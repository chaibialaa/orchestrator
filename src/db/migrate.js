import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { dbPath, json, machineId, nowStamp, schemaChecksum, schemaSql } from './index.js'

const stable = (kind, id) => `legacy-${kind}-${id}`
const key = (kind, id) => `legacy:${kind}:${id}`
const digest = (value) => createHash('sha256').update(value).digest('hex')
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))

function pathInfo(ref, repoPath) {
  const raw = String(ref ?? '').trim()
  const match = raw.match(/(?:^|\s)([^\s]+\.(?:png|jpe?g|webp|md|json|txt|csv|log|pdf))(?:\s|$)/i)
  if (!match) return { locator_kind: 'missing', locator: raw || null, status: 'unverified', retention: 'missing' }
  const candidate = isAbsolute(match[1]) ? match[1] : resolve(repoPath || '.', match[1])
  if (!existsSync(candidate)) return { locator_kind: 'missing', locator: candidate, status: 'missing', retention: 'missing' }
  const bytes = statSync(candidate).size
  const sha256 = digest(readFileSync(candidate))
  return { locator_kind: 'path', locator: candidate, status: 'available', retention: 'referenced', bytes, sha256 }
}

export function migrate(path = dbPath()) {
  const db = new Database(path)
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = OFF')
  const current = hasTable(db, 'schema_migrations') ? db.prepare('SELECT max(version) version FROM schema_migrations').get()?.version : null
  if (current === 3) { db.close(); return { migrated: false, version: 3 } }
  if (current === 2) {
    const eventColumns=new Set(db.prepare('PRAGMA table_info(events)').all().map(row=>row.name)),syncColumns=new Set(db.prepare('PRAGMA table_info(sync_connections)').all().map(row=>row.name))
    if(!eventColumns.has('machine_id'))db.exec('ALTER TABLE events ADD COLUMN machine_id TEXT;')
    if(!syncColumns.has('last_local_event_id'))db.exec('ALTER TABLE sync_connections ADD COLUMN last_local_event_id INTEGER NOT NULL DEFAULT 0;')
    db.exec(schemaSql())
    db.exec('DROP TRIGGER IF EXISTS events_no_update;')
    db.prepare('UPDATE events SET machine_id=? WHERE machine_id IS NULL').run(machineId())
    db.exec(schemaSql())
    db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(3,?)').run(schemaChecksum())
    db.close()
    return { migrated: true, version: 3, counts: {} }
  }
  if (current === 1) {
    db.exec(schemaSql())
    db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(2,?)').run(schemaChecksum())
    db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(3,?)').run(schemaChecksum())
    db.close()
    return { migrated: true, version: 3, counts: {} }
  }
  if (current != null) throw new Error(`Unsupported schema version: ${current}`)

  const legacy = hasTable(db, 'projects')
  const tx = db.transaction(() => {
    if (legacy) {
      db.exec('ALTER TABLE projects RENAME TO legacy_projects; ALTER TABLE objectives RENAME TO legacy_objectives; ALTER TABLE decisions RENAME TO legacy_decisions;')
    }
    db.exec(schemaSql())
    if (!legacy) {
      db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(1,?)').run(schemaChecksum())
      db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(2,?)').run(schemaChecksum())
      db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(3,?)').run(schemaChecksum())
      return
    }

    const projectRows = db.prepare('SELECT * FROM legacy_projects ORDER BY id').all()
    const projectInsert = db.prepare('INSERT INTO projects(id,uid,slug,name,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    for (const p of projectRows) projectInsert.run(p.id, stable('project', p.id), p.slug, p.name, p.repo_path ? `Repository: ${p.repo_path}` : null, p.active === 0 ? 'archived' : 'active', p.created_at, p.updated_at)

    const objectiveInsert = db.prepare('INSERT INTO objectives(id,uid,project_id,parent_id,title,intent,success_criteria,status,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    for (const o of db.prepare('SELECT * FROM legacy_objectives ORDER BY id').all()) objectiveInsert.run(o.id, stable('objective', o.id), o.project_id, o.parent_id, o.title, o.intent, o.proof_spec, o.status, o.priority, o.created_at, o.updated_at)

    const eventInsert = db.prepare(`INSERT INTO events(uid,project_id,objective_id,kind,actor_kind,actor,assertion,summary,payload,occurred_at,idempotency_key,source)
      VALUES(@uid,@project_id,@objective_id,@kind,@actor_kind,@actor,@assertion,@summary,@payload,@occurred_at,@idempotency_key,'legacy-migration')`)
    const event = (kind, row, projectId, objectiveId, summary, assertion = 'system_record') => {
      const info = eventInsert.run({ uid: stable(`event-${kind}`, row.id), project_id: projectId, objective_id: objectiveId ?? null, kind, actor_kind: 'import', actor: 'legacy-orchestrator', assertion, summary: summary || kind, payload: json.write(row), occurred_at: row.created_at || row.started_at || row.decided_at || row.at || nowStamp(), idempotency_key: key(kind, row.id) })
      return Number(info.lastInsertRowid)
    }

    if (hasTable(db, 'passages')) for (const r of db.prepare('SELECT p.*,o.project_id FROM passages p JOIN legacy_objectives o ON o.id=p.objective_id').all()) event('passage.recorded', r, r.project_id, r.objective_id, r.summary || r.mission, 'agent_statement')
    if (hasTable(db, 'runs')) for (const r of db.prepare('SELECT r.*,o.project_id FROM runs r JOIN legacy_objectives o ON o.id=r.objective_id').all()) event('legacy_run.recorded', r, r.project_id, r.objective_id, `Historical execution record #${r.id}`)

    if (hasTable(db, 'evidences')) for (const r of db.prepare('SELECT e.*,o.project_id,p.repo_path FROM evidences e JOIN legacy_objectives o ON o.id=e.objective_id JOIN legacy_projects p ON p.id=o.project_id').all()) {
      const eventId = event('evidence.recorded', r, r.project_id, r.objective_id, r.label, 'measured_fact')
      const info = pathInfo(r.ref, r.repo_path)
      db.prepare(`INSERT INTO evidence_manifests(uid,event_id,project_id,objective_id,label,type,origin,locator_kind,locator,sha256,bytes,mime,retention,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(stable('evidence', r.id), eventId, r.project_id, r.objective_id, r.label, r.type, 'legacy-evidences', info.locator_kind, info.locator, info.sha256 ?? null, info.bytes ?? null, null, info.retention, info.status, r.created_at)
      const verdictEvent = event('verdict.recorded', { ...r, id: `evidence-${r.id}`, created_at: r.created_at }, r.project_id, r.objective_id, `Evidence verdict: ${r.verdict}`, r.verdict === 'inconclusive' ? 'agent_statement' : 'human_judgment')
      db.prepare('INSERT INTO verdicts(uid,event_id,project_id,objective_id,verdict,rationale,created_at) VALUES(?,?,?,?,?,?,?)').run(stable('verdict-evidence', r.id), verdictEvent, r.project_id, r.objective_id, r.verdict, r.label, r.created_at)
    }

    for (const r of db.prepare('SELECT * FROM legacy_decisions').all()) {
      const eventId = event('decision.recorded', r, r.project_id, r.objective_id, r.title, 'human_judgment')
      db.prepare('INSERT INTO decisions(uid,event_id,project_id,objective_id,title,body,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(stable('decision', r.id), eventId, r.project_id, r.objective_id, r.title, r.body, 'accepted', r.decided_at)
    }
    if (hasTable(db, 'halts')) for (const r of db.prepare('SELECT h.*,o.project_id FROM halts h JOIN legacy_objectives o ON o.id=h.objective_id').all()) {
      const eventId = event(r.resolved_at ? 'blocker.resolved' : 'blocker.opened', r, r.project_id, r.objective_id, r.reason)
      db.prepare('INSERT INTO blockers(uid,event_id,project_id,objective_id,title,detail,status,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?)').run(stable('blocker', r.id), eventId, r.project_id, r.objective_id, r.reason, r.detail, r.resolved_at ? 'resolved' : 'open', r.created_at, r.resolved_at)
    }
    if (hasTable(db, 'passages')) for (const r of db.prepare('SELECT p.*,o.project_id FROM passages p JOIN legacy_objectives o ON o.id=p.objective_id WHERE p.cost_usd IS NOT NULL OR p.cost_known=0').all()) {
      const eventId = event('cost.recorded', { ...r, id: `passage-${r.id}` }, r.project_id, r.objective_id, `Cost ${r.cost_known ? `$${r.cost_usd}` : 'unknown'}`, 'measured_fact')
      db.prepare('INSERT INTO costs(uid,event_id,project_id,objective_id,amount,known,category,created_at) VALUES(?,?,?,?,?,?,?,?)').run(stable('cost', r.id), eventId, r.project_id, r.objective_id, r.cost_known ? r.cost_usd : null, r.cost_known, r.harness, r.started_at)
    }

    const oldTables = ['evidence_remotes','attachments','machine_readings','chores','runs','permissions','workflows','briefs','agents','scans','storages','settings','invariants','resources','halts','evidences','passages','legacy_decisions','legacy_objectives','legacy_projects']
    for (const table of oldTables) if (hasTable(db, table)) db.exec(`DROP TABLE "${table}"`)
    db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(1,?)').run(schemaChecksum())
    db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(2,?)').run(schemaChecksum())
    db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(3,?)').run(schemaChecksum())
  })
  tx()
  db.pragma('foreign_keys = ON')
  const integrity = db.pragma('integrity_check', { simple: true })
  const foreignKeys = db.pragma('foreign_key_check')
  const counts = Object.fromEntries(['projects','objectives','events','evidence_manifests','decisions','blockers','verdicts','costs'].map((table) => [table, db.prepare(`SELECT count(*) count FROM ${table}`).get().count]))
  db.close()
  if (integrity !== 'ok' || foreignKeys.length) throw new Error(`Migration validation failed: ${integrity}, ${foreignKeys.length} foreign key errors`)
  return { migrated: true, version: 3, counts }
}
