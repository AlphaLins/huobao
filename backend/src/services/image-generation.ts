import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, readImageAsCompressedDataUrl, saveBase64Image } from '../utils/storage.js'
import { getImageAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { normalizeApimartReferenceImages } from './adapters/apimart-upload'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { injectStylePrompt } from '../utils/style-prompt.js'
import { emitImageEvent } from '../utils/events.js'

/**
 * 根据 drama 的 aspectRatio 计算图片尺寸
 * 16:9 -> 1920x1080
 * 9:16 -> 1080x1920
 * 1:1  -> 1024x1024
 */
async function getDramaImageSize(dramaId?: number): Promise<string> {
  if (!dramaId) return '1920x1080' // 默认 16:9
  try {
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
    if (!drama) return '1920x1080'
    const ratio = drama.aspectRatio || '16:9'
    if (ratio === '9:16') return '1080x1920'
    if (ratio === '1:1') return '1024x1024'
    return '1920x1080' // 16:9
  } catch {
    return '1920x1080'
  }
}

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  imageType?: string
  configId?: number
  promptMode?: 'auto' | 'custom_final'
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('image')
  if (!config) throw new Error('No active image AI config')

  // 如果未指定 size，根据 drama 的 aspectRatio 计算
  const size = params.size || await getDramaImageSize(params.dramaId)

  // 注入风格提示词
  const styledPrompt = params.promptMode === 'custom_final'
    ? params.prompt
    : injectStylePrompt(params.prompt, params.dramaId)

  const res = db.insert(schema.imageGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    prompt: styledPrompt,
    model: params.model || config.model,
    provider: config.provider,
    size: size,
    imageType: params.imageType,
    frameType: params.frameType,
    referenceImages: params.referenceImages ? JSON.stringify(params.referenceImages) : null,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  logTaskStart('ImageTask', 'enqueue', {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })
  processImageGeneration(lastId, config).catch(err => {
    logTaskError('ImageTask', 'process', { id: lastId, error: err.message })
    console.error(`Image generation ${lastId} failed:`, err)
  })
  return lastId
}

export async function syncImageGenerationResult(id: number) {
  const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  if (!record) throw new Error('Image generation not found')
  if (record.status === 'completed' || record.status === 'failed') return record
  if (!record.taskId) return record

  const configRows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'image'))
    .all()
    .filter(row => row.isActive && row.provider === record.provider)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  const configRow = configRows[0]
  if (!configRow) throw new Error(`No active image config for provider ${record.provider}`)

  const models = configRow.model ? JSON.parse(configRow.model) : []
  const config: AIConfig = {
    provider: configRow.provider || '',
    baseUrl: configRow.baseUrl,
    apiKey: configRow.apiKey,
    model: record.model || models[0] || '',
  }

  const adapter = getImageAdapter(config.provider)
  const { url, method, headers } = adapter.buildPollRequest(config, record.taskId)
  const resp = await fetch(url, {
    method,
    headers,
    signal: AbortSignal.timeout(120_000),
  })
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)
  const result = await resp.json() as any
  const pollResp = adapter.parsePollResponse(result)

  if (pollResp.status === 'completed' && pollResp.imageUrl) {
    await handleImageComplete(id, config.provider, pollResp.imageUrl)
  } else if (pollResp.status === 'completed') {
    const b64 = adapter.extractImageBase64(result)
    if (b64) await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
  } else if (pollResp.status === 'failed') {
    db.update(schema.imageGenerations)
      .set({ status: 'failed', errorMsg: pollResp.error || 'Generation failed', updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
    emitImageFailed(id, pollResp.error || 'Generation failed')
  }

  const [updated] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  return updated || record
}

async function processImageGeneration(id: number, config: AIConfig) {
  const adapter = getImageAdapter(config.provider)

  let record: (typeof schema.imageGenerations.$inferSelect) | undefined
  try {
    const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
    record = rows[0]
    if (!record) return
    logTaskProgress('ImageTask', 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
      frameType: record.frameType,
    })

    // 使用 Adapter 构建请求
    const resolvedReferenceImages = config.provider === 'apimart'
      ? await normalizeApimartReferenceImages(config, parseReferenceImages(record.referenceImages))
      : await normalizeReferenceImages(record.referenceImages)
    const { url, method, headers, body } = adapter.buildGenerateRequest(config, {
      id: record.id,
      model: record.model,
      prompt: record.prompt,
      size: record.size,
      frameType: record.frameType,
      imageType: record.imageType,
      referenceImages: resolvedReferenceImages ? JSON.stringify(resolvedReferenceImages) : null,
    })
    logTaskProgress('ImageTask', 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })
    logTaskPayload('ImageTask', 'request payload', {
      id,
      method,
      url,
      headers,
      body,
    })

    const resp = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })

    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)
    const result = await resp.json() as any
    logTaskPayload('ImageTask', 'response payload', {
      id,
      provider: config.provider,
      result,
    })

    const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

    if (!isAsync && imageUrl) {
      logTaskProgress('ImageTask', 'sync-complete', { id, imageUrl })
      // 同步模式：直接下载图片
      await handleImageComplete(id, config.provider, imageUrl)
      return
    }

    if (!isAsync && !imageUrl) {
      // 同步模式但无 URL（Gemini 等返回 base64）
      const b64 = adapter.extractImageBase64(result)
      if (b64) {
        logTaskProgress('ImageTask', 'sync-base64-complete', { id, mimeType: b64.mimeType })
        await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
        return
      }
      throw new Error('No image URL or base64 data in response')
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.imageGenerations)
      .set({ taskId, status: 'processing', updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
    logTaskProgress('ImageTask', 'poll-start', { id, taskId, provider: config.provider })
    pollImageTask(id, config, taskId!)
  } catch (err: any) {
    logTaskError('ImageTask', 'process', { id, provider: config.provider, error: err.message })
    db.update(schema.imageGenerations)
      .set({ status: 'failed', errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
    emitImageEvent({
      id,
      dramaId: record?.dramaId,
      characterId: record?.characterId,
      sceneId: record?.sceneId,
      storyboardId: record?.storyboardId,
      frameType: record?.frameType,
      imageType: record?.imageType,
      localPath: '',
      status: 'failed',
      errorMsg: err.message,
    })
  }
}

function parseReferenceImages(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

async function normalizeReferenceImages(raw: string | null | undefined): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    refs = []
  }

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/') || value.startsWith('project/') || value.startsWith('/project/')) {
      const localPath = value.startsWith('/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item): item is string => !!item).slice(0, 6)
}

async function pollImageTask(id: number, config: AIConfig, taskId: string) {
  const adapter = getImageAdapter(config.provider)
  const startedAt = Date.now()

  // 带参考图时生成时间更长（Grsai 可达 12+ 分钟），延长轮询超时
  const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const hasRefs = !!record?.referenceImages
  const maxDurationMs = hasRefs ? 1_200_000 : 600_000 // 有参考图 20 分钟，无参考图 10 分钟
  const maxAttempts = hasRefs ? 240 : 120

  const timeoutMsg = `Polling exceeded ${maxDurationMs / 60_000} minutes`

  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: timeoutMsg })
      db.update(schema.imageGenerations)
        .set({ status: 'failed', errorMsg: `Timeout: ${timeoutMsg}`, updatedAt: now() })
        .where(eq(schema.imageGenerations.id, id))
        .run()
      emitImageFailed(id, `Timeout: ${timeoutMsg}`)
      return
    }
    await new Promise(r => setTimeout(r, 5000))
    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: timeoutMsg })
      db.update(schema.imageGenerations)
        .set({ status: 'failed', errorMsg: `Timeout: ${timeoutMsg}`, updatedAt: now() })
        .where(eq(schema.imageGenerations.id, id))
        .run()
      emitImageFailed(id, `Timeout: ${timeoutMsg}`)
      return
    }
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress('ImageTask', 'poll-request', {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = Math.max(1_000, maxDurationMs - (Date.now() - startedAt))
      const resp = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      })
      if (!resp.ok) continue
      const result = await resp.json() as any

      const pollResp = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.imageUrl) {
        logTaskSuccess('ImageTask', 'poll-complete', { id, taskId, imageUrl: pollResp.imageUrl })
        await handleImageComplete(id, config.provider, pollResp.imageUrl)
        return
      }
      if (pollResp.status === 'completed' && adapter.provider === 'gemini') {
        // Gemini 可能返回 base64
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskSuccess('ImageTask', 'poll-base64-complete', { id, taskId, mimeType: b64.mimeType })
          await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
          return
        }
      }
      if (pollResp.status === 'failed') {
        logTaskError('ImageTask', 'poll-failed', { id, taskId, error: pollResp.error || 'Generation failed' })
        throw new Error(pollResp.error || 'Generation failed')
      }
    } catch (err: any) {
      if (i === maxAttempts - 1 || Date.now() - startedAt >= maxDurationMs) {
        logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: err.message })
        db.update(schema.imageGenerations)
          .set({ status: 'failed', errorMsg: `Timeout: ${err.message}`, updatedAt: now() })
          .where(eq(schema.imageGenerations.id, id))
          .run()
        emitImageFailed(id, `Timeout: ${err.message}`)
        return
      }
      logTaskWarn('ImageTask', 'poll-retry', { id, taskId, attempt: i + 1, error: err.message })
    }
  }
}

function emitImageFailed(id: number, errorMsg: string) {
  const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  emitImageEvent({
    id,
    dramaId: record?.dramaId,
    characterId: record?.characterId,
    sceneId: record?.sceneId,
    storyboardId: record?.storyboardId,
    frameType: record?.frameType,
    imageType: record?.imageType,
    localPath: '',
    status: 'failed',
    errorMsg,
  })
}

function getProjectStorageContext(record: (typeof schema.imageGenerations.$inferSelect) | undefined, id: number, kind: string) {
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

async function handleImageComplete(id: number, provider: string, imageUrl: string) {
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const record = rows[0]
  const localPath = await downloadFile(imageUrl, 'images', getProjectStorageContext(record, id, 'image'))

  db.update(schema.imageGenerations)
    .set({ imageUrl, localPath, status: 'completed', updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  logTaskSuccess('ImageTask', 'downloaded', { id, provider, localPath })

  // 更新关联表
  if (record?.storyboardId && record.imageType !== 'refine') {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
  }
  if (record?.characterId && record.imageType !== 'refine') {
    db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId)).run()
  }
  if (record?.sceneId && record.imageType !== 'refine') {
    db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId)).run()
  }

  emitImageEvent({
    id,
    dramaId: record?.dramaId,
    characterId: record?.characterId,
    sceneId: record?.sceneId,
    storyboardId: record?.storyboardId,
    frameType: record?.frameType,
    imageType: record?.imageType,
    localPath,
    status: 'completed',
  })
}

async function handleImageCompleteBase64(id: number, provider: string, base64Data: string, mimeType: string) {
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const record = rows[0]
  const localPath = await saveBase64Image(base64Data, mimeType, 'images', getProjectStorageContext(record, id, 'image'))

  db.update(schema.imageGenerations)
    .set({ localPath, status: 'completed', updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  logTaskSuccess('ImageTask', 'saved-base64', { id, provider, mimeType, localPath })

  // 更新关联表
  if (record?.storyboardId && record.imageType !== 'refine') {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
  }
  if (record?.characterId && record.imageType !== 'refine') {
    db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId)).run()
  }
  if (record?.sceneId && record.imageType !== 'refine') {
    db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId)).run()
  }

  emitImageEvent({
    id,
    dramaId: record?.dramaId,
    characterId: record?.characterId,
    sceneId: record?.sceneId,
    storyboardId: record?.storyboardId,
    frameType: record?.frameType,
    imageType: record?.imageType,
    localPath,
    status: 'completed',
  })
}
