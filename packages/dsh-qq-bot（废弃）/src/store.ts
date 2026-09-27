/**
 * SQLite persistence layer for dsh-qq-bot.
 *
 * Owns the whole schema (M2 uses `conversations` + `messages`; the memory /
 * allowlist / usage tables are created up front so M3/M4 need no migration).
 * Uses Node 24's built-in `node:sqlite` (no native build).
 *
 * Reads map SQL NULL to `undefined` so tool output matches optional-JSON-schema
 * fields; writes accept `null` (bound as SQL NULL).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'

export interface ConversationRow {
  id: string
  kind: 'group' | 'private'
  title: string | undefined
  created_at: number
  updated_at: number
}

export interface ConversationListRow extends ConversationRow {
  message_count: number
}

export interface MessageRow {
  id: number
  conv_id: string
  role: 'user' | 'bot'
  user_id: number | undefined
  content: string
  thinking: string | undefined
  message_id: number | undefined
  created_at: number
}

export interface NewMessage {
  conv_id: string
  role: 'user' | 'bot'
  user_id: number | null
  content: string
  thinking: string | null
  message_id: number | null
  created_at: number
}

/** One stored allowlist entry; `key` is a conversation id (`g:<gid>` / `u:<qq>`). */
export interface AllowlistRow {
  key: string
  kind: 'group' | 'private'
  note: string | undefined
}

export interface MemoryRow {
  id: number
  scope: 'member' | 'group'
  scope_key: string
  topic: string
  summary: string
  strength: number
  mention_count: number
  first_seen_at: number
  last_mentioned_at: number
  updated_at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id    TEXT NOT NULL REFERENCES conversations(id),
  role       TEXT NOT NULL,
  user_id    INTEGER,
  content    TEXT NOT NULL,
  thinking   TEXT,
  message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
CREATE TABLE IF NOT EXISTS memories (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scope             TEXT NOT NULL,
  scope_key         TEXT NOT NULL,
  topic             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  strength          REAL NOT NULL,
  mention_count     INTEGER NOT NULL DEFAULT 0,
  first_seen_at     INTEGER NOT NULL,
  last_mentioned_at INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope_key, strength DESC);
CREATE TABLE IF NOT EXISTS memory_archive (
  id                INTEGER PRIMARY KEY,
  scope             TEXT NOT NULL,
  scope_key         TEXT NOT NULL,
  topic             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  strength          REAL,
  mention_count     INTEGER,
  first_seen_at     INTEGER,
  last_mentioned_at INTEGER,
  archived_at       INTEGER NOT NULL,
  reason            TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_profiles (
  group_id   INTEGER PRIMARY KEY,
  summary    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_allowlist (
  key     TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  note    TEXT
);
CREATE TABLE IF NOT EXISTS usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  conv_id       TEXT,
  model         TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cache_hit     INTEGER,
  cost          REAL,
  raw           TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
`

function cleanRow(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null) out[key] = value
  }
  return out
}

export class Store {
  private db: DatabaseSync

  constructor(dataDir: string) {
    const dir = dataDir ? expandHomePath(dataDir) : dshHomePath('storages', 'qq-bot')
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'qq-bot.sqlite'))
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  // ---- conversations -------------------------------------------------------

  upsertConversation(id: string, kind: 'group' | 'private', title: string | null = null): void {
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO conversations (id, kind, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = COALESCE(excluded.title, title), updated_at = excluded.updated_at`,
    ).run(id, kind, title, now, now)
  }

  listConversations(): ConversationListRow[] {
    const raw = this.db.prepare(
      `SELECT c.id, c.kind, c.title, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conv_id = c.id) AS message_count
       FROM conversations c ORDER BY c.updated_at DESC`,
    ).all() as unknown as Record<string, unknown>[]
    return raw.map(cleanRow) as unknown as ConversationListRow[]
  }

  getConversation(id: string): ConversationRow | undefined {
    const raw = this.db.prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as unknown as Record<string, unknown> | undefined
    return raw === undefined ? undefined : cleanRow(raw) as unknown as ConversationRow
  }

  clearConversation(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE conv_id = ?').run(id)
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  // ---- messages ------------------------------------------------------------

  addMessage(msg: NewMessage): number {
    const result = this.db.prepare(
      `INSERT INTO messages (conv_id, role, user_id, content, thinking, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(msg.conv_id, msg.role, msg.user_id, msg.content, msg.thinking, msg.message_id, msg.created_at)
    return Number(result.lastInsertRowid)
  }

  /** Messages of one conversation, oldest first, capped to `limit` newest. */
  listMessages(convId: string, limit = 200): MessageRow[] {
    const raw = this.db.prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
    ).all(convId, limit) as unknown as Record<string, unknown>[]
    return raw.map(cleanRow) as unknown as MessageRow[]
  }

  /** Newest messages across all conversations, oldest first. */
  listRecentMessages(limit = 50): MessageRow[] {
    const raw = this.db.prepare(
      `SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
    ).all(limit) as unknown as Record<string, unknown>[]
    return raw.map(cleanRow) as unknown as MessageRow[]
  }

  deleteMessage(id: number): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  countMessages(convId?: string): number {
    const row = convId === undefined
      ? this.db.prepare('SELECT COUNT(*) AS n FROM messages').get()
      : this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?').get(convId)
    return Number((row as unknown as { n: number }).n)
  }

  // ---- usage ---------------------------------------------------------------

  addUsageEvent(ev: {
    ts: number
    conv_id: string | null
    model: string
    input_tokens: number | null
    output_tokens: number | null
    cache_hit: number | null
    cost: number | null
    raw: string | null
  }): void {
    this.db.prepare(
      `INSERT INTO usage_events (ts, conv_id, model, input_tokens, output_tokens, cache_hit, cost, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ev.ts, ev.conv_id, ev.model, ev.input_tokens, ev.output_tokens, ev.cache_hit, ev.cost, ev.raw)
  }

  // ---- memories ------------------------------------------------------------

  listMemories(scopeKeys: string[], limit: number): MemoryRow[] {
    if (scopeKeys.length === 0) return []
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const raw = this.db.prepare(
      `SELECT * FROM memories WHERE scope_key IN (${placeholders}) ORDER BY strength DESC LIMIT ?`,
    ).all(...scopeKeys, limit) as unknown as Record<string, unknown>[]
    return raw.map(cleanRow) as unknown as MemoryRow[]
  }

  findMemoryByTopic(scopeKey: string, topic: string): MemoryRow | undefined {
    const raw = this.db.prepare('SELECT * FROM memories WHERE scope_key = ? AND topic = ?')
      .get(scopeKey, topic) as unknown as Record<string, unknown> | undefined
    return raw === undefined ? undefined : cleanRow(raw) as unknown as MemoryRow
  }

  addMemory(m: Omit<MemoryRow, 'id'>): number {
    const result = this.db.prepare(
      `INSERT INTO memories (scope, scope_key, topic, summary, strength, mention_count, first_seen_at, last_mentioned_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.scope, m.scope_key, m.topic, m.summary, m.strength, m.mention_count, m.first_seen_at, m.last_mentioned_at, m.updated_at)
    return Number(result.lastInsertRowid)
  }

  reinforceMemory(id: number, strength: number, mentionCount: number, lastMentionedAt: number): void {
    this.db.prepare(
      'UPDATE memories SET strength = ?, mention_count = ?, last_mentioned_at = ?, updated_at = ? WHERE id = ?',
    ).run(strength, mentionCount, lastMentionedAt, Date.now(), id)
  }

  allMemoriesForDecay(): Array<{ id: number; strength: number; last_mentioned_at: number }> {
    const raw = this.db.prepare('SELECT id, strength, last_mentioned_at FROM memories')
      .all() as unknown as Record<string, unknown>[]
    return raw.map(cleanRow) as unknown as Array<{ id: number; strength: number; last_mentioned_at: number }>
  }

  setMemoryStrength(id: number, strength: number): void {
    this.db.prepare('UPDATE memories SET strength = ?, updated_at = ? WHERE id = ?').run(strength, Date.now(), id)
  }

  /** Soft-delete: copy to archive, then remove from active (transactional). */
  archiveMemory(id: number, reason: string): void {
    const raw = this.db.prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as unknown as Record<string, unknown> | undefined
    if (raw === undefined) return
    const row = cleanRow(raw) as unknown as MemoryRow
    this.db.exec('BEGIN')
    try {
      this.db.prepare(
        `INSERT INTO memory_archive (id, scope, scope_key, topic, summary, strength, mention_count, first_seen_at, last_mentioned_at, archived_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.scope, row.scope_key, row.topic, row.summary, row.strength, row.mention_count, row.first_seen_at, row.last_mentioned_at, Date.now(), reason)
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---- group profiles ------------------------------------------------------

  getGroupProfile(groupId: number): string | undefined {
    const raw = this.db.prepare('SELECT summary FROM group_profiles WHERE group_id = ?')
      .get(groupId) as unknown as Record<string, unknown> | undefined
    return raw === undefined ? undefined : String(raw.summary)
  }

  upsertGroupProfile(groupId: number, summary: string): void {
    this.db.prepare(
      `INSERT INTO group_profiles (group_id, summary, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
    ).run(groupId, summary, Date.now())
  }

  // ---- chat allowlist ------------------------------------------------------

  /** Every stored allowlist entry (the whole set is the allowed set). */
  listAllowlist(): AllowlistRow[] {
    const raw = this.db.prepare('SELECT "key", kind, note FROM chat_allowlist ORDER BY kind, "key"')
      .all() as unknown as Record<string, unknown>[]
    return raw.map(cleanRow) as unknown as AllowlistRow[]
  }

  /** Replace the entire allowlist atomically (the UI saves a full selection). */
  replaceAllowlist(entries: Array<{ key: string; kind: 'group' | 'private'; note?: string | null }>): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM chat_allowlist').run()
      const insert = this.db.prepare('INSERT INTO chat_allowlist ("key", kind, enabled, note) VALUES (?, ?, 1, ?)')
      for (const entry of entries) insert.run(entry.key, entry.kind, entry.note ?? null)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---- panel queries -------------------------------------------------------

  listAllMemories(limit = 200): MemoryRow[] {
    const raw = this.db.prepare('SELECT * FROM memories ORDER BY strength DESC LIMIT ?')
      .all(limit) as unknown as Record<string, unknown>[]
    return raw.map(cleanRow) as unknown as MemoryRow[]
  }

  listUsageEvents(limit = 200): Array<{
    id: number
    ts: number
    conv_id: string | undefined
    model: string
    input_tokens: number | undefined
    output_tokens: number | undefined
    cache_hit: number | undefined
    cost: number | undefined
  }> {
    const raw = this.db.prepare(
      `SELECT id, ts, conv_id, model, input_tokens, output_tokens, cache_hit, cost FROM usage_events ORDER BY id DESC LIMIT ?`,
    ).all(limit) as unknown as Record<string, unknown>[]
    return raw.map(cleanRow) as unknown as Array<{
      id: number
      ts: number
      conv_id: string | undefined
      model: string
      input_tokens: number | undefined
      output_tokens: number | undefined
      cache_hit: number | undefined
      cost: number | undefined
    }>
  }
}
