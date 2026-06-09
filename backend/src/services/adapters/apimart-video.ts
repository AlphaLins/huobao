import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { joinProviderUrl } from './url'

export class ApimartVideoAdapter implements VideoProviderAdapter {
  provider = 'apimart'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = firstModel(record.model || config.model) || 'sora-2'
    const images = getReferenceImages(record).slice(0, maxImagesForModel(model))
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
    }

    if (images.length) body.image_urls = images
    Object.assign(body, videoParamsForModel(model, record))

    return {
      url: joinProviderUrl(config.baseUrl || 'https://api.apimart.ai', '/v1', '/videos/generations'),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result?.error) throw new Error(extractError(result))
    const videoUrl = this.extractVideoUrl(result)
    if (videoUrl) return { isAsync: false, videoUrl }
    const taskId = extractTaskId(result)
    if (taskId) return { isAsync: true, taskId: String(taskId) }
    throw new Error(`No APIMart video task ID or URL in response: ${JSON.stringify(result).slice(0, 500)}`)
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

  parsePollResponse(result: any): VideoPollResponse {
    const status = normalizeTaskStatus(result)
    if (status === 'completed') {
      const videoUrl = this.extractVideoUrl(result)
      return videoUrl
        ? { status: 'completed', videoUrl, raw: result }
        : { status: 'failed', error: 'APIMart video task completed but no video URL was returned', raw: result }
    }
    if (status === 'failed') return { status: 'failed', error: extractError(result), raw: result }
    return { status: status === 'pending' ? 'pending' : 'processing', raw: result }
  }

  extractVideoUrl(result: any): string | null {
    const data = result?.data || result?.result || result?.output || result
    const nestedResult = data?.result || result?.result
    const firstVideo = Array.isArray(data?.videos) ? data.videos[0] : null
    const firstNestedVideo = Array.isArray(nestedResult?.videos) ? nestedResult.videos[0] : null
    const firstResult = Array.isArray(data?.results) ? data.results[0] : null
    return firstString(
      data?.video_url
      || data?.videoUrl
      || data?.url
      || data?.uri
      || data?.data?.[0]?.url
      || firstVideo?.url
      || firstVideo?.video_url
      || firstVideo?.uri
      || nestedResult?.video_url
      || nestedResult?.videoUrl
      || nestedResult?.url
      || firstNestedVideo?.url
      || firstNestedVideo?.video_url
      || firstNestedVideo?.uri
      || firstResult?.url
      || firstResult?.video_url
      || result?.data?.[0]?.url
      || null
    )
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

function videoParamsForModel(model: string, record: VideoGenerationRecord) {
  const lower = model.toLowerCase()
  const aspectRatio = normalizeAspectRatio(record.aspectRatio)
  const duration = Math.round(Number(record.duration || 10))

  if (lower.startsWith('sora')) {
    return {
      duration,
      resolution: lower.includes('pro') ? resolutionFromModel(model, '1080p') : resolutionFromModel(model, '720p'),
      orientation: aspectRatio === '9:16' ? 'portrait' : 'landscape',
    }
  }

  if (lower.startsWith('omni') || lower.includes('omni-video')) {
    return {
      duration,
      resolution: resolutionFromModel(model, '720p'),
      aspect_ratio: aspectRatio,
    }
  }

  if (lower.startsWith('veo')) {
    return {
      duration: 8,
      resolution: resolutionFromModel(model, lower.includes('lite') ? '720p' : '1080p'),
      aspect_ratio: aspectRatio,
      generation_type: record.referenceMode === 'first_last' ? 'first_last_frame' : 'image_to_video',
    }
  }

  if (lower.startsWith('grok') || lower.includes('grok-video')) {
    return {
      duration,
      size: normalizeGrokAspectRatio(record.aspectRatio),
      quality: grokQualityFromModel(model),
    }
  }

  return {
    duration,
    aspect_ratio: aspectRatio,
  }
}

function getReferenceImages(record: VideoGenerationRecord): string[] {
  const refs: string[] = []
  const push = (value?: string | null) => {
    const normalized = String(value || '').trim()
    if (normalized && !refs.includes(normalized)) refs.push(normalized)
  }
  if (record.referenceMode === 'first_last') {
    push(record.firstFrameUrl || record.imageUrl)
    push(record.lastFrameUrl)
  } else {
    push(record.imageUrl || record.firstFrameUrl)
  }
  if (record.referenceImageUrls) {
    try {
      const parsed = JSON.parse(record.referenceImageUrls)
      if (Array.isArray(parsed)) parsed.forEach(push)
    } catch {}
  }
  return refs
}

function maxImagesForModel(model: string) {
  const lower = model.toLowerCase()
  if (lower.startsWith('sora')) return 1
  if (lower.startsWith('veo')) return 3
  if (lower.startsWith('grok')) return 7
  return 6
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

function normalizeAspectRatio(ratio?: string | null) {
  return ratio === '9:16' ? '9:16' : '16:9'
}

function normalizeGrokAspectRatio(ratio?: string | null) {
  const normalized = String(ratio || '').trim()
  if (['16:9', '9:16', '1:1', '3:2', '2:3'].includes(normalized)) return normalized
  return normalizeAspectRatio(ratio)
}

function resolutionFromModel(model: string, fallback: string) {
  const lower = model.toLowerCase()
  if (lower.includes('4k')) return '4k'
  if (lower.includes('1080')) return '1080p'
  if (lower.includes('1024')) return '1024p'
  if (lower.includes('720')) return '720p'
  return fallback
}

function grokQualityFromModel(model: string) {
  const lower = model.toLowerCase()
  if (lower.includes('480')) return '480p'
  return '720p'
}

function normalizeTaskStatus(result: any): VideoPollResponse['status'] {
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
  return 'APIMart video generation failed'
}

function normalizeApimartError(message: string) {
  const raw = String(message || '')
  if (raw.includes('PUBLIC_ERROR_UNSAFE_GENERATION')) {
    return 'APIMart 上游安全策略拒绝生成：PUBLIC_ERROR_UNSAFE_GENERATION。通常是提示词、参考图或二者组合触发内容安全过滤；请降低暴力、政治压迫、监控、极端心理、真实历史敏感人物/组织等表述强度，或更换参考图后重试。'
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
