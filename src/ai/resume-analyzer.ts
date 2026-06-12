import { generate } from './providers'

export interface ResumeAnalysis {
  matchScore: number
  missingKeywords: string[]  // top 5 keywords from JD absent from resume
  redFlags: string[]         // 3 specific things a hiring manager would notice negatively
  weakSections: string[]     // sections/bullets ATS or a skimming HM would skip, each with reason
}

const SYSTEM = `You are simultaneously two readers:

READER 1 — Senior technical recruiter at the hiring company. You know this JD inside out. You are blunt and specific. You do not give vague feedback like "needs more impact". You point at exact sentences, exact missing terms, exact patterns that get resumes binned.

READER 2 — A hiring manager who has read 80 resumes today and is tired. You skim. Your eyes go to: headline, first bullet of most recent job, any number that stands out. You skip walls of text, generic summaries, and anything that sounds like every other resume.

Your job is to analyze the resume against the JD from both perspectives and return a JSON object. No commentary outside the JSON.`

export async function analyzeResumeVsJd(
  resumeText: string,
  jobDescription: string,
  role: string,
): Promise<{ analysis: ResumeAnalysis; provider: string }> {
  const prompt = `Resume:
<resume>
${resumeText}
</resume>

Target role: ${role}
Job description:
<jd>
${jobDescription}
</jd>

Analyze as both readers described in your system prompt and return this exact JSON:
{
  "matchScore": <0-100 integer. 100 = every hard skill, tool, and keyword present with evidence. 50 = half the hard requirements covered. Be honest — most first-pass resumes score 55-75>,
  "missingKeywords": [
    "<top 5 specific technical terms, tools, or skills explicitly named in the JD that are absent from the resume. Exact strings, not categories>"
  ],
  "redFlags": [
    "<3 concrete things a hiring manager would notice negatively. Be specific: quote the offending text or name the exact section. Examples: 'Summary opener reads the same as 90% of resumes: Full-stack engineer with 5 years', '2 of 5 bullets in most recent role have no metrics', 'Skills section lists React but JD requires React 18 hooks and concurrent features — no evidence of this depth'>",
  ],
  "weakSections": [
    "<sections or specific bullets that ATS would score low OR a skimming HM would skip. State: what the section/bullet is, why it gets skipped, what it needs to change. One string per item, 1-2 sentences max>"
  ]
}

Rules:
- missingKeywords: hard technical terms only — no soft skills, no inferred requirements
- redFlags: name the exact text or section. Generic feedback like 'needs more impact' is not allowed
- weakSections: be surgical — name the specific bullet or section, not 'the experience section generally'
- matchScore: penalise heavily for missing core stack (e.g. JD says Go, resume has none) and lightly for missing adjacent tools`

  const { text, provider } = await generate(prompt, SYSTEM)
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  const analysis = JSON.parse(cleaned) as ResumeAnalysis
  return { analysis, provider }
}

export function formatAnalysisCard(analysis: ResumeAnalysis): string {
  const scoreEmoji = analysis.matchScore >= 80 ? '🟢' : analysis.matchScore >= 60 ? '🟡' : '🔴'
  const lines: string[] = [
    `${scoreEmoji} *Match score: ${analysis.matchScore}/100*`,
  ]

  if (analysis.missingKeywords.length > 0) {
    lines.push('')
    lines.push('🔑 *Keywords to weave in:*')
    lines.push(analysis.missingKeywords.map(k => `• ${k}`).join('\n'))
  }

  if (analysis.redFlags.length > 0) {
    lines.push('')
    lines.push('⚠️ *Red flags to fix:*')
    lines.push(analysis.redFlags.map(f => `• ${f}`).join('\n'))
  }

  if (analysis.weakSections.length > 0) {
    lines.push('')
    lines.push('🔍 *Sections at risk of being skipped:*')
    lines.push(analysis.weakSections.map(s => `• ${s}`).join('\n'))
  }

  lines.push('')
  lines.push('_Rewriting resume with all of the above addressed…_')

  return lines.join('\n')
}
