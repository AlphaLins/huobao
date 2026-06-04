import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import { getAbsolutePath, parseDataUrl } from '../../utils/storage.js'
import { joinProviderUrl } from './url.js'
import type { AIConfig } from './types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.resolve(__dirname, '../../../../data/cache')
const CACHE_PATH = path.join(CACHE_DIR, 'apimart-upload-cache.json')
const DEFAULT_BASE_URL = 'https://api.apimart.ai'
const CACHE_TTL_MS = 71 * 60 * 60 * 1000

type UploadCacheEntry = {
  url: string
  expiresAt: number
}

type UploadCache = Record<string, UploadCacheEntry>

export async function normalizeApimartReferenceImages(config: AIConfig, refs: Array<string | null | undefined>): Promise<string[]> {
  const normalized: string[] = []
  for (const item of refs) {
    const value = String(item || '').trim()
    if (!value) continue
    const url = await normalizeApimartReferenceImage(config, value)
    if (url && !normalized.includes(url)) normalized.push(url)
  }
  return normalized
}

export async function normalizeApimartReferenceImage(config: AIConfig, value: string): Promise<string> {
  if (/^https?:\/\//i.test(value)) return value
  const { buffer, mimeType, filename } = readReferenceImage(value)
  const cacheKey = hashReference(config, buffer)
  const cached = readUploadCache()[cacheKey]
  if (cached?.url && cached.expiresAt > Date.now()) return cached.url

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename)

  const url = joinProviderUrl(config.baseUrl || DEFAULT_BASE_URL, '/v1', '/uploads/images')
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json',
    },
    body: form,
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`APIMart image upload failed ${resp.status}: ${text}`)

  let result: any
  try {
    result = JSON.parse(text)
  } catch {
    throw new Error(`APIMart image upload returned non-JSON response: ${text.slice(0, 300)}`)
  }
  const uploadedUrl = extractUploadedUrl(result)
  if (!uploadedUrl) throw new Error(`APIMart image upload response has no URL: ${JSON.stringify(result).slice(0, 500)}`)

  const cache = readUploadCache()
  cache[cacheKey] = { url: uploadedUrl, expiresAt: Date.now() + CACHE_TTL_MS }
  writeUploadCache(cache)
  return uploadedUrl
}

function readReferenceImage(value: string): { buffer: Buffer; mimeType: string; filename: string } {
  const dataUrl = parseDataUrl(value)
  if (dataUrl) {
    return {
      buffer: Buffer.from(dataUrl.data, 'base64'),
      mimeType: dataUrl.mimeType,
      filename: `reference${mimeToExt(dataUrl.mimeType)}`,
    }
  }

  const localPath = value.startsWith('/') ? value.slice(1) : value
  const absolutePath = getAbsolutePath(localPath)
  const buffer = fs.readFileSync(absolutePath)
  const ext = path.extname(absolutePath).toLowerCase() || '.jpg'
  return {
    buffer,
    mimeType: extToMime(ext),
    filename: `reference${ext}`,
  }
}

function hashReference(config: AIConfig, buffer: Buffer) {
  const host = (() => {
    try {
      return new URL(config.baseUrl || DEFAULT_BASE_URL).host
    } catch {
      return config.baseUrl || DEFAULT_BASE_URL
    }
  })()
  return crypto.createHash('sha256').update(host).update(buffer).digest('hex')
}

function readUploadCache(): UploadCache {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function writeUploadCache(cache: UploadCache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const pruned = Object.fromEntries(Object.entries(cache).filter(([, entry]) => entry.expiresAt > Date.now()))
  fs.writeFileSync(CACHE_PATH, JSON.stringify(pruned, null, 2), 'utf8')
}

function extractUploadedUrl(result: any): string | null {
  return result?.url
    || result?.image_url
    || result?.file_url
    || result?.data?.url
    || result?.data?.image_url
    || result?.data?.file_url
    || result?.result?.url
    || result?.result?.image_url
    || result?.results?.[0]?.url
    || null
}

function extToMime(ext: string) {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }
  return map[ext] || 'image/jpeg'
}

function mimeToExt(mimeType: string) {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
  }
  return map[mimeType] || '.jpg'
}
