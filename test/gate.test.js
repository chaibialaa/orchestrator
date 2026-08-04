import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ORCHESTRATOR_DB = join(mkdtempSync(join(tmpdir(), 'orch-')), 'test.db')

const { base } = await import('../src/db/index.js')
const { evaluateGate, canStart, isStalling, requiresVisual } = await import('../src/gate.js')

const db = base()
db.prepare("INSERT INTO projects (id,slug,name,gate_judge) VALUES (1,'p','P','gpt')").run()

let n = 0
function objectif(champs = {}) {
  const id = ++n + 100
  db.prepare(
    `INSERT INTO objectives (id,project_id,parent_id,title,proof_spec,blast_radius,status)
     VALUES (@id,1,@parent_id,@title,@proof_spec,@blast_radius,'ready')`,
  ).run({
    id,
    parent_id: null,
    title: 'o' + id,
    proof_spec: 'le test passe',
    blast_radius: 'feature',
    ...champs,
  })
  return id
}

/** Un verdict est TOUJOURS de type `manual` : c'est ce qui le distingue du travail. */
const verdict = (oid, par = 'gpt') =>
  preuve(oid, { type: 'manual', payload: JSON.stringify({ judged_by: par }) })

const preuve = (oid, champs = {}) =>
  db
    .prepare(
      `INSERT INTO evidences (objective_id,passage_id,type,label,verdict,payload)
       VALUES (@oid,@passage_id,@type,'l',@verdict,@payload)`,
    )
    .run({ oid, passage_id: null, type: 'test', verdict: 'pass', payload: null, ...champs })

test('with no criterion, nothing can conclude or start', () => {
  const o = objectif({ proof_spec: null })
  assert.equal(evaluateGate(o).reason, 'no_provable_criterion')
  assert.equal(canStart(o).reason, 'no_provable_criterion')
})

test('un chapitre ne conclut pas avant ses parties', () => {
  const chap = objectif()
  objectif({ parent_id: chap })
  verdict(chap)
  assert.equal(evaluateGate(chap).reason, 'children_open')
})

test('sans preuve pass, il manque une preuve — pas un verdict', () => {
  const o = objectif()
  assert.equal(evaluateGate(o).reason, 'no_new_proof')
})

test('a visual criterion refuses to conclude without an image', () => {
  const o = objectif({ proof_spec: 'une capture par format montre le plan A' })
  // A proof of work FIRST, so the only thing missing is the image. Without it
  // this objective has two defects at once and the gate refuses on the deeper
  // one — that the verdict is the only passing proof — which is correct and is
  // not what this test is about.
  preuve(o, { type: 'test' })
  verdict(o)
  const g = evaluateGate(o)
  assert.equal(g.ok, false)
  assert.match(g.detail, /no image is attached/)

  preuve(o, { type: 'render' })
  assert.equal(evaluateGate(o).ok, true)
})

test('a verdict is not a proof of itself', () => {
  const o = objectif()
  // The judge says yes, and nothing else exists. That single row used to satisfy
  // BOTH conditions this gate believes it checks apart: that a passing proof
  // exists, and that the judge has ruled. Sixteen of eighteen proven objectives
  // on the real install rested on exactly this.
  verdict(o)
  const g = evaluateGate(o)
  assert.equal(g.ok, false)
  assert.equal(g.reason, 'no_new_proof')
  assert.match(g.detail, /IS the verdict/)

  // Something the pass produced, and the same verdict now closes it.
  preuve(o, { type: 'test' })
  assert.equal(evaluateGate(o).ok, true)
})

test('a high blast radius requires proof from the real world', () => {
  const o = objectif({ blast_radius: 'critical' })
  preuve(o, { type: 'test' })
  verdict(o)
  assert.equal(evaluateGate(o).reason, 'blast_radius')
  preuve(o, { type: 'e2e' })
  assert.equal(evaluateGate(o).ok, true)
})

test('everything is here but the judge has not spoken: ready, not failed', () => {
  const o = objectif()
  preuve(o)
  const g = evaluateGate(o)
  assert.equal(g.ok, false)
  assert.equal(g.reason, 'awaiting_verdict')
  assert.equal(g.ready, true, 'an objective awaiting a verdict is READY, not failed')
})

test('an open halt prevents concluding', () => {
  const o = objectif()
  preuve(o, { type: 'test' })
  verdict(o)
  assert.equal(evaluateGate(o).ok, true)
  db.prepare("INSERT INTO halts (objective_id,reason) VALUES (?,'human_request')").run(o)
  assert.equal(evaluateGate(o).ok, false)
})

test('an absorbable halt does not block starting', () => {
  const o = objectif()
  db.prepare("INSERT INTO halts (objective_id,reason) VALUES (?,'no_new_proof')").run(o)
  assert.equal(canStart(o).ok, true, 'the loop clears this reason itself')
  db.prepare("INSERT INTO halts (objective_id,reason) VALUES (?,'blast_radius')").run(o)
  assert.equal(canStart(o).ok, false)
})

test('a prevented attempt does not count as stalling', () => {
  const o = objectif()
  const p = (prevented) =>
    db
      .prepare(
        "INSERT INTO passages (objective_id,harness,ended_at,prevented) VALUES (?,'claude',datetime('now'),?)",
      )
      .run(o, prevented)
  p(1)
  p(1)
  assert.equal(isStalling(o), false, 'two prevented attempts are not two failures')
  p(0)
  p(0)
  assert.equal(isStalling(o), true)
})

test('visual detection', () => {
  assert.ok(requiresVisual('une capture par format'))
  assert.ok(requiresVisual('Ruiz reste lisible'))
  assert.ok(requiresVisual('le plan C est crédible'))
  assert.equal(requiresVisual('php artisan test passe au vert'), false)
})

test('une levée nommée dispense de l’image, sur ce seul objectif', () => {
  // Le critère parle de captures parce qu'elles sont son SUJET : il demande un
  // décompte, pas un regard. La règle se déclenche quand même — c'est ce que la
  // levée corrige, sans toucher à la règle.
  const spec = 'baseline.csv compte les 18 captures du corpus, une ligne par fichier'
  const o = objectif({ proof_spec: spec })
  const autre = objectif({ proof_spec: spec })
  preuve(o, { type: 'test' })
  preuve(autre, { type: 'test' })
  verdict(o)
  verdict(autre)

  assert.equal(evaluateGate(o).ok, false, 'sans levée, la porte réclame une image')
  assert.match(evaluateGate(o).detail, /asks to see something/)

  db.prepare(
    "INSERT INTO decisions (project_id,objective_id,title,body,waives) VALUES (1,?,'t','il ne demande à personne de regarder','visual_proof')",
  ).run(o)

  assert.equal(evaluateGate(o).ok, true, 'levée : il conclut sur ce qu’il a mesuré')
  assert.equal(evaluateGate(autre).ok, false, 'et le voisin, au critère identique, reste tenu')

  // Une levée qui ne nomme pas la bonne règle ne lève rien.
  const tiers = objectif({ proof_spec: spec })
  preuve(tiers, { type: 'test' })
  verdict(tiers)
  db.prepare(
    "INSERT INTO decisions (project_id,objective_id,title,body,waives) VALUES (1,?,'t','x','blast_radius')",
  ).run(tiers)
  assert.equal(evaluateGate(tiers).ok, false)
})

test('un refus suivi d’une acceptation ne conclut pas sans preuve neuve', () => {
  const o = objectif()
  preuve(o, { type: 'test' })
  verdict(o)
  assert.equal(evaluateGate(o).ok, true, 'to begin with, it could conclude')

  // The judge takes it back…
  const mark = db.prepare('SELECT COALESCE(MAX(id),0) m FROM evidences WHERE objective_id = ?').get(o).m
  db.prepare("INSERT INTO halts (objective_id,reason,evidence_mark,resolved_at) VALUES (?,'verdict_rejected',?,datetime('now'))").run(o, mark)
  assert.equal(evaluateGate(o).ok, false, 'after a rejection, it no longer concludes')

  // …then changes its mind with nothing produced in between: refused.
  verdict(o)
  const g = evaluateGate(o)
  assert.equal(g.ok, false)
  assert.match(g.detail, /change on something new/)

  // A real proof lands: now it can conclude.
  preuve(o, { type: 'render' })
  assert.equal(evaluateGate(o).ok, true)
})
