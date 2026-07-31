/**
 * Every word a person reads. The data model keeps its technical terms; the
 * screen speaks plainly — a status is what it means to you, not what the column
 * is called.
 */

export const statusLabel: Record<string, string> = {
  draft: 'Needs a criterion',
  ready: 'Ready to start',
  in_progress: 'In progress',
  blocked: 'Waiting on you',
  proven: 'Done and verified',
  abandoned: 'Dropped',
}

export const statusHelp: Record<string, string> = {
  draft: "Nobody has said yet how we'd know this is done. No agent can take it.",
  ready: 'The goal and the check are clear. An agent can pick this up.',
  in_progress: 'An agent took it on. The dot tells you whether one is working on it right now.',
  blocked: 'The tool stopped on purpose and is waiting for you to decide.',
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
  error: 'Technical error',
}

export const haltHelp: Record<string, string> = {
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
