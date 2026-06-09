# Project Map — wingman

Reference document for AI-assisted development sessions. Describes every file, data flow, state machine, and design decision.

---

## Purpose

AI-powered Telegram bot that automates job applications. The user sends a job URL or role name; the bot parses a stored resume, tailors it for ATS, generates a cover letter, and emails the application — all without leaving Telegram. Applications are tracked in a local SQLite database and visible in a web dashboard.

---

## Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 20 + TypeScript | `tsx` for no-compile execution; `tsc --noEmit` in `dev` script catches type errors |
| Bot | grammY | In-memory session state machine. NOT @grammyjs/conversations |
| AI | Gemini → DeepSeek → Claude | Cascade: tries cheapest first, falls back automatically |
| Resume parsing | mammoth (DOCX), pdf-parse (PDF) | pdf-parse loaded with `require()` to avoid module init issues |
| Resume generation | `docx` npm package | Manual `•` bullets with indent, PT() helper for sizing, tab stops for right-aligned dates |
| Email | nodemailer | `connectionTimeout`/`socketTimeout`, `verify()` called before send |
| Database | better-sqlite3 + drizzle-orm | SQLite, WAL mode, raw SQL migrations (no migration tool) |
| Dashboard | Hono + @hono/node-server + htmx | Server-rendered HTML, manual Refresh button, HTTP Basic Auth |
| Container | Docker (node:20-slim) | build tools for better-sqlite3 native compilation |

---

## Source File Tree

```
src/
├── index.ts                 Entry point — starts dashboard, bot, scheduler
├── config.ts                Env var validation; creates data/ and uploads/ dirs
├── user-config.ts           Persists resume variants + portfolio URL + chatId
├── scheduler.ts             Daily check for follow-ups; notifies via Telegram
│
├── ai/
│   ├── providers.ts         generate(prompt, system) — Gemini → DeepSeek → Claude
│   ├── optimizer.ts         optimizeResume() — ATS-tailored resume as structured JSON
│   ├── cover-letter.ts      generateCoverLetter() — professional cover letter text
│   ├── job-extractor.ts     extractJobDetails() — parses job posting HTML into struct
│   └── follow-up.ts         generateFollowUp() — brief follow-up email body
│
├── resume/
│   ├── parser.ts            parseResume(filePath) — DOCX or PDF to plain text
│   └── generator.ts         generateResumeDocx(resume, filename) — creates .docx file
│
├── email/
│   └── sender.ts            sendApplication() + sendFollowUp() via SMTP/nodemailer
│
├── db/
│   ├── schema.ts            Drizzle schema for `applications` table
│   └── index.ts             Opens SQLite, runs migrations, exports `db`
│
├── bot/
│   └── index.ts             All bot commands + state machine (see diagram below)
│
└── dashboard/
    └── server.ts            Hono app — dark header, stat cards, application table
```

---

## Bot State Machine

### /setup flow

```
/setup
  └─ awaiting_resume (upload PDF or DOCX)
       └─ awaiting_variant_label (type label: "frontend", "backend", etc.)
            └─ awaiting_portfolio (type URL or "skip")
                 └─ done
```

On each upload, `pendingSetupPath` is stored in session. On label entry, `addVariant(label, path, makeDefault)` is called and `pendingSetupPath` cleared.

First variant is always default. Subsequent variants keep the existing default unless label is "default".

---

### /apply flow

```
/apply
  └─ awaiting_role
       ├─ URL pasted? → scrape → extractJobDetails → awaiting_scrape_confirm
       │    ├─ YES → (check email) → (check variants) → processing
       │    └─ NO  → awaiting_role (manual mode)
       │
       └─ text? → awaiting_company → awaiting_email
                       └─ awaiting_email
                            ├─ 2+ variants? → awaiting_variant
                            │    ├─ jd already set? → processing
                            │    └─ else → awaiting_jd
                            │
                            ├─ jd already set (from scraper)? → processing
                            └─ else → awaiting_jd
                                        └─ processing (calls processApplication)
                                              └─ awaiting_confirm
                                                   ├─ YES        → sendApplication → db.insert → done
                                                   ├─ NO         → cancel
                                                   ├─ "use N"    → swap pendingResumePath
                                                   ├─ "resume:"  → runAI(resume only)
                                                   ├─ "cover letter:" → runAI(CL only)
                                                   ├─ other text → runAI(both)
                                                   ├─ DOCX upload → replace pendingResumePath
                                                   └─ TXT upload  → replace pendingCoverLetter
```

---

### /followup <id>

```
/followup <id>
  └─ db.select(application)
       └─ generateFollowUp(role, company, originalCL, fromName, daysAgo)
            └─ sendFollowUp(to, role, company, body)   // no resume attachment
                 └─ db.update(followUpSentAt)
```

---

## Data Flows

### Application send

1. User runs `/apply`, enters role/company/email/jd (or pastes URL for auto-fill)
2. `processApplication(ctx)` — reads selected variant path from session, calls `parseResume`
3. `runAIAndSendPreview(ctx, portfolioUrl)`:
   - `optimizeResume(text, jd, role)` → `OptimizedResume` + `keywordsAdded[]`
   - `generateResumeDocx(resume, filename)` → `.docx` file in uploads/
   - `generateCoverLetter(text, jd, role, company)` → cover letter text + `.txt` in uploads/
   - Sends: summary card, `.txt` file, `.docx` file, options message
4. User replies YES → `sendApplication()` with SMTP + resume attachment
5. `db.insert(applications)` — tracked with providerUsed, coverLetter, resumePath

### Revision loop (in awaiting_confirm)

- Text triggers `runAIAndSendPreview(ctx, portfolioUrl, note, target)` where target is 'resume' | 'cover-letter' | 'both'
- Only the targeted component is re-run; the other keeps its session value
- Session stays at 'awaiting_confirm' throughout

### Follow-up scheduler

1. `startScheduler(bot)` is called in `index.ts` immediately after bot is created
2. On startup and every 24 hours: queries DB for `status='sent' AND created_at < (now - 7 days) AND follow_up_sent_at IS NULL`
3. For each found application, sends Telegram message with `/followup <id>` link
4. User runs `/followup <id>` → AI generates follow-up → SMTP send → `followUpSentAt` marked

---

## Database Schema

Table: `applications`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| role | TEXT | job title |
| company | TEXT | company name |
| to_email | TEXT | recipient |
| status | TEXT | sent / interviewing / offer / rejected |
| resume_path | TEXT | absolute path to .docx in uploads/ |
| cover_letter | TEXT | full text (stored for follow-up context) |
| provider_used | TEXT | e.g. "gemini (resume) · gemini (cover letter)" |
| follow_up_sent_at | INTEGER | unix timestamp, null = not yet sent |
| created_at | INTEGER | unix timestamp (default unixepoch()) |

Migration: `ALTER TABLE applications ADD COLUMN follow_up_sent_at INTEGER` runs on every startup inside a try/catch (safe to repeat).

---

## User Config (`data/user_config.json`)

```json
{
  "variants": [
    { "label": "frontend", "path": "uploads/resume_upload_1716000000000.docx" },
    { "label": "backend",  "path": "uploads/resume_upload_1716000001000.pdf" }
  ],
  "defaultVariant": "frontend",
  "portfolioUrl": "https://simon.dev",
  "chatId": 123456789
}
```

**Backward compat**: if old config has `resumePath` (single-resume format), `getUserConfig()` migrates it to `variants: [{ label: 'default', path: resumePath }]` on first read and rewrites the file.

`chatId` is stored the first time any message is received, enabling the scheduler to send proactive notifications.

---

## AI Cascade (`src/ai/providers.ts`)

```
generate(prompt, system)
  → try Gemini (gemini-2.0-flash)
  → try DeepSeek (deepseek-chat, OpenAI-compatible SDK with custom baseURL)
  → try Claude (claude-sonnet-4-6)
  → throw if all fail
```

Providers are skipped if their API key is not set. Each failure is logged with `console.warn`. Returns `{ text, provider }`.

---

## File Naming

**Storage filename**: `${slug}-${Date.now()}.docx` (e.g. `simon-ugorji-1716000000000.docx`)
- Timestamped to avoid collisions in uploads/

**Telegram display name**: `new InputFile(storagePath, `${displayName}.docx`)` (e.g. `simon_ugorji.docx`)
- Clean name shown to user in Telegram

**Email attachment**: same as display name (derived from `config.fromName`)

---

## Dashboard (`src/dashboard/server.ts`)

- Routes: `GET /` (full page), `GET /apps/rows` (partial for refresh), `PATCH /apps/:id/status`
- Style: dark header (`#0f172a`), light gray bg (`#f1f5f9`), stat cards, styled status pills
- Status pill colors use CSS custom properties `--sbg / --sc / --sd` updated by client JS (`syncStatus`) for instant visual feedback before htmx response
- Manual Refresh button (`hx-get="/apps/rows"`) — was auto-polling but that interrupted status dropdowns
- `authMiddleware()` — no-op if `DASHBOARD_TOKEN` unset; HTTP Basic Auth (any username + token as password) if set

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| TELEGRAM_BOT_TOKEN | Yes | | From @BotFather |
| GEMINI_API_KEY | One AI key required | | Primary AI |
| GEMINI_MODEL | No | gemini-2.0-flash | |
| DEEPSEEK_API_KEY | One AI key required | | Secondary AI |
| DEEPSEEK_MODEL | No | deepseek-chat | |
| ANTHROPIC_API_KEY | One AI key required | | Tertiary AI |
| CLAUDE_MODEL | No | claude-sonnet-4-6 | |
| SMTP_HOST | Yes | | e.g. smtp.gmail.com |
| SMTP_PORT | Yes | | 587 (TLS) or 465 (SSL) |
| SMTP_USER | Yes | | Gmail address |
| SMTP_PASS | Yes | | Gmail App Password |
| FROM_EMAIL | Yes | | Sender address |
| FROM_NAME | Yes | | Full name (used in filenames and signatures) |
| DASHBOARD_PORT | No | 3000 | |
| DATA_DIR | No | ./data | SQLite + user_config.json |
| UPLOADS_DIR | No | ./uploads | Resume + cover letter files |
| DASHBOARD_TOKEN | No | (blank = no auth) | HTTP Basic Auth password for dashboard |

---

## Key Design Decisions

1. **grammY sessions over @grammyjs/conversations** — in-memory state machine is simpler and more predictable; no conversation persistence needed since apply sessions are short-lived.

2. **tsx over ts-node** — faster startup, no compile step. `tsc --noEmit` is run as a pre-check in the `dev` npm script to catch type errors (tsx itself does not type-check).

3. **Manual bullet points (•) over docx bullet engine** — Word's internal list engine is inconsistent across PDF renderers and versions. Manual `•` char + `indent: { left, hanging }` gives clean, predictable output everywhere.

4. **PT() helper in generator.ts** — docx package uses half-points (2 × pt). `PT(n) = n * 2` makes all size values readable as their point equivalent.

5. **`transporter.verify()` before sendMail** — fails fast with a descriptive error if SMTP credentials are wrong or server is unreachable. Without it, `sendMail` would hang or fail with a cryptic timeout.

6. **Timestamped storage filenames, clean display filenames** — separates uniqueness concern (storage) from presentation concern (Telegram + email). `InputFile(storagePath, displayName)` is grammY's API for this.

7. **Manual Refresh on dashboard** — auto-polling (`hx-trigger="every 60s"`) interrupted the status dropdown while the user was interacting with it. Replaced with a single manual Refresh button.

8. **`authMiddleware()` is a no-op when DASHBOARD_TOKEN is unset** — zero friction for local use; set the token for online deployment without changing code.

9. **`sanitizeHtml()` strips tags before passing to AI** — reduces token count, avoids leaking script/style noise into the AI context, makes job descriptions cleaner for optimization prompts.

10. **`parseRevision(text)`** — detects `resume: <note>` or `cover letter: <note>` prefixes to target revisions, so the user doesn't need new commands.

11. **`processApplication(ctx)`** — extracted helper so the processing step can be triggered from multiple paths (normal JD entry, post-scrape confirm, post-variant selection) without duplicating the try/catch and loading logic.

12. **Cover letter perspective enforcement** — AI system prompt explicitly states "I/my = APPLICANT, you/your = HIRING COMPANY" to prevent the common AI mistake of attributing the applicant's employers to the reader.
