/**
 * Google Veo video generation adapter for VIPStar-style /v1/videos APIs.
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

export class VeoVideoAdapter implements VideoProviderAdapter {
  provider = 'veo'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const referenceImages = this.getReferenceImages(record)
    const model = this.normalizeModel(record.model || config.model, record.referenceMode, referenceImages.length)
    const body: Record<string, unknown> = {
      prompt: record.prompt || '',
      model,
      enhance_prompt: false,
      enable_upsample: this.shouldEnableUpsample(record.model || config.model),
      aspect_ratio: this.normalizeAspectRatio(record.aspectRatio),
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
      throw new Error(result.error.message || `Veo API error: ${JSON.stringify(result.error)}`)
    }
    if (result.id) {
      return { isAsync: true, taskId: result.id }
    }
    const videoUrl = this.extractVideoUrl(result)
    if (videoUrl) return { isAsync: false, videoUrl }
    throw new Error(`No task ID or video URL in Veo response: ${JSON.stringify(result).slice(0, 200)}`)
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

    const status = result.status
    if (this.isProviderRetrying(result)) {
      return { status: 'processing', raw: result }
    }
    if (
      status === 'completed'
      || status === 'succeeded'
      || status === 'success'
      || status === 'video_generation_completed'
      || status === 'video_upsampling_completed'
    ) {
      const videoUrl = this.extractVideoUrl(result)
      return videoUrl
        ? { status: 'completed', videoUrl }
        : { status: 'failed', error: 'Video completed but no video URL was returned' }
    }
    if (
      status === 'failed'
      || status === 'error'
      || status === 'video_generation_failed'
      || status === 'video_upsampling_failed'
    ) {
      const rawError = this.extractProviderError(result)
      return { status: 'failed', error: this.normalizeProviderError(rawError), raw: result }
    }
    return { status: status || 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.video_url
      || result.output?.video_url
      || result.data?.video_url
      || result.uri
      || result.url
      || null
  }

  private normalizeProviderError(message: string) {
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

  private extractProviderError(result: any): string {
    const candidates = [
      result?.message,
      result?.error?.message,
      result?.error,
      result?.failure_reason,
      result?.fail_reason,
      result?.reason,
      result?.detail,
      result?.details,
      result?.data?.message,
      result?.data?.error?.message,
      result?.data?.error,
      result?.data?.failure_reason,
      result?.output?.message,
      result?.output?.error,
    ]
    for (const item of candidates) {
      if (!item) continue
      if (typeof item === 'string') return item
      try {
        return JSON.stringify(item)
      } catch {}
    }
    return `Video generation failed; raw=${this.safeJson(result, 1200)}`
  }

  private safeJson(value: unknown, maxLength: number) {
    try {
      return JSON.stringify(value).slice(0, maxLength)
    } catch {
      return String(value).slice(0, maxLength)
    }
  }

  private isProviderRetrying(result: any): boolean {
    const detail = result?.detail || result
    const running = detail?.running === true || result?.running === true
    const retryCount = Number(detail?.retry_count ?? result?.retry_count ?? 0)
    const maxRetries = Number(detail?.max_retries ?? result?.max_retries ?? 0)
    const hasRetryBudget = maxRetries > 0 && retryCount < maxRetries
    return running && hasRetryBudget
  }

  private normalizeAspectRatio(ratio?: string | null): string {
    const r = ratio || '16:9'
    if (r === '9:16' || r === '16:9') return r
    return '16:9'
  }

  private shouldEnableUpsample(model: string): boolean {
    return /(?:4k|hd|1080|high)/i.test(model)
  }

  private normalizeModel(model: string | null | undefined, referenceMode?: string | null, referenceCount = 0): string {
    const rawModel = this.firstModel(model) || 'veo3.1-fast'
    const compact = rawModel
      .trim()
      .replace(/^veo_3_1/i, 'veo3.1')
      .replace(/^veo_31/i, 'veo3.1')
      .replace(/^veo3_1/i, 'veo3.1')
      .replace(/^veo31/i, 'veo3.1')

    const isKnownVeoModel = /^veo3(?:\.1)?[-.]?(?:fast|pro|components|fast-frames|4k)/i.test(compact)
    if (compact && !isKnownVeoModel) return compact

    const needsFirstLast = referenceMode === 'first_last'
    const hasReferences = referenceCount > 0 || Boolean(referenceMode && referenceMode !== 'none')

    if (isKnownVeoModel) return compact
    if (needsFirstLast) return 'veo3-fast-frames'
    if (referenceCount > 1) return 'veo3.1-components'
    if (hasReferences) return 'veo3.1-fast'

    return 'veo3.1-fast'
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
}
