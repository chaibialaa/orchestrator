import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ORCHESTRATOR_DB = join(mkdtempSync(join(tmpdir(), 'orch-')), 'test.db')

const { base } = await import('../src/db/index.js')
const { startServer } = await import('../src/server.js')

const db = base()
db.prepare("INSERT INTO projects (id,slug,name,gate_judge) VALUES (1,'p','P','gpt')").run()
db.prepare(
  `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
   VALUES (9,1,'o','the test passes','feature','ready')`,
).run()

const { serveur } = await startServer(0)
// `startServer` echoes back the port it was asked for; 0 means "any", so the one
// that matters is the one the socket actually bound.
const port = serveur.address().port
const url = (p) => `http://127.0.0.1:${port}/api${p}`
const post = (p, body) =>
  fetch(url(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test('a chapter run without an objective is refused at the door', async () => {
  // It used to be accepted, queued, claimed, and only then fail — in a worker log,
  // on a usage message nobody was reading.
  const res = await post('/projects/p/runs', { mode: 'chapter' })
  assert.equal(res.status, 422) // `Rejected` means "understood, and refused"
  assert.match((await res.json()).message, /needs an objective/)
})

test('the objective can be named either way', async () => {
  // The column is `objective_id`, the field was `objective`. Both are the caller
  // being right; only one used to work.
  const res = await post('/projects/p/runs', { mode: 'chapter', objective_id: 9 })
  assert.equal((await res.json()).objective_id, 9)
})

test('a run put in front is taken before what was already waiting', async () => {
  // Nothing is interrupted: this only changes which pending run is claimed next.
  db.prepare("DELETE FROM runs WHERE status = 'pending'").run()
  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (20,1,'first','x','feature','ready'), (21,1,'urgent','x','feature','ready')`,
  ).run()

  // `alongside` because both are deliberately queued on one repository — which the
  // guard below refuses by default.
  await post('/projects/p/runs', { mode: 'chapter', objective: 20, alongside: true })
  await post('/projects/p/runs', {
    mode: 'chapter',
    objective: 21,
    jump: true,
    alongside: true,
    reason: 'it broke the scene',
  })

  const claimed = await (await post('/projects/p/runs/claim', { machine: 'm', pid: 1 })).json()
  assert.equal(claimed.run.objective_id, 21)
  assert.equal(claimed.run.reason, 'it broke the scene')

  const next = await (await post('/projects/p/runs/claim', { machine: 'm', pid: 1 })).json()
  assert.equal(next.run.objective_id, 20) // the one it jumped is not lost, only later
})

test('a second pass on the same repository is refused, and can be forced', async () => {
  // Two agents in one checkout overwrite each other's edits, and each one's
  // `git status` charges it for what the other left lying around.
  db.prepare("DELETE FROM runs WHERE status IN ('pending','running')").run()
  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (30,1,'a','x','feature','ready'), (31,1,'b','x','feature','ready')`,
  ).run()

  await post('/projects/p/runs', { mode: 'chapter', objective: 30 })

  const refused = await post('/projects/p/runs', { mode: 'chapter', objective: 31 })
  assert.equal(refused.status, 422)
  assert.match((await refused.json()).message, /already working this repository/)

  const forced = await post('/projects/p/runs', { mode: 'chapter', objective: 31, alongside: true })
  assert.equal((await forced.json()).alongside, true)
})

test('releasing frees only the runs named, never a neighbour', async () => {
  // Two workers share this machine. Releasing every run on the machine had a
  // starting worker killing its neighbour's live pass.
  const mine = db
    .prepare(
      `INSERT INTO runs (project_id,objective_id,mode,status,machine,pid) VALUES (1,9,'chapter','running','m',111)`,
    )
    .run().lastInsertRowid
  const neighbour = db
    .prepare(
      `INSERT INTO runs (project_id,objective_id,mode,status,machine,pid) VALUES (1,9,'chapter','running','m',222)`,
    )
    .run().lastInsertRowid

  const res = await post('/runs/release', { machine: 'm', ids: [mine] })
  assert.deepEqual((await res.json()).released, [Number(mine)])

  const status = (id) => db.prepare('SELECT status FROM runs WHERE id = ?').get(id).status
  assert.equal(status(mine), 'failed')
  assert.equal(status(neighbour), 'running')
})

test('releasing nothing releases nothing', async () => {
  const res = await post('/runs/release', { machine: 'm', ids: [] })
  assert.deepEqual((await res.json()).released, [])
})

test('a refusal throws instead of killing the process', async () => {
  // `fail` called `process.exit`, which no `try` can catch — so the worker's catch
  // block, written so one bad run would not take the worker with it, never ran.
  const { Refusal } = await import('../src/agent/commands.js')
  const boom = () => {
    throw new Refusal('nope')
  }
  assert.throws(boom, Refusal)
})

test.after(() => serveur.close())

test('the unseeded-tools rule actually fires', async () => {
  // It filtered on a column no query selected, so `undefined > 0` was false and
  // the rule never fired — including the day a project ran on 4 of its 60 tools.
  const { blockers } = await import('../src/blockers.js')
  const kinds = blockers()
    .filter((b) => b.project === 'p')
    .map((b) => b.kind)
  assert.ok(kinds.includes('permissions_unseeded'), 'a project with open work and no tools is blocked')
  // Codex is not blocked by an empty list — it is never handed one. What is worth
  // saying is that the rules displayed for it hold nothing back.
  assert.ok(!kinds.includes('codex_no_tools'))
})
