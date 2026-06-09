import './config' // validates env vars and creates dirs early
import { createBot } from './bot/index'
import { startDashboard } from './dashboard/server'
import { startScheduler } from './scheduler'

async function main() {
  console.log('[wingman] Starting...')

  startDashboard()

  const bot = createBot()
  startScheduler(bot)

  await bot.start({
    onStart: info => console.log(`[bot] @${info.username} is running`),
    drop_pending_updates: true,
  })
}

main().catch(err => {
  if (err instanceof Error && err.message.includes('404')) {
    console.error(
      '[fatal] Telegram returned 404 — your bot token is invalid.\n' +
      '  1. Open Telegram and message @BotFather\n' +
      '  2. Send /newbot and follow the prompts\n' +
      '  3. Copy the token into TELEGRAM_BOT_TOKEN in your .env file'
    )
  } else {
    console.error('[fatal]', err.message ?? err)
  }
  process.exit(1)
})
