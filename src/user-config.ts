import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { config } from './config'

export interface ResumeVariant {
  label: string   // e.g. 'frontend', 'backend', 'fullstack'
  path: string
}

export interface UserConfig {
  variants?: ResumeVariant[]
  defaultVariant?: string
  portfolioUrl?: string
  chatId?: number
  // Legacy field — migrated automatically on first read
  resumePath?: string
}

const CONFIG_PATH = path.join(config.dataDir, 'user_config.json')

export function getUserConfig(): UserConfig {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as UserConfig
    // Migrate old single-resume format
    if (raw.resumePath && (!raw.variants || raw.variants.length === 0)) {
      raw.variants = [{ label: 'default', path: raw.resumePath }]
      raw.defaultVariant = 'default'
      delete raw.resumePath
      writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2))
    }
    return raw
  } catch {
    return {}
  }
}

export function setUserConfig(updates: Partial<UserConfig>): UserConfig {
  const next = { ...getUserConfig(), ...updates }
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2))
  return next
}

export function getDefaultResumePath(cfg: UserConfig): string | undefined {
  if (!cfg.variants || cfg.variants.length === 0) return undefined
  if (cfg.defaultVariant) {
    return cfg.variants.find(v => v.label === cfg.defaultVariant)?.path
  }
  return cfg.variants[0]?.path
}

export function getResumePath(cfg: UserConfig, variantLabel?: string): string | undefined {
  if (!cfg.variants || cfg.variants.length === 0) return undefined
  if (variantLabel) {
    return cfg.variants.find(v => v.label === variantLabel)?.path ?? getDefaultResumePath(cfg)
  }
  return getDefaultResumePath(cfg)
}

export function addVariant(label: string, filePath: string, makeDefault = false): UserConfig {
  const cfg = getUserConfig()
  const variants = cfg.variants ?? []
  const existingIdx = variants.findIndex(v => v.label === label)
  if (existingIdx >= 0) {
    variants[existingIdx] = { label, path: filePath }
  } else {
    variants.push({ label, path: filePath })
  }
  const defaultVariant = makeDefault || !cfg.defaultVariant ? label : cfg.defaultVariant
  return setUserConfig({ variants, defaultVariant })
}
