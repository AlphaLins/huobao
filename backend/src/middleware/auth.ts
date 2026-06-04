import type { Context, Next } from 'hono'
import { createHash } from 'crypto'
import { rawSqlite } from '../db/index.js'
import { forbidden, unauthorized } from '../utils/response.js'

export type AuthUser = {
  id: number
  username: string
  displayName: string | null
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
}

const COOKIE_NAME = 'huobao_session'

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (header || '').split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) cookies[key] = decodeURIComponent(value)
  }
  return cookies
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.AUTH_COOKIE_SECURE === 'true'
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function getCurrentUser(c: Context): AuthUser | null {
  return (c.get('user') as AuthUser | undefined) || null
}

export async function requireAuth(c: Context, next: Next) {
  const cookies = parseCookies(c.req.header('cookie'))
  const token = cookies[COOKIE_NAME]
  if (!token) return unauthorized(c)

  const tokenHash = hashToken(token)
  const row = rawSqlite.prepare(`
    SELECT
      sessions.id as session_id,
      sessions.expires_at as expires_at,
      users.id as id,
      users.username as username,
      users.display_name as display_name,
      users.role as role,
      users.status as status
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
    LIMIT 1
  `).get(tokenHash) as any

  if (!row) return unauthorized(c)
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    rawSqlite.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id)
    c.header('Set-Cookie', clearSessionCookie())
    return unauthorized(c)
  }
  if (row.status !== 'active') return forbidden(c, 'account disabled')

  c.set('user', {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
  } satisfies AuthUser)
  await next()
}

export async function requireAdmin(c: Context, next: Next) {
  const user = getCurrentUser(c)
  if (!user) return unauthorized(c)
  if (user.role !== 'admin') return forbidden(c, 'admin required')
  await next()
}
