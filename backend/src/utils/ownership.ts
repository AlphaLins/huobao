import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getCurrentUser } from '../middleware/auth.js'

export function canAccessDrama(c: Context, dramaId: number | null | undefined): boolean {
  if (!dramaId) return false
  const user = getCurrentUser(c)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, Number(dramaId))).all()
  return !!drama && (user?.role === 'admin' || drama.userId === user?.id)
}

export function canAccessEpisode(c: Context, episodeId: number | null | undefined): boolean {
  if (!episodeId) return false
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(episodeId))).all()
  return !!episode && canAccessDrama(c, episode.dramaId)
}

export function canAccessStoryboard(c: Context, storyboardId: number | null | undefined): boolean {
  if (!storyboardId) return false
  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(storyboardId))).all()
  return !!storyboard && canAccessEpisode(c, storyboard.episodeId)
}

export function canAccessCharacter(c: Context, characterId: number | null | undefined): boolean {
  if (!characterId) return false
  const [character] = db.select().from(schema.characters).where(eq(schema.characters.id, Number(characterId))).all()
  return !!character && canAccessDrama(c, character.dramaId)
}

export function canAccessScene(c: Context, sceneId: number | null | undefined): boolean {
  if (!sceneId) return false
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, Number(sceneId))).all()
  return !!scene && canAccessDrama(c, scene.dramaId)
}

export function canAccessGeneration(c: Context, row: { dramaId?: number | null; storyboardId?: number | null; sceneId?: number | null; characterId?: number | null } | null | undefined): boolean {
  if (!row) return false
  if (row.dramaId && canAccessDrama(c, row.dramaId)) return true
  if (row.storyboardId && canAccessStoryboard(c, row.storyboardId)) return true
  if (row.sceneId && canAccessScene(c, row.sceneId)) return true
  if (row.characterId && canAccessCharacter(c, row.characterId)) return true
  return false
}
