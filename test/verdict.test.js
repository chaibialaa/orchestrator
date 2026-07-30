import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerdict, parseDirective } from '../src/agent/relay.js'

test('le verdict de tête gagne, pas le motif trouvé le premier', () => {
  // Cas réel : le juge refuse #11 en tête, puis parle de #12 satisfait plus bas.
  const t = `#11 refusé.\n\nLe chapitre ne satisfait pas son gate.\n\nRappel : #12 est validé.`
  assert.deepEqual(parseVerdict(t), { id: 11, decision: 'reject' })
})

test('on peut viser un objectif précis', () => {
  const t = `#11 refusé.\n\nRappel : #12 est validé.`
  assert.deepEqual(parseVerdict(t, { attendu: 12 }), { id: 12, decision: 'accept' })
  assert.equal(parseVerdict(t, { attendu: 99 }), null, 'un verdict sur un autre objectif ne répond pas')
})

test('les deux tournures sont lues', () => {
  assert.deepEqual(parseVerdict('#7 est validé'), { id: 7, decision: 'accept' })
  assert.deepEqual(parseVerdict('validé : #7'), { id: 7, decision: 'accept' })
  assert.deepEqual(parseVerdict('refusé — #7'), { id: 7, decision: 'reject' })
})

test('aucun verdict quand il n’y en a pas', () => {
  assert.equal(parseVerdict('Le chapitre est terminé.'), null)
  assert.equal(parseVerdict(''), null)
  assert.equal(parseVerdict(null), null)
})

test('la mission part mot pour mot, sur plusieurs lignes', () => {
  const t = `Verdict\n\n#15 validé.\n\n@claude:\nAvant toute action, lis :\n- Docs/A.md\n\n1. OBJECTIF\nFaire X.`
  const d = parseDirective(t)
  assert.equal(d.harness, 'claude')
  assert.ok(d.task.startsWith('Avant toute action'))
  assert.ok(d.task.includes('1. OBJECTIF'), 'la mission ne doit pas être tronquée')
})

test('le marqueur explicite prime sur la prose', async () => {
  const { parseVerdict } = await import('../src/agent/relay.js')
  // La prose dit l'inverse du marqueur : c'est le marqueur qui compte.
  const t = `Tout semble satisfait pour #12.\n\n@verdict: #11 refusé\n\nExplications…`
  assert.deepEqual(parseVerdict(t), { id: 11, decision: 'reject', explicite: true })
})

test('le marqueur accepte les deux ordres', async () => {
  const { parseVerdict } = await import('../src/agent/relay.js')
  assert.deepEqual(parseVerdict('@verdict validé #16'), { id: 16, decision: 'accept', explicite: true })
  assert.deepEqual(parseVerdict('@verdict: 16 refusé'), { id: 16, decision: 'reject', explicite: true })
})

test('un marqueur sur un autre objectif ne répond pas à la question posée', async () => {
  const { parseVerdict } = await import('../src/agent/relay.js')
  assert.equal(parseVerdict('@verdict: #12 validé', { attendu: 11 }), null)
})

test('la fin se déclare, elle ne se devine pas', async () => {
  const { parseFini } = await import('../src/agent/relay.js')
  assert.equal(parseFini('Le chapitre est terminé.'), null, 'sans marqueur, on ne devine pas')
  assert.deepEqual(parseFini('@fini: #16 plus rien à produire'), {
    id: 16,
    raison: 'plus rien à produire',
  })
})
