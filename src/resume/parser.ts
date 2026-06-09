import mammoth from 'mammoth'
import { readFileSync } from 'fs'
import path from 'path'

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
    const links: Array<{ text: string; href: string }> = []
    const linkPattern = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g
    let match
    while ((match = linkPattern.exec(htmlResult.value)) !== null) {
      const [, href, linkText] = match
      if (href.startsWith('http')) {
        links.push({ text: linkText.trim(), href })
      }
    }

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
