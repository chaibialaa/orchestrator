import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ORCHESTRATOR_DB = join(mkdtempSync(join(tmpdir(), 'orch-')), 'test.db')

const { base } = await import('../src/db/index.js')
const { evaluer, peutDemarrer, pietine, exigeDuVisuel } = await import('../src/gate.js')

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

test('sans critère, rien ne peut conclure ni démarrer', () => {
  const o = objectif({ proof_spec: null })
  assert.equal(evaluer(o).reason, 'no_provable_criterion')
  assert.equal(peutDemarrer(o).reason, 'no_provable_criterion')
})

test('un chapitre ne conclut pas avant ses parties', () => {
  const chap = objectif()
  objectif({ parent_id: chap })
  verdict(chap)
  assert.equal(evaluer(chap).reason, 'children_open')
})

test('sans preuve pass, il manque une preuve — pas un verdict', () => {
  const o = objectif()
  assert.equal(evaluer(o).reason, 'no_new_proof')
})

test('un critère visuel refuse de conclure sans image', () => {
  const o = objectif({ proof_spec: 'une capture par format montre le plan A' })
  verdict(o)
  const g = evaluer(o)
  assert.equal(g.ok, false)
  assert.match(g.detail, /aucune image/)

  preuve(o, { type: 'render' })
  assert.equal(evaluer(o).ok, true)
})

test('un rayon de souffle élevé exige une preuve du réel', () => {
  const o = objectif({ blast_radius: 'critical' })
  preuve(o, { type: 'test' })
  verdict(o)
  assert.equal(evaluer(o).reason, 'blast_radius')
  preuve(o, { type: 'e2e' })
  assert.equal(evaluer(o).ok, true)
})

test('tout est là mais le juge n’a pas parlé : prêt, pas échoué', () => {
  const o = objectif()
  preuve(o)
  const g = evaluer(o)
  assert.equal(g.ok, false)
  assert.equal(g.reason, 'awaiting_verdict')
  assert.equal(g.ready, true, 'un objectif qui attend un verdict est PRÊT, pas en échec')
})

test('un arrêt ouvert empêche de conclure', () => {
  const o = objectif()
  preuve(o, { type: 'test' })
  verdict(o)
  assert.equal(evaluer(o).ok, true)
  db.prepare("INSERT INTO halts (objective_id,reason) VALUES (?,'human_request')").run(o)
  assert.equal(evaluer(o).ok, false)
})

test('un arrêt absorbable ne bloque pas le démarrage', () => {
  const o = objectif()
  db.prepare("INSERT INTO halts (objective_id,reason) VALUES (?,'no_new_proof')").run(o)
  assert.equal(peutDemarrer(o).ok, true, 'la boucle lève elle-même ce motif')
  db.prepare("INSERT INTO halts (objective_id,reason) VALUES (?,'blast_radius')").run(o)
  assert.equal(peutDemarrer(o).ok, false)
})

test('une tentative empêchée ne compte pas comme un piétinement', () => {
  const o = objectif()
  const p = (prevented) =>
    db
      .prepare(
        "INSERT INTO passages (objective_id,harness,ended_at,prevented) VALUES (?,'claude',datetime('now'),?)",
      )
      .run(o, prevented)
  p(1)
  p(1)
  assert.equal(pietine(o), false, 'deux tentatives empêchées ne sont pas deux échecs')
  p(0)
  p(0)
  assert.equal(pietine(o), true)
})

test('la détection du visuel', () => {
  assert.ok(exigeDuVisuel('une capture par format'))
  assert.ok(exigeDuVisuel('Ruiz reste lisible'))
  assert.ok(exigeDuVisuel('le plan C est crédible'))
  assert.equal(exigeDuVisuel('php artisan test passe au vert'), false)
})

test('un refus suivi d’une acceptation ne conclut pas sans preuve neuve', () => {
  const o = objectif()
  preuve(o, { type: 'test' })
  verdict(o)
  assert.equal(evaluer(o).ok, true, 'départ : il pouvait conclure')

  // Le juge se dédit…
  const marque = db.prepare('SELECT COALESCE(MAX(id),0) m FROM evidences WHERE objective_id = ?').get(o).m
  db.prepare("INSERT INTO halts (objective_id,reason,evidence_mark,resolved_at) VALUES (?,'verdict_rejected',?,datetime('now'))").run(o, marque)
  assert.equal(evaluer(o).ok, false, 'après un refus, il ne conclut plus')

  // …puis se ravise sans que rien n’ait été produit : refusé.
  verdict(o)
  const g = evaluer(o)
  assert.equal(g.ok, false)
  assert.match(g.detail, /changer sur du neuf/)

  // Une preuve réelle arrive : il peut conclure.
  preuve(o, { type: 'render' })
  assert.equal(evaluer(o).ok, true)
})
