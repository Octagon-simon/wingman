import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'

export type Provider = 'gemini' | 'deepseek' | 'claude'

export interface AIResult {
  text: string
  provider: Provider
}

async function callGemini(prompt: string, system: string): Promise<string> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY not set')
  const genAI = new GoogleGenerativeAI(config.geminiApiKey)
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    systemInstruction: system,
  })
  const result = await model.generateContent(prompt)
  return result.response.text()
}

async function callDeepseek(prompt: string, system: string): Promise<string> {
  if (!config.deepseekApiKey) throw new Error('DEEPSEEK_API_KEY not set')
  const client = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: config.deepseekApiKey,
  })
  const res = await client.chat.completions.create({
    model: config.deepseekModel,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  })
  return res.choices[0]?.message.content ?? ''
}

async function callClaude(prompt: string, system: string): Promise<string> {
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not set')
  const client = new Anthropic({ apiKey: config.anthropicApiKey })
  const message = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  const block = message.content[0]
  if (block.type !== 'text') throw new Error('Unexpected response block type')
  return block.text
}

const PROVIDERS: Record<Provider, (p: string, s: string) => Promise<string>> = {
  gemini: callGemini,
  deepseek: callDeepseek,
  claude: callClaude,
}

// Tries each provider in order: Gemini → DeepSeek → Claude
export async function generate(prompt: string, system: string): Promise<AIResult> {
  const order: Provider[] = ['gemini', 'deepseek', 'claude']
  const errors: string[] = []

  for (const provider of order) {
    try {
      const text = await PROVIDERS[provider](prompt, system)
      return { text, provider }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[ai] ${provider} failed — ${msg}`)
      errors.push(`${provider}: ${msg}`)
    }
  }

  throw new Error(`All AI providers failed:\n${errors.join('\n')}`)
}
