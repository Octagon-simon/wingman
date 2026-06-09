import nodemailer from 'nodemailer'
import { readFileSync } from 'fs'
import { config } from '../config'

export interface SendOptions {
  to: string
  role: string
  company: string
  coverLetter: string
  resumePath: string
  portfolioUrl?: string
}

export interface FollowUpOptions {
  to: string
  role: string
  company: string
  body: string
}

function createTransporter() {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    connectionTimeout: 10_000,
    socketTimeout: 30_000,
  })
}

function assertSmtp() {
  if (!config.smtpUser || !config.smtpPass) {
    throw new Error('SMTP credentials not configured — set SMTP_USER and SMTP_PASS in .env')
  }
  if (!config.fromEmail) {
    throw new Error('FROM_EMAIL not set in .env')
  }
}

async function verifiedTransporter() {
  const t = createTransporter()
  try {
    await t.verify()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[email] SMTP verify failed:', msg)
    throw new Error(`SMTP connection failed: ${msg}`)
  }
  return t
}

export async function sendApplication(opts: SendOptions): Promise<void> {
  assertSmtp()

  const transporter = await verifiedTransporter()

  const resumeFilename = config.fromName
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '') + '.docx'

  const body = opts.coverLetter +
    (opts.portfolioUrl ? `\n\nPortfolio: ${opts.portfolioUrl}` : '')

  try {
    await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: opts.to,
      subject: `Application — ${opts.role} at ${opts.company} | ${config.fromName}`,
      text: body,
      attachments: [
        {
          filename: resumeFilename,
          content: readFileSync(opts.resumePath),
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
    })
    console.log(`[email] Sent to ${opts.to} — ${opts.role} @ ${opts.company}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[email] sendMail failed:', msg)
    throw new Error(`Failed to send email: ${msg}`)
  }
}

export async function sendFollowUp(opts: FollowUpOptions): Promise<void> {
  assertSmtp()

  const transporter = await verifiedTransporter()

  try {
    await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: opts.to,
      subject: `Following up — ${opts.role} at ${opts.company} | ${config.fromName}`,
      text: opts.body,
    })
    console.log(`[email] Follow-up sent to ${opts.to} — ${opts.role} @ ${opts.company}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[email] sendFollowUp failed:', msg)
    throw new Error(`Failed to send follow-up: ${msg}`)
  }
}
