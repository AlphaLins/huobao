/**
 * TTS 语音合成服务
 * 支持 MiniMax TTS (hex 音频响应) 和 OpenAI 兼容 /audio/speech
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { getAudioConfigById } from './ai.js'
import { getTTSAdapter } from './adapters/registry.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, redactUrl } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')

/**
 * 生成 WAV 文件头 (RIFF chunk)
 * 用于 LINEAR16 PCM 格式音频
 */
function createWavHeader(dataSize: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const buffer = Buffer.alloc(44)
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)

  // RIFF header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)  // file size - 8
  buffer.write('WAVE', 8)

  // fmt chunk
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)             // chunk size
  buffer.writeUInt16LE(1, 20)              // audio format (1 = PCM)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)

  // data chunk
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  return buffer
}

interface TTSParams {
  text: string
  voice: string
  model?: string
  speed?: number
  emotion?: string
  configId?: number | null
}

/**
 * 生成 TTS 音频，返回本地文件路径
 */
export async function generateTTS(params: TTSParams): Promise<string> {
  const config = getAudioConfigById(params.configId)
  const adapter = getTTSAdapter(config.provider)

  logTaskStart('AudioTask', 'tts-generate', {
    provider: config.provider,
    voice: params.voice,
    model: params.model || config.model,
    textPreview: params.text.slice(0, 50),
    textLength: params.text.length,
  })
  logTaskPayload('AudioTask', 'tts params', {
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })

  const { url, method, headers, body } = adapter.buildGenerateRequest(config, params)
  logTaskProgress('AudioTask', 'request', {
    provider: config.provider,
    voice: params.voice,
    method,
    url: redactUrl(url),
    model: params.model || config.model,
  })
  logTaskPayload('AudioTask', 'request payload', {
    method,
    url,
    headers,
    body,
  })

  const resp = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    logTaskError('AudioTask', 'tts-generate', { provider: config.provider, voice: params.voice, status: resp.status, error: errText })
    throw new Error(`TTS API error ${resp.status}: ${errText}`)
  }

  // OpenAI /v1/audio/speech 返回二进制，直接写入文件
  if (config.provider === 'openai') {
    const buffer = Buffer.from(await resp.arrayBuffer())
    const audioDir = path.join(STORAGE_ROOT, 'audio')
    fs.mkdirSync(audioDir, { recursive: true })
    const filename = `${uuid()}.mp3`
    const filePath = path.join(audioDir, filename)
    fs.writeFileSync(filePath, buffer)
    const relativePath = `static/audio/${filename}`
    logTaskSuccess('AudioTask', 'tts-saved', {
      provider: config.provider,
      voice: params.voice,
      path: relativePath,
      bytes: buffer.length,
    })
    return relativePath
  }

  // 检测内容类型，判断是二进制音频还是 JSON
  const contentType = resp.headers.get('content-type') || ''
  const isBinaryAudio = contentType.includes('audio') || contentType.includes('mpeg') || contentType.includes('mp3') ||
                        resp.headers.get('content-length') && parseInt(resp.headers.get('content-length')!) > 1000 && !contentType.includes('application/json')

  if (isBinaryAudio) {
    console.log('[DEBUG] Gemini TTS returning binary audio directly, content-type:', contentType)
    const buffer = Buffer.from(await resp.arrayBuffer())
    const audioDir = path.join(STORAGE_ROOT, 'audio')
    fs.mkdirSync(audioDir, { recursive: true })
    const filename = `${uuid()}.mp3`
    const filePath = path.join(audioDir, filename)
    fs.writeFileSync(filePath, buffer)
    const relativePath = `static/audio/${filename}`
    logTaskSuccess('AudioTask', 'tts-saved', {
      provider: config.provider,
      voice: params.voice,
      path: relativePath,
      bytes: buffer.length,
    })
    return relativePath
  }

  const result = await resp.json()
  const parsed = adapter.parseResponse(result)

  // 将 hex 或 base64 解码为二进制
  // 注意：Buffer.from(str, 'hex') 对无效hex字符不会抛异常而是忽略，
  // 所以需要先检查字符串是否只包含有效hex字符
  let buffer: Buffer
  const hexOnly = /^[0-9a-fA-F]+$/.test(parsed.audioHex)
  if (hexOnly) {
    buffer = Buffer.from(parsed.audioHex, 'hex')
  } else {
    // 尝试 base64 解码
    try {
      buffer = Buffer.from(parsed.audioHex, 'base64')
    } catch {
      // 最后的兜底：原始二进制
      buffer = Buffer.from(parsed.audioHex)
    }
  }

  console.log('[DEBUG] Audio decoded: hexOnly=', hexOnly, 'buffer.length=', buffer.length)

  // PCM 格式需要添加 WAV 头才能播放
  let finalBuffer = buffer
  if (parsed.format === 'wav' && buffer.length > 0) {
    const wavHeader = createWavHeader(buffer.length, parsed.sampleRate, parsed.channel, 16)
    finalBuffer = Buffer.concat([wavHeader, buffer])
    console.log('[DEBUG] WAV header added, final size:', finalBuffer.length)
  }

  // 保存到本地
  const audioDir = path.join(STORAGE_ROOT, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const filename = `${uuid()}.${parsed.format || 'mp3'}`
  const filePath = path.join(audioDir, filename)
  fs.writeFileSync(filePath, finalBuffer)

  const relativePath = `static/audio/${filename}`
  logTaskSuccess('AudioTask', 'tts-saved', {
    provider: config.provider,
    voice: params.voice,
    path: relativePath,
    bytes: finalBuffer.length,
    audioMs: parsed.audioLength,
  })
  return relativePath
}

/**
 * 为角色生成试听音频
 */
export async function generateVoiceSample(characterName: string, voiceId: string, configId?: number | null): Promise<string> {
  const sampleText = `你好，我是${characterName}。很高兴认识你，这是我的声音试听。`
  return generateTTS({ text: sampleText, voice: voiceId, configId })
}
