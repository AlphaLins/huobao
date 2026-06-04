import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, created, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { requireAdmin } from '../middleware/auth.js'
import { AGENT_PRESET_TYPES, BUILTIN_AGENT_PRESETS } from '../agents/preset-data.js'

const app = new Hono()

function presetWithConfigs(row: any) {
  const configs = db.select().from(schema.agentPresetConfigs)
    .where(eq(schema.agentPresetConfigs.presetId, row.id))
    .all()
  return {
    ...toSnakeCase(row),
    configs: toSnakeCaseArray(configs),
  }
}

function getDefaultPreset() {
  const [row] = db.select().from(schema.agentPresets)
    .where(and(eq(schema.agentPresets.isDefault, true), isNull(schema.agentPresets.deletedAt)))
    .all()
  if (row) return row
  const [original] = db.select().from(schema.agentPresets)
    .where(and(eq(schema.agentPresets.key, 'original'), isNull(schema.agentPresets.deletedAt)))
    .all()
  return original || null
}

function upsertPresetConfigs(presetId: number, configs: any[]) {
  const ts = now()
  const validTypes = new Set(AGENT_PRESET_TYPES.map(a => a.type))

  for (const config of configs || []) {
    if (!validTypes.has(config.agent_type)) continue
    const [existing] = db.select().from(schema.agentPresetConfigs)
      .where(and(
        eq(schema.agentPresetConfigs.presetId, presetId),
        eq(schema.agentPresetConfigs.agentType, config.agent_type),
      ))
      .all()

    const values = {
      name: config.name || AGENT_PRESET_TYPES.find(a => a.type === config.agent_type)?.name || config.agent_type,
      model: config.model || '',
      systemPrompt: config.system_prompt || '',
      temperature: config.temperature ?? 0.7,
      maxTokens: config.max_tokens ?? 4096,
      maxIterations: config.max_iterations ?? 10,
      updatedAt: ts,
    }

    if (existing) {
      db.update(schema.agentPresetConfigs).set(values).where(eq(schema.agentPresetConfigs.id, existing.id)).run()
    } else {
      db.insert(schema.agentPresetConfigs).values({
        presetId,
        agentType: config.agent_type,
        ...values,
        createdAt: ts,
      }).run()
    }
  }
}

// GET /agent-presets
app.get('/', async (c) => {
  const rows = db.select().from(schema.agentPresets)
    .where(isNull(schema.agentPresets.deletedAt))
    .all()
  return success(c, rows.map(presetWithConfigs))
})

// GET /agent-presets/default
app.get('/default', async (c) => {
  const row = getDefaultPreset()
  if (!row) return badRequest(c, 'No default preset')
  return success(c, presetWithConfigs(row))
})

// POST /agent-presets
app.post('/', requireAdmin, async (c) => {
  const body = await c.req.json()
  if (!body.name) return badRequest(c, 'name required')
  const key = String(body.key || body.name).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  const ts = now()

  const res = db.insert(schema.agentPresets).values({
    key: `${key}_${Date.now()}`,
    name: body.name,
    description: body.description || '',
    isBuiltin: false,
    isDefault: false,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const presetId = Number(res.lastInsertRowid)

  const sourceConfigs = Array.isArray(body.configs) && body.configs.length
    ? body.configs
    : BUILTIN_AGENT_PRESETS[0].configs.map(c => ({
      agent_type: c.agentType,
      name: c.name,
      model: c.model,
      system_prompt: c.systemPrompt,
      temperature: c.temperature,
      max_tokens: c.maxTokens,
      max_iterations: c.maxIterations,
    }))
  upsertPresetConfigs(presetId, sourceConfigs)

  const [row] = db.select().from(schema.agentPresets).where(eq(schema.agentPresets.id, presetId)).all()
  return created(c, presetWithConfigs(row))
})

// POST /agent-presets/:id/duplicate
app.post('/:id/duplicate', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [source] = db.select().from(schema.agentPresets).where(eq(schema.agentPresets.id, id)).all()
  if (!source || source.deletedAt) return badRequest(c, 'Preset not found')

  const configs = db.select().from(schema.agentPresetConfigs)
    .where(eq(schema.agentPresetConfigs.presetId, id))
    .all()
  const ts = now()
  const res = db.insert(schema.agentPresets).values({
    key: `${source.key}_copy_${Date.now()}`,
    name: body.name || `${source.name} 副本`,
    description: body.description ?? source.description ?? '',
    isBuiltin: false,
    isDefault: false,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const presetId = Number(res.lastInsertRowid)
  upsertPresetConfigs(presetId, configs.map(c => ({
    agent_type: c.agentType,
    name: c.name,
    model: c.model,
    system_prompt: c.systemPrompt,
    temperature: c.temperature,
    max_tokens: c.maxTokens,
    max_iterations: c.maxIterations,
  })))

  const [row] = db.select().from(schema.agentPresets).where(eq(schema.agentPresets.id, presetId)).all()
  return created(c, presetWithConfigs(row))
})

// PUT /agent-presets/:id
app.put('/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [preset] = db.select().from(schema.agentPresets).where(eq(schema.agentPresets.id, id)).all()
  if (!preset || preset.deletedAt) return badRequest(c, 'Preset not found')
  if (preset.isBuiltin && Array.isArray(body.configs)) return badRequest(c, '内置预设不能直接修改，请复制为自定义预设')

  const updates: Record<string, any> = { updatedAt: now() }
  if (!preset.isBuiltin && 'name' in body) updates.name = body.name
  if ('description' in body) updates.description = body.description
  if ('is_active' in body) updates.isActive = body.is_active
  db.update(schema.agentPresets).set(updates).where(eq(schema.agentPresets.id, id)).run()

  if (Array.isArray(body.configs)) upsertPresetConfigs(id, body.configs)

  const [row] = db.select().from(schema.agentPresets).where(eq(schema.agentPresets.id, id)).all()
  return success(c, presetWithConfigs(row))
})

// POST /agent-presets/:id/set-default
app.post('/:id/set-default', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const [preset] = db.select().from(schema.agentPresets).where(eq(schema.agentPresets.id, id)).all()
  if (!preset || preset.deletedAt) return badRequest(c, 'Preset not found')
  db.update(schema.agentPresets).set({ isDefault: false }).run()
  db.update(schema.agentPresets).set({ isDefault: true, updatedAt: now() }).where(eq(schema.agentPresets.id, id)).run()
  return success(c, presetWithConfigs({ ...preset, isDefault: true }))
})

// DELETE /agent-presets/:id
app.delete('/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const [preset] = db.select().from(schema.agentPresets).where(eq(schema.agentPresets.id, id)).all()
  if (!preset || preset.deletedAt) return badRequest(c, 'Preset not found')
  if (preset.isBuiltin) return badRequest(c, '内置预设不能删除')
  db.update(schema.agentPresets).set({ deletedAt: now(), isActive: false }).where(eq(schema.agentPresets.id, id)).run()
  return success(c)
})

export default app
