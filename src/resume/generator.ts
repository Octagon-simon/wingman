import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from 'docx'
import { writeFileSync } from 'fs'
import path from 'path'
import { config } from '../config'
import type { OptimizedResume, Certificate } from '../ai/optimizer'

// All sizes in half-points (docx unit). PT(n) = n * 2 converts pt → half-points
const FONT = 'Calibri'
const PT   = (pt: number) => pt * 2

// Right-margin tab stop in twips (1/1440 inch).
// Page: 8.5" letter = 12240 twips. Margins: 864 twips each side (0.6").
// Content width: 12240 - 864 - 864 = 10512. Use 9900 for safe cross-paper compatibility.
const RIGHT_MARGIN = 9900

function nameBlock(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: PT(3) },
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
    spacing: { after: PT(3) },
    children: [
      new TextRun({ text: text.toUpperCase(), size: PT(11), font: FONT, color: '444444' }),
    ],
  })
}

function contactBlock(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: PT(12) },
    children: [
      new TextRun({ text, size: PT(10), font: FONT, color: '444444' }),
    ],
  })
}

function sectionHeader(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: PT(16), after: PT(5) },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: '1a1a1a', space: 2 },
    },
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, size: PT(11), font: FONT }),
    ],
  })
}

// Line 1: COMPANY NAME (bold, uppercase) — date right-aligned
function jobCompanyRow(company: string, dates: string): Paragraph {
  return new Paragraph({
    spacing: { before: PT(14), after: PT(1) },
    tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_MARGIN }],
    children: [
      new TextRun({ text: company.toUpperCase(), bold: true, size: PT(11), font: FONT }),
      new TextRun({ text: `\t${dates}`, size: PT(10), font: FONT, color: '555555' }),
    ],
  })
}

// Line 2: Job title (italic)
function jobTitleRow(title: string): Paragraph {
  return new Paragraph({
    spacing: { before: PT(1), after: PT(4) },
    children: [
      new TextRun({ text: title, size: PT(11), font: FONT, italics: true }),
    ],
  })
}

function bulletPoint(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: PT(3) },
    indent: { left: PT(14), hanging: PT(10) },
    children: [
      new TextRun({ text: '•  ', size: PT(11), font: FONT }),
      new TextRun({ text,              size: PT(11), font: FONT }),
    ],
  })
}

function bodyText(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: PT(5) },
    children: [
      new TextRun({ text, size: PT(11), font: FONT }),
    ],
  })
}

// Line 1: SCHOOL NAME — location right-aligned (no graduation date, matches original)
function eduSchoolRow(school: string, location: string): Paragraph {
  return new Paragraph({
    spacing: { before: PT(8), after: PT(1) },
    tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_MARGIN }],
    children: [
      new TextRun({ text: school.toUpperCase(), bold: true, size: PT(11), font: FONT }),
      new TextRun({ text: `\t${location}`, size: PT(10), font: FONT, color: '555555' }),
    ],
  })
}

// Line 2: Degree (italic)
function eduDegreeRow(degree: string): Paragraph {
  return new Paragraph({
    spacing: { before: PT(1), after: PT(2) },
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

    if (cert.url) {
      children.push(
        new ExternalHyperlink({
          link: cert.url,
          children: [
            new TextRun({ text: cert.name, size: PT(11), font: FONT, color: '1155cc', underline: {} }),
          ],
        })
      )
    } else {
      children.push(new TextRun({ text: cert.name, size: PT(11), font: FONT, color: '1155cc' }))
    }
  })

  return new Paragraph({ spacing: { after: PT(4) }, children })
}

export async function generateResumeDocx(resume: OptimizedResume, filename: string): Promise<string> {
  const children: Paragraph[] = [nameBlock(resume.name)]

  if (resume.headline) {
    children.push(headlineBlock(resume.headline))
  }

  children.push(contactBlock(resume.contact))

  // Skills first — immediately scannable, matches original layout
  children.push(sectionHeader('Skills'))
  children.push(bodyText(resume.skills.join('  |  ')))

  // Summary after skills (ATS keyword density, not the visual focus)
  if (resume.summary) {
    children.push(sectionHeader('Summary'))
    children.push(bodyText(resume.summary))
  }

  children.push(sectionHeader('Professional Experience'))
  for (const job of resume.experience) {
    children.push(jobCompanyRow(job.company, job.dates))
    children.push(jobTitleRow(job.title))
    job.bullets.forEach(b => children.push(bulletPoint(b)))
  }

  if (resume.certificates && resume.certificates.length > 0) {
    children.push(sectionHeader('Certificates'))
    children.push(certificatesBlock(resume.certificates))
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
          paragraph: { spacing: { line: 276 } },  // ~1.15 line spacing
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, right: 864, bottom: 720, left: 864 },
          },
        },
        children,
      },
    ],
  })

  const buffer = await Packer.toBuffer(doc)
  const outPath = path.join(config.uploadsDir, filename)
  writeFileSync(outPath, buffer)
  return outPath
}
