import { Bot, Context, session, SessionFlavor, InputFile } from 'grammy'
import { writeFileSync, existsSync } from 'fs'
import path from 'path'
import axios from 'axios'
import { config } from '../config'
import {
  getUserConfig,
  setUserConfig,
  getResumePath,
  addVariant,
} from '../user-config'
import { parseResume } from '../resume/parser'
import { optimizeResume } from '../ai/optimizer'
import { generateCoverLetter } from '../ai/cover-letter'
import { extractJobDetails } from '../ai/job-extractor'
import { generateFollowUp } from '../ai/follow-up'
import { analyzeGaps } from '../ai/gap-analyzer'
import { generateResumeDocx } from '../resume/generator'
import { extractLinks } from '../resume/parser'
import { countDocxPages } from '../resume/page-check'
import { sendApplication, sendFollowUp } from '../email/sender'
import { db } from '../db'
import { applications } from '../db/schema'
import { eq, desc, isNotNull } from 'drizzle-orm'

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Downloads a Telegram file URL with up to 3 attempts and exponential backoff.
// Telegram's CDN occasionally times out; retrying almost always succeeds.
async function downloadWithRetry(url: string, attempts = 3): Promise<Buffer> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 30_000,
      })
      return Buffer.from(res.data)
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, (i + 1) * 2000))
      }
    }
  }
  throw lastErr
}

// ─── Session ─────────────────────────────────────────────────────────────────

type Flow = 'setup' | 'apply' | null

interface SessionData {
  flow: Flow
  step: string | null
  // apply
  role?: string
  company?: string
  toEmail?: string
  jd?: string
  resumeText?: string         // cached so revisions don't re-parse the file
  selectedVariant?: string    // label of chosen resume variant
  additionalContext?: string  // extra info provided after gap analysis
  contextGathered?: boolean   // true once gap analysis step is complete
  pendingResumePath?: string
  resumeManuallyUploaded?: boolean  // true when user uploaded a DOCX; prevents free-text from re-running optimizer
  pendingCoverLetter?: string
  providerUsed?: string
  // setup
  pendingSetupPath?: string  // temp path while waiting for variant label
}

type Ctx = Context & SessionFlavor<SessionData>

function freshSession(): SessionData {
  return { flow: null, step: null }
}

function clearFlow(ctx: Ctx) {
  ctx.session = freshSession()
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toKebabCase(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

function toFileName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000)
}

function variantList(cfg: ReturnType<typeof getUserConfig>): string {
  return (cfg.variants ?? [])
    .map((v, i) => `  ${i + 1}. ${v.label}${v.label === cfg.defaultVariant ? ' (default)' : ''}`)
    .join('\n')
}

// ─── Core application processor ──────────────────────────────────────────────

async function processApplication(ctx: Ctx): Promise<void> {
  const cfg = getUserConfig()

  // Parse resume once; cache in session so revisions and context-retry skip this
  if (!ctx.session.resumeText) {
    const variantPath = getResumePath(cfg, ctx.session.selectedVariant)
    if (!variantPath || !existsSync(variantPath)) {
      throw new Error('Resume file not found. Run /setup to upload a new one.')
    }
    ctx.session.resumeText = await parseResume(variantPath)
  }

  // Gap analysis — only on first run, before context has been gathered, and only when a JD exists
  if (!ctx.session.contextGathered && ctx.session.jd?.trim()) {
    const analysis = await analyzeGaps(ctx.session.resumeText, ctx.session.jd!, ctx.session.role!)

    if (analysis.hasSignificantGaps && analysis.gaps.length > 0) {
      ctx.session.step = 'awaiting_context'
      const gapList = analysis.gaps.map(g => `• ${g}`).join('\n')
      await ctx.reply(
        `Your resume is a strong fit overall, but the JD specifically requires:\n\n${gapList}\n\nDo you have any experience with these? Share details and I'll work them into your application — or type *skip* to proceed as-is.`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    ctx.session.contextGathered = true
  }

  await runAIAndSendPreview(ctx, cfg.portfolioUrl)
}

// ─── Shared preview builder (first run + revisions) ──────────────────────────

async function getRecentResumes(limit: number) {
  return db
    .select()
    .from(applications)
    .where(isNotNull(applications.resumePath))
    .orderBy(desc(applications.createdAt))
    .limit(limit)
}

type RevisionTarget = 'both' | 'resume' | 'cover-letter'

function parseRevision(text: string): { target: RevisionTarget; note: string } {
  const resumeMatch = text.match(/^resume:\s*/i)
  if (resumeMatch) return { target: 'resume', note: text.slice(resumeMatch[0].length).trim() }
  const clMatch = text.match(/^cover\s*letter:\s*/i)
  if (clMatch) return { target: 'cover-letter', note: text.slice(clMatch[0].length).trim() }
  return { target: 'both', note: text }
}

async function runAIAndSendPreview(
  ctx: Ctx,
  portfolioUrl?: string,
  revisionNote?: string,
  revisionTarget: RevisionTarget = 'both'
) {
  const { resumeText, jd, role, company } = ctx.session
  const slug = toKebabCase(config.fromName)
  const displayName = toFileName(config.fromName)
  const ts = Date.now()

  const shouldReviseResume = revisionTarget === 'both' || revisionTarget === 'resume'
  const shouldReviseCL = revisionTarget === 'both' || revisionTarget === 'cover-letter'

  let resumePath = ctx.session.pendingResumePath
  let coverText = ctx.session.pendingCoverLetter ?? ''
  let providerResume = ''
  let providerCL = ''
  let keywords: string[] = []

  if (shouldReviseResume) {
    const certLinks = getUserConfig().certLinks
    const optimized = await optimizeResume(resumeText!, jd!, role!, portfolioUrl, revisionNote, ctx.session.additionalContext)
    resumePath = await generateResumeDocx(optimized.resume, `${slug}-${ts}.docx`, certLinks)
    ctx.session.resumeManuallyUploaded = false  // AI owns the resume now
    providerResume = optimized.provider
    keywords = optimized.keywordsAdded ?? []

    // If the generated resume spills onto a second page, retry with shorter bullets
    const pages = await countDocxPages(resumePath!, optimized.resume)
    if (pages > 1) {
      console.log('[resume] overflow detected — retrying with shorter bullets')
      const shortenNote = (revisionNote ? revisionNote + '\n\n' : '') +
        'CRITICAL: The resume is currently overflowing to a second page. Reduce every bullet point to at most 10 words. Keep only the single most impactful fact per bullet. Do not change anything else.'
      const reopt = await optimizeResume(resumeText!, jd!, role!, portfolioUrl, shortenNote, ctx.session.additionalContext)
      resumePath = await generateResumeDocx(reopt.resume, `${slug}-${ts}.docx`, certLinks)
      providerResume = reopt.provider
      keywords = reopt.keywordsAdded ?? []
    }
  }

  if (shouldReviseCL) {
    const coverResult = await generateCoverLetter(resumeText!, jd!, role!, company!, portfolioUrl, revisionNote)
    coverText = coverResult.text
    const clPath = path.join(config.uploadsDir, `cover-letter-${slug}-${ts}.txt`)
    writeFileSync(clPath, coverText)
    providerCL = coverResult.provider
  }

  ctx.session.pendingResumePath = resumePath
  ctx.session.pendingCoverLetter = coverText
  ctx.session.providerUsed = [providerResume, providerCL].filter(Boolean).join(' / ') || ctx.session.providerUsed
  ctx.session.step = 'awaiting_confirm'

  const providerLine = [
    providerResume ? `${providerResume} (resume)` : '',
    providerCL ? `${providerCL} (cover letter)` : '',
  ].filter(Boolean).join(' · ')

  await ctx.reply(
    [
      `*${role}* at ${company}`,
      `To: \`${ctx.session.toEmail}\``,
      providerLine ? `AI: ${providerLine}` : '',
      keywords.length ? `ATS keywords added: ${keywords.slice(0, 8).join(', ')}` : '',
    ].filter(Boolean).join('\n'),
    { parse_mode: 'Markdown' }
  )

  if (shouldReviseCL) {
    const clPath = path.join(config.uploadsDir, `cover-letter-${slug}-${ts}.txt`)
    await ctx.replyWithDocument(
      new InputFile(clPath, `${displayName}.txt`),
      { caption: '📝 Cover letter' }
    )
  }
  // Always send the resume so the user can verify what will be attached to the email,
  // even when this pass only revised the cover letter.
  if (resumePath && existsSync(resumePath)) {
    await ctx.replyWithDocument(
      new InputFile(resumePath, `${displayName}.docx`),
      { caption: shouldReviseResume ? '📄 Resume' : '📄 Resume (unchanged)' }
    )
  }

  const recent = await getRecentResumes(5)
  const recentLines = recent
    .filter(r => r.resumePath && existsSync(r.resumePath))
    .map((r, i) => `  ${i + 1}. ${r.role} @ ${r.company} (${new Date(r.createdAt * 1000).toLocaleDateString()})`)

  const recentSection = recentLines.length > 0
    ? ['\n*Previous resumes:*', ...recentLines, 'Reply `use 1`, `use 2` … to swap one in'].join('\n')
    : ''

  return ctx.reply(
    [
      'Review the files above, then:',
      '',
      '• *YES* — send it',
      '• *NO* — cancel',
      '• `resume: <note>` — revise only the resume',
      '• `cover letter: <note>` — revise only the cover letter',
      '• Just describe changes — revises both',
      '• Upload an edited DOCX to replace the resume',
      '• Upload an edited TXT to replace the cover letter',
      recentSection,
    ].join('\n'),
    { parse_mode: 'Markdown' }
  )
}

// ─── Bot ─────────────────────────────────────────────────────────────────────

export function createBot() {
  // timeoutSeconds: grammY's per-request fetch timeout.
  // Default is 500s — way too long when the network can't reach api.telegram.org.
  // 35s: 5s buffer over the 30s long-poll timeout so getUpdates isn't aborted early.
  const bot = new Bot<Ctx>(config.telegramToken, { client: { timeoutSeconds: 35 } })

  bot.use(session<SessionData, Ctx>({ initial: freshSession }))

  // ── /start & /help ──────────────────────────────────────────────────────────

  const HELP = `*Job Application Agent*

*Commands*
/setup — upload a resume variant and set your portfolio URL
/portfolio <url> — set or update your portfolio URL (use "clear" to remove it)
/apply — start a new application (paste a URL or type the role)
/status — view your last 10 applications
/followup <id> — send a follow-up email for an application
/cancel — cancel whatever is in progress

*During /apply — at the confirm step*
Reply YES — send the application
Reply NO — cancel
\`resume: <note>\` — revise only the resume
\`cover letter: <note>\` — revise only the cover letter
Any other text — revise both resume and cover letter
\`use 1\`, \`use 2\` … — swap in a previous resume
Upload a DOCX — replace the resume manually
Upload a TXT — replace the cover letter manually`

  bot.command('start', ctx => ctx.reply(HELP, { parse_mode: 'Markdown' }))
  bot.command('help', ctx => ctx.reply(HELP, { parse_mode: 'Markdown' }))

  bot.command('cancel', ctx => {
    clearFlow(ctx)
    return ctx.reply('Cancelled. Use /apply or /setup to start again.')
  })

  // ── /portfolio ───────────────────────────────────────────────────────────────

  bot.command('portfolio', ctx => {
    const arg = ctx.match?.trim()
    if (!arg) {
      const current = getUserConfig().portfolioUrl
      return ctx.reply(current
        ? `Current portfolio: ${current}\n\nSend /portfolio <url> to update it, or /portfolio clear to remove it.`
        : 'No portfolio URL set.\n\nSend /portfolio <url> to add one.')
    }
    if (arg.toLowerCase() === 'clear') {
      setUserConfig({ portfolioUrl: undefined })
      return ctx.reply('Portfolio URL removed.')
    }
    setUserConfig({ portfolioUrl: arg })
    return ctx.reply(`Portfolio URL updated: ${arg}`)
  })

  // ── /setup ──────────────────────────────────────────────────────────────────

  bot.command('setup', ctx => {
    clearFlow(ctx)
    ctx.session.flow = 'setup'
    ctx.session.step = 'awaiting_resume'
    const cfg = getUserConfig()
    const variants = cfg.variants ?? []

    let message: string
    if (variants.length === 0) {
      message = '📄 Upload your resume (PDF or DOCX):'
    } else {
      const list = variants.map(v => `• ${v.label}${v.label === cfg.defaultVariant ? ' (default)' : ''}`).join('\n')
      message = `Current resume variants:\n${list}\n\n📄 Upload a new or updated resume (PDF or DOCX):\n_You will be asked to label it._`
    }
    return ctx.reply(message, { parse_mode: 'Markdown' })
  })

  // ── /apply ──────────────────────────────────────────────────────────────────

  bot.command('apply', ctx => {
    const cfg = getUserConfig()
    if (!cfg.variants || cfg.variants.length === 0) {
      return ctx.reply('No resume on file yet. Run /setup first.')
    }
    clearFlow(ctx)
    ctx.session.flow = 'apply'
    ctx.session.step = 'awaiting_role'
    return ctx.reply(
      'Paste a job URL to auto-fill the details, or type the role name:\n\n_e.g. https://jobs.stripe.com/123 or "Senior Frontend Engineer"_',
      { parse_mode: 'Markdown' }
    )
  })

  // ── /status ─────────────────────────────────────────────────────────────────

  bot.command('status', async ctx => {
    const rows = await db
      .select()
      .from(applications)
      .orderBy(desc(applications.createdAt))
      .limit(10)

    if (rows.length === 0) {
      return ctx.reply('No applications yet. Use /apply to send your first one.')
    }

    const EMOJI: Record<string, string> = {
      sent: '📤',
      interviewing: '🔄',
      offer: '🎉',
      rejected: '❌',
    }

    const lines = rows.map(a => {
      const date = new Date(a.createdAt * 1000).toLocaleDateString()
      const icon = EMOJI[a.status] ?? '❓'
      const followedUp = a.followUpSentAt ? ' ↩' : ''
      return `${icon} #${a.id} *${a.role}* @ ${a.company} — ${date}${followedUp}`
    })

    return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
  })

  // ── /followup ────────────────────────────────────────────────────────────────

  bot.command('followup', async ctx => {
    const idStr = (ctx.match ?? '').trim()
    const id = parseInt(idStr)
    if (isNaN(id) || id <= 0) {
      return ctx.reply('Usage: /followup <id>\n\nGet application IDs from /status')
    }

    const [app] = await db.select().from(applications).where(eq(applications.id, id))
    if (!app) return ctx.reply(`Application #${id} not found.`)

    const days = Math.floor((Date.now() / 1000 - app.createdAt) / 86400)
    await ctx.reply(`Generating follow-up for #${id} — ${app.role} at ${app.company}... ⏳`)

    try {
      const { text } = await generateFollowUp(
        app.role,
        app.company,
        app.coverLetter ?? '',
        config.fromName,
        days
      )

      await sendFollowUp({
        to: app.toEmail,
        role: app.role,
        company: app.company,
        body: text,
      })

      await db
        .update(applications)
        .set({ followUpSentAt: Math.floor(Date.now() / 1000) })
        .where(eq(applications.id, id))

      return ctx.reply(`Follow-up sent to ${app.toEmail} ✓`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return ctx.reply(`Failed: ${msg}`)
    }
  })

  // ── Text messages — flow state machine ──────────────────────────────────────

  bot.on('message:text', async ctx => {
    const text = ctx.message.text.trim()
    if (text.startsWith('/')) return

    // Store chat ID for scheduler follow-up notifications
    if (ctx.chat?.id) {
      const cfg = getUserConfig()
      if (cfg.chatId !== ctx.chat.id) setUserConfig({ chatId: ctx.chat.id })
    }

    // ── Setup flow ─────────────────────────────────────────────────────────────
    if (ctx.session.flow === 'setup') {
      if (ctx.session.step === 'awaiting_variant_label') {
        const label = text.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        if (!label) return ctx.reply('Please enter a label (letters and numbers only):')

        const cfg = getUserConfig()
        const isFirst = !cfg.variants || cfg.variants.length === 0
        const makeDefault = label === 'default' || isFirst

        addVariant(label, ctx.session.pendingSetupPath!, makeDefault)
        ctx.session.pendingSetupPath = undefined
        ctx.session.step = 'awaiting_portfolio'

        const defaultNote = makeDefault ? ' and set as default' : ''
        return ctx.reply(
          `Saved as "${label}"${defaultNote} ✓\n\n🔗 Portfolio URL? (or reply "skip"):`,
          { parse_mode: 'Markdown' }
        )
      }

      if (ctx.session.step === 'awaiting_portfolio') {
        const url = text.toLowerCase() === 'skip' ? undefined : text
        setUserConfig({ portfolioUrl: url })
        const cfg = getUserConfig()
        const variants = cfg.variants ?? []
        const list = variants.map(v => `• ${v.label}${v.label === cfg.defaultVariant ? ' (default)' : ''}`).join('\n')
        clearFlow(ctx)
        return ctx.reply(
          [
            'Setup complete ✓',
            url ? `Portfolio: ${url}` : '',
            '',
            `Resume variants:\n${list}`,
            '',
            'Use /apply to send your first application.',
          ].filter(Boolean).join('\n')
        )
      }
      return
    }

    // ── Apply flow ─────────────────────────────────────────────────────────────
    if (ctx.session.flow === 'apply') {
      if (ctx.session.step === 'awaiting_role') {
        if (text.startsWith('http')) {
          await ctx.reply('Scraping job posting... ⏳')
          try {
            const res = await axios.get<string>(text, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobBot/1.0)' },
              timeout: 15000,
            })
            const cleaned = sanitizeHtml(res.data)
            const extracted = await extractJobDetails(cleaned)
            ctx.session.role = extracted.role
            ctx.session.company = extracted.company
            ctx.session.jd = extracted.description
            if (extracted.email) ctx.session.toEmail = extracted.email
            ctx.session.step = 'awaiting_scrape_confirm'

            const preview = extracted.description.slice(0, 200)
            return ctx.reply(
              [
                'Found this job posting:',
                `*Role:* ${extracted.role}`,
                `*Company:* ${extracted.company}`,
                extracted.email
                  ? `*Email:* \`${extracted.email}\``
                  : '*Email:* not found (you will be asked)',
                `*Preview:* ${preview}...`,
                '',
                'Reply *YES* to proceed or *NO* to enter details manually.',
              ].join('\n'),
              { parse_mode: 'Markdown' }
            )
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error('[bot] Scrape failed:', msg)
            return ctx.reply("Couldn't scrape that URL. Type the role name instead:")
          }
        }

        ctx.session.role = text
        ctx.session.step = 'awaiting_company'
        return ctx.reply('Company name?')
      }

      if (ctx.session.step === 'awaiting_scrape_confirm') {
        if (text.toUpperCase() === 'YES') {
          const cfg = getUserConfig()
          if (!ctx.session.toEmail) {
            ctx.session.step = 'awaiting_email'
            return ctx.reply('Application email? (not found in the posting):')
          }
          const variants = cfg.variants ?? []
          if (variants.length > 1) {
            ctx.session.step = 'awaiting_variant'
            return ctx.reply(`Which resume variant?\n${variantList(cfg)}`)
          }
          ctx.session.step = 'processing'
          await ctx.reply('Analysing fit... ⏳')
          try {
            await processApplication(ctx)
          } catch (err) {
            clearFlow(ctx)
            const msg = err instanceof Error ? err.message : String(err)
            await ctx.reply(`Failed:\n${msg}\n\nUse /apply to try again.`)
          }
          return
        }
        clearFlow(ctx)
        ctx.session.flow = 'apply'
        ctx.session.step = 'awaiting_role'
        return ctx.reply("OK, let's enter the details manually.\n\nWhat role are you applying for?")
      }

      if (ctx.session.step === 'awaiting_company') {
        ctx.session.company = text
        ctx.session.step = 'awaiting_email'
        return ctx.reply('Application email?\n\n_e.g. jobs@company.com_', { parse_mode: 'Markdown' })
      }

      if (ctx.session.step === 'awaiting_email') {
        if (!text.includes('@')) return ctx.reply("That doesn't look like an email. Try again:")
        ctx.session.toEmail = text
        const cfg = getUserConfig()
        const variants = cfg.variants ?? []
        if (variants.length > 1) {
          ctx.session.step = 'awaiting_variant'
          return ctx.reply(`Which resume variant?\n${variantList(cfg)}`)
        }
        if (ctx.session.jd) {
          // JD was pre-filled by scraper
          ctx.session.step = 'processing'
          await ctx.reply('Analysing fit... ⏳')
          try {
            await processApplication(ctx)
          } catch (err) {
            clearFlow(ctx)
            const msg = err instanceof Error ? err.message : String(err)
            await ctx.reply(`Failed:\n${msg}\n\nUse /apply to try again.`)
          }
          return
        }
        ctx.session.step = 'awaiting_jd'
        return ctx.reply('Paste the job description, or send the job posting URL:')
      }

      if (ctx.session.step === 'awaiting_variant') {
        const cfg = getUserConfig()
        const variants = cfg.variants ?? []
        const n = parseInt(text)
        if (isNaN(n) || n < 1 || n > variants.length) {
          return ctx.reply(`Pick a number 1–${variants.length}:\n${variantList(cfg)}`)
        }
        ctx.session.selectedVariant = variants[n - 1]!.label
        if (ctx.session.jd) {
          ctx.session.step = 'processing'
          await ctx.reply('Analysing fit... ⏳')
          try {
            await processApplication(ctx)
          } catch (err) {
            clearFlow(ctx)
            const msg = err instanceof Error ? err.message : String(err)
            await ctx.reply(`Failed:\n${msg}\n\nUse /apply to try again.`)
          }
          return
        }
        ctx.session.step = 'awaiting_jd'
        return ctx.reply('Paste the job description, or send the job posting URL:')
      }

      if (ctx.session.step === 'awaiting_jd') {
        let jd = text

        const noJd = /^(none|no|n\/a|na|skip|-)$/i.test(text.trim())
        if (noJd) {
          jd = ''
        } else if (text.startsWith('http')) {
          await ctx.reply('Fetching job posting...')
          try {
            const res = await axios.get<string>(text, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              timeout: 10000,
            })
            jd = sanitizeHtml(res.data)
          } catch {
            await ctx.reply('Could not fetch that URL — proceeding with the URL as context.')
          }
        }

        ctx.session.jd = jd
        ctx.session.step = 'processing'
        await ctx.reply('Analysing fit... ⏳')

        try {
          await processApplication(ctx)
        } catch (err) {
          clearFlow(ctx)
          const msg = err instanceof Error ? err.message : String(err)
          await ctx.reply(`Failed:\n${msg}\n\nUse /apply to try again.`)
        }
        return
      }

      if (ctx.session.step === 'awaiting_context') {
        if (text.toLowerCase() !== 'skip') {
          ctx.session.additionalContext = text
        }
        ctx.session.contextGathered = true
        ctx.session.step = 'processing'
        await ctx.reply('Building your application... ⏳ (15–30s)')
        try {
          await processApplication(ctx)
        } catch (err) {
          clearFlow(ctx)
          const msg = err instanceof Error ? err.message : String(err)
          await ctx.reply(`Failed:\n${msg}\n\nUse /apply to try again.`)
        }
        return
      }

      if (ctx.session.step === 'awaiting_confirm') {
        const upper = text.toUpperCase()

        if (upper === 'YES') {
          await ctx.reply('Sending...')
          try {
            const cfg = getUserConfig()
            await sendApplication({
              to: ctx.session.toEmail!,
              role: ctx.session.role!,
              company: ctx.session.company!,
              coverLetter: ctx.session.pendingCoverLetter!,
              resumePath: ctx.session.pendingResumePath!,
              portfolioUrl: cfg.portfolioUrl,
            })
            const [record] = await db
              .insert(applications)
              .values({
                role: ctx.session.role!,
                company: ctx.session.company!,
                toEmail: ctx.session.toEmail!,
                resumePath: ctx.session.pendingResumePath,
                coverLetter: ctx.session.pendingCoverLetter,
                providerUsed: ctx.session.providerUsed,
              })
              .returning()
            clearFlow(ctx)
            return ctx.reply(
              `Application sent ✓ — tracked as *#${record!.id}*\n\nView dashboard: http://localhost:${config.dashboardPort}`,
              { parse_mode: 'Markdown' }
            )
          } catch (err) {
            clearFlow(ctx)
            const msg = err instanceof Error ? err.message : String(err)
            return ctx.reply(`Failed to send email:\n${msg}`)
          }
        }

        if (upper === 'NO') {
          clearFlow(ctx)
          return ctx.reply('Cancelled. Use /apply to start a new application.')
        }

        const useMatch = text.match(/^use\s+(\d+)$/i)
        if (useMatch) {
          const n = parseInt(useMatch[1])
          const recent = await getRecentResumes(5)
          const valid = recent.filter(r => r.resumePath && existsSync(r.resumePath))
          const picked = valid[n - 1]
          if (!picked) return ctx.reply(`No resume #${n} in the list. Check the numbers above.`)
          ctx.session.pendingResumePath = picked.resumePath!
          return ctx.reply(
            `Swapped in resume from *${picked.role}* @ ${picked.company} ✓\n\nReply *YES* to send or keep making changes.`,
            { parse_mode: 'Markdown' }
          )
        }

        const { target, note } = parseRevision(text)
        // If the user uploaded a manual DOCX, unqualified text should only revise
        // the cover letter — not re-run the optimizer and lose their upload.
        const effectiveTarget: RevisionTarget =
          target === 'both' && ctx.session.resumeManuallyUploaded ? 'cover-letter' : target
        const targetLabel = effectiveTarget === 'resume' ? 'resume' : effectiveTarget === 'cover-letter' ? 'cover letter' : 'both'
        await ctx.reply(`Revising ${targetLabel}... ⏳`)
        try {
          const cfg = getUserConfig()
          await runAIAndSendPreview(ctx, cfg.portfolioUrl, note, effectiveTarget)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return ctx.reply(`Revision failed:\n${msg}`)
        }
      }
    }
  })

  // ── Document uploads ─────────────────────────────────────────────────────────

  bot.on('message:document', async ctx => {
    // Store chat ID
    if (ctx.chat?.id) {
      const cfg = getUserConfig()
      if (cfg.chatId !== ctx.chat.id) setUserConfig({ chatId: ctx.chat.id })
    }

    // Setup flow — receive base resume
    if (ctx.session.flow === 'setup' && ctx.session.step === 'awaiting_resume') {
      const doc = ctx.message.document
      const ext = path.extname(doc.file_name ?? '').toLowerCase()
      if (!['.pdf', '.docx'].includes(ext)) return ctx.reply('Please send a PDF or DOCX file.')

      await ctx.reply('Downloading resume...')
      const file = await ctx.getFile()
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`
      let buf: Buffer
      try {
        buf = await downloadWithRetry(fileUrl)
      } catch {
        return ctx.reply('Download failed (network error). Please try sending the file again.')
      }
      const savePath = path.join(config.uploadsDir, `resume_upload_${Date.now()}${ext}`)
      writeFileSync(savePath, buf)

      ctx.session.pendingSetupPath = savePath
      ctx.session.step = 'awaiting_variant_label'

      // Extract and persist cert links from this DOCX so they survive across all future applications
      if (ext === '.docx') {
        const links = await extractLinks(savePath)
        if (Object.keys(links).length > 0) {
          const existing = getUserConfig().certLinks ?? {}
          setUserConfig({ certLinks: { ...existing, ...links } })
          console.log('[setup] cert links saved:', Object.keys(links))
        }
      }

      const cfg = getUserConfig()
      const variants = cfg.variants ?? []
      const existingNote = variants.length > 0
        ? `Existing variants: ${variants.map(v => v.label).join(', ')}\n\n`
        : ''

      return ctx.reply(
        `Resume downloaded ✓\n\n${existingNote}Label for this variant? (e.g. frontend, backend, fullstack)\n\n_Type "default" to replace your main resume._`,
        { parse_mode: 'Markdown' }
      )
    }

    // Apply flow — accept edited DOCX (resume) or TXT (cover letter)
    if (ctx.session.flow === 'apply' && ctx.session.step === 'awaiting_confirm') {
      const doc = ctx.message.document
      const ext = path.extname(doc.file_name ?? '').toLowerCase()

      if (ext !== '.docx' && ext !== '.txt') {
        return ctx.reply('Upload a DOCX to replace the resume, or a TXT to replace the cover letter.')
      }

      const file = await ctx.getFile()
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`
      let buf: Buffer
      try {
        buf = await downloadWithRetry(fileUrl)
      } catch {
        return ctx.reply('Download failed (network error). Please try sending the file again.')
      }
      const slug = toKebabCase(config.fromName)

      if (ext === '.docx') {
        const savePath = path.join(config.uploadsDir, `${slug}-edited.docx`)
        writeFileSync(savePath, buf)
        ctx.session.pendingResumePath = savePath
        ctx.session.resumeManuallyUploaded = true
        return ctx.reply(
          'Resume replaced with your edited version ✓\n\n' +
          'Reply *YES* to send, upload a TXT to replace the cover letter, or type a note to revise the cover letter.',
          { parse_mode: 'Markdown' }
        )
      }

      if (ext === '.txt') {
        ctx.session.pendingCoverLetter = buf.toString('utf-8').trim()
        return ctx.reply(
          'Cover letter replaced with your edited version ✓\n\nReply *YES* to send or keep making changes.',
          { parse_mode: 'Markdown' }
        )
      }
    }
  })

  bot.catch(err => {
    console.error('[bot]', err.message, err.error)
  })

  return bot
}
