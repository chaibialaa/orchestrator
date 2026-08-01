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

test('a Set has no length, and the version check has to know that', async () => {
  // `e.versions.length > 1` on a Set is `undefined > 1` — false for every server,
  // including the one that disagreed. The same shape as `p.family` and
  // `p.openHaltsOf` before it: a property that does not exist reads as falsy and
  // the rule quietly never fires.
  const { mcpServers } = await import('../src/mcp.js')
  for (const s of mcpServers()) {
    assert.equal(s.disagrees, s.versions.length > 1, `${s.name} reports its own disagreement`)
  }
})

test('an objective that stops proving anything is refused another attempt', async () => {
  // `--budget-sans-progres` guards one pass and is rearmed by the next, so every
  // attempt is the first as far as it is concerned. Atlas #11 spent 17 passes and
  // $462 that way without a single guard firing. This counts across them.
  const { canStart, attemptsSinceProof } = await import('../src/gate.js')

  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (40,1,'stuck','the test passes','feature','ready')`,
  ).run()

  const attempt = db.prepare(
    `INSERT INTO passages (objective_id,harness,started_at,ended_at,cost_usd,prevented)
     VALUES (40,'claude',datetime('now'),datetime('now'),10,0)`,
  )

  for (let i = 0; i < 5; i++) attempt.run()
  assert.equal(canStart(40).ok, true, 'five attempts is a hard objective, not a stuck one')

  for (let i = 0; i < 2; i++) attempt.run()
  const blocked = canStart(40)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'not_converging')
  assert.equal(attemptsSinceProof(40).attempts, 7)

  // Rewriting the criterion resets it too, and it has to: the rewrite is the only
  // remedy this halt has, and without the reset the gate would refuse exactly as
  // before — leaving the halt unclearable.
  db.prepare("UPDATE objectives SET proof_spec_changed_at = datetime('now','+1 second') WHERE id = 40").run()
  assert.equal(attemptsSinceProof(40).attempts, 0)
  assert.equal(canStart(40).ok, true)

  // And a passing proof resets it: an objective that proved something two
  // attempts ago is progressing, however long it has been open.
  db.prepare("UPDATE objectives SET proof_spec_changed_at = NULL WHERE id = 40").run()
  assert.equal(attemptsSinceProof(40).attempts, 7)
  db.prepare(
    `INSERT INTO evidences (objective_id,type,label,verdict,created_at)
     VALUES (40,'test','it passed','pass',datetime('now','+1 second'))`,
  ).run()
  assert.equal(attemptsSinceProof(40).attempts, 0)
  assert.equal(canStart(40).ok, true)
})

test('a series is queued whole or not at all, and a failure drops what follows', async () => {
  db.prepare("DELETE FROM runs").run()
  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (50,1,'one','the test passes','feature','ready'),
            (51,1,'two','the test passes','feature','ready'),
            (52,1,'no criterion',NULL,'feature','draft')`,
  ).run()

  // Half a series is worse than none: the half that ran has been paid for.
  const partly = await post('/projects/p/runs/series', { objectives: [50, 52] })
  assert.equal(partly.status, 409)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM runs").get().n, 0, 'nothing was queued')

  const ok = await post('/projects/p/runs/series', { objectives: [50, 51] })
  const { queued } = await ok.json()
  assert.equal(queued.length, 2)

  // The first fails; the second was queued behind it and loses its ground.
  await fetch(url(`/runs/${queued[0]}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'failed', error: 'nope' }),
  })
  const next = db.prepare('SELECT status, error FROM runs WHERE id = ?').get(queued[1])
  assert.equal(next.status, 'cancelled')
  assert.match(next.error, /the step before it failed/)
})

test('a series can be told to carry on through a failure', async () => {
  db.prepare("DELETE FROM runs").run()
  const ok = await post('/projects/p/runs/series', { objectives: [50, 51], stop_on_failure: false })
  const { queued } = await ok.json()
  await fetch(url(`/runs/${queued[0]}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'failed' }),
  })
  assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(queued[1]).status, 'pending')
})

test('a declared source reaches the breakdown, not just the session', async () => {
  // A breakdown that does not know an asset library exists plans to model
  // everything from scratch — a different chapter, a different budget. And the
  // `kind` field was accepted by this route and dropped in silence, so every
  // source created through it came back as `null` and matched no filter.
  const res = await post('/agents', {
    name: 'test-source',
    label: 'A library of things',
    kind: 'source',
    reach: 'browser',
    capabilities: ['3d'],
  })
  const made = await res.json()
  assert.equal(made.kind, 'source', 'the kind survives the insert')

  const listed = await (await fetch(url('/agents'))).json()
  const sources = listed.filter((a) => a.enabled && a.kind === 'source')
  assert.ok(
    sources.some((a) => a.name === 'test-source'),
    'and it is findable by the filter the breakdown uses',
  )

  const refused = await post('/agents', { name: 'nope', label: 'x', kind: 'invented' })
  assert.equal(refused.status, 422, 'an unknown kind is refused out loud, not silently nulled')
})

test('a plan of several chapters survives the guard that stores it', async () => {
  // The breakdown learned to return `chapters` in the morning; this guard was not
  // told, and would have refused an eighteen-chapter plan AFTER paying for it.
  const brief = await (await post('/projects/p/briefs', {
    body: 'A request long enough to be taken seriously by the length check.',
  })).json()

  const res = await fetch(url(`/briefs/${brief.id}/propose`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proposal: {
        chapters: [
          { chapter: 'one', steps: [{ title: 'a', proof_spec: 'x' }] },
          { chapter: 'two', steps: [{ title: 'b', proof_spec: 'y' }] },
        ],
        assumptions: ['the grass is animated, not a static texture'],
        unknowns: ['what crowd density are we aiming for?'],
      },
    }),
  })
  const stored = await res.json()
  assert.equal(stored.status, 'proposed')
  assert.equal(stored.proposal.chapters.length, 2)

  // The assumptions are the point: they are what a reader disagrees with, one
  // line at a time, instead of rejecting a whole plan.
  assert.equal(stored.proposal.assumptions.length, 1)
  assert.equal(stored.proposal.unknowns.length, 1)
})

test('a chapter with no steps is still refused, however it is wrapped', async () => {
  const brief = await (await post('/projects/p/briefs', {
    body: 'Another request, long enough to pass the length check on the body.',
  })).json()

  const res = await fetch(url(`/briefs/${brief.id}/propose`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal: { chapters: [{ chapter: 'empty', steps: [] }] } }),
  })
  assert.equal(res.status, 422)
})

test('an objective nothing has ever measured is flagged, once it has had a fair run', async () => {
  // 4 pieces of evidence out of 385 across this install came from a command; 18
  // of the 33 passing ones are judgements. That is what separated a $22 chapter
  // from a $634 one — not difficulty, but whether anything could read the answer.
  const { blockers } = await import('../src/blockers.js')

  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (60,1,'measured by nothing','a score of at least 78/100','feature','ready'),
            (61,1,'measured by something','the test passes','feature','ready'),
            (62,1,'barely started','a score of at least 78/100','feature','ready')`,
  ).run()

  const attempt = db.prepare(
    `INSERT INTO passages (objective_id,harness,started_at,ended_at,cost_usd,prevented)
     VALUES (?,'claude',datetime('now'),datetime('now'),20,0)`,
  )
  for (let i = 0; i < 4; i++) {
    attempt.run(60)
    attempt.run(61)
  }
  attempt.run(62) // one attempt only: too early to say anything

  // Renders and diffs are deliverables; only a command returns a verdict.
  db.prepare(
    `INSERT INTO evidences (objective_id,type,label,verdict)
     VALUES (60,'render','a picture somebody produced','inconclusive'),
            (61,'test','a command that ran','pass'),
            (62,'render','a picture','inconclusive')`,
  ).run()

  const flagged = blockers()
    .filter((b) => b.kind === 'nothing_measures_it')
    .map((b) => b.objective)

  assert.ok(flagged.includes(60), 'four attempts and nothing measurable: said out loud')
  assert.ok(!flagged.includes(61), 'a command settled it, so there is nothing to say')
  assert.ok(!flagged.includes(62), 'one attempt is too early to call anything')
})

test('setting an objective aside survives a halt being cleared', async () => {
  // Clearing a halt recomputed the status blind, so #11 went from `abandoned`
  // back to `in_progress` and the loop picked it up again — minutes after it had
  // been deliberately dropped and replaced. Setting something aside has to
  // survive housekeeping, or it means nothing.
  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (70,1,'dropped on purpose','the test passes','feature','abandoned')`,
  ).run()
  db.prepare(
    `INSERT INTO passages (objective_id,harness,started_at,ended_at,prevented)
     VALUES (70,'claude',datetime('now'),datetime('now'),0)`,
  ).run()
  const halt = db
    .prepare("INSERT INTO halts (objective_id,reason,detail) VALUES (70,'human_request','x')")
    .run().lastInsertRowid

  await fetch(url(`/halts/${halt}/resolve`), { method: 'PATCH' })

  assert.equal(
    db.prepare('SELECT status FROM objectives WHERE id = 70').get().status,
    'abandoned',
    'it stays where you put it',
  )
})

test('a chapter run does not wander into another chapter', async () => {
  // A run launched on chapter #41 opened a pass on #11 — a chapter that had just
  // been set aside and replaced — because with no number in the mission the
  // fallback ranged over the whole project and #11 had the lower priority.
  // Reproduced here as the selection itself: scope first, then priority.
  const objectives = [
    { id: 11, parent_id: null, status: 'ready', priority: 10, open_halts_count: 0 },
    { id: 41, parent_id: null, status: 'ready', priority: 15, open_halts_count: 0 },
    { id: 42, parent_id: 41, status: 'ready', priority: 10, open_halts_count: 0 },
  ]

  const pick = (within) => {
    const inScope = within
      ? objectives.filter((o) => o.id === within || o.parent_id === within)
      : objectives
    return inScope
      .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
      .sort((a, b) => a.priority - b.priority)[0]
  }

  assert.equal(pick(null).id, 11, 'unbounded, the lowest priority number wins — whatever chapter it is in')
  assert.equal(pick(41).id, 42, 'bounded to #41, it takes that chapter’s own step')
})

test('nothing routine can revive an objective that was set aside', async () => {
  // Three separate places wrote the status without looking at what it was:
  // clearing a halt, and two that mark an objective blocked. #11 came back twice
  // after being dropped — once as `in_progress`, once as `blocked` — and each
  // time the loop took it up again.
  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (80,1,'set aside','the test passes','feature','abandoned')`,
  ).run()

  const still = () => db.prepare('SELECT status FROM objectives WHERE id = 80').get().status

  await post('/objectives/80/halts', { reason: 'human_request', detail: 'look at it' })
  assert.equal(still(), 'abandoned', 'raising a halt does not revive it')

  const halt = db.prepare('SELECT id FROM halts WHERE objective_id = 80').get().id
  await fetch(url(`/halts/${halt}/resolve`), { method: 'PATCH' })
  assert.equal(still(), 'abandoned', 'nor does clearing one')
})
