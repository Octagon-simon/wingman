import type { Api } from 'grammy'
import { and, eq, isNull, lte } from 'drizzle-orm'
import { db } from './db'
import { applications } from './db/schema'
import { getUserConfig } from './user-config'

interface BotLike { api: Api }

const SEVEN_DAYS_SECS = 7 * 24 * 60 * 60

export function startScheduler(bot: BotLike) {
  void checkFollowUps(bot)
  setInterval(() => void checkFollowUps(bot), 24 * 60 * 60 * 1000)
}

async function checkFollowUps(bot: BotLike) {
  const cfg = getUserConfig()
  if (!cfg.chatId) return

  const cutoff = Math.floor(Date.now() / 1000) - SEVEN_DAYS_SECS

  const due = await db
    .select()
    .from(applications)
    .where(
      and(
        eq(applications.status, 'sent'),
        lte(applications.createdAt, cutoff),
        isNull(applications.followUpSentAt)
      )
    )

  for (const app of due) {
    try {
      const days = Math.floor((Date.now() / 1000 - app.createdAt) / 86400)
      await bot.api.sendMessage(
        cfg.chatId,
        `📬 *${app.role}* at ${app.company} — sent ${days} days ago with no reply.\n\nSend a follow-up? /followup ${app.id}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error(`[scheduler] Failed to notify for app #${app.id}:`, err)
    }
  }
}
