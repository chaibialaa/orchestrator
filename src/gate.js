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
  // Ten attempts that proved nothing are not nine attempts plus bad luck. The
  // loop cannot fix this by trying again — the criterion or the approach has to
  // change, and that is a decision.
  'not_converging',
]

/**
 * Attempts without a passing proof before we stop and ask.
 *
 * Not a round number for its own sake: below about six, a hard objective looks
 * like a stuck one and the loop would be interrupted while it is working. Past
 * that, the record here shows attempts repeating rather than converging.
 */
const NOT_CONVERGING_AFTER = 6

/**
 * However well it is converging, this many attempts is a method problem.
 *
 * Without it, a quantity improving by a tenth each pass would run for ever, and
 * "it is moving" would become the excuse that patience always finds.
 */
const HARD_CEILING = 12

/**
 * Has any measured quantity come CLOSER to its target since the run before?
 *
 * The rule above counts passing proofs, so a chapter converging slowly looks
 * exactly like a dead one. Chapter 6 spent six passes at a steady
 * `9 PASS / 1 FAIL` while the palette distance went from 62.3 to 49.0 — real
 * work, invisible to a verdict, and stopped by this rule as if nothing had
 * happened.
 *
 * Only what a proof states itself, through `PROGRESS <name> <value> <target>`.
 * Nothing is inferred from prose, and a gate that says nothing falls back to the
 * old rule unchanged — so adopting this costs nothing and skips nobody.
 */
function rapproche(db, objectiveId) {
  const runs = db
    .prepare(
      `SELECT payload FROM evidences
       WHERE objective_id = @id AND payload IS NOT NULL AND payload LIKE '%progress%'
       ORDER BY id DESC LIMIT 2`,
    )
    .all({ id: objectiveId })
    .map((e) => json.read(e.payload, {})?.progress)
    .filter(Array.isArray)

  if (runs.length < 2) return null

  const [maintenant, avant] = runs
  for (const m of maintenant) {
    const a = avant.find((x) => x.name === m.name)
    if (!a) continue
    // Closer, whichever side of the target it started on.
    const ecartAvant = Math.abs(a.value - a.target)
    const ecartMaintenant = Math.abs(m.value - m.target)
    if (ecartMaintenant < ecartAvant) {
      return `${m.name} moved from ${a.value} to ${m.value}, target ${m.target}`
    }
  }
  return null
}

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

/**
 * The rules a person may lift, one objective at a time.
 *
 * `requiresVisual` reads words, and words name the subject as often as they name
 * a demand. A criterion asking for a CSV of measurements over a corpus of
 * captures mentions "capture", "visual", "image" — and asks nobody to look at
 * anything. Widening the regex to tell those apart would weaken the rule
 * everywhere to fix it in one place.
 *
 * So the rule stays whole and the exception is named: a person states, on this
 * objective, that its criterion does not require seeing. It costs a decision
 * with an author and a date, and it stays legible afterwards — where a quietly
 * loosened regex would leave no trace of who decided what.
 */
export const WAIVABLE = [
  'visual_proof',
  /**
   * Closed on the judge's word, before a proof was required — and not
   * re-measurable, because the criterion asked for a rubric score no command
   * computes. Two objectives predate the rule that now refuses that shape.
   *
   * It lifts a WARNING, never the gate: nothing here lets a new objective close
   * on a verdict. It stops a permanent flag from teaching someone to ignore the
   * panel it lives in.
   */
  'verdict_only',
]

/**
 * Is the missing image the thing standing in the way, right now? Asked by the
 * page that has to offer the waiver, so that the option shows up where the rule
 * bites and nowhere else.
 */
export function needsImage(objectiveId) {
  const db = base()
  const o = db.prepare('SELECT id, proof_spec FROM objectives WHERE id = ?').get(objectiveId)
  if (!o || !requiresVisual(o.proof_spec)) return false
  if (waiver(db, o.id, 'visual_proof')) return false
  return !db
    .prepare("SELECT COUNT(*) n FROM evidences WHERE objective_id = ? AND type IN ('render','screenshot')")
    .get(o.id).n
}

export function waiver(db, objectiveId, rule) {
  return (
    db
      .prepare('SELECT * FROM decisions WHERE objective_id = ? AND waives = ? ORDER BY decided_at DESC')
      .get(objectiveId, rule) ?? null
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

  /**
   * A verdict is not a proof of itself.
   *
   * Saying "the criterion is satisfied" writes a `manual` evidence with a `pass`
   * verdict, which then satisfied BOTH of the two conditions this gate believes
   * it checks independently: that a passing proof exists, and that the judge has
   * ruled. One row counted twice. Sixteen of eighteen proven objectives here
   * rested on nothing else — the judge's own word, recorded as the evidence for
   * itself.
   *
   * So the two are separated: `work` is what the pass produced, `verdicts` are
   * opinions about it. An opinion can close an objective; it cannot BE the thing
   * it closes on.
   */
  const work = passing.filter((e) => judgedBy(e) === null)
  const verdicts = passing.filter((e) => judgedBy(e) !== null)

  if (!work.length) {
    return refuse(
      'no_new_proof',
      verdicts.length
        ? 'The only passing proof here IS the verdict. A judgement is not evidence of itself: ' +
          'something the pass produced — a command, a measurement, a rendering — has to be attached.'
        : 'No proof with a `pass` verdict is attached to this objective.',
    )
  }

  // A criterion that requires SEEING does not conclude on text. The judge only
  // has what we hand over: with no image attached, its "accepted" is about the
  // executor's account, not about its work. That happened twice in a row before
  // this rule existed.
  if (requiresVisual(o.proof_spec) && !waiver(db, o.id, 'visual_proof')) {
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

  /**
   * A halt outranks the judge, and used to come after it.
   *
   * The `awaiting_verdict` branch below returns early, so on a project judged by
   * the driving conversation this check was never reached: an objective stopped
   * by an open halt still reported `ready`, the page offered a verdict on it, and
   * casting one would have written a proof that closed nothing — the gate would
   * have refused on the halt a step later, without a word.
   */
  const openHalt = db
    .prepare('SELECT reason, detail FROM halts WHERE objective_id = ? AND resolved_at IS NULL LIMIT 1')
    .get(o.id)

  if (openHalt) {
    /**
     * The halt's OWN reason, not `human_request` for all of them.
     *
     * Every open halt was reported under that one label, which means something
     * precise — a person has to decide — and most halts are not that. An
     * absorbable `no_new_proof` came back as `human_request`, so the screen said
     * "a pass stopped here and nothing goes round it" about something the verdict
     * route clears by itself a second later.
     */
    return refuse(
      openHalt.reason,
      `A halt is still open on this objective (${openHalt.reason}); it has to be cleared before concluding.`,
    )
  }

  const project = db.prepare('SELECT gate_judge FROM projects WHERE id = ?').get(o.project_id)
  const judge = project?.gate_judge ?? 'human'

  if (judge === 'gpt') {
    /**
     * A person's verdict counts, whoever the project's judge is.
     *
     * `gate_judge` says who judges BY DEFAULT, not who is allowed to. The
     * distinction was never made, so the page offered "Conclude it now — you are
     * accepting what came out, without waiting for the conversation", the click
     * wrote a `judged_by: human` proof, and the gate went on answering
     * `awaiting_verdict`. The objective stayed open, the screen said nothing at
     * all, and the one control offered to a person waiting on a conversation
     * that had been dead for two hours did nothing whatsoever.
     */
    if (!passing.some((e) => ['gpt', 'human'].includes(judgedBy(e)))) {
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

  // Before anything else: has this been going nowhere? Relaunching an objective
  // that has failed ten times in a row is not persistence, it is the same
  // attempt billed again — and the loop is what keeps relaunching it.
  const { attempts, spent } = attemptsSinceProof(o.id)
  if (attempts >= NOT_CONVERGING_AFTER) {
    const avance = rapproche(db, o.id)
    if (!avance) {
      return refuse(
        'not_converging',
        `${attempts} attempts since the last passing proof` +
          (spent ? `, $${spent.toFixed(0)} spent` : '') +
          '. Trying again changes nothing on its own: the criterion or the approach has to change.',
      )
    }
    if (attempts >= HARD_CEILING) {
      return refuse(
        'not_converging',
        `${attempts} attempts. ${avance} — but a measure creeping towards its target over that many ` +
          'passes is a problem of method, not of patience.',
      )
    }
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
/**
 * How long this objective has been running without proving anything.
 *
 * `--budget-sans-progres` guards ONE pass and is rearmed by the next, so every
 * attempt is the first as far as it is concerned. Atlas #11 spent 17 passes,
 * $462 and 412 M tokens that way without a single guard firing: each one was
 * within its own budget, and nothing counted across them.
 *
 * Counted from the last passing proof rather than from the start — an objective
 * that proved something two attempts ago is progressing, however long it has
 * been open. What we are looking for is the absence of learning, not slowness.
 */
export function attemptsSinceProof(objectiveId) {
  const db = base()

  /**
   * The clock restarts on whichever came last: a passing proof, a rewrite of the
   * criterion, or a DECISION taken on this objective. All three mean the
   * attempts before them were answering a different question, and counting them
   * against the current one leaves the halt unclearable.
   *
   * The decision was missing, and its absence contradicted the refusal's own
   * words. "Trying again changes nothing on its own: the criterion or the
   * approach has to change" — said to somebody who had just changed the
   * approach, in the box the screen provides for it, and whose decision is
   * handed to every session that follows. The tool held the proof that its own
   * condition had been met and refused anyway.
   */
  const { at: lastProof } =
    db
      .prepare(
        `SELECT MAX(at) AS at FROM (
           SELECT created_at AS at FROM evidences WHERE objective_id = @id AND verdict = 'pass'
           UNION ALL
           SELECT proof_spec_changed_at FROM objectives WHERE id = @id
           UNION ALL
           SELECT decided_at FROM decisions WHERE objective_id = @id
         )`,
      )
      .get({ id: objectiveId }) ?? {}

  const { n, spent } = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS spent FROM passages
       WHERE objective_id = ? AND prevented = 0 AND ended_at IS NOT NULL
         ${lastProof ? 'AND started_at > @since' : ''}`,
    )
    .get(objectiveId, { since: lastProof })

  return { attempts: n, spent: Number(spent), since: lastProof ?? null }
}

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
