/**
 * Every word a person reads. The data model keeps its technical terms; the
 * screen speaks plainly — a status is what it means to you, not what the column
 * is called.
 */

export const statusLabel: Record<string, string> = {
  draft: 'Needs a criterion',
  ready: 'Ready to start',
  in_progress: 'In progress',
  // Not "waiting on you": `blocked` covers halts the loop clears by itself —
  // a rejected verdict is an instruction to redo, not a question. Two screens
  // disagreed out loud, one showing "Waiting on you" and the other "0 of them
  // waiting on you", and the second was right. The halt says who is waited on.
  blocked: 'Stopped',
  proven: 'Done and verified',
  abandoned: 'Dropped',
}

export const statusHelp: Record<string, string> = {
  draft: "Nobody has said yet how we'd know this is done. No agent can take it.",
  ready: 'The goal and the check are clear. An agent can pick this up.',
  in_progress: 'An agent took it on. The dot tells you whether one is working on it right now.',
  blocked: 'The tool stopped on purpose. Whether it needs you depends on why — the halt says so.',
  proven: 'It is done, and the proof was produced and accepted.',
  abandoned: 'Set aside for good.',
}

export const blastLabel: Record<string, string> = {
  cosmetic: 'No risk',
  feature: 'Limited risk',
  api: 'Touches data',
  critical: 'Critical',
}

export const blastHelp: Record<string, string> = {
  cosmetic: 'Visual or convenience. If it comes out wrong you see it and redo it — the agent runs alone.',
  feature: 'A visible feature. One check in the real screen is enough — the agent runs alone.',
  api: 'Data or a shared interface. A human read is required before concluding.',
  critical:
    'Money, payroll, production. No autonomy: proof from the real world and your approval are both required.',
}

export const harnessLabel: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gpt: 'GPT',
  human: 'You',
}

export const verdictLabel: Record<string, string> = {
  advanced: 'Moved it forward',
  no_progress: 'Demonstrated nothing',
  halted: 'Stopped',
  failed: 'Failed',
}

export const evidenceLabel: Record<string, string> = {
  test: 'Automated test',
  e2e: 'Real run through the screen',
  screenshot: 'Screenshot',
  render: 'Rendered image',
  diff: 'Review of the changed code',
  invariant: 'Measurement on production',
  manual: 'Checked by hand',
}

export const evidenceVerdictLabel: Record<string, string> = {
  pass: 'passing',
  fail: 'failing',
  inconclusive: 'inconclusive',
}

export const haltLabel: Record<string, string> = {
  no_provable_criterion: 'No way to verify it',
  blast_radius: 'Too risky to decide alone',
  piege_rule: 'A project rule was broken',
  invariant_regression: 'A production measurement degraded',
  no_new_proof: 'Several attempts, nothing demonstrated',
  budget: 'Budget reached',
  human_request: 'You asked it to stop',
  verdict_rejected: 'Rejected at verdict, to be redone',
  children_open: 'Sub-objectives are still open',
  // Added when the halt was, and forgotten here: the analysis page printed the
  // raw keys `not_converging` and `judge_conversation_full` among nine phrases
  // written for a person. A label table with a hole shows the hole.
  not_converging: 'It stopped getting anywhere',
  judge_conversation_full: 'The judging conversation is full',
  error: 'Technical error',
}

export const haltHelp: Record<string, string> = {
  not_converging:
    'Attempt after attempt, and not one produced a passing proof. This is not a hard objective ' +
    'having a bad run — it is the same attempt being billed again. What has to change is the ' +
    'criterion or the approach, and only you can decide which.',
  judge_conversation_full:
    'The driving conversation has grown past what it can carry. Every turn re-reads the whole ' +
    'thread, so it is now slower, dearer, and losing the rules it was given at the top. A fresh ' +
    'one takes over from here.',
  no_provable_criterion:
    "Nobody could say what would prove this is finished. That means the request is still too vague — sharpen it and the tool starts again.",
  blast_radius:
    'The change touches a sensitive area. The tool prepared the work but refuses to conclude without you.',
  piege_rule:
    'The code breaks a rule we set after a past incident. The tool would rather stop than work around it.',
  invariant_regression:
    'A measurement taken on the live site went out of bounds. Work is suspended — something just broke for real.',
  no_new_proof:
    'Attempt after attempt demonstrated nothing. Continuing would cost without adding anything: usually the sign to change approach, not to push harder.',
  budget: 'The spending limit set for this objective was reached. It is your call whether to continue.',
  human_request: 'Stop requested explicitly.',
  verdict_rejected:
    "The project's judge looked at the work and turned it down. That is not a blocker: it is an instruction to redo, with the reason attached.",
  children_open:
    'A chapter does not conclude before its parts. The sub-objectives still open have to be dealt with first.',
  error: 'Something crashed inside the tool. Worth a look before relaunching.',
}

export function formatTokens(n: number | null | undefined): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} k`
  return `${(n / 1_000_000).toFixed(2)} M`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Why a run ended. `status` says whether it stopped, not whether it got
 * anywhere: five runs out of ten on 2 August ended `done` on a defect of the
 * tool, and the screen showed the same word as for a chapter that closed.
 */
export const outcomeLabel: Record<string, string> = {
  chapter_closed: 'chapter closed',
  steps_done_awaiting_verdict: 'steps done, verdict awaited',
  declared_done: 'closed by the judge',
  needs_you: 'needs you',
  judge_silent: 'the judge stopped answering',
  judge_conversation_full: 'the conversation was full',
  no_progress_budget: 'spent its budget without proving anything',
  no_unity_editor: 'no Unity editor',
  cancelled_from_screen: 'stopped from the screen',
  read_only: 'read only, nothing ran',
  out_of_turns: 'ran out of turns',
}

/** Outcomes that mean nobody got anywhere — worth colouring, not just printing. */
export const outcomeWorrying = [
  'judge_silent',
  'judge_conversation_full',
  'no_progress_budget',
  'no_unity_editor',
  'out_of_turns',
]
