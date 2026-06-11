# wingman

An AI-powered Telegram bot that automates job applications. Paste a job URL or describe the role — the bot tailors your resume for ATS, writes a cover letter, and emails the application. Everything runs locally via Docker.

## Features

- **Job URL scraping** — paste a job posting URL; role, company, and job description are extracted automatically
- **AI resume optimization** — resume rewritten per-job for ATS keyword alignment; categorized skills section; 2-3 most relevant experience entries only
- **AI cover letter** — human-sounding cover letter; banned AI phrases enforced; portfolio URL included inline
- **Gap analysis** — flags hard technical skills explicitly required by the JD that are missing from your resume; soft skills and generic requirements are ignored
- **No JD mode** — type "none" when asked for the job description; the bot crafts the application from the role title and your experience without guessing company details
- **Multi-resume variants** — store separate base resumes (frontend, backend, fullstack, etc.) and pick per application
- **Cert link persistence** — hyperlinks extracted from your DOCX at setup time and automatically applied to certificates in every generated resume
- **Page overflow detection** — uses LibreOffice if available, falls back to a layout heuristic; retries with shorter bullets if the resume spills onto page 2
- **Revision loop** — refine the resume or cover letter through natural language before sending; uploading an edited DOCX or TXT replaces just that document
- **Follow-up scheduler** — get notified 7 days after applying; send a polished follow-up with one command
- **AI provider cascade** — Gemini → DeepSeek → Claude (cheap-first, automatic fallback)
- **Web dashboard** — track all applications, update status (interviewing / offer / rejected)
- **Runs locally** — Docker Compose, no cloud accounts required; fully open source

---

## Requirements

- Docker + Docker Compose
- A Telegram account ([create a bot via @BotFather](https://t.me/BotFather))
- At least one AI API key — [Gemini free tier](https://aistudio.google.com/app/apikey) is recommended
- Gmail App Password ([set one up here](https://myaccount.google.com/apppasswords)) or other SMTP credentials

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/yourname/wingman.git
cd wingman
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your values — see [Configuration](#configuration) for all options. At minimum:
- `TELEGRAM_BOT_TOKEN` — from @BotFather (`/newbot`)
- `GEMINI_API_KEY` — from Google AI Studio (free)
- `SMTP_USER`, `SMTP_PASS` — Gmail address + App Password
- `FROM_EMAIL`, `FROM_NAME` — your email and full name

### 3. Start

```bash
docker compose up -d
```

### 4. Set up your resume

Message your bot on Telegram and run `/setup` to upload your resume.

### 5. Apply

Run `/apply`, paste a job URL or type the role name, and let the bot do the rest.

---

## Telegram Commands

| Command | Description |
|---|---|
| `/setup` | Upload a resume variant and set your portfolio URL |
| `/portfolio` | View, update, or clear your portfolio URL without re-running setup |
| `/apply` | Start a new application |
| `/status` | View your last 10 applications with status |
| `/followup <id>` | Send a follow-up email for application #id |
| `/cancel` | Cancel the current flow |
| `/help` | Show this command list |

### At the review step (after AI generates your documents)

| Reply | Action |
|---|---|
| `YES` | Send the application |
| `NO` | Cancel |
| `resume: <note>` | Revise only the resume |
| `cover letter: <note>` | Revise only the cover letter |
| Any other text | Revise both documents |
| `use 1`, `use 2` … | Swap in a previously generated resume |
| Upload a `.docx` | Replace the resume with your edited file |
| Upload a `.txt` | Replace the cover letter with your edited file |

After uploading a DOCX, further free-text revisions will only touch the cover letter — the bot won't re-run the optimizer and lose your edits.

---

## Multi-resume Variants

Store separate resume versions for different types of roles:

```
/setup → upload "Frontend Dev" resume → label it "frontend"
/setup → upload "Fullstack" resume   → label it "fullstack"
```

When you run `/apply` with more than one variant stored, you will be asked which one to use. Label a variant "default" to make it the primary.

---

## Job URL Scraping

Instead of manually entering role, company, and pasting a job description, just paste the URL when prompted for the role:

```
/apply
Bot: Paste a job URL or type the role name
You: https://jobs.company.com/senior-frontend-engineer
Bot: Found — Senior Frontend Engineer at Stripe | Preview: ...
     Reply YES to proceed or NO to enter manually.
```

If the application email isn't found in the posting, you will be asked for it separately.

---

## No Job Description

If you don't have a job description — or the role has none — type `none`, `n/a`, or `skip` when asked:

```
Bot: Paste the job description (or a URL), or type "none" to skip
You: none
Bot: Got it — will craft the application from the role and your experience.
```

The bot writes the cover letter and optimizes the resume based on the target role title and your actual experience. It will not guess what the company does from its name or email domain.

---

## Follow-up Scheduler

The bot checks daily for applications that were sent 7+ days ago with no status change. When it finds one, it sends you a Telegram notification:

```
📬 Senior Frontend Engineer at Stripe — sent 8 days ago with no reply.
Send a follow-up? /followup 42
```

Running `/followup 42` generates a short, professional follow-up email and sends it immediately (no resume attached — follow-ups are brief by design).

---

## Web Dashboard

Visit `http://localhost:3000` after starting the bot.

- View all applications with role, company, date, and status
- Update status (Sent → Interviewing → Offer / Rejected) inline
- Click Refresh to reload the application list

---

## Configuration

All options are in `.env`. See `.env.example` for the full list.

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `GEMINI_API_KEY` | One AI key required | Primary AI provider (recommended) |
| `DEEPSEEK_API_KEY` | | Secondary AI provider |
| `ANTHROPIC_API_KEY` | | Tertiary AI provider |
| `SMTP_HOST` | Yes | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | Yes | `587` (TLS) or `465` (SSL) |
| `SMTP_USER` | Yes | Your email address |
| `SMTP_PASS` | Yes | App password — **not** your regular password |
| `FROM_EMAIL` | Yes | Sender email (usually same as SMTP_USER) |
| `FROM_NAME` | Yes | Your full name (used in filenames and email signature) |
| `DASHBOARD_PORT` | No | Dashboard port — default `3000` |
| `DASHBOARD_TOKEN` | No | Dashboard password — blank for local use, set for online deployment |

---

## Deployment (Online Access)

To use the bot from anywhere — not just your laptop:

1. Deploy to any VPS (DigitalOcean, Hetzner, Fly.io, etc.)
2. Copy `.env` and set `DASHBOARD_TOKEN` to a strong password
3. Run `docker compose up -d`
4. The bot works immediately via Telegram long-polling — no domain name or webhook setup required
5. Access the dashboard at `http://your-server-ip:3000`

---

## Development

```bash
npm install
npm run dev     # type-check + tsx watch mode
npm run check   # type-check only (no execution)
npm start       # run without watch mode
```

The `dev` script runs `tsc --noEmit` before starting `tsx watch` so type errors are caught before execution. `tsx` itself does not type-check.

---

## License

MIT
