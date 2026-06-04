/**
 * Gemini TTS Adapter
 * 端点: /v1beta/models/gemini-2.5-pro-preview-tts:generateContent
 * 响应: base64 编码的音频数据
 */
import type { TTSProviderAdapter } from './types'
import { joinProviderUrl } from './url'
import { getGeminiVoices } from './gemini-voices'

export interface TTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
}

export class GeminiTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'geminitts'

  buildGenerateRequest(config: any, params: TTSParams): {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  } {
    const modelName = params.model || config.model || 'gemini-3.1-flash-tts-preview'
    const voiceName = normalizeGeminiVoice(params.voice)

    const url = new URL(joinProviderUrl(config.baseUrl, '/v1beta', `/models/${modelName}:generateContent`))
    url.searchParams.set('key', config.apiKey)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Gemini TTS 格式 (必须指定 AUDIO modality)
    const body: any = {
      contents: [{
        parts: [{ text: params.text }]
      }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName,
            }
          }
        },
        audioConfig: {
          audioEncoding: 'LINEAR16',
        },
      },
    }

    return { url: url.toString(), method: 'POST', headers, body }
  }

  parseResponse(result: any): { audioHex: string; audioLength: number; sampleRate: number; bitrate: number; format: string; channel: number } {
    if (result.error) {
      throw new Error(result.error.message || 'Gemini TTS generation failed')
    }

    // VIPStar Gemini TTS 响应格式探索
    console.log('[DEBUG] Gemini TTS parseResponse input:', JSON.stringify(result).slice(0, 1000))

    // 遍历多种可能的音频数据路径
    let audioData: string | undefined
    const paths = [
      // 标准 OpenAI兼容格式
      'data.audio',
      'audio',
      // Gemini 格式
      'candidates.[0].content.parts.[0].inlineData.data',
      'candidates.[0].content.parts.[0].inline_data.data',
      'candidates.[0].content.parts.[0].audio',
      'candidates.[0].content.parts.[0].audio.data',
      // VIPStar 可能格式
      'output.audio',
      'output.audio.data',
      'audioContent',
      'audioData',
      // 直接字段
      'audio_data',
      'audioData',
      'data',
    ]

    // 正确的路径解析（支持数组下标）
    const resolvePath = (obj: any, path: string): any => {
      const parts = path.match(/[^.[\]]+|\[\d+\]/g) || []
      let val: any = obj
      for (const part of parts) {
        if (part === '[0]' || part === '0') {
          val = Array.isArray(val) ? val[0] : undefined
        } else {
          val = val?.[part]
        }
        if (val === undefined) break
      }
      return val
    }

    for (const p of paths) {
      const val = resolvePath(result, p)
      console.log(`[DEBUG] Trying path '${p}':`, val === undefined ? 'undefined' : `found (${typeof val}, length=${typeof val === 'string' ? val.length : 'N/A'})`)
      if (val && typeof val === 'string' && val.length > 0) {
        audioData = val
        console.log(`[DEBUG] Audio found at path '${p}', length=${val.length}`)
        break
      }
    }

    if (!audioData) {
      console.error('[ERROR] Gemini TTS response structure:', JSON.stringify(result).slice(0, 2000))
      throw new Error('No audio data in Gemini TTS response')
    }

    return {
      audioHex: audioData,
      audioLength: 0,
      sampleRate: 24000,
      bitrate: 384000,
      format: 'wav',
      channel: 1,
    }
  }
}

function normalizeGeminiVoice(voice?: string | null) {
  const raw = String(voice || '').trim()
  const valid = new Set(getGeminiVoices('gemini').map(v => v.voice_id.toLowerCase()))
  if (raw && valid.has(raw.toLowerCase())) return raw

  const legacyMap: Record<string, string> = {
    alloy: 'Alnilam',
    echo: 'Charon',
    fable: 'Puck',
    onyx: 'Fenrir',
    nova: 'Kore',
    shimmer: 'Leda',
  }
  return legacyMap[raw.toLowerCase()] || 'Charon'
}
