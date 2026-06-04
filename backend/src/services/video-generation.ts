import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, readImageAsCompressedDataUrl } from '../utils/storage.js'
import { detectVideoModelFamily, getVideoAdapterForModel } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { normalizeApimartReferenceImage, normalizeApimartReferenceImages } from './adapters/apimart-upload'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { injectStylePrompt } from '../utils/style-prompt.js'
import { emitTaskEvent } from '../utils/events.js'

interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  duration?: number
  aspectRatio?: string
  configId?: number
  promptMode?: 'auto' | 'custom_final'
}

function normalizeVideoError(message: string) {
  const raw = String(message || '')
  if (
    raw.includes('TLS handshake timeout')
    || raw.includes('aisandbox-pa.googleapis.com')
    || raw.includes('status=0')
  ) {
    return 'Veo 上游链路超时：VipStar 请求 Google/Veo 服务时 TLS 握手超时。通常不是提示词或参数错误，请稍后重试；避免并发提交，必要时更换 VipStar API Key、账号或网络出口。'
  }
  if (
    raw.includes('reCAPTCHA evaluation failed')
    || raw.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY')
    || raw.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC')
  ) {
    return 'Veo 上游风控拒绝：reCAPTCHA evaluation failed。请稍后重试，避免并发提交；如果持续出现，请更换 VipStar API Key、账号或网络出口。'
  }
  return raw
}

function formatVideoPollError(message: string, raw?: unknown) {
  const normalized = normalizeVideoError(message)
  const rawText = summarizeProviderRaw(raw)
  if (!rawText) return normalized
  if (normalized.includes(rawText)) return normalized
  return `${normalized} | provider_raw=${rawText}`
}

function summarizeProviderRaw(raw: unknown, maxLength = 2000) {
  if (!raw) return ''
  try {
    return JSON.stringify(raw).slice(0, maxLength)
  } catch {
    return String(raw).slice(0, maxLength)
  }
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('video')
  if (!config) throw new Error('No active video AI config')
  const model = params.model || config.model
  const provider = config.provider === 'apimart'
    ? 'apimart'
    : detectVideoModelFamily(model) || config.provider

  // 注入风格提示词
  const styledPrompt = params.promptMode === 'custom_final'
    ? params.prompt
    : injectStylePrompt(params.prompt, params.dramaId)

  const res = db.insert(schema.videoGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    prompt: styledPrompt,
    model,
    provider,
    referenceMode: params.referenceMode || 'none',
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: params.referenceImageUrls ? JSON.stringify(params.referenceImageUrls) : null,
    duration: params.duration || 5,
    aspectRatio: params.aspectRatio || '16:9',
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  logTaskStart('VideoTask', 'enqueue', {
    id: lastId,
    provider,
    configuredProvider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    referenceMode: params.referenceMode || 'none',
    duration: params.duration || 5,
  })
  logTaskPayload('VideoTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      resolvedProvider: provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })
  processVideoGeneration(lastId, config).catch(err => {
    logTaskError('VideoTask', 'process', { id: lastId, error: err.message })
    console.error(`Video generation ${lastId} failed:`, err)
  })
  return lastId
}

async function processVideoGeneration(id: number, config: AIConfig) {
  let record: (typeof schema.videoGenerations.$inferSelect) | undefined

  try {
    const rows = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
    record = rows[0]
    if (!record) return
    const adapter = getVideoAdapterForModel(config.provider, record.model || config.model)
    const resolvedProvider = adapter.provider || detectVideoModelFamily(record.model || config.model) || config.provider
    const resolvedConfig = { ...config, provider: resolvedProvider }
    logTaskProgress('VideoTask', 'build-request', {
      id,
      provider: config.provider,
      resolvedProvider,
      model: record.model,
      storyboardId: record.storyboardId,
      referenceMode: record.referenceMode,
    })

    const apimartMode = resolvedProvider === 'apimart'
    const resolvedImageUrl = apimartMode
      ? await normalizeApimartVideoReferenceUrl(resolvedConfig, record.imageUrl)
      : await normalizeVideoReferenceUrl(record.imageUrl)
    const resolvedFirstFrameUrl = apimartMode
      ? await normalizeApimartVideoReferenceUrl(resolvedConfig, record.firstFrameUrl)
      : await normalizeVideoReferenceUrl(record.firstFrameUrl)
    const resolvedLastFrameUrl = apimartMode
      ? await normalizeApimartVideoReferenceUrl(resolvedConfig, record.lastFrameUrl)
      : await normalizeVideoReferenceUrl(record.lastFrameUrl)
    const resolvedReferenceImageUrls = apimartMode
      ? await normalizeApimartReferenceImages(resolvedConfig, parseVideoReferenceUrls(record.referenceImageUrls))
      : await normalizeVideoReferenceUrls(record.referenceImageUrls)

    // 使用 Adapter 构建请求
    const { url, method, headers, body } = adapter.buildGenerateRequest(resolvedConfig, {
      id: record.id,
      model: record.model,
      prompt: record.prompt,
      referenceMode: record.referenceMode,
      imageUrl: resolvedImageUrl,
      firstFrameUrl: resolvedFirstFrameUrl,
      lastFrameUrl: resolvedLastFrameUrl,
      referenceImageUrls: resolvedReferenceImageUrls ? JSON.stringify(resolvedReferenceImageUrls) : null,
      duration: record.duration,
      aspectRatio: record.aspectRatio,
    })
    logTaskProgress('VideoTask', 'request', {
      id,
      provider: config.provider,
      resolvedProvider,
      method,
      url: redactUrl(url),
      model: record.model,
      referenceMode: record.referenceMode,
    })
    logTaskPayload('VideoTask', 'request payload', {
      id,
      method,
      url,
      headers,
      body: summarizeRequestBody(body),
    })

    const resp = await fetch(url, {
      method,
      headers,
      body: body instanceof FormData ? body : JSON.stringify(body),
    })

    if (!resp.ok) {
      const responseText = await resp.text()
      throw new Error(formatVideoCreateError(resp.status, responseText, {
        provider: config.provider,
        resolvedProvider,
        model: record.model,
        referenceMode: record.referenceMode,
        duration: record.duration,
        aspectRatio: record.aspectRatio,
        request: summarizeRequestBody(body),
      }))
    }
    const result = await resp.json() as any

    const { isAsync, taskId, videoUrl } = adapter.parseGenerateResponse(result)

    if (!isAsync && videoUrl) {
      logTaskProgress('VideoTask', 'sync-complete', { id, videoUrl })
      // 同步模式
      await handleVideoComplete(id, videoUrl, record.duration, record.storyboardId)
      return
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.videoGenerations)
      .set({ taskId, status: 'processing', updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
    logTaskProgress('VideoTask', 'poll-start', { id, taskId, provider: config.provider })

    // Vidu 没有轮询端点，跳过轮询（依赖 Webhook 回调）
    if (adapter.provider === 'vidu') {
      logTaskProgress('VideoTask', 'webhook-wait', { id, taskId, provider: adapter.provider })
      return
    }

    pollVideoTask(id, resolvedConfig, taskId!, record.storyboardId)
  } catch (err: any) {
    const errorMsg = normalizeVideoError(err.message)
    logTaskError('VideoTask', 'process', { id, provider: config.provider, error: errorMsg })
    db.update(schema.videoGenerations)
      .set({ status: 'failed', errorMsg, updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
    emitTaskEvent({
      type: 'video',
      status: 'failed',
      id,
      dramaId: record?.dramaId,
      storyboardId: record?.storyboardId,
      errorMsg,
    })
  }
}

async function normalizeApimartVideoReferenceUrl(config: AIConfig, value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  return normalizeApimartReferenceImage(config, raw)
}

function parseVideoReferenceUrls(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/') || raw.startsWith('project/') || raw.startsWith('/project/')) {
    const localPath = raw.startsWith('/') ? raw.slice(1) : raw
    try {
      return await readImageAsCompressedDataUrl(localPath, {
        maxWidth: 768,
        maxHeight: 768,
        quality: 68,
      })
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(raw: string | null | undefined): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    refs = []
  }
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

async function pollVideoTask(id: number, config: AIConfig, taskId: string, storyboardId?: number | null) {
  const [initialRecord] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
  const adapter = getVideoAdapterForModel(config.provider, initialRecord?.model || config.model)
  const resolvedProvider = adapter.provider || detectVideoModelFamily(initialRecord?.model || config.model) || config.provider
  const resolvedConfig = { ...config, provider: resolvedProvider }

  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 10000))
    try {
      const { url, method, headers } = adapter.buildPollRequest(resolvedConfig, taskId)
      logTaskProgress('VideoTask', 'poll-request', {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const resp = await fetch(url, { method, headers })
      if (!resp.ok) {
        const bodyText = await resp.text()
        const errorMsg = formatVideoPollError(`Poll API error ${resp.status}: ${bodyText}`, bodyText)
        logTaskWarn('VideoTask', 'poll-http-error', {
          id,
          taskId,
          provider: config.provider,
          status: resp.status,
          attempt: i + 1,
          error: errorMsg,
        })
        if (resp.status === 401 || resp.status === 403) {
          const [record] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
          db.update(schema.videoGenerations)
            .set({ status: 'failed', errorMsg, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id))
            .run()
          emitTaskEvent({
            type: 'video',
            status: 'failed',
            id,
            dramaId: record?.dramaId,
            storyboardId: record?.storyboardId,
            errorMsg,
          })
          return
        }
        continue
      }
      const result = await resp.json() as any

      const pollResp = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.videoUrl) {
        logTaskSuccess('VideoTask', 'poll-complete', { id, taskId, videoUrl: pollResp.videoUrl })
        await handleVideoComplete(id, pollResp.videoUrl, null, storyboardId)
        return
      }
      if (pollResp.status === 'failed') {
        const errorMsg = formatVideoPollError(pollResp.error || 'Video generation failed', pollResp.raw)
        logTaskError('VideoTask', 'poll-failed', { id, taskId, error: errorMsg, raw: pollResp.raw })
        const [record] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
        db.update(schema.videoGenerations)
          .set({ status: 'failed', errorMsg, updatedAt: now() })
          .where(eq(schema.videoGenerations.id, id))
          .run()
        emitTaskEvent({
          type: 'video',
          status: 'failed',
          id,
          dramaId: record?.dramaId,
          storyboardId: record?.storyboardId,
          errorMsg,
        })
        return
      }
      if (pollResp.status === 'processing') {
        logTaskProgress('VideoTask', 'poll-processing', { id, taskId, status: pollResp.status, raw: pollResp.raw })
      }
    } catch (err: any) {
      if (i === 299) {
        const errorMsg = normalizeVideoError(err.message)
        logTaskError('VideoTask', 'poll-timeout', { id, taskId, error: errorMsg })
        db.update(schema.videoGenerations)
          .set({ status: 'failed', errorMsg: `Timeout: ${errorMsg}`, updatedAt: now() })
          .where(eq(schema.videoGenerations.id, id))
          .run()
        const [record] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
        emitTaskEvent({
          type: 'video',
          status: 'failed',
          id,
          dramaId: record?.dramaId,
          storyboardId: record?.storyboardId,
          errorMsg: `Timeout: ${errorMsg}`,
        })
        return
      }
      logTaskWarn('VideoTask', 'poll-retry', { id, taskId, attempt: i + 1, error: err.message })
    }
  }
}

async function handleVideoComplete(id: number, videoUrl: string, duration: number | null | undefined, storyboardId?: number | null) {
  const [record] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
  const localPath = await downloadFile(videoUrl, 'videos', getProjectStorageContext(record, id, 'video'))
  db.update(schema.videoGenerations)
    .set({ videoUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id))
    .run()
  logTaskSuccess('VideoTask', 'downloaded', { id, localPath, storyboardId, duration })

  if (storyboardId) {
    db.update(schema.storyboards)
      .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
  }
  emitTaskEvent({
    type: 'video',
    status: 'completed',
    id,
    dramaId: record?.dramaId,
    storyboardId: storyboardId || record?.storyboardId,
    localPath,
    videoUrl: localPath,
  })
}

function summarizeRequestBody(body: unknown) {
  if (body instanceof FormData) {
    const fields: Array<Record<string, unknown>> = []
    for (const [key, value] of body.entries()) {
      if (typeof value === 'string') {
        fields.push({ key, type: 'string', value })
        continue
      }
      const file = value as File
      fields.push({
        key,
        type: file.constructor?.name || 'file',
        name: file.name,
        size: file.size,
        mimeType: file.type,
      })
    }
    return { type: 'FormData', fields }
  }
  return summarizeValue(body)
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      const [head] = value.split(',', 1)
      return `${head || 'data:image'};base64,<${value.length} chars>`
    }
    if (value.length > 1200) return `${value.slice(0, 1200)}...<${value.length} chars>`
    return value
  }
  if (Array.isArray(value)) return value.map(summarizeValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, summarizeValue(item)]))
  }
  return value
}

function formatVideoCreateError(status: number, responseText: string, context: Record<string, unknown>) {
  const response = responseText.length > 2000 ? `${responseText.slice(0, 2000)}...<${responseText.length} chars>` : responseText
  return `API error ${status}: ${response} | request_context=${JSON.stringify(context)}`
}

function getProjectStorageContext(record: (typeof schema.videoGenerations.$inferSelect) | undefined, id: number, kind: string) {
  const dramaId = record?.dramaId || undefined
  const [drama] = dramaId ? db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all() : []
  let episodeNumber: number | undefined
  if (record?.storyboardId) {
    const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, record.storyboardId)).all()
    if (storyboard?.episodeId) {
      const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all()
      episodeNumber = episode?.episodeNumber || undefined
    }
  }
  return {
    dramaId,
    dramaTitle: drama?.title,
    episodeNumber,
    generationId: id,
    kind,
    prompt: record?.prompt,
  }
}
