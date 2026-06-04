/**
 * Grsai OpenAI 兼容接口 Adapter
 * 端点: /v1/images/generations
 * 支持模型: gpt-image-2 等
 * 响应: { created, data: [{ url }], usage }
 */
import type { ImageProviderAdapter, ProviderRequest, AIConfig, ImageGenerationRecord, ImageGenResponse, ImagePollResponse } from './types'
import { joinProviderUrl } from './url'

export class GrsaiOpenAIImageAdapter implements ImageProviderAdapter {
  provider = 'grsai-openai'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    // 解析参考图
    let image: string | undefined
    if (record.referenceImages) {
      try {
        const refs = JSON.parse(record.referenceImages)
        if (Array.isArray(refs) && refs.length > 0 && refs[0]) {
          image = refs[0]
        }
      } catch {}
    }

    const model = record.model || 'gpt-image-2'

    const body: any = {
      model,
      prompt: record.prompt,
      response_format: 'url',
    }

    if (image) body.image = image
    if (record.size) body.size = record.size

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
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
      throw new Error(result.error.message || 'Grsai OpenAI generation failed')
    }
    const imageUrl = result.data?.[0]?.url
    if (imageUrl) return { isAsync: false, imageUrl }
    throw new Error('No image URL in response')
  }

  buildPollRequest(_config: AIConfig, _taskId: string): ProviderRequest {
    // OpenAI 兼容接口为同步返回，理论上不会调用到此方法
    return { url: '', method: 'GET', headers: {}, body: undefined }
  }

  parsePollResponse(_result: any): ImagePollResponse {
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || null
  }

  extractImageBase64(_result: any): { data: string; mimeType: string } | null {
    return null
  }
}
