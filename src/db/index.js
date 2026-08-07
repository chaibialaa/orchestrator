import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const schemaVersion = 9
export const uid = () => randomUUID()
export const nowStamp = () => new Date().toISOString()
export const json = {
  read(value, fallback = null) { try { return value == null ? fallback : JSON.parse(value) } catch { return fallback } },
  write(value) { return JSON.stringify(value ?? {}) },
}
export function dbPath() { return process.env.ORCHESTRATOR_DB ?? join(homedir(), '.orchestrator', 'orchestrator.db') }
export function machineId() {
  if (process.env.ORCHESTRATOR_MACHINE) return process.env.ORCHESTRATOR_MACHINE
  const path = join(homedir(), '.orchestrator', 'machine')
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) writeFileSync(path, randomUUID(), { mode: 0o600 })
  return readFileSync(path, 'utf8').trim()
}

let connection
export function base({ requireCurrent = true } = {}) {
  if (connection) return connection
  const path = dbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  if (requireCurrent) {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
    const version = has ? db.prepare('SELECT max(version) version FROM schema_migrations').get()?.version : null
    if (version !== schemaVersion) {
      db.close()
      throw new Error(`Database migration required (found ${version ?? 'legacy'}, expected ${schemaVersion}). Run: orchestrator migrate`)
    }
  }
  connection = db
  return db
}

export function closeBase() { if (connection) connection.close(); connection = null }
export function schemaSql() { return readFileSync(join(here, 'schema.sql'), 'utf8') }
export function schemaChecksum() { return createHash('sha256').update(schemaSql()).digest('hex') }
