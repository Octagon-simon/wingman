// api.telegram.org has both A and AAAA records. On this network IPv6 is unreachable,
// so Node's undici tries both and hangs on AggregateError. Force IPv4 DNS ordering
// globally before any network code runs.
import dns from 'dns'
dns.setDefaultResultOrder('ipv4first')

import './config' // validates env vars and creates dirs early
import { createBot } from './bot/index'
import { startDashboard } from './dashboard/server'
import { startScheduler } from './scheduler'

const RETRY_DELAY_MS  = 5_000   // wait between connection attempts
const MAX_RETRIES     = 10      // give up after this many consecutive failures
const CONNECT_WARN_MS = 15_000  // log a hint if still connecting after this long

async function main() {
  console.log('[wingman] Starting...')

  startDashboard()

  const bot = createBot()
  startScheduler(bot)

  process.once('SIGINT',  () => void bot.stop())
  process.once('SIGTERM', () => void bot.stop())

  let attempts = 0

  while (true) {
    attempts++

    // Warn the user if the initial handshake is taking too long
    const warnTimer = setTimeout(() => {
      console.warn(
        '[bot] Still connecting to Telegram... ' +
        '(check network access to api.telegram.org)'
      )
    }, CONNECT_WARN_MS)

    try {
      await bot.start({
        onStart: info => {
          clearTimeout(warnTimer)
          attempts = 0
          console.log(`[bot] @${info.username} is running`)
        },
        drop_pending_updates: true,
      })
      // bot.start() resolves only when the bot is stopped — normal exit
      break
    } catch (err) {
      clearTimeout(warnTimer)
      const msg = err instanceof Error ? err.message : String(err)

      if (msg.includes('404')) {
        console.error(
          '[fatal] Telegram returned 404 — your bot token is invalid.\n' +
          '  1. Open Telegram and message @BotFather\n' +
          '  2. Send /newbot and follow the prompts\n' +
          '  3. Copy the token into TELEGRAM_BOT_TOKEN in your .env file'
        )
        process.exit(1)
      }

      if (attempts >= MAX_RETRIES) {
        console.error(`[bot] Failed to connect after ${MAX_RETRIES} attempts. Last error: ${msg}`)
        process.exit(1)
      }

      console.warn(`[bot] Connection failed (${msg}) — retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempts}/${MAX_RETRIES})`)
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    }
  }
}

main().catch(err => {
  console.error('[fatal]', err instanceof Error ? err.message : err)
  process.exit(1)
})
