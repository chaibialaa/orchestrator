import Database from 'better-sqlite3'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * A file, not a server. The database lives in ~/.orchestrator/ by default: you
 * back it up by copying it, you move it by moving it, and nobody has to install
 * anything to read their own data.
 */
export function dbPath() {
  return process.env.ORCHESTRATOR_DB ?? join(homedir(), '.orchestrator', 'orchestrator.db')
}

let db = null

export function base() {
  if (db) return db

  const path = dbPath()
  mkdirSync(dirname(path), { recursive: true })

  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Several processes write at the same time — the loop, the server, the brief
  // splitter. Without a wait, one of them takes a SQLITE_BUSY.
  db.pragma('busy_timeout = 5000')

  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))
  addMissingColumns(db)

  return db
}

/** JSON columns are stored as text: hand them back in the shape callers expect. */
export const json = {
  read(v, fallback = null) {
    if (v === null || v === undefined || v === '') return fallback
    try {
      return JSON.parse(v)
    } catch {
      return fallback
    }
  },
  write(v) {
    return v === null || v === undefined ? null : JSON.stringify(v)
  },
}

/** The time, in the format the database stores, in UTC — never local time. */
export function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * The schema is created in one block, but an existing database is not recreated.
 * Columns added afterwards land here, one by one, without ever touching the data:
 * someone who updates should have nothing to do.
 */
function addMissingColumns(db) {
  const additions = [
    /**
     * WHY a run ended, next to the fact that it did.
     *
     * `status` only ever said `done`, `failed` or `cancelled`, and `done` was
     * carrying everything: a chapter closed, a gate that refused, a judge whose
     * reply was misread, an ending left over from another objective read as an
     * answer. On 2 August five runs out of ten ended on a defect of the tool and
     * every one of them was recorded `done`, turn 0 or 1, no error — indis-
     * tinguishable from a success on the screen you read the next morning.
     *
     * That is the difference between a loop you can leave running and one you
     * have to sit with.
     */
    ['runs', 'outcome', 'TEXT'],
    // What the agent can DO, beyond executing or judging: generate images, 3D, a
    // rendering. That is what lets a mission say "for images, use this one"
    // instead of leaving it to guesswork.
    ['agents', 'capabilities', "TEXT"],
    // The NAME of the environment variable that carries its secret. The VALUE
    // stays on the machine: a hosted server will never hold anybody's RunPod key.
    ['agents', 'env_var', 'TEXT'],
    ['agents', 'endpoint', 'TEXT'],
    // Which conversation drives this project, and which of the connected AIs
    // holds it. Freezing one URL in the code made it impossible to have a thread
    // per project — or to use a judge other than ChatGPT.
    ['projects', 'judge_agent', 'TEXT'],
    ['projects', 'judge_url', 'TEXT'],
    // Continuity is a PER-OBJECTIVE choice: it makes sense on a loop of
    // iterations, none on an independent step. Never global.
    ['objectives', 'resume_mode', "TEXT NOT NULL DEFAULT 'new'"],
    ['objectives', 'resume_session', 'TEXT'],
    // The harness session id, and the one it inherits from. Without this, a
    // resume carries state nobody can see: we could no longer tell whether the
    // order was bad or the execution was.
    ['passages', 'session_id', 'TEXT'],
    ['passages', 'resumed_from', 'TEXT'],
    // The fingerprint of the memories at scan time, and the latest one observed.
    // Without this, a three-day-old scan displays as the current truth while the
    // files have changed ten times since.
    ['scans', 'fingerprint', 'TEXT'],
    ['scans', 'fingerprint_seen', 'TEXT'],
    ['scans', 'seen_at', 'TEXT'],
    // How many proofs existed at the moment of the halt. Comparing timestamps at
    // one-second resolution cannot tell two close writes apart; a watermark on
    // ids does not lie.
    ['halts', 'evidence_mark', 'INTEGER'],
    // WHO the connected account belongs to. Derived from the token, never typed:
    // a storage with no readable owner drops proofs somewhere nobody can name.
    ['storages', 'account', 'TEXT'],
    // When the criterion itself last changed. `updated_at` moves for a retitle
    // too, and a retitle is not a new attempt at anything.
    ['objectives', 'proof_spec_changed_at', 'TEXT'],
    ['runs', 'jump', 'INTEGER NOT NULL DEFAULT 0'],
    // Queued as part of a series: when this one fails, drop what was queued
    // behind it rather than spending on steps whose ground has moved.
    ['runs', 'series_stops_on_failure', 'INTEGER NOT NULL DEFAULT 0'],
    // Queued knowingly beside another pass on the same repository. The mission is
    // told, so the agent can keep off what the other one is holding.
    ['runs', 'alongside', 'INTEGER NOT NULL DEFAULT 0'],
    // Why this run was slipped in front. Written by whoever queued it, read by
    // whoever wonders later why the order was not the order.
    ['runs', 'reason', 'TEXT'],
    ['projects', 'judge_message_cap', 'INTEGER NOT NULL DEFAULT 40'],
    // How full the driving conversation was the last time a loop looked. Measured
    // from the page, never declared — and stored so the screen can show it without
    // opening a browser.
    ['projects', 'judge_messages_seen', 'INTEGER'],
    ['projects', 'judge_seen_at', 'TEXT'],
    // What KIND of AI this is, beyond what it can do. A model that writes code, a
    // machine rented by the hour, an image service and a 3D generator are not
    // interchangeable, and a mission that treats them alike wastes one of them.
    ['agents', 'kind', 'TEXT'],
    // A brief that is about one objective rather than about new work.
    ['briefs', 'objective_id', 'INTEGER'],
    // Whether a recorded cost means anything, or whether nothing priced it.
    ['passages', 'cost_known', 'INTEGER NOT NULL DEFAULT 1'],
    ['passages', 'model', 'TEXT'],
    ['passages', 'tokens_in', 'INTEGER'],
    ['passages', 'tokens_out', 'INTEGER'],
    ['passages', 'tokens_cached', 'INTEGER'],
    // Which gate rule this decision lifts, on its objective alone. NULL for the
    // ordinary decisions, which lift nothing.
    ['decisions', 'waives', 'TEXT'],
    /**
     * Is this project being worked on right now?
     *
     * Four projects were registered and two were being worked on, so half of
     * what the dashboard called "waiting on you" was waiting on a decision
     * nobody intended to take this month. A queue that includes work you have
     * set aside stops being a queue: you learn to skim it, and then you skim the
     * line that mattered. Existing projects default to active — nothing is
     * hidden by an upgrade.
     */
    ['projects', 'active', 'INTEGER NOT NULL DEFAULT 1'],
  ]

  for (const [table, column, type] of additions) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  /**
   * Rows recorded before the column existed claim to be priced, because that is
   * what its default says. Tokens burned with a cost of exactly zero were not
   * priced by anything — nobody spends a million tokens for free — so they are
   * corrected once. Idempotent by construction: after this they no longer match.
   */
  db.exec(
    "UPDATE passages SET cost_known = 0 WHERE cost_known = 1 AND tokens > 0 AND cost_usd = 0",
  )

  renameLegacyColumns(db)
  translateStoredKeys(db)
}

/**
 * Columns renamed when the project switched to English. `CREATE TABLE IF NOT
 * EXISTS` does not touch a table that exists: without this pass, the query would
 * target `bytes` on a database that still has `octets`, and uploading proofs
 * would fail the day someone used it — not before.
 */
function renameLegacyColumns(db) {
  // The name on the LEFT is data, not an identifier: it is the historic French
  // name we still look for on existing databases.
  const renames = [['evidence_remotes', 'octets', 'bytes']]

  for (const [table, from, to] of renames) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (cols.includes(from) && !cols.includes(to)) {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`)
    }
  }

  translateRoleValues(db)
  widenHaltReasons(db)
  widenRunModes(db)
  widenAgentKinds(db)
  translatePermissionLabels(db)
  translateAgentLabels(db)
}

/**
 * A CHECK constraint cannot be altered, and `CREATE TABLE IF NOT EXISTS` will not
 * rewrite a table that exists — so a new halt reason is rejected on every database
 * that predates it, silently, at the moment someone needs it. The table has to be
 * rebuilt, from the schema rather than from string surgery on the old definition.
 */
/**
 * Rebuild a table from schema.sql, carrying its rows across.
 *
 * A CHECK constraint cannot be altered, and `CREATE TABLE IF NOT EXISTS` does
 * not rewrite a table that already exists — so a new allowed value is refused by
 * a constraint written months ago. Rebuilding is the only way through. `marker`
 * is the new value: finding it in the stored DDL means the work is already done.
 */
function rebuildTable(db, name, marker) {
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)?.sql
  if (!existing || existing.includes(marker)) return

  const schema = readFileSync(join(here, 'schema.sql'), 'utf8')
  const target = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`).exec(schema)?.[0]
  if (!target) return

  const old = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name)

  db.exec('PRAGMA foreign_keys = OFF')
  db.transaction(() => {
    db.exec(target.replace(`IF NOT EXISTS ${name}`, `${name}_migrated`))
    const shared = db
      .prepare(`PRAGMA table_info(${name}_migrated)`)
      .all()
      .map((c) => c.name)
      .filter((c) => old.includes(c))
    db.exec(
      `INSERT INTO ${name}_migrated (${shared.join(',')}) SELECT ${shared.join(',')} FROM ${name}`,
    )
    db.exec(`DROP TABLE ${name}`)
    db.exec(`ALTER TABLE ${name}_migrated RENAME TO ${name}`)
  })()
  db.exec('PRAGMA foreign_keys = ON')
}

/**
 * Permission families and their notes are STORED VALUES shown on screen.
 *
 * The translation pass renamed identifiers and code strings and stopped there,
 * so an English interface presented “Outils de base”, “Interdits” and four
 * sentences of French to anyone who opened Permissions. Matched on the exact
 * old text: a value already translated, or one someone wrote themselves, is
 * left alone.
 */
function translateAgentLabels(db) {
  // Same oversight, one table over: labels and capabilities are stored values the
  // screen prints. `juge` also outlived the role rename, so the wiring view
  // announced a capability spelled in a language nothing else on the page uses.
  const labels = {
    'GPT (conversation qui pilote)': 'GPT (the driving conversation)',
    'RunPod (génération 3D)': 'RunPod (3D generation)',
    'Nano Banana (images, web)': 'Nano Banana (images, web interface)',
  }
  const set = db.prepare('UPDATE agents SET label = ? WHERE label = ?')
  db.transaction(() => {
    for (const [from, to] of Object.entries(labels)) set.run(to, from)
    for (const a of db.prepare('SELECT id, capabilities FROM agents').all()) {
      if (!a.capabilities?.includes('"juge"')) continue
      db.prepare('UPDATE agents SET capabilities = ? WHERE id = ?').run(
        a.capabilities.replace('"juge"', '"judge"'),
        a.id,
      )
    }
  })()
}

function translatePermissionLabels(db) {
  const labels = {
    'Outils de base': 'Core tools',
    Interdits: 'Never',
    'Interdits absolus': 'Never',
  }
  const notes = {
    'Lecture, ecriture et shell non destructif.': 'Reading, writing, and a shell that destroys nothing.',
    'Autorise en non interactif : une session pilotee par le relais ne peut demander aucune validation. Les gardes s appliquent apres, sur le diff.':
      'Allowed unattended: a session driven by the relay cannot ask for approval. The guards apply afterwards, on the diff.',
    'Pousser, taguer, supprimer, elever les privileges, builder ou toucher aux paquets : jamais sans toi.':
      'Pushing, tagging, deleting, elevating privileges, building or touching packages: never without you.',
    'sort du dépôt ou ne se rattrape pas': 'leaves the repository, or cannot be taken back',
  }
  const set = db.prepare('UPDATE permissions SET label = ? WHERE label = ?')
  const setNote = db.prepare('UPDATE permissions SET note = ? WHERE note = ?')
  db.transaction(() => {
    for (const [from, to] of Object.entries(labels)) set.run(to, from)
    for (const [from, to] of Object.entries(notes)) setNote.run(to, from)
  })()
}

function widenHaltReasons(db) {
  rebuildTable(db, 'halts', "'not_converging'")
}

/** `judge` renews the driving conversation — a mode the original CHECK forbade. */
/** `source` — asset libraries — was not an allowed kind when agents was created. */
function widenAgentKinds(db) {
  rebuildTable(db, 'agents', "'source'")
}

function widenRunModes(db) {
  rebuildTable(db, 'runs', "'judge'")
}

/**
 * An agent's role is a STORED VALUE, not an identifier: the code only recognises
 * `judge` now, so a row left at `juge` would make the judge vanish from the
 * screen without a single error.
 *
 * And a CHECK constraint cannot be altered: `CREATE TABLE IF NOT EXISTS` does not
 * rewrite a table that exists, so the old constraint survives and refuses the new
 * value. The only way through is to rebuild the table.
 */
function translateRoleValues(db) {
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'")
    .get()?.sql

  if (!existing || !existing.includes("'juge'")) return

  // The target table comes from the SCHEMA, not from rewriting the old one.
  // Deriving the new from the old by string surgery produced a constraint that
  // accepted neither value: there is one source of truth, and it is schema.sql.
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8')
  const target = /CREATE TABLE IF NOT EXISTS agents \([\s\S]*?\n\);/.exec(schema)?.[0]
  if (!target) return

  const oldColumns = db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name)

  db.exec('PRAGMA foreign_keys = OFF')
  db.transaction(() => {
    db.exec(target.replace('IF NOT EXISTS agents', 'agents_migrated'))

    // We only copy columns present on both sides, and the conversion happens
    // INSIDE the copy: afterwards, the new constraint would already refuse `juge`.
    const shared = db
      .prepare('PRAGMA table_info(agents_migrated)')
      .all()
      .map((c) => c.name)
      .filter((c) => oldColumns.includes(c))

    const source = shared
      .map((c) => (c === 'role' ? "CASE WHEN role = 'juge' THEN 'judge' ELSE role END" : c))
      .join(',')

    db.exec(`INSERT INTO agents_migrated (${shared.join(',')}) SELECT ${source} FROM agents`)
    db.exec('DROP TABLE agents')
    db.exec('ALTER TABLE agents_migrated RENAME TO agents')
  })()
  db.exec('PRAGMA foreign_keys = ON')
}

/**
 * The same keys, but inside JSON already written to the database. A memory scan
 * carries `titre`/`contexte`/`projets`; the code now reads
 * `title`/`context`/`projects`. Without a rewrite the screen renders EMPTY with
 * no error at all — the worst possible case, and one we have already lived.
 */
function translateStoredKeys(db) {
  // The keys on the LEFT are data — the French names actually written to the
  // database. Translating them here, as an automatic rename did once, turns the
  // migration into a no-op: it passes without fixing anything, and the failure
  // shows up on somebody else's machine.
  const KEYS = {
    octets: 'bytes',
    projects: 'projects',
    nombre: 'count',
    files: 'files',
    nom: 'name',
    titre: 'title',
    contexte: 'context',
    contraintes: 'constraints',
    perime: 'stale',
    sources_nombre: 'sources_count',
    laisses_nombre: 'skipped_count',
    releve_sous: 'written_to',
  }

  const translate = (value) => {
    if (Array.isArray(value)) return value.map(translate)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [KEYS[k] ?? k, translate(v)]))
    }
    return value
  }

  const rows = db
    .prepare("SELECT id, inventory, result FROM scans WHERE inventory LIKE '%projets%' OR result LIKE '%titre%'")
    .all()

  for (const r of rows) {
    const inv = r.inventory ? JSON.stringify(translate(JSON.parse(r.inventory))) : null
    const res = r.result ? JSON.stringify(translate(JSON.parse(r.result))) : null
    db.prepare('UPDATE scans SET inventory = ?, result = ? WHERE id = ?').run(inv, res, r.id)
  }
}
