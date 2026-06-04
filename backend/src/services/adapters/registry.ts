/**
 * Provider Adapter 注册表
 * 根据 provider 名称返回对应的 Adapter 实例
 */
import { MiniMaxImageAdapter } from './minimax-image'
import { MiniMaxVideoAdapter } from './minimax-video'
import { MiniMaxTTSAdapter } from './minimax-tts'
import { OpenAIImageAdapter } from './openai-image'
import { OpenAITTSAdapter } from './openai-tts'
import { GeminiImageAdapter } from './gemini-image'
import { GeminiTTSAdapter } from './gemini-tts'
import { GrsaiImageAdapter } from './grsai-image'
import { GrsaiOpenAIImageAdapter } from './grsai-openai-image'
import { VolcEngineImageAdapter } from './volcengine-image'
import { VolcEngineVideoAdapter } from './volcengine-video'
import { ViduVideoAdapter } from './vidu-video'
import { AliImageAdapter } from './ali-image'
import { AliVideoAdapter } from './ali-video'
import { VeoVideoAdapter } from './veo-video'
import { SoraVideoAdapter } from './sora-video'
import { ApimartImageAdapter } from './apimart-image'
import { ApimartVideoAdapter } from './apimart-video'
import type { ImageProviderAdapter, VideoProviderAdapter, TTSProviderAdapter } from './types'

// 图片 Adapter 注册表
export const imageAdapters: Record<string, ImageProviderAdapter> = {
  minimax: new MiniMaxImageAdapter(),
  openai: new OpenAIImageAdapter(),
  gemini: new GeminiImageAdapter(),
  volcengine: new VolcEngineImageAdapter(),
  ali: new AliImageAdapter(),
  // Chatfire - 待确认 API 格式，暂用 OpenAI
  chatfire: new OpenAIImageAdapter(),
  // Grsai/Nano-banana 图片生成
  grsai: new GrsaiImageAdapter(),
  // Grsai OpenAI 兼容接口
  'grsai-openai': new GrsaiOpenAIImageAdapter(),
  apimart: new ApimartImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  minimax: new MiniMaxVideoAdapter(),
  volcengine: new VolcEngineVideoAdapter(),
  vidu: new ViduVideoAdapter(),
  ali: new AliVideoAdapter(),
  veo: new VeoVideoAdapter(),
  grok: new VeoVideoAdapter(),
  xai: new VeoVideoAdapter(),
  sora: new SoraVideoAdapter(),
  openai_sora: new SoraVideoAdapter(),
  openai: new SoraVideoAdapter(),
  vipstar: new SoraVideoAdapter(),
  apimart: new ApimartVideoAdapter(),
  // Chatfire 视频 - 待确认 API 格式
}

// TTS Adapter 注册表
export const ttsAdapters: Record<string, TTSProviderAdapter> = {
  minimax: new MiniMaxTTSAdapter(),
  openai: new OpenAITTSAdapter(),
  gemini: new GeminiTTSAdapter(),
  apimart: new OpenAITTSAdapter(),
}

export function getTTSAdapter(provider: string): TTSProviderAdapter {
  return ttsAdapters[provider.toLowerCase()] || ttsAdapters['minimax']
}

/**
 * 获取图片 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter，未知厂商返回 MiniMax 默认
 */
export function getImageAdapter(provider: string): ImageProviderAdapter {
  return imageAdapters[provider.toLowerCase()] || imageAdapters['minimax']
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter，未知厂商返回 MiniMax 默认
 */
export function getVideoAdapter(provider: string): VideoProviderAdapter {
  return videoAdapters[provider.toLowerCase()] || videoAdapters['minimax']
}

export function getVideoAdapterForModel(provider: string, model?: string | null): VideoProviderAdapter {
  if (provider.toLowerCase() === 'apimart') return videoAdapters['apimart']
  const family = detectVideoModelFamily(model)
  if (family && videoAdapters[family]) return videoAdapters[family]
  return getVideoAdapter(provider)
}

export function detectVideoModelFamily(model?: string | null): string | null {
  const first = firstModel(model).toLowerCase()
  if (!first) return null
  if (first.startsWith('sora')) return 'sora'
  if (first.startsWith('omni') || first.includes('omni-video')) return 'sora'
  if (first.startsWith('grok') || first.includes('grok-video')) return 'grok'
  if (first.startsWith('veo') || first.startsWith('veo_')) return 'veo'
  return null
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
