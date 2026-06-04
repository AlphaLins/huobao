import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { getDramaStylePrompt, injectStylePrompt } from '../utils/style-prompt.js'

type ServiceType = 'image' | 'video'

function parseJsonArray(value?: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : []
  } catch {
    return []
  }
}

function firstModel(model?: string | null) {
  if (!model) return ''
  try {
    const parsed = JSON.parse(model)
    return Array.isArray(parsed) ? String(parsed[0] || '') : String(parsed || '')
  } catch {
    return model
  }
}

function getDramaImageSize(dramaId?: number | null): string {
  if (!dramaId) return '1920x1080'
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
  const ratio = drama?.aspectRatio || '16:9'
  if (ratio === '9:16') return '1080x1920'
  if (ratio === '1:1') return '1024x1024'
  return '1920x1080'
}

function resolveConfig(serviceType: ServiceType, configId?: number | null) {
  const config = configId ? getConfigById(configId) : getActiveConfig(serviceType)
  if (!config) throw new Error(`No active ${serviceType} AI config`)
  return config
}

function getEpisodeConfig(episodeId?: number | null) {
  if (!episodeId) return null
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  return episode || null
}

function getStoryboardCharacterNames(storyboardId: number): string[] {
  const links = db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
  if (!links.length) return []
  const ids = new Set(links.map(link => link.characterId))
  return db.select().from(schema.characters).all()
    .filter(char => ids.has(char.id))
    .map(char => char.name)
    .filter(Boolean)
}

function getStoryboardReferenceImages(storyboard: typeof schema.storyboards.$inferSelect): string[] {
  const refs: string[] = []
  const pushRef = (value?: string | null) => {
    if (!value || refs.includes(value) || refs.length >= 6) return
    refs.push(value)
  }

  if (storyboard.sceneId) {
    const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, storyboard.sceneId)).all()
    pushRef(scene?.imageUrl)
  }

  const links = db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboard.id)).all()
  const charIds = new Set(links.map(link => link.characterId))
  for (const char of db.select().from(schema.characters).all()) {
    if (charIds.has(char.id)) pushRef(char.imageUrl)
  }

  parseJsonArray(storyboard.referenceImages).forEach(pushRef)
  pushRef(storyboard.firstFrameImage)
  pushRef(storyboard.lastFrameImage)
  return refs
}

function buildStoryboardImageBasePrompt(storyboard: typeof schema.storyboards.$inferSelect, frameType?: string | null) {
  const charactersText = getStoryboardCharacterNames(storyboard.id).join('、')
  const frameHint = frameType === 'first_frame'
    ? '生成这个镜头的起始关键帧，突出建立关系和动作开始瞬间'
    : frameType === 'last_frame'
      ? '生成这个镜头的结束关键帧，突出动作结束、情绪落点或结果状态'
      : '生成这个镜头的电影感画面，突出人物、动作和环境关系'

  return [
    storyboard.title ? `镜头标题：${storyboard.title}` : '',
    (storyboard.imagePrompt || storyboard.description) ? `画面描述：${storyboard.imagePrompt || storyboard.description}` : '',
    storyboard.shotType ? `景别：${storyboard.shotType}` : '',
    storyboard.angle ? `机位：${storyboard.angle}` : '',
    storyboard.movement ? `运镜：${storyboard.movement}` : '',
    charactersText ? `角色：${charactersText}` : '',
    (storyboard.location) ? `地点：${storyboard.location}` : '',
    storyboard.time ? `时间：${storyboard.time}` : '',
    storyboard.action ? `动作：${storyboard.action}` : '',
    storyboard.atmosphere ? `氛围：${storyboard.atmosphere}` : '',
    frameHint,
  ].filter(Boolean).join('；')
}

function withCommonResult(args: {
  serviceType: ServiceType
  dramaId?: number | null
  configId?: number | null
  basePrompt: string
  size?: string
  duration?: number
  referenceImages?: string[]
  referenceMode?: string
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
}) {
  const config = resolveConfig(args.serviceType, args.configId)
  const stylePrompt = getDramaStylePrompt(args.dramaId)
  const prompt = injectStylePrompt(args.basePrompt, args.dramaId)
  return {
    prompt,
    base_prompt: args.basePrompt,
    style_prompt: stylePrompt,
    reference_images: args.referenceImages || [],
    reference_mode: args.referenceMode,
    first_frame_url: args.firstFrameUrl || null,
    last_frame_url: args.lastFrameUrl || null,
    provider: config.provider,
    model: firstModel(config.model),
    config_id: args.configId || null,
    size: args.size,
    duration: args.duration,
  }
}

export function previewImagePrompt(body: any) {
  const type = String(body.type || '')
  const episode = getEpisodeConfig(Number(body.episode_id || 0))
  const dramaId = Number(body.drama_id || episode?.dramaId || 0) || undefined

  if (type === 'character') {
    const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, Number(body.character_id))).all()
    if (!char) throw new Error('Character not found')
    const appearance = char.appearance || char.description || '人物立绘'
    const basePrompt = body.custom_prompt || `character turnaround sheet of ${char.name}, ${appearance}, three views: front view, 3/4 side view, back view, full body, same character in all views, consistent design, white background, professional character design reference, high quality, no text`
    return withCommonResult({
      serviceType: 'image',
      dramaId: char.dramaId,
      configId: body.config_id ?? episode?.imageConfigId,
      basePrompt,
      size: '1024x1024',
    })
  }

  if (type === 'scene') {
    const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, Number(body.scene_id))).all()
    if (!scene) throw new Error('Scene not found')
    const basePrompt = body.custom_prompt || scene.prompt || `${scene.location}${scene.time ? `, ${scene.time}` : ''}, establishing shot, cinematic composition, atmospheric lighting, high quality, no text, no watermark`
    return withCommonResult({
      serviceType: 'image',
      dramaId: scene.dramaId,
      configId: body.config_id ?? episode?.imageConfigId,
      basePrompt,
      size: getDramaImageSize(scene.dramaId),
    })
  }

  if (type === 'storyboard') {
    const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
    if (!storyboard) throw new Error('Storyboard not found')
    const ep = episode || getEpisodeConfig(storyboard.episodeId)
    const basePrompt = body.custom_prompt || buildStoryboardImageBasePrompt(storyboard, body.frame_type)
    return withCommonResult({
      serviceType: 'image',
      dramaId: ep?.dramaId || dramaId,
      configId: body.config_id ?? ep?.storyboardImageConfigId ?? ep?.imageConfigId,
      basePrompt,
      size: getDramaImageSize(ep?.dramaId || dramaId),
      referenceImages: getStoryboardReferenceImages(storyboard),
    })
  }

  throw new Error('Unsupported image prompt type')
}

export function previewVideoPrompt(body: any) {
  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
  if (!storyboard) throw new Error('Storyboard not found')
  const episode = getEpisodeConfig(storyboard.episodeId)
  const firstFrameUrl = body.first_frame_url ?? storyboard.firstFrameImage
  const lastFrameUrl = body.last_frame_url ?? storyboard.lastFrameImage
  const refs = parseJsonArray(storyboard.referenceImages)
  const referenceMode = firstFrameUrl && lastFrameUrl
    ? 'first_last'
    : refs.length
      ? 'multiple'
      : firstFrameUrl
        ? 'single'
        : 'none'
  const referenceImages = referenceMode === 'multiple' ? [firstFrameUrl, ...refs].filter(Boolean) as string[] : []
  const basePrompt = body.custom_prompt || storyboard.videoPrompt || storyboard.description || storyboard.imagePrompt || ''

  return withCommonResult({
    serviceType: 'video',
    dramaId: episode?.dramaId || body.drama_id,
    configId: body.config_id ?? episode?.videoConfigId,
    basePrompt,
    duration: Number(body.duration || storyboard.duration || 5),
    referenceMode,
    firstFrameUrl,
    lastFrameUrl,
    referenceImages,
  })
}
