import { Hono } from 'hono'
import { randomBytes } from 'crypto'
import { rawSqlite, passwordUtils } from '../db/index.js'
import { badRequest, created, forbidden, success, unauthorized, now } from '../utils/response.js'
import { clearSessionCookie, getCurrentUser, hashToken, requireAdmin, requireAuth, sessionCookie } from '../middleware/auth.js'

const app = new Hono()

const SESSION_DAYS = Number(process.env.AUTH_SESSION_DAYS || 14)
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60

function publicAccessPassword() {
  return process.env.PUBLIC_ACCESS_PASSWORD || 'huobao'
}

function toPublicUser(row: any) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

app.get('/me', requireAuth, async (c) => {
  return success(c, getCurrentUser(c))
})

app.post('/login', async (c) => {
  const body = await c.req.json()
  const accessPassword = String(body.access_password || '')
  const username = String(body.username || '').trim()
  const password = String(body.password || '')

  if (!username || !password) return badRequest(c, 'username and password are required')
  if (accessPassword !== publicAccessPassword()) return unauthorized(c, 'invalid access password')

  const user = rawSqlite.prepare('SELECT * FROM users WHERE username = ? LIMIT 1').get(username) as any
  if (!user || user.status !== 'active') return unauthorized(c, 'invalid username or password')
  if (!passwordUtils.verifyPassword(password, user.password_hash)) {
    return unauthorized(c, 'invalid username or password')
  }

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString()
  rawSqlite.prepare(`
    INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(user.id, hashToken(token), expiresAt, now())

  c.header('Set-Cookie', sessionCookie(token, SESSION_SECONDS))
  return success(c, { user: toPublicUser(user) })
})

app.post('/logout', requireAuth, async (c) => {
  const cookie = c.req.header('cookie') || ''
  const match = cookie.match(/(?:^|;\s*)huobao_session=([^;]+)/)
  if (match) {
    rawSqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(decodeURIComponent(match[1])))
  }
  c.header('Set-Cookie', clearSessionCookie())
  return success(c)
})

app.get('/users', requireAuth, requireAdmin, async (c) => {
  const rows = rawSqlite.prepare('SELECT * FROM users ORDER BY id').all()
  return success(c, rows.map(toPublicUser))
})

app.post('/users', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json()
  const username = String(body.username || '').trim()
  const password = String(body.password || '')
  const displayName = String(body.display_name || body.displayName || username).trim()
  const role = body.role === 'admin' ? 'admin' : 'user'

  if (!username || !password) return badRequest(c, 'username and password are required')
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return badRequest(c, 'username must be 3-32 characters: letters, numbers, dot, dash, underscore')
  }
  if (password.length < 6) return badRequest(c, 'password must be at least 6 characters')

  const existing = rawSqlite.prepare('SELECT id FROM users WHERE username = ? LIMIT 1').get(username)
  if (existing) return badRequest(c, 'username already exists')

  const ts = now()
  const info = rawSqlite.prepare(`
    INSERT INTO users (username, password_hash, display_name, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(username, passwordUtils.hashPassword(password), displayName || username, role, ts, ts)

  const user = rawSqlite.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)
  return created(c, toPublicUser(user))
})

app.put('/users/:id', requireAuth, requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const current = getCurrentUser(c)
  const user = rawSqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
  if (!user) return badRequest(c, 'user not found')

  const updates: string[] = []
  const values: any[] = []

  if ('display_name' in body || 'displayName' in body) {
    updates.push('display_name = ?')
    values.push(String(body.display_name || body.displayName || '').trim())
  }
  if ('password' in body && body.password) {
    if (String(body.password).length < 6) return badRequest(c, 'password must be at least 6 characters')
    updates.push('password_hash = ?')
    values.push(passwordUtils.hashPassword(String(body.password)))
  }
  if ('role' in body) {
    if (id === current?.id && body.role !== 'admin') return forbidden(c, 'cannot remove your own admin role')
    updates.push('role = ?')
    values.push(body.role === 'admin' ? 'admin' : 'user')
  }
  if ('status' in body) {
    if (id === current?.id && body.status !== 'active') return forbidden(c, 'cannot disable your own account')
    updates.push('status = ?')
    values.push(body.status === 'disabled' ? 'disabled' : 'active')
  }

  if (!updates.length) return badRequest(c, 'no valid fields')
  updates.push('updated_at = ?')
  values.push(now(), id)

  rawSqlite.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  const updated = rawSqlite.prepare('SELECT * FROM users WHERE id = ?').get(id)
  return success(c, toPublicUser(updated))
})

export default app
