import mammoth from 'mammoth'
import { readFileSync } from 'fs'
import path from 'path'

// Extracts hyperlinks from a DOCX as { linkText: url }.
// Called at setup time so cert URLs persist in user config independent of AI matching.
export async function extractLinks(filePath: string): Promise<Record<string, string>> {
  if (path.extname(filePath).toLowerCase() !== '.docx') return {}
  try {
    const { value: html } = await mammoth.convertToHtml({ path: filePath })
    const result: Record<string, string> = {}
    const pattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = pattern.exec(html)) !== null) {
      const [, href, rawInner] = m
      if (!href.startsWith('http')) continue
      const text = rawInner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (text) result[text] = href
    }
    return result
  } catch {
    return {}
  }
}

export async function parseResume(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.docx') {
    const [textResult, htmlResult] = await Promise.all([
      mammoth.extractRawText({ path: filePath }),
      mammoth.convertToHtml({ path: filePath }),
    ])

    let text = textResult.value.trim()

    // Extract hyperlinks from the HTML output and append them for the AI to use.
    // mammoth strips hrefs from plain text, so we pull them from the HTML separately.
    // Use [\s\S]*? to handle nested <span> tags inside <a> elements.
    const links: Array<{ text: string; href: string }> = []
    const linkPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let match
    while ((match = linkPattern.exec(htmlResult.value)) !== null) {
      const [, href, rawInner] = match
      if (!href.startsWith('http')) continue
      const linkText = rawInner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (linkText) links.push({ text: linkText, href })
    }
    console.log(`[parser] DOCX links found: ${links.length}`, links.map(l => l.text))

    if (links.length > 0) {
      text += '\n\nHYPERLINKS IN DOCUMENT (use these URLs for matching certificate entries):\n'
      text += links.map(l => `- "${l.text}": ${l.href}`).join('\n')
    }

    return text
  }

  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>
    const buffer = readFileSync(filePath)
    const data = await pdfParse(buffer)
    return data.text.trim()
  }

  throw new Error(`Unsupported file type "${ext}". Please upload a PDF or DOCX.`)
}
