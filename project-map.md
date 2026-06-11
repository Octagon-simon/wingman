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
| Bot | grammY | In-memory session state machine. NOT @grammyjs/conversations. `client: { timeoutSeconds: 35 }` to avoid silent hangs on network failure |
| AI | Gemini → DeepSeek → Claude | Cascade: tries cheapest first, falls back automatically |
| Resume parsing | mammoth (DOCX), pdf-parse (PDF) | pdf-parse loaded with `require()` to avoid module init issues; mammoth also used for hyperlink extraction |
| Resume generation | `docx` npm package | Manual `•` bullets with indent; `PT()` for font sizes; `SP()` for paragraph spacing/indent; tab stops for right-aligned dates; `ExternalHyperlink` for cert URLs |
| Page check | LibreOffice (`soffice`) + heuristic fallback | `page-check.ts` — converts DOCX to PDF and counts pages; falls back to content-height estimate when soffice is unavailable |
| Email | nodemailer | `connectionTimeout`/`socketTimeout`, `verify()` called before send |
| Database | better-sqlite3 + drizzle-orm | SQLite, WAL mode, raw SQL migrations (no migration tool) |
| Dashboard | Hono + @hono/node-server + htmx | Server-rendered HTML, manual Refresh button, HTTP Basic Auth |
| Container | Docker (node:20-slim) | build tools for better-sqlite3 native compilation |

---

## Source File Tree

```
src/
├── index.ts                 Entry point — dns.setDefaultResultOrder('ipv4first'), starts dashboard, bot, scheduler
├── config.ts                Env var validation; creates data/ and uploads/ dirs
├── user-config.ts           Persists resume variants + portfolio URL + chatId + certLinks
├── scheduler.ts             Daily check for follow-ups; notifies via Telegram
│
├── ai/
│   ├── providers.ts         generate(prompt, system) — Gemini → DeepSeek → Claude
│   ├── optimizer.ts         optimizeResume() — ATS-tailored resume as structured JSON; handles empty JD
│   ├── cover-letter.ts      generateCoverLetter() — human-tone cover letter; handles empty JD
│   ├── gap-analyzer.ts      analyzeGaps() — flags hard technical skills missing from resume; skipped when no JD
│   ├── job-extractor.ts     extractJobDetails() — parses job posting HTML into struct
│   └── follow-up.ts         generateFollowUp() — brief follow-up email body
│
├── resume/
│   ├── parser.ts            parseResume(filePath) — DOCX or PDF to plain text; extractLinks() — hyperlinks from DOCX
│   ├── generator.ts         generateResumeDocx(resume, filename, certLinks?) — creates .docx; findCertUrl() for cert hyperlinks
│   └── page-check.ts        countDocxPages(docxPath, resume?) — soffice accurate count or heuristic fallback
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

On upload: `pendingSetupPath` stored in session; `extractLinks(savePath)` called and cert links saved to `UserConfig.certLinks`.

On label entry: `addVariant(label, path, makeDefault)` is called and `pendingSetupPath` cleared.

First variant is always default. Subsequent variants keep the existing default unless label is "default".

---

### /portfolio command

```
/portfolio          → shows current URL (or "not set")
/portfolio <url>    → updates portfolioUrl in UserConfig
/portfolio clear    → removes portfolioUrl
```

Does not restart the setup flow — updates the single `portfolioUrl` field directly.

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
                                        ├─ "none/no/n/a/na/skip/-" → jd = '' → processing
                                        └─ text or URL → jd = text → processing
                                              └─ processApplication → runAIAndSendPreview
                                                   └─ awaiting_confirm
                                                        ├─ YES            → sendApplication → db.insert → done
                                                        ├─ NO             → cancel
                                                        ├─ "use N"        → swap pendingResumePath
                                                        ├─ "resume:"      → runAI(resume only)
                                                        ├─ "cover letter:" → runAI(CL only)
                                                        ├─ other text     → runAI(both) — but if resumeManuallyUploaded, runAI(CL only)
                                                        ├─ DOCX upload    → replace pendingResumePath; set resumeManuallyUploaded = true
                                                        └─ TXT upload     → replace pendingCoverLetter
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

1. User runs `/apply`, enters role/company/email/jd (or pastes URL for auto-fill; or types "none" to skip JD)
2. `processApplication(ctx)` — reads selected variant path from session, calls `parseResume`; runs gap analysis if JD is non-empty
3. `runAIAndSendPreview(ctx, portfolioUrl)`:
   - `optimizeResume(text, jd, role)` → `OptimizedResume` + `keywordsAdded[]`
   - `generateResumeDocx(resume, filename, certLinks)` → `.docx` file in uploads/
   - `countDocxPages(path, resume)` — if >1 page, retries with a 10-word bullet constraint
   - `generateCoverLetter(text, jd, role, company)` → cover letter text + `.txt` in uploads/
   - Sends: summary card, `.txt` file, `.docx` file, options message
4. User replies YES → `sendApplication()` with SMTP + resume attachment
5. `db.insert(applications)` — tracked with providerUsed, coverLetter, resumePath

### Revision loop (in awaiting_confirm)

- Text triggers `runAIAndSendPreview(ctx, portfolioUrl, note, target)` where target is `'resume' | 'cover-letter' | 'both'`
- If `resumeManuallyUploaded = true` and target would be `'both'`, it is silently downgraded to `'cover-letter'` — preserves the user's edited DOCX
- After AI generates a new resume, `resumeManuallyUploaded` is reset to `false`
- Resume is always sent in the preview, even on cover-letter-only revisions (captioned "Resume (unchanged)")
- Session stays at `awaiting_confirm` throughout

### Cert link enrichment

1. At `/setup`: `extractLinks(docxPath)` scans DOCX hyperlinks via mammoth HTML conversion
2. Extracted links stored as `certLinks: Record<string, string>` in `UserConfig` (key = anchor text, value = URL)
3. At resume generation: `generateResumeDocx(..., certLinks)` calls `findCertUrl(certName, certLinks)` for each cert — case-insensitive substring match — and attaches the URL as an `ExternalHyperlink` in the DOCX

### Follow-up scheduler

1. `startScheduler(bot)` called in `index.ts` immediately after bot is created
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
  "chatId": 123456789,
  "certLinks": {
    "AWS Certified Developer": "https://aws.amazon.com/verification/...",
    "Meta Front-End Developer": "https://coursera.org/verify/..."
  }
}
```

**Backward compat**: if old config has `resumePath` (single-resume format), `getUserConfig()` migrates it to `variants: [{ label: 'default', path: resumePath }]` on first read and rewrites the file.

`chatId` is stored the first time any message is received, enabling the scheduler to send proactive notifications.

`certLinks` is populated by `extractLinks()` during `/setup` and used by `findCertUrl()` in `generator.ts` to attach hyperlinks to certificates without relying on the AI to remember them.

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

## Resume Generation (`src/resume/generator.ts`)

### Unit helpers

```typescript
const PT = (pt: number) => pt * 2    // font sizes: docx uses half-points
const SP = (pt: number) => pt * 20   // spacing/indent: docx uses twips (1/20 pt)
```

PT() is correct for `size:` fields. SP() is required for `spacing.before/after` and `indent.left/hanging` — using PT() there gives values 10× too small.

### Layout constants

- `RIGHT_MARGIN = 9900` twips — right-aligned tab stop for dates
- Section headers: `before: SP(12), after: SP(4)` — every section boundary = 4+12 = 16pt gap
- Page margins: top/bottom 720 twips (0.5"), left/right 864 twips (0.6")

### Key functions

| Function | Description |
|---|---|
| `sectionHeader(text)` | Bold uppercase text + bottom border; consistent 16pt gap before every section |
| `skillLines(skills[])` | One paragraph per skill category; bold "Category:" label + plain items; tight 1pt spacing between lines, 4pt after last |
| `bulletPoint(text)` | Manual `•` + indent `left: SP(18), hanging: SP(14)`; no docx list engine |
| `certificatesBlock(certs[])` | Certs separated by ` | `; cert with URL becomes `ExternalHyperlink` with underline |
| `findCertUrl(name, links)` | Case-insensitive substring match against stored cert links |
| `generateResumeDocx(resume, filename, certLinks?)` | Assembles all blocks, enriches cert URLs, writes .docx to uploads/ |

---

## Optimizer Prompt Design (`src/ai/optimizer.ts`)

### Experience rules
- Include ONLY 2-3 entries most relevant to the target role
- 5 bullets for the single best-matching entry; 4 bullets for all others
- Bullets: 15-20 words, `verb → method/technology → quantified result`
- Sort most recent to oldest (by end year)
- Dates: 4-digit end year only (e.g. "2024"); current roles use current year

### Summary rules
- 2-3 sentences written like the candidate is describing themselves to a peer
- One specific achievement with a real number worked in naturally
- Names the target role
- No career-speak, no dashes, no CV-template phrases

### Skills format
- `["Languages: JS, TS", "Frameworks: React, Node.js", ...]` — 3-5 categories
- Rendered by `skillLines()` with bold category label per line

### Banned everywhere
- leveraged, utilized, spearheaded, orchestrated, streamlined
- cutting-edge, innovative, dynamic, passionate
- responsible for, tasked with, assisted with
- various, multiple, numerous (use real numbers)
- Em/en dashes as separators in prose

### Empty JD path
When `jobDescription` is empty, the optimizer receives an explicit instruction not to guess company details and to optimize based on role title + candidate experience only.

---

## Cover Letter Prompt Design (`src/ai/cover-letter.ts`)

- Opens with company's work or a challenge (not "I") — or a concrete fact from the applicant's experience when no JD exists
- 3 paragraphs max; real numbers and outcomes in the middle paragraph
- Portfolio URL written inline as a bare URL in the closing paragraph (not "at the top of this letter")
- Same banned words/phrases as optimizer, plus: "I am writing to express", "passionate about", "make a difference", "Furthermore", "Moreover", template-sounding openers
- Uses contractions; mixes sentence lengths
- Empty JD path: explicit "do not guess company details from name or email domain" instruction

---

## Gap Analyzer (`src/ai/gap-analyzer.ts`)

- Compares resume against JD and identifies hard technical skills explicitly required that are absent
- Never flags soft skills, generic requirements, or inferred needs
- `hasSignificantGaps` is true only when 2+ specific hard-skill gaps are found
- Skipped entirely when `jd` is empty (bot sets `jd = ''` when user types "none")

---

## Page Overflow Detection (`src/resume/page-check.ts`)

```
countDocxPages(docxPath, resume?)
  ├─ soffice available? → convert DOCX to PDF → pdf-parse numpages (accurate)
  └─ fallback → estimatePageCount(resume) — content-height heuristic
```

The heuristic sums estimated heights of all rendered elements (name, headline, contact, skills, summary, experience, certs, education) in points and compares against a 690pt usable page limit. Not pixel-perfect but reliably catches overflow of a full paragraph or more.

On overflow: bot retries `optimizeResume` with an injected note asking for 10-word max bullets.

---

## File Naming

**Storage filename**: `${slug}-${Date.now()}.docx` (e.g. `simon-ugorji-1716000000000.docx`)
- Timestamped to avoid collisions in uploads/

**Telegram display name**: `new InputFile(storagePath, `${displayName}.docx`)` (e.g. `simon_ugorji.docx`)
- Clean name shown to user in Telegram

**Email attachment**: same as display name (derived from `config.fromName`)

---

## Network Resilience (`src/index.ts`, `src/bot/index.ts`)

- `dns.setDefaultResultOrder('ipv4first')` — called before any imports; fixes ETIMEDOUT on networks where IPv6 is broken (Node's undici tries AAAA records first)
- `client: { timeoutSeconds: 35 }` on Bot constructor — 5s buffer over the 30s long-poll timeout; default 500s caused silent hangs on network failure
- `downloadWithRetry(url, attempts=3)` — 30s timeout per attempt, 2s/4s backoff; used for all Telegram file downloads

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

4. **SP() and PT() helpers in generator.ts** — docx uses half-points for font sizes (`size:`) and twips (1/20pt) for spacing/indent. Using the same multiplier for both was a silent bug (spacing 10× too small). Two named helpers make the unit explicit at every call site.

5. **`transporter.verify()` before sendMail** — fails fast with a descriptive error if SMTP credentials are wrong or server is unreachable.

6. **Timestamped storage filenames, clean display filenames** — separates uniqueness concern (storage) from presentation concern (Telegram + email). `InputFile(storagePath, displayName)` is grammY's API for this.

7. **Manual Refresh on dashboard** — auto-polling (`hx-trigger="every 60s"`) interrupted the status dropdown while the user was interacting with it.

8. **`authMiddleware()` is a no-op when DASHBOARD_TOKEN is unset** — zero friction for local use; set the token for online deployment without changing code.

9. **`sanitizeHtml()` strips tags before passing to AI** — reduces token count, avoids leaking script/style noise into the AI context.

10. **`parseRevision(text)`** — detects `resume: <note>` or `cover letter: <note>` prefixes to target revisions, so the user doesn't need new commands.

11. **`processApplication(ctx)`** — extracted helper so the processing step can be triggered from multiple paths (normal JD entry, post-scrape confirm, post-variant selection) without duplicating the try/catch and loading logic.

12. **Cover letter perspective enforcement** — system prompt explicitly states "I/my = APPLICANT, you/your = HIRING COMPANY" to prevent the common AI mistake of attributing the applicant's employers to the reader.

13. **`resumeManuallyUploaded` flag** — when the user uploads an edited DOCX, subsequent free-text revisions are downgraded from `'both'` to `'cover-letter'` so the optimizer doesn't overwrite their manual edits. Reset to `false` when AI next generates a resume.

14. **Cert links extracted at setup, not at generation time** — AI matching of cert names to URLs is unreliable. Extracting hyperlinks from the DOCX via mammoth at setup time and doing a substring match at generation time is deterministic and doesn't depend on the AI remembering URLs.

15. **`dns.setDefaultResultOrder('ipv4first')` before all imports** — on networks where IPv6 is broken, Node's undici tries AAAA records first and hangs. This call must come before any import that could trigger DNS resolution (e.g. the grammY Bot constructor).

16. **Two-pass page overflow** — first pass generates the resume normally; if it overflows, a second pass injects a hard constraint ("10 words max per bullet"). Checking page count with LibreOffice is accurate; the heuristic fallback is conservative enough to catch clear overflows when soffice isn't available.

17. **`keywordsAdded ?? []` guard** — the AI sometimes omits `keywordsAdded` from its JSON response. Without the guard, `keywords = undefined` and `keywords.length` throws at preview time. The `[]` fallback is safe since keywords are displayed but not critical.
