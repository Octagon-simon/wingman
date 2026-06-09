import { generate } from './providers'

const SYSTEM = `You are an expert ATS resume optimizer.

Rules:
- Mirror keywords from the job description naturally — never stuff them
- Every bullet starts with a strong past-tense action verb
- Quantify achievements wherever the original has enough signal to do so
- No tables, columns, or graphics — ATS parsers cannot read them
- Target 1–2 pages of content
- Preserve the candidate's actual experience and facts — do not invent achievements
- Return ONLY valid JSON, no markdown fences or extra text`

export interface Experience {
  title: string
  company: string
  dates: string
  bullets: string[]
}

export interface Education {
  degree: string
  school: string
  location: string   // city, state/country — shown right-aligned next to school name
}

export interface Certificate {
  name: string
  url?: string   // hyperlink URL if found in the document, omit if not available
}

export interface OptimizedResume {
  name: string
  headline: string   // professional title shown below name, e.g. "SOFTWARE ENGINEER"
  contact: string
  summary: string
  experience: Experience[]
  certificates: Certificate[]   // empty array if none
  education: Education[]
  skills: string[]
}

export interface OptimizeResult {
  resume: OptimizedResume
  keywordsAdded: string[]
  provider: string
}

export async function optimizeResume(
  resumeText: string,
  jobDescription: string,
  role: string,
  portfolioUrl?: string,
  revisionNote?: string
): Promise<OptimizeResult> {
  const prompt = `Resume:
<resume>
${resumeText}
</resume>

Target role: ${role}
${portfolioUrl ? `Portfolio: ${portfolioUrl}` : ''}
${revisionNote ? `\nApplicant revision instructions (apply these on top of ATS optimisation):\n${revisionNote}\n` : ''}
Job description:
<jd>
${jobDescription}
</jd>

Return this exact JSON shape:
{
  "resume": {
    "name": "Full Name",
    "headline": "PROFESSIONAL TITLE extracted from the resume, e.g. SOFTWARE ENGINEER",
    "contact": "city, country  •  email  •  phone${portfolioUrl ? '  •  portfolio' : ''}",
    "summary": "2–3 sentence summary tailored to this specific role and its keywords",
    "experience": [
      {
        "title": "Job Title",
        "company": "Company Name",
        "dates": "MMM YYYY – MMM YYYY",
        "bullets": ["Achieved X by doing Y, resulting in Z"]
      }
    ],
    "certificates": [
      { "name": "Certificate or Course Name", "url": "https://... or omit if not found" }
    ],
    "education": [
      {
        "degree": "Bachelor of Science in Computer Science",
        "school": "University Name",
        "location": "City, State/Country"
      }
    ],
    "skills": ["Skill1", "Skill2", "Skill3"]
  },
  "keywordsAdded": ["keyword1", "keyword2"]
}

Notes:
- certificates: extract all certifications, courses, and credentials. Match each name against the HYPERLINKS IN DOCUMENT section (if present) to find its URL. Use empty array [] if none.
- education location: the institution's city and state/country, NOT the graduation year.`

  const { text, provider } = await generate(prompt, SYSTEM)
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  const parsed = JSON.parse(cleaned) as { resume: OptimizedResume; keywordsAdded: string[] }
  return { ...parsed, provider }
}
