/**
 * OpenAI TTS Adapter (gpt-4o-mini-tts / tts-1)
 * 端点: /v1/audio/speech
 * gpt-4o-mini-tts 支持 instructions 参数调整语气
 * 响应: 直接返回二进制音频
 */
import type { TTSProviderAdapter } from './types'
import { joinProviderUrl } from './url'

export interface TTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
}

export class OpenAITTSAdapter implements TTSProviderAdapter {
  readonly provider = 'openai'

  buildGenerateRequest(config: any, params: TTSParams): {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  } {
    const url = joinProviderUrl(config.baseUrl, '/v1', '/audio/speech')

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    }

    // 默认用 gpt-4o-mini-tts，支持 instructions
    // 也支持 tts-1（无 instructions）
    const model = params.model || config.model || 'gpt-4o-mini-tts'

    const body: any = {
      model,
      input: params.text,
      voice: params.voice || 'echo',
    }

    // gpt-4o-mini-tts 支持 instructions 调整语气
    if (params.emotion && model === 'gpt-4o-mini-tts') {
      body.instructions = params.emotion
    }

    // speed 参数
    if (params.speed) {
      body.speed = params.speed
    }

    return { url, method: 'POST', headers, body }
  }

  parseResponse(): { audioHex: string; audioLength: number; sampleRate: number; bitrate: number; format: string; channel: number } {
    return {
      audioHex: '',
      audioLength: 0,
      sampleRate: 24000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    }
  }
}
