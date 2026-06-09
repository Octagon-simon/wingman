import 'dotenv/config'
import { mkdirSync, existsSync } from 'fs'

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

export const config = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),

  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',

  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',

  smtpHost: process.env.SMTP_HOST ?? 'smtp.gmail.com',
  smtpPort: parseInt(process.env.SMTP_PORT ?? '587'),
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',
  fromEmail: process.env.FROM_EMAIL ?? '',
  fromName: process.env.FROM_NAME ?? 'Applicant',

  dashboardPort: parseInt(process.env.DASHBOARD_PORT ?? '3000'),
  dataDir: process.env.DATA_DIR ?? './data',
  uploadsDir: process.env.UPLOADS_DIR ?? './uploads',
}

for (const dir of [config.dataDir, config.uploadsDir]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
