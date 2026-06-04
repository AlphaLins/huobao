import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest, forbidden, notFound } from '../utils/response.js'
import { generateImage, syncImageGenerationResult } from '../services/image-generation.js'
import { getActiveConfig, getConfigById } from '../services/ai.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { previewImagePrompt } from '../services/prompt-builder.js'
import { canAccessCharacter, canAccessDrama, canAccessGeneration, canAccessScene, canAccessStoryboard } from '../utils/ownership.js'

const app = new Hono()

function normalizeImagePath(value?: string | null) {
  if (!value) return ''
  return String(value).trim().replace(/^\/+/, '')
}

function resolveImageConfig(configId?: number | null) {
  const config = configId ? getConfigById(configId) : getActiveConfig('image')
  if (!config) throw new Error('No active image AI config')
  return config
}

function resolveSourceImage(body: any) {
  if (body.image_generation_id) {
    const [row] = db.select().from(schema.imageGenerations)
      .where(eq(schema.imageGenerations.id, Number(body.image_generation_id))).all()
    if (row) return row
  }

  const imagePath = normalizeImagePath(body.image_path || body.image_url)
  if (!imagePath) return null

  const rows = db.select().from(schema.imageGenerations).all()
  return rows
    .filter(row => normalizeImagePath(row.localPath) === imagePath || normalizeImagePath(row.imageUrl) === imagePath)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0] || null
}

function buildRefinePrompt(sourcePrompt: string, instruction: string) {
  const base = sourcePrompt?.trim()
  const edit = instruction.trim()
  return [
    'Use the provided reference image as the base image.',
    'Preserve the same character identity, facial features, composition, camera angle, pose, lighting direction, and overall visual style unless the edit request explicitly changes them.',
    `Edit request: ${edit}`,
    base ? `Original generation prompt for continuity: ${base}` : '',
    'Return a polished final image that applies only the requested changes.',
  ].filter(Boolean).join('\n')
}

function setImageAsCurrent(row: typeof schema.imageGenerations.$inferSelect) {
  const path = row.localPath || row.imageUrl
  if (!path) throw new Error('image has no local path')

  if (row.characterId) {
    db.update(schema.characters)
      .set({ imageUrl: path, updatedAt: now() })
      .where(eq(schema.characters.id, row.characterId))
      .run()
  }
  if (row.sceneId) {
    db.update(schema.scenes)
      .set({ imageUrl: path, status: 'completed', updatedAt: now() })
      .where(eq(schema.scenes.id, row.sceneId))
      .run()
  }
  if (row.storyboardId) {
    const update: Record<string, any> = { updatedAt: now() }
    if (row.frameType === 'first_frame') update.firstFrameImage = path
    else if (row.frameType === 'last_frame') update.lastFrameImage = path
    else update.composedImage = path
    db.update(schema.storyboards).set(update).where(eq(schema.storyboards.id, row.storyboardId)).run()
  }
}

app.post('/preview-prompt', async (c) => {
  try {
    const body = await c.req.json()
    return success(c, previewImagePrompt(body))
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

app.post('/refine-preview', async (c) => {
  try {
    const body = await c.req.json()
    const instruction = String(body.instruction || '').trim()
    const imagePath = normalizeImagePath(body.image_path || body.image_url)
    if (!imagePath) return badRequest(c, 'image_path is required')
    if (!instruction) return badRequest(c, 'instruction is required')

    const source = resolveSourceImage(body)
    const config = resolveImageConfig(body.config_id)
    const prompt = buildRefinePrompt(source?.prompt || '', instruction)
    const size = body.size || source?.size || '1024x1024'

    return success(c, {
      prompt,
      base_prompt: source?.prompt || '',
      instruction,
      reference_images: [imagePath],
      provider: config.provider,
      model: config.model,
      size,
      source_image_generation_id: source?.id || null,
    })
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

app.post('/refine', async (c) => {
  const body = await c.req.json()
  const prompt = String(body.prompt || '').trim()
  const imagePath = normalizeImagePath(body.image_path || body.image_url)
  if (!imagePath) return badRequest(c, 'image_path is required')
  if (!prompt) return badRequest(c, 'prompt is required')

  try {
    const source = resolveSourceImage(body)
    let configId: number | undefined = body.config_id
    if (!configId && body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        if (ep?.storyboardImageConfigId != null) configId = ep.storyboardImageConfigId
        else if (ep?.imageConfigId != null) configId = ep.imageConfigId
      }
    }

    const id = await generateImage({
      storyboardId: body.storyboard_id ?? source?.storyboardId ?? undefined,
      dramaId: body.drama_id ?? source?.dramaId ?? undefined,
      sceneId: body.scene_id ?? source?.sceneId ?? undefined,
      characterId: body.character_id ?? source?.characterId ?? undefined,
      prompt,
      model: body.model,
      size: body.size || source?.size || undefined,
      referenceImages: [imagePath],
      frameType: body.frame_type ?? source?.frameType ?? undefined,
      imageType: 'refine',
      configId,
      promptMode: 'custom_final',
    })

    const [record] = db.select().from(schema.imageGenerations)
      .where(eq(schema.imageGenerations.id, id)).all()
    return created(c, record)
  } catch (err: any) {
    logTaskError('ImageAPI', 'refine', { error: err.message })
    return badRequest(c, err.message)
  }
})

app.post('/set-current', async (c) => {
  try {
    const body = await c.req.json()
    let row = null as typeof schema.imageGenerations.$inferSelect | null
    if (body.image_generation_id) {
      const [found] = db.select().from(schema.imageGenerations)
        .where(eq(schema.imageGenerations.id, Number(body.image_generation_id))).all()
      row = found || null
    } else {
      const imagePath = normalizeImagePath(body.image_path || body.image_url)
      if (!imagePath) return badRequest(c, 'image_path or image_generation_id is required')
      const rows = db.select().from(schema.imageGenerations).all()
      row = rows
        .filter(item => normalizeImagePath(item.localPath) === imagePath || normalizeImagePath(item.imageUrl) === imagePath)
        .filter(item => {
          if (body.character_id && item.characterId !== Number(body.character_id)) return false
          if (body.scene_id && item.sceneId !== Number(body.scene_id)) return false
          if (body.storyboard_id && item.storyboardId !== Number(body.storyboard_id)) return false
          if (body.frame_type && item.frameType !== body.frame_type) return false
          return true
        })
        .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0] || null
    }
    if (!row) return badRequest(c, 'image generation not found')
    setImageAsCurrent(row)
    return success(c, row)
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

// POST /images — Generate image
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')
  if (body.drama_id && !canAccessDrama(c, Number(body.drama_id))) return forbidden(c)
  if (body.storyboard_id && !canAccessStoryboard(c, Number(body.storyboard_id))) return forbidden(c)
  if (body.scene_id && !canAccessScene(c, Number(body.scene_id))) return forbidden(c)
  if (body.character_id && !canAccessCharacter(c, Number(body.character_id))) return forbidden(c)

  try {
    let configId: number | undefined = body.config_id
    if (body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        // 分镜类图片使用 storyboardImageConfigId，fallback 到 imageConfigId
        if (ep?.storyboardImageConfigId != null) configId = ep.storyboardImageConfigId
        else if (ep?.imageConfigId != null) configId = ep.imageConfigId
      }
    }

    logTaskStart('ImageAPI', 'generate', {
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
      frameType: body.frame_type,
    })
    logTaskPayload('ImageAPI', 'request body', body)
    const id = await generateImage({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      prompt: body.prompt,
      model: body.model,
      size: body.size,
      referenceImages: body.reference_images,
      frameType: body.frame_type,
      imageType: body.image_type,
      configId,
      promptMode: body.prompt_mode,
    })

    const [record] = db.select().from(schema.imageGenerations)
      .where(eq(schema.imageGenerations.id, id)).all()
    logTaskSuccess('ImageAPI', 'generate', { generationId: id, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('ImageAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /images/latest - Latest completed image for an entity.
app.get('/latest', async (c) => {
  const dramaId = c.req.query('drama_id')
  const storyboardId = c.req.query('storyboard_id')
  const sceneId = c.req.query('scene_id')
  const characterId = c.req.query('character_id')
  const frameType = c.req.query('frame_type')

  const filters = [eq(schema.imageGenerations.status, 'completed')]
  if (dramaId) filters.push(eq(schema.imageGenerations.dramaId, Number(dramaId)))
  if (storyboardId) filters.push(eq(schema.imageGenerations.storyboardId, Number(storyboardId)))
  if (sceneId) filters.push(eq(schema.imageGenerations.sceneId, Number(sceneId)))
  if (characterId) filters.push(eq(schema.imageGenerations.characterId, Number(characterId)))
  if (frameType) filters.push(eq(schema.imageGenerations.frameType, frameType))

  const [row] = db.select().from(schema.imageGenerations)
    .where(and(...filters))
    .orderBy(desc(schema.imageGenerations.id))
    .limit(1)
    .all()

  return success(c, row || null)
})

// GET /images/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  if (!row) return notFound(c)
  if (!canAccessGeneration(c, row)) return forbidden(c)
  return success(c, row || null)
})

app.post('/:id/sync-result', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const row = await syncImageGenerationResult(id)
    return success(c, row || null)
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

// GET /images — List by storyboard_id or drama_id
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')
  const sceneId = c.req.query('scene_id')
  const characterId = c.req.query('character_id')
  const frameType = c.req.query('frame_type')
  const imageType = c.req.query('image_type')
  const status = c.req.query('status')
  const limit = Number(c.req.query('limit') || 0)

  let rows = db.select().from(schema.imageGenerations).all().filter(r => canAccessGeneration(c, r))

  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))
  if (sceneId) rows = rows.filter(r => r.sceneId === Number(sceneId))
  if (characterId) rows = rows.filter(r => r.characterId === Number(characterId))
  if (frameType) rows = rows.filter(r => r.frameType === frameType)
  if (imageType) rows = rows.filter(r => r.imageType === imageType)
  if (status) rows = rows.filter(r => r.status === status)
  rows = rows.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
  if (limit > 0) rows = rows.slice(0, Math.min(limit, 100))

  return success(c, rows)
})

// DELETE /images/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  if (!row) return notFound(c)
  if (!canAccessGeneration(c, row)) return forbidden(c)
  db.delete(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).run()
  return success(c)
})

export default app
