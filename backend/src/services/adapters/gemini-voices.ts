export type StaticVoice = {
  voice_id: string
  voice_name: string
  description: string[]
  language: string
  provider: string
}

const GEMINI_VOICE_DESCRIPTIONS: Array<[string, string, string[]]> = [
  ['Zephyr', 'Zephyr', ['Bright']],
  ['Puck', 'Puck', ['Upbeat']],
  ['Charon', 'Charon', ['Informative']],
  ['Kore', 'Kore', ['Firm']],
  ['Fenrir', 'Fenrir', ['Excitable']],
  ['Leda', 'Leda', ['Youthful']],
  ['Orus', 'Orus', ['Firm']],
  ['Aoede', 'Aoede', ['Breezy']],
  ['Callirrhoe', 'Callirrhoe', ['Easy-going']],
  ['Autonoe', 'Autonoe', ['Bright']],
  ['Enceladus', 'Enceladus', ['Breathy']],
  ['Iapetus', 'Iapetus', ['Clear']],
  ['Umbriel', 'Umbriel', ['Easy-going']],
  ['Algieba', 'Algieba', ['Smooth']],
  ['Despina', 'Despina', ['Smooth']],
  ['Erinome', 'Erinome', ['Clear']],
  ['Algenib', 'Algenib', ['Gravelly']],
  ['Rasalgethi', 'Rasalgethi', ['Informative']],
  ['Laomedeia', 'Laomedeia', ['Upbeat']],
  ['Achernar', 'Achernar', ['Soft']],
  ['Alnilam', 'Alnilam', ['Firm']],
  ['Schedar', 'Schedar', ['Even']],
  ['Gacrux', 'Gacrux', ['Mature']],
  ['Pulcherrima', 'Pulcherrima', ['Forward']],
  ['Achird', 'Achird', ['Friendly']],
  ['Zubenelgenubi', 'Zubenelgenubi', ['Casual']],
  ['Vindemiatrix', 'Vindemiatrix', ['Gentle']],
  ['Sadachbia', 'Sadachbia', ['Lively']],
  ['Sadaltager', 'Sadaltager', ['Knowledgeable']],
  ['Sulafat', 'Sulafat', ['Warm']],
]

export function getGeminiVoices(provider = 'gemini'): StaticVoice[] {
  return GEMINI_VOICE_DESCRIPTIONS.map(([voiceId, voiceName, description]) => ({
    voice_id: voiceId,
    voice_name: voiceName,
    description,
    language: 'Multilingual',
    provider,
  }))
}

export function isGeminiVoiceProvider(provider?: string | null) {
  const normalized = String(provider || '').toLowerCase()
  return normalized === 'gemini' || normalized === 'geminitts' || normalized === 'google'
}
