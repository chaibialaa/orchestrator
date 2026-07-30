import { base, json } from './db/index.js'

/**
 * The proof gate. "Done" is not a field an agent writes, it is a condition we
 * evaluate — every transition to `proven` comes through here.
 *
 * Every rule below exists because it was missing at least once, and its absence
 * let something false through. The comments say which one: removing them
 * reopens the gate.
 */

/** Proof types that require contact with the real world, not just a green build. */
export const REAL_WORLD = ['e2e', 'manual', 'invariant', 'screenshot', 'render']

/** Halt reasons that REALLY need a human. The loop clears the others itself. */
export const HUMAN_HALTS = [
  'blast_radius',
  'no_provable_criterion',
  'invariant_regression',
  'human_request',
]

const refuse = (reason, detail) => ({ ok: false, reason, detail, ready: false })

/** Who pronounced this proof, if it is a judgement. Otherwise, nobody. */
const judgedBy = (e) => json.read(e.payload, {})?.judged_by ?? null

/**
 * Does the criterion require looking at an image to be settled?
 *
 * The French words stay: this matches a `proof_spec` written by a human or by
 * the driving conversation, and those are still written in French. Dropping them
 * would silently disable the rule on every existing objective.
 */
export function requiresVisual(spec) {
  return /(capture|rendu|render|screenshot|image|visuel|visual|lisible|readable|on ?screen|à l['’]écran|plan [ABC])/iu.test(
    spec ?? '',
  )
}

export function evaluateGate(objectiveId) {
  const db = base()
  const o = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
  if (!o) return refuse('error', 'This objective does not exist.')

  if (!o.proof_spec || !o.proof_spec.trim()) {
    return refuse('no_provable_criterion', 'No proof criterion is defined for this objective.')
  }

  // A chapter does not conclude before its parts. Without this rule, a parent
  // carrying a few proofs read as "ready" while its sub-objectives were still
  // open.
  const openChildren = db
    .prepare("SELECT id, title FROM objectives WHERE parent_id = ? AND status NOT IN ('proven','abandoned')")
    .all(o.id)

  if (openChildren.length) {
    return refuse(
      'children_open',
      `${openChildren.length} sub-objective(s) still open: ` +
        openChildren.map((e) => `#${e.id} ${e.title}`).join(' · ') +
        '.',
    )
  }

  const passing = db
    .prepare("SELECT * FROM evidences WHERE objective_id = ? AND verdict = 'pass'")
    .all(o.id)

  if (!passing.length) {
    return refuse('no_new_proof', 'No proof with a `pass` verdict is attached to this objective.')
  }

  // A criterion that requires SEEING does not conclude on text. The judge only
  // has what we hand over: with no image attached, its "accepted" is about the
  // executor's account, not about its work. That happened twice in a row before
  // this rule existed.
  if (requiresVisual(o.proof_spec)) {
    const images = db
      .prepare("SELECT COUNT(*) n FROM evidences WHERE objective_id = ? AND type IN ('render','screenshot')")
      .get(o.id).n

    if (!images) {
      return refuse(
        'no_new_proof',
        'The criterion asks to see something, and no image is attached. ' +
          "A verdict pronounced without a rendering judges the session's story, not its work.",
      )
    }
  }

  // High blast radius: a green build is not enough, it takes a proof that
  // touched the real world — and that comes from the WORK, not from the
  // judgement. A verdict is a `manual` proof, therefore "real world" by the
  // list above: without this exclusion, the judge satisfied itself on a critical
  // objective. Found by a test, never by use.
  if (['api', 'critical'].includes(o.blast_radius)) {
    const fromWork = passing.filter((e) => REAL_WORLD.includes(e.type) && judgedBy(e) === null)
    if (!fromWork.length) {
      const supplied = [...new Set(passing.map((e) => e.type))].join(', ')
      return refuse(
        'blast_radius',
        `Blast radius \`${o.blast_radius}\`: a proof of type ${REAL_WORLD.join('/')} is required, ` +
          `only ${supplied} were supplied.`,
      )
    }
  }

  // A judge may take it back — but on something NEW. Without this rule, asking
  // again was enough to turn a rejection into an acceptance: rejected at 12:40,
  // accepted at 12:49, zero attempts and zero proof in between. That is the
  // exact opposite of what the tool promises.
  const lastRejection = db
    .prepare(
      `SELECT evidence_mark FROM halts
       WHERE objective_id = ? AND reason IN ('verdict_rejected','human_request')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(o.id)

  if (lastRejection?.evidence_mark != null) {
    const since = db
      .prepare(
        `SELECT COUNT(*) n FROM evidences
         WHERE objective_id = ? AND id > ? AND type != 'manual'`,
      )
      .get(o.id, lastRejection.evidence_mark).n

    if (!since) {
      return refuse(
        'no_new_proof',
        'The judge rejected, then accepted, without a single proof being produced in between. ' +
          'An opinion may change; it has to change on something new.',
      )
    }
  }

  const project = db.prepare('SELECT gate_judge FROM projects WHERE id = ?').get(o.project_id)
  const judge = project?.gate_judge ?? 'human'

  if (judge === 'gpt') {
    if (!passing.some((e) => judgedBy(e) === 'gpt')) {
      // An essential distinction: a proof is NOT missing, a verdict is. The
      // objective is ready, it is waiting for its judge.
      return {
        ok: false,
        reason: 'awaiting_verdict',
        detail: 'Everything is here. Only the verdict of the driving conversation is missing.',
        ready: true,
      }
    }
  } else if (judge !== 'self') {
    const independent = passing.some(
      (e) =>
        e.passage_id === null ||
        judgedBy(e) !== null ||
        db.prepare('SELECT harness FROM passages WHERE id = ?').get(e.passage_id)?.harness === 'human',
    )

    if (!independent) {
      return {
        ok: false,
        reason: 'awaiting_verdict',
        detail:
          judge === 'human'
            ? 'Everything is here. Only your verdict is missing: the proofs come from the executor, and this project requires you to accept them.'
            : 'Everything is here. Only an independent judgement is missing.',
        ready: true,
      }
    }
  }

  const openHalt = db
    .prepare('SELECT reason FROM halts WHERE objective_id = ? AND resolved_at IS NULL LIMIT 1')
    .get(o.id)

  if (openHalt) {
    return refuse(
      'human_request',
      'A halt is still open on this objective; it has to be cleared before concluding.',
    )
  }

  return { ok: true, reason: null, detail: null, ready: true }
}

/**
 * A pass only starts if we already know how the result will be proven. That is
 * the detectable form of "I am stuck".
 */
export function canStart(objectiveId) {
  const db = base()
  const o = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
  if (!o) return refuse('error', 'This objective does not exist.')

  if (!o.proof_spec || !o.proof_spec.trim()) {
    return refuse(
      'no_provable_criterion',
      'Cannot start: the objective does not state how it will be proven.',
    )
  }

  const blockingHalt = db
    .prepare(
      `SELECT reason FROM halts WHERE objective_id = ? AND resolved_at IS NULL
       AND reason IN (${HUMAN_HALTS.map(() => '?').join(',')}) LIMIT 1`,
    )
    .get(o.id, ...HUMAN_HALTS)

  if (blockingHalt) {
    return refuse('human_request', 'An uncleared halt is blocking this objective.')
  }

  return { ok: true, reason: null, detail: null }
}

/**
 * Stalling: N consecutive attempts with no new proof. A PREVENTED attempt did
 * not try — permissions refused, usage ceiling, diagnostic probe — and does not
 * count. Counting them made the method look at fault when nothing had been
 * attempted at all.
 */
export function isStalling(objectiveId, threshold = 2) {
  const db = base()
  const recentPassages = db
    .prepare(
      `SELECT id FROM passages
       WHERE objective_id = ? AND ended_at IS NOT NULL AND prevented = 0
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(objectiveId, threshold)

  if (recentPassages.length < threshold) return false

  return recentPassages.every(
    (p) =>
      db
        .prepare("SELECT COUNT(*) n FROM evidences WHERE passage_id = ? AND verdict = 'pass'")
        .get(p.id).n === 0,
  )
}
