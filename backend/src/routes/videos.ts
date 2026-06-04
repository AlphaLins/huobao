import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest, forbidden, notFound } from '../utils/response.js'
import { generateVideo } from '../services/video-generation.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { previewVideoPrompt } from '../services/prompt-builder.js'
import { canAccessDrama, canAccessGeneration, canAccessStoryboard } from '../utils/ownership.js'

const app = new Hono()

app.post('/preview-prompt', async (c) => {
  try {
    const body = await c.req.json()
    return success(c, previewVideoPrompt(body))
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

// POST /videos - Generate video
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')
  if (body.drama_id && !canAccessDrama(c, Number(body.drama_id))) return forbidden(c)
  if (body.storyboard_id && !canAccessStoryboard(c, Number(body.storyboard_id))) return forbidden(c)

  try {
    let configId: number | undefined = body.config_id
    if (body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        if (ep?.videoConfigId != null) configId = ep.videoConfigId
      }
    }

    logTaskStart('VideoAPI', 'generate', {
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      referenceMode: body.reference_mode,
      duration: body.duration,
    })
    logTaskPayload('VideoAPI', 'request body', body)
    const id = await generateVideo({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      prompt: body.prompt,
      model: body.model,
      referenceMode: body.reference_mode,
      imageUrl: body.image_url,
      firstFrameUrl: body.first_frame_url,
      lastFrameUrl: body.last_frame_url,
      referenceImageUrls: body.reference_image_urls,
      duration: body.duration,
      aspectRatio: body.aspect_ratio,
      configId,
      promptMode: body.prompt_mode,
    })

    const [record] = db.select().from(schema.videoGenerations)
      .where(eq(schema.videoGenerations.id, id)).all()
    logTaskSuccess('VideoAPI', 'generate', { generationId: id, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('VideoAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

app.post('/set-current', async (c) => {
  try {
    const body = await c.req.json()
    let row = null as typeof schema.videoGenerations.$inferSelect | null

    if (body.video_generation_id) {
      const [found] = db.select().from(schema.videoGenerations)
        .where(eq(schema.videoGenerations.id, Number(body.video_generation_id))).all()
      row = found || null
    } else {
      const videoPath = String(body.video_path || body.video_url || '').trim().replace(/^\/+/, '')
      if (!videoPath) return badRequest(c, 'video_path or video_generation_id is required')
      const rows = db.select().from(schema.videoGenerations).all()
      row = rows
        .filter(item => {
          const localPath = String(item.localPath || '').trim().replace(/^\/+/, '')
          const videoUrl = String(item.videoUrl || '').trim().replace(/^\/+/, '')
          return localPath === videoPath || videoUrl === videoPath
        })
        .filter(item => !body.storyboard_id || item.storyboardId === Number(body.storyboard_id))
        .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0] || null
    }

    if (!row) return badRequest(c, 'video generation not found')
    if (!row.storyboardId) return badRequest(c, 'video generation has no storyboard_id')
    const path = row.localPath || row.videoUrl
    if (!path) return badRequest(c, 'video generation has no video path')

    db.update(schema.storyboards)
      .set({ videoUrl: path, updatedAt: now() })
      .where(eq(schema.storyboards.id, row.storyboardId))
      .run()

    return success(c, row)
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

// GET /videos/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.id, id)).all()
  if (!row) return notFound(c)
  if (!canAccessGeneration(c, row)) return forbidden(c)
  return success(c, row || null)
})

// GET /videos - List by storyboard_id, drama_id, status, provider, or reference_mode.
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')
  const status = c.req.query('status')
  const provider = c.req.query('provider')
  const referenceMode = c.req.query('reference_mode')
  const limit = Number(c.req.query('limit') || 0)

  let rows = db.select().from(schema.videoGenerations).all().filter(r => canAccessGeneration(c, r))

  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))
  if (status) rows = rows.filter(r => r.status === status)
  if (provider) rows = rows.filter(r => r.provider === provider)
  if (referenceMode) rows = rows.filter(r => r.referenceMode === referenceMode)
  rows = rows.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
  if (limit > 0) rows = rows.slice(0, Math.min(limit, 100))

  return success(c, rows)
})

// DELETE /videos/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
  if (!row) return notFound(c)
  if (!canAccessGeneration(c, row)) return forbidden(c)
  db.delete(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).run()
  return success(c)
})

export default app
