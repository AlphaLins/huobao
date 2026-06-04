import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'

/**
 * 根据 dramaId 获取风格提示词
 */
export function getDramaStylePrompt(dramaId: number | null | undefined): string {
  if (!dramaId) return ''
  const [drama] = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, dramaId)).all()
  return drama?.stylePrompt?.trim() || ''
}

/**
 * 将风格提示词注入到原始 prompt 后，作为风格修饰
 * 格式: "{originalPrompt} -- {stylePrompt}"
 * 使用 " -- " 分隔符明确区分内容和风格，避免风格覆盖结构性指令
 */
export function injectStylePrompt(
  originalPrompt: string,
  dramaId: number | null | undefined,
): string {
  const style = getDramaStylePrompt(dramaId)
  if (!style) return originalPrompt
  return `${originalPrompt} -- ${style}`
}
