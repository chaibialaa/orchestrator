import { base, json } from './db/index.js'
import { evaluateGate, canStart, HUMAN_HALTS, needsImage } from './gate.js'
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
/** How many times something has actually run here. Zero changes what to say. */
function attempts(db, id) {
  return db.prepare('SELECT COUNT(*) n FROM passages WHERE objective_id = ?').get(id).n
}

/**
 * Has anything happened here at all?
 *
 * Not the same question as "how many passes": evidence can be attached without
 * one — by hand, or by a check run outside a session. Counting only passages
 * called an objective untouched while its proofs sat on the page underneath.
 */
function everRan(db, id) {
  return Boolean(
    attempts(db, id) || db.prepare('SELECT COUNT(*) n FROM evidences WHERE objective_id = ?').get(id).n,
  )
}

export function nextStepForObjective(id, withChoices = true) {
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
  /**
   * A waiver is excluded here. It lifts a rule of the gate; it is not an
   * instruction for the next pass. Counted as one, the page answered a lifted
   * rule with "you have decided — start a pass", and the loop would have handed
   * the agent a note about the gate as though it were the work to do.
   */
  const decided = db
    .prepare(
      `SELECT title, body, decided_at FROM decisions
       WHERE objective_id = ? AND waives IS NULL ORDER BY id DESC LIMIT 1`,
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
   * A pass in flight outranks everything: there is nothing to do but watch it.
   *
   * The band went on saying "you have decided — nothing has run on it since"
   * with `turn 1 — codex on #26` printed directly underneath. Two states of the
   * same objective, contradicting each other, four lines apart. An instruction
   * that does not follow the machine is worse than none: it teaches the reader
   * that the top of the page is decoration.
   */
  const live = db
    .prepare(
      `SELECT id, harness, started_at FROM passages
       WHERE objective_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(id)
  const queued = db
    .prepare(
      `SELECT id, status, turn, taken_at FROM runs WHERE objective_id = ? AND status IN ('pending','running')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(id)

  /**
   * Three states, not two.
   *
   * A live run with no open passage was called "queued and about to start —
   * the worker takes it within seconds". On run 59 that sentence sat above a
   * line reading `turn 2 — claude on #50 · 2 h`: the run had been claimed two
   * hours earlier, its turn had ended, and it was waiting on the judging
   * conversation. "About to start" is what you say before anything happened,
   * and the page said it after everything had.
   */
  const between = queued?.taken_at && !live && (queued.turn ?? 0) > 0
  const lastTurnEnded = between
    ? db
        .prepare('SELECT MAX(ended_at) at FROM passages WHERE objective_id = ?')
        .get(id).at
    : null

  /**
   * Waiting, or broken?
   *
   * The page said "it runs again once an answer comes back" over a run whose
   * judging page had been dead for two hours — five give-ups in the worker log,
   * reloading a conversation that never returned. A reply normally comes back in
   * seconds, so past twenty minutes the sentence is not optimism, it is false.
   * Twenty is the loop's own silence threshold; the same number, so the screen
   * and the machine agree on when patience has stopped being reasonable.
   */
  const STALLED_MIN = 20
  const stalledFor = lastTurnEnded
    ? (() => {
        const min = Math.round((Date.now() - new Date(lastTurnEnded.replace(' ', 'T') + 'Z').getTime()) / 60000)
        return min >= STALLED_MIN ? min : null
      })()
    : null

  if ((live || queued) && o.status !== 'proven') {
    return {
      tone: 'work',
      headline: live
        ? 'A pass is working on it right now'
        : between
          ? 'A pass is between turns, waiting on the conversation that judges'
          : 'A pass is queued and about to start',
      why: live
        ? `${live.harness} has been on it since ${live.started_at?.slice(11, 16) ?? 'a moment ago'}.`
        : between
          ? `Turn ${queued.turn} ended at ${lastTurnEnded?.slice(11, 16) ?? 'an unknown time'}` +
            (stalledFor
              ? `, ${stalledFor} minutes ago, and no turn has begun since. A reply normally comes back ` +
                'in seconds: the judging conversation is very likely unreachable, and waiting will not fix it.'
              : '. It runs again once an answer comes back; nothing is being spent while it waits.')
          : 'The worker on the machine that holds the repository takes it within seconds.',
      /**
       * The instruction has to match the options underneath it.
       *
       * "Nothing to do but let it work — or stop it" sat directly above four
       * choices, two of which were conclude and refuse. I added the options and
       * left the sentence that denies them.
       */
      action: stalledFor
        ? 'Conclude it if what came out is enough — nothing is going to arrive on its own. ' +
          'Or stop the run and look at the judging conversation.'
        : evaluateGate(id).ready
          ? 'Let it work, or take the decision yourself now — the criterion is already met.'
          : 'Nothing to do but let it work — or stop it, which finishes the turn it is in.',
      from: 'running',
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

  /**
   * Never attempted: everything the gate says about it is technically true and
   * humanly wrong.
   *
   * "Nothing new has been produced to judge", "run it AGAIN", "the attempts
   * already made stop counting" — on a step nobody has started, all three
   * describe a history that does not exist, and the reader reasonably concludes
   * the tool is confused. The gate is answering "can it conclude?" when the only
   * question here is "has it begun?".
   */
  if (!everRan(db, id)) {
    return {
      tone: 'work',
      headline: 'It has not been started',
      why: '',
      action: 'Start a pass. Nothing has run on it yet, so there is nothing else to weigh.',
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

  /**
   * `no_new_proof` covers two very different walls, and its generic sentence —
   * "run it again to produce something new" — is a lie on one of them. When the
   * measurements are in and only a rendering is missing, running it again
   * produces the same numbers and changes nothing. Name the wall that is
   * actually there.
   */
  if (needsImage(o.id)) {
    return {
      tone: 'work',
      headline: 'It has to be seen, and nothing was attached',
      why: gate.detail ?? '',
      action:
        'Ask the next pass for a rendering — or, if this criterion settles on files and ' +
        'numbers alone, say so: the option below records it and the rule stops applying here.',
    }
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

/**
 * What can be DONE right now, as things to choose between.
 *
 * The screens stated facts — what is in the way, what waits on you, how far each
 * chapter is — all true, none of them an action. The one place that spoke in
 * options was an AI analysis, and only when it happened to produce them; that
 * form was the only one anybody found readable, and it was a special case.
 *
 * So it becomes the form. Every state answers the same question with the same
 * shape: two to four things you could do, each with what it costs you. Ranked,
 * because ranking them is the judgement the tool already makes everywhere else,
 * and a reader should not have to redo it.
 *
 * `price` is not decoration. An option with no cost is a preference, and a list
 * of preferences is what a screen full of buttons already was.
 */
export function choices(objectiveId) {
  const db = base()
  const o = db
    .prepare(
      `SELECT o.*, p.slug, p.name project_name, p.gate_judge FROM objectives o
       JOIN projects p ON p.id = o.project_id WHERE o.id = ?`,
    )
    .get(objectiveId)
  if (!o) return []

  const step = nextStepForObjective(objectiveId)
  const out = []

  // Whatever the state, these two are almost always available and almost always
  // wrong to hide: a criterion can be rewritten, and work can be set aside.
  /**
   * The price of rewriting is what it throws away, and on a step nobody has
   * started it throws nothing away. Quoting attempts that were never made is the
   * kind of sentence that makes a reader distrust every other one on the page.
   */
  const tried = everRan(db, objectiveId)
  const rewrite = {
    kind: 'criterion',
    label: tried ? 'Change what would prove it' : 'Word it differently before starting',
    price: tried
      ? 'The attempts already made were measured against the old wording; they stop counting.'
      : 'Nothing is lost — nothing has run against this wording yet.',
    href: `/p/${o.slug}/plan`,
  }
  const drop = {
    kind: 'abandon',
    label: 'Set it aside',
    price: 'It stops being counted and nothing runs on it. What it proved is kept.',
    href: `/o/${o.id}`,
  }

  if (step?.from === 'running') {
    const out = [
      { kind: 'wait', label: 'Let it work', price: 'Nothing to do. It reports when the turn ends.', href: `/o/${o.id}` },
      { kind: 'stop', label: 'Stop it', price: 'It finishes the turn it is in; that turn is paid for either way.', href: `/o/${o.id}` },
    ]

    /**
     * A pass running does not take the decision away from you.
     *
     * These two were the ONLY options while anything was live, and the page
     * hides the verdict buttons as soon as options exist — so an objective whose
     * criterion was fully met, waiting on a judging conversation that had been
     * silent for two hours, offered no way whatsoever to conclude it. The only
     * advice on screen was to wait for something that was not coming.
     */
    if (evaluateGate(objectiveId).ready) {
      out.push({
        kind: 'accept',
        label: 'Conclude it now',
        price: 'You are accepting what came out, without waiting for the conversation. The pass keeps its turn.',
        href: `/o/${o.id}`,
      })
      out.push({
        kind: 'reject',
        label: 'Refuse it',
        price: 'It goes back to work, and the next pass has to produce something new.',
        href: `/o/${o.id}`,
      })
    }
    return out
  }

  if (step?.from === 'halt') {
    out.push({
      kind: 'clear',
      label: 'Clear the halt',
      price: 'You are saying it is dealt with. Nothing runs until you start a pass.',
      href: `/o/${o.id}`,
    })
    out.push(rewrite, drop)
    return out
  }

  if (step?.tone === 'blocked') {
    out.push({
      kind: 'unblock',
      label: step.headline,
      price: 'Until this is cleared, every pass on this project bills and produces nothing.',
      href: `/p/${o.slug}`,
    })
    return out
  }

  /**
   * Nothing is left to choose on something already accepted.
   *
   * The gate still reads `ok` after a verdict — of course it does, that is why
   * the verdict could be cast — so the page went on offering "Conclude it" and
   * "Refuse it" under a banner saying it was finished. What comes next is the
   * next step of the chapter, and it has its own place further down.
   */
  if (o.status === 'proven') return []

  const gate = evaluateGate(objectiveId)

  if (gate.ok) {
    out.push({
      kind: 'accept',
      label: 'Conclude it',
      price: 'You are accepting what came out. The chapter closes on it.',
      href: `/o/${o.id}`,
    })
    out.push({
      kind: 'reject',
      label: 'Refuse it',
      price: 'It goes back to work, and the next pass has to produce something new.',
      href: `/o/${o.id}`,
    })
    return out
  }

  if (!o.proof_spec?.trim()) {
    out.push({
      kind: 'criterion',
      label: 'Write what would prove it',
      price: 'Until it exists, no agent can take this — whatever its priority.',
      href: `/p/${o.slug}/plan`,
    })
    out.push({
      kind: 'ask',
      label: 'Ask what it should say',
      price: 'A short session, and it may answer that nothing here can measure this.',
      href: `/o/${o.id}`,
    })
    out.push(drop)
    return out
  }

  /**
   * The gate is holding out for an image. Two ways forward, and they are not the
   * same act: produce the rendering it wants, or state that this criterion never
   * asked for one. The second is offered here rather than left to a config file,
   * because the person who can tell the difference is the one reading this page.
   */
  if (needsImage(objectiveId)) {
    out.push({
      kind: 'image',
      label: 'Attach what it should show',
      price: 'A rendering or a screenshot. Until one is attached, no verdict here judges the work.',
      href: `/o/${o.id}`,
    })
    out.push({
      kind: 'waive_visual',
      label: 'This criterion does not require seeing',
      price:
        'Recorded as a decision, dated, on this objective alone. The rule keeps applying everywhere ' +
        'else. If the criterion did ask to be looked at, nothing will catch it after this.',
      href: `/o/${o.id}`,
    })
  }

  /**
   * Past three attempts, "start a pass" stops being a neutral offer, and its
   * price says so — with the count rather than with an adjective. This sentence
   * used to be a paragraph of its own further down the page; it belongs to the
   * option it qualifies.
   */
  const history = db
    .prepare(
      `SELECT COUNT(*) n,
              (SELECT COUNT(*) FROM evidences WHERE objective_id = ? AND verdict = 'pass') settled
       FROM passages WHERE objective_id = ?`,
    )
    .get(objectiveId, objectiveId)

  const start = canStart(objectiveId)
  if (start.ok) {
    out.push({
      kind: 'run',
      label: 'Start a pass',
      price:
        history.n >= 3
          ? `A session, billed — and it repeats the ${history.n} already made (${history.settled} settled by ` +
            'a verdict) unless what you ask for changes.'
          : 'A session, billed. What you tell it is the whole of what it will try.',
      href: `/o/${o.id}`,
    })
  }

  // Asking what to do belongs wherever things are not converging, not only where
  // a criterion is missing: three attempts in, it is often the useful one.
  if (history.n >= 3) {
    out.push({
      kind: 'ask',
      label: 'Ask what to do about it',
      price: 'A short session that reads its history. It may answer that nothing here can measure this.',
      href: `/o/${o.id}`,
    })
  }

  out.push(rewrite, drop)
  return out
}
