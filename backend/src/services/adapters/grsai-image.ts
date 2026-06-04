/**
 * Grsai/Nano-banana 图片生成 Adapter
 * 端点: /v1/api/generate
 * 支持模型: nano-banana, nano-banana-2, nano-banana-pro 等
 * 响应: { id, status, results: [{ url }] }
 */
import type { ImageProviderAdapter, ProviderRequest, AIConfig, ImageGenerationRecord, ImageGenResponse, ImagePollResponse } from './types'
import { joinProviderUrl } from './url'

export class GrsaiImageAdapter implements ImageProviderAdapter {
  provider = 'grsai'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    // 解析参考图（角色形象、场景图等）
    let images: string[] = []
    if (record.referenceImages) {
      try {
        const refs = JSON.parse(record.referenceImages)
        if (Array.isArray(refs) && refs.length > 0) {
          images = refs.filter(Boolean).slice(0, 6)
        }
      } catch {}
    }

    const model = record.model || 'nano-banana-2'
    const isGptImage = model.startsWith('gpt-image')
    const isVip = model.includes('vip')

    const body: any = {
      model,
      prompt: record.prompt,
      images,
      replyType: images.length ? 'async' : 'json',
    }

    if (isGptImage) {
      // gpt-image-2: vip 用像素值, 非vip 用比例或像素值
      body.aspectRatio = isVip
      body.aspectRatio = this.parsePixelSize(record.size)
      if (isVip) body.replyType = 'async'
      // 不发送 imageSize
    } else {
      // nano-banana 系列
      body.aspectRatio = this.parseAspectRatio(record.size)
      body.imageSize = this.parseImageSize(record.size)
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1/api', '/generate'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    if (result.error) {
      throw new Error(result.error.message || 'Grsai generation failed')
    }

    if (result.status === 'succeeded' && result.results?.[0]?.url) {
      return { isAsync: false, imageUrl: result.results[0].url }
    }

    if (result.status === 'running' || result.status === 'pending') {
      return { isAsync: true, taskId: result.id }
    }

    if (result.status === 'failed' || result.status === 'violation') {
      throw new Error(result.error || `Generation ${result.status}`)
    }

    return { isAsync: true, taskId: result.id }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const url = new URL(joinProviderUrl(config.baseUrl, '/v1/api', '/result'))
    url.searchParams.set('id', taskId)
    return {
      url: url.toString(),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    if (result.status === 'succeeded' && result.results?.[0]?.url) {
      return { status: 'completed', imageUrl: result.results[0].url }
    }
    if (result.status === 'failed') {
      return { status: 'failed', error: result.error || 'Generation failed' }
    }
    if (result.status === 'violation') {
      return { status: 'failed', error: 'Content violates policy' }
    }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.results?.[0]?.url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    return null
  }

  private parsePixelSize(size?: string | null): string {
    if (!size) return '1024x1024'
    // 如果已经是像素格式 (NxN)，直接返回
    if (/^\d+x\d+$/.test(size)) return size
    // 比例→像素映射（取 1K 基准）
    const map: Record<string, string> = {
      '1:1': '1024x1024', '16:9': '1280x720', '9:16': '720x1280',
      '4:3': '1152x864', '3:4': '864x1152', '3:2': '1536x1024',
      '2:3': '1024x1536', '5:4': '1120x896', '4:5': '896x1120',
      '21:9': '1456x624',
    }
    return map[size] || '1024x1024'
  }

  private parseAspectRatio(size?: string | null): string {
    if (!size) return '1:1'
    if (/^\d+\s*:\s*\d+$/.test(size)) return size.replace(/\s+/g, '')
    const [w, h] = (size || '1:1').split('x').map(Number)
    if (!w || !h) return '1:1'

    // 常见的比例映射
    const ratio = w / h
    if (Math.abs(ratio - 1) < 0.1) return '1:1'
    if (Math.abs(ratio - 16 / 9) < 0.1) return '16:9'
    if (Math.abs(ratio - 9 / 16) < 0.1) return '9:16'
    if (Math.abs(ratio - 4 / 3) < 0.1) return '4:3'
    if (Math.abs(ratio - 3 / 4) < 0.1) return '3:4'
    if (Math.abs(ratio - 3 / 2) < 0.1) return '3:2'
    if (Math.abs(ratio - 2 / 3) < 0.1) return '2:3'

    return '1:1'
  }

  private parseImageSize(size?: string | null): string {
    if (!size) return '1K'
    const [w] = (size || '1024x1024').split('x').map(Number)
    if (!w) return '1K'
    if (w >= 2048) return '4K'
    if (w >= 1024) return '2K'
    return '1K'
  }
}
