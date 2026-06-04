import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'
import { db, schema } from '../db/index.js'
import { success, notFound, badRequest, now, forbidden } from '../utils/response.js'
import { toSnakeCaseArray, toSnakeCase } from '../utils/transform.js'
import { getAbsolutePath } from '../utils/storage.js'
import { getCurrentUser } from '../middleware/auth.js'

const app = new Hono()
const VIDEO_EXPORT_ROOT = process.env.VIDEO_EXPORT_PATH
  || path.resolve(process.cwd(), process.cwd().endsWith('backend') ? '../video' : 'video')

function safeFilename(value: string) {
  return String(value || 'untitled')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'untitled'
}

function asciiFilename(value: string) {
  return safeFilename(value)
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/_+/g, '_')
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosTime, dosDate }
}

function createZip(files: Array<{ name: string; data: Buffer }>) {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const { dosTime, dosDate } = dosDateTime()

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8')
    const checksum = crc32(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuffer, file.data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(file.data.length, 20)
    centralHeader.writeUInt32LE(file.data.length, 24)
    centralHeader.writeUInt16LE(nameBuffer.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, nameBuffer)
    offset += local.length + nameBuffer.length + file.data.length
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, ...central, end])
}

function buildGeneratedVideosZip(episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return null
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const files: Array<{ name: string; data: Buffer }> = []
  const report: string[] = [
    `Drama: ${drama?.title || ep.dramaId}`,
    `Episode: ${ep.episodeNumber}`,
    `Exported at: ${new Date().toISOString()}`,
    '',
  ]

  for (const sb of storyboards) {
    if (!sb.videoUrl) {
      report.push(`SKIP shot_${String(sb.storyboardNumber).padStart(2, '0')}: no current video`)
      continue
    }
    const filePath = getAbsolutePath(sb.videoUrl)
    if (!fs.existsSync(filePath)) {
      report.push(`MISSING shot_${String(sb.storyboardNumber).padStart(2, '0')}: ${sb.videoUrl} -> ${filePath}`)
      continue
    }
    const ext = path.extname(filePath) || '.mp4'
    const title = safeFilename(sb.title || sb.description || `storyboard_${sb.id}`)
    const filename = `shot_${String(sb.storyboardNumber).padStart(2, '0')}_${title}${ext}`
    files.push({ name: filename, data: fs.readFileSync(filePath) })
    report.push(`OK ${filename}: ${sb.videoUrl}`)
  }

  report.push('', `Exported videos: ${files.length}/${storyboards.length}`)
  files.push({ name: 'export-report.txt', data: Buffer.from(report.join('\n'), 'utf8') })
  const zipName = `${safeFilename(drama?.title || `drama_${ep.dramaId}`)}_episode_${String(ep.episodeNumber).padStart(2, '0')}_generated_videos.zip`
  const fallbackZipName = `${asciiFilename(`drama_${ep.dramaId}`)}_episode_${String(ep.episodeNumber).padStart(2, '0')}_generated_videos.zip`
  return {
    ep,
    drama,
    files,
    zipName,
    fallbackZipName,
    zip: createZip(files),
    exportedCount: files.length - 1,
    totalCount: storyboards.length,
  }
}

function canAccessDrama(c: any, dramaId: number) {
  const user = getCurrentUser(c)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
  return !!drama && (user?.role === 'admin' || drama.userId === user?.id)
}

function getAccessibleEpisode(c: any, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return { ep: null, allowed: false }
  return { ep, allowed: canAccessDrama(c, ep.dramaId) }
}

function getEpisodeStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
}

function getEpisodeCharacterIds(episodeId: number) {
  return db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
    .all()
    .map(link => link.characterId)
}

function getEpisodeSceneIds(episodeId: number) {
  return db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
    .all()
    .map(link => link.sceneId)
}

function clearImageHistoryByStoryboard(storyboardId: number) {
  db.delete(schema.imageGenerations)
    .where(eq(schema.imageGenerations.storyboardId, storyboardId))
    .run()
}

function clearVideoHistoryByStoryboard(storyboardId: number) {
  db.delete(schema.videoGenerations)
    .where(eq(schema.videoGenerations.storyboardId, storyboardId))
    .run()
}

function clearEpisodeMerge(episodeId: number) {
  db.delete(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .run()
  db.update(schema.episodes)
    .set({ videoUrl: null, thumbnail: null, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
    .run()
}

function clearEpisodeModule(episodeId: number, module: string) {
  const storyboards = getEpisodeStoryboards(episodeId)
  const storyboardIds = storyboards.map(sb => sb.id)
  const characterIds = getEpisodeCharacterIds(episodeId)
  const sceneIds = getEpisodeSceneIds(episodeId)
  const counts: Record<string, number> = {}

  if (module === 'raw_content') {
    db.update(schema.episodes).set({ content: null, updatedAt: now() }).where(eq(schema.episodes.id, episodeId)).run()
    counts.episodes = 1
    return counts
  }

  if (module === 'script') {
    db.update(schema.episodes).set({ scriptContent: null, updatedAt: now() }).where(eq(schema.episodes.id, episodeId)).run()
    counts.episodes = 1
    return counts
  }

  if (module === 'extract') {
    db.delete(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)).run()
    db.delete(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)).run()
    counts.characters_unlinked = characterIds.length
    counts.scenes_unlinked = sceneIds.length
    return counts
  }

  if (module === 'voice') {
    for (const characterId of characterIds) {
      db.update(schema.characters)
        .set({ voiceStyle: null, voiceProvider: null, voiceSampleUrl: null, updatedAt: now() })
        .where(eq(schema.characters.id, characterId))
        .run()
    }
    counts.characters = characterIds.length
    return counts
  }

  if (module === 'storyboards') {
    for (const storyboardId of storyboardIds) {
      db.delete(schema.storyboardCharacters)
        .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
        .run()
      clearImageHistoryByStoryboard(storyboardId)
      clearVideoHistoryByStoryboard(storyboardId)
    }
    db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()
    clearEpisodeMerge(episodeId)
    counts.storyboards = storyboardIds.length
    counts.image_generations = storyboardIds.length
    counts.video_generations = storyboardIds.length
    return counts
  }

  if (module === 'character_images') {
    for (const characterId of characterIds) {
      db.update(schema.characters)
        .set({ imageUrl: null, localPath: null, referenceImages: null, updatedAt: now() })
        .where(eq(schema.characters.id, characterId))
        .run()
      db.delete(schema.imageGenerations)
        .where(eq(schema.imageGenerations.characterId, characterId))
        .run()
    }
    counts.characters = characterIds.length
    return counts
  }

  if (module === 'scene_images') {
    for (const sceneId of sceneIds) {
      db.update(schema.scenes)
        .set({ imageUrl: null, localPath: null, status: 'pending', updatedAt: now() })
        .where(eq(schema.scenes.id, sceneId))
        .run()
      db.delete(schema.imageGenerations)
        .where(eq(schema.imageGenerations.sceneId, sceneId))
        .run()
    }
    counts.scenes = sceneIds.length
    return counts
  }

  if (module === 'tts') {
    for (const storyboardId of storyboardIds) {
      db.update(schema.storyboards)
        .set({ ttsAudioUrl: null, subtitleUrl: null, updatedAt: now() })
        .where(eq(schema.storyboards.id, storyboardId))
        .run()
    }
    counts.storyboards = storyboardIds.length
    return counts
  }

  if (module === 'shot_images') {
    for (const storyboardId of storyboardIds) {
      db.update(schema.storyboards)
        .set({
          composedImage: null,
          firstFrameImage: null,
          lastFrameImage: null,
          referenceImages: null,
          updatedAt: now(),
        })
        .where(eq(schema.storyboards.id, storyboardId))
        .run()
      clearImageHistoryByStoryboard(storyboardId)
    }
    counts.storyboards = storyboardIds.length
    return counts
  }

  if (module === 'videos') {
    for (const storyboardId of storyboardIds) {
      db.update(schema.storyboards)
        .set({ videoUrl: null, updatedAt: now() })
        .where(eq(schema.storyboards.id, storyboardId))
        .run()
      clearVideoHistoryByStoryboard(storyboardId)
    }
    counts.storyboards = storyboardIds.length
    return counts
  }

  if (module === 'compose') {
    for (const storyboardId of storyboardIds) {
      db.update(schema.storyboards)
        .set({ composedVideoUrl: null, status: 'pending', updatedAt: now() })
        .where(eq(schema.storyboards.id, storyboardId))
        .run()
    }
    counts.storyboards = storyboardIds.length
    return counts
  }

  if (module === 'merge') {
    clearEpisodeMerge(episodeId)
    counts.episode = 1
    return counts
  }

  throw new Error('unsupported clear module')
}

// POST /episodes — Create a new episode
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id required')
  if (!canAccessDrama(c, Number(body.drama_id))) return forbidden(c)
  if (!body.image_config_id || !body.video_config_id || !body.audio_config_id) {
    return badRequest(c, 'image_config_id, video_config_id and audio_config_id are required')
  }
  const ts = now()

  // Get next episode number
  const existing = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, body.drama_id))
    .orderBy(schema.episodes.episodeNumber).all()
  const nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  const res = db.insert(schema.episodes).values({
    dramaId: body.drama_id,
    episodeNumber: nextNum,
    title: body.title || `第${nextNum}集`,
    imageConfigId: body.image_config_id,
    storyboardImageConfigId: body.storyboard_image_config_id || body.image_config_id,
    videoConfigId: body.video_config_id,
    audioConfigId: body.audio_config_id,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, Number(res.lastInsertRowid))).all()
  return success(c, {
    id: ep.id,
    episode_number: ep.episodeNumber,
    title: ep.title,
    image_config_id: ep.imageConfigId,
    storyboard_image_config_id: ep.storyboardImageConfigId,
    video_config_id: ep.videoConfigId,
    audio_config_id: ep.audioConfigId,
  })
})

// PUT /episodes/:id - Update episode fields
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const { ep, allowed: accessAllowed } = getAccessibleEpisode(c, id)
  if (!ep) return notFound(c, 'Episode not found')
  if (!accessAllowed) return forbidden(c)
  const body = await c.req.json()

  const allowed = ['content', 'script_content', 'title', 'description', 'status',
    'image_config_id', 'storyboard_image_config_id', 'video_config_id', 'audio_config_id']
  const updates: Record<string, any> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }
  if (Object.keys(updates).length === 0) return badRequest(c, 'no valid fields')

  // Map snake_case to camelCase for drizzle
  const drizzleUpdates: Record<string, any> = { updatedAt: now() }
  if ('content' in updates) drizzleUpdates.content = updates.content
  if ('script_content' in updates) drizzleUpdates.scriptContent = updates.script_content
  if ('title' in updates) drizzleUpdates.title = updates.title
  if ('description' in updates) drizzleUpdates.description = updates.description
  if ('status' in updates) drizzleUpdates.status = updates.status
  if ('image_config_id' in updates) drizzleUpdates.imageConfigId = updates.image_config_id
  if ('storyboard_image_config_id' in updates) drizzleUpdates.storyboardImageConfigId = updates.storyboard_image_config_id
  if ('video_config_id' in updates) drizzleUpdates.videoConfigId = updates.video_config_id
  if ('audio_config_id' in updates) drizzleUpdates.audioConfigId = updates.audio_config_id

  db.update(schema.episodes).set(drizzleUpdates).where(eq(schema.episodes.id, id)).run()
  return success(c)
})

// POST /episodes/:id/clear-module - Clear one module for the current episode.
app.post('/:id/clear-module', async (c) => {
  const id = Number(c.req.param('id'))
  const { ep, allowed } = getAccessibleEpisode(c, id)
  if (!ep) return notFound(c, 'Episode not found')
  if (!allowed) return forbidden(c)

  const body = await c.req.json().catch(() => ({}))
  const module = String(body.module || '').trim()
  const supportedModules = new Set([
    'raw_content',
    'script',
    'extract',
    'voice',
    'storyboards',
    'character_images',
    'scene_images',
    'tts',
    'shot_images',
    'videos',
    'compose',
    'merge',
  ])
  if (!supportedModules.has(module)) return badRequest(c, 'unsupported clear module')

  try {
    const counts = clearEpisodeModule(id, module)
    return success(c, {
      module,
      episode_id: id,
      delete_files: false,
      counts,
    })
  } catch (err: any) {
    return badRequest(c, err.message || 'clear module failed')
  }
})

// GET /episodes/:id/characters — characters linked to this episode
// GET /episodes/:id/export-generated-videos - Download current generated videos ZIP.
app.get('/:id/export-generated-videos', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const result = buildGeneratedVideosZip(episodeId)
  if (!result) return notFound(c, 'Episode not found')
  if (result.exportedCount <= 0) return badRequest(c, 'No generated videos to export')

  c.header('Content-Type', 'application/zip')
  c.header('Content-Disposition', `attachment; filename="${result.fallbackZipName}"; filename*=UTF-8''${encodeURIComponent(result.zipName)}`)
  c.header('Content-Length', String(result.zip.length))
  return c.body(result.zip)
})

// POST /episodes/:id/save-generated-videos - Save current generated videos ZIP to local export folder.
app.post('/:id/save-generated-videos', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const result = buildGeneratedVideosZip(episodeId)
  if (!result) return notFound(c, 'Episode not found')
  if (result.exportedCount <= 0) return badRequest(c, 'No generated videos to export')

  const projectDir = safeFilename(result.drama?.title || `drama_${result.ep.dramaId}`)
  const episodeDir = `episode_${String(result.ep.episodeNumber).padStart(2, '0')}`
  const outputDir = path.join(VIDEO_EXPORT_ROOT, projectDir, episodeDir)
  fs.mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, result.zipName)
  fs.writeFileSync(outputPath, result.zip)

  return success(c, {
    path: outputPath,
    directory: outputDir,
    filename: result.zipName,
    exported: result.exportedCount,
    total: result.totalCount,
  })
})

app.get('/:id/characters', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const { ep, allowed } = getAccessibleEpisode(c, episodeId)
  if (!ep) return notFound(c, 'Episode not found')
  if (!allowed) return forbidden(c)
  const links = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
  const charIds = links.map(l => l.characterId)
  if (!charIds.length) return success(c, [])
  const allChars = db.select().from(schema.characters).all()
  const result = allChars.filter(ch => charIds.includes(ch.id) && !ch.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/scenes — scenes linked to this episode
app.get('/:id/scenes', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const { ep, allowed } = getAccessibleEpisode(c, episodeId)
  if (!ep) return notFound(c, 'Episode not found')
  if (!allowed) return forbidden(c)
  const links = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
  const sceneIds = links.map(l => l.sceneId)
  if (!sceneIds.length) return success(c, [])
  const allScenes = db.select().from(schema.scenes).all()
  const result = allScenes.filter(sc => sceneIds.includes(sc.id) && !sc.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:episode_id/storyboards
app.get('/:episode_id/storyboards', async (c) => {
  const episodeId = Number(c.req.param('episode_id'))
  const { ep, allowed } = getAccessibleEpisode(c, episodeId)
  if (!ep) return notFound(c, 'Episode not found')
  if (!allowed) return forbidden(c)
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
  const links = db.select().from(schema.storyboardCharacters).all()
  const charIdsByStoryboard = new Map<number, number[]>()
  for (const link of links) {
    const arr = charIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.characterId)
    charIdsByStoryboard.set(link.storyboardId, arr)
  }

  const episodeCharIds = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
    .map(link => link.characterId)
  const allChars = db.select().from(schema.characters).all()
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)

  return success(c, rows.map((row) => ({
    ...toSnakeCase(row),
    character_ids: charIdsByStoryboard.get(row.id) || [],
    characters: allChars
      .filter(ch => (charIdsByStoryboard.get(row.id) || []).includes(ch.id))
      .map(ch => toSnakeCase(ch)),
  })))
})

// GET /episodes/:id/pipeline-status — 流水线进度
app.get('/:id/pipeline-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const { ep, allowed } = getAccessibleEpisode(c, episodeId)
  if (!ep) return notFound(c, 'Episode not found')
  if (!allowed) return forbidden(c)

  const chars = db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
  const scenes = db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, ep.dramaId)).all()
  const sbs = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
  const merges = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.episodeId, episodeId)).all()

  const charsWithVoice = chars.filter(c => c.voiceStyle)
  const charsWithSample = chars.filter(c => c.voiceSampleUrl)
  const sbsWithImage = sbs.filter(s => s.composedImage)
  const sbsWithVideo = sbs.filter(s => s.videoUrl)
  const sbsComposed = sbs.filter(s => s.composedVideoUrl)
  const latestMerge = merges[merges.length - 1]

  function stepStatus(done: boolean, partial?: boolean) {
    if (done) return 'done'
    if (partial) return 'partial'
    return 'pending'
  }

  return success(c, {
    episode_id: episodeId,
    steps: {
      script_rewrite: { status: ep.scriptContent ? 'done' : (ep.content ? 'ready' : 'pending') },
      extract_characters: { status: stepStatus(chars.length > 0), count: chars.length },
      extract_scenes: { status: stepStatus(scenes.length > 0), count: scenes.length },
      assign_voices: { status: stepStatus(charsWithVoice.length === chars.length && chars.length > 0, charsWithVoice.length > 0), assigned: charsWithVoice.length, total: chars.length },
      generate_voice_samples: { status: stepStatus(charsWithSample.length === charsWithVoice.length && charsWithVoice.length > 0, charsWithSample.length > 0), completed: charsWithSample.length, total: charsWithVoice.length },
      extract_storyboards: { status: stepStatus(sbs.length > 0), count: sbs.length },
      generate_images: { status: stepStatus(sbsWithImage.length === sbs.length && sbs.length > 0, sbsWithImage.length > 0), completed: sbsWithImage.length, total: sbs.length },
      generate_videos: { status: stepStatus(sbsWithVideo.length === sbs.length && sbs.length > 0, sbsWithVideo.length > 0), completed: sbsWithVideo.length, total: sbs.length },
      compose_shots: { status: stepStatus(sbsComposed.length === sbs.length && sbs.length > 0, sbsComposed.length > 0), completed: sbsComposed.length, total: sbs.length },
      merge_episode: { status: latestMerge?.status === 'completed' ? 'done' : (latestMerge ? latestMerge.status : 'pending'), merged_url: latestMerge?.mergedUrl },
    },
  })
})

export default app
