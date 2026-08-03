import { base } from './db/index.js'
import { evaluateGate, HUMAN_HALTS } from './gate.js'
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
      why: 'A measurement that used to hold no longer does.',
      action: 'Look at what broke it before starting anything else on this project.',
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
