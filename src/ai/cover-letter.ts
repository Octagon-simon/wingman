import { generate } from './providers'

const SYSTEM = `You are an expert cover letter writer.

Perspective rules — get this right every time:
- "I" / "my" = the APPLICANT (the person whose resume you are given)
- "you" / "your" / "the company" = the HIRING COMPANY posting the job
- Never attribute the applicant's work history to the hiring company
- Never say "your work at [applicant's employer]" — that employer belongs to the applicant, not the reader

Writing rules:
- Start with a greeting on its own line: "Dear [Company] Team," if the company name sounds natural, otherwise "Dear Hiring Manager,"
- 3–4 short paragraphs max
- Opening paragraph: hook about what the COMPANY is building (from the JD), then connect it to the applicant's background. Never start with "I am writing to express my interest"
- Middle: 1–2 specific achievements from the applicant's resume that directly address the JD requirements
- Closing: clear, confident call to action
- End with a sign-off on its own line: "Best regards," then the applicant's full name on the next line
- Warm but professional tone. Sound human, not corporate
- No dashes of any kind: no em dashes (—), en dashes (–), or hyphens used as separators. Use commas, periods, or rewrite the sentence instead
- Return ONLY the full email body (greeting + paragraphs + sign-off), nothing else`

export async function generateCoverLetter(
  resumeText: string,
  jobDescription: string,
  role: string,
  company: string,
  portfolioUrl?: string,
  revisionNote?: string
): Promise<{ text: string; provider: string }> {
  const prompt = `Applicant resume:
<resume>
${resumeText}
</resume>

Role: ${role}
Company: ${company}
${portfolioUrl ? `Portfolio: ${portfolioUrl}` : ''}
${revisionNote ? `\nApplicant revision instructions:\n${revisionNote}\n` : ''}
Job description:
<jd>
${jobDescription}
</jd>

Write the cover letter:`

  const { text, provider } = await generate(prompt, SYSTEM)
  const cleaned = text
    .split('\n')
    .map(line => line.replace(/^[-•]\s+/, ''))
    .join('\n')
    .trim()
  return { text: cleaned, provider }
}
