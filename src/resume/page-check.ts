import { execSync } from 'child_process'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import path from 'path'
import type { OptimizedResume } from '../ai/optimizer'

// Cached once at first call — avoids a shell spawn on every resume generation
let _sofficeAvailable: boolean | null = null
function sofficeAvailable(): boolean {
  if (_sofficeAvailable !== null) return _sofficeAvailable
  try { execSync('which soffice', { stdio: 'ignore' }); _sofficeAvailable = true }
  catch { _sofficeAvailable = false }
  return _sofficeAvailable
}

async function countViaSoffice(docxPath: string): Promise<number> {
  const pdfPath = path.join('/tmp', path.basename(docxPath, '.docx') + '.pdf')
  if (existsSync(pdfPath)) unlinkSync(pdfPath)
  execSync(`soffice --headless --convert-to pdf --outdir /tmp "${docxPath}"`, {
    timeout: 30_000,
    stdio: 'pipe',
  })
  if (!existsSync(pdfPath)) return 1
  const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ numpages: number }>
  const result = await pdfParse(readFileSync(pdfPath))
  unlinkSync(pdfPath)
  return result.numpages
}

// Heuristic fallback when soffice is unavailable.
// Estimates total content height in points using known generator spacing values (SP units).
// Not pixel-perfect but reliably catches overflow of a full paragraph or more.
function estimatePageCount(resume: OptimizedResume): number {
  const CHARS_PER_LINE = 90  // ~90 chars/line at 11pt Calibri in a 6.5" column
  const LINE_PT = 13         // 11pt × 1.15 line spacing, rounded up
  const SECTION_H = 29       // SP(12) before + 1 line + SP(4) after
  const PAGE_PT = 690        // usable ~720pt with 30pt safety margin

  // Height of a text block: lines × line height + after spacing
  const textH = (text: string, afterPt: number) =>
    Math.max(1, Math.ceil(text.length / CHARS_PER_LINE)) * LINE_PT + afterPt

  let h = 0

  // Fixed header block
  h += 22 + 2  // name (large font, ~1 line + SP(2) after)
  if (resume.headline) h += textH(resume.headline, 2)
  h += textH(resume.contact, 8)

  // Skills — one line per category
  h += SECTION_H
  const validSkills = resume.skills.filter(Boolean)
  validSkills.forEach((s, i) => {
    h += textH(s, i === validSkills.length - 1 ? 4 : 1)
  })

  // Summary
  if (resume.summary?.trim()) h += SECTION_H + textH(resume.summary, 4)

  // Experience
  h += SECTION_H
  for (const job of resume.experience) {
    h += 24  // company row: SP(10) before + line + SP(1) after
    h += 17  // title row:   SP(1)  before + line + SP(3) after
    for (const b of job.bullets) h += textH(b, 3)
  }

  // Certificates
  if (resume.certificates?.length) {
    h += SECTION_H + textH(resume.certificates.map(c => c.name).join('  |  '), 4)
  }

  // Education
  h += SECTION_H
  for (const _edu of resume.education) {
    h += LINE_PT + 7  // school row
    h += LINE_PT + 5  // degree row
  }

  console.log(`[page-check] heuristic estimate: ${Math.round(h)}pt / ${PAGE_PT}pt limit`)
  return h > PAGE_PT ? 2 : 1
}

// Returns the page count of a generated DOCX.
// Uses soffice (accurate) when available, falls back to a layout heuristic otherwise.
export async function countDocxPages(docxPath: string, resume?: OptimizedResume): Promise<number> {
  if (sofficeAvailable()) {
    try {
      return await countViaSoffice(docxPath)
    } catch (err) {
      console.warn('[page-check] soffice failed, falling back to heuristic:', (err as Error).message)
    }
  }
  if (resume) return estimatePageCount(resume)
  return 1
}
