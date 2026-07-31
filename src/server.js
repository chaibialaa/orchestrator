import express from 'express'
import { existsSync, statSync, createReadStream } from 'node:fs'
import { resolve as path, join, extname, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { base, json, nowStamp } from './db/index.js'
import { evaluateGate, canStart, HUMAN_HALTS } from './gate.js'
import { encrypt, decrypt, keyHint } from './crypto.js'
import { upload, checkStorage, createDriveFolder } from './storage.js'
import { blockers } from './blockers.js'
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
  const o = db().prepare('SELECT * FROM objectives WHERE id = ?').get(id)
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
  const chemins = [
    ...String(e.ref ?? '').matchAll(/[\w./-]+\.(?:png|jpe?g|webp|md|json|txt|unity)/g),
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

  api.get('/projects', (_req, res) => res.json(db().prepare('SELECT * FROM projects ORDER BY name').all()))

  api.patch('/projects/:slug', (req, res) => {
    const p = projectBy(req.params.slug)
    const b = req.body ?? {}
    if (b.gate_judge && !['human', 'agent', 'gpt', 'self'].includes(b.gate_judge)) {
      throw new Rejected('Unknown judge: human, agent, gpt or self.')
    }
    const champs = {}
    for (const k of ['gate_judge', 'name', 'judge_agent', 'judge_url', 'repo_path']) {
      if (k in b) champs[k] = b[k]
    }
    if (Object.keys(champs).length) {
      db()
        .prepare(`UPDATE projects SET ${Object.keys(champs).map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`)
        .run({ ...champs, id: p.id })
    }
    res.json(db().prepare('SELECT * FROM projects WHERE id = ?').get(p.id))
  })

  /**
   * The objective list carries everything the screen needs without inferring it:
   * who is working RIGHT NOW, when it last moved, which halt is open, who did the
   * work. Without these columns, the screen presented three chains as three open
   * fronts.
   */
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
    const { title, body, paths, objective_id, decided_at } = req.body ?? {}
    if (!title?.trim()) throw new Rejected('A decision must have a title.')
    if (!body?.trim()) throw new Rejected('A decision must have a body.')
    const r = db()
      .prepare(
        `INSERT INTO decisions (project_id,objective_id,title,body,paths,decided_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(p.id, objective_id ?? null, title, body, json.write(paths ?? []), decided_at ?? nowStamp())
    res.status(201).json(db().prepare('SELECT * FROM decisions WHERE id = ?').get(r.lastInsertRowid))
  })

  /** What an agent must reread before acting: the project's decisions and constraints. */
  api.get('/projects/:slug/recall', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json({
      project: p,
      decisions: db()
        .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at DESC LIMIT 30')
        .all(p.id)
        .map((d) => ({ ...d, paths: json.read(d.paths, []) })),
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
        .prepare(`UPDATE objectives SET ${noms.map((n) => `${n} = @${n}`).join(', ')}, updated_at = @maj WHERE id = @id`)
        .run({ ...champs, maj: nowStamp(), id: o.id })
    }
    res.json(objectiveBy(o.id))
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
    db()
      .prepare('UPDATE passages SET tokens = ?, requests = ?, cost_usd = ? WHERE id = ?')
      .run(nombre(b.tokens, 0), nombre(b.requests, 0), nombre(b.cost_usd, 0), p.id)
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
    db().prepare("UPDATE objectives SET status = 'blocked' WHERE id = ?").run(o.id)
    res.status(201).json(db().prepare('SELECT * FROM halts WHERE id = ?').get(r.lastInsertRowid))
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
      // prenable, il retourne au brouillon.
      const statut = !o.proof_spec?.trim() ? 'draft' : aDesTentatives ? 'in_progress' : 'ready'
      db().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(statut, o.id)
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
      db().prepare("UPDATE objectives SET status = 'blocked' WHERE id = ?").run(o.id)
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
         WHERE o.status IN ('in_progress','blocked','ready')`,
      )
      .all()
      .map((l) => ({ ...l, ...evaluateGate(l.id) }))

    const pret = lines.filter((l) => l.ready && !l.ok)
    res.json({
      ready: pret,
      in_progress: lines.filter((l) => !l.ready),
      counts: { ready: pret.length, in_progress: lines.length - pret.length },
    })
  })

  api.get('/dashboard', (_req, res) => {
    const projects = db().prepare('SELECT * FROM projects ORDER BY name').all()
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
      const pendingAuth = db()
        .prepare(
          `SELECT COUNT(*) n FROM halts WHERE resolved_at IS NULL
             AND reason IN (${HUMAN_HALTS.map(() => '?').join(',')})
             AND objective_id IN (SELECT id FROM objectives WHERE project_id = ?)`,
        )
        .get(...HUMAN_HALTS, p.id).n
      return {
        slug: p.slug,
        name: p.name,
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
      invariants: [],
    })
  })

  // ---- livrables ----------------------------------------------------------

  /**
   * Serves a file cited by a proof. We NEVER serve a free-form path from the
   * client: only a path already recorded, and only while it stays under the
   * project repository's root.
   */
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
        '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' }[
        extname(absolute).toLowerCase()
      ] ?? 'application/octet-stream'

    res.set('Content-Type', mime)
    res.set('Content-Disposition', `inline; filename="${basename(absolute)}"`)
    res.set('Cache-Control', 'public, max-age=3600')
    createReadStream(absolute).pipe(res)
  })


  /**
   * What is in the way, as a list of actions. Every entry cost real money before
   * it was visible anywhere but a log file: that is this route's whole reason to
   * exist.
   */
  api.get('/blockers', (_req, res) => res.json(blockers()))

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
    if (!b.label?.trim()) throw new Rejected("L'agent doit porter un nom lisible.")
    if (db().prepare('SELECT 1 FROM agents WHERE name = ?').get(b.name)) {
      throw new Rejected('An agent already has that technical name.')
    }
    const r = db()
      .prepare(
        `INSERT INTO agents (name,label,reach,role,enabled,priority,api_key,settings,capabilities,env_var,endpoint)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        b.name, b.label, b.reach ?? 'cli', b.role ?? 'executant',
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
    for (const k of ['label', 'reach', 'role', 'priority', 'env_var', 'endpoint']) if (k in b) champs[k] = b[k]
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
   * The tools available to an executor, by capability and by preference.
   * On ne renvoie JAMAIS de secret : seulement le nom de la variable qui le
   * will fall on the machine that executes.
   */
  api.get('/toolbox', (_req, res) => {
    const agents = db()
      .prepare("SELECT * FROM agents WHERE enabled = 1 ORDER BY priority, name")
      .all()
      .map(sortirAgent)
      .filter((a) => a.capabilities.length)

    const by = {}
    for (const a of agents) {
      for (const c of a.capabilities) {
        ;(by[c] ??= []).push({
          name: a.name,
          label: a.label,
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
    if (prop && (!prop.chapter || !Array.isArray(prop.steps) || !prop.steps.length)) {
      throw new Rejected('Unusable breakdown: it needs a chapter and at least one step.')
    }
    db()
      .prepare('UPDATE briefs SET proposal=?, error=?, status=? WHERE id=?')
      .run(json.write(prop ?? null), req.body?.error ?? null, prop ? 'proposed' : 'failed', b.id)
    res.json(sortirBrief(db().prepare('SELECT * FROM briefs WHERE id = ?').get(b.id)))
  })

  /** C'est SEULEMENT here que des objectifs naissent, et sur le texte relu par l'humain. */
  api.post('/briefs/:id/apply', (req, res) => {
    const b = db().prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id)
    if (!b) throw new Rejected('This brief does not exist.', 404)
    const d = req.body ?? {}
    if (!d.chapter?.trim()) throw new Rejected('The chapter must have a title.')
    if (!Array.isArray(d.steps) || !d.steps.length) throw new Rejected('A chapter with no steps is useless.')

    const chap = db().transaction(() => {
      const prio =
        db().prepare('SELECT COALESCE(MAX(priority),0) m FROM objectives WHERE project_id=? AND parent_id IS NULL').get(b.project_id).m + 10

      const c = db()
        .prepare(
          `INSERT INTO objectives (project_id,title,intent,blast_radius,priority,status)
           VALUES (?,?,?,'feature',?,'draft')`,
        )
        .run(b.project_id, d.chapter, d.intent ?? null, prio)

      d.steps.forEach((e, i) => {
        db()
          .prepare(
            `INSERT INTO objectives (project_id,parent_id,title,proof_spec,blast_radius,priority,status)
             VALUES (?,?,?,?,?,?,?)`,
          )
          .run(
            b.project_id, c.lastInsertRowid, e.title, e.proof_spec ?? null,
            e.blast_radius ?? 'feature', (i + 1) * 10,
            e.proof_spec?.trim() ? 'ready' : 'draft',
          )
      })

      db().prepare("UPDATE briefs SET status='applied' WHERE id=?").run(b.id)
      return c.lastInsertRowid
    })()

    res.status(201).json({
      ...objectiveBy(chap),
      children: db().prepare('SELECT * FROM objectives WHERE parent_id = ? ORDER BY priority').all(chap),
    })
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
    db()
      .prepare('UPDATE invariants SET last_value=?, last_status=?, last_checked_at=? WHERE id=?')
      .run(String(b.value ?? ''), b.status ?? 'unknown', nowStamp(), i.id)
    res.json(db().prepare('SELECT * FROM invariants WHERE id = ?').get(i.id))
  })

  api.get('/projects/:slug/resources', (req, res) => {
    const p = projectBy(req.params.slug)
    res.json(db().prepare('SELECT * FROM resources WHERE project_id = ?').all(p.id).map((r) => ({ ...r, included: Boolean(r.included) })))
  })

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
