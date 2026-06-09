import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const applications = sqliteTable('applications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  role: text('role').notNull(),
  company: text('company').notNull(),
  toEmail: text('to_email').notNull(),
  status: text('status').default('sent').notNull(), // sent | interviewing | offer | rejected
  resumePath: text('resume_path'),
  coverLetter: text('cover_letter'),
  providerUsed: text('provider_used'),
  followUpSentAt: integer('follow_up_sent_at'),
  createdAt: integer('created_at').default(sql`(unixepoch())`).notNull(),
})

export type Application = typeof applications.$inferSelect
export type NewApplication = typeof applications.$inferInsert
