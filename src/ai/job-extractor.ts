import { generate } from './providers'

export interface ExtractedJob {
  role: string
  company: string
  email: string | null
  description: string
}

const SYSTEM = `You are a job posting parser. Extract structured data from the provided job posting content.

Return ONLY valid JSON with no markdown fences or explanation:
{
  "role": "exact job title",
  "company": "company name",
  "email": "application email address, or null if not found — ATS form URLs are not emails",
  "description": "full job description text cleaned of HTML, max 6000 chars"
}`

export async function extractJobDetails(
  rawContent: string
): Promise<ExtractedJob & { provider: string }> {
  const truncated = rawContent.slice(0, 12000)

  const { text, provider } = await generate(
    `Parse this job posting and return structured JSON:\n\n${truncated}`,
    SYSTEM
  )

  const cleaned = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim()

  const parsed = JSON.parse(cleaned) as {
    role?: string
    company?: string
    email?: string | null
    description?: string
  }

  return {
    role: parsed.role?.trim() || 'Unknown Role',
    company: parsed.company?.trim() || 'Unknown Company',
    email: parsed.email?.trim() || null,
    description: parsed.description?.trim() || rawContent.slice(0, 4000),
    provider,
  }
}
