import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getTextConfig, getTextProviderBaseUrl } from '../services/ai.js'
import { generateImage } from '../services/image-generation.js'
import { generateTTS } from '../services/tts-generation.js'
import { generateVideo } from '../services/video-generation.js'
import { success, badRequest, forbidden, now } from '../utils/response.js'
import { canAccessDrama, canAccessEpisode, canAccessStoryboard } from '../utils/ownership.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

type AssistantActionType =
  | 'inspect_episode_gaps'
  | 'update_storyboard_fields'
  | 'generate_storyboard_image'
  | 'generate_storyboard_video'
  | 'generate_storyboard_tts'

type AssistantAction = {
  type: AssistantActionType
  label?: string
  description?: string
  payload?: Record<string, any>
}

const ACTION_TYPES: AssistantActionType[] = [
  'inspect_episode_gaps',
  'update_storyboard_fields',
  'generate_storyboard_image',
  'generate_storyboard_video',
  'generate_storyboard_tts',
]

const ACTION_LABELS: Record<AssistantActionType, string> = {
  inspect_episode_gaps: '检查当前集缺失项',
  update_storyboard_fields: '更新分镜字段',
  generate_storyboard_image: '生成分镜图片',
  generate_storyboard_video: '生成分镜视频',
  generate_storyboard_tts: '生成分镜配音',
}

const STORYBOARD_FIELD_MAP: Record<string, string> = {
  title: 'title',
  description: 'description',
  action: 'action',
  dialogue: 'dialogue',
  duration: 'duration',
  image_prompt: 'imagePrompt',
  imagePrompt: 'imagePrompt',
  video_prompt: 'videoPrompt',
  videoPrompt: 'videoPrompt',
  atmosphere: 'atmosphere',
  bgm_prompt: 'bgmPrompt',
  bgmPrompt: 'bgmPrompt',
  sound_effect: 'soundEffect',
  soundEffect: 'soundEffect',
  shot_type: 'shotType',
  shotType: 'shotType',
  angle: 'angle',
  movement: 'movement',
  location: 'location',
  time: 'time',
}

const ASSISTANT_PROMPT = `你是“火宝短剧制作顾问”，服务于 Huobao Drama 这个 AI 短剧/视频生产工作台。

职责：
- 帮用户优化图片、视频、角色、场景、分镜相关提示词。
- 指导用户完成生成流程，例如先补剧本、再拆分镜、再生图、生视频、合成。
- 根据当前页面和数据库上下文给出具体建议。
- 当用户明确希望你检查、更新或生成时，你可以提出一个待确认动作，但不要声称已经执行。

可提出的动作类型仅限：
- inspect_episode_gaps：检查当前集缺失项。
- update_storyboard_fields：更新某个分镜的提示词或描述字段。
- generate_storyboard_image：为某个分镜生成图片。
- generate_storyboard_video：为某个分镜生成视频。
- generate_storyboard_tts：为某个分镜生成配音。

动作输出格式：
如果需要动作，请在正常回复末尾追加一个独立 JSON 块：
<assistant_actions>[{"type":"inspect_episode_gaps","label":"检查当前集缺失项","payload":{"drama_id":10,"episode_number":1}}]</assistant_actions>

规则：
- 动作只表示“建议执行”，必须由用户点击确认后才会真正执行。
- 不要提出删除、导出、修改账号、查看密钥、修改系统配置等动作。
- 不要泄露或猜测 API Key、服务器路径、系统配置等敏感信息。
- 默认用中文回答。
- 回复可以使用 Markdown。`

function clipText(value: unknown, limit: number) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function normalizeMessages(input: any): ChatMessage[] {
  if (!Array.isArray(input)) return []
  return input
    .map((msg) => ({
      role: (msg?.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: clipText(msg?.content, 4000),
    }))
    .filter((msg) => msg.content)
    .slice(-12)
}

function buildDbContext(c: any, context: any) {
  const parts: string[] = []
  const dramaId = Number(context?.drama_id || context?.dramaId || 0)
  const episodeNumber = Number(context?.episode_number || context?.episodeNumber || 0)

  if (!dramaId || !canAccessDrama(c, dramaId)) return ''

  const [drama] = db.select().from(schema.dramas)
    .where(and(eq(schema.dramas.id, dramaId), isNull(schema.dramas.deletedAt)))
    .all()
  if (!drama) return ''

  parts.push(`当前项目：${drama.title}`)
  if (drama.description) parts.push(`项目简介：${clipText(drama.description, 800)}`)
  if (drama.genre) parts.push(`类型：${drama.genre}`)
  if (drama.style) parts.push(`风格：${drama.style}`)

  const episodes = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .orderBy(schema.episodes.episodeNumber)
    .all()

  const episode = episodeNumber
    ? episodes.find((ep) => ep.episodeNumber === episodeNumber)
    : episodes[0]

  if (episode) {
    parts.push(`当前集：第 ${episode.episodeNumber} 集，${episode.title}`)
    if (episode.content) parts.push(`原始内容摘要：${clipText(episode.content, 1200)}`)
    if (episode.scriptContent) parts.push(`剧本摘要：${clipText(episode.scriptContent, 1600)}`)

    const storyboards = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episode.id))
      .orderBy(schema.storyboards.storyboardNumber)
      .all()
      .slice(0, 30)
    if (storyboards.length) {
      parts.push(`当前集分镜：${storyboards.map((sb) => {
        const title = sb.title || `镜头${sb.storyboardNumber}`
        const prompt = sb.videoPrompt || sb.imagePrompt || sb.description || sb.action || ''
        return `#${sb.storyboardNumber} id=${sb.id} ${title}：${clipText(prompt, 180)}`
      }).join('\n')}`)
    }
  }

  const characters = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, dramaId))
    .all()
    .filter((char) => !char.deletedAt)
    .slice(0, 20)
  if (characters.length) {
    parts.push(`角色：${characters.map((char) => `${char.name}(${char.role || '角色'})`).join('、')}`)
  }

  const scenes = db.select().from(schema.scenes)
    .where(eq(schema.scenes.dramaId, dramaId))
    .all()
    .filter((scene) => !scene.deletedAt)
    .slice(0, 20)
  if (scenes.length) {
    parts.push(`场景：${scenes.map((scene) => `${scene.location}/${scene.time}`).join('、')}`)
  }

  return parts.join('\n\n')
}

function parseActions(text: string): { message: string; actions: AssistantAction[] } {
  const match = text.match(/<assistant_actions>([\s\S]*?)<\/assistant_actions>/)
  if (!match) return { message: text.trim(), actions: [] }

  const message = text.replace(match[0], '').trim()
  try {
    const parsed = JSON.parse(match[1])
    return { message, actions: Array.isArray(parsed) ? parsed : [] }
  } catch {
    return { message, actions: [] }
  }
}

function buildFallbackActions(message: string, context: any): AssistantAction[] {
  const text = message.toLowerCase()
  const dramaId = Number(context?.drama_id || context?.dramaId || 0)
  const episodeNumber = Number(context?.episode_number || context?.episodeNumber || 0)
  if (!dramaId || !episodeNumber) return []

  if (/(检查|缺失|缺什么|还缺|进度|完成度)/.test(text)) {
    return [{
      type: 'inspect_episode_gaps',
      label: ACTION_LABELS.inspect_episode_gaps,
      payload: { drama_id: dramaId, episode_number: episodeNumber },
    }]
  }

  return []
}

function normalizeAction(action: any, context: any): AssistantAction | null {
  if (!action || !ACTION_TYPES.includes(action.type)) return null
  const payload = { ...(action.payload || {}) }
  if (!payload.drama_id && context?.drama_id) payload.drama_id = Number(context.drama_id)
  if (!payload.episode_number && context?.episode_number) payload.episode_number = Number(context.episode_number)

  return {
    type: action.type,
    label: clipText(action.label || ACTION_LABELS[action.type as AssistantActionType], 80),
    description: action.description ? clipText(action.description, 240) : '',
    payload,
  }
}

function resolveEpisode(c: any, payload: Record<string, any>) {
  const episodeId = Number(payload.episode_id || payload.episodeId || 0)
  if (episodeId) {
    if (!canAccessEpisode(c, episodeId)) return null
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
    return episode || null
  }

  const dramaId = Number(payload.drama_id || payload.dramaId || 0)
  const episodeNumber = Number(payload.episode_number || payload.episodeNumber || 0)
  if (!dramaId || !episodeNumber || !canAccessDrama(c, dramaId)) return null

  const [episode] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), eq(schema.episodes.episodeNumber, episodeNumber)))
    .all()
  return episode || null
}

function resolveStoryboard(c: any, payload: Record<string, any>) {
  const storyboardId = Number(payload.storyboard_id || payload.storyboardId || 0)
  if (storyboardId) {
    if (!canAccessStoryboard(c, storyboardId)) return null
    const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
    return storyboard || null
  }

  const episode = resolveEpisode(c, payload)
  const storyboardNumber = Number(payload.storyboard_number || payload.storyboardNumber || payload.shot_number || 0)
  if (!episode || !storyboardNumber) return null

  const [storyboard] = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episode.id), eq(schema.storyboards.storyboardNumber, storyboardNumber)))
    .all()
  return storyboard || null
}

function getReferenceImages(sb: any) {
  const refs: string[] = []
  if (sb.firstFrameImage) refs.push(sb.firstFrameImage)
  if (sb.composedImage) refs.push(sb.composedImage)
  if (sb.referenceImages) {
    try {
      const parsed = JSON.parse(sb.referenceImages)
      if (Array.isArray(parsed)) refs.push(...parsed.filter(Boolean))
    } catch {
      // Ignore malformed reference image metadata.
    }
  }
  if (sb.lastFrameImage) refs.push(sb.lastFrameImage)
  return [...new Set(refs)].filter(Boolean).slice(0, 6)
}

function parseDialogueForTTS(dialogue?: string | null) {
  const raw = dialogue?.trim() || ''
  if (!raw) return { speaker: '', pureText: '', ignorable: true }
  const speakerMatch = raw.match(/^(.+?)[:：]/)
  const speaker = speakerMatch ? speakerMatch[1].replace(/[（(].+?[)）]/g, '').trim() : ''
  const pureText = raw.replace(/^.+?[:：]\s*/, '').replace(/[（(].+?[)）]/g, '').trim()
  const ignorable = !pureText || /^(无|无对白|无台词|无需配音|none|null|n\/a|na|bgm|sfx|ambient)$/i.test(pureText)
  return { speaker, pureText, ignorable }
}

function inspectEpisode(c: any, payload: Record<string, any>) {
  const episode = resolveEpisode(c, payload)
  if (!episode) return { ok: false, message: '没有找到可访问的当前集。' }

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episode.id))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const missing = storyboards.map((sb) => {
    const items: string[] = []
    if (!sb.imagePrompt) items.push('图片提示词')
    if (!sb.videoPrompt) items.push('视频提示词')
    if (!sb.firstFrameImage && !sb.composedImage) items.push('图片/首帧')
    if (!sb.videoUrl) items.push('视频')
    if (sb.dialogue && !sb.ttsAudioUrl) items.push('配音')
    return items.length ? `#${sb.storyboardNumber} ${sb.title || ''}：${items.join('、')}` : ''
  }).filter(Boolean)

  const readyVideos = storyboards.filter((sb) => !!sb.videoUrl).length
  const readyImages = storyboards.filter((sb) => !!(sb.firstFrameImage || sb.composedImage)).length
  const readyTts = storyboards.filter((sb) => !sb.dialogue || !!sb.ttsAudioUrl).length

  return {
    ok: true,
    message: [
      `第 ${episode.episodeNumber} 集共有 ${storyboards.length} 个分镜。`,
      `图片完成 ${readyImages}/${storyboards.length}，视频完成 ${readyVideos}/${storyboards.length}，配音完成 ${readyTts}/${storyboards.length}。`,
      missing.length ? `缺失项：\n${missing.slice(0, 30).join('\n')}` : '当前没有发现明显缺失项。',
    ].join('\n'),
    episode_id: episode.id,
    storyboard_count: storyboards.length,
    missing_count: missing.length,
  }
}

async function executeAction(c: any, action: AssistantAction) {
  const payload = action.payload || {}

  if (action.type === 'inspect_episode_gaps') {
    return inspectEpisode(c, payload)
  }

  const sb = resolveStoryboard(c, payload)
  if (!sb) return { ok: false, message: '没有找到可访问的分镜。请先说明镜头编号或打开对应页面。' }

  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!episode || !canAccessEpisode(c, episode.id)) return { ok: false, message: '没有找到可访问的当前集。' }

  if (action.type === 'update_storyboard_fields') {
    const fields = payload.fields || {}
    const updates: Record<string, any> = { updatedAt: now() }
    for (const [key, value] of Object.entries(fields)) {
      const mapped = STORYBOARD_FIELD_MAP[key]
      if (mapped) updates[mapped] = value
    }
    if (Object.keys(updates).length === 1) return { ok: false, message: '没有可更新的分镜字段。' }
    if ('dialogue' in updates) {
      updates.ttsAudioUrl = null
      updates.subtitleUrl = null
    }
    db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, sb.id)).run()
    return { ok: true, message: `已更新第 ${sb.storyboardNumber} 个分镜。`, storyboard_id: sb.id }
  }

  if (action.type === 'generate_storyboard_image') {
    const prompt = clipText(payload.prompt || sb.imagePrompt || sb.description || sb.action || sb.title, 6000)
    if (!prompt) return { ok: false, message: '这个分镜没有可用于生成图片的提示词。' }
    const generationId = await generateImage({
      storyboardId: sb.id,
      dramaId: episode.dramaId,
      prompt,
      frameType: payload.frame_type || 'first_frame',
      referenceImages: getReferenceImages(sb),
      configId: episode.imageConfigId ?? undefined,
    })
    return { ok: true, message: `已开始生成第 ${sb.storyboardNumber} 个分镜图片。`, generation_id: generationId }
  }

  if (action.type === 'generate_storyboard_video') {
    const prompt = clipText(payload.prompt || sb.videoPrompt || sb.description || sb.action || sb.title, 6000)
    if (!prompt) return { ok: false, message: '这个分镜没有可用于生成视频的提示词。' }

    const refs = getReferenceImages(sb)
    const params: any = {
      storyboardId: sb.id,
      dramaId: episode.dramaId,
      prompt,
      duration: Number(payload.duration || sb.duration || 5),
      configId: episode.videoConfigId ?? undefined,
    }
    if (sb.firstFrameImage && sb.lastFrameImage) {
      params.referenceMode = 'first_last'
      params.firstFrameUrl = sb.firstFrameImage
      params.lastFrameUrl = sb.lastFrameImage
    } else if (refs.length > 1) {
      params.referenceMode = 'multiple'
      params.referenceImageUrls = refs
    } else if (refs.length === 1) {
      params.referenceMode = 'single'
      params.imageUrl = refs[0]
    }

    const generationId = await generateVideo(params)
    return { ok: true, message: `已开始生成第 ${sb.storyboardNumber} 个分镜视频。`, generation_id: generationId }
  }

  if (action.type === 'generate_storyboard_tts') {
    const parsed = parseDialogueForTTS(sb.dialogue)
    if (parsed.ignorable) return { ok: false, message: '这个分镜没有可用于配音的对白。' }
    let voiceId = 'alloy'
    if (parsed.speaker && !/^(旁白|narrator)$/i.test(parsed.speaker)) {
      const chars = db.select().from(schema.characters).where(eq(schema.characters.dramaId, episode.dramaId)).all()
      const found = chars.find((char) => char.name === parsed.speaker)
      if (found?.voiceStyle) voiceId = found.voiceStyle
    }
    const audioPath = await generateTTS({ text: parsed.pureText, voice: voiceId, configId: episode.audioConfigId || null })
    db.update(schema.storyboards)
      .set({ ttsAudioUrl: audioPath, updatedAt: now() })
      .where(eq(schema.storyboards.id, sb.id))
      .run()
    return { ok: true, message: `已生成第 ${sb.storyboardNumber} 个分镜配音。`, tts_audio_url: audioPath }
  }

  return { ok: false, message: '不支持的动作。' }
}

app.post('/chat', async (c) => {
  const body = await c.req.json()
  const messages = normalizeMessages(body.messages)
  const latestUserMessage = messages.filter((msg) => msg.role === 'user').at(-1)
  if (!latestUserMessage) return badRequest(c, 'message is required')

  const context = body.context || {}
  const dbContext = buildDbContext(c, context)
  const pageContext = [
    context.route ? `当前路由：${context.route}` : '',
    context.title ? `页面标题：${clipText(context.title, 200)}` : '',
    context.page_text ? `当前页面可见内容：${clipText(context.page_text, 3000)}` : '',
  ].filter(Boolean).join('\n')

  logTaskStart('Assistant', 'chat', {
    route: context.route,
    dramaId: context.drama_id,
    messageLength: latestUserMessage.content.length,
  })

  try {
    const textConfig = getTextConfig()
    const provider = createOpenAI({
      baseURL: getTextProviderBaseUrl(textConfig),
      apiKey: textConfig.apiKey,
    } as any)

    const agent = new Agent({
      id: 'huobao-assistant',
      name: '火宝短剧制作顾问',
      instructions: ASSISTANT_PROMPT,
      model: provider.chat(textConfig.model),
    })

    const result = await agent.generate([
      {
        role: 'system',
        content: [
          '以下是当前工作台上下文，只能用于回答、建议和提出待确认动作：',
          pageContext,
          dbContext,
        ].filter(Boolean).join('\n\n'),
      },
      ...messages,
    ] as any)

    const parsed = parseActions(result.text || '')
    const proposedActions = (parsed.actions.length ? parsed.actions : buildFallbackActions(latestUserMessage.content, context))
      .map((action) => normalizeAction(action, context))
      .filter(Boolean)
      .slice(0, 3)

    logTaskSuccess('Assistant', 'chat', {
      textLength: parsed.message.length,
      proposedActions: proposedActions.length,
    })
    return success(c, { message: parsed.message, proposed_actions: proposedActions })
  } catch (err: any) {
    logTaskError('Assistant', 'chat', { error: err.message })
    return badRequest(c, err.message || 'assistant failed')
  }
})

app.post('/actions/execute', async (c) => {
  const body = await c.req.json()
  const action = normalizeAction(body.action, body.context || {})
  if (!action) return badRequest(c, 'unsupported assistant action')

  logTaskStart('Assistant', 'execute-action', { type: action.type, payload: action.payload })
  try {
    const result = await executeAction(c, action)
    logTaskSuccess('Assistant', 'execute-action', { type: action.type, ok: result.ok })
    return success(c, result)
  } catch (err: any) {
    logTaskError('Assistant', 'execute-action', { type: action.type, error: err.message })
    return badRequest(c, err.message || 'assistant action failed')
  }
})

export default app
