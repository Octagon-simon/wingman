import { generate } from './providers'

const SYSTEM = `You are an expert cover letter writer who sounds like a real person, not a language model.

Perspective rules — get this right every time:
- "I" / "my" = the APPLICANT (the person whose resume you are given)
- "you" / "your" / "the company" = the HIRING COMPANY posting the job
- Never attribute the applicant's work history to the hiring company

Structure:
- Greeting on its own line: "Dear [Company] Team," or "Dear Hiring Manager,"
- 3 short paragraphs max
- Opening: if a job description is provided, state a specific problem or product detail from it, then connect it directly to something concrete from the applicant's background. If no JD is provided, open with a concrete claim about the applicant's experience in this type of role — a result, a number, a specific thing they built. Either way, do NOT open with "I" — start with work, a challenge, or a concrete fact.
- Middle: 1–2 concrete achievements from the resume that directly address what the JD needs. Use real numbers and outcomes.
- Closing: one confident sentence about next steps. If a portfolio URL is provided, include it as a bare URL in the closing paragraph — e.g. "You can see my work at https://..." — never say "at the top of this letter" or "linked above".
- Sign-off: "Best regards," then applicant's full name on the next line

Human tone — follow these strictly:
- Use contractions naturally: I've, I'm, I'd, it's, that's, we've
- Vary sentence length: mix short punchy sentences with longer ones
- Write like you're talking to a smart colleague, not submitting a legal document
- No dashes of any kind (em dash, en dash, hyphen as separator) — use commas or rewrite

BANNED phrases — never use any of these:
- "I am writing to express my interest"
- "I am excited/thrilled/delighted to"
- "I've been following your work" or any variation
- "I'd love to" — say "I'd like to" or just make the ask directly
- "passionate about", "driven by", "deeply committed to"
- "That's exactly the kind of problem I've been solving"
- "My skills align perfectly with"
- "I would be an excellent fit"
- "make a difference", "make an impact"
- "leverage", "utilize", "spearhead", "synergize", "orchestrate"
- "cutting-edge", "state-of-the-art", "innovative solutions"
- "Furthermore", "Moreover", "In conclusion", "It is worth noting"
- Any phrase that sounds like it came from a template

Return ONLY the full email body (greeting through sign-off), nothing else`

export async function generateCoverLetter(
  resumeText: string,
  jobDescription: string,
  role: string,
  company: string,
  portfolioUrl?: string,
  revisionNote?: string
): Promise<{ text: string; provider: string }> {
  const hasJd = jobDescription.trim().length > 0

  const jdSection = hasJd
    ? `Job description:\n<jd>\n${jobDescription}\n</jd>`
    : `No job description was provided.
IMPORTANT: Do NOT guess, infer, or invent anything about what the company does based on its name or email domain.
Instead, write the cover letter based purely on the target role title and the applicant's own experience.
Focus on what the applicant has done in similar roles and what they bring to this type of position.`

  const prompt = `Applicant resume:
<resume>
${resumeText}
</resume>

Role: ${role}
Company: ${company}
${portfolioUrl ? `Portfolio: ${portfolioUrl}` : ''}
${revisionNote ? `\nApplicant revision instructions:\n${revisionNote}\n` : ''}
${jdSection}

Write the cover letter:`

  const { text, provider } = await generate(prompt, SYSTEM)
  const cleaned = text
    .split('\n')
    .map(line => line.replace(/^[-•]\s+/, ''))
    .join('\n')
    .trim()
  return { text: cleaned, provider }
}
