import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerdict, parseDirective } from '../src/agent/relay.js'

test('the leading verdict wins, not the first pattern found', () => {
  // A real case: the judge rejects #11 up top, then mentions #12 satisfied lower
  // down. The inputs below stay in French on purpose — the parser reads real
  // conversations, and those are written in French.
  const t = `#11 refusé.\n\nLe chapitre ne satisfait pas son gate.\n\nRappel : #12 est validé.`
  assert.deepEqual(parseVerdict(t), { id: 11, decision: 'reject' })
})

test('a specific objective can be targeted', () => {
  const t = `#11 refusé.\n\nRappel : #12 est validé.`
  assert.deepEqual(parseVerdict(t, { expected: 12 }), { id: 12, decision: 'accept' })
  assert.equal(parseVerdict(t, { expected: 99 }), null, 'a verdict on another objective is not an answer')
})

test('both phrasings are read', () => {
  assert.deepEqual(parseVerdict('#7 est validé'), { id: 7, decision: 'accept' })
  assert.deepEqual(parseVerdict('validé : #7'), { id: 7, decision: 'accept' })
  assert.deepEqual(parseVerdict('refusé — #7'), { id: 7, decision: 'reject' })
})

test('no verdict when there is none', () => {
  assert.equal(parseVerdict('Le chapitre est terminé.'), null)
  assert.equal(parseVerdict(''), null)
  assert.equal(parseVerdict(null), null)
})

test('the mission goes out verbatim, across many lines', () => {
  const t = `Verdict\n\n#15 validé.\n\n@claude:\nAvant toute action, lis :\n- Docs/A.md\n\n1. OBJECTIF\nFaire X.`
  const d = parseDirective(t)
  assert.equal(d.harness, 'claude')
  assert.ok(d.task.startsWith('Avant toute action'))
  assert.ok(d.task.includes('1. OBJECTIF'), 'the mission must not be truncated')
})

test('the explicit marker beats the prose', async () => {
  const { parseVerdict } = await import('../src/agent/relay.js')
  // La prose dit l'inverse du marqueur : c'est le marqueur qui compte.
  const t = `Tout semble satisfait pour #12.\n\n@verdict: #11 refusé\n\nExplications…`
  assert.deepEqual(parseVerdict(t), { id: 11, decision: 'reject', explicite: true })
})

test('the marker accepts either order', async () => {
  const { parseVerdict } = await import('../src/agent/relay.js')
  assert.deepEqual(parseVerdict('@verdict validé #16'), { id: 16, decision: 'accept', explicite: true })
  assert.deepEqual(parseVerdict('@verdict: 16 refusé'), { id: 16, decision: 'reject', explicite: true })
})

test('a marker on another objective does not answer the question asked', async () => {
  const { parseVerdict } = await import('../src/agent/relay.js')
  assert.equal(parseVerdict('@verdict: #12 validé', { expected: 11 }), null)
})

test('the end is declared, never guessed', async () => {
  const { parseDone } = await import('../src/agent/relay.js')
  assert.equal(parseDone('Le chapitre est terminé.'), null, 'with no marker, we do not guess')
  assert.deepEqual(parseDone('@fini: #16 plus rien à produire'), {
    id: 16,
    reason: 'plus rien à produire',
  })
})

// Cases the mass rename broke once without a single test noticing: the French
// verdict vocabulary is DATA the parser matches, and one word lost its "n".
test('the whole French verdict vocabulary is matched', () => {
  for (const w of ['validé', 'valide', 'accepté', 'conforme', 'atteint', 'satisfait']) {
    assert.equal(parseVerdict(`#5 ${w}`)?.decision, 'accept', `« ${w} » should accept`)
  }
  for (const w of ['refusé', 'refuse', 'rejeté', 'insuffisant', 'non conforme']) {
    assert.equal(parseVerdict(`#5 ${w}`)?.decision, 'reject', `« ${w} » should reject`)
  }
})

// From the switch to English on: the judge is addressed in English, but the
// conversations opened before it are French and keep their history. A parser that
// spoke only one of the two would misread half of them.
test('the English verdict vocabulary is matched too', () => {
  for (const w of ['validated', 'accepted', 'approved', 'satisfied', 'met', 'passes']) {
    assert.equal(parseVerdict(`#5 ${w}`)?.decision, 'accept', `“${w}” should accept`)
  }
  for (const w of ['refused', 'rejected', 'insufficient', 'not met', 'not satisfied', 'fails']) {
    assert.equal(parseVerdict(`#5 ${w}`)?.decision, 'reject', `“${w}” should reject`)
  }
})

test('a negated acceptance is not an acceptance', () => {
  assert.equal(parseVerdict('#5 not accepted')?.decision, 'reject')
  assert.equal(parseVerdict('#5 never satisfied')?.decision, 'reject')
})

test('the explicit marker reads English too', () => {
  assert.deepEqual(parseVerdict('@verdict: #16 rejected'), { id: 16, decision: 'reject', explicite: true })
  assert.deepEqual(parseVerdict('@verdict: #16 approved'), { id: 16, decision: 'accept', explicite: true })
})
