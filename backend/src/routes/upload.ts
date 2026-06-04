import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { inflateRawSync } from 'zlib'
import { db, schema } from '../db/index.js'
import { success, badRequest, forbidden, now } from '../utils/response.js'
import { saveUploadedFile } from '../utils/storage.js'
import { canAccessCharacter, canAccessEpisode, canAccessScene, canAccessStoryboard } from '../utils/ownership.js'

const app = new Hono()

const MAX_IMAGE_SIZE = 20 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const DOCUMENT_EXTENSIONS = new Set(['.docx', '.txt', '.md'])

function extOf(name: string) {
  const match = String(name || '').toLowerCase().match(/\.[^.]+$/)
  return match?.[0] || ''
}

function getFormFile(body: Record<string, unknown>) {
  const file = body.file
  return file instanceof File ? file : null
}

function getFormString(body: Record<string, unknown>, key: string) {
  const value = body[key]
  return typeof value === 'string' ? value.trim() : ''
}

function toArrayBuffer(buffer: Buffer) {
  return new Uint8Array(buffer).buffer
}

function isAllowedImage(file: File) {
  return IMAGE_EXTENSIONS.has(extOf(file.name)) && String(file.type || '').startsWith('image/')
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function extractDocxEntry(buffer: Buffer, entryName: string) {
  for (let offset = 0; offset < buffer.length - 46; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength)
    offset += 45 + fileNameLength + extraLength + commentLength
    if (fileName !== entryName) continue

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) return null
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const data = buffer.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) return data
    if (method === 8) return inflateRawSync(data)
    return null
  }
  return null
}

function extractTextFromDocx(buffer: Buffer) {
  const documentXml = extractDocxEntry(buffer, 'word/document.xml')
  if (!documentXml) throw new Error('未能读取 docx 正文')
  return decodeXmlEntities(
    documentXml
      .toString('utf8')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  )
}

function parseReferenceImages(value: string | null | undefined) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

function insertUploadHistory(data: {
  dramaId?: number | null
  storyboardId?: number | null
  sceneId?: number | null
  characterId?: number | null
  frameType?: string | null
  path: string
}) {
  const ts = now()
  return db.insert(schema.imageGenerations).values({
    storyboardId: data.storyboardId ?? null,
    dramaId: data.dramaId ?? null,
    sceneId: data.sceneId ?? null,
    characterId: data.characterId ?? null,
    imageType: 'upload',
    frameType: data.frameType ?? null,
    provider: 'local',
    prompt: 'Uploaded local image',
    imageUrl: data.path,
    localPath: data.path,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  }).run()
}

// POST /upload/image
app.post('/image', async (c) => {
  const body = await c.req.parseBody()
  const file = getFormFile(body)

  if (!file) return badRequest(c, 'file is required')
  if (!isAllowedImage(file)) return badRequest(c, '仅支持 png、jpg、jpeg、webp、gif 图片')
  if (file.size > MAX_IMAGE_SIZE) return badRequest(c, '图片不能超过 20MB')

  const buffer = await file.arrayBuffer()
  const path = await saveUploadedFile(buffer, 'uploads', file.name)
  return success(c, { url: `/${path}`, path })
})

// POST /upload/episode-document
app.post('/episode-document', async (c) => {
  const body = await c.req.parseBody()
  const file = getFormFile(body)
  const episodeId = Number(getFormString(body, 'episode_id'))
  const field = getFormString(body, 'field') || 'content'

  if (!file) return badRequest(c, 'file is required')
  if (!episodeId) return badRequest(c, 'episode_id is required')
  if (!['content', 'script_content'].includes(field)) return badRequest(c, 'field must be content or script_content')
  if (!canAccessEpisode(c, episodeId)) return forbidden(c)

  const ext = extOf(file.name)
  if (!DOCUMENT_EXTENSIONS.has(ext)) return badRequest(c, '仅支持 .docx、.txt、.md 文档')

  const buffer = Buffer.from(await file.arrayBuffer())
  const text = ext === '.docx' ? extractTextFromDocx(buffer) : buffer.toString('utf8').replace(/^\uFEFF/, '')
  const path = await saveUploadedFile(toArrayBuffer(buffer), `uploads/documents/episode_${episodeId}`, file.name)
  const ts = now()

  if (field === 'script_content') {
    db.update(schema.episodes).set({ scriptContent: text, updatedAt: ts }).where(eq(schema.episodes.id, episodeId)).run()
  } else {
    db.update(schema.episodes).set({ content: text, updatedAt: ts }).where(eq(schema.episodes.id, episodeId)).run()
  }

  return success(c, { field, text, path, length: text.length })
})

// POST /upload/module-image
app.post('/module-image', async (c) => {
  const body = await c.req.parseBody()
  const file = getFormFile(body)
  const targetType = getFormString(body, 'target_type')
  const targetId = Number(getFormString(body, 'target_id'))
  const frameType = getFormString(body, 'frame_type')

  if (!file) return badRequest(c, 'file is required')
  if (!targetId) return badRequest(c, 'target_id is required')
  if (!['character', 'scene', 'storyboard'].includes(targetType)) return badRequest(c, 'target_type is invalid')
  if (!isAllowedImage(file)) return badRequest(c, '仅支持 png、jpg、jpeg、webp、gif 图片')
  if (file.size > MAX_IMAGE_SIZE) return badRequest(c, '图片不能超过 20MB')

  const buffer = await file.arrayBuffer()
  const path = await saveUploadedFile(buffer, `uploads/${targetType}/${targetId}`, file.name)
  const ts = now()

  if (targetType === 'character') {
    if (!canAccessCharacter(c, targetId)) return forbidden(c)
    const [character] = db.select().from(schema.characters).where(eq(schema.characters.id, targetId)).all()
    if (!character) return badRequest(c, 'character not found')
    db.update(schema.characters)
      .set({ imageUrl: path, localPath: path, updatedAt: ts })
      .where(eq(schema.characters.id, targetId))
      .run()
    const result = insertUploadHistory({ dramaId: character.dramaId, characterId: targetId, path })
    return success(c, { id: Number(result.lastInsertRowid), path, url: `/${path}`, target_type: targetType, target_id: targetId })
  }

  if (targetType === 'scene') {
    if (!canAccessScene(c, targetId)) return forbidden(c)
    const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, targetId)).all()
    if (!scene) return badRequest(c, 'scene not found')
    db.update(schema.scenes)
      .set({ imageUrl: path, localPath: path, status: 'completed', updatedAt: ts })
      .where(eq(schema.scenes.id, targetId))
      .run()
    const result = insertUploadHistory({ dramaId: scene.dramaId, sceneId: targetId, path })
    return success(c, { id: Number(result.lastInsertRowid), path, url: `/${path}`, target_type: targetType, target_id: targetId })
  }

  if (!['first_frame', 'last_frame', 'composed', 'reference'].includes(frameType)) {
    return badRequest(c, 'storyboard frame_type must be first_frame, last_frame, composed, or reference')
  }
  if (!canAccessStoryboard(c, targetId)) return forbidden(c)

  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, targetId)).all()
  if (!storyboard) return badRequest(c, 'storyboard not found')
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all()
  if (!episode) return badRequest(c, 'episode not found')

  if (frameType === 'reference') {
    const refs = parseReferenceImages(storyboard.referenceImages)
    if (!refs.includes(path)) refs.push(path)
    db.update(schema.storyboards)
      .set({ referenceImages: JSON.stringify(refs), updatedAt: ts })
      .where(eq(schema.storyboards.id, targetId))
      .run()
  } else {
    const update: Record<string, any> = { updatedAt: ts }
    if (frameType === 'first_frame') update.firstFrameImage = path
    else if (frameType === 'last_frame') update.lastFrameImage = path
    else update.composedImage = path
    db.update(schema.storyboards).set(update).where(eq(schema.storyboards.id, targetId)).run()
  }

  const result = insertUploadHistory({ dramaId: episode.dramaId, storyboardId: targetId, frameType, path })
  return success(c, {
    id: Number(result.lastInsertRowid),
    storyboard_id: targetId,
    drama_id: episode.dramaId,
    frame_type: frameType,
    path,
    url: `/${path}`,
    target_type: targetType,
    target_id: targetId,
  })
})

// POST /upload/storyboard-image
app.post('/storyboard-image', async (c) => {
  const body = await c.req.parseBody()
  const file = getFormFile(body)
  const storyboardId = Number(body['storyboard_id'] || body['storyboardId'] || 0)
  const frameType = String(body['frame_type'] || body['frameType'] || 'composed')

  if (!file) return badRequest(c, 'file is required')
  if (!storyboardId) return badRequest(c, 'storyboard_id is required')
  if (!['first_frame', 'last_frame', 'composed', 'reference'].includes(frameType)) return badRequest(c, 'invalid frame_type')
  if (!isAllowedImage(file)) return badRequest(c, '仅支持 png、jpg、jpeg、webp、gif 图片')
  if (file.size > MAX_IMAGE_SIZE) return badRequest(c, '图片不能超过 20MB')
  if (!canAccessStoryboard(c, storyboardId)) return forbidden(c)

  const [storyboard] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId)).all()
  if (!storyboard) return badRequest(c, 'storyboard not found')

  const [episode] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, storyboard.episodeId)).all()
  if (!episode) return badRequest(c, 'episode not found')

  const buffer = await file.arrayBuffer()
  const localPath = await saveUploadedFile(buffer, `uploads/storyboards/${storyboardId}`, file.name)
  const update: Record<string, any> = { updatedAt: now() }
  if (frameType === 'first_frame') update.firstFrameImage = localPath
  else if (frameType === 'last_frame') update.lastFrameImage = localPath
  else if (frameType === 'reference') {
    const refs = parseReferenceImages(storyboard.referenceImages)
    if (!refs.includes(localPath)) refs.push(localPath)
    update.referenceImages = JSON.stringify(refs)
  } else update.composedImage = localPath

  db.update(schema.storyboards)
    .set(update)
    .where(eq(schema.storyboards.id, storyboardId))
    .run()

  const ts = now()
  const result = db.insert(schema.imageGenerations).values({
    storyboardId,
    dramaId: episode.dramaId,
    imageType: 'upload',
    frameType,
    provider: 'local',
    prompt: 'Uploaded local image',
    imageUrl: localPath,
    localPath,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  }).run()

  return success(c, {
    id: Number(result.lastInsertRowid),
    storyboard_id: storyboardId,
    drama_id: episode.dramaId,
    frame_type: frameType,
    path: localPath,
    url: `/${localPath}`,
  })
})

export default app
