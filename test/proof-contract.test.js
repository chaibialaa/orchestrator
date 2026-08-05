import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Chapter 6 lost six passes because nothing separated the ONE check that fails
 * the gate from the three it merely reports. And over those same six passes the
 * score stayed `9 PASS / 1 FAIL` while the palette distance went from 62.3 to
 * 49.0 — a verdict cannot show that, a distance can.
 */
const { ditParSaSortie } = await import('../src/agent/commands.js')

test('une porte peut dire ce qui bloque, ce qu’elle constate, et sa distance', () => {
  const dit = ditParSaSortie(`
  [FAIL] C06-PALETTE  familles retrouvées : 5/6
BLOCKING C06-PALETTE la 6e famille #E4918A est a 49.0, il faut <= 40
OBSERVED C06-SATURATION saturation 0.128 contre 0.309 au releve #24
PROGRESS palette-distance 49.0 40.0
PROGRESS distinct-colours 423.5 419.5
GATE FAIL
`)
  assert.deepEqual(dit.blocking.map((b) => b.id), ['C06-PALETTE'])
  assert.deepEqual(dit.observed.map((o) => o.id), ['C06-SATURATION'])
  assert.deepEqual(dit.progress, [
    { name: 'palette-distance', value: 49, target: 40 },
    { name: 'distinct-colours', value: 423.5, target: 419.5 },
  ])
})

test('une porte qui ne dit rien se comporte exactement comme avant', () => {
  assert.deepEqual(ditParSaSortie('PASS C1\nPASS C2\n2/2\n'), {})
  assert.deepEqual(ditParSaSortie(''), {})
  assert.deepEqual(ditParSaSortie(null), {})
})

test('la prose qui PARLE de blocage n’est pas lue comme un blocage', () => {
  // Rien n'est reniflé dans le texte : seule une ligne qui commence par le mot
  // compte. Sinon un rapport qui explique ce qui bloque en deviendrait un.
  assert.deepEqual(ditParSaSortie('le controle BLOCKING est celui qui compte'), {})
  assert.deepEqual(ditParSaSortie('PROGRESS is good'), {})
})
