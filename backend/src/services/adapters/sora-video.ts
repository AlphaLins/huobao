/**
 * Sora video generation adapter for VipStar-style /v1/video APIs.
 */
import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { joinProviderUrl } from './url'

export class SoraVideoAdapter implements VideoProviderAdapter {
  provider = 'sora'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const referenceImages = this.getReferenceImages(record)
    const body: Record<string, unknown> = {
      model: this.firstModel(record.model || config.model) || 'sora-2',
      prompt: record.prompt || '',
      orientation: this.orientationFromAspectRatio(record.aspectRatio),
      size: this.sizeFromModel(record.model || config.model),
      duration: this.normalizeDuration(record.duration),
      watermark: false,
    }
    if (referenceImages.length) body.images = referenceImages

    const base = config.baseUrl || 'https://vipstar.vip'
    return {
      url: joinProviderUrl(base, '/v1', '/video/create'),
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
    if (result.error) {
      throw new Error(result.error.message || `Sora API error: ${JSON.stringify(result.error)}`)
    }
    if (result.id) return { isAsync: true, taskId: result.id }
    const videoUrl = this.extractVideoUrl(result)
    if (videoUrl) return { isAsync: false, videoUrl }
    throw new Error(`No task ID or video URL in Sora response: ${JSON.stringify(result).slice(0, 300)}`)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const base = config.baseUrl || 'https://vipstar.vip'
    return {
      url: `${joinProviderUrl(base, '/v1', '/video/query')}?id=${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    if (result.error) {
      const message = result.error.message || JSON.stringify(result.error)
      return { status: 'failed', error: this.normalizeProviderError(message), raw: result }
    }

    const detail = result.detail || result.data || result.output || result
    const status = String(detail.status || result.status || '').toLowerCase()

    if (this.isProviderRetrying(result)) return { status: 'processing', raw: result }

    if (this.isCompletedStatus(status)) {
      const videoUrl = this.extractVideoUrl(result)
      return videoUrl
        ? { status: 'completed', videoUrl, raw: result }
        : { status: 'failed', error: 'Sora completed but no video URL was returned', raw: result }
    }

    if (this.isFailedStatus(status)) {
      return { status: 'failed', error: this.normalizeProviderError(this.extractProviderError(result)), raw: result }
    }

    return { status: 'processing', raw: result }
  }

  extractVideoUrl(result: any): string | null {
    const detail = result.detail || result.data || result.output || result
    return result.video_url
      || result.videoUrl
      || result.url
      || result.uri
      || result.data?.video_url
      || result.data?.videoUrl
      || result.output?.video_url
      || result.output?.videoUrl
      || result.result?.video_url
      || result.result?.videoUrl
      || detail.video_url
      || detail.videoUrl
      || detail.url
      || detail.uri
      || detail.video?.url
      || detail.videos?.[0]?.url
      || detail.media?.url
      || null
  }

  private isCompletedStatus(status: string) {
    return [
      'completed',
      'succeeded',
      'success',
      'done',
      'video_generation_completed',
      'video_completed',
    ].includes(status)
  }

  private isFailedStatus(status: string) {
    return [
      'failed',
      'error',
      'video_generation_failed',
      'video_failed',
    ].includes(status)
  }

  private normalizeProviderError(message: string) {
    const raw = String(message || '')
    if (
      raw.includes('reCAPTCHA evaluation failed')
      || raw.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY')
      || raw.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC')
    ) {
      return 'Sora 上游风控拒绝：reCAPTCHA evaluation failed。请稍后重试，避免并发提交；如果持续出现，请更换 VipStar API Key、账号或网络出口。'
    }
    return raw || 'Sora video generation failed'
  }

  private extractProviderError(result: any): string {
    const detail = result?.detail || result
    const candidates = [
      result?.message,
      result?.error?.message,
      result?.error,
      detail?.error_message,
      detail?.message,
      detail?.error?.message,
      detail?.error,
      detail?.failure_reason,
      detail?.fail_reason,
      detail?.reason,
      detail?.detail,
      detail?.details,
    ]
    for (const item of candidates) {
      if (!item) continue
      if (typeof item === 'string') return item
      try {
        return JSON.stringify(item)
      } catch {}
    }
    return `Sora video generation failed; raw=${this.safeJson(result, 1200)}`
  }

  private isProviderRetrying(result: any): boolean {
    const detail = result?.detail || result
    const running = detail?.running === true || result?.running === true
    const retryCount = Number(detail?.retry_count ?? result?.retry_count ?? 0)
    const maxRetries = Number(detail?.max_retries ?? result?.max_retries ?? 0)
    return running && maxRetries > 0 && retryCount < maxRetries
  }

  private getReferenceImages(record: VideoGenerationRecord): string[] {
    const refs: string[] = []
    const push = (value?: string | null) => {
      const normalized = String(value || '').trim()
      if (normalized && !refs.includes(normalized)) refs.push(normalized)
    }

    if (record.referenceMode === 'first_last') {
      push(record.firstFrameUrl || record.imageUrl)
      push(record.lastFrameUrl)
      return refs.slice(0, 2)
    }

    push(record.imageUrl || record.firstFrameUrl)
    if (record.referenceImageUrls) {
      try {
        const parsed = JSON.parse(record.referenceImageUrls)
        if (Array.isArray(parsed)) parsed.forEach(push)
      } catch {}
    }
    return refs.slice(0, 3)
  }

  private orientationFromAspectRatio(ratio?: string | null) {
    if (ratio === '9:16') return 'portrait'
    return 'landscape'
  }

  private normalizeDuration(duration?: number | null) {
    const value = Number(duration || 10)
    if (value <= 4) return 4
    if (value <= 8) return 8
    return 12
  }

  private sizeFromModel(model?: string | null) {
    return /(?:720p|small|low)/i.test(String(model || '')) ? 'small' : 'large'
  }

  private firstModel(model: string | null | undefined): string {
    const raw = String(model || '').trim()
    if (!raw) return ''
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return String(parsed[0] || '').trim()
    } catch {}
    return raw
  }

  private safeJson(value: unknown, maxLength: number) {
    try {
      return JSON.stringify(value).slice(0, maxLength)
    } catch {
      return String(value).slice(0, maxLength)
    }
  }
}
