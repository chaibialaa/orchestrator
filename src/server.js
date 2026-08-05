import express from 'express'
import { execFileSync } from 'node:child_process'
const { X_OK } = constants
import { existsSync, statSync, createReadStream, accessSync, constants, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve as path, join, extname, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { base, json, nowStamp, dbPath as dbPathOf } from './db/index.js'
import { evaluateGate, canStart, HUMAN_HALTS, WAIVABLE, requiresVisual } from './gate.js'
import { encrypt, decrypt, keyHint } from './crypto.js'
import { upload, checkStorage, createDriveFolder } from './storage.js'
import { blockersFor } from './blockers.js'
import { attention, attentionFor, nextStep, nextStepForObjective, choices } from './attention.js'
import { charts } from './charts.js'
import { live } from './live.js'

/**
 * Errands the worker knows how to run. A whitelist rather than a command: the
 * server holds a NAME, and what that name does lives on the machine that has the
 * repository — which is the only place it could be decided anyway.
 */
const KNOWN_CHORES = ['open_unity', 'open_judge_browser']
import { signedIn, judgeHealth, startJudgeBrowser } from './agent/relay.js'
import { mcpServers } from './mcp.js'
import {
  consentUrl,
  exchangeCode,
  accountOf,
  openPendingAuth,
  closePendingAuth,
  oauthAppPresent,
  PROVIDER_OF,
} from './oauth.js'

const here = dirname(fileURLToPath(import.meta.url))
const db = () => base()

/** A business error states itself plainly and returns a code, not a stack trace. */
class Rejected extends Error {
  constructor(message, code = 422, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

const projectBy = (slug) => {
  const p = db().prepare('SELECT * FROM projects WHERE slug = ? OR id = ?').get(slug, slug)
  if (!p) throw new Rejected('This project does not exist.', 404)
  return p
}

const objectiveBy = (id) => {
  // The project's name travels with it. Without it a page showing one objective
  // could not offer to run it — every control needs the slug, and the page had
  // only a numeric project_id, which addresses nothing.
  const o = db()
    .prepare(
      `SELECT o.*, p.slug AS project, p.name AS project_name
       FROM objectives o JOIN projects p ON p.id = o.project_id WHERE o.id = ?`,
    )
    .get(id)
  if (!o) throw new Rejected('This objective does not exist.', 404)
  return o
}

const nombre = (v, fallback = null) => (v === undefined || v === null || v === '' ? fallback : Number(v))
const texte = (v) => (v === undefined ? undefined : v === null ? null : String(v))

/** JSON columns come out decoded, booleans come out as booleans. */
function sortirObjectif(o) {
  return o
}

function sortirPassage(p) {
  return p && { ...p, tools_used: json.read(p.tools_used), prevented: Boolean(p.prevented) }
}

function sortirPreuve(e) {
  // `csv` and `log` were missing, so the central deliverable of a measuring
  // chapter — its table of numbers — was not counted as a file at all, and sat
  // in the findings list looking like an unjudged remark.
  const chemins = [
    ...String(e.ref ?? '').matchAll(/[\w./-]+\.(?:png|jpe?g|webp|md|json|txt|csv|log|unity)/g),
  ].map((m) => m[0])
  return { ...e, payload: json.read(e.payload), files: chemins }
}

/**
 * The path of a proof that can actually be uploaded, or null.
 *
 * `ref` holds two different kinds of thing: sometimes a file path, sometimes the
 * criterion text or a score label. Only the first can travel, and only if the
 * file exists and stays under its project's repository.
 */
function uploadablePath(candidate) {
  if (!candidate.repo_path) return null
  const rel = sortirPreuve(candidate).files[0]
  if (!rel) return null
  const absolute = path(candidate.repo_path, rel)
  if (!absolute.startsWith(path(candidate.repo_path) + '/')) return null
  return existsSync(absolute) ? rel : null
}

function sortirAgent(a) {
  const { api_key, ...reste } = a
  return {
    ...reste,
    enabled: Boolean(a.enabled),
    settings: json.read(a.settings),
    capabilities: json.read(a.capabilities, []),
    has_key: Boolean(api_key),
    key_hint: keyHint(api_key),
  }
}

const sortirBrief = (b) => b && { ...b, proposal: json.read(b.proposal) }

/** How many attempts an objective has behind it. */
const passagesCount = (id) =>
  db().prepare('SELECT COUNT(*) n FROM passages WHERE objective_id = ?').get(id).n

/** Where the proofs stood at the moment of a halt: the "nothing new" watermark. */
const evidenceWatermark = (objectifId) =>
  db().prepare('SELECT COALESCE(MAX(id),0) m FROM evidences WHERE objective_id = ?').get(objectifId).m

export function createServer() {
  const app = express()
  app.use(express.json({ limit: '32mb' }))

  // The front end and the API can be served from two ports in development.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Headers', 'Content-Type')
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  const api = express.Router()

  // ---- projets ------------------------------------------------------------

  /**
   * `active` as a boolean, here as everywhere.
   *
   * SQLite has no boolean: the column comes back as 0 or 1, and a screen
   * comparing `active === false` never matched — so the button read "active" on
   * a project that was set aside, and pressing it set it aside again. Nothing
   * moved on screen, which is exactly what a person reports as "the button does
   * nothing". The dashboard already converted; the list did not.
   */
  api.get('/projects', (_req, res) =>
    res.json(
      db()
        .prepare('SELECT * FROM projects ORDER BY name')
        .all()
        .map((p) => ({ ...p, active: Boolean(p.active) })),
    ),
  )

  /**
   * The objective list carries everything the screen needs without inferring it:
   * who is working RIGHT NOW, when it last moved, which halt is open, who did the
   * work. Without these columns, the screen presented three chains as three open
   * fronts.
   */
  /**
   * Declare a project.
   *
   * Until now this could only be done by hand in the database, or as a side effect
   * of distilling memories — so the one thing you need before anything else works
   * was the one thing the screen could not do.
   *
   * The repository path is checked against the disk. A wrong path breaks
   * everything downstream in silence: proofs resolve to nothing, deliverables are
   * never found, and the tool reports an empty project rather than a broken one.
   */
  api.post('/projects', (req, res) => {
    const b = req.body ?? {}
    const slug = String(b.slug ?? '').trim()
    const name = String(b.name ?? '').trim()

    if (!name) throw new Rejected('A project must have a name.')
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      throw new Rejected('Invalid project id: lowercase letters, digits and hyphens, 2 to 40 characters.')
    }
    if (db().prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) {
      throw new Rejected(`Project “${slug}” already exists.`)
    }
    if (b.repo_path && !existsSync(String(b.repo_path))) {
      throw new Rejected(`This repository does not exist on this machine: ${b.repo_path}`)
    }
    if (b.gate_judge && !['human', 'agent', 'gpt', 'self'].includes(b.gate_judge)) {
      throw new Rejected('Unknown judge: human, agent, gpt or self.')
    }

    const r = db()
      .prepare(
        `INSERT INTO projects (slug, name, repo_path, gate_judge, judge_agent, judge_url, judge_message_cap)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        slug,
        name,
        b.repo_path?.trim() || null,
        b.gate_judge ?? 'gpt',
        b.judge_agent ?? 'gpt',
        b.judge_url?.trim() || null,
        Number(b.judge_message_cap ?? 40),
      )

    res.status(201).json(db().prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid))
  })

  api.patch('/projects/:slug', (req, res) => {
    const p = projectBy(req.params.slug)
    const b = req.body ?? {}
    if (b.gate_judge && !['human', 'agent', 'gpt', 'self'].includes(b.gate_judge)) {
      throw new Rejected('Unknown judge: human, agent, gpt or self.')
    }
    const fields = {}
    for (const k of ['name', 'repo_path', 'gate_judge', 'judge_agent', 'judge_url']) {
      if (k in b) fields[k] = b[k]?.toString().trim() || null
    }
    if ('judge_message_cap' in b) fields.judge_message_cap = Number(b.judge_message_cap) || 40
    // Set aside, or picked back up. Nothing is deleted and nothing stops running:
    // an inactive project simply stops filling the queue of what waits on a person.
    if ('active' in b) fields.active = b.active ? 1 : 0
    // Reported by a loop that just looked at the page. Never typed by anyone.
    if ('judge_messages_seen' in b) {
      fields.judge_messages_seen = Number(b.judge_messages_seen) || 0
      fields.judge_seen_at = nowStamp()
    }
    if (fields.repo_path && !existsSync(fields.repo_path)) {
      throw new Rejected(`This repository does not exist on this machine: ${fields.repo_path}`)
    }
    const names = Object.keys(fields)
    if (names.length) {
      db()
        .prepare(`UPDATE projects SET ${names.map((n) => `${n} = @${n}`).join(', ')}, updated_at = @now WHERE id = @id`)
        .run({ ...fields, now: nowStamp(), id: p.id })
    }
    // Same shape as the list: a PATCH that answered with an integer put the
    // screen back into the state it had just left.
    const saved = db().prepare('SELECT * FROM projects WHERE id = ?').get(p.id)
    res.json({ ...saved, active: Boolean(saved.active) })
  })

  api.get('/projects/:slug/objectives', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json(
      db()
        .prepare(
          `SELECT o.*,
            (SELECT COUNT(*) FROM passages  WHERE objective_id = o.id) AS passages_count,
            (SELECT COUNT(*) FROM evidences WHERE objective_id = o.id) AS evidences_count,
            (SELECT COUNT(*) FROM halts     WHERE objective_id = o.id AND resolved_at IS NULL) AS open_halts_count,
            (SELECT MAX(started_at) FROM passages WHERE objective_id = o.id AND ended_at IS NULL) AS live_since,
            (SELECT MAX(started_at) FROM passages WHERE objective_id = o.id) AS last_activity,
            (SELECT reason FROM halts WHERE objective_id = o.id AND resolved_at IS NULL ORDER BY id DESC LIMIT 1) AS halt_reason,
            (SELECT GROUP_CONCAT(DISTINCT harness) FROM passages WHERE objective_id = o.id) AS harnesses,
            (SELECT session_id FROM passages WHERE objective_id = o.id AND session_id IS NOT NULL
              ORDER BY started_at DESC LIMIT 1) AS last_session,
            (SELECT COUNT(*) FROM evidences WHERE objective_id = o.id AND ref IS NOT NULL
              AND type IN ('render','screenshot','diff')) AS artifacts_count
          FROM objectives o WHERE o.project_id = ?
          ORDER BY o.priority, o.id DESC`,
        )
        .all(p.id)
        .map(sortirObjectif),
    )
  })

  /**
   * The project as a tree: the chapter that was asked for, the steps under it,
   * and every attempt each step took — successes and failures alike.
   *
   * The screen used to draw a single line per chapter, which hides the shape of
   * the work: eleven attempts on one step and one on the next look identical on a
   * line. Where effort actually went, and where it kept failing, is branching —
   * so the data has to arrive branched.
   *
   * One query per level, not one per node: a tree of thirty nodes must not cost
   * thirty round trips.
   */
  api.get('/projects/:slug/tree', (req, res) => {
    const p = projectBy(req.params.slug)

    const objectives = db()
      .prepare(
        `SELECT o.id, o.parent_id, o.title, o.status, o.priority, o.blast_radius, o.proof_spec,
                (SELECT MAX(started_at) FROM passages WHERE objective_id = o.id AND ended_at IS NULL) AS live_since,
                (SELECT reason FROM halts WHERE objective_id = o.id AND resolved_at IS NULL ORDER BY id DESC LIMIT 1) AS halt_reason,
                (SELECT COUNT(*) FROM evidences WHERE objective_id = o.id AND ref IS NOT NULL
                  AND type IN ('render','screenshot','diff')) AS artifacts_count
         FROM objectives o WHERE o.project_id = ? ORDER BY o.priority, o.id`,
      )
      .all(p.id)

    const attempts = db()
      .prepare(
        `SELECT pa.id, pa.objective_id, pa.harness, pa.verdict, pa.prevented, pa.cost_usd, pa.tokens,
                pa.started_at, pa.ended_at, pa.summary,
                (SELECT COUNT(*) FROM evidences WHERE passage_id = pa.id AND ref IS NOT NULL) AS files
         FROM passages pa
         WHERE pa.objective_id IN (SELECT id FROM objectives WHERE project_id = ?)
         ORDER BY pa.id`,
      )
      .all(p.id)

    const byObjective = {}
    for (const a of attempts) (byObjective[a.objective_id] ??= []).push(a)

    res.json({
      project: { slug: p.slug, name: p.name },
      objectives: objectives.map((o) => ({ ...o, attempts: byObjective[o.id] ?? [] })),
    })
  })

  // ---- runs: what the interface asks for, a local worker carries out ---------

  const publicRun = (r) =>
    r && {
      ...r,
      post: Boolean(r.post),
      hold_between_turns: Boolean(r.hold_between_turns),
      cancel_asked: Boolean(r.cancel_asked),
      jump: Boolean(r.jump),
      alongside: Boolean(r.alongside),
      series_stops_on_failure: Boolean(r.series_stops_on_failure),
    }

  api.get('/runs', (req, res) => {
    const slug = req.query.project
    const p = slug ? projectBy(String(slug)) : null
    res.json(
      db()
        .prepare(
          `SELECT r.*, o.title AS objective_title, pr.slug AS project
           FROM runs r
           JOIN projects pr ON pr.id = r.project_id
           LEFT JOIN objectives o ON o.id = r.objective_id
           ${p ? 'WHERE r.project_id = @project' : ''}
           ORDER BY r.id DESC LIMIT 25`,
        )
        .all(p ? { project: p.id } : {})
        .map(publicRun),
    )
  })

  api.post('/projects/:slug/runs', (req, res) => {
    const p = projectBy(req.params.slug)
    const b = req.body ?? {}

    const mode = b.mode ?? 'chapter'
    if (!['chapter', 'plan', 'judge'].includes(mode)) {
      throw new Rejected('Unknown run mode: chapter, plan or judge.')
    }

    // The column is `objective_id`, the field was `objective`, and a request that
    // named the wrong one was accepted, queued, claimed, and only then failed —
    // in a worker log, on a usage message. Take either, and refuse at the door
    // what cannot possibly run.
    b.objective = b.objective ?? b.objective_id ?? null
    if (mode === 'chapter' && !b.objective) {
      throw new Rejected('A chapter run needs an objective to work on.')
    }

    /**
     * Two passes on the same PROJECT touch the same working tree.
     *
     * The guard below only ever covered the same objective, which misses the case
     * that actually hurts: two objectives of one project, two agents, one
     * checkout. They overwrite each other's edits, and each one's `git status`
     * charges it for what the other left lying around.
     *
     * Refused rather than warned — a warning on a screen nobody is watching at
     * three in the morning is not a guard. Queue it `alongside` to take the risk
     * knowingly; the mission is then told what the other pass is holding.
     */
    if (mode === 'chapter' && !b.alongside) {
      const busyElsewhere = db()
        .prepare(
          `SELECT r.id, r.objective_id, o.title
           FROM runs r LEFT JOIN objectives o ON o.id = r.objective_id
           WHERE r.project_id = ? AND r.mode = 'chapter' AND r.status IN ('pending','running')
             AND (r.objective_id IS NULL OR r.objective_id != ?)`,
        )
        .get(p.id, b.objective ?? -1)
      if (busyElsewhere) {
        throw new Rejected(
          `Another pass is already working this repository — run #${busyElsewhere.id} on ` +
            `#${busyElsewhere.objective_id} “${busyElsewhere.title ?? ''}”. Two agents in one ` +
            `checkout overwrite each other's edits. Wait for it to finish, or queue this one ` +
            `alongside on purpose.`,
        )
      }
    }

    /**
     * An objective that is not converging is not queued again.
     *
     * `canStart` already refuses this when the attempt opens, but by then the
     * harness has been launched and the session paid for. Refusing at the door
     * costs nothing and says the same thing earlier — and it records the halt,
     * so the reason appears on the overview instead of only in a worker log.
     */
    if (mode === 'chapter' && b.objective) {
      const start = canStart(b.objective)
      if (!start.ok && start.reason === 'not_converging') {
        const open = db()
          .prepare(
            "SELECT id FROM halts WHERE objective_id = ? AND reason = 'not_converging' AND resolved_at IS NULL",
          )
          .get(b.objective)
        if (!open) {
          db()
            .prepare('INSERT INTO halts (objective_id, reason, detail) VALUES (?,?,?)')
            .run(b.objective, 'not_converging', start.detail)
        }
        throw new Rejected(start.detail, 409, { gate: start })
      }
    }

    // One run per objective at a time. Two loops on the same objective fight over
    // the same repository and the same conversation — which happened, and cost a
    // Unity scene.
    // A judge renewal carries the objective only to clear its halt afterwards —
    // it does not work on it, so it must not queue behind it.
    if (b.objective && mode !== 'judge') {
      const busy = db()
        .prepare(
          "SELECT id FROM runs WHERE objective_id = ? AND mode != 'judge' AND status IN ('pending','running')",
        )
        .get(b.objective)
      if (busy) throw new Rejected(`A run is already queued or running on this objective (#${busy.id}).`)
    }

    const r = db()
      .prepare(
        `INSERT INTO runs (project_id, objective_id, mode, max_turns, budget,
                           budget_without_progress, post, hold_between_turns, jump, reason, alongside)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        b.objective ?? null,
        mode,
        Number(b.max_turns ?? 8),
        b.budget ? Number(b.budget) : null,
        Number(b.budget_without_progress ?? 120),
        b.post === false ? 0 : 1,
        b.hold_between_turns ? 1 : 0,
        // Slipped in front of what is already waiting. It does not interrupt the
        // run in flight — that one finishes; this one goes next. When a loop has
        // just broken something, the fix cannot wait behind six queued chapters.
        b.jump ? 1 : 0,
        b.reason?.toString().trim() || null,
        b.alongside ? 1 : 0,
      )

    res.status(201).json(publicRun(db().prepare('SELECT * FROM runs WHERE id = ?').get(r.lastInsertRowid)))
  })

  /** A worker claims the oldest pending run for a project. Atomic: two workers
   *  polling at the same second must not both take it. */
  /**
   * Queue a series of objectives in one go.
   *
   * The queue could only ever take one at a time, so running a chapter of eight
   * steps meant coming back eight times — which is the interruption this tool
   * exists to remove. They are queued in the order given and the worker takes
   * them one after another.
   *
   * Sequential, and only sequential. Two passes in one working tree overwrite
   * each other's edits, so "run them in parallel" is not a mode this can offer
   * honestly on a single repository; what it can offer is not needing anyone
   * between one step and the next.
   *
   * `stop_on_failure` is the real choice: carry on down the list when a step
   * fails, or stop there. Stopping is the default — a step that failed is often
   * the reason the next one cannot work either.
   */
  api.post('/projects/:slug/runs/series', (req, res) => {
    const p = projectBy(req.params.slug)
    const ids = Array.isArray(req.body?.objectives) ? req.body.objectives.map(Number).filter(Boolean) : []
    if (!ids.length) throw new Rejected('Which objectives should run?')
    if (ids.length > 40) throw new Rejected('Forty at a time at most — queue the rest afterwards.')

    // Everything is checked BEFORE anything is queued: half a series is worse
    // than none, because the half that ran has already been paid for.
    const refused = []
    for (const id of ids) {
      const o = db().prepare('SELECT id, project_id, title FROM objectives WHERE id = ?').get(id)
      if (!o || o.project_id !== p.id) {
        refused.push({ objective: id, why: 'not an objective of this project' })
        continue
      }
      const start = canStart(id)
      if (!start.ok) refused.push({ objective: id, title: o.title, why: start.detail })
    }
    if (refused.length) {
      throw new Rejected(
        `${refused.length} of ${ids.length} cannot start: ` +
          refused.map((r) => `#${r.objective} ${r.why}`).join(' · '),
        409,
        { refused },
      )
    }

    const busy = db()
      .prepare(
        "SELECT id FROM runs WHERE project_id = ? AND mode = 'chapter' AND status IN ('pending','running')",
      )
      .get(p.id)
    if (busy && !req.body?.alongside) {
      throw new Rejected(
        `A pass is already queued or running on this repository (run #${busy.id}). ` +
          'Wait for it, or queue this series alongside on purpose.',
      )
    }

    const b = req.body ?? {}
    const insert = db().prepare(
      `INSERT INTO runs (project_id, objective_id, mode, max_turns, budget,
                         budget_without_progress, post, hold_between_turns, jump, reason, alongside, series_stops_on_failure)
       VALUES (?,?,'chapter',?,?,?,?,?,0,?,?,?)`,
    )
    const made = db().transaction(() =>
      ids.map((id) =>
        Number(
          insert.run(
            p.id,
            id,
            Number(b.max_turns ?? 8),
            b.budget ? Number(b.budget) : null,
            Number(b.budget_without_progress ?? 120),
            b.post === false ? 0 : 1,
            b.hold_between_turns ? 1 : 0,
            b.reason?.toString().trim() || null,
            b.alongside ? 1 : 0,
            b.stop_on_failure === false ? 0 : 1,
          ).lastInsertRowid,
        ),
      ),
    )()

    res.status(201).json({ queued: made, objectives: ids })
  })

  api.post('/projects/:slug/runs/claim', (req, res) => {
    const p = projectBy(req.params.slug)
    const taken = db().transaction(() => {
      const r = db()
        .prepare(
          `SELECT * FROM runs WHERE project_id = ? AND status = 'pending'
           ORDER BY jump DESC, id LIMIT 1`,
        )
        .get(p.id)
      if (!r) return null
      db()
        .prepare("UPDATE runs SET status='running', machine=?, pid=?, taken_at=? WHERE id=?")
        .run(req.body?.machine ?? null, req.body?.pid ?? null, nowStamp(), r.id)
      return db().prepare('SELECT * FROM runs WHERE id = ?').get(r.id)
    })()
    res.json({ run: publicRun(taken) })
  })

  /**
   * A run is carried by a worker process. If that process is gone — restarted,
   * killed, crashed — nothing is carrying the run, and leaving it `running`
   * blocks its objective for good: the "one run per objective" guard refuses
   * every new one. So a worker releases the machine's orphans when it starts.
   */
  /**
   * Which runs this machine is on the hook for, and which process carries each.
   * Only the machine itself can tell whether those processes are still alive, so
   * that judgement is made there and reported back.
   */
  /**
   * Runs this HOST is carrying — not this identity.
   *
   * A worker used to be known by its hostname, and is now known by
   * `hostname-xxxxxx` so that a laptop keeps one name across networks. Matching
   * the identity exactly means every run recorded under the previous scheme is
   * orphaned for good: no worker ever claims it, no worker ever releases it, and
   * it reads `running` forever while its process is long dead. Run 59 sat like
   * that, holding a worker slot, with nothing on any screen able to explain it.
   *
   * The host is the thing that can answer "is that pid alive", so the host is
   * what this asks about.
   */
  api.get('/runs/carried', (req, res) => {
    const machine = req.query.machine
    if (!machine) throw new Rejected('Which machine?')
    const host = String(req.query.host ?? machine).trim()

    /**
     * The name this machine had when its identity was minted.
     *
     * The hostname changes — a laptop on a different network answers to
     * something else entirely, which is why identities were made stable in the
     * first place. So the current hostname is no help in recognising runs
     * recorded months ago: this host answered to `M1-Pro---Alaa-Chaibi.local`
     * this morning and to `MacBookPro` this evening. The stable id carries that
     * old name inside it — `hostname-xxxxxx` — so it is the one durable link
     * back to whatever this machine used to be called.
     */
    const born = String(machine).replace(/-[a-z0-9]{6}$/, '')

    res.json({
      runs: db()
        .prepare(
          `SELECT id, pid, objective_id FROM runs
           WHERE status = 'running'
             AND (machine = @machine OR machine = @host OR machine = @born
                  OR machine LIKE @host || '-%' OR machine LIKE @born || '-%')`,
        )
        .all({ machine, host, born }),
    })
  })

  /**
   * Release runs nothing is carrying any more.
   *
   * This used to close every run on the machine, on the theory that a starting
   * worker was the only process there. Two workers share this machine, so that
   * theory had a starting worker killing its neighbour's live pass. Ids only, and
   * only ones the caller has established are dead.
   */
  api.post('/runs/release', (req, res) => {
    const machine = req.body?.machine
    const host = String(req.body?.host ?? machine ?? '').trim()
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null
    if (!machine) throw new Rejected('Which machine is releasing its runs?')
    if (!ids?.length) return res.json({ released: [] })

    // Same rule as `/runs/carried`: the host, not the identity. Releasing on a
    // narrower rule than the one that listed them would hand a worker a list it
    // is then refused permission to act on. Ids are already numbers, so they go
    // in the text — better-sqlite3 refuses named and positional in one statement.
    const inIds = ids.join(',')
    const born = String(machine).replace(/-[a-z0-9]{6}$/, '')
    const mine = `status='running' AND id IN (${inIds})
                  AND (machine=@machine OR machine=@host OR machine=@born
                       OR machine LIKE @host || '-%' OR machine LIKE @born || '-%')`

    const orphans = db().prepare(`SELECT id FROM runs WHERE ${mine}`).all({ machine, host, born })
    db()
      .prepare(
        `UPDATE runs SET status='failed', error='the process carrying it is gone', ended_at=@at
         WHERE ${mine}`,
      )
      .run({ machine, host, born, at: nowStamp() })
    res.json({ released: orphans.map((o) => o.id) })
  })

  api.patch('/runs/:id', (req, res) => {
    const r = db().prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id)
    if (!r) throw new Rejected('This run does not exist.', 404)
    const b = req.body ?? {}
    const fields = {}
    for (const k of ['status', 'turn', 'note', 'error', 'ended_at', 'outcome']) if (k in b) fields[k] = b[k]
    if ('hold_between_turns' in b) fields.hold_between_turns = b.hold_between_turns ? 1 : 0
    if (fields.status && ['done', 'failed', 'cancelled'].includes(fields.status) && !fields.ended_at) {
      fields.ended_at = nowStamp()
    }
    const names = Object.keys(fields)
    if (names.length) {
      db()
        .prepare(`UPDATE runs SET ${names.map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`)
        .run({ ...fields, id: r.id })
    }

    /**
     * A step of a series failed, and the rest was queued behind it.
     *
     * Left alone, the queue would spend on every following step against ground
     * that has just moved — and the failure would be discovered eight times
     * rather than once. Only what is still waiting is dropped: a run already in
     * flight has been paid for and finishes.
     */
    if (r.series_stops_on_failure && ['failed', 'cancelled'].includes(fields.status)) {
      const dropped = db()
        .prepare(
          `SELECT id FROM runs WHERE project_id = ? AND status = 'pending'
             AND series_stops_on_failure = 1 AND id > ?`,
        )
        .all(r.project_id, r.id)
      if (dropped.length) {
        db()
          .prepare(
            `UPDATE runs SET status='cancelled', ended_at=?,
                    error='the step before it failed, and the series was set to stop there'
             WHERE project_id=? AND status='pending' AND series_stops_on_failure=1 AND id > ?`,
          )
          .run(nowStamp(), r.project_id, r.id)
      }
    }

    res.json(publicRun(db().prepare('SELECT * FROM runs WHERE id = ?').get(r.id)))
  })

  /** Asking to stop is not stopping: the worker sees the flag between two turns
   *  and finishes what it is doing. Killing mid-session would lose paid work. */
  api.post('/runs/:id/cancel', (req, res) => {
    const r = db().prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id)
    if (!r) throw new Rejected('This run does not exist.', 404)
    if (r.status === 'pending') {
      db().prepare("UPDATE runs SET status='cancelled', ended_at=? WHERE id=?").run(nowStamp(), r.id)
    } else {
      db().prepare('UPDATE runs SET cancel_asked=1 WHERE id=?').run(r.id)
    }
    res.json(publicRun(db().prepare('SELECT * FROM runs WHERE id = ?').get(r.id)))
  })

  /** "Carry on" — the answer to a run holding between turns. */
  api.post('/runs/:id/continue', (req, res) => {
    const r = db().prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id)
    if (!r) throw new Rejected('This run does not exist.', 404)
    db().prepare("UPDATE runs SET note = NULL, hold_between_turns = 0 WHERE id = ?").run(r.id)
    res.json(publicRun(db().prepare('SELECT * FROM runs WHERE id = ?').get(r.id)))
  })

  api.get('/projects/:slug/stats', (req, res) => {
    const p = projectBy(req.params.slug)
    const objectives = db().prepare('SELECT id, status FROM objectives WHERE project_id = ?').all(p.id)
    const ids = objectives.map((o) => o.id)
    const holes = ids.length ? ids.map(() => '?').join(',') : '-1'

    const byStatus = {}
    for (const o of objectives) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1

    const conso = db()
      .prepare(
        `SELECT COALESCE(SUM(tokens),0) tokens, COALESCE(SUM(requests),0) requests,
                COALESCE(SUM(cost_usd),0) cost, COUNT(*) n
         FROM passages WHERE objective_id IN (${holes})`,
      )
      .get(...ids)

    const halts = db()
      .prepare(`SELECT reason, COUNT(*) n FROM halts WHERE objective_id IN (${holes}) GROUP BY reason`)
      .all(...ids)
    const harnais = db()
      .prepare(`SELECT harness, COUNT(*) n FROM passages WHERE objective_id IN (${holes}) GROUP BY harness`)
      .all(...ids)

    const haltPlaceholders = HUMAN_HALTS.map(() => '?').join(',')
    const countHalts = (within) =>
      db()
        .prepare(
          `SELECT COUNT(*) n FROM halts WHERE objective_id IN (${holes}) AND resolved_at IS NULL
           AND reason ${within ? 'IN' : 'NOT IN'} (${haltPlaceholders})`,
        )
        .get(...ids, ...HUMAN_HALTS).n

    res.json({
      objectives: byStatus,
      proven_ratio: objectives.length ? Number(((byStatus.proven ?? 0) / objectives.length).toFixed(3)) : 0,
      passages: conso.n,
      halts_by_reason: Object.fromEntries(halts.map((a) => [a.reason, a.n])),
      harness_split: Object.fromEntries(harnais.map((h) => [h.harness, h.n])),
      tokens: conso.tokens,
      requests: conso.requests,
      cost_usd: conso.cost,
      // Ne compte QUE ce qui exige vraiment un humain : un refus au verdict ou
      // or a stall, the loop clears them itself. Adding them up manufactured
      // une file d'attente qui n'existait pas.
      awaiting_human: countHalts(true),
      self_healing: countHalts(false),
    })
  })

  api.get('/projects/:slug/decisions', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json(
      db()
        .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at DESC')
        .all(p.id)
        .map((d) => ({ ...d, paths: json.read(d.paths, []) })),
    )
  })

  api.post('/projects/:slug/decisions', (req, res) => {
    const p = projectBy(req.params.slug)
    const { title, body, paths, objective_id, decided_at, waives } = req.body ?? {}
    if (!title?.trim()) throw new Rejected('A decision must have a title.')
    if (!body?.trim()) throw new Rejected('A decision must have a body.')

    // A waiver lifts a gate rule, so it has to name one that exists and to say
    // which objective it applies to. A typo would otherwise record a decision
    // that lifts nothing, and read afterwards as though it had.
    if (waives) {
      if (!WAIVABLE.includes(waives)) {
        throw new Rejected(
          `\`${waives}\` is not a rule this gate can lift. Those are: ${WAIVABLE.join(', ')}.`,
        )
      }
      if (!objective_id) throw new Rejected('A waiver applies to one objective — name it.')
    }

    const r = db()
      .prepare(
        `INSERT INTO decisions (project_id,objective_id,title,body,paths,decided_at,waives)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        objective_id ?? null,
        title,
        body,
        json.write(paths ?? []),
        decided_at ?? nowStamp(),
        waives ?? null,
      )
    res.status(201).json(db().prepare('SELECT * FROM decisions WHERE id = ?').get(r.lastInsertRowid))
  })

  /** What an agent must reread before acting: the project's decisions and constraints. */
  api.get('/projects/:slug/recall', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json({
      project: p,
      // Waivers are left out: they tell the gate what not to require, and an
      // agent reading "this does not require seeing" as a project constraint
      // would take it as licence to stop rendering anything.
      decisions: db()
        .prepare(
          'SELECT * FROM decisions WHERE project_id = ? AND waives IS NULL ORDER BY decided_at DESC LIMIT 30',
        )
        .all(p.id)
        .map((d) => ({ ...d, paths: json.read(d.paths, []) })),

      /**
       * The documents, finally travelling.
       *
       * The agent side already iterated `recall.resources` and printed each one
       * with its content — that loop has been there all along, reading a key this
       * route never sent. So the memory page promised "what the tool brings back
       * when a session starts", the include switch decided nothing, and the
       * consumer sat waiting on a field that did not exist.
       *
       * A small text file travels whole; anything else travels as a link, because
       * a megabyte of image in a prompt helps nobody.
       */
      resources: db()
        .prepare('SELECT * FROM resources WHERE project_id = ? AND included = 1 ORDER BY id')
        .all(p.id)
        .map((r) => {
          const absolute = r.path ? join(dirname(dbPathOf()), r.path) : null
          const present = Boolean(absolute && existsSync(absolute))
          const inline =
            present && readable(r.mime, r.name) && statSync(absolute).size <= INLINE_MAX
              ? readFileSync(absolute, 'utf8')
              : null
          return {
            name: r.name,
            summary: r.summary,
            content: inline,
            // Named rather than silently dropped: a document marked to travel and
            // missing from disk is a fact the agent should see, not a blank.
            url: present ? `/api/resources/${r.id}/raw` : null,
            missing: !present,
          }
        }),
    })
  })

  api.get('/projects/:slug/context', (req, res) => {
    const p = projectBy(req.params.slug)
    const target = String(req.query.path ?? '')
    const colle = (glob, s) =>
      new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(s) ||
      s.startsWith(glob.replace(/\*+$/, ''))

    const decisions = db()
      .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at DESC')
      .all(p.id)
      .map((d) => ({ ...d, paths: json.read(d.paths, []) }))
      .filter((d) => d.paths.some((g) => colle(g, target)))

    const blast = json.read(p.blast_globs, []).filter((g) => colle(g, target))
    res.json({ path: target, decisions, blast_radius_hit: blast, requires_human: blast.length > 0 })
  })

  // ---- objectifs ----------------------------------------------------------

  api.post('/projects/:slug/objectives', (req, res) => {
    const p = projectBy(req.params.slug)
    const b = req.body ?? {}
    if (!b.title?.trim()) throw new Rejected('An objective must have a title.')
    const blast = b.blast_radius ?? 'feature'
    if (!['cosmetic', 'feature', 'api', 'critical'].includes(blast)) {
      throw new Rejected('Rayon de souffle inconnu : cosmetic, feature, api ou critical.')
    }
    const r = db()
      .prepare(
        `INSERT INTO objectives (project_id,parent_id,title,intent,proof_spec,blast_radius,priority,status)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        b.parent_id ?? null,
        b.title,
        b.intent ?? null,
        b.proof_spec ?? null,
        blast,
        nombre(b.priority, 50),
        b.status ?? (b.proof_spec?.trim() ? 'ready' : 'draft'),
      )
    res.status(201).json(objectiveBy(r.lastInsertRowid))
  })

  api.patch('/projects/:slug/objectives/reorder', (req, res) => {
    const p = projectBy(req.params.slug)
    const ordre = req.body?.ordre
    if (!Array.isArray(ordre) || !ordre.length) throw new Rejected('No order supplied.')
    db().transaction(() => {
      for (const l of ordre) {
        db()
          .prepare('UPDATE objectives SET priority = ? WHERE id = ? AND project_id = ?')
          .run(nombre(l.priority, 50), l.id, p.id)
      }
    })()
    res.json({ ok: true })
  })

  api.get('/objectives/:id', (req, res) => {
    const o = objectiveBy(req.params.id)
    const passages = db()
      .prepare('SELECT * FROM passages WHERE objective_id = ? ORDER BY started_at DESC')
      .all(o.id)
      .map(sortirPassage)
    for (const p of passages) {
      p.evidences = db()
        .prepare('SELECT * FROM evidences WHERE passage_id = ? ORDER BY id')
        .all(p.id)
        .map(sortirPreuve)
    }
    res.json({
      ...o,
      gate: evaluateGate(o.id),
      // A lifted rule that shows nowhere reads, later, like a rule that never
      // applied. It travels with the objective it was granted on.
      waivers: db()
        .prepare('SELECT waives, body, decided_at FROM decisions WHERE objective_id = ? AND waives IS NOT NULL ORDER BY decided_at DESC')
        .all(o.id),
      /**
       * A run asked for but not yet picked up.
       *
       * The status is written by the worker when it claims the run, and the
       * worker polls every five seconds. In between, the header said "Ready to
       * start" about something already starting — the one moment a person is
       * watching the page, because they just pressed the button.
       */
      live_run:
        db()
          .prepare(
            `SELECT id, status, turn FROM runs
             WHERE objective_id = ? AND mode != 'judge' AND status IN ('pending','running')
             ORDER BY id DESC LIMIT 1`,
          )
          .get(o.id) ?? null,

      /**
       * What comes after this one, in its own chapter.
       *
       * Concluding an objective ended the page: a green "Accepted", and nothing
       * saying where to go. The project's own next step is a different question
       * — it ranks the whole project, and answers with whatever is most urgent
       * anywhere, which after finishing step 2 of 6 is rarely step 3. The
       * continuation of the chapter you are reading belongs on the page you are
       * reading.
       */
      next_in_chapter: o.parent_id
        ? (db()
            .prepare(
              `SELECT id, title, status FROM objectives
               WHERE parent_id = @parent AND priority > @priority
                 AND status NOT IN ('proven','abandoned')
               ORDER BY priority LIMIT 1`,
            )
            .get({ parent: o.parent_id, priority: o.priority }) ?? null)
        : null,
      children: db().prepare('SELECT * FROM objectives WHERE parent_id = ? ORDER BY priority').all(o.id),
      halts: db().prepare('SELECT * FROM halts WHERE objective_id = ? ORDER BY id DESC').all(o.id),
      evidences: db()
        .prepare('SELECT * FROM evidences WHERE objective_id = ? AND passage_id IS NULL ORDER BY id')
        .all(o.id)
        .map(sortirPreuve),
      passages,
    })
  })

  api.patch('/objectives/:id', (req, res) => {
    const o = objectiveBy(req.params.id)
    const b = req.body ?? {}
    const champs = {}

    for (const k of ['title', 'intent', 'proof_spec', 'blast_radius', 'priority', 'parent_id', 'resume_session']) {
      if (k in b) champs[k] = b[k]
    }
    if ('resume_mode' in b) {
      if (!['new', 'last', 'named'].includes(b.resume_mode)) {
        throw new Rejected('Unknown continuity: new, last or named.')
      }
      champs.resume_mode = b.resume_mode
    }

    // An objective cannot sit under itself, nor under one of its own.
    if (champs.parent_id) {
      const seen = new Set()
      for (let p = champs.parent_id; p; ) {
        if (p === o.id || seen.has(p)) throw new Rejected('An objective cannot be placed under itself.')
        seen.add(p)
        p = db().prepare('SELECT parent_id FROM objectives WHERE id = ?').get(p)?.parent_id
      }
    }

    // Writing the criterion makes the objective takeable, clearing it makes it
    // unusable. Without this recalculation, you wrote the criterion and the step
    // stayed "undefined":
    // personne ne la prenait, et rien ne disait pourquoi.
    if ('proof_spec' in b && !('status' in b)) {
      if (b.proof_spec?.trim() && o.status === 'draft') champs.status = 'ready'
      else if (!b.proof_spec?.trim() && o.status === 'ready') champs.status = 'draft'
    }

    if ('status' in b) {
      // The only guarded transition: concluding. Nothing declares itself proven.
      if (b.status === 'proven') {
        const g = evaluateGate(o.id)
        if (!g.ok) {
          if (g.reason !== 'human_request' && g.reason !== 'awaiting_verdict') {
            db()
              .prepare('INSERT INTO halts (objective_id,reason,detail) VALUES (?,?,?)')
              .run(o.id, g.reason, g.detail)
          }
          throw new Rejected('The objective cannot conclude.', 409, { gate: g })
        }
        champs.proven_at = nowStamp()
      }
      champs.status = b.status
    }

    const noms = Object.keys(champs)
    if (noms.length) {
      db()
        .prepare(
          `UPDATE objectives SET ${noms.map((n) => `${n} = @${n}`).join(', ')}, updated_at = @maj` +
            // Stamped only when the CRITERION moves: rewriting what would prove an
            // objective is a new attempt at it, and the convergence count has to
            // start again — otherwise the one way out of a `not_converging` halt
            // leaves the gate refusing exactly as before.
            (noms.includes('proof_spec') ? ', proof_spec_changed_at = @maj' : '') +
            ' WHERE id = @id',
        )
        .run({ ...champs, maj: nowStamp(), id: o.id })
    }
    res.json(objectiveBy(o.id))
  })

  /**
   * How a chapter began and how it ended — derived, like everything else.
   *
   * Asked for as "the starting state and the final state, with the proof of
   * each". None of it needs declaring: the first visual proof attached to a
   * chapter or its children IS the before, the last one is the after, and what
   * it cost sits in the attempts. A field somebody has to remember to fill would
   * be empty on every chapter that mattered.
   *
   * Counts the chapter AND its children: a chapter's evidence is mostly produced
   * by its steps, and asking only about the parent returned an empty history for
   * a chapter that had thirty passes behind it.
   */
  api.get('/objectives/:id/closure', (req, res) => {
    const o = objectiveBy(req.params.id)
    const family = { id: o.id }

    const span = db()
      .prepare(
        `SELECT MIN(started_at) AS started, MAX(ended_at) AS ended,
                COUNT(*) AS attempts, COALESCE(SUM(cost_usd),0) AS cost,
                COALESCE(SUM(tokens),0) AS tokens
         FROM passages
         WHERE objective_id = @id OR objective_id IN (SELECT id FROM objectives WHERE parent_id = @id)`,
      )
      .get(family)

    const visual = db()
      .prepare(
        `SELECT id, type, label, ref, verdict, created_at FROM evidences
         WHERE (objective_id = @id OR objective_id IN (SELECT id FROM objectives WHERE parent_id = @id))
           AND type IN ('render','screenshot')
         ORDER BY created_at`,
      )
      .all(family)
      .map(sortirPreuve)

    const passing = db()
      .prepare(
        `SELECT id, type, label, ref, verdict, created_at FROM evidences
         WHERE objective_id = @id AND verdict = 'pass' ORDER BY created_at DESC`,
      )
      .all(family)
      .map(sortirPreuve)

    const steps = db()
      .prepare('SELECT id, title, status, proof_spec FROM objectives WHERE parent_id = ? ORDER BY priority')
      .all(o.id)

    res.json({
      objective: { id: o.id, title: o.title, status: o.status, proof_spec: o.proof_spec, proven_at: o.proven_at },
      span: {
        started: span.started,
        ended: span.ended,
        attempts: span.attempts,
        cost_usd: Number(span.cost),
        tokens: Number(span.tokens),
      },
      // Named `before`/`after` rather than first/last: what the reader wants is
      // the comparison, and two identical-looking fields invite reading them the
      // wrong way round.
      before: visual[0] ?? null,
      after: visual.length > 1 ? visual[visual.length - 1] : null,
      visual_count: visual.length,
      // What actually settled it, as opposed to what merely came out.
      settled_by: passing,
      steps,
    })
  })

  // ---- tentatives et preuves ---------------------------------------------

  api.post('/objectives/:id/passages', (req, res) => {
    const o = objectiveBy(req.params.id)
    const g = canStart(o.id)
    if (!g.ok) throw new Rejected(g.detail, 409, { gate: g })

    const b = req.body ?? {}
    const r = db()
      .prepare(
        `INSERT INTO passages (objective_id,harness,summary,mission,git_before,resumed_from,started_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(o.id, b.harness ?? 'claude', b.summary ?? null, b.mission ?? null, b.git_before ?? null, b.resumed_from ?? null, nowStamp())

    if (o.status === 'ready' || o.status === 'draft') {
      db().prepare("UPDATE objectives SET status = 'in_progress' WHERE id = ?").run(o.id)
    }
    res.status(201).json(sortirPassage(db().prepare('SELECT * FROM passages WHERE id = ?').get(r.lastInsertRowid)))
  })

  api.get('/passages/:id', (req, res) => {
    const p = db().prepare('SELECT * FROM passages WHERE id = ?').get(req.params.id)
    if (!p) throw new Rejected('This attempt does not exist.', 404)
    res.json({
      ...sortirPassage(p),
      evidences: db().prepare('SELECT * FROM evidences WHERE passage_id = ?').all(p.id).map(sortirPreuve),
    })
  })

  api.patch('/passages/:id', (req, res) => {
    const p = db().prepare('SELECT * FROM passages WHERE id = ?').get(req.params.id)
    if (!p) throw new Rejected('This attempt does not exist.', 404)
    const b = req.body ?? {}
    const champs = {}
    for (const k of ['verdict', 'summary', 'mission', 'said', 'git_after', 'prevented_by', 'ended_at', 'session_id', 'resumed_from']) {
      if (k in b) champs[k] = b[k]
    }
    if ('tools_used' in b) champs.tools_used = json.write(b.tools_used)
    if ('prevented' in b) champs.prevented = b.prevented ? 1 : 0
    if ('verdict' in b && !('ended_at' in b)) champs.ended_at = nowStamp()

    const noms = Object.keys(champs)
    if (noms.length) {
      db()
        .prepare(`UPDATE passages SET ${noms.map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`)
        .run({ ...champs, id: p.id })
    }
    res.json(sortirPassage(db().prepare('SELECT * FROM passages WHERE id = ?').get(p.id)))
  })

  api.post('/passages/:id/usage', (req, res) => {
    const p = db().prepare('SELECT * FROM passages WHERE id = ?').get(req.params.id)
    if (!p) throw new Rejected('This attempt does not exist.', 404)
    const b = req.body ?? {}
    /**
     * A cost of zero and a cost nobody could compute are not the same figure.
     *
     * The caller sends `cost_usd` only when something priced it; absent, we
     * record the tokens and say plainly that the amount means nothing, rather
     * than letting a harness with no declared rate read as free.
     */
    const priced = b.cost_usd !== undefined && b.cost_usd !== null
    db()
      .prepare(
        `UPDATE passages SET tokens = ?, requests = ?, cost_usd = ?, cost_known = ?,
                             model = COALESCE(?, model),
                             tokens_in = COALESCE(?, tokens_in),
                             tokens_out = COALESCE(?, tokens_out),
                             tokens_cached = COALESCE(?, tokens_cached)
         WHERE id = ?`,
      )
      .run(
        nombre(b.tokens, 0), nombre(b.requests, 0), nombre(b.cost_usd, 0),
        priced ? 1 : 0, b.model ?? null,
        b.tokens_in ?? null, b.tokens_out ?? null, b.tokens_cached ?? null, p.id,
      )
    res.json(sortirPassage(db().prepare('SELECT * FROM passages WHERE id = ?').get(p.id)))
  })

  api.post('/passages/:id/evidences', (req, res) => {
    const p = db().prepare('SELECT * FROM passages WHERE id = ?').get(req.params.id)
    if (!p) throw new Rejected('This attempt does not exist.', 404)
    res.status(201).json(creerPreuve(p.objective_id, p.id, req.body ?? {}))
  })

  api.post('/objectives/:id/evidences', (req, res) => {
    const o = objectiveBy(req.params.id)
    res.status(201).json(creerPreuve(o.id, null, req.body ?? {}))
  })

  function creerPreuve(objectifId, passageId, b) {
    const types = ['test', 'e2e', 'screenshot', 'render', 'diff', 'invariant', 'manual']
    if (!types.includes(b.type)) throw new Rejected(`Unknown proof type: ${types.join(', ')}.`)
    if (!b.label?.trim()) throw new Rejected('A proof must have a label.')

    /**
     * A passing `test` or `e2e` has to carry what the command printed.
     *
     * Of sixty-six passing proofs here, thirty-six were verdicts, seven came from
     * a command this tool ran, and twenty-three were DECLARED: an agent calling
     * `orchestrator evidence <passage> test pass "check_c45_gate.py — exit 0"`.
     * The label narrates a command; nobody re-ran it. That is the same disease as
     * a verdict standing in for a proof, one floor down — the session's account of
     * a measurement, recorded as the measurement.
     *
     * `prove` runs a declared command and keeps its output, so a genuine pass has
     * one. An artefact (screenshot, render, diff) and an opinion (manual) claim no
     * exit code and are untouched; a failing or inconclusive result is a report,
     * not a claim, and stays recordable.
     */
    // `payload` arrives as an object from a request and as text from the
    // database: reading it one way only made the guard refuse the very proofs it
    // was meant to let through.
    const charge = typeof b.payload === 'string' ? json.read(b.payload, {}) : (b.payload ?? {})
    if (b.verdict === 'pass' && ['test', 'e2e'].includes(b.type) && !charge?.output) {
      throw new Rejected(
        `A passing ${b.type} has to carry what the command printed. Run it through the tool — ` +
          '`orchestrator prove <passage> <key>`, with the command declared in .orchestrator.json — ' +
          'rather than recording that it passed. An account of a command is not its result.',
      )
    }
    const r = db()
      .prepare(
        `INSERT INTO evidences (objective_id,passage_id,type,label,ref,verdict,payload)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(objectifId, passageId, b.type, b.label, b.ref ?? null, b.verdict ?? 'inconclusive', json.write(b.payload))
    return sortirPreuve(db().prepare('SELECT * FROM evidences WHERE id = ?').get(r.lastInsertRowid))
  }

  // ---- halts --------------------------------------------------------------

  api.post('/objectives/:id/halts', (req, res) => {
    const o = objectiveBy(req.params.id)
    const b = req.body ?? {}
    const r = db()
      .prepare('INSERT INTO halts (objective_id,passage_id,reason,detail,evidence_mark) VALUES (?,?,?,?,?)')
      .run(o.id, b.passage_id ?? null, b.reason, b.detail ?? null, evidenceWatermark(o.id))
    // Never over an objective that was set aside or already proven. The same
    // oversight in two more places: `abandoned` kept being overwritten by
    // routine bookkeeping, so #11 came back twice after being dropped.
    db()
      .prepare("UPDATE objectives SET status = 'blocked' WHERE id = ? AND status NOT IN ('abandoned','proven')")
      .run(o.id)
    res.status(201).json(db().prepare('SELECT * FROM halts WHERE id = ?').get(r.lastInsertRowid))
  })

  /**
   * Clear the open halts of one kind on an objective.
   *
   * The screen knows which objective is stuck and why, never the halt's id — and
   * making it fetch the objective just to find a number is asking the reader's
   * browser to do bookkeeping the server already has in front of it.
   */
  api.post('/objectives/:id/halts/resolve', (req, res) => {
    const reason = req.body?.reason
    if (!reason) throw new Rejected('Which kind of halt should be cleared?')
    const rows = db()
      .prepare('SELECT id FROM halts WHERE objective_id = ? AND reason = ? AND resolved_at IS NULL')
      .all(req.params.id, reason)
    db()
      .prepare(
        'UPDATE halts SET resolved_at = ? WHERE objective_id = ? AND reason = ? AND resolved_at IS NULL',
      )
      .run(nowStamp(), req.params.id, reason)

    /**
     * Clearing halts in bulk left the objective `blocked` for good.
     *
     * The single-halt route recomputes the status and this one never did, so
     * anything cleared through it stayed blocked — and the loop only ever takes
     * `ready` or `in_progress`. The halt was gone from the screen and the
     * objective was out of reach, with nothing saying why.
     *
     * Same rules as there, deliberately: an objective with no criterion is not
     * takeable, so it goes back to `draft` rather than `ready`; and one that was
     * SET ASIDE stays set aside — housekeeping must not undo a decision.
     */
    const reste = db()
      .prepare('SELECT COUNT(*) n FROM halts WHERE objective_id = ? AND resolved_at IS NULL')
      .get(req.params.id).n

    if (!reste) {
      const o = objectiveBy(req.params.id)
      if (!['abandoned', 'proven'].includes(o.status)) {
        const aDesTentatives = db()
          .prepare('SELECT COUNT(*) n FROM passages WHERE objective_id = ?')
          .get(o.id).n
        const statut = !o.proof_spec?.trim() ? 'draft' : aDesTentatives ? 'in_progress' : 'ready'
        db().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(statut, o.id)
      }
    }

    res.json({ resolved: rows.map((r) => r.id) })
  })

  api.patch('/halts/:id/resolve', (req, res) => {
    const h = db().prepare('SELECT * FROM halts WHERE id = ?').get(req.params.id)
    if (!h) throw new Rejected('This halt does not exist.', 404)
    db().prepare('UPDATE halts SET resolved_at = ? WHERE id = ?').run(nowStamp(), h.id)

    const reste = db()
      .prepare('SELECT COUNT(*) n FROM halts WHERE objective_id = ? AND resolved_at IS NULL')
      .get(h.objective_id).n

    if (!reste) {
      const o = objectiveBy(h.objective_id)
      const aDesTentatives = db()
        .prepare('SELECT COUNT(*) n FROM passages WHERE objective_id = ?')
        .get(o.id).n
      // An objective with no criterion does not go back to "ready": it is not
      // takeable, it goes back to draft.
      //
      // And one that was SET ASIDE stays set aside. Clearing its halt used to
      // recompute the status blind, so #11 went from `abandoned` back to
      // `in_progress` and the loop picked it up again — after it had been
      // deliberately dropped and replaced. Setting something aside has to
      // survive housekeeping, or it means nothing.
      if (!['abandoned', 'proven'].includes(o.status)) {
        const statut = !o.proof_spec?.trim() ? 'draft' : aDesTentatives ? 'in_progress' : 'ready'
        db().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(statut, o.id)
      }
    }
    res.json(db().prepare('SELECT * FROM halts WHERE id = ?').get(h.id))
  })

  // ---- verdict ------------------------------------------------------------

  api.post('/objectives/:id/verdict/:decision/:by?', (req, res) => {
    const o = objectiveBy(req.params.id)
    const decision = req.params.decision
    if (!['accept', 'reject'].includes(decision)) throw new Rejected('Verdict inconnu : accept ou reject.')
    const by = ['human', 'gpt', 'agent'].includes(req.params.by) ? req.params.by : 'human'

    if (decision === 'reject') {
      // A judge who takes it back cancels what they said. Without this, one
      // "accepted" kept the gate open despite every later rejection.
      db()
        .prepare(
          `UPDATE evidences SET verdict = 'inconclusive',
             label = label || ' — withdrawn by a later verdict'
           WHERE objective_id = ? AND type = 'manual' AND verdict = 'pass'
             AND payload IS NOT NULL AND payload LIKE '%judged_by%'`,
        )
        .run(o.id)

      // Un refus du juge du projet est une consigne de reprise, pas une demande
      // d'arbitrage : seul un refus HUMAIN suspend la boucle.
      //
      // And one open halt per reason: the same message read on two turns stacked
      // two identical ones, which reads as two rejections when
      // il n'y en a eu qu'un.
      const reason = by === 'human' ? 'human_request' : 'verdict_rejected'
      const dejaOuvert = db()
        .prepare('SELECT id FROM halts WHERE objective_id = ? AND reason = ? AND resolved_at IS NULL')
        .get(o.id, reason)

      if (!dejaOuvert)
        db()
        .prepare('INSERT INTO halts (objective_id,reason,detail,evidence_mark) VALUES (?,?,?,?)')
        .run(
          o.id,
          reason,
          `Verdict ${by === 'gpt' ? 'from the conversation' : by === 'agent' ? 'from a third-party agent' : 'from a human'}: rejected. The work does not satisfy the proof criterion.`,
          evidenceWatermark(o.id),
        )
      // Never over an objective that was set aside or already proven. The same
    // oversight in two more places: `abandoned` kept being overwritten by
    // routine bookkeeping, so #11 came back twice after being dropped.
    db()
      .prepare("UPDATE objectives SET status = 'blocked' WHERE id = ? AND status NOT IN ('abandoned','proven')")
      .run(o.id)
      return res.json(objectiveBy(o.id))
    }

    db()
      .prepare(
        `INSERT INTO evidences (objective_id,type,label,ref,verdict,payload)
         VALUES (?, 'manual', ?, ?, 'pass', ?)`,
      )
      .run(
        o.id,
        by === 'gpt'
          ? 'Verdict from the conversation: the criterion is satisfied'
          : by === 'agent'
            ? 'Verdict from a third-party agent: the criterion is satisfied'
            : 'Human verdict: the proof criterion is satisfied',
        o.proof_spec,
        json.write({ judged_by: by }),
      )

    // An absorbable halt is stale the moment a proof arrives: "several attempts,
    // nothing demonstrated" makes no sense once something has just been
    // demonstrated. Only the halts that require a human survive.
    db()
      .prepare(
        `UPDATE halts SET resolved_at = ? WHERE objective_id = ? AND resolved_at IS NULL
         AND reason NOT IN (${HUMAN_HALTS.map(() => '?').join(',')})`,
      )
      .run(nowStamp(), o.id, ...HUMAN_HALTS)

    // Un verdict est une PREUVE, pas un interrupteur. Le gate tranche ensuite :
    // without this, one "accepted" would be enough to bypass every guard.
    const g = evaluateGate(o.id)
    if (!g.ok) {
      return res
        .status(409)
        .json({ message: 'Verdict recorded, but the objective cannot conclude.', gate: g, objective: objectiveBy(o.id) })
    }

    db().prepare('UPDATE objectives SET status = ?, proven_at = ? WHERE id = ?').run('proven', nowStamp(), o.id)
    res.json(objectiveBy(o.id))
  })

  // ---- revue et tableau de bord -------------------------------------------

  api.get('/review', (_req, res) => {
    const lines = db()
      .prepare(
        `SELECT o.*, p.slug project, p.gate_judge,
           (SELECT COUNT(*) FROM evidences WHERE objective_id=o.id AND verdict='pass') evidences_pass,
           (SELECT COUNT(*) FROM evidences WHERE objective_id=o.id AND verdict='fail') evidences_fail,
           (SELECT COUNT(*) FROM passages  WHERE objective_id=o.id) passages,
           (SELECT COALESCE(SUM(cost_usd),0) FROM passages WHERE objective_id=o.id) cost_usd
         FROM objectives o JOIN projects p ON p.id = o.project_id
         -- Only projects being worked on. The dashboard's "needs you" takes its
         -- COUNT from attention() and its CARDS from here: filtering one and not
         -- the other left a project that had just been set aside still sitting in
         -- the queue, under a heading that no longer counted it. Two sources for
         -- one section is how a screen ends up disagreeing with itself.
         WHERE o.status IN ('in_progress','blocked','ready') AND p.active = 1`,
      )
      .all()
      .map((l) => ({ ...l, ...evaluateGate(l.id) }))

    /**
     * `ready && !ok` and `!ready` do not cover `ready && ok`.
     *
     * An objective whose gate is entirely satisfied fell through both filters and
     * appeared in neither list — on the endpoint whose only job is to show what
     * awaits a decision. Iberis #7 has been concludable since the 2nd of August
     * and was on no screen at all. A gate that is met is the strongest reason to
     * show something, not a reason to hide it.
     */
    const pret = lines.filter((l) => l.ready)
    res.json({
      ready: pret,
      in_progress: lines.filter((l) => !l.ready),
      counts: { ready: pret.length, in_progress: lines.length - pret.length },
    })
  })

  api.get('/dashboard', async (_req, res) => {
    const projects = db().prepare('SELECT * FROM projects ORDER BY name').all()
    // Computed once for the whole page rather than per project: every entry
    // re-evaluates gates, and four projects would mean four full passes.
    const waiting = attention()
    const rollup = projects.map((p) => {
      const s = db()
        .prepare(
          `SELECT COUNT(*) total,
             SUM(CASE WHEN status='proven' THEN 1 ELSE 0 END) proven
           FROM objectives WHERE project_id = ?`,
        )
        .get(p.id)
      const c = db()
        .prepare(
          `SELECT COUNT(*) passages, COALESCE(SUM(tokens),0) tokens, COALESCE(SUM(requests),0) requests,
                  COALESCE(SUM(cost_usd),0) cost, MAX(started_at) last_activity
           FROM passages WHERE objective_id IN (SELECT id FROM objectives WHERE project_id = ?)`,
        )
        .get(p.id)
      /**
       * This counted open halts and nothing else, so it read 0 on all four
       * projects while three of them were waiting on a decision: a chapter whose
       * criterion was fully met and which nothing would close, a run that ended
       * saying `needs_you`, a project with no allowed tool. One rule now answers
       * it, the same one the panel below the projects reads.
       */
      const pendingAuth = waiting.filter((w) => w.project === p.slug).length
      return {
        slug: p.slug,
        name: p.name,
        active: Boolean(p.active),
        // Whether a judging conversation is recorded — the errand that opens one
        // needs a project that has one, and the dashboard is where it is chosen.
        has_judge: Boolean(p.judge_url),
        repo_path: p.repo_path,
        total_objectives: s.total,
        proven: s.proven ?? 0,
        awaiting_human: pendingAuth,
        passages: c.passages,
        tokens: c.tokens,
        requests: c.requests,
        cost_usd: c.cost,
        last_activity: c.last_activity,
        // These two were hardcoded empty. The screen drew a progress bar with no
        // segments and an invariants column that never said anything — for every
        // project, since the beginning. A placeholder that renders as "nothing to
        // report" is worse than an error: it looks like an answer.
        objectives: Object.fromEntries(
          db()
            .prepare('SELECT status, COUNT(*) n FROM objectives WHERE project_id = ? GROUP BY status')
            .all(p.id)
            .map((r) => [r.status, r.n]),
        ),
        invariants: db()
          .prepare(
            `SELECT COUNT(*) total,
               SUM(CASE WHEN last_status = 'breached' THEN 1 ELSE 0 END) breached,
               SUM(CASE WHEN last_status = 'unknown' OR last_status IS NULL THEN 1 ELSE 0 END) unknown
             FROM invariants WHERE project_id = ?`,
          )
          .get(p.id),
      }
    })

    res.json({
      projects: rollup,

      /**
       * The judging browser, measured on every load.
       *
       * This was already probed — in `/api/setup`, the walkthrough everybody
       * skips — and nowhere a person looks. Run 59 spent two hours reloading a
       * page inside a Chrome that was not running while every screen showed a
       * healthy `running`; the fact was one HTTP call away the whole time.
       *
       * Only true when the server shares a machine with the worker: port 9222
       * binds to 127.0.0.1, so a remote server cannot see another machine's
       * browser and must not pretend to. Hence `same_machine`, stated rather
       * than assumed.
       */
      judge: await judgeHealth().catch(() => null),

      totals: {
        projects: rollup.length,
        objectives: rollup.reduce((n, p) => n + p.total_objectives, 0),
        proven: rollup.reduce((n, p) => n + p.proven, 0),
        awaiting_human: rollup.reduce((n, p) => n + p.awaiting_human, 0),
        passages: rollup.reduce((n, p) => n + p.passages, 0),
        tokens: rollup.reduce((n, p) => n + p.tokens, 0),
        requests: rollup.reduce((n, p) => n + p.requests, 0),
        cost_usd: rollup.reduce((n, p) => n + p.cost_usd, 0),
      },

      /**
       * The day, beside the running total.
       *
       * Every figure on this screen counted from the beginning of the install,
       * so $1899 answered "what has this ever cost" and never "what did last
       * night cost" — which is the one a person actually opens the page with. A
       * total that only ever grows says nothing about whether anything moved.
       */
      today: db()
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM passages WHERE started_at >= date('now'))                    AS passages,
             (SELECT COALESCE(SUM(cost_usd),0) FROM passages WHERE started_at >= date('now'))    AS cost_usd,
             (SELECT COALESCE(SUM(tokens),0) FROM passages WHERE started_at >= date('now'))      AS tokens,
             (SELECT COUNT(*) FROM objectives WHERE proven_at >= date('now'))                    AS proven,
             (SELECT COUNT(*) FROM evidences
               WHERE created_at >= date('now') AND verdict = 'pass'
                 AND type IN ('test','e2e','invariant'))                                         AS measured`,
        )
        .get(),
      halts_by_reason: db()
        .prepare(
          `SELECT reason, COUNT(*) n, SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) open
           FROM halts GROUP BY reason ORDER BY n DESC`,
        )
        .all(),
      harness_split: db()
        .prepare(
          `SELECT harness, COUNT(*) n, COALESCE(SUM(tokens),0) tokens, COALESCE(SUM(cost_usd),0) cost
           FROM passages GROUP BY harness`,
        )
        .all(),
      open_halts: db()
        .prepare(
          `SELECT h.id,h.reason,h.detail,h.created_at,h.objective_id,
                  o.title objective_title,o.blast_radius,p.slug project
           FROM halts h JOIN objectives o ON o.id=h.objective_id JOIN projects p ON p.id=o.project_id
           WHERE h.resolved_at IS NULL ORDER BY h.id DESC LIMIT 20`,
        )
        .all(),
      recent: db()
        .prepare(
          `SELECT pa.id,pa.harness,pa.verdict,pa.tokens,pa.cost_usd,pa.started_at,pa.ended_at,pa.summary,
                  pa.objective_id,o.title objective_title,p.slug project
           FROM passages pa JOIN objectives o ON o.id=pa.objective_id JOIN projects p ON p.id=o.project_id
           ORDER BY pa.started_at DESC LIMIT 15`,
        )
        .all(),
      /**
       * This was `[]`, written into the response.
       *
       * The page has a section for measurements out of bounds; it reads this
       * field, so it has never drawn once — while Atlas has carried a breached
       * invariant for days and the project card, counting from the database,
       * said "1 out of bounds" three inches above the silence. Same family as
       * the "four proofs out of 385" that was typed in on the day it was true:
       * a field a screen believes is live and is in fact a decision made once.
       */
      invariants: db()
        .prepare(
          `SELECT i.id, p.slug project, i.name,
                  COALESCE(i.description, i.name) statement,
                  i.last_value, i.last_status, i.last_checked_at, i.armed
           FROM invariants i JOIN projects p ON p.id = i.project_id
           WHERE i.armed = 1
           ORDER BY CASE i.last_status WHEN 'breached' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, i.id`,
        )
        .all()
        .map((i) => ({ ...i, armed: Boolean(i.armed) })),
    })
  })

  // ---- livrables ----------------------------------------------------------

  /**
   * Serves a file cited by a proof. We NEVER serve a free-form path from the
   * client: only a path already recorded, and only while it stays under the
   * project repository's root.
   */
  /**
   * A downscaled copy, cached on disk, or null to serve the original.
   *
   * `sips` ships with macOS and this tool is already bound to it — Unity paths,
   * `pgrep`, `open -a`. Anything that goes wrong here returns null rather than
   * throwing: a thumbnail that cannot be made is worth serving full size, not
   * worth failing the request over.
   */
  const thumbnail = (absolute, width) => {
    try {
      const cacheDir = join(dirname(dbPathOf()), 'thumbs')
      mkdirSync(cacheDir, { recursive: true })
      // The mtime is in the name: a rendering that is redone regenerates rather
      // than serving the old one for as long as the cache survives.
      const stamp = statSync(absolute).mtimeMs
      const out = join(cacheDir, `${createHash('sha1').update(`${absolute}:${width}:${stamp}`).digest('hex')}.jpg`)
      if (existsSync(out)) return out
      // JPEG, not PNG: these are renderings of 3D scenes, which is the one thing
      // PNG compresses badly. Same picture, a fifth of the bytes, at a size where
      // the difference is not visible anyway.
      execFileSync(
        '/usr/bin/sips',
        ['-Z', String(width), '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', absolute, '--out', out],
        { stdio: 'ignore', timeout: 15000 },
      )
      return existsSync(out) ? out : null
    } catch {
      return null
    }
  }

  api.get('/evidences/:id/file', (req, res) => {
    const e = db().prepare('SELECT * FROM evidences WHERE id = ?').get(req.params.id)
    if (!e) throw new Rejected('This proof does not exist.', 404)

    const o = objectiveBy(e.objective_id)
    const root = db().prepare('SELECT repo_path FROM projects WHERE id = ?').get(o.project_id)?.repo_path
    if (!root) throw new Rejected('Project has no repository.', 404)

    const files = sortirPreuve(e).files
    const rel = files[nombre(req.query.n, 0)]
    if (!rel) throw new Rejected('No file on this proof.', 404)

    const absolute = path(root, rel)
    if (!absolute.startsWith(path(root) + '/')) throw new Rejected('Path outside the repository.', 403)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Rejected('File not found.', 404)

    const mime =
      { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
        '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
        '.csv': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' }[
        extname(absolute).toLowerCase()
      ] ?? 'application/octet-stream'

    res.set('Content-Type', mime)
    res.set('Content-Disposition', `inline; filename="${basename(absolute)}"`)
    res.set('Cache-Control', 'public, max-age=3600')

    // The screen asks for a 480px thumbnail; this route used to ignore the ask and
    // send the original. On an objective with 54 renderings that is seventy
    // megabytes to draw a contact sheet — which is why the thumbnails were still
    // blank grey squares long after the page had loaded.
    const width = nombre(req.query.w, 0)
    const small = width > 0 && mime.startsWith('image/') ? thumbnail(absolute, width) : null
    // The thumbnail is a JPEG whatever the original was: say so, or the browser is
    // handed a PNG header over JPEG bytes.
    if (small) res.set('Content-Type', 'image/jpeg')
    createReadStream(small ?? absolute).pipe(res)
  })


  // ---- attachments ----------------------------------------------------------

  /** Where a person's files live: the tool's own directory, never the repository. */
  const attachmentsDir = () => {
    const dir = join(dirname(dbPathOf()), 'attachments')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  // The path is not hidden: this is a single-user tool on localhost, repository
  // paths are printed on every other screen, and the agent needs it to open the
  // file. Hiding it would only have forced a second endpoint to reveal it.
  const publicAttachment = (a) => a

  /**
   * Put a file into the process.
   *
   * The loop already sends what a pass produced up to the judging conversation.
   * Nothing came the other way, so the most natural way to steer a visual
   * project — "make it look like this" — had nowhere to go but a sentence
   * describing the picture.
   *
   * Base64 through JSON rather than multipart: one dependency fewer, and the
   * body limit already covers a screenshot several times over.
   */
  api.post('/projects/:slug/attachments', (req, res) => {
    const p = projectBy(req.params.slug)
    const b = req.body ?? {}
    if (!['brief', 'run', 'project'].includes(b.kind)) {
      throw new Rejected('Attach it to a brief, a run, or the project.')
    }
    const name = String(b.name ?? '').trim()
    if (!name || /[/\\]/.test(name)) throw new Rejected('A file name, without a path.')

    const data = Buffer.from(String(b.data ?? ''), 'base64')
    if (!data.length) throw new Rejected('The file arrived empty.')
    if (data.length > 24 * 1024 * 1024) throw new Rejected('Too big — 24 MB at most.')

    // The stored name is ours; the original is kept for display. A name chosen by
    // whoever uploads must never decide where the bytes land.
    const safe = `${Date.now()}-${createHash('sha1').update(data).digest('hex').slice(0, 12)}${extname(name).slice(0, 12)}`
    const absolute = join(attachmentsDir(), safe)
    writeFileSync(absolute, data)

    const r = db()
      .prepare(
        `INSERT INTO attachments (project_id, kind, owner_id, name, mime, bytes, path, note)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        b.kind,
        b.owner_id ? Number(b.owner_id) : null,
        name,
        b.mime ?? null,
        data.length,
        absolute,
        b.note?.toString().trim() || null,
      )
    res
      .status(201)
      .json(publicAttachment(db().prepare('SELECT * FROM attachments WHERE id = ?').get(r.lastInsertRowid)))
  })

  api.get('/projects/:slug/attachments', (req, res) => {
    const p = projectBy(req.params.slug)
    const { kind, owner_id: owner } = req.query
    res.json(
      db()
        .prepare(
          `SELECT * FROM attachments WHERE project_id = ?
           ${kind ? 'AND kind = @kind' : ''} ${owner ? 'AND owner_id = @owner' : ''}
           ORDER BY id DESC`,
        )
        .all(p.id, { kind, owner })
        .map(publicAttachment),
    )
  })

  api.get('/attachments/:id/file', (req, res) => {
    const a = db().prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id)
    if (!a || !existsSync(a.path)) throw new Rejected('This file is not here any more.', 404)
    res.set('Content-Type', a.mime || 'application/octet-stream')
    res.set('Content-Disposition', `inline; filename="${basename(a.name)}"`)
    const width = nombre(req.query.w, 0)
    const small = width > 0 && String(a.mime).startsWith('image/') ? thumbnail(a.path, width) : null
    if (small) res.set('Content-Type', 'image/jpeg')
    createReadStream(small ?? a.path).pipe(res)
  })

  api.delete('/attachments/:id', (req, res) => {
    const a = db().prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id)
    if (!a) throw new Rejected('This file is not here any more.', 404)
    // The row goes; the bytes stay until something sweeps them. Deleting a file an
    // agent may be reading mid-pass is worse than leaving it on disk.
    db().prepare('DELETE FROM attachments WHERE id = ?').run(a.id)
    res.json({ removed: a.id })
  })

  // ---- setup ---------------------------------------------------------------

  const setting = (key) => db().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null

  const setSetting = (key, value) =>
    db()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @now)
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @now`,
      )
      .run({ key, value, now: nowStamp() })

  /**
   * Where this harness actually is on this machine. Asked of the shell, never of
   * the reader.
   *
   * The PATH is not the whole story: Codex installs under ~/.codex and is not on
   * it, so a PATH-only probe reported "not installed" about a harness with
   * fourteen advancing passes to its name. A previous check recorded the real
   * path — we try that too, and confirm it is still executable.
   */
  const binaryAt = (name) => {
    if (/^[\w.-]+$/.test(name)) {
      try {
        const found = execFileSync('/bin/sh', ['-c', `command -v ${name} 2>/dev/null`], {
          encoding: 'utf8',
          timeout: 3000,
        }).trim().split('\n')[0]
        if (found) return found
      } catch {
        /* not on the PATH — keep looking */
      }
    }
    const remembered = db()
      .prepare("SELECT last_detail FROM agents WHERE name = ? AND reach = 'cli' AND last_status = 'ok'")
      .get(name)?.last_detail
    if (remembered && existsSync(remembered)) {
      try {
        accessSync(remembered, X_OK)
        return remembered
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * The state of the installation, measured.
   *
   * Every line here is a probe, not a stored answer. A walkthrough that asked
   * "have you installed Claude Code?" and believed the reply would be a form,
   * and the first thing to go stale — the value of asking is that the tool goes
   * and looks.
   */
  api.get('/setup', async (_req, res) => {
    const port = 9222
    let browser = { listening: false, judgeTab: null, signedIn: null }
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(2500),
      })).json()
      browser = {
        listening: true,
        judgeTab: tabs.find((t) => t.type === 'page' && String(t.url).includes('chatgpt.com'))?.url ?? null,
        // A tab is not a session. Asked of the page, never inferred from the URL.
        signedIn: await signedIn(port).catch(() => null),
      }
    } catch {
      /* not listening: that IS the answer */
    }

    const projects = db()
      .prepare('SELECT id, slug, name, repo_path, judge_url FROM projects ORDER BY id')
      .all()
      .map((p) => ({
        slug: p.slug,
        name: p.name,
        repo_path: p.repo_path,
        repo_exists: Boolean(p.repo_path && existsSync(p.repo_path)),
        has_judge: Boolean(p.judge_url),
        allowed_tools: db()
          .prepare(
            "SELECT COUNT(*) n FROM permissions WHERE project_id = ? AND harness = 'claude' AND decision = 'allow'",
          )
          .get(p.id).n,
      }))

    res.json({
      controller: setting('controller'),
      walkthrough_done: setting('walkthrough_done') === '1',
      harnesses: {
        claude: binaryAt('claude'),
        codex: binaryAt('codex'),
      },
      browser: { ...browser, port },
      projects,
      storages: db().prepare('SELECT COUNT(*) n FROM storages WHERE enabled = 1').get().n,
      // A worker is what actually carries out anything asked from this screen.
      workers_seen: db()
        .prepare("SELECT COUNT(DISTINCT machine) n FROM runs WHERE machine IS NOT NULL AND taken_at > datetime('now','-1 day')")
        .get().n,
    })
  })

  api.patch('/setup', (req, res) => {
    const b = req.body ?? {}
    if ('controller' in b) {
      if (b.controller !== null && !['claude', 'codex', 'none'].includes(b.controller)) {
        throw new Rejected('Unknown controller: claude, codex or none.')
      }
      setSetting('controller', b.controller)
    }
    if ('walkthrough_done' in b) setSetting('walkthrough_done', b.walkthrough_done ? '1' : '0')
    res.json({ ok: true })
  })

  /**
   * The one question every screen asks: is anything waiting on a person?
   *
   * One rule, one answer. Each page quoted its own version of it and they
   * disagreed — see attention.js.
   */
  api.get('/attention', (req, res) => res.json(attentionFor(req.query.project)))

  // ---- errands -------------------------------------------------------------
  //
  // The server records what is asked for; the worker on the machine that holds
  // the repository carries it out. Nothing here ever spawns a process: a server
  // able to run commands on your machine is a far worse thing to expose than one
  // that keeps a list.

  /** What a person asked the machine to go and do. */
  api.get('/projects/:slug/chores', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json(
      db()
        .prepare(
          `SELECT * FROM chores WHERE project_id = ?
           ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, id DESC
           LIMIT 10`,
        )
        .all(p.id),
    )
  })

  api.post('/projects/:slug/chores', (req, res) => {
    const p = projectBy(req.params.slug)
    const kind = String(req.body?.kind ?? '')
    if (!KNOWN_CHORES.includes(kind)) throw new Rejected(`Nothing here knows how to “${kind}”.`)

    // Asking twice while the first is still in flight queues nothing: a button
    // pressed three times would otherwise open three editors.
    const already = db()
      .prepare("SELECT * FROM chores WHERE project_id = ? AND kind = ? AND status IN ('pending','running')")
      .get(p.id, kind)
    if (already) return res.json(already)

    const r = db()
      .prepare('INSERT INTO chores (project_id, kind, asked_by) VALUES (?, ?, ?)')
      .run(p.id, kind, req.body?.by ?? 'screen')
    res.status(201).json(db().prepare('SELECT * FROM chores WHERE id = ?').get(r.lastInsertRowid))
  })

  /** The worker takes one. Same shape as claiming a run, for the same reason. */
  api.post('/projects/:slug/chores/claim', (req, res) => {
    const p = projectBy(req.params.slug)
    const taken = db().transaction(() => {
      const c = db()
        .prepare("SELECT * FROM chores WHERE project_id = ? AND status = 'pending' ORDER BY id LIMIT 1")
        .get(p.id)
      if (!c) return null
      db()
        .prepare("UPDATE chores SET status='running', machine=?, taken_at=? WHERE id=?")
        .run(req.body?.machine ?? null, nowStamp(), c.id)
      return db().prepare('SELECT * FROM chores WHERE id = ?').get(c.id)
    })()
    res.json({ chore: taken })
  })

  api.patch('/chores/:id', (req, res) => {
    const c = db().prepare('SELECT * FROM chores WHERE id = ?').get(req.params.id)
    if (!c) throw new Rejected('This errand does not exist.', 404)
    const status = ['done', 'failed'].includes(req.body?.status) ? req.body.status : c.status
    db()
      .prepare('UPDATE chores SET status=?, detail=?, ended_at=? WHERE id=?')
      .run(status, req.body?.detail ?? c.detail, status === c.status ? c.ended_at : nowStamp(), c.id)
    res.json(db().prepare('SELECT * FROM chores WHERE id = ?').get(c.id))
  })

  /**
   * One thing to do next, on this project.
   *
   * The page answered four questions and none of them said which to act on
   * first — so the reader ranked them by hand, every time, when the ranking is
   * a judgement the tool already makes.
   */
  api.get('/projects/:slug/next', (req, res) => {
    const step = nextStep(req.params.slug)
    if (!step) throw new Rejected('This project does not exist.', 404)
    res.json(step)
  })

  /** The series behind the charts. Same rows as the rest, counted differently. */
  api.get('/charts', (req, res) => {
    const c = charts({ project: req.query.project })
    if (!c) throw new Rejected('This project does not exist.', 404)
    res.json(c)
  })

  // Scoped on demand: the overview asks for everything, a project page for its
  // own, an objective page for what is stopping that objective specifically.
  api.get('/blockers', (req, res) =>
    res.json(blockersFor({ project: req.query.project, objective: req.query.objective })),
  )

  /** What each harness is wired to, read from the harnesses' own configuration. */
  api.get('/mcp', (_req, res) => res.json(mcpServers()))

  // ---- stockages distants -------------------------------------------------

  const publicStorage = (st) => {
    const { credentials, ...reste } = st
    const plain = credentials ? json.read(decrypt(credentials), {}) : null
    return {
      ...reste,
      enabled: Boolean(st.enabled),
      // Credentials never leave: the screen needs to know they exist, not to read
      // them.
      has_credentials: Boolean(credentials),
      // It does need to know HOW we authenticate, though: a connected account and
      // a service-account key are not repaired the same way.
      auth_kind: plain?.refresh_token ? 'oauth' : plain?.client_email ? 'service_account' : plain ? 'token' : null,
      oauth_ready: oauthAppPresent(PROVIDER_OF[st.provider]),
      uploads: db().prepare('SELECT COUNT(*) n FROM evidence_remotes WHERE storage_id = ?').get(st.id).n,
    }
  }

  const storageWithSecrets = (id) => {
    const st = db().prepare('SELECT * FROM storages WHERE id = ?').get(id)
    if (!st) throw new Rejected('This storage does not exist.', 404)
    return { ...st, credentials: decrypt(st.credentials) }
  }

  api.get('/storages', (_req, res) =>
    res.json(db().prepare('SELECT * FROM storages ORDER BY id').all().map(publicStorage)),
  )

  api.post('/storages', (req, res) => {
    const b = req.body ?? {}
    if (!['gdrive', 'dropbox'].includes(b.provider)) throw new Rejected('Fournisseur inconnu : gdrive ou dropbox.')
    if (!b.label?.trim()) throw new Rejected('Le stockage doit porter un nom lisible.')
    const r = db()
      .prepare('INSERT INTO storages (provider,label,target,credentials) VALUES (?,?,?,?)')
      .run(b.provider, b.label, b.target ?? null, encrypt(b.credentials ? JSON.stringify(b.credentials) : null))
    res.status(201).json(publicStorage(db().prepare('SELECT * FROM storages WHERE id = ?').get(r.lastInsertRowid)))
  })

  api.patch('/storages/:id', (req, res) => {
    const st = db().prepare('SELECT * FROM storages WHERE id = ?').get(req.params.id)
    if (!st) throw new Rejected('This storage does not exist.', 404)
    const b = req.body ?? {}
    const champs = {}
    for (const k of ['label', 'target']) if (k in b) champs[k] = b[k]
    if ('enabled' in b) champs.enabled = b.enabled ? 1 : 0
    // Three distinct cases, as with agent keys: absent = touch nothing; empty =
    // clear it; a value = replace it.
    if ('credentials' in b) {
      champs.credentials = b.credentials ? encrypt(JSON.stringify(b.credentials)) : null
    }
    const noms = Object.keys(champs)
    if (noms.length) {
      db().prepare(`UPDATE storages SET ${noms.map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`).run({ ...champs, id: st.id })
    }
    res.json(publicStorage(db().prepare('SELECT * FROM storages WHERE id = ?').get(st.id)))
  })

  api.delete('/storages/:id', (req, res) => {
    db().prepare('DELETE FROM storages WHERE id = ?').run(req.params.id)
    res.sendStatus(204)
  })

  /**
   * The redirect URI has to be IDENTICAL, character for character, to the one
   * declared with the provider — otherwise the callback is refused with no useful
   * explanation. So it is derived in exactly one place.
   */
  const redirectUri = () =>
    `${process.env.ORCHESTRATOR_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4747}`}/api/storages/oauth/callback`

  /**
   * Returns the address where a person authorises THEIR account. We do not open a
   * browser from the server: whoever clicks is the one who must consent, and they
   * are not necessarily on the same machine.
   */
  api.post('/storages/:id/connect', (req, res) => {
    const st = db().prepare('SELECT * FROM storages WHERE id = ?').get(req.params.id)
    if (!st) throw new Rejected('This storage does not exist.', 404)

    const provider = PROVIDER_OF[st.provider]
    const state = openPendingAuth({ storage: st.id, provider })
    res.json({ url: consentUrl(provider, { redirect: redirectUri(), state }), provider })
  })

  /**
   * The authorisation callback. It lands in a browser, so it answers in HTML: a
   * raw JSON error here would be read by nobody.
   */
  api.get('/storages/oauth/callback', async (req, res) => {
    const page = (title, body) =>
      res
        .status(200)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
            '<style>body{font:15px/1.6 system-ui;margin:15vh auto;max-width:34rem;padding:0 1.5rem}' +
            'h1{font-size:1.15rem;margin:0 0 .6rem}p{color:#444}</style>' +
            `<h1>${title}</h1>${body}`,
        )

    try {
      // The `state` first: without it, any page at all could send this server off
      // to exchange a code of its own choosing.
      const pendingAuth = req.query.state ? closePendingAuth(String(req.query.state)) : null
      if (!pendingAuth) {
        return page(
          'Unknown or expired request',
          '<p>Start the connection again from the Storage screen. An authorisation request is only valid for fifteen minutes.</p>',
        )
      }
      if (req.query.error) {
        return page('Authorisation refused', `<p>The provider answered: ${req.query.error}</p>`)
      }

      const { refresh_token, access_token } = await exchangeCode(pendingAuth.provider, {
        code: String(req.query.code ?? ''),
        redirect: redirectUri(),
      })
      const account = await accountOf(pendingAuth.provider, access_token)

      db()
        .prepare('UPDATE storages SET credentials=?, account=?, last_status=?, last_detail=? WHERE id=?')
        .run(
          encrypt(JSON.stringify({ refresh_token })),
          account,
          'ok',
          `account ${account ?? 'connected'} authorised`,
          pendingAuth.storage,
        )

      page(
        'Account connected',
        `<p>${account ?? 'The account'} is authorised. Proofs will go into its space — ` +
          'nobody else has to share theirs.</p><p>You can close this tab.</p>',
      )
    } catch (e) {
      page('The connection failed', `<p>${String(e.message)}</p>`)
    }
  })

  /** Checks without depositing anything: does the storage answer, and does the folder exist? */
  api.post('/storages/:id/check', async (req, res, next) => {
    try {
      const st = storageWithSecrets(req.params.id)
      if (!st.credentials) throw new Rejected('No credentials recorded for this storage.')
      const r = await checkStorage(st)
      db().prepare('UPDATE storages SET last_status=?, last_detail=? WHERE id=?').run(r.status, r.detail, st.id)
      res.json(publicStorage(db().prepare('SELECT * FROM storages WHERE id = ?').get(st.id)))
    } catch (e) {
      db()
        .prepare('UPDATE storages SET last_status=?, last_detail=? WHERE id=?')
        .run('refused', String(e.message).slice(0, 240), req.params.id)
      next(e)
    }
  })

  /**
   * Prepares the drop folder: creates it and shares it. Nobody has to do anything
   * by hand — asking them to was laziness.
   */
  api.post('/storages/:id/prepare', async (req, res, next) => {
    try {
      const st = storageWithSecrets(req.params.id)
      if (st.provider !== 'gdrive') throw new Rejected('Dropbox creates its path by itself on the first upload.')
      if (!st.credentials) throw new Rejected('No credentials recorded for this storage.')

      const r = await createDriveFolder(st, {
        name: req.body?.name || `Orchestrator — Proofs`,
        shareWith: req.body?.partager_avec || null,
      })

      db()
        .prepare('UPDATE storages SET target=?, last_status=?, last_detail=? WHERE id=?')
        .run(r.id, 'ok', `folder “${r.name}” created${r.sharedWith ? ` · shared with ${r.sharedWith}` : ''}`, st.id)

      res.json({ ...publicStorage(db().prepare('SELECT * FROM storages WHERE id = ?').get(st.id)), folder: r })
    } catch (e) {
      next(e)
    }
  })

  /**
   * Uploads the proofs that are not over there yet. We send ONLY what is missing:
   * resending everything each time would cost a lot and erase the distinction
   * between "already shared" and "new".
   */
  /**
   * Bring the proof files back down.
   *
   * The record travels in an export; the files did not travel at all. A second
   * machine could import five hundred proofs and hold not one of them, and this
   * one after a restore was in the same position — the upload had no
   * counterpart.
   *
   * Only ever writes what is MISSING. A file already on disk is the local truth
   * and is left alone: a "sync" that overwrites what you have is how work
   * disappears. What it writes, it verifies against the fingerprint recorded
   * when the file went up.
   */
  api.post('/storages/:id/pull', async (req, res, next) => {
    try {
      const st = storageWithSecrets(req.params.id)
      if (!st.credentials) throw new Rejected('No credentials recorded for this storage.')

      const { download } = await import('./storage.js')
      const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
      const { dirname, resolve, isAbsolute } = await import('node:path')
      const { createHash } = await import('node:crypto')

      const limite = Math.min(Number(req.body?.limite ?? 50), 200)

      const lignes = db()
        .prepare(
          `SELECT er.remote_id, er.sha256, e.ref, p.repo_path
             FROM evidence_remotes er
             JOIN evidences e   ON e.id = er.evidence_id
             JOIN objectives o  ON o.id = e.objective_id
             JOIN projects p    ON p.id = o.project_id
            WHERE er.storage_id = ? AND e.ref IS NOT NULL AND p.repo_path IS NOT NULL
            ORDER BY er.id DESC`,
        )
        .all(st.id)

      const manquants = lignes
        .filter((l) => {
          const chemin = isAbsolute(l.ref) ? l.ref : resolve(l.repo_path, l.ref)
          return !existsSync(chemin)
        })
        .slice(0, limite)

      const posed = []
      const failed = []

      for (const l of manquants) {
        // A ref is one path. Some were written as a LIST — three filenames
        // crammed into one field, separated by "·" — and writing that blindly
        // put a 1.2 MB file on disk under a nonsense name. Malformed data must
        // surface, not land in somebody's repository.
        if (/[·,\n\r]/.test(l.ref)) {
          failed.push({ ref: l.ref, why: 'the reference is not a single path — nothing written' })
          continue
        }

        const chemin = isAbsolute(l.ref) ? l.ref : resolve(l.repo_path, l.ref)
        try {
          const bytes = await download(st, l.remote_id)
          const empreinte = createHash('sha256').update(bytes).digest('hex')
          if (l.sha256 && empreinte !== l.sha256) {
            failed.push({ ref: l.ref, why: 'fingerprint does not match what went up' })
            continue
          }
          mkdirSync(dirname(chemin), { recursive: true })
          writeFileSync(chemin, bytes)
          posed.push(l.ref)
        } catch (e) {
          failed.push({ ref: l.ref, why: String(e.message).slice(0, 120) })
        }
      }

      res.json({ missing: manquants.length, written: posed.length, posed, failed })
    } catch (e) {
      next(e)
    }
  })

  api.post('/storages/:id/sync', async (req, res, next) => {
    try {
      const st = storageWithSecrets(req.params.id)
      if (!st.enabled) throw new Rejected('This storage is disabled.')
      if (!st.credentials) throw new Rejected('No credentials recorded for this storage.')

      const limite = Math.min(Number(req.body?.limite ?? 25), 100)

      // Filter to what CAN be uploaded before taking the batch, never after. The
      // unresolvable rows sit at the head of the id-descending queue, so a batch
      // taken first was spent entirely on them: forty skipped, zero uploaded, and
      // the same forty on the next call. The batch has to be forty pieces of work.
      const outstanding = db()
        .prepare(
          `SELECT e.id, e.ref, e.label, o.project_id, p.repo_path
           FROM evidences e
           JOIN objectives o ON o.id = e.objective_id
           JOIN projects p ON p.id = o.project_id
           WHERE e.ref IS NOT NULL
             AND e.id NOT IN (SELECT evidence_id FROM evidence_remotes WHERE storage_id = ?)
           ORDER BY e.id DESC`,
        )
        .all(st.id)

      const skipped = outstanding.filter((c) => uploadablePath(c) === null).length
      const candidates = outstanding.filter((c) => uploadablePath(c) !== null).slice(0, limite)

      const uploaded = []
      const failures = []

      for (const c of candidates) {
        const absolute = path(c.repo_path, uploadablePath(c))

        try {
          const r = await upload(st, absolute)
          db()
            .prepare(
              `INSERT OR REPLACE INTO evidence_remotes (evidence_id,storage_id,remote_id,remote_url,bytes,sha256,sent_at)
               VALUES (?,?,?,?,?,?,?)`,
            )
            .run(c.id, st.id, r.remote_id, r.remote_url, r.bytes, r.sha256, nowStamp())
          uploaded.push({ evidence_id: c.id, file: basename(absolute), url: r.remote_url })
        } catch (e) {
          failures.push({ evidence_id: c.id, file: basename(absolute), error: String(e.message).slice(0, 200) })
        }
      }

      // `remaining` must mean "work left", not "rows left". Counting proofs whose
      // ref is prose reported 155 outstanding when the real queue was empty.
      const remaining = db()
        .prepare(
          `SELECT e.id, e.ref, p.repo_path FROM evidences e
           JOIN objectives o ON o.id = e.objective_id
           JOIN projects p ON p.id = o.project_id
           WHERE e.ref IS NOT NULL
             AND e.id NOT IN (SELECT evidence_id FROM evidence_remotes WHERE storage_id = ?)`,
        )
        .all(st.id)
        .filter((c) => uploadablePath(c) !== null).length

      db()
        .prepare('UPDATE storages SET last_sync_at=?, last_status=?, last_detail=? WHERE id=?')
        .run(
          nowStamp(),
          failures.length && !uploaded.length ? 'refused' : 'ok',
          `${uploaded.length} uploaded, ${failures.length} failed, ${remaining} left` +
            (skipped ? ` · ${skipped} carry no file` : ''),
          st.id,
        )

      res.json({ uploaded, failures, skipped, remaining })
    } catch (e) {
      next(e)
    }
  })

  // ---- agents -------------------------------------------------------------

  api.get('/agents', (_req, res) =>
    res.json(db().prepare('SELECT * FROM agents ORDER BY priority, name').all().map(sortirAgent)),
  )

  api.post('/agents', (req, res) => {
    const b = req.body ?? {}
    if (!/^[a-z0-9-]+$/.test(b.name ?? '')) {
      throw new Rejected('A technical name takes only lowercase letters, digits and hyphens.')
    }
    if (!b.label?.trim()) throw new Rejected('The agent needs a readable name.')
    const KINDS = ['model', 'machine', 'service', 'browser', 'source']
    if (b.kind && !KINDS.includes(b.kind)) {
      throw new Rejected(`Unknown kind: ${KINDS.join(', ')}.`)
    }
    if (db().prepare('SELECT 1 FROM agents WHERE name = ?').get(b.name)) {
      throw new Rejected('An agent already has that technical name.')
    }
    const r = db()
      .prepare(
        `INSERT INTO agents (name,label,kind,reach,role,enabled,priority,api_key,settings,capabilities,env_var,endpoint)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        // `kind` was in the schema, on the screen, and dropped here in silence:
        // every agent created through this route came back `null`. Validated
        // rather than passed through, so an unknown one is refused out loud.
        b.name, b.label, b.kind ?? null, b.reach ?? 'cli', b.role ?? 'executant',
        b.enabled === false ? 0 : 1, nombre(b.priority, 50),
        encrypt(b.api_key), json.write(b.settings ?? null),
        json.write(b.capabilities ?? []), b.env_var ?? null, b.endpoint ?? null,
      )
    res.status(201).json(sortirAgent(db().prepare('SELECT * FROM agents WHERE id = ?').get(r.lastInsertRowid)))
  })

  api.patch('/agents/reorder', (req, res) => {
    const ordre = req.body?.ordre
    if (!Array.isArray(ordre) || !ordre.length) throw new Rejected('No order supplied.')
    db().transaction(() => {
      for (const l of ordre) db().prepare('UPDATE agents SET priority = ? WHERE id = ?').run(nombre(l.priority, 50), l.id)
    })()
    res.json({ ok: true })
  })

  api.post('/agents/checkin', (req, res) => {
    const b = req.body ?? {}
    if (!b.machine || !Array.isArray(b.results)) throw new Rejected('Incomplete report.')
    const vus = []
    for (const r of b.results) {
      const a = db().prepare('SELECT id FROM agents WHERE name = ?').get(r.name)
      if (!a) continue
      db()
        .prepare('UPDATE agents SET last_status=?, last_detail=?, last_machine=?, last_checked_at=? WHERE id=?')
        .run(r.status, r.detail ?? null, b.machine, nowStamp(), a.id)
      vus.push(r.name)
    }
    res.json({ mis_a_jour: vus })
  })

  api.patch('/agents/:id', (req, res) => {
    const a = db().prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id)
    if (!a) throw new Rejected('This agent does not exist.', 404)
    const b = req.body ?? {}
    const champs = {}
    for (const k of ['label', 'kind', 'reach', 'role', 'priority', 'env_var', 'endpoint']) if (k in b) champs[k] = b[k]
    if ('capabilities' in b) champs.capabilities = json.write(b.capabilities ?? [])
    if ('enabled' in b) champs.enabled = b.enabled ? 1 : 0
    if ('settings' in b) champs.settings = json.write(b.settings)

    // Three distinct cases: field absent = touch nothing; empty string = clear;
    // a value = replace. Conflating them let a key outlive its
    // suppression.
    if ('api_key' in b) champs.api_key = b.api_key ? encrypt(b.api_key) : null

    const noms = Object.keys(champs)
    if (noms.length) {
      db().prepare(`UPDATE agents SET ${noms.map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`).run({ ...champs, id: a.id })
    }
    res.json(sortirAgent(db().prepare('SELECT * FROM agents WHERE id = ?').get(a.id)))
  })

  api.delete('/agents/:id', (req, res) => {
    db().prepare('DELETE FROM agents WHERE id = ?').run(req.params.id)
    res.sendStatus(204)
  })

  /**
   * The tools available to an executor, grouped by what they can do.
   * On ne renvoie JAMAIS de secret : seulement le nom de la variable qui le
   * will fall on the machine that executes.
   */
  api.get('/toolbox', (_req, res) => {
    // Sorted by NAME, not by priority. Ordering by our preference told the judge
    // which harness to pick before it had read the mission — and a ranking, once
    // shown, is obeyed. Which one fits is a question of the work at hand, not of
    // a number we set months ago. We say what exists and what it can do; the
    // choice is the judge's.
    const agents = db()
      .prepare('SELECT * FROM agents WHERE enabled = 1 ORDER BY name')
      .all()
      .map(sortirAgent)
      .filter((a) => a.capabilities.length)

    const by = {}
    for (const a of agents) {
      for (const c of a.capabilities) {
        ;(by[c] ??= []).push({
          name: a.name,
          label: a.label,
          kind: a.kind,
          reach: a.reach,
          endpoint: a.endpoint,
          env_var: a.env_var,
          joignable: a.last_status,
          settings: a.settings,
        })
      }
    }
    res.json(by)
  })



  /**
   * The activity feed: what is happening RIGHT NOW and what just happened, in
   * time order. A status table says where things stand; it does not
   * dit pas ce qui bouge. C'est ce qui manquait pour suivre une passe en cours
   * sans lire un fichier de journal dans un terminal.
   */
  /**
   * The wiring: what is connected, and what is actually used.
   *
   * Those are two different questions and the screen answered neither. A tool can
   * be reachable and never called — a declaration nobody exercises is a guess. And
   * a tool can be called constantly while its entry says `unknown`, which is how
   * Codex spent weeks looking incapable of Unity.
   *
   * Reachability is MEASURED by `agents:check` on a machine. Usage is derived from
   * the tool counts in the passages — which were NULL for months because the
   * function that built them never returned them.
   */
  api.get('/wiring', (req, res) => {
    const agents = db().prepare('SELECT * FROM agents ORDER BY name').all().map(sortirAgent)

    // Every tool actually invoked, and by which harness. `tools_used` is a JSON
    // object of {toolName: count} written from the harness traces.
    const calls = {}
    for (const p of db()
      .prepare("SELECT harness, tools_used FROM passages WHERE tools_used IS NOT NULL AND tools_used != '{}'")
      .all()) {
      for (const [tool, n] of Object.entries(json.read(p.tools_used, {}) ?? {})) {
        const e = (calls[tool] ??= { tool, calls: 0, by: {} })
        e.calls += Number(n) || 0
        e.by[p.harness] = (e.by[p.harness] ?? 0) + (Number(n) || 0)
      }
    }

    // An MCP server is not an agent — it is a surface a harness reaches through.
    // Grouping its tools under their server is what turns a list of forty tool
    // names into something a person can read.
    const servers = {}
    for (const e of Object.values(calls)) {
      const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(e.tool)
      const key = m ? `mcp:${m[1]}` : 'built-in'
      const g = (servers[key] ??= { name: key, calls: 0, tools: [] })
      g.calls += e.calls
      g.tools.push(e)
    }
    for (const g of Object.values(servers)) g.tools.sort((a, b) => b.calls - a.calls)

    res.json({
      agents: agents.map((a) => ({
        name: a.name,
        label: a.label,
        kind: a.kind,
        reach: a.reach,
        role: a.role,
        enabled: a.enabled,
        capabilities: a.capabilities,
        reachable: a.last_status,
        detail: a.last_detail,
        checked_at: a.last_checked_at,
        machine: a.last_machine,
        /**
         * What this agent DID, in its own unit.
         *
         * `passes` counts executions, and a judge never executes one: GPT read
         * as "never used" on the tools page while it had ruled forty-two times
         * and driven a hundred and two turns. A column that measures one role
         * and is read as measuring all of them says nothing about the others.
         */
        passes: db()
          .prepare('SELECT COUNT(*) n FROM passages WHERE harness = ?')
          .get(a.name).n,
        verdicts: db()
          .prepare("SELECT COUNT(*) n FROM evidences WHERE json_extract(payload, '$.judged_by') = ?")
          .get(a.name).n,
      })),
      servers: Object.values(servers).sort((a, b) => b.calls - a.calls),
    })
  })

  api.get('/activity', (req, res) => {
    const slug = req.query.project
    const p = slug ? projectBy(slug) : null
    const filter = p ? 'AND o.project_id = @project' : ''
    const args = p ? { project: p.id } : {}

    const attempts = db()
      .prepare(
        `SELECT pa.id, pa.harness, pa.verdict, pa.cost_usd, pa.tokens, pa.started_at, pa.ended_at,
                pa.prevented, pa.prevented_by, pa.resumed_from, pa.summary,
                o.id objective_id, o.title objective_title, pr.slug project
         FROM passages pa
         JOIN objectives o ON o.id = pa.objective_id
         JOIN projects pr ON pr.id = o.project_id
         WHERE 1=1 ${filter}
         ORDER BY pa.started_at DESC LIMIT 12`,
      )
      .all(args)

    const verdicts = db()
      .prepare(
        `SELECT e.id, e.label, e.created_at, e.payload,
                o.id objective_id, o.title objective_title, pr.slug project
         FROM evidences e
         JOIN objectives o ON o.id = e.objective_id
         JOIN projects pr ON pr.id = o.project_id
         WHERE e.type = 'manual' AND e.payload LIKE '%judged_by%' ${filter}
         ORDER BY e.id DESC LIMIT 8`,
      )
      .all(args)
      .map((v) => ({ ...v, payload: json.read(v.payload) }))

    const halts = db()
      .prepare(
        `SELECT h.id, h.reason, h.detail, h.created_at, h.resolved_at,
                o.id objective_id, o.title objective_title, pr.slug project
         FROM halts h
         JOIN objectives o ON o.id = h.objective_id
         JOIN projects pr ON pr.id = o.project_id
         WHERE 1=1 ${filter}
         ORDER BY h.id DESC LIMIT 8`,
      )
      .all(args)

    // What is REALLY running: an attempt with no end. The rest is the past.
    const live = attempts.filter((t) => !t.ended_at)

    const feed = [
      ...attempts.map((t) => ({
        type: t.ended_at ? 'attempt' : 'live',
        at: t.started_at,
        ...t,
      })),
      ...verdicts.map((v) => ({ type: 'verdict', at: v.created_at, ...v })),
      ...halts.map((a) => ({ type: 'halt', at: a.created_at, ...a })),
    ]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 20)

    res.json({ live: live, feed })
  })

  // ---- local memory analysis ----------------------------------------------

  api.get('/scans', (_req, res) => {
    const minutes = (iso) =>
      iso ? Math.max(0, Math.round((Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 60000)) : null

    res.json(
      db()
        .prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 10')
        .all()
        .map((s) => ({
          ...s,
          inventory: json.read(s.inventory),
          result: json.read(s.result),
          // How long it has been waiting. A scan left "pending" for nineteen hours
          // was not waiting: nobody was listening. The screen
          // doit le dire au lieu d'afficher une patience sans fin.
          waiting_minutes: ['pending', 'running'].includes(s.status)
            ? minutes(s.taken_at ?? s.created_at)
            : null,
          // Have the memories moved since this scan?
          stale: Boolean(s.fingerprint && s.fingerprint_seen && s.fingerprint !== s.fingerprint_seen),
        })),
    )
  })

  api.post('/scans', (_req, res) => {
    const r = db().prepare("INSERT INTO scans (status) VALUES ('pending')").run()
    res.status(201).json(db().prepare('SELECT * FROM scans WHERE id = ?').get(r.lastInsertRowid))
  })

  /** A local agent claims the scan: it is the one with access to the disk. */
  api.post('/scans/claim', (req, res) => {
    const pris = db().transaction(() => {
      const s = db().prepare("SELECT * FROM scans WHERE status = 'pending' ORDER BY id LIMIT 1").get()
      if (!s) return null
      db()
        .prepare("UPDATE scans SET status='running', machine=?, taken_at=? WHERE id=?")
        .run(req.body?.machine ?? 'inconnue', nowStamp(), s.id)
      return db().prepare('SELECT * FROM scans WHERE id = ?').get(s.id)
    })()
    res.json({ scan: pris && { ...pris, inventory: json.read(pris.inventory) } })
  })

  api.patch('/scans/:id', (req, res) => {
    const s = db().prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id)
    if (!s) throw new Rejected('This scan does not exist.', 404)
    const b = req.body ?? {}
    const champs = { status: b.status ?? s.status }
    if ('inventory' in b) champs.inventory = json.write(b.inventory)
    if ('result' in b) champs.result = json.write(b.result)
    if ('error' in b) champs.error = b.error
    for (const k of ['fingerprint', 'fingerprint_seen', 'seen_at']) if (k in b) champs[k] = b[k]
    db()
      .prepare(`UPDATE scans SET ${Object.keys(champs).map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`)
      .run({ ...champs, id: s.id })
    const maj = db().prepare('SELECT * FROM scans WHERE id = ?').get(s.id)
    res.json({ ...maj, inventory: json.read(maj.inventory), result: json.read(maj.result) })
  })

  /**
   * A human accepts a project's distilled context. It becomes a project decision,
   * so the agent rereads it on every brief — that is the whole point: what was
   * learned elsewhere stops being rediscovered here.
   */
  /**
   * Creates a project FROM a distilled context. That was the scan's original
   * intent: discover the projects inside the memories, not merely enrich the ones
   * already declared by hand.
   */
  api.post('/scans/:id/creer', (req, res) => {
    const s = db().prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id)
    if (!s) throw new Rejected('This scan does not exist.', 404)

    const { slug, name, repo_path, title, body, sources } = req.body ?? {}
    if (!/^[a-z0-9-]+$/.test(slug ?? '')) {
      throw new Rejected('Invalid project id: lowercase letters, digits and hyphens.')
    }
    if (db().prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)) {
      throw new Rejected(`Project “${slug}” already exists — attach the context instead of recreating it.`)
    }
    if (repo_path && !existsSync(repo_path)) {
      // A wrong repository path breaks everything else silently: proofs
      // ne se servent plus, les sondes ne tournent plus.
      throw new Rejected(`This repository does not exist on this machine: ${repo_path}`)
    }

    const cree = db().transaction(() => {
      const p = db()
        .prepare("INSERT INTO projects (slug,name,repo_path,gate_judge) VALUES (?,?,?,'gpt')")
        .run(slug, name?.trim() || slug, repo_path || null)

      if (body?.trim()) {
        db()
          .prepare('INSERT INTO decisions (project_id,title,body,paths) VALUES (?,?,?,?)')
          .run(
            p.lastInsertRowid,
            title?.trim() || 'Context taken from the local memories',
            body,
            json.write(sources ?? []),
          )
      }
      return p.lastInsertRowid
    })()

    res.status(201).json(db().prepare('SELECT * FROM projects WHERE id = ?').get(cree))
  })

  api.post('/scans/:id/apply/:slug', (req, res) => {
    const s = db().prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id)
    if (!s) throw new Rejected('This scan does not exist.', 404)
    const p = projectBy(req.params.slug)
    const { title, body, sources } = req.body ?? {}
    if (!body?.trim()) throw new Rejected('Contexte vide.')

    const r = db()
      .prepare('INSERT INTO decisions (project_id,title,body,paths,decided_at) VALUES (?,?,?,?,?)')
      .run(
        p.id,
        title?.trim() || `Context taken from the local memories (${new Date().toISOString().slice(0, 10)})`,
        body,
        json.write(sources ?? []),
        nowStamp(),
      )
    res.status(201).json(db().prepare('SELECT * FROM decisions WHERE id = ?').get(r.lastInsertRowid))
  })

  api.delete('/scans/:id', (req, res) => {
    db().prepare('DELETE FROM scans WHERE id = ?').run(req.params.id)
    res.sendStatus(204)
  })

  // ---- briefs -------------------------------------------------------------

  api.get('/projects/:slug/briefs', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json(db().prepare('SELECT * FROM briefs WHERE project_id = ? ORDER BY id DESC LIMIT 20').all(p.id).map(sortirBrief))
  })

  api.post('/projects/:slug/briefs', (req, res) => {
    const p = projectBy(req.params.slug)
    const body = String(req.body?.body ?? '').trim()
    if (body.length < 20) throw new Rejected('Too short to break down — describe what you want to end up with.')
    const r = db().prepare("INSERT INTO briefs (project_id,body,status) VALUES (?,?,'pending')").run(p.id, body)
    res.status(201).json(sortirBrief(db().prepare('SELECT * FROM briefs WHERE id = ?').get(r.lastInsertRowid)))
  })

  /**
   * "Ask what to do" — about ONE objective that is not converging.
   *
   * The request writes itself. Asking a person to describe what went wrong is
   * asking them to summarise ten sessions they did not read; the tool already
   * holds every fact that matters — how many attempts, what came back failing,
   * what halted it, how the last run ended — and a summary written from the
   * record cannot flatter the work the way a remembered one does.
   *
   * It produces a brief, and a brief PROPOSES. Nothing here rewrites a criterion
   * on its own: an objective silently re-aimed by a machine is exactly the thing
   * this tool exists to make impossible.
   */
  /**
   * The answer already paid for, on the objective it is about.
   *
   * The panel only knew the brief it had just created, so pressing "ask what to
   * do", closing the tab and coming back showed the button again — with a
   * verdict sitting in the database, bought and unread. A page that forgets what
   * it asked for is a page that asks twice.
   */
  /**
   * What the open attempt is doing, right now.
   *
   * Null when nothing runs — the caller then falls back to the recorded mission
   * and reply, which beat a stale stream.
   */
  api.get('/objectives/:id/live', (req, res) => res.json(live(Number(req.params.id))))

  /** What to do about this one objective, in the words of somebody who has to act. */
  api.get('/objectives/:id/next', (req, res) => {
    const step = nextStepForObjective(Number(req.params.id))
    if (!step) throw new Rejected('This objective does not exist.', 404)
    // The same question always answered the same way: what can be done, and what
    // each one costs. The analysis's branches were the only options on any
    // screen, and they were the only thing anybody found readable.
    res.json({ ...step, choices: choices(Number(req.params.id)) })
  })

  api.get('/objectives/:id/recalibration', (req, res) => {
    /**
     * The LAST one, whatever became of it — and nothing at all once it is applied.
     *
     * This asked for "the latest that is not applied", so the moment a
     * recalibration was applied the panel fell back to the failed attempt before
     * it and displayed its error. A success then read, word for word, as the
     * failure of the thing that had just worked.
     */
    /**
     * The answer is kept, applied or not.
     *
     * This returned nothing once a recalibration had been applied, so the best
     * diagnosis this tool has ever produced — a named contradiction, two branches
     * to choose between, paid for with a real session — vanished from every
     * screen the moment somebody acted on it. What you bought was a judgement,
     * and a judgement does not stop being true because it was used.
     *
     * `actionable` says whether there is still something to press.
     */
    const b = db()
      .prepare(
        `SELECT * FROM briefs WHERE objective_id = ? AND (proposal IS NOT NULL OR status != 'applied')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(req.params.id)
    res.json(b ? { ...sortirBrief(b), actionable: b.status !== 'applied' } : null)
  })

  api.post('/objectives/:id/recalibrate', async (req, res) => {
    const o = db()
      .prepare(
        `SELECT o.*, p.slug, p.name project_name FROM objectives o
         JOIN projects p ON p.id = o.project_id WHERE o.id = ?`,
      )
      .get(req.params.id)
    if (!o) throw new Rejected('This objective does not exist.', 404)

    const already = db()
      .prepare("SELECT * FROM briefs WHERE objective_id = ? AND status IN ('pending','running','proposed')")
      .get(o.id)
    if (already) return res.json(sortirBrief(already))

    const passages = db()
      .prepare('SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) spent FROM passages WHERE objective_id = ?')
      .get(o.id)
    const tally = db()
      .prepare(
        `SELECT verdict, COUNT(*) n FROM evidences WHERE objective_id = ?
         GROUP BY verdict`,
      )
      .all(o.id)
    const failing = db()
      .prepare("SELECT label FROM evidences WHERE objective_id = ? AND verdict = 'fail' ORDER BY id DESC LIMIT 6")
      .all(o.id)
    const halts = db()
      .prepare('SELECT reason, detail FROM halts WHERE objective_id = ? ORDER BY id DESC LIMIT 6')
      .all(o.id)
    const run = db()
      .prepare('SELECT outcome, reason FROM runs WHERE objective_id = ? ORDER BY id DESC LIMIT 1')
      .get(o.id)
    const children = db()
      .prepare("SELECT title, status FROM objectives WHERE parent_id = ? AND status != 'abandoned' ORDER BY priority")
      .all(o.id)

    /**
     * A draft has no history, and asking about it produced an empty page.
     *
     * The brief was composed of attempts, failures and halts — which a draft has
     * none of. Worse, the reply could only ever propose criteria the instrument
     * already knows how to check, so on a project whose complaint is "the
     * atmosphere lacks tension" it would have written a criterion about
     * saturation: an axis already satisfied, passing while the complaint stood.
     *
     * So the request now carries what this project can MEASURE, and the current
     * readings. A model cannot look at a picture through this pipe; it can
     * reason about numbers, and refuse them when they do not answer the question.
     */
    const measured = []
    if (o.status === 'draft' || !passagesCount(o.id)) {
      try {
        const { measureImage } = await import('./visual.js')
        const { readdirSync, statSync } = await import('node:fs')
        const root = join(db().prepare('SELECT repo_path FROM projects WHERE id = ?').get(o.project_id).repo_path, 'Captures')
        if (existsSync(root)) {
          const shots = readdirSync(root)
            .flatMap((d) => {
              const dir = join(root, d)
              if (!statSync(dir).isDirectory()) return []
              return readdirSync(dir)
                .filter((f) => f.endsWith('.png'))
                .map((f) => ({ path: join(dir, f), name: `${d}/${f}`, at: statSync(join(dir, f)).mtimeMs }))
            })
            .sort((a, b) => b.at - a.at)
            .slice(0, 8)
          for (const shot of shots) {
            try {
              const m = measureImage(shot.path)
              measured.push(
                `- ${shot.name}: saturation ${m.saturation}, ${m.hues} hues, ${m.distinctColours} distinct colours, ` +
                  `contrast ${m.contrast} (p95−p5), shadow ${(m.shadowShare * 100).toFixed(1)}%, ` +
                  `highlight ${(m.highlightShare * 100).toFixed(1)}%`,
              )
            } catch {
              /* an unreadable capture is not a reason to answer nothing */
            }
          }
        }
      } catch {
        /* no visual measurement available on this install */
      }
    }

    const L = []
    L.push(`Objective #${o.id} — ${o.title}`)
    if (o.intent) L.push(`Intent: ${o.intent}`)
    L.push('')
    L.push('What it currently says would prove it:')
    L.push(o.proof_spec ? o.proof_spec : '(nothing — it has no criterion at all)')
    L.push('')
    L.push(
      `History: ${passages.n} attempt(s), $${Number(passages.spent).toFixed(0)} spent, ` +
        tally.map((t) => `${t.n} ${t.verdict ?? 'unrecorded'}`).join(', ') + '.',
    )
    if (failing.length) {
      L.push('')
      L.push('What came back failing:')
      for (const f of failing) L.push(`- ${f.label}`)
    }
    if (halts.length) {
      L.push('')
      L.push('Where it stopped:')
      for (const h of halts) L.push(`- ${h.reason}: ${(h.detail ?? '').replace(/\s+/g, ' ').slice(0, 300)}`)
    }
    if (run?.outcome) {
      L.push('')
      L.push(`The last run ended on “${run.outcome}”.`)
      if (run.reason) L.push(`It had been told: ${String(run.reason).replace(/\s+/g, ' ').slice(0, 600)}`)
    }
    if (children.length) {
      L.push('')
      L.push('Its steps today:')
      for (const c of children) L.push(`- ${c.title} (${c.status})`)
    }
    /**
     * What was refused THEN, and whether it is still refused NOW.
     *
     * The history handed over is full of tool refusals, and a reader with no
     * present-tense view will raise them as obstacles to clear — the first
     * recalibration on Atlas demanded two permissions that had been granted the
     * week before, and told the reader to open them before relaunching. History
     * read as the present, which is the fault this tool exists to catch, made by
     * the analysis meant to catch it.
     */
    const pending = db()
      .prepare(
        `SELECT pattern, decision, requested FROM permissions
         WHERE project_id = ? AND requested > 0 AND decision != 'allow'`,
      )
      .all(o.project_id)

    L.push('')
    if (pending.length) {
      L.push('Tools an agent asked for on this project and that are STILL refused today:')
      for (const r of pending) L.push(`- \`${r.pattern}\` (${r.decision}, asked ${r.requested}×)`)
    } else {
      L.push(
        'Every tool refusal that appears in the history above has since been granted: nothing is ' +
          'refused on this project today. Do not raise past refusals as work to be done.',
      )
    }

    if (measured.length) {
      L.push('')
      L.push('What this project can measure, and what it reads TODAY:')
      L.push('`orchestrator visual <image.png>` reports saturation, hues, distinct colours, contrast')
      L.push('(p95−p5 of value), shadow share (< 0.15) and highlight share (> 0.85). It can gate on')
      L.push('--min-saturation, --min-hues, --min-colours, --min-contrast, --min-shadow.')
      L.push('')
      L.push(...measured)
      L.push('')
      L.push(
        'Use these numbers. A threshold already met by the current readings proves nothing — it ' +
          'would close the objective while the complaint that opened it still stands.',
      )
    }

    L.push('')
    L.push(
      'Say whether this can be proven as written, and if not, rewrite what would prove it — ' +
        'or split it into steps that each can be. Do not soften the target to make it pass: if the ' +
        'objective is over-constrained, say which constraints contradict each other and what ' +
        'decision would settle it.',
    )

    const made = db().transaction(() => {
      const r = db()
        .prepare("INSERT INTO briefs (project_id,objective_id,body,status) VALUES (?,?,?,'pending')")
        .run(o.project_id, o.id, L.join('\n'))

      /**
       * And something to carry it out.
       *
       * A brief is claimed by a `plan` run, not by the worker's ordinary loop —
       * so a brief created on its own sits pending for ever and the button looks
       * broken while being, technically, a success. Queuing the run here is what
       * makes the two ends meet, and it also means the short session it costs is
       * recorded and billed like every other.
       */
      db()
        .prepare(
          `INSERT INTO runs (project_id, objective_id, mode, max_turns, budget,
                             budget_without_progress, post, hold_between_turns, jump, reason, alongside)
           VALUES (?,?,'plan',1,NULL,120,1,0,1,?,1)`,
        )
        .run(o.project_id, o.id, `Recalibrate #${o.id} — ${o.title}`)

      return r.lastInsertRowid
    })()

    res.status(201).json(sortirBrief(db().prepare('SELECT * FROM briefs WHERE id = ?').get(made)))
  })

  /** Claimed in one write: two agents never pay for the same breakdown. */
  api.post('/projects/:slug/briefs/claim', (req, res) => {
    const p = projectBy(req.params.slug)
    const pris = db().transaction(() => {
      const b = db()
        .prepare("SELECT * FROM briefs WHERE project_id = ? AND status = 'pending' ORDER BY id LIMIT 1")
        .get(p.id)
      if (!b) return null
      db()
        .prepare("UPDATE briefs SET status='running', harness=?, taken_at=? WHERE id=?")
        .run(req.body?.harness ?? 'claude', nowStamp(), b.id)
      return db().prepare('SELECT * FROM briefs WHERE id = ?').get(b.id)
    })()
    res.json({ brief: sortirBrief(pris) })
  })

  api.patch('/briefs/:id/propose', (req, res) => {
    const b = db().prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id)
    if (!b) throw new Rejected('This brief does not exist.', 404)
    const prop = req.body?.proposal
    if (prop) {
      /**
       * Two questions, two shapes, and this guard only knew one.
       *
       * A recalibration answers with a verdict on an existing objective, not with
       * chapters — so it was refused here as an "unusable breakdown" AFTER the
       * session had been paid for, and the call that reported it was `soft`, so
       * the refusal was swallowed. The worker's log said `over_constrained`; the
       * database said the brief was still running. The same guard that catches a
       * bad reply hid a good one, silently, for the exact reason it exists.
       */
      if (b.objective_id) {
        if (!prop.verdict || !prop.why) {
          throw new Rejected('Unusable recalibration: it carries no verdict on the objective.')
        }
      } else {
        // One chapter or several. The breakdown learned to return `chapters` this
        // morning and this guard was not told, so a plan of eighteen chapters would
        // have been refused here — after being paid for.
        const chapters = Array.isArray(prop.chapters) && prop.chapters.length ? prop.chapters : [prop]
        const usable = chapters.every((c) => c?.chapter && Array.isArray(c.steps) && c.steps.length)
        if (!usable) {
          throw new Rejected('Unusable breakdown: every chapter needs a title and at least one step.')
        }
      }
    }
    db()
      .prepare('UPDATE briefs SET proposal=?, error=?, status=? WHERE id=?')
      .run(json.write(prop ?? null), req.body?.error ?? null, prop ? 'proposed' : 'failed', b.id)
    res.json(sortirBrief(db().prepare('SELECT * FROM briefs WHERE id = ?').get(b.id)))
  })

  /** C'est SEULEMENT here que des objectifs naissent, et sur le texte relu par l'humain. */
  /**
   * One brief, by id.
   *
   * The front has had a method for this route since briefs existed and the route
   * did not: nothing called it until a screen started polling one, and then it
   * polled a 404 for ever while showing "thinking".
   */
  api.get('/briefs/:id', (req, res) => {
    const b = db().prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id)
    if (!b) throw new Rejected('This brief does not exist.', 404)
    res.json(sortirBrief(b))
  })

  api.post('/briefs/:id/apply', (req, res) => {
    const b = db().prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id)
    if (!b) throw new Rejected('This brief does not exist.', 404)
    const d = req.body ?? {}

    /**
     * A recalibration lands ON an objective rather than beside it.
     *
     * Applying is deliberately narrow: the criterion, and steps if splitting was
     * the answer. The verdict and its reasoning are not stored as a decision —
     * an opinion produced by a machine that was asked to judge its own family of
     * work is a thing to read, not a thing to file as settled.
     */
    if (b.objective_id) {
      const o = db().prepare('SELECT * FROM objectives WHERE id = ?').get(b.objective_id)
      if (!o) throw new Rejected('The objective this was about no longer exists.', 404)

      const criterion = String(d.criterion ?? '').trim()
      const steps = Array.isArray(d.steps) ? d.steps.filter((e) => e?.title?.trim()) : []
      if (!criterion && !steps.length) throw new Rejected('Nothing to apply: no criterion and no steps.')

      /**
       * Replacing a criterion is not a side effect of pressing apply.
       *
       * The first real use of this button replaced a four-item criterion with the
       * model's own one-line summary of it — "(unchanged — this is an arbitration,
       * not a rewrite)" — and deleted the three items the summary did not mention.
       * The reply meant "leave it alone" and the apply read it as "here is the new
       * text". So the caller now has to SAY it is replacing, and a criterion that
       * loses more than half its substance is refused unless it says so twice.
       */
      const replacing = criterion && criterion !== o.proof_spec
      if (replacing && !d.replace_criterion) {
        throw new Rejected(
          'This would rewrite the criterion. Tick “replace the criterion” if that is what you mean.',
        )
      }
      if (replacing && o.proof_spec && criterion.length < o.proof_spec.length * 0.5 && !d.shrink_ok) {
        throw new Rejected(
          `The proposed criterion is ${Math.round((1 - criterion.length / o.proof_spec.length) * 100)}% ` +
            'shorter than the one it replaces — that usually means a summary, not a rewrite. ' +
            'Confirm again if you really mean to drop what it leaves out.',
        )
      }

      db().transaction(() => {
        if (replacing) {
          // `proof_spec_changed_at` is not bookkeeping: the stalling guard counts
          // attempts SINCE it, so a criterion rewritten without stamping it would
          // leave ten failures counting against a question that no longer exists
          // — and the objective refusing to start for a reason its rewrite had
          // already answered.
          db()
            .prepare(
              'UPDATE objectives SET proof_spec = ?, proof_spec_changed_at = ?, updated_at = ? WHERE id = ?',
            )
            .run(criterion, nowStamp(), nowStamp(), o.id)
        }
        let prio = db()
          .prepare('SELECT COALESCE(MAX(priority),0) m FROM objectives WHERE parent_id = ?')
          .get(o.id).m
        for (const e of steps) {
          prio += 10
          db()
            .prepare(
              `INSERT INTO objectives (project_id,parent_id,title,proof_spec,blast_radius,priority,status)
               VALUES (?,?,?,?,?,?,?)`,
            )
            .run(
              o.project_id, o.id, e.title, e.proof_spec ?? null,
              e.blast_radius ?? 'feature', prio,
              e.proof_spec ? 'ready' : 'draft',
            )
        }
        db().prepare("UPDATE briefs SET status = 'applied' WHERE id = ?").run(b.id)
      })()

      // What it DID, in the words the screen will repeat. "Applied" alone leaves
      // the reader to guess whether the criterion moved.
      return res.json({
        objective: db().prepare('SELECT * FROM objectives WHERE id = ?').get(o.id),
        steps: steps.length,
        criterion_replaced: Boolean(replacing),
      })
    }

    // One chapter or several — a request is one piece of work, a plan already has
    // its own chapters, and flattening eighteen of them into one loses the plan.
    const chapters = Array.isArray(d.chapters) && d.chapters.length ? d.chapters : [d]

    for (const c of chapters) {
      if (!c.chapter?.trim()) throw new Rejected('Every chapter must have a title.')
      if (!Array.isArray(c.steps) || !c.steps.length) {
        throw new Rejected(`“${c.chapter}” has no steps — a chapter with none is useless.`)
      }
    }

    const made = db().transaction(() => {
      let prio =
        db().prepare('SELECT COALESCE(MAX(priority),0) m FROM objectives WHERE project_id=? AND parent_id IS NULL').get(b.project_id).m

      const ids = []
      for (const chapter of chapters) {
        prio += 10
        const c = db()
          .prepare(
            `INSERT INTO objectives (project_id,title,intent,blast_radius,priority,status)
             VALUES (?,?,?,'feature',?,'draft')`,
          )
          .run(b.project_id, chapter.chapter, chapter.intent ?? null, prio)

        chapter.steps.forEach((e, i) => {
          db()
            .prepare(
              `INSERT INTO objectives (project_id,parent_id,title,proof_spec,blast_radius,priority,status)
               VALUES (?,?,?,?,?,?,?)`,
            )
            .run(
              b.project_id, c.lastInsertRowid, e.title, e.proof_spec ?? null,
              e.blast_radius ?? 'feature', (i + 1) * 10,
              // A step with no checkable criterion stays a draft. The gate refuses
              // to start it and says why — better than a criterion nobody can check,
              // which is what makes a chapter run six times and conclude never.
              e.proof_spec?.trim() ? 'ready' : 'draft',
            )
        })
        ids.push(c.lastInsertRowid)
      }

      db().prepare("UPDATE briefs SET status='applied' WHERE id=?").run(b.id)
      return ids
    })()

    res.status(201).json(
      made.map((id) => ({
        ...objectiveBy(id),
        children: db().prepare('SELECT * FROM objectives WHERE parent_id = ? ORDER BY priority').all(id),
      })),
    )
  })

  api.delete('/briefs/:id', (req, res) => {
    db().prepare('DELETE FROM briefs WHERE id = ?').run(req.params.id)
    res.sendStatus(204)
  })

  // ---- workflows, permissions, invariants, ressources ---------------------

  api.get('/projects/:slug/workflows', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json(
      db()
        .prepare('SELECT * FROM workflows WHERE project_id = ?')
        .all(p.id)
        .map((w) => ({
          ...w,
          active: Boolean(w.active),
          steps: json.read(w.steps, []),
          stop_when: json.read(w.stop_when, {}),
          absorb: json.read(w.absorb, []),
        })),
    )
  })

  api.get('/projects/:slug/permissions', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json(db().prepare('SELECT * FROM permissions WHERE project_id = ? ORDER BY harness, pattern').all(p.id))
  })

  /**
   * Write one rule by hand.
   *
   * Everything else on this screen is derived: a rule appears because a session
   * asked for it. That holds right up to the case that costs the most — a tool
   * nobody has asked for, because the pass that needed it was refused in silence
   * and could only say so in its prose, which nothing reads.
   *
   * `Bash(node ../orchestrator/src/cli.js *)` was missing on two projects for
   * days. A criterion named it as its own arbiter, every pass hit the wall, and
   * this screen offered no way to enter it: the only doors were "an agent asks"
   * and "copy another project". Adding it meant writing into the database by
   * hand, which is not a thing an interface should make anyone do.
   *
   * Re-adding a pattern that already exists changes its decision instead of
   * inserting a duplicate the UNIQUE index would refuse anyway.
   */
  api.post('/projects/:slug/permissions', (req, res) => {
    const p = projectBy(req.params.slug)
    const b = req.body ?? {}
    const pattern = String(b.pattern ?? '').trim()
    const harness = String(b.harness ?? '').trim()
    const decision = b.decision ?? 'allow'

    if (!pattern) {
      throw new Rejected('A rule needs a pattern — written as the harness writes it, e.g. `Bash(node *)`.')
    }
    if (!harness) throw new Rejected('A rule belongs to one harness. Say which.')
    if (!['allow', 'deny', 'ask'].includes(decision)) throw new Rejected('Unknown decision.')

    const already = db()
      .prepare('SELECT * FROM permissions WHERE project_id = ? AND harness = ? AND pattern = ?')
      .get(p.id, harness, pattern)

    if (already) {
      db().prepare('UPDATE permissions SET decision = ? WHERE id = ?').run(decision, already.id)
      return res.json(db().prepare('SELECT * FROM permissions WHERE id = ?').get(already.id))
    }

    const r = db()
      .prepare(
        `INSERT INTO permissions (project_id, harness, pattern, label, decision, note)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(p.id, harness, pattern, b.label?.trim() || 'Added by hand', decision, b.note?.trim() || null)

    res.status(201).json(db().prepare('SELECT * FROM permissions WHERE id = ?').get(r.lastInsertRowid))
  })

  api.get('/projects/:slug/permissions/effective/:harness', (req, res) => {
    const p = projectBy(req.params.slug)
    const lines = db()
      .prepare('SELECT pattern, decision FROM permissions WHERE project_id = ? AND harness = ?')
      .all(p.id, req.params.harness)
    res.json({
      allow: lines.filter((l) => l.decision === 'allow').map((l) => l.pattern),
      deny: lines.filter((l) => l.decision === 'deny').map((l) => l.pattern),
      ask: lines.filter((l) => l.decision === 'ask').map((l) => l.pattern),
    })
  })

  /**
   * Copy one project's allowed list onto another.
   *
   * Seeding a list by hand is sixty decisions taken one at a time, and the cost
   * of getting it wrong is silent: a session simply refuses every call it needs
   * and bills for the refusals. A project that already works is the only honest
   * starting point — better than a list invented here, which would be a guess
   * dressed as a default.
   *
   * Denials are copied too. Copying only the permissions would quietly widen
   * what the source project allows.
   */
  api.post('/projects/:slug/permissions/copy', (req, res) => {
    const target = projectBy(req.params.slug)
    const source = projectBy(String(req.body?.from ?? ''))
    if (source.id === target.id) throw new Rejected('A project cannot be copied onto itself.')

    const rows = db()
      .prepare('SELECT harness, pattern, label, decision, note FROM permissions WHERE project_id = ?')
      .all(source.id)
    if (!rows.length) throw new Rejected(`${source.name} has no rules to copy.`)

    // Existing rules win: this fills a gap, it does not overwrite a decision
    // someone already took on the target.
    const insert = db().prepare(
      `INSERT INTO permissions (project_id, harness, pattern, label, decision, note)
       SELECT @project_id, @harness, @pattern, @label, @decision, @note
       WHERE NOT EXISTS (
         SELECT 1 FROM permissions WHERE project_id = @project_id AND harness = @harness AND pattern = @pattern
       )`,
    )
    let added = 0
    db().transaction(() => {
      for (const r of rows) added += insert.run({ ...r, project_id: target.id }).changes
    })()

    res.json({ added, from: source.slug, skipped: rows.length - added })
  })

  api.patch('/permissions/:id', (req, res) => {
    const perm = db().prepare('SELECT * FROM permissions WHERE id = ?').get(req.params.id)
    if (!perm) throw new Rejected('This permission does not exist.', 404)
    if (!['allow', 'deny', 'ask'].includes(req.body?.decision)) throw new Rejected('Unknown decision.')
    db().prepare('UPDATE permissions SET decision = ? WHERE id = ?').run(req.body.decision, perm.id)
    res.json(db().prepare('SELECT * FROM permissions WHERE id = ?').get(perm.id))
  })

  api.post('/projects/:slug/permissions/requested', (req, res) => {
    const p = projectBy(req.params.slug)
    const { harness, patterns } = req.body ?? {}
    if (!harness || !Array.isArray(patterns)) throw new Rejected('Incomplete report.')
    db().transaction(() => {
      for (const reason of patterns) {
        db()
          .prepare(
            `INSERT INTO permissions (project_id,harness,pattern,decision,requested,last_requested_at)
             VALUES (?,?,?,'ask',1,?)
             ON CONFLICT(project_id,harness,pattern)
             DO UPDATE SET requested = requested + 1, last_requested_at = excluded.last_requested_at`,
          )
          .run(p.id, harness, reason, nowStamp())
      }
    })()
    res.json({ ok: true })
  })

  api.get('/projects/:slug/invariants', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json(db().prepare('SELECT * FROM invariants WHERE project_id = ?').all(p.id).map((i) => ({ ...i, armed: Boolean(i.armed) })))
  })

  api.post('/invariants/:id/readings', (req, res) => {
    const i = db().prepare('SELECT * FROM invariants WHERE id = ?').get(req.params.id)
    if (!i) throw new Rejected('This invariant does not exist.', 404)
    const b = req.body ?? {}

    /**
     * Say whether it holds. Nothing did.
     *
     * The reading was stored and the row handed back, and the row has no
     * `holds`. The caller reads `result.holds`, gets `undefined`, and prints
     * BREACHED — so the first two real invariants on a project both reported a
     * breach while both were comfortably inside their threshold: 1029 min under
     * a 1440 ceiling, and zero sessions under a ceiling of zero.
     *
     * A check that never pronounces still produces a verdict, and it is always
     * the alarming one.
     */
    const valeur = Number(b.value)
    const seuil = Number(i.threshold)
    const comparable = Number.isFinite(valeur) && Number.isFinite(seuil)

    const holds = !comparable
      ? null
      : i.comparison === 'gte'
        ? valeur >= seuil
        : i.comparison === 'eq'
          ? valeur === seuil
          : i.comparison === 'lt'
            ? valeur < seuil
            : i.comparison === 'gt'
              ? valeur > seuil
              : valeur <= seuil

    const status = holds === null ? 'unknown' : holds ? 'ok' : 'breached'

    db()
      .prepare('UPDATE invariants SET last_value=?, last_status=?, last_checked_at=? WHERE id=?')
      .run(String(b.value ?? ''), status, nowStamp(), i.id)

    // A breach on an armed invariant is a halt that needs a person: production
    // moved the wrong way, and no amount of retrying changes that.
    let halt = null
    if (holds === false && i.armed && i.objective_id) {
      const r = db()
        .prepare('INSERT INTO halts (objective_id,reason,detail,evidence_mark) VALUES (?,?,?,?)')
        .run(
          i.objective_id,
          'invariant_regression',
          `${i.name} = ${b.value} ${i.unit ?? ''} — outside its threshold (${i.comparison} ${i.threshold}).`,
          evidenceWatermark(i.objective_id),
        )
      db()
        .prepare("UPDATE objectives SET status = 'blocked' WHERE id = ? AND status NOT IN ('abandoned','proven')")
        .run(i.objective_id)
      halt = db().prepare('SELECT * FROM halts WHERE id = ?').get(r.lastInsertRowid)
    }

    res.json({ ...db().prepare('SELECT * FROM invariants WHERE id = ?').get(i.id), holds, halt })
  })

  /**
   * Where the documents live: beside the database, never inside a repository.
   * A file dropped into a working tree becomes a change to review, attributed to
   * whichever pass happens to run next.
   */
  const resourcesDir = (slug) => {
    const dir = join(dirname(dbPathOf()), 'resources', slug)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Small text files travel WITH the memory; anything else travels as a link. */
  const INLINE_MAX = 32 * 1024
  const readable = (mime, name) =>
    /^text\//.test(mime ?? '') || /\.(md|txt|json|csv|log|ya?ml)$/i.test(name ?? '')

  api.post('/projects/:slug/resources', (req, res) => {
    const p = projectBy(req.params.slug)
    const b = req.body ?? {}
    const name = String(b.name ?? '').trim()
    if (!name || /[/\\]/.test(name)) throw new Rejected('A file name, without a path.')

    const data = Buffer.from(String(b.data ?? ''), 'base64')
    if (!data.length) throw new Rejected('The file arrived empty.')
    if (data.length > 5 * 1024 * 1024) throw new Rejected('Too big — 5 MB at most for a memory document.')

    const sha = createHash('sha256').update(data).digest('hex')
    const safe = `${sha.slice(0, 40)}${extname(name).slice(0, 12)}`
    writeFileSync(join(resourcesDir(p.slug), safe), data)

    const r = db()
      .prepare(
        `INSERT INTO resources (project_id,name,kind,mime,size,summary,path,sha256,included)
         VALUES (?,?,?,?,?,?,?,?,1)`,
      )
      .run(p.id, name, 'document', b.mime ?? null, data.length, b.summary?.trim() || null,
           `resources/${p.slug}/${safe}`, sha)

    const saved = db().prepare('SELECT * FROM resources WHERE id = ?').get(r.lastInsertRowid)
    res.status(201).json({ ...saved, included: true, file_exists: true })
  })

  api.get('/resources/:id/raw', (req, res) => {
    const r = db().prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id)
    if (!r) throw new Rejected('This document does not exist.', 404)
    const absolute = join(dirname(dbPathOf()), r.path ?? '')
    if (!r.path || !existsSync(absolute)) throw new Rejected('The row is here; the file is not.', 404)
    res.set('Content-Type', r.mime ?? 'application/octet-stream')
    res.set('Content-Disposition', `inline; filename="${basename(r.name)}"`)
    createReadStream(absolute).pipe(res)
  })

  api.patch('/resources/:id', (req, res) => {
    const r = db().prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id)
    if (!r) throw new Rejected('This document does not exist.', 404)
    const b = req.body ?? {}
    // Only what a person can decide about a document: whether it travels, and
    // what it is for. Never its bytes, its size or its fingerprint.
    if ('included' in b) db().prepare('UPDATE resources SET included = ? WHERE id = ?').run(b.included ? 1 : 0, r.id)
    if ('summary' in b) db().prepare('UPDATE resources SET summary = ? WHERE id = ?').run(String(b.summary ?? '').trim() || null, r.id)
    const saved = db().prepare('SELECT * FROM resources WHERE id = ?').get(r.id)
    res.json({
      ...saved,
      included: Boolean(saved.included),
      file_exists: Boolean(saved.path && existsSync(join(dirname(dbPathOf()), saved.path))),
    })
  })

  api.delete('/resources/:id', (req, res) => {
    const r = db().prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id)
    if (!r) throw new Rejected('This document does not exist.', 404)
    // The row goes; the file goes with it, but only ours — a path that escaped
    // our own directory is left alone rather than followed.
    const root = join(dirname(dbPathOf()), 'resources')
    const absolute = r.path ? join(dirname(dbPathOf()), r.path) : null
    if (absolute && absolute.startsWith(root + '/') && existsSync(absolute)) rmSync(absolute)
    db().prepare('DELETE FROM resources WHERE id = ?').run(r.id)
    res.json({ removed: r.id })
  })

  /**
   * The documents, with the two facts the page was asserting without checking.
   *
   * `file_exists`: every row here pointed at a path, and not one of the files was
   * on disk — the page listed four documents with their sizes and dates, three of
   * them "included in the context", over nothing at all.
   *
   * `reaches_agents`: nowhere in this codebase does anything read `resources` to
   * build what an agent is handed. The table is read exactly twice — here, and by
   * a counter. So `included` decides nothing, and the page said it decided what
   * agents receive.
   */
  api.get('/projects/:slug/resources', (req, res) => {
    const p = projectBy(req.params.slug)
    const root = join(homedir(), '.orchestrator')
    res.json({
      reaches_agents: true,
      items: db()
        .prepare('SELECT * FROM resources WHERE project_id = ?')
        .all(p.id)
        .map((r) => ({
          ...r,
          included: Boolean(r.included),
          file_exists: Boolean(r.path && existsSync(join(root, r.path))),
        })),
    })
  })

  /**
   * Two handlers on the same method and path: the first answers, the second is
   * dead code, and nothing says so. That is how `PATCH /projects/:slug` came to
   * exist twice — the second one validated more, saved more fields, and never
   * ran once. Loud at startup beats silent forever.
   */
  {
    const seen = new Map()
    for (const layer of api.stack) {
      if (!layer.route) continue
      for (const method of Object.keys(layer.route.methods)) {
        const key = `${method.toUpperCase()} ${layer.route.path}`
        if (seen.has(key)) throw new Error(`Route declared twice — the second never runs: ${key}`)
        seen.set(key, true)
      }
    }
  }

  app.use('/api', api)

  // The compiled front end is served by the same process: one port, one command,
  // nothing to keep alive alongside. Three processes to watch were three ways to
  // fall over in silence.
  const front = join(here, '..', 'public')
  if (existsSync(front)) {
    app.use(express.static(front))
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(front, 'index.html')))
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof Rejected) return res.status(err.code).json({ message: err.message, ...err.extra })
    console.error(err)
    res.status(500).json({ message: err.message ?? 'internal error' })
  })

  return app
}

export function startServer(port = Number(process.env.PORT ?? 4747)) {
  return new Promise((ok) => {
    const serveur = createServer().listen(port, () => ok({ serveur, port }))
  })
}
