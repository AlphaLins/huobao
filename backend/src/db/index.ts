import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { BUILTIN_AGENT_PRESETS } from '../agents/preset-data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../../../data/huobao_drama.db')

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const sqlite = new Database(DB_PATH, { timeout: 30000 })
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('busy_timeout = 30000')

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_token_hash
    ON sessions (token_hash);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id
    ON sessions (user_id);

  CREATE TABLE IF NOT EXISTS dramas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    genre TEXT,
    style TEXT DEFAULT 'realistic',
    total_episodes INTEGER DEFAULT 1,
    total_duration INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    thumbnail TEXT,
    tags TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    script_content TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    video_url TEXT,
    thumbnail TEXT,
    image_config_id INTEGER,
    video_config_id INTEGER,
    audio_config_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    description TEXT,
    appearance TEXT,
    personality TEXT,
    voice_style TEXT,
    image_url TEXT,
    reference_images TEXT,
    seed_value TEXT,
    sort_order INTEGER,
    local_path TEXT,
    voice_sample_url TEXT,
    voice_provider TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER,
    location TEXT NOT NULL,
    time TEXT NOT NULL,
    prompt TEXT NOT NULL,
    storyboard_count INTEGER DEFAULT 1,
    image_url TEXT,
    status TEXT DEFAULT 'pending',
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS storyboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER,
    storyboard_number INTEGER NOT NULL,
    title TEXT,
    location TEXT,
    time TEXT,
    shot_type TEXT,
    angle TEXT,
    movement TEXT,
    action TEXT,
    result TEXT,
    atmosphere TEXT,
    image_prompt TEXT,
    video_prompt TEXT,
    bgm_prompt TEXT,
    sound_effect TEXT,
    dialogue TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    composed_image TEXT,
    first_frame_image TEXT,
    last_frame_image TEXT,
    reference_images TEXT,
    video_url TEXT,
    tts_audio_url TEXT,
    subtitle_url TEXT,
    composed_video_url TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS episode_characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episode_characters_episode_id
    ON episode_characters (episode_id);
  CREATE INDEX IF NOT EXISTS idx_episode_characters_character_id
    ON episode_characters (character_id);

  CREATE TABLE IF NOT EXISTS episode_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episode_scenes_episode_id
    ON episode_scenes (episode_id);
  CREATE INDEX IF NOT EXISTS idx_episode_scenes_scene_id
    ON episode_scenes (scene_id);

  CREATE TABLE IF NOT EXISTS storyboard_characters (
    storyboard_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, character_id)
  );
  CREATE INDEX IF NOT EXISTS idx_storyboard_characters_storyboard_id
    ON storyboard_characters (storyboard_id);
  CREATE INDEX IF NOT EXISTS idx_storyboard_characters_character_id
    ON storyboard_characters (character_id);

  CREATE TABLE IF NOT EXISTS ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    provider TEXT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    query_endpoint TEXT,
    priority INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_service_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_name TEXT,
    service_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    default_url TEXT,
    preset_models TEXT,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_id TEXT NOT NULL UNIQUE,
    voice_name TEXT NOT NULL,
    description TEXT,
    language TEXT,
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    model TEXT,
    system_prompt TEXT,
    temperature REAL,
    max_tokens INTEGER,
    max_iterations INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    is_builtin INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_preset_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preset_id INTEGER NOT NULL,
    agent_type TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT,
    system_prompt TEXT,
    temperature REAL,
    max_tokens INTEGER,
    max_iterations INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_preset_configs_unique
    ON agent_preset_configs (preset_id, agent_type);

  CREATE TABLE IF NOT EXISTS image_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER,
    drama_id INTEGER,
    scene_id INTEGER,
    character_id INTEGER,
    prop_id INTEGER,
    image_type TEXT,
    frame_type TEXT,
    provider TEXT,
    prompt TEXT,
    negative_prompt TEXT,
    model TEXT,
    size TEXT,
    quality TEXT,
    style TEXT,
    steps INTEGER,
    cfg_scale REAL,
    seed INTEGER,
    image_url TEXT,
    minio_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'pending',
    task_id TEXT,
    error_msg TEXT,
    width INTEGER,
    height INTEGER,
    reference_images TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS video_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER,
    drama_id INTEGER,
    provider TEXT,
    prompt TEXT,
    model TEXT,
    image_gen_id INTEGER,
    reference_mode TEXT,
    image_url TEXT,
    first_frame_url TEXT,
    last_frame_url TEXT,
    reference_image_urls TEXT,
    duration INTEGER,
    fps INTEGER,
    resolution TEXT,
    aspect_ratio TEXT,
    style TEXT,
    motion_level INTEGER,
    camera_motion TEXT,
    seed INTEGER,
    video_url TEXT,
    minio_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'pending',
    task_id TEXT,
    error_msg TEXT,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS video_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER,
    drama_id INTEGER,
    title TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    scenes TEXT,
    merged_url TEXT,
    duration INTEGER,
    task_id TEXT,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    description TEXT,
    prompt TEXT,
    image_url TEXT,
    reference_images TEXT,
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER,
    episode_id INTEGER,
    storyboard_id INTEGER,
    storyboard_num INTEGER,
    name TEXT,
    description TEXT,
    type TEXT,
    category TEXT,
    url TEXT,
    thumbnail_url TEXT,
    local_path TEXT,
    file_size INTEGER,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    duration INTEGER,
    format TEXT,
    image_gen_id INTEGER,
    video_gen_id INTEGER,
    is_favorite INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
`)

function ensureColumn(table: string, column: string, definition: string) {
  const tableExists = sqlite.prepare(
    `SELECT 1 as ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
  ).get(table) as { ok: number } | undefined
  if (!tableExists) return
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some(col => col.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

ensureColumn('episodes', 'image_config_id', 'INTEGER')
ensureColumn('episodes', 'storyboard_image_config_id', 'INTEGER')
ensureColumn('episodes', 'video_config_id', 'INTEGER')
ensureColumn('episodes', 'audio_config_id', 'INTEGER')
ensureColumn('dramas', 'style_prompt', 'TEXT')
ensureColumn('dramas', 'user_id', 'INTEGER')
ensureColumn('dramas', 'agent_preset_id', 'INTEGER')

function seedBuiltinAgentPresets() {
  const ts = new Date().toISOString()
  const insertPreset = sqlite.prepare(`
    INSERT INTO agent_presets (key, name, description, is_builtin, is_default, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, 1, ?, ?)
  `)
  const updatePreset = sqlite.prepare(`
    UPDATE agent_presets
    SET name = ?, description = ?, is_builtin = 1, is_active = 1, updated_at = ?
    WHERE id = ?
  `)
  const findPreset = sqlite.prepare('SELECT id FROM agent_presets WHERE key = ? LIMIT 1')
  const upsertConfig = sqlite.prepare(`
    INSERT INTO agent_preset_configs (
      preset_id, agent_type, name, model, system_prompt, temperature, max_tokens, max_iterations, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(preset_id, agent_type) DO UPDATE SET
      name = excluded.name,
      model = CASE WHEN agent_preset_configs.model IS NULL OR agent_preset_configs.model = '' THEN excluded.model ELSE agent_preset_configs.model END,
      system_prompt = excluded.system_prompt,
      temperature = excluded.temperature,
      max_tokens = excluded.max_tokens,
      max_iterations = excluded.max_iterations,
      updated_at = excluded.updated_at
  `)

  const tx = sqlite.transaction(() => {
    for (const preset of BUILTIN_AGENT_PRESETS) {
      let row = findPreset.get(preset.key) as { id: number } | undefined
      if (row) {
        updatePreset.run(preset.name, preset.description, ts, row.id)
      } else {
        const result = insertPreset.run(preset.key, preset.name, preset.description, preset.isDefault ? 1 : 0, ts, ts)
        row = { id: Number(result.lastInsertRowid) }
      }

      for (const config of preset.configs) {
        upsertConfig.run(
          row.id,
          config.agentType,
          config.name,
          config.model,
          config.systemPrompt,
          config.temperature,
          config.maxTokens,
          config.maxIterations,
          ts,
          ts,
        )
      }
    }

    const defaultRow = sqlite.prepare(`
      SELECT id FROM agent_presets
      WHERE is_default = 1 AND deleted_at IS NULL
      ORDER BY id
      LIMIT 1
    `).get() as { id: number } | undefined
    if (!defaultRow) {
      sqlite.prepare("UPDATE agent_presets SET is_default = 1 WHERE key = 'original'").run()
    }
  })

  tx()
}

seedBuiltinAgentPresets()

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `scrypt:${salt}:${derived}`
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, salt, hash] = parts
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

const ts = new Date().toISOString()
const adminUsername = process.env.ADMIN_USERNAME || 'admin'
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123'
const adminDisplayName = process.env.ADMIN_DISPLAY_NAME || 'Admin'

let admin = sqlite.prepare('SELECT * FROM users WHERE role = ? ORDER BY id LIMIT 1').get('admin') as
  | { id: number; username: string; password_hash: string }
  | undefined

if (!admin) {
  const passwordHash = hashPassword(adminPassword)
  const info = sqlite.prepare(`
    INSERT INTO users (username, password_hash, display_name, role, status, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', 'active', ?, ?)
  `).run(adminUsername, passwordHash, adminDisplayName, ts, ts)
  admin = {
    id: Number(info.lastInsertRowid),
    username: adminUsername,
    password_hash: passwordHash,
  }
  console.warn(`Created default admin account: ${adminUsername}`)
}

sqlite.prepare('UPDATE dramas SET user_id = ? WHERE user_id IS NULL').run(admin.id)

export const db = drizzle(sqlite, { schema })
export { schema }
export type DB = typeof db
export const rawSqlite: any = sqlite
export const passwordUtils = { hashPassword, verifyPassword }
