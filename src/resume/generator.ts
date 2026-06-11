import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
  UnderlineType,
} from 'docx'
import { writeFileSync } from 'fs'
import path from 'path'
import { config } from '../config'
import type { OptimizedResume, Certificate } from '../ai/optimizer'

const FONT = 'Calibri'

// Font sizes are in half-points (docx w:sz unit). PT(11) = 22 half-pts = 11pt font.
const PT = (pt: number) => pt * 2

// Paragraph spacing (before/after) and indent (left/hanging) are in twips (1/20 pt).
// PT() is WRONG for spacing — it gives values 10× too small.
const SP = (pt: number) => pt * 20

// Right-margin tab stop in twips.
// Letter page 12240 twips wide, 864 twips margins each side → content 10512 twips.
const RIGHT_MARGIN = 9900

// Strip AI-added bullet markers. AI sometimes prefixes bullets with "- ", "• ", etc.
function cleanBullet(text: string): string {
  return text.replace(/^[\-–—•·*]\s+/, '').trim()
}

// Case-insensitive substring match: stored cert name ⊆ AI cert name, or vice-versa.
// Returns the URL if any stored entry matches, undefined otherwise.
export function findCertUrl(certName: string, links: Record<string, string>): string | undefined {
  const lower = certName.toLowerCase()
  for (const [stored, url] of Object.entries(links)) {
    const s = stored.toLowerCase()
    if (lower.includes(s) || s.includes(lower)) return url
  }
  return undefined
}

function nameBlock(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: SP(2) },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        size: PT(22),
        font: FONT,
        characterSpacing: 40,
      }),
    ],
  })
}

function headlineBlock(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: SP(2) },
    children: [
      new TextRun({ text, size: PT(11), font: FONT, color: '444444' }),
    ],
  })
}

function contactBlock(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: SP(8) },
    children: [
      new TextRun({ text, size: PT(10), font: FONT, color: '444444' }),
    ],
  })
}

// SP(12) before every section header + SP(4) after the last content item in the
// previous section = ~16pt total gap, consistent across all section boundaries.
function sectionHeader(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: SP(12), after: SP(4) },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: '1a1a1a', space: 2 },
    },
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, size: PT(11), font: FONT }),
    ],
  })
}

function jobCompanyRow(company: string, dates: string): Paragraph {
  return new Paragraph({
    spacing: { before: SP(10), after: SP(1) },
    tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_MARGIN }],
    children: [
      new TextRun({ text: company.toUpperCase(), bold: true, size: PT(11), font: FONT }),
      new TextRun({ text: `\t${dates}`, size: PT(10), font: FONT, color: '555555' }),
    ],
  })
}

function jobTitleRow(title: string): Paragraph {
  return new Paragraph({
    spacing: { before: SP(1), after: SP(3) },
    children: [
      new TextRun({ text: title, size: PT(11), font: FONT, italics: true }),
    ],
  })
}

function bulletPoint(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: SP(3) },
    indent: { left: SP(18), hanging: SP(14) },
    children: [
      new TextRun({ text: '•  ', size: PT(11), font: FONT }),
      new TextRun({ text: cleanBullet(text), size: PT(11), font: FONT }),
    ],
  })
}

// after: SP(4) — matches eduDegreeRow and certBlock so all section gaps are equal
function bodyText(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: SP(4) },
    children: [
      new TextRun({ text, size: PT(11), font: FONT }),
    ],
  })
}

// One line per skill category — tighter spacing between lines, normal gap after the last one.
// Each item is expected to be "Category: item1, item2, item3" from the AI.
function skillLines(skills: string[]): Paragraph[] {
  return skills.filter(s => s.trim()).map((s, i, arr) => {
    const isLast = i === arr.length - 1
    const colonIdx = s.indexOf(':')
    if (colonIdx === -1) {
      // No category prefix — render as plain text
      return new Paragraph({
        spacing: { after: isLast ? SP(4) : SP(1) },
        children: [new TextRun({ text: s, size: PT(11), font: FONT })],
      })
    }
    const category = s.slice(0, colonIdx + 1)
    const items    = s.slice(colonIdx + 1).trim()
    return new Paragraph({
      spacing: { after: isLast ? SP(4) : SP(1) },
      children: [
        new TextRun({ text: category + ' ', bold: true, size: PT(11), font: FONT }),
        new TextRun({ text: items,                      size: PT(11), font: FONT }),
      ],
    })
  })
}

function eduSchoolRow(school: string, location: string): Paragraph {
  return new Paragraph({
    spacing: { before: SP(6), after: SP(1) },
    tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_MARGIN }],
    children: [
      new TextRun({ text: school.toUpperCase(), bold: true, size: PT(11), font: FONT }),
      new TextRun({ text: `\t${location}`, size: PT(10), font: FONT, color: '555555' }),
    ],
  })
}

function eduDegreeRow(degree: string): Paragraph {
  return new Paragraph({
    spacing: { before: SP(1), after: SP(4) },
    children: [
      new TextRun({ text: degree, size: PT(11), font: FONT, italics: true }),
    ],
  })
}

function certificatesBlock(certs: Certificate[]): Paragraph {
  const children: (TextRun | ExternalHyperlink)[] = []

  certs.forEach((cert, i) => {
    if (i > 0) {
      children.push(new TextRun({ text: '  |  ', size: PT(11), font: FONT, color: '888888' }))
    }
    const url = cert.url?.trim()
    if (url && url.startsWith('http')) {
      children.push(
        new ExternalHyperlink({
          link: url,
          children: [
            new TextRun({
              text: cert.name,
              size: PT(11),
              font: FONT,
              color: '1155cc',
              underline: { type: UnderlineType.SINGLE },
            }),
          ],
        })
      )
    } else {
      children.push(new TextRun({ text: cert.name, size: PT(11), font: FONT }))
    }
  })

  return new Paragraph({ spacing: { after: SP(4) }, children })
}

export async function generateResumeDocx(
  resume: OptimizedResume,
  filename: string,
  certLinks?: Record<string, string>,
): Promise<string> {
  // Enrich certificates with stored links where the AI didn't return a URL
  const certs: Certificate[] = (resume.certificates ?? [])
    .filter(c => c.name?.trim())
    .map(cert => {
      if (!cert.url && certLinks) {
        const found = findCertUrl(cert.name, certLinks)
        if (found) return { ...cert, url: found }
      }
      return cert
    })

  console.log('[generator] certificates:', certs.map(c => `${c.name} → ${c.url ?? 'no url'}`))

  const children: Paragraph[] = [nameBlock(resume.name)]

  if (resume.headline) children.push(headlineBlock(resume.headline))
  children.push(contactBlock(resume.contact))

  children.push(sectionHeader('Skills'))
  skillLines(resume.skills).forEach(p => children.push(p))

  if (resume.summary?.trim()) {
    children.push(sectionHeader('Summary'))
    children.push(bodyText(resume.summary.trim()))
  }

  children.push(sectionHeader('Professional Experience'))
  resume.experience.forEach(job => {
    children.push(jobCompanyRow(job.company, job.dates))
    children.push(jobTitleRow(job.title))
    job.bullets.filter(b => b.trim()).forEach(b => children.push(bulletPoint(b)))
  })

  if (certs.length > 0) {
    children.push(sectionHeader('Certificates'))
    children.push(certificatesBlock(certs))
  }

  children.push(sectionHeader('Education'))
  for (const edu of resume.education) {
    children.push(eduSchoolRow(edu.school, edu.location))
    children.push(eduDegreeRow(edu.degree))
  }

  const doc = new Document({
    creator: config.fromName,
    styles: {
      default: {
        document: {
          run:       { font: FONT, size: PT(11) },
          paragraph: { spacing: { line: 276 } },
        },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 720, right: 864, bottom: 720, left: 864 } } },
      children,
    }],
  })

  const buffer = await Packer.toBuffer(doc)
  const outPath = path.join(config.uploadsDir, filename)
  writeFileSync(outPath, buffer)
  return outPath
}
