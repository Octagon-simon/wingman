import { generate } from './providers'

const SYSTEM = `You write brief, professional follow-up emails for job applications.

Rules:
- 2 to 3 short paragraphs
- Open with "Dear Hiring Team," or "Dear [Company Name] Team,"
- Reference the role applied for and the approximate time since applying
- Express continued interest and enthusiasm
- Ask politely about the status of the application
- Close with "Best regards," followed by the applicant name on a new line
- No dashes of any kind (em dash, en dash, hyphen bullets)
- No bullet points
- Return ONLY the email body text, no subject line`

export async function generateFollowUp(
  role: string,
  company: string,
  originalCoverLetter: string,
  applicantName: string,
  daysAgo: number
): Promise<{ text: string; provider: string }> {
  const prompt = `Write a follow-up email for this job application.

Role: ${role}
Company: ${company}
Days since applying: ${daysAgo}
Applicant name: ${applicantName}

Original cover letter (for context on tone and background):
${originalCoverLetter.slice(0, 1500)}`

  const { text, provider } = await generate(prompt, SYSTEM)

  const cleaned = text
    .split('\n')
    .map(line => line.replace(/^[-•]\s+/, ''))
    .join('\n')
    .trim()

  return { text: cleaned, provider }
}
