import express from 'express'
import { existsSync, statSync, createReadStream } from 'node:fs'
import { resolve as chemin, join, extname, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { base, json, maintenant } from './db/index.js'
import { evaluer, peutDemarrer, ARRETS_HUMAINS } from './gate.js'
import { chiffrer, dechiffrer, indice } from './crypto.js'
import { envoyer, verifier, creerDossierDrive } from './stockage.js'

const ici = dirname(fileURLToPath(import.meta.url))
const db = () => base()

/** Une erreur métier se dit en français et rend un code, pas une pile d'appels. */
class Refus extends Error {
  constructor(message, code = 422, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

const projetPar = (slug) => {
  const p = db().prepare('SELECT * FROM projects WHERE slug = ? OR id = ?').get(slug, slug)
  if (!p) throw new Refus("Ce projet n'existe pas.", 404)
  return p
}

const objectifPar = (id) => {
  const o = db().prepare('SELECT * FROM objectives WHERE id = ?').get(id)
  if (!o) throw new Refus("Cet objectif n'existe pas.", 404)
  return o
}

const nombre = (v, defaut = null) => (v === undefined || v === null || v === '' ? defaut : Number(v))
const texte = (v) => (v === undefined ? undefined : v === null ? null : String(v))

/** Les colonnes JSON sortent décodées, les booléens sortent en booléens. */
function sortirObjectif(o) {
  return o
}

function sortirPassage(p) {
  return p && { ...p, tools_used: json.lire(p.tools_used), prevented: Boolean(p.prevented) }
}

function sortirPreuve(e) {
  const chemins = [
    ...String(e.ref ?? '').matchAll(/[\w./-]+\.(?:png|jpe?g|webp|md|json|txt|unity)/g),
  ].map((m) => m[0])
  return { ...e, payload: json.lire(e.payload), files: chemins }
}

function sortirAgent(a) {
  const { api_key, ...reste } = a
  return {
    ...reste,
    enabled: Boolean(a.enabled),
    settings: json.lire(a.settings),
    capabilities: json.lire(a.capabilities, []),
    has_key: Boolean(api_key),
    key_hint: indice(api_key),
  }
}

const sortirBrief = (b) => b && { ...b, proposal: json.lire(b.proposal) }

/** Où en étaient les preuves au moment d'un arrêt : le repère du « rien de neuf ». */
const repereDePreuves = (objectifId) =>
  db().prepare('SELECT COALESCE(MAX(id),0) m FROM evidences WHERE objective_id = ?').get(objectifId).m

export function creerServeur() {
  const app = express()
  app.use(express.json({ limit: '32mb' }))

  // Le front et l'API peuvent être servis depuis deux ports en développement.
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
    const p = projetPar(req.params.slug)
    const b = req.body ?? {}
    if (b.gate_judge && !['human', 'agent', 'gpt', 'self'].includes(b.gate_judge)) {
      throw new Refus('Juge inconnu : human, agent, gpt ou self.')
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
   * La liste des objectifs porte tout ce que l'écran doit savoir sans le
   * déduire : qui travaille MAINTENANT, quand ça a bougé pour la dernière
   * fois, quel arrêt est ouvert, qui a fait le travail. Sans ces colonnes,
   * l'écran présentait trois chaînes comme trois fronts ouverts.
   */
  api.get('/projects/:slug/objectives', (req, res) => {
    const p = projetPar(req.params.slug)
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
    const p = projetPar(req.params.slug)
    const objectifs = db().prepare('SELECT id, status FROM objectives WHERE project_id = ?').all(p.id)
    const ids = objectifs.map((o) => o.id)
    const trous = ids.length ? ids.map(() => '?').join(',') : '-1'

    const parStatut = {}
    for (const o of objectifs) parStatut[o.status] = (parStatut[o.status] ?? 0) + 1

    const conso = db()
      .prepare(
        `SELECT COALESCE(SUM(tokens),0) tokens, COALESCE(SUM(requests),0) requests,
                COALESCE(SUM(cost_usd),0) cost, COUNT(*) n
         FROM passages WHERE objective_id IN (${trous})`,
      )
      .get(...ids)

    const arrets = db()
      .prepare(`SELECT reason, COUNT(*) n FROM halts WHERE objective_id IN (${trous}) GROUP BY reason`)
      .all(...ids)
    const harnais = db()
      .prepare(`SELECT harness, COUNT(*) n FROM passages WHERE objective_id IN (${trous}) GROUP BY harness`)
      .all(...ids)

    const trousH = ARRETS_HUMAINS.map(() => '?').join(',')
    const compterArrets = (dedans) =>
      db()
        .prepare(
          `SELECT COUNT(*) n FROM halts WHERE objective_id IN (${trous}) AND resolved_at IS NULL
           AND reason ${dedans ? 'IN' : 'NOT IN'} (${trousH})`,
        )
        .get(...ids, ...ARRETS_HUMAINS).n

    res.json({
      objectives: parStatut,
      proven_ratio: objectifs.length ? Number(((parStatut.proven ?? 0) / objectifs.length).toFixed(3)) : 0,
      passages: conso.n,
      halts_by_reason: Object.fromEntries(arrets.map((a) => [a.reason, a.n])),
      harness_split: Object.fromEntries(harnais.map((h) => [h.harness, h.n])),
      tokens: conso.tokens,
      requests: conso.requests,
      cost_usd: conso.cost,
      // Ne compte QUE ce qui exige vraiment un humain : un refus au verdict ou
      // un piétinement, la boucle les lève seule. Les additionner fabriquait
      // une file d'attente qui n'existait pas.
      awaiting_human: compterArrets(true),
      self_healing: compterArrets(false),
    })
  })

  api.get('/projects/:slug/decisions', (req, res) => {
    const p = projetPar(req.params.slug)
    res.json(
      db()
        .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at DESC')
        .all(p.id)
        .map((d) => ({ ...d, paths: json.lire(d.paths, []) })),
    )
  })

  api.post('/projects/:slug/decisions', (req, res) => {
    const p = projetPar(req.params.slug)
    const { title, body, paths, objective_id, decided_at } = req.body ?? {}
    if (!title?.trim()) throw new Refus('Le titre de la décision est obligatoire.')
    if (!body?.trim()) throw new Refus('Le corps de la décision est obligatoire.')
    const r = db()
      .prepare(
        `INSERT INTO decisions (project_id,objective_id,title,body,paths,decided_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(p.id, objective_id ?? null, title, body, json.ecrire(paths ?? []), decided_at ?? maintenant())
    res.status(201).json(db().prepare('SELECT * FROM decisions WHERE id = ?').get(r.lastInsertRowid))
  })

  /** Ce qu'un agent doit relire avant d'agir : décisions et contraintes du projet. */
  api.get('/projects/:slug/recall', (req, res) => {
    const p = projetPar(req.params.slug)
    res.json({
      project: p,
      decisions: db()
        .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at DESC LIMIT 30')
        .all(p.id)
        .map((d) => ({ ...d, paths: json.lire(d.paths, []) })),
    })
  })

  api.get('/projects/:slug/context', (req, res) => {
    const p = projetPar(req.params.slug)
    const cible = String(req.query.path ?? '')
    const colle = (glob, s) =>
      new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(s) ||
      s.startsWith(glob.replace(/\*+$/, ''))

    const decisions = db()
      .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at DESC')
      .all(p.id)
      .map((d) => ({ ...d, paths: json.lire(d.paths, []) }))
      .filter((d) => d.paths.some((g) => colle(g, cible)))

    const blast = json.lire(p.blast_globs, []).filter((g) => colle(g, cible))
    res.json({ path: cible, decisions, blast_radius_hit: blast, requires_human: blast.length > 0 })
  })

  // ---- objectifs ----------------------------------------------------------

  api.post('/projects/:slug/objectives', (req, res) => {
    const p = projetPar(req.params.slug)
    const b = req.body ?? {}
    if (!b.title?.trim()) throw new Refus("Le titre de l'objectif est obligatoire.")
    const blast = b.blast_radius ?? 'feature'
    if (!['cosmetic', 'feature', 'api', 'critical'].includes(blast)) {
      throw new Refus('Rayon de souffle inconnu : cosmetic, feature, api ou critical.')
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
    res.status(201).json(objectifPar(r.lastInsertRowid))
  })

  api.patch('/projects/:slug/objectives/reorder', (req, res) => {
    const p = projetPar(req.params.slug)
    const ordre = req.body?.ordre
    if (!Array.isArray(ordre) || !ordre.length) throw new Refus('Aucun ordre transmis.')
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
    const o = objectifPar(req.params.id)
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
      gate: evaluer(o.id),
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
    const o = objectifPar(req.params.id)
    const b = req.body ?? {}
    const champs = {}

    for (const k of ['title', 'intent', 'proof_spec', 'blast_radius', 'priority', 'parent_id', 'resume_session']) {
      if (k in b) champs[k] = b[k]
    }
    if ('resume_mode' in b) {
      if (!['new', 'last', 'named'].includes(b.resume_mode)) {
        throw new Refus('Continuité inconnue : new, last ou named.')
      }
      champs.resume_mode = b.resume_mode
    }

    // Un objectif ne peut pas se ranger sous lui-même, ni sous l'un des siens.
    if (champs.parent_id) {
      const vu = new Set()
      for (let p = champs.parent_id; p; ) {
        if (p === o.id || vu.has(p)) throw new Refus("Un objectif ne peut pas être rangé sous lui-même.")
        vu.add(p)
        p = db().prepare('SELECT parent_id FROM objectives WHERE id = ?').get(p)?.parent_id
      }
    }

    // Écrire le critère rend l'objectif prenable, l'effacer le rend inutilisable.
    // Sans ce recalcul, on écrivait le critère et l'étape restait « à préciser » :
    // personne ne la prenait, et rien ne disait pourquoi.
    if ('proof_spec' in b && !('status' in b)) {
      if (b.proof_spec?.trim() && o.status === 'draft') champs.status = 'ready'
      else if (!b.proof_spec?.trim() && o.status === 'ready') champs.status = 'draft'
    }

    if ('status' in b) {
      // Seule transition gardée : conclure. On ne se déclare pas prouvé.
      if (b.status === 'proven') {
        const g = evaluer(o.id)
        if (!g.ok) {
          if (g.reason !== 'human_request' && g.reason !== 'awaiting_verdict') {
            db()
              .prepare('INSERT INTO halts (objective_id,reason,detail) VALUES (?,?,?)')
              .run(o.id, g.reason, g.detail)
          }
          throw new Refus("L'objectif ne peut pas conclure.", 409, { gate: g })
        }
        champs.proven_at = maintenant()
      }
      champs.status = b.status
    }

    const noms = Object.keys(champs)
    if (noms.length) {
      db()
        .prepare(`UPDATE objectives SET ${noms.map((n) => `${n} = @${n}`).join(', ')}, updated_at = @maj WHERE id = @id`)
        .run({ ...champs, maj: maintenant(), id: o.id })
    }
    res.json(objectifPar(o.id))
  })

  // ---- tentatives et preuves ---------------------------------------------

  api.post('/objectives/:id/passages', (req, res) => {
    const o = objectifPar(req.params.id)
    const g = peutDemarrer(o.id)
    if (!g.ok) throw new Refus(g.detail, 409, { gate: g })

    const b = req.body ?? {}
    const r = db()
      .prepare(
        `INSERT INTO passages (objective_id,harness,summary,mission,git_before,resumed_from,started_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(o.id, b.harness ?? 'claude', b.summary ?? null, b.mission ?? null, b.git_before ?? null, b.resumed_from ?? null, maintenant())

    if (o.status === 'ready' || o.status === 'draft') {
      db().prepare("UPDATE objectives SET status = 'in_progress' WHERE id = ?").run(o.id)
    }
    res.status(201).json(sortirPassage(db().prepare('SELECT * FROM passages WHERE id = ?').get(r.lastInsertRowid)))
  })

  api.get('/passages/:id', (req, res) => {
    const p = db().prepare('SELECT * FROM passages WHERE id = ?').get(req.params.id)
    if (!p) throw new Refus("Cette tentative n'existe pas.", 404)
    res.json({
      ...sortirPassage(p),
      evidences: db().prepare('SELECT * FROM evidences WHERE passage_id = ?').all(p.id).map(sortirPreuve),
    })
  })

  api.patch('/passages/:id', (req, res) => {
    const p = db().prepare('SELECT * FROM passages WHERE id = ?').get(req.params.id)
    if (!p) throw new Refus("Cette tentative n'existe pas.", 404)
    const b = req.body ?? {}
    const champs = {}
    for (const k of ['verdict', 'summary', 'mission', 'said', 'git_after', 'prevented_by', 'ended_at', 'session_id', 'resumed_from']) {
      if (k in b) champs[k] = b[k]
    }
    if ('tools_used' in b) champs.tools_used = json.ecrire(b.tools_used)
    if ('prevented' in b) champs.prevented = b.prevented ? 1 : 0
    if ('verdict' in b && !('ended_at' in b)) champs.ended_at = maintenant()

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
    if (!p) throw new Refus("Cette tentative n'existe pas.", 404)
    const b = req.body ?? {}
    db()
      .prepare('UPDATE passages SET tokens = ?, requests = ?, cost_usd = ? WHERE id = ?')
      .run(nombre(b.tokens, 0), nombre(b.requests, 0), nombre(b.cost_usd, 0), p.id)
    res.json(sortirPassage(db().prepare('SELECT * FROM passages WHERE id = ?').get(p.id)))
  })

  api.post('/passages/:id/evidences', (req, res) => {
    const p = db().prepare('SELECT * FROM passages WHERE id = ?').get(req.params.id)
    if (!p) throw new Refus("Cette tentative n'existe pas.", 404)
    res.status(201).json(creerPreuve(p.objective_id, p.id, req.body ?? {}))
  })

  api.post('/objectives/:id/evidences', (req, res) => {
    const o = objectifPar(req.params.id)
    res.status(201).json(creerPreuve(o.id, null, req.body ?? {}))
  })

  function creerPreuve(objectifId, passageId, b) {
    const types = ['test', 'e2e', 'screenshot', 'render', 'diff', 'invariant', 'manual']
    if (!types.includes(b.type)) throw new Refus(`Type de preuve inconnu : ${types.join(', ')}.`)
    if (!b.label?.trim()) throw new Refus('La preuve doit porter un intitulé.')
    const r = db()
      .prepare(
        `INSERT INTO evidences (objective_id,passage_id,type,label,ref,verdict,payload)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(objectifId, passageId, b.type, b.label, b.ref ?? null, b.verdict ?? 'inconclusive', json.ecrire(b.payload))
    return sortirPreuve(db().prepare('SELECT * FROM evidences WHERE id = ?').get(r.lastInsertRowid))
  }

  // ---- arrêts -------------------------------------------------------------

  api.post('/objectives/:id/halts', (req, res) => {
    const o = objectifPar(req.params.id)
    const b = req.body ?? {}
    const r = db()
      .prepare('INSERT INTO halts (objective_id,passage_id,reason,detail,evidence_mark) VALUES (?,?,?,?,?)')
      .run(o.id, b.passage_id ?? null, b.reason, b.detail ?? null, repereDePreuves(o.id))
    db().prepare("UPDATE objectives SET status = 'blocked' WHERE id = ?").run(o.id)
    res.status(201).json(db().prepare('SELECT * FROM halts WHERE id = ?').get(r.lastInsertRowid))
  })

  api.patch('/halts/:id/resolve', (req, res) => {
    const h = db().prepare('SELECT * FROM halts WHERE id = ?').get(req.params.id)
    if (!h) throw new Refus("Cet arrêt n'existe pas.", 404)
    db().prepare('UPDATE halts SET resolved_at = ? WHERE id = ?').run(maintenant(), h.id)

    const reste = db()
      .prepare('SELECT COUNT(*) n FROM halts WHERE objective_id = ? AND resolved_at IS NULL')
      .get(h.objective_id).n

    if (!reste) {
      const o = objectifPar(h.objective_id)
      const aDesTentatives = db()
        .prepare('SELECT COUNT(*) n FROM passages WHERE objective_id = ?')
        .get(o.id).n
      // Un objectif sans critère ne redevient pas « prêt » : il n'est pas
      // prenable, il retourne au brouillon.
      const statut = !o.proof_spec?.trim() ? 'draft' : aDesTentatives ? 'in_progress' : 'ready'
      db().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(statut, o.id)
    }
    res.json(db().prepare('SELECT * FROM halts WHERE id = ?').get(h.id))
  })

  // ---- verdict ------------------------------------------------------------

  api.post('/objectives/:id/verdict/:decision/:par?', (req, res) => {
    const o = objectifPar(req.params.id)
    const decision = req.params.decision
    if (!['accept', 'reject'].includes(decision)) throw new Refus('Verdict inconnu : accept ou reject.')
    const par = ['human', 'gpt', 'agent'].includes(req.params.par) ? req.params.par : 'human'

    if (decision === 'reject') {
      // Un juge qui se dédit annule ce qu'il avait dit. Sans ça, un « validé »
      // prononcé une fois gardait le gate ouvert malgré les refus suivants.
      db()
        .prepare(
          `UPDATE evidences SET verdict = 'inconclusive',
             label = label || ' — retiré par un verdict ultérieur'
           WHERE objective_id = ? AND type = 'manual' AND verdict = 'pass'
             AND payload IS NOT NULL AND payload LIKE '%judged_by%'`,
        )
        .run(o.id)

      // Un refus du juge du projet est une consigne de reprise, pas une demande
      // d'arbitrage : seul un refus HUMAIN suspend la boucle.
      //
      // Et un seul arrêt ouvert par motif : le même message relu à deux tours
      // en empilait deux identiques, ce qui laisse croire à deux refus quand
      // il n'y en a eu qu'un.
      const motif = par === 'human' ? 'human_request' : 'verdict_rejected'
      const dejaOuvert = db()
        .prepare('SELECT id FROM halts WHERE objective_id = ? AND reason = ? AND resolved_at IS NULL')
        .get(o.id, motif)

      if (!dejaOuvert)
        db()
        .prepare('INSERT INTO halts (objective_id,reason,detail,evidence_mark) VALUES (?,?,?,?)')
        .run(
          o.id,
          motif,
          `Verdict ${par === 'gpt' ? 'de la conversation' : par === 'agent' ? "d'un agent tiers" : 'humain'} : refusé. Le travail ne satisfait pas le critère de preuve.`,
          repereDePreuves(o.id),
        )
      db().prepare("UPDATE objectives SET status = 'blocked' WHERE id = ?").run(o.id)
      return res.json(objectifPar(o.id))
    }

    db()
      .prepare(
        `INSERT INTO evidences (objective_id,type,label,ref,verdict,payload)
         VALUES (?, 'manual', ?, ?, 'pass', ?)`,
      )
      .run(
        o.id,
        par === 'gpt'
          ? 'Verdict de la conversation : le critère est satisfait'
          : par === 'agent'
            ? "Verdict d'un agent tiers : le critère est satisfait"
            : 'Verdict humain : le critère de preuve est satisfait',
        o.proof_spec,
        json.ecrire({ judged_by: par }),
      )

    // Un arrêt absorbable est périmé dès qu'une preuve arrive : « plusieurs
    // essais, rien de démontré » n'a plus de sens quand quelque chose vient
    // d'être démontré. Seuls les arrêts qui exigent un humain survivent.
    db()
      .prepare(
        `UPDATE halts SET resolved_at = ? WHERE objective_id = ? AND resolved_at IS NULL
         AND reason NOT IN (${ARRETS_HUMAINS.map(() => '?').join(',')})`,
      )
      .run(maintenant(), o.id, ...ARRETS_HUMAINS)

    // Un verdict est une PREUVE, pas un interrupteur. Le gate tranche ensuite :
    // sans ça, un « validé » suffirait à contourner toutes les gardes.
    const g = evaluer(o.id)
    if (!g.ok) {
      return res
        .status(409)
        .json({ message: "Verdict enregistré, mais l'objectif ne peut pas conclure.", gate: g, objective: objectifPar(o.id) })
    }

    db().prepare('UPDATE objectives SET status = ?, proven_at = ? WHERE id = ?').run('proven', maintenant(), o.id)
    res.json(objectifPar(o.id))
  })

  // ---- revue et tableau de bord -------------------------------------------

  api.get('/review', (_req, res) => {
    const lignes = db()
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
      .map((l) => ({ ...l, ...evaluer(l.id) }))

    const pret = lignes.filter((l) => l.ready && !l.ok)
    res.json({
      ready: pret,
      in_progress: lignes.filter((l) => !l.ready),
      counts: { ready: pret.length, in_progress: lignes.length - pret.length },
    })
  })

  api.get('/dashboard', (_req, res) => {
    const projets = db().prepare('SELECT * FROM projects ORDER BY name').all()
    const rollup = projets.map((p) => {
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
      const attente = db()
        .prepare(
          `SELECT COUNT(*) n FROM halts WHERE resolved_at IS NULL
             AND reason IN (${ARRETS_HUMAINS.map(() => '?').join(',')})
             AND objective_id IN (SELECT id FROM objectives WHERE project_id = ?)`,
        )
        .get(...ARRETS_HUMAINS, p.id).n
      return {
        slug: p.slug,
        name: p.name,
        repo_path: p.repo_path,
        total_objectives: s.total,
        proven: s.proven ?? 0,
        awaiting_human: attente,
        passages: c.passages,
        tokens: c.tokens,
        requests: c.requests,
        cost_usd: c.cost,
        last_activity: c.last_activity,
        objectives: {},
        invariants: { total: 0, breached: 0, unknown: 0 },
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
   * Sert un fichier cité par une preuve. On ne sert JAMAIS un chemin libre venu
   * du client : seulement un chemin déjà enregistré, et seulement s'il reste
   * sous la racine du dépôt du projet.
   */
  api.get('/evidences/:id/file', (req, res) => {
    const e = db().prepare('SELECT * FROM evidences WHERE id = ?').get(req.params.id)
    if (!e) throw new Refus("Cette preuve n'existe pas.", 404)

    const o = objectifPar(e.objective_id)
    const racine = db().prepare('SELECT repo_path FROM projects WHERE id = ?').get(o.project_id)?.repo_path
    if (!racine) throw new Refus('Projet sans dépôt.', 404)

    const fichiers = sortirPreuve(e).files
    const rel = fichiers[nombre(req.query.n, 0)]
    if (!rel) throw new Refus('Aucun fichier dans cette preuve.', 404)

    const absolu = chemin(racine, rel)
    if (!absolu.startsWith(chemin(racine) + '/')) throw new Refus('Chemin hors du dépôt.', 403)
    if (!existsSync(absolu) || !statSync(absolu).isFile()) throw new Refus('Fichier introuvable.', 404)

    const mime =
      { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
        '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' }[
        extname(absolu).toLowerCase()
      ] ?? 'application/octet-stream'

    res.set('Content-Type', mime)
    res.set('Content-Disposition', `inline; filename="${basename(absolu)}"`)
    res.set('Cache-Control', 'public, max-age=3600')
    createReadStream(absolu).pipe(res)
  })


  // ---- stockages distants -------------------------------------------------

  const sortirStockage = (st) => {
    const { credentials, ...reste } = st
    return {
      ...reste,
      enabled: Boolean(st.enabled),
      // Les identifiants ne sortent jamais : l'écran a besoin de savoir
      // qu'ils existent, pas de les lire.
      has_credentials: Boolean(credentials),
      envois: db().prepare('SELECT COUNT(*) n FROM evidence_remotes WHERE storage_id = ?').get(st.id).n,
    }
  }

  const stockageComplet = (id) => {
    const st = db().prepare('SELECT * FROM storages WHERE id = ?').get(id)
    if (!st) throw new Refus("Ce stockage n'existe pas.", 404)
    return { ...st, credentials: dechiffrer(st.credentials) }
  }

  api.get('/storages', (_req, res) =>
    res.json(db().prepare('SELECT * FROM storages ORDER BY id').all().map(sortirStockage)),
  )

  api.post('/storages', (req, res) => {
    const b = req.body ?? {}
    if (!['gdrive', 'dropbox'].includes(b.provider)) throw new Refus('Fournisseur inconnu : gdrive ou dropbox.')
    if (!b.label?.trim()) throw new Refus('Le stockage doit porter un nom lisible.')
    const r = db()
      .prepare('INSERT INTO storages (provider,label,target,credentials) VALUES (?,?,?,?)')
      .run(b.provider, b.label, b.target ?? null, chiffrer(b.credentials ? JSON.stringify(b.credentials) : null))
    res.status(201).json(sortirStockage(db().prepare('SELECT * FROM storages WHERE id = ?').get(r.lastInsertRowid)))
  })

  api.patch('/storages/:id', (req, res) => {
    const st = db().prepare('SELECT * FROM storages WHERE id = ?').get(req.params.id)
    if (!st) throw new Refus("Ce stockage n'existe pas.", 404)
    const b = req.body ?? {}
    const champs = {}
    for (const k of ['label', 'target']) if (k in b) champs[k] = b[k]
    if ('enabled' in b) champs.enabled = b.enabled ? 1 : 0
    // Trois cas distincts, comme pour les clés d'agent : absent = on ne touche
    // à rien ; vide = on efface ; valeur = on remplace.
    if ('credentials' in b) {
      champs.credentials = b.credentials ? chiffrer(JSON.stringify(b.credentials)) : null
    }
    const noms = Object.keys(champs)
    if (noms.length) {
      db().prepare(`UPDATE storages SET ${noms.map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`).run({ ...champs, id: st.id })
    }
    res.json(sortirStockage(db().prepare('SELECT * FROM storages WHERE id = ?').get(st.id)))
  })

  api.delete('/storages/:id', (req, res) => {
    db().prepare('DELETE FROM storages WHERE id = ?').run(req.params.id)
    res.sendStatus(204)
  })

  /** Vérifie sans rien déposer : le stockage répond-il, et le dossier existe-t-il ? */
  api.post('/storages/:id/check', async (req, res, next) => {
    try {
      const st = stockageComplet(req.params.id)
      if (!st.credentials) throw new Refus("Aucun identifiant enregistré pour ce stockage.")
      const r = await verifier(st)
      db().prepare('UPDATE storages SET last_status=?, last_detail=? WHERE id=?').run(r.status, r.detail, st.id)
      res.json(sortirStockage(db().prepare('SELECT * FROM storages WHERE id = ?').get(st.id)))
    } catch (e) {
      db()
        .prepare('UPDATE storages SET last_status=?, last_detail=? WHERE id=?')
        .run('refused', String(e.message).slice(0, 240), req.params.id)
      next(e)
    }
  })

  /**
   * Prépare le dossier de dépôt : le crée et le partage. L'humain n'a rien à
   * faire à la main — c'était une paresse de le lui demander.
   */
  api.post('/storages/:id/prepare', async (req, res, next) => {
    try {
      const st = stockageComplet(req.params.id)
      if (st.provider !== 'gdrive') throw new Refus('Dropbox crée son chemin tout seul au premier envoi.')
      if (!st.credentials) throw new Refus("Aucun identifiant enregistré pour ce stockage.")

      const cle = JSON.parse(st.credentials)
      const r = await creerDossierDrive(cle, {
        nom: req.body?.nom || `Orchestrator — Preuves`,
        partagerAvec: req.body?.partager_avec || null,
      })

      db()
        .prepare('UPDATE storages SET target=?, last_status=?, last_detail=? WHERE id=?')
        .run(r.id, 'ok', `dossier « ${r.nom} » créé${r.partage ? ` · partagé avec ${r.partage}` : ''}`, st.id)

      res.json({ ...sortirStockage(db().prepare('SELECT * FROM storages WHERE id = ?').get(st.id)), dossier: r })
    } catch (e) {
      next(e)
    }
  })

  /**
   * Envoie les preuves qui ne sont pas encore là-bas. On n'envoie QUE ce qui
   * manque : renvoyer tout à chaque fois coûterait cher et effacerait la
   * distinction entre « déjà partagé » et « nouveau ».
   */
  api.post('/storages/:id/sync', async (req, res, next) => {
    try {
      const st = stockageComplet(req.params.id)
      if (!st.enabled) throw new Refus('Ce stockage est désactivé.')
      if (!st.credentials) throw new Refus("Aucun identifiant enregistré pour ce stockage.")

      const limite = Math.min(Number(req.body?.limite ?? 25), 100)
      const candidates = db()
        .prepare(
          `SELECT e.id, e.ref, e.label, o.project_id, p.repo_path
           FROM evidences e
           JOIN objectives o ON o.id = e.objective_id
           JOIN projects p ON p.id = o.project_id
           WHERE e.ref IS NOT NULL
             AND e.id NOT IN (SELECT evidence_id FROM evidence_remotes WHERE storage_id = ?)
           ORDER BY e.id DESC LIMIT ?`,
        )
        .all(st.id, limite)

      const envoyes = []
      const echecs = []

      for (const c of candidates) {
        const rel = sortirPreuve(c).files[0]
        if (!rel || !c.repo_path) continue
        const absolu = chemin(c.repo_path, rel)
        if (!absolu.startsWith(chemin(c.repo_path) + '/') || !existsSync(absolu)) continue

        try {
          const r = await envoyer(st, absolu)
          db()
            .prepare(
              `INSERT OR REPLACE INTO evidence_remotes (evidence_id,storage_id,remote_id,remote_url,octets,sha256,sent_at)
               VALUES (?,?,?,?,?,?,?)`,
            )
            .run(c.id, st.id, r.remote_id, r.remote_url, r.octets, r.sha256, maintenant())
          envoyes.push({ evidence_id: c.id, fichier: basename(absolu), url: r.remote_url })
        } catch (e) {
          echecs.push({ evidence_id: c.id, fichier: basename(absolu), erreur: String(e.message).slice(0, 200) })
        }
      }

      const restant = db()
        .prepare(
          `SELECT COUNT(*) n FROM evidences e
           WHERE e.ref IS NOT NULL AND e.id NOT IN (SELECT evidence_id FROM evidence_remotes WHERE storage_id = ?)`,
        )
        .get(st.id).n

      db()
        .prepare('UPDATE storages SET last_sync_at=?, last_status=?, last_detail=? WHERE id=?')
        .run(
          maintenant(),
          echecs.length && !envoyes.length ? 'refused' : 'ok',
          `${envoyes.length} envoyée(s), ${echecs.length} en échec, ${restant} restante(s)`,
          st.id,
        )

      res.json({ envoyes, echecs, restant })
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
      throw new Refus('Le nom technique ne prend que des minuscules, chiffres et tirets.')
    }
    if (!b.label?.trim()) throw new Refus("L'agent doit porter un nom lisible.")
    if (db().prepare('SELECT 1 FROM agents WHERE name = ?').get(b.name)) {
      throw new Refus('Un agent porte déjà ce nom technique.')
    }
    const r = db()
      .prepare(
        `INSERT INTO agents (name,label,reach,role,enabled,priority,api_key,settings,capabilities,env_var,endpoint)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        b.name, b.label, b.reach ?? 'cli', b.role ?? 'executant',
        b.enabled === false ? 0 : 1, nombre(b.priority, 50),
        chiffrer(b.api_key), json.ecrire(b.settings ?? null),
        json.ecrire(b.capabilities ?? []), b.env_var ?? null, b.endpoint ?? null,
      )
    res.status(201).json(sortirAgent(db().prepare('SELECT * FROM agents WHERE id = ?').get(r.lastInsertRowid)))
  })

  api.patch('/agents/reorder', (req, res) => {
    const ordre = req.body?.ordre
    if (!Array.isArray(ordre) || !ordre.length) throw new Refus('Aucun ordre transmis.')
    db().transaction(() => {
      for (const l of ordre) db().prepare('UPDATE agents SET priority = ? WHERE id = ?').run(nombre(l.priority, 50), l.id)
    })()
    res.json({ ok: true })
  })

  api.post('/agents/checkin', (req, res) => {
    const b = req.body ?? {}
    if (!b.machine || !Array.isArray(b.resultats)) throw new Refus('Relevé incomplet.')
    const vus = []
    for (const r of b.resultats) {
      const a = db().prepare('SELECT id FROM agents WHERE name = ?').get(r.name)
      if (!a) continue
      db()
        .prepare('UPDATE agents SET last_status=?, last_detail=?, last_machine=?, last_checked_at=? WHERE id=?')
        .run(r.status, r.detail ?? null, b.machine, maintenant(), a.id)
      vus.push(r.name)
    }
    res.json({ mis_a_jour: vus })
  })

  api.patch('/agents/:id', (req, res) => {
    const a = db().prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id)
    if (!a) throw new Refus("Cet agent n'existe pas.", 404)
    const b = req.body ?? {}
    const champs = {}
    for (const k of ['label', 'reach', 'role', 'priority', 'env_var', 'endpoint']) if (k in b) champs[k] = b[k]
    if ('capabilities' in b) champs.capabilities = json.ecrire(b.capabilities ?? [])
    if ('enabled' in b) champs.enabled = b.enabled ? 1 : 0
    if ('settings' in b) champs.settings = json.ecrire(b.settings)

    // Trois cas distincts : champ absent = ne touche à rien ; chaîne vide =
    // efface ; valeur = remplace. Les confondre faisait survivre une clé à sa
    // suppression.
    if ('api_key' in b) champs.api_key = b.api_key ? chiffrer(b.api_key) : null

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
   * Les outils à disposition d'un exécutant, par capacité et par préférence.
   * On ne renvoie JAMAIS de secret : seulement le nom de la variable qui le
   * portera sur la machine qui exécute.
   */
  api.get('/toolbox', (_req, res) => {
    const agents = db()
      .prepare("SELECT * FROM agents WHERE enabled = 1 ORDER BY priority, name")
      .all()
      .map(sortirAgent)
      .filter((a) => a.capabilities.length)

    const par = {}
    for (const a of agents) {
      for (const c of a.capabilities) {
        ;(par[c] ??= []).push({
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
    res.json(par)
  })



  /**
   * Le fil d'activité : ce qui se passe MAINTENANT et ce qui vient de se
   * passer, dans l'ordre du temps. Un tableau d'état dit où on en est ; il ne
   * dit pas ce qui bouge. C'est ce qui manquait pour suivre une passe en cours
   * sans lire un fichier de journal dans un terminal.
   */
  api.get('/activity', (req, res) => {
    const slug = req.query.project
    const p = slug ? projetPar(slug) : null
    const filtre = p ? 'AND o.project_id = @projet' : ''
    const args = p ? { projet: p.id } : {}

    const tentatives = db()
      .prepare(
        `SELECT pa.id, pa.harness, pa.verdict, pa.cost_usd, pa.tokens, pa.started_at, pa.ended_at,
                pa.prevented, pa.prevented_by, pa.resumed_from, pa.summary,
                o.id objective_id, o.title objective_title, pr.slug project
         FROM passages pa
         JOIN objectives o ON o.id = pa.objective_id
         JOIN projects pr ON pr.id = o.project_id
         WHERE 1=1 ${filtre}
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
         WHERE e.type = 'manual' AND e.payload LIKE '%judged_by%' ${filtre}
         ORDER BY e.id DESC LIMIT 8`,
      )
      .all(args)
      .map((v) => ({ ...v, payload: json.lire(v.payload) }))

    const arrets = db()
      .prepare(
        `SELECT h.id, h.reason, h.detail, h.created_at, h.resolved_at,
                o.id objective_id, o.title objective_title, pr.slug project
         FROM halts h
         JOIN objectives o ON o.id = h.objective_id
         JOIN projects pr ON pr.id = o.project_id
         WHERE 1=1 ${filtre}
         ORDER BY h.id DESC LIMIT 8`,
      )
      .all(args)

    // Ce qui tourne VRAIMENT : une tentative sans fin. Le reste est du passé.
    const enCours = tentatives.filter((t) => !t.ended_at)

    const fil = [
      ...tentatives.map((t) => ({
        type: t.ended_at ? 'tentative' : 'en_cours',
        quand: t.started_at,
        ...t,
      })),
      ...verdicts.map((v) => ({ type: 'verdict', quand: v.created_at, ...v })),
      ...arrets.map((a) => ({ type: 'arret', quand: a.created_at, ...a })),
    ]
      .sort((a, b) => String(b.quand).localeCompare(String(a.quand)))
      .slice(0, 20)

    res.json({ en_cours: enCours, fil })
  })

  // ---- analyse des mémoires locales ---------------------------------------

  api.get('/scans', (_req, res) => {
    const minutes = (iso) =>
      iso ? Math.max(0, Math.round((Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 60000)) : null

    res.json(
      db()
        .prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 10')
        .all()
        .map((s) => ({
          ...s,
          inventory: json.lire(s.inventory),
          result: json.lire(s.result),
          // Depuis combien de temps il attend. Un relevé resté « en attente »
          // dix-neuf heures n'attendait pas : personne n'écoutait. L'écran
          // doit le dire au lieu d'afficher une patience sans fin.
          attente_minutes: ['pending', 'running'].includes(s.status)
            ? minutes(s.taken_at ?? s.created_at)
            : null,
          // Les mémoires ont-elles bougé depuis ce relevé ?
          perime: Boolean(s.fingerprint && s.fingerprint_seen && s.fingerprint !== s.fingerprint_seen),
        })),
    )
  })

  api.post('/scans', (_req, res) => {
    const r = db().prepare("INSERT INTO scans (status) VALUES ('pending')").run()
    res.status(201).json(db().prepare('SELECT * FROM scans WHERE id = ?').get(r.lastInsertRowid))
  })

  /** Un agent local réclame le relevé : c'est lui qui a accès au disque. */
  api.post('/scans/claim', (req, res) => {
    const pris = db().transaction(() => {
      const s = db().prepare("SELECT * FROM scans WHERE status = 'pending' ORDER BY id LIMIT 1").get()
      if (!s) return null
      db()
        .prepare("UPDATE scans SET status='running', machine=?, taken_at=? WHERE id=?")
        .run(req.body?.machine ?? 'inconnue', maintenant(), s.id)
      return db().prepare('SELECT * FROM scans WHERE id = ?').get(s.id)
    })()
    res.json({ scan: pris && { ...pris, inventory: json.lire(pris.inventory) } })
  })

  api.patch('/scans/:id', (req, res) => {
    const s = db().prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id)
    if (!s) throw new Refus("Ce relevé n'existe pas.", 404)
    const b = req.body ?? {}
    const champs = { status: b.status ?? s.status }
    if ('inventory' in b) champs.inventory = json.ecrire(b.inventory)
    if ('result' in b) champs.result = json.ecrire(b.result)
    if ('error' in b) champs.error = b.error
    for (const k of ['fingerprint', 'fingerprint_seen', 'seen_at']) if (k in b) champs[k] = b[k]
    db()
      .prepare(`UPDATE scans SET ${Object.keys(champs).map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`)
      .run({ ...champs, id: s.id })
    const maj = db().prepare('SELECT * FROM scans WHERE id = ?').get(s.id)
    res.json({ ...maj, inventory: json.lire(maj.inventory), result: json.lire(maj.result) })
  })

  /**
   * L'humain accepte le contexte distillé d'un projet. Il devient une décision
   * du projet, donc relue par l'agent à chaque brief — c'est tout l'intérêt :
   * ce qui a été appris ailleurs cesse d'être redécouvert ici.
   */
  /**
   * Crée un projet À PARTIR d'un contexte distillé. C'était l'intention
   * d'origine du relevé : découvrir les projets dans les mémoires, pas
   * seulement enrichir ceux qu'on avait déjà déclarés à la main.
   */
  api.post('/scans/:id/creer', (req, res) => {
    const s = db().prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id)
    if (!s) throw new Refus("Ce relevé n'existe pas.", 404)

    const { slug, name, repo_path, title, body, sources } = req.body ?? {}
    if (!/^[a-z0-9-]+$/.test(slug ?? '')) {
      throw new Refus('Identifiant de projet invalide : minuscules, chiffres et tirets.')
    }
    if (db().prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)) {
      throw new Refus(`Le projet « ${slug} » existe déjà — rattache le contexte au lieu de le recréer.`)
    }
    if (repo_path && !existsSync(repo_path)) {
      // Un chemin de dépôt faux casse tout le reste en silence : les preuves
      // ne se servent plus, les sondes ne tournent plus.
      throw new Refus(`Ce dépôt n'existe pas sur cette machine : ${repo_path}`)
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
            title?.trim() || 'Contexte repris des mémoires locales',
            body,
            json.ecrire(sources ?? []),
          )
      }
      return p.lastInsertRowid
    })()

    res.status(201).json(db().prepare('SELECT * FROM projects WHERE id = ?').get(cree))
  })

  api.post('/scans/:id/apply/:slug', (req, res) => {
    const s = db().prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id)
    if (!s) throw new Refus("Ce relevé n'existe pas.", 404)
    const p = projetPar(req.params.slug)
    const { title, body, sources } = req.body ?? {}
    if (!body?.trim()) throw new Refus('Contexte vide.')

    const r = db()
      .prepare('INSERT INTO decisions (project_id,title,body,paths,decided_at) VALUES (?,?,?,?,?)')
      .run(
        p.id,
        title?.trim() || `Contexte repris des mémoires locales (${new Date().toISOString().slice(0, 10)})`,
        body,
        json.ecrire(sources ?? []),
        maintenant(),
      )
    res.status(201).json(db().prepare('SELECT * FROM decisions WHERE id = ?').get(r.lastInsertRowid))
  })

  api.delete('/scans/:id', (req, res) => {
    db().prepare('DELETE FROM scans WHERE id = ?').run(req.params.id)
    res.sendStatus(204)
  })

  // ---- briefs -------------------------------------------------------------

  api.get('/projects/:slug/briefs', (req, res) => {
    const p = projetPar(req.params.slug)
    res.json(db().prepare('SELECT * FROM briefs WHERE project_id = ? ORDER BY id DESC LIMIT 20').all(p.id).map(sortirBrief))
  })

  api.post('/projects/:slug/briefs', (req, res) => {
    const p = projetPar(req.params.slug)
    const body = String(req.body?.body ?? '').trim()
    if (body.length < 20) throw new Refus('Trop court pour être découpé — décris ce que tu veux obtenir.')
    const r = db().prepare("INSERT INTO briefs (project_id,body,status) VALUES (?,?,'pending')").run(p.id, body)
    res.status(201).json(sortirBrief(db().prepare('SELECT * FROM briefs WHERE id = ?').get(r.lastInsertRowid)))
  })

  /** Attribué en une écriture : deux agents ne paient pas le même découpage. */
  api.post('/projects/:slug/briefs/claim', (req, res) => {
    const p = projetPar(req.params.slug)
    const pris = db().transaction(() => {
      const b = db()
        .prepare("SELECT * FROM briefs WHERE project_id = ? AND status = 'pending' ORDER BY id LIMIT 1")
        .get(p.id)
      if (!b) return null
      db()
        .prepare("UPDATE briefs SET status='running', harness=?, taken_at=? WHERE id=?")
        .run(req.body?.harness ?? 'claude', maintenant(), b.id)
      return db().prepare('SELECT * FROM briefs WHERE id = ?').get(b.id)
    })()
    res.json({ brief: sortirBrief(pris) })
  })

  api.patch('/briefs/:id/propose', (req, res) => {
    const b = db().prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id)
    if (!b) throw new Refus("Ce brief n'existe pas.", 404)
    const prop = req.body?.proposal
    if (prop && (!prop.chapter || !Array.isArray(prop.steps) || !prop.steps.length)) {
      throw new Refus('Découpage inexploitable : il faut un chapitre et au moins une étape.')
    }
    db()
      .prepare('UPDATE briefs SET proposal=?, error=?, status=? WHERE id=?')
      .run(json.ecrire(prop ?? null), req.body?.error ?? null, prop ? 'proposed' : 'failed', b.id)
    res.json(sortirBrief(db().prepare('SELECT * FROM briefs WHERE id = ?').get(b.id)))
  })

  /** C'est SEULEMENT ici que des objectifs naissent, et sur le texte relu par l'humain. */
  api.post('/briefs/:id/apply', (req, res) => {
    const b = db().prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id)
    if (!b) throw new Refus("Ce brief n'existe pas.", 404)
    const d = req.body ?? {}
    if (!d.chapter?.trim()) throw new Refus('Le chapitre doit avoir un titre.')
    if (!Array.isArray(d.steps) || !d.steps.length) throw new Refus('Un chapitre sans étape ne sert à rien.')

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
      ...objectifPar(chap),
      children: db().prepare('SELECT * FROM objectives WHERE parent_id = ? ORDER BY priority').all(chap),
    })
  })

  api.delete('/briefs/:id', (req, res) => {
    db().prepare('DELETE FROM briefs WHERE id = ?').run(req.params.id)
    res.sendStatus(204)
  })

  // ---- workflows, permissions, invariants, ressources ---------------------

  api.get('/projects/:slug/workflows', (req, res) => {
    const p = projetPar(req.params.slug)
    res.json(
      db()
        .prepare('SELECT * FROM workflows WHERE project_id = ?')
        .all(p.id)
        .map((w) => ({
          ...w,
          active: Boolean(w.active),
          steps: json.lire(w.steps, []),
          stop_when: json.lire(w.stop_when, {}),
          absorb: json.lire(w.absorb, []),
        })),
    )
  })

  api.get('/projects/:slug/permissions', (req, res) => {
    const p = projetPar(req.params.slug)
    res.json(db().prepare('SELECT * FROM permissions WHERE project_id = ? ORDER BY harness, pattern').all(p.id))
  })

  api.get('/projects/:slug/permissions/effective/:harness', (req, res) => {
    const p = projetPar(req.params.slug)
    const lignes = db()
      .prepare('SELECT pattern, decision FROM permissions WHERE project_id = ? AND harness = ?')
      .all(p.id, req.params.harness)
    res.json({
      allow: lignes.filter((l) => l.decision === 'allow').map((l) => l.pattern),
      deny: lignes.filter((l) => l.decision === 'deny').map((l) => l.pattern),
      ask: lignes.filter((l) => l.decision === 'ask').map((l) => l.pattern),
    })
  })

  api.patch('/permissions/:id', (req, res) => {
    const perm = db().prepare('SELECT * FROM permissions WHERE id = ?').get(req.params.id)
    if (!perm) throw new Refus("Cette autorisation n'existe pas.", 404)
    if (!['allow', 'deny', 'ask'].includes(req.body?.decision)) throw new Refus('Décision inconnue.')
    db().prepare('UPDATE permissions SET decision = ? WHERE id = ?').run(req.body.decision, perm.id)
    res.json(db().prepare('SELECT * FROM permissions WHERE id = ?').get(perm.id))
  })

  api.post('/projects/:slug/permissions/requested', (req, res) => {
    const p = projetPar(req.params.slug)
    const { harness, patterns } = req.body ?? {}
    if (!harness || !Array.isArray(patterns)) throw new Refus('Relevé incomplet.')
    db().transaction(() => {
      for (const motif of patterns) {
        db()
          .prepare(
            `INSERT INTO permissions (project_id,harness,pattern,decision,requested,last_requested_at)
             VALUES (?,?,?,'ask',1,?)
             ON CONFLICT(project_id,harness,pattern)
             DO UPDATE SET requested = requested + 1, last_requested_at = excluded.last_requested_at`,
          )
          .run(p.id, harness, motif, maintenant())
      }
    })()
    res.json({ ok: true })
  })

  api.get('/projects/:slug/invariants', (req, res) => {
    const p = projetPar(req.params.slug)
    res.json(db().prepare('SELECT * FROM invariants WHERE project_id = ?').all(p.id).map((i) => ({ ...i, armed: Boolean(i.armed) })))
  })

  api.post('/invariants/:id/readings', (req, res) => {
    const i = db().prepare('SELECT * FROM invariants WHERE id = ?').get(req.params.id)
    if (!i) throw new Refus("Cet invariant n'existe pas.", 404)
    const b = req.body ?? {}
    db()
      .prepare('UPDATE invariants SET last_value=?, last_status=?, last_checked_at=? WHERE id=?')
      .run(String(b.value ?? ''), b.status ?? 'unknown', maintenant(), i.id)
    res.json(db().prepare('SELECT * FROM invariants WHERE id = ?').get(i.id))
  })

  api.get('/projects/:slug/resources', (req, res) => {
    const p = projetPar(req.params.slug)
    res.json(db().prepare('SELECT * FROM resources WHERE project_id = ?').all(p.id).map((r) => ({ ...r, included: Boolean(r.included) })))
  })

  app.use('/api', api)

  // Le front compilé est servi par le même processus : un seul port, une seule
  // commande, rien à garder vivant en parallèle. Trois processus à surveiller,
  // c'était trois façons de tomber en silence.
  const front = join(ici, '..', 'public')
  if (existsSync(front)) {
    app.use(express.static(front))
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(front, 'index.html')))
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof Refus) return res.status(err.code).json({ message: err.message, ...err.extra })
    console.error(err)
    res.status(500).json({ message: err.message ?? 'erreur interne' })
  })

  return app
}

export function servir(port = Number(process.env.PORT ?? 4747)) {
  return new Promise((ok) => {
    const serveur = creerServeur().listen(port, () => ok({ serveur, port }))
  })
}
