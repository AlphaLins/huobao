import type {
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
  ImageProviderAdapter,
  ProviderRequest,
} from './types'
import { joinProviderUrl } from './url'

export class ApimartImageAdapter implements ImageProviderAdapter {
  provider = 'apimart'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const images = parseRefs(record.referenceImages).slice(0, this.maxImages(record.model || config.model))
    const body: Record<string, unknown> = {
      model: firstModel(record.model || config.model) || 'gpt-image-2',
      prompt: record.prompt || '',
      n: 1,
    }
    const size = normalizeImageSize(record.size)
    if (size) body.size = size
    if (images.length) body.image_urls = images

    return {
      url: joinProviderUrl(config.baseUrl || 'https://api.apimart.ai', '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    if (result?.error) throw new Error(extractError(result))
    const imageUrl = this.extractImageUrl(result)
    if (imageUrl) return { isAsync: false, imageUrl }
    const taskId = extractTaskId(result)
    if (taskId) return { isAsync: true, taskId: String(taskId) }
    throw new Error(`No APIMart image task ID or URL in response: ${JSON.stringify(result).slice(0, 500)}`)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl || 'https://api.apimart.ai', '/v1', `/tasks/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = normalizeTaskStatus(result)
    if (status === 'completed') {
      const imageUrl = this.extractImageUrl(result)
      return imageUrl
        ? { status: 'completed', imageUrl }
        : { status: 'failed', error: 'APIMart image task completed but no image URL was returned' }
    }
    if (status === 'failed') return { status: 'failed', error: extractError(result) }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    const data = result?.data || result?.result || result?.output || result
    const nestedResult = data?.result || result?.result
    const first = Array.isArray(data?.images) ? data.images[0] : null
    const firstNested = Array.isArray(nestedResult?.images) ? nestedResult.images[0] : null
    const firstResult = Array.isArray(data?.results) ? data.results[0] : null
    return firstString(
      data?.image_url
      || data?.imageUrl
      || data?.url
      || data?.data?.[0]?.url
      || first?.url
      || first?.image_url
      || nestedResult?.image_url
      || nestedResult?.imageUrl
      || nestedResult?.url
      || firstNested?.url
      || firstNested?.image_url
      || firstResult?.url
      || firstResult?.image_url
      || result?.data?.[0]?.url
      || null
    )
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result?.data?.[0]?.b64_json || result?.b64_json
    return b64 ? { data: b64, mimeType: 'image/png' } : null
  }

  private maxImages(model?: string | null) {
    const lower = String(model || '').toLowerCase()
    if (lower.includes('sora')) return 1
    if (lower.includes('veo')) return 3
    if (lower.includes('grok')) return 7
    return 6
  }
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const found = value.find(item => typeof item === 'string' && item)
    return found || null
  }
  return null
}

function parseRefs(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function firstModel(model?: string | null) {
  const raw = String(model || '').trim()
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return String(parsed[0] || '').trim()
  } catch {}
  return raw
}

function normalizeImageSize(size?: string | null) {
  const raw = String(size || '').trim()
  if (!raw) return undefined
  if (/^\d+x\d+$/.test(raw)) return raw
  const map: Record<string, string> = {
    '1:1': '1024x1024',
    '16:9': '1792x1024',
    '9:16': '1024x1792',
    '4:3': '1536x1024',
    '3:4': '1024x1536',
  }
  return map[raw] || raw
}

function normalizeTaskStatus(result: any): ImagePollResponse['status'] {
  const raw = String(result?.status || result?.data?.status || result?.state || result?.data?.state || '').toLowerCase()
  if (['completed', 'succeeded', 'success', 'done'].includes(raw)) return 'completed'
  if (['failed', 'error', 'cancelled', 'canceled'].includes(raw)) return 'failed'
  if (['pending', 'queued', 'created'].includes(raw)) return 'pending'
  return 'processing'
}

function extractError(result: any) {
  const candidates = [
    result?.error?.message,
    result?.error,
    result?.message,
    result?.data?.error?.message,
    result?.data?.error,
    result?.data?.message,
  ]
  for (const item of candidates) {
    if (!item) continue
    return normalizeApimartError(typeof item === 'string' ? item : JSON.stringify(item))
  }
  return 'APIMart image generation failed'
}

function normalizeApimartError(message: string) {
  const raw = String(message || '')
  if (raw.includes('PUBLIC_ERROR_UNSAFE_GENERATION')) {
    return 'APIMart 上游安全策略拒绝生成：PUBLIC_ERROR_UNSAFE_GENERATION。通常是提示词、参考图或二者组合触发内容安全过滤；请弱化敏感、暴力、政治压迫、监控、极端心理等描述，或更换参考图后重试。'
  }
  return raw
}

function extractTaskId(result: any): string | null {
  const data = Array.isArray(result?.data) ? result.data[0] : result?.data
  return result?.task_id
    || result?.taskId
    || result?.id
    || data?.task_id
    || data?.taskId
    || data?.id
    || result?.result?.task_id
    || result?.result?.id
    || null
}
