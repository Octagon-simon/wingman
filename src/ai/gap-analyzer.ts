import { generate } from './providers'

export interface GapAnalysis {
  matched: string[]
  gaps: string[]
  hasSignificantGaps: boolean
}

const SYSTEM = `You are a resume-to-job-description fit analyser. Return ONLY valid JSON, no markdown fences.`

export async function analyzeGaps(
  resumeText: string,
  jobDescription: string,
  role: string
): Promise<GapAnalysis> {
  const prompt = `Analyse how well this resume matches the job description for the role: ${role}

Resume:
${resumeText.slice(0, 3000)}

Job description:
${jobDescription.slice(0, 2000)}

Return JSON:
{
  "matched": ["up to 5 hard technical skills, tools, or frameworks from the JD that clearly appear in the resume"],
  "gaps": ["up to 3 hard technical skills, specific tools, or domain knowledge EXPLICITLY required in the JD that are completely absent from the resume"],
  "hasSignificantGaps": true
}

Rules for gaps:
- Only include HARD technical skills, tools, frameworks, languages, or certifications
- Only include things explicitly stated as requirements in the JD, not inferred
- NEVER include soft skills (communication, teamwork, problem-solving, etc.)
- NEVER include generic requirements (remote work, portfolio, GitHub profile)
- NEVER include things that could reasonably be implied from the candidate's existing experience
- If you cannot find 2+ clear, specific hard-skill gaps, set hasSignificantGaps to false

Set hasSignificantGaps to true ONLY if there are 2 or more specific hard technical gaps the applicant may be able to address with additional context.`

  try {
    const { text } = await generate(prompt, SYSTEM)
    const cleaned = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim()
    return JSON.parse(cleaned) as GapAnalysis
  } catch {
    return { matched: [], gaps: [], hasSignificantGaps: false }
  }
}
