import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Codex moved where it writes the model.
 *
 * Older rollouts carry it on `turn_context`; current ones put it in
 * `thread_settings_applied` and leave `turn_context` without it. Reading only
 * the old places found nothing on seventeen passes, no rate could match, and the
 * screen sent someone to declare a price that was already declared and already
 * correct.
 */
const { codexDiagnostics } = await import('../src/agent/commands.js')

function rollout(lignes) {
  const f = join(mkdtempSync(join(tmpdir(), 'codex-')), 'rollout.jsonl')
  writeFileSync(f, lignes.map((l) => JSON.stringify(l)).join('\n'))
  return f
}

const usage = {
  payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2 } } },
}

test('le modèle est lu là où Codex l’écrit AUJOURD’HUI', () => {
  const f = rollout([
    { payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-sol' } } },
    { payload: { type: 'turn_context' } },
    usage,
  ])
  assert.equal(codexDiagnostics(f).model, 'gpt-5.6-sol')
})

test('et là où il l’écrivait AVANT', () => {
  const f = rollout([{ payload: { type: 'turn_context', model: 'gpt-5.3-codex' } }, usage])
  assert.equal(codexDiagnostics(f).model, 'gpt-5.3-codex')
})
