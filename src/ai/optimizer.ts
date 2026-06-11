import { generate } from './providers'

const SYSTEM = `You are an expert ATS resume optimizer who writes like a real person, not a language model.

Content rules:
- Mirror keywords from the job description naturally — never stuff them
- No tables, columns, or graphics — ATS parsers cannot read them
- Target 1 page of content
- Preserve the candidate's actual experience and facts — do not invent achievements
- Sort experience entries from most recent to oldest (highest start year first)
- Include ONLY the 2-3 experience entries most directly relevant to the target role; omit entries from unrelated industries or domains
- Give EXACTLY 5 bullets to the single experience entry that most closely matches the job description; give all other included entries EXACTLY 4 bullets
- Each bullet must be 15-20 words: strong past-tense action verb → what you built/did and how → quantified result (number, %, or clear business impact)
- When additional context fills a skills gap, rewrite or replace weaker bullets to incorporate it naturally; never exceed the bullet limit for that entry
- Bullet text must NOT start with "- ", "• ", "* " or any marker — the renderer adds its own bullet character

Human tone — follow these strictly:
- Vary the opening verb across bullets: don't start multiple bullets with the same word
- Use specific, concrete language: "reduced load time from 3s to 400ms" not "improved performance"
- Write how a confident engineer would describe their own work to a peer

BANNED words and phrases — never use these in bullets or summary:
- "leveraged", "utilized", "spearheaded", "orchestrated", "synergized", "streamlined" (use the specific action instead)
- "cutting-edge", "state-of-the-art", "innovative", "dynamic", "passionate"
- "responsible for", "tasked with", "assisted with" (own it — say what you actually did)
- "various", "multiple", "numerous" (say the actual number)
- Dashes as separators (em dash —, en dash –) in prose — use commas or rewrite the sentence
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
  headline: string   // the target role — becomes the candidate's title on the resume
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
  revisionNote?: string,
  additionalContext?: string
): Promise<OptimizeResult> {
  const hasJd = jobDescription.trim().length > 0

  const jdSection = hasJd
    ? `Job description:\n<jd>\n${jobDescription}\n</jd>`
    : `No job description was provided. Optimize purely based on the target role title and the candidate's own experience. Do NOT guess or infer what the company does.`

  const prompt = `Resume:
<resume>
${resumeText}
</resume>

Target role: ${role}
${portfolioUrl ? `Portfolio: ${portfolioUrl}` : ''}
${additionalContext ? `\nAdditional experience/context provided by the applicant — incorporate naturally into bullets and summary:\n${additionalContext}\n` : ''}
${revisionNote ? `\nApplicant revision instructions (apply these on top of ATS optimisation):\n${revisionNote}\n` : ''}
${jdSection}

Return this exact JSON shape:
{
  "resume": {
    "name": "Full Name",
    "headline": "use the target role exactly as given — this becomes the candidate's title on the resume",
    "contact": "city, country  •  email  •  phone${portfolioUrl ? '  •  portfolio' : ''}",
    "summary": "2-3 sentence summary targeted to this specific role",
    "experience": [
      {
        "title": "Job Title",
        "company": "Company Name",
        "dates": "YYYY (end year only — use ${new Date().getFullYear()} if current/present)",
        "bullets": ["Achieved X by doing Y, resulting in Z", "...5 bullets if best match for JD, 4 bullets otherwise"]
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
    "skills": [
      "Languages: JavaScript, TypeScript, Python",
      "Frameworks: React, Node.js, Express",
      "Databases: PostgreSQL, MongoDB",
      "Tools: Git, Docker, AWS"
    ]
  },
  "keywordsAdded": ["keyword1", "keyword2"]
}

Notes:
- summary: imagine the candidate is telling a friend what they do for work, in 2-3 sentences. It should sound like something a real person would actually say out loud. Pick ONE specific thing they built or improved — something with a real number or outcome — and lead with that or work it in naturally. Name the target role. No career-speak, no self-congratulation, no vague claims like "strong communicator" or "results-driven". No dashes of any kind (em dash, en dash, hyphen-as-separator) — use commas or rewrite. Contractions are fine. If the result sounds like it came from a CV template or a LinkedIn "About" section, rewrite it.
- skills: group into 3-5 meaningful categories based on the candidate's actual stack (e.g. Languages, Frameworks, Databases, Cloud & Tools). Each element must be "Category: item1, item2, item3". Mirror the categories relevant to the target role.
- certificates: extract all certifications, courses, and credentials. Match each name against the HYPERLINKS IN DOCUMENT section (if present) to find its URL. Use empty array [] if none.
- education location: the institution's city and state/country, NOT the graduation year.
- dates: use only the 4-digit END year of each role (e.g. "2024"). If the role is current/present, use ${new Date().getFullYear()} as the end year. Never output a range.`

  const { text, provider } = await generate(prompt, SYSTEM)
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  const parsed = JSON.parse(cleaned) as { resume: OptimizedResume; keywordsAdded: string[] }
  return { ...parsed, provider }
}
