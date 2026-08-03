import { base, json } from './db/index.js'
import { evaluateGate, canStart, HUMAN_HALTS } from './gate.js'
import { blockers } from './blockers.js'

/**
 * What is waiting on a person — derived, in ONE place.
 *
 * Every screen used to assemble its own answer, and each got a different one.
 * The overview added up satisfiable gates, open halts and breached measurements;
 * a project counted open halts alone; an objective knew nothing of either and
 * showed a verdict panel whether or not anybody was expected to press it. Three
 * counters, three rules, one question.
 *
 * The rule that matters is not "what is unfinished" — that is the whole board —
 * but "what will never move again unless a person moves it". A chapter waiting
 * on its judging conversation is not waiting on you: the loop asks. A chapter
 * whose criterion is fully met and which nothing is going to close, is.
 */

/** A run that ended this way is not going to be picked up again by itself. */
const RUN_NEEDS_PERSON = [
  'needs_you',
  'judge_silent',
  'judge_conversation_full',
  'judge_page_unreachable',
  'no_progress_budget',
  'no_unity_editor',
  'out_of_turns',
]

/**
 * A reading old enough that acting on it would be acting on a memory.
 *
 * Six hours is not a threshold anybody agreed on; it is the point past which a
 * working tree, a production table or a frame time has had every opportunity to
 * change without anybody watching. Returns how old, in words, or null when it is
 * recent enough to be treated as current.
 */
function staleness(iso) {
  if (!iso) return 'never measured'
  const hours = (Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 3600000
  if (hours < 6) return null
  const days = Math.round(hours / 24)
  return days >= 1 ? `taken ${days} day${days > 1 ? 's' : ''} ago` : `taken ${Math.round(hours)} hours ago`
}

export function attention() {
  const db = base()
  const out = []

  const projects = new Map(db.prepare('SELECT id, slug, name, gate_judge FROM projects').all().map((p) => [p.id, p]))

  const open = db
    .prepare(
      `SELECT id, title, project_id, status FROM objectives
       WHERE status IN ('in_progress','blocked','ready')`,
    )
    .all()

  for (const o of open) {
    const p = projects.get(o.project_id)
    const gate = evaluateGate(o.id)
    const judge = p?.gate_judge ?? 'human'

    /**
     * The one `/api/review` dropped on the floor.
     *
     * Its two lists were "ready and not ok" and "not ready". An objective whose
     * gate is entirely satisfied — ready AND ok — matches neither, so the
     * endpoint whose whole job is to show what awaits a decision was the only
     * place that could not show the objective actually awaiting one. Iberis #7
     * sat there, concludable, invisible, since the 2nd of August.
     */
    if (gate.ok) {
      out.push({
        kind: 'conclude',
        severity: 'decide',
        project: p?.slug ?? null,
        objective: o.id,
        title: o.title,
        why: 'Everything the criterion asks for is here, and nothing is going to close it on its own.',
        action: 'Conclude it — or say it is not good enough, which is just as useful.',
        href: `/o/${o.id}`,
        since: null,
      })
      continue
    }

    // Waiting on a verdict that only a person can give. When the judge is the
    // driving conversation, the loop asks it every turn — that is not yours.
    if (gate.ready && gate.reason === 'awaiting_verdict' && judge !== 'gpt' && judge !== 'self') {
      out.push({
        kind: 'verdict',
        severity: 'decide',
        project: p?.slug ?? null,
        objective: o.id,
        title: o.title,
        why: gate.detail ?? 'The proofs are in and this project asks you to accept them.',
        action: 'Read what came out and give your verdict.',
        href: `/o/${o.id}`,
        since: null,
      })
    }
  }

  // Halts the loop cannot clear by itself. It clears a rejected verdict or a
  // stall on its own; counting those would manufacture a queue.
  const marks = HUMAN_HALTS.map(() => '?').join(',')
  for (const h of db
    .prepare(
      `SELECT h.id, h.reason, h.detail, h.created_at, o.id objective, o.title, p.slug project
       FROM halts h JOIN objectives o ON o.id = h.objective_id JOIN projects p ON p.id = o.project_id
       WHERE h.resolved_at IS NULL AND h.reason IN (${marks})`,
    )
    .all(...HUMAN_HALTS)) {
    out.push({
      kind: 'halt',
      severity: 'decide',
      project: h.project,
      objective: h.objective,
      title: h.title,
      why: h.detail ?? h.reason,
      action: 'Decide, then clear the halt — the run is suspended, not dead.',
      href: `/o/${h.objective}`,
      since: h.created_at,
    })
  }

  /**
   * A run that stopped and said so, with nothing after it.
   *
   * This was the loudest signal in the database and the quietest on screen: the
   * word lived on the run row, and one component displayed it — on the objective
   * page, which you only reach if you already suspected something. Run 43 ended
   * `needs_you` at midnight and every overview read "nothing waiting on you".
   */
  const stops = RUN_NEEDS_PERSON.map(() => '?').join(',')
  for (const r of db
    .prepare(
      `SELECT r.id, r.outcome, r.reason, r.ended_at, o.id objective, o.title, p.slug project
       FROM runs r JOIN objectives o ON o.id = r.objective_id JOIN projects p ON p.id = r.project_id
       WHERE r.outcome IN (${stops})
         AND o.status IN ('in_progress','blocked','ready')
         -- only if it is still the last word on that objective
         AND NOT EXISTS (SELECT 1 FROM runs r2 WHERE r2.objective_id = r.objective_id AND r2.id > r.id)`,
    )
    .all(...RUN_NEEDS_PERSON)) {
    out.push({
      kind: 'run_stopped',
      severity: 'decide',
      project: r.project,
      objective: r.objective,
      title: r.title,
      why: `The last run ended on “${r.outcome.replace(/_/g, ' ')}” and nothing has run since.`,
      action: 'Read what it left, then start it again or change what you are asking for.',
      href: `/o/${r.objective}`,
      since: r.ended_at,
    })
  }

  // A measurement that used to hold and no longer does.
  for (const i of db
    .prepare(
      `SELECT i.id, i.name, i.last_status, i.last_checked_at, i.objective_id, p.slug project
       FROM invariants i JOIN projects p ON p.id = i.project_id
       WHERE i.last_status = 'breached'`,
    )
    .all()) {
    out.push({
      kind: 'invariant_breached',
      severity: 'decide',
      project: i.project,
      objective: i.objective_id,
      title: i.name,
      /**
       * How old the reading is, in the sentence itself.
       *
       * Atlas carried "out of bounds, 2 files" for six days. The probe returned
       * 0 the whole time — nobody had re-run it, and the screen showed the
       * remembered value with nothing to say when it was taken. A breach is a
       * measurement, and a measurement without its date is an opinion.
       */
      why: staleness(i.last_checked_at)
        ? `A measurement that no longer held when it was last taken — ${staleness(i.last_checked_at)}. ` +
          'It may well have been fixed since; nothing has measured it again.'
        : 'A measurement that used to hold no longer does.',
      action: staleness(i.last_checked_at)
        ? 'Re-run it before acting on it: `orchestrator invariants:check` in the repository.'
        : 'Look at what broke it before starting anything else on this project.',
      href: i.objective_id ? `/o/${i.objective_id}` : `/p/${i.project}/analysis`,
      since: i.last_checked_at,
    })
  }

  // Conditions that make any pass fail before it starts. Not a decision — an
  // errand — but it is still a person's, and nothing else will do it.
  for (const b of blockers().filter((x) => x.severity === 'blocking')) {
    out.push({
      kind: 'blocking_condition',
      severity: 'fix',
      project: b.project,
      objective: b.objective ?? b.stops?.[0]?.id ?? null,
      title: b.group ?? b.title,
      why: b.detail,
      action: b.action,
      href: b.project ? `/p/${b.project}` : '/',
      since: b.since,
    })
  }

  // Decisions before errands: an errand can be done by anyone at any time, a
  // decision is what the tool is actually stuck on.
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'decide' ? -1 : 1))
}

/** The same list, narrowed to one project. */
export function attentionFor(slug) {
  return slug ? attention().filter((a) => a.project === slug || a.project == null) : attention()
}

/**
 * The next step — one sentence, one button.
 *
 * A project screen answered four questions well and the first one badly: what
 * do I do now. What is in the way, what waits on you, how far each chapter is,
 * where the money went — all true, all on the same page, and none of them
 * saying which to act on first. The reader had to rank them, every time, and
 * ranking them is exactly the judgement the tool already makes.
 *
 * The order is not a preference. A blocking condition beats a decision because
 * no decision survives a pass that cannot run; a decision beats new work
 * because starting more while something waits on you is how four projects end
 * up half-done; a chapter with no criterion beats the queue because no agent
 * can take it, however high its priority.
 *
 * `orchestrator next` had a version of this and it read the objectives table
 * alone — first by priority, blockers and gates ignored. It would have sent you
 * at a chapter whose editor was closed.
 */
export function nextStep(slug) {
  const db = base()
  const p = db.prepare('SELECT id, slug, name FROM projects WHERE slug = ?').get(slug)
  if (!p) return null

  const waiting = attention().filter((a) => a.project === slug || a.project == null)

  const blocking = waiting.find((a) => a.severity === 'fix')
  if (blocking) {
    return {
      kind: 'unblock',
      headline: blocking.title,
      why: `Nothing on this project can run until this is cleared. ${blocking.why}`,
      action: blocking.action,
      href: blocking.href,
      // Carried so the page can tell that the list below is repeating this one.
      objective: blocking.objective ?? null,
    }
  }

  const decision = waiting.find((a) => a.severity === 'decide')
  if (decision) {
    return {
      kind: decision.kind,
      headline: decision.title,
      why: decision.why,
      action: decision.action,
      href: decision.href,
      objective: decision.objective ?? null,
    }
  }

  // A criterion is what lets an agent take the work at all, so a chapter
  // without one is not "low priority", it is unreachable.
  const mute = db
    .prepare(
      `SELECT id, title FROM objectives
       WHERE project_id = ? AND status NOT IN ('proven','abandoned')
         AND (proof_spec IS NULL OR TRIM(proof_spec) = '')
       ORDER BY priority, id LIMIT 1`,
    )
    .get(p.id)
  if (mute) {
    return {
      kind: 'no_criterion',
      objective: mute.id,
      headline: mute.title,
      why: 'It does not say how it would be proven, so no agent can pick it up whatever its priority.',
      action: 'Write what would prove it finished, on the Plan tab.',
      href: `/p/${slug}/plan`,
    }
  }

  const candidates = db
    .prepare(
      `SELECT id, title FROM objectives
       WHERE project_id = ? AND status IN ('ready','in_progress') ORDER BY priority, id`,
    )
    .all(p.id)

  for (const o of candidates) {
    const start = canStart(o.id)
    if (start.ok) {
      return {
        kind: 'run',
        headline: o.title,
        why: 'Nothing is in the way and nothing waits on you. This is the next one an agent can take.',
        action: 'Start it — the instruction you give it is the whole of what it will try to do.',
        href: `/o/${o.id}`,
        objective: o.id,
      }
    }
  }

  // Saying "nothing" is an answer, as long as it says which nothing.
  const left = db
    .prepare(
      `SELECT COUNT(*) n FROM objectives WHERE project_id = ? AND status NOT IN ('proven','abandoned')`,
    )
    .get(p.id).n

  return left
    ? {
        kind: 'stuck',
        headline: 'Nothing here can be started right now',
        why: `${left} objective(s) are still open and none of them can begin — each is halted, or its criterion refuses a fresh attempt.`,
        action: 'Open the track below: the reason is on the one that stopped.',
        href: `/p/${slug}`,
      }
    : {
        kind: 'done',
        headline: 'Everything asked for is proven',
        why: 'No objective is open on this project.',
        action: 'Break down what comes next, or leave it here.',
        href: `/p/${slug}/plan`,
      }
}

/**
 * The next step for ONE objective, in the words of somebody who has to act.
 *
 * Its page announced two states — "in progress", "not ready to conclude" — and
 * no action. Both are true and neither is an instruction: a reader who did not
 * build this cannot tell whether they are waiting on a machine, on a decision,
 * or on nothing at all. The project page got this band and the objective page,
 * where the work is actually done, did not.
 *
 * It says the same thing every time in the same order: what state this is in,
 * why, and the ONE thing to do about it.
 */
export function nextStepForObjective(id) {
  const db = base()
  const o = db
    .prepare(
      `SELECT o.*, p.slug, p.gate_judge FROM objectives o JOIN projects p ON p.id = o.project_id
       WHERE o.id = ?`,
    )
    .get(id)
  if (!o) return null

  if (o.status === 'proven') {
    return { tone: 'done', headline: 'Accepted', why: 'The criterion was met and a verdict closed it.', action: null }
  }
  if (o.status === 'abandoned') {
    return {
      tone: 'done',
      headline: 'Set aside',
      why: 'It is no longer counted, and nothing runs on it. What it proved is kept.',
      action: null,
    }
  }

  // A condition of the machine beats everything: no instruction survives a pass
  // that cannot start.
  const blocking = blockers().find(
    (b) => b.severity === 'blocking' && (b.project === o.slug || b.project == null),
  )
  if (blocking) {
    return {
      tone: 'blocked',
      headline: blocking.group ?? blocking.title,
      why: blocking.detail,
      action: blocking.action,
    }
  }

  /**
   * A diagnosis beats a rule.
   *
   * The gate can say "nothing new has been produced to judge", which is true of
   * a thousand objectives. When something has actually READ this one — its
   * history, its failures, its criterion — and come back with "these two
   * requirements cannot both hold, here is the decision", that is the more
   * useful sentence, and it was sitting unread in a table.
   */
  const judged = db
    .prepare(
      `SELECT proposal FROM briefs WHERE objective_id = ? AND proposal IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(id)
  const verdict = judged ? json.read(judged.proposal, null) : null

  /**
   * A decision taken after the analysis answers it, and the page must move on.
   *
   * Otherwise the screen keeps asking for a judgement that has been made — and
   * the person who made it has no way to tell whether it registered.
   */
  const decided = db
    .prepare(
      `SELECT title, body, decided_at FROM decisions
       WHERE objective_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(id)

  /**
   * Shown when there is something to CHOOSE, not when the verdict is bad.
   *
   * This first read "any verdict except provable", and the second analysis of
   * chapter 3 came back `provable` with three branches and a question — the most
   * useful answer yet, and the rule would have dropped it on the floor. What
   * decides is whether a person still has something to settle.
   */
  const toSettle = Boolean(verdict?.options?.length || verdict?.decision_needed)

  if (verdict && toSettle && o.status !== 'proven' && !decided) {
    const WORD = {
      over_constrained: 'Two of its requirements cannot both hold',
      unmeasurable: 'Nothing can measure this as written',
      too_big: 'Too big for one session — it wants splitting',
      provable: 'It can be proven — but not without a choice from you',
    }
    return {
      tone: 'decide',
      headline: WORD[verdict.verdict] ?? verdict.verdict,
      /**
       * Only what is SHORT enough to be read standing up.
       *
       * A contradiction arrives as two lines and belongs at the top. The long
       * reasoning does not: with no contradiction this fell back to it, printed a
       * wall above the options, and then offered the same wall again behind
       * "read the reasoning". The fold is where it lives when there are branches
       * to choose instead.
       */
      why: (verdict.contradiction ?? []).join('\n') || (verdict.options?.length ? '' : verdict.why),
      action: verdict.decision_needed ?? 'Read what it found, below, and decide.',
      /**
       * The branches, as things to choose rather than as a paragraph to distil.
       *
       * The first version of this returned the whole reasoning in `action` — 1500
       * characters of prose with "Branche A" and "Branche B" buried in it — and
       * asked the reader to synthesise a decision out of it. The tool held the
       * structure and handed over the work of finding it.
       */
      options: Array.isArray(verdict.options) ? verdict.options : [],
      /** The long reasoning, kept but folded away: it is there to be checked. */
      reasoning: verdict.why ?? null,
      from: 'analysis',
    }
  }

  /**
   * A halt outranks a decision, because it outranks a start.
   *
   * The band went on saying "you have decided — start a pass" while the pass it
   * was inviting could not begin: a halt had been opened by the previous
   * attempt, and nothing on the page mentioned it. The instruction has to fail
   * the same way the machine does.
   */
  const halt = db
    .prepare(
      `SELECT id, reason, detail FROM halts WHERE objective_id = ? AND resolved_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(id)
  if (halt && o.status !== 'proven') {
    return {
      tone: 'decide',
      headline: 'A pass stopped here and nothing goes round it',
      why: halt.detail ?? halt.reason,
      action:
        decided
          ? 'You have since decided. Clear this, below, and start a pass — it will be handed your decision.'
          : 'Answer what it asks, below, then clear it.',
      from: 'halt',
      halt: halt.id,
    }
  }

  if (decided && o.status !== 'proven') {
    return {
      tone: 'work',
      headline: 'You have decided — nothing has run on it since',
      why: decided.body,
      action:
        'Start a pass. Every session is handed this decision and is told not to contradict it, so ' +
        'what it does next follows from it.',
      from: 'decision',
    }
  }

  const gate = evaluateGate(id)

  if (gate.ok) {
    return {
      tone: 'decide',
      headline: 'It is ready to be concluded — that is your call',
      why: 'Everything the criterion asks for has been produced and accepted. Nothing will close it on its own.',
      action: 'Read what came out, then press “The criterion is met”. Or refuse it, which is just as useful.',
    }
  }

  /**
   * Why it refuses, said as a thing to do rather than as a rule that failed.
   *
   * The gate's own sentence explains itself correctly and to the wrong person:
   * "no proof with a pass verdict is attached" is a fact about the database.
   */
  const INSTRUCTION = {
    no_provable_criterion: {
      headline: 'It does not say how it would be proven',
      action: 'Write what would prove it finished — until then no agent can pick it up.',
    },
    children_open: {
      headline: 'Its steps are not all finished',
      action: 'Open the steps below: a chapter closes when they do.',
    },
    no_new_proof: {
      headline: 'Nothing new has been produced to judge',
      action:
        'Run it again to produce something new, or change what would prove it. A verdict now would rest on nothing.',
    },
    blast_radius: {
      headline: 'What it touches asks for proof from the real world',
      action: 'Run it again and let it produce a test, a run through the screen, or a measurement.',
    },
    awaiting_verdict: {
      headline: 'Everything is here — only the verdict is missing',
      action:
        o.gate_judge === 'gpt'
          ? 'The driving conversation rules on this one. Start a pass and it will be asked.'
          : 'Read what came out and say whether the criterion is met.',
    },
    human_request: {
      headline: 'A halt is open and nothing goes round it',
      action: 'Answer what it asks, below, and clear it.',
    },
  }

  const known = INSTRUCTION[gate.reason]
  return {
    tone: gate.ready ? 'decide' : 'work',
    headline: known?.headline ?? 'It cannot be concluded yet',
    // The gate's explanation stays: it is the evidence for the instruction.
    why: gate.detail ?? '',
    action: known?.action ?? 'Look at what it has produced, then run it again or change what would prove it.',
  }
}
