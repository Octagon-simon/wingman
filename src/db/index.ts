import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import path from 'path'
import { config } from '../config'
import * as schema from './schema'

const sqlite = new Database(path.join(config.dataDir, 'applications.db'))
sqlite.pragma('journal_mode = WAL')

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    role              TEXT NOT NULL,
    company           TEXT NOT NULL,
    to_email          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'sent',
    resume_path       TEXT,
    cover_letter      TEXT,
    provider_used     TEXT,
    follow_up_sent_at INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch())
  )
`)

// Migration: add follow_up_sent_at for databases created before this column existed
try {
  sqlite.exec(`ALTER TABLE applications ADD COLUMN follow_up_sent_at INTEGER`)
} catch {
  // Column already exists — safe to ignore
}

export const db = drizzle(sqlite, { schema })
