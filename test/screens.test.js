import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

/**
 * The screens, checked against what the API actually sends.
 *
 * Seven of the ten defects fixed on 2026-07-31 were one shape: a property that
 * does not exist, read as falsy, in silence. `p.family` was declared on an
 * interface and sent by nobody, so all 66 permission rules fell into one group
 * headed "undefined 66". `versions.length` on a Set is `undefined > 1`, false
 * for every server including the one that disagreed. `b.kind` was accepted by a
 * route and dropped, so every agent came back null.
 *
 * None of them fails a typecheck: TypeScript believes a declaration, and
 * JavaScript does not object to reading a key that is not there. They were all
 * found by a person looking at a screen — which means the rate does not fall,
 * it just stays invisible while nobody looks.
 *
 * It starts its OWN server on its OWN database. The first version asked whoever
 * ran the tests to have one up, and skipped when they did not — which is how the
 * visual tests sat green and checking nothing for hours after their fixtures
 * were swept. A test that depends on someone else's housekeeping is not a test.
 */

process.env.ORCHESTRATOR_DB = join(mkdtempSync(join(tmpdir(), 'orch-screens-')), 'test.db')

const here = dirname(fileURLToPath(import.meta.url))
const WEB = join(here, '..', 'web', 'src')
const require = createRequire(join(here, '..', 'web', 'package.json'))

const { base } = await import('../src/db/index.js')
const { startServer } = await import('../src/server.js')

/**
 * Enough of everything for each response to carry its real shape.
 *
 * An empty table returns `[]`, every field is trivially "not missing", and the
 * check passes while looking at nothing — the same silence it was written to
 * break. So every endpoint the screens read gets at least one row.
 */
const db = base()
db.prepare("INSERT INTO projects (id,slug,name,repo_path,gate_judge) VALUES (1,'atlas','Atlas','/tmp','gpt')").run()
db.prepare(
  `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
   VALUES (1,1,'a chapter','the test passes','feature','ready')`,
).run()
db.prepare(
  `INSERT INTO permissions (project_id,harness,pattern,label,decision,note)
   VALUES (1,'claude','Bash(ls *)','Core tools','allow','reading only')`,
).run()
db.prepare(
  `INSERT INTO agents (name,label,kind,reach,role,enabled,priority,capabilities)
   VALUES ('claude','Claude','model','cli','executant',1,50,'["code"]')`,
).run()
db.prepare(
  `INSERT INTO runs (project_id,objective_id,mode,status,turn,machine,pid)
   VALUES (1,1,'chapter','running',1,'here',1)`,
).run()
// `tools_used` matters: without it `/wiring` reports no tool surfaces at all, and
// the check on Wiring.vue sees an empty half of the response. Found by this very
// test, on its own fixtures.
db.prepare(
  `INSERT INTO passages (objective_id,harness,started_at,ended_at,cost_usd,tokens,prevented,tools_used)
   VALUES (1,'claude',datetime('now'),datetime('now'),1.5,1000,0,'{"mcp__UnityMCP__manage_scene":3,"Read":7}')`,
).run()

const { serveur } = await startServer(0)
const API = `http://127.0.0.1:${serveur.address().port}/api`

test.after(() => serveur.close())

function vueFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? vueFiles(join(dir, e.name)) : e.name.endsWith('.vue') ? [join(dir, e.name)] : [],
  )
}

/**
 * A `v-else` whose `v-if` sibling is gone is dropped by the compiler without a
 * word — the dashboard counted two things needing a person and displayed
 * neither. The compiler knows; nothing was asking it.
 */
/**
 * A `v-else` with no `v-if` at all before it.
 *
 * Narrower than the bug that prompted it, deliberately. The dashboard defect was
 * a `v-else` whose partner had moved away, so it silently re-attached to the
 * `v-if` that happened to sit before it — valid Vue, compiles clean, and the
 * block then showed only when a button was hidden. I tried to catch that by
 * flagging pairs written far apart, and it fired on a deliberate one in
 * SetupView separated by nothing worse than a comment. A check that cries wolf
 * gets switched off, which is worse than not having it.
 *
 * So this catches only what is unambiguous. The re-attaching case is not
 * detectable by reading the source — both versions are correct code — and is
 * caught by looking at the screen, or by a test on the rendered output. Saying
 * so here is better than a heuristic that pretends otherwise.
 */
function orphanedElse(node, file, found = []) {
  const kids = (node.children ?? []).filter((c) => c.type === 1)
  kids.forEach((child, i) => {
    const isElse = (child.props ?? []).some((p) => p.type === 7 && ['else', 'else-if'].includes(p.name))
    if (isElse) {
      const before = kids[i - 1]
      const paired =
        before && (before.props ?? []).some((p) => p.type === 7 && ['if', 'else-if'].includes(p.name))
      if (!paired) {
        found.push(`${file.replace(WEB, '')}: <${child.tag}> has v-else with no v-if before it`)
      }
    }
    orphanedElse(child, file, found)
  })
  return found
}

test('every template compiles, and no v-else has lost its v-if', () => {
  const { parse, compileTemplate } = require('@vue/compiler-sfc')
  const { baseParse } = require('@vue/compiler-core')
  const broken = []

  for (const file of vueFiles(WEB)) {
    const source = readFileSync(file, 'utf8')
    const { descriptor } = parse(source, { filename: file })
    if (!descriptor.template) continue

    const out = compileTemplate({
      source: descriptor.template.content,
      filename: file,
      id: file,
    })
    for (const e of out.errors ?? []) {
      broken.push(`${file.replace(WEB, '')}: ${e.message ?? e}`)
    }
    // The raw parse, not the compiled AST: by the time the template is compiled
    // the orphan has been dropped and there is nothing left to find.
    // The raw parse, not the compiled AST: by the time a template is compiled the
    // pairing has been resolved and there is nothing left to inspect.
    broken.push(...orphanedElse(baseParse(descriptor.template.content), file))
  }

  assert.deepEqual(broken, [], 'templates that will silently drop a block')
})

/** Fields a template reads off a named object, e.g. `p.family` → family. */
function fieldsRead(template, holders) {
  const found = new Set()
  for (const holder of holders) {
    const re = new RegExp(`\\b${holder}\\.([a-z_][a-z0-9_]*)`, 'gi')
    let m
    while ((m = re.exec(template))) found.add(m[1])
  }
  return found
}

/**
 * One entry per screen: every endpoint it reads, and the loop variables it reads
 * them through.
 *
 * Several endpoints per screen on purpose. The first version of this test named
 * one, and `Wiring.vue` uses `s` for two unrelated things — an MCP server and a
 * tool surface, from two different calls — so it reported `tools` and `calls` as
 * missing when they arrive perfectly well from the other one. A check that cries
 * wolf gets switched off, which is worse than not having it.
 */
const SCREENS = [
  {
    what: 'the project list',
    paths: ['/projects'],
    file: 'components/ProjectSwitcher.vue',
    holders: ['p'],
  },
  {
    what: 'permission rules',
    paths: ['/projects/atlas/permissions'],
    file: 'views/PermissionsView.vue',
    holders: ['p'],
  },
  {
    what: 'what is in the way',
    paths: ['/blockers'],
    file: 'components/Blockers.vue',
    holders: ['b'],
  },
  {
    what: 'the wiring',
    paths: ['/mcp', '/wiring'],
    file: 'components/Wiring.vue',
    holders: ['s', 'a'],
  },
  {
    what: 'the queue',
    paths: ['/runs?project=atlas'],
    file: 'components/RunQueue.vue',
    holders: ['r'],
  },
]

for (const screen of SCREENS) {
  test(`${screen.what}: every field the screen reads is one the API sends`, async () => {
    const file = join(WEB, screen.file)
    if (!existsSync(file)) return

    // Every field of every row of every endpoint this screen reads, one level
    // down too: `a.capabilities` is a field of an agent, `s.entries[0].harness`
    // belongs to what a server carries.
    const sent = new Set()
    for (const path of screen.paths) {
      const body = await (await fetch(`${API}${path}`)).json()
      const rows = Array.isArray(body) ? body : Object.values(body).flat()
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        for (const [k, v] of Object.entries(row)) {
          sent.add(k)
          const nested = Array.isArray(v) ? v[0] : v
          if (nested && typeof nested === 'object') for (const k2 of Object.keys(nested)) sent.add(k2)
        }
      }
    }
    if (!sent.size) return // nothing to compare against; not a failure

    const { parse } = require('@vue/compiler-sfc')
    const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
    const template = descriptor.template?.content ?? ''

    const missing = [...fieldsRead(template, screen.holders)].filter((f) => !sent.has(f))

    assert.deepEqual(
      missing,
      [],
      `${screen.file} reads fields the API never sends — the shape that produced ` +
        `"undefined 66". Sent: ${[...sent].sort().join(', ')}`,
    )
  })
}

test('the fixtures cover every endpoint the screens read', async () => {
  // The check above is only as good as the rows behind it: an endpoint that
  // returns nothing makes every field trivially present. This fails loudly when
  // a screen is added and its data is not.
  for (const screen of SCREENS) {
    for (const path of screen.paths) {
      const body = await (await fetch(`${API}${path}`)).json()
      // Every branch of the response, not just the union: `/wiring` returns
      // agents AND tool surfaces, and a fixture that filled only the first left
      // the second silently unexamined. This test found that on its own data.
      const branches = Array.isArray(body) ? { '': body } : body
      for (const [key, rows] of Object.entries(branches)) {
        if (!Array.isArray(rows)) continue
        assert.ok(
          rows.length,
          `${path}${key ? `.${key}` : ''} returned nothing — the check on ${screen.file} saw no data there`,
        )
      }
    }
  }
})

test('every halt reason the schema allows has a label and an explanation', () => {
  // The analysis page printed `not_converging` and `judge_conversation_full` raw,
  // among nine phrases written for a person. Both halts were added carefully and
  // the label table was not told — a table with a hole shows the hole, in the one
  // place someone goes to understand why work stopped.
  const schema = readFileSync(join(here, '..', 'src', 'db', 'schema.sql'), 'utf8')
  const check = /reason\s+TEXT NOT NULL CHECK \(reason IN \(([\s\S]*?)\)\)/.exec(schema)
  assert.ok(check, 'the schema still declares the allowed reasons')

  const allowed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(allowed.length > 5, 'and there are several of them')

  const labels = readFileSync(join(WEB, 'labels.ts'), 'utf8')
  const section = (name) => {
    const from = labels.indexOf(`export const ${name}`)
    const to = labels.indexOf('export const', from + 1)
    return labels.slice(from, to === -1 ? undefined : to)
  }

  const named = (block) => new Set([...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]))
  const withLabel = named(section('haltLabel'))
  const withHelp = named(section('haltHelp'))

  assert.deepEqual(
    allowed.filter((r) => !withLabel.has(r)),
    [],
    'reasons with no short label',
  )
  assert.deepEqual(
    allowed.filter((r) => !withHelp.has(r)),
    [],
    'reasons with no explanation',
  )
})

/**
 * The whole journey of a waiver, through the API the screen actually calls.
 *
 * Recording it revealed a defect nothing else caught: a waiver lands in
 * `decisions`, and the instruction on the page treats the latest decision as
 * something the next pass must be handed. So a lifted gate rule answered with
 * "you have decided — start a pass", and the agent would have been given a note
 * about the gate as if it were the work. Found by eye on a screenshot; kept
 * closed here.
 */
test('a waiver lifts the rule, and is not mistaken for an instruction', async () => {
  const post = (path, body) =>
    fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  // Its own project: the shared fixture carries a single permission, which trips
  // the "no allowed tools" blocker, and a project-level blocker outranks the gate
  // — rightly. Borrowing it would have this test measure that instead.
  db.prepare(
    "INSERT INTO projects (id,slug,name,repo_path,gate_judge) VALUES (2,'waived','Waived','/tmp','gpt')",
  ).run()
  for (let i = 0; i < 12; i++) {
    db.prepare(
      `INSERT INTO permissions (project_id,harness,pattern,label,decision,note)
       VALUES (2,'claude',?,'Core tools','allow','seeded')`,
    ).run(`Bash(cmd${i} *)`)
  }

  // A criterion whose words name captures as its SUBJECT and ask nobody to look.
  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (9,2,'baseline','baseline.csv compte les 18 captures du corpus','feature','in_progress')`,
  ).run()
  db.prepare(
    `INSERT INTO evidences (objective_id,type,label,verdict) VALUES (9,'test','verify.py','pass')`,
  ).run()
  db.prepare(
    `INSERT INTO evidences (objective_id,type,label,verdict,payload)
     VALUES (9,'manual','verdict','pass','{"judged_by":"gpt"}')`,
  ).run()

  const before = await (await fetch(`${API}/objectives/9/next`)).json()
  assert.match(before.headline, /seen/, 'the wall that is actually there is the one named')
  assert.ok(
    before.choices.some((c) => c.kind === 'waive_visual'),
    'and the way past it is offered where it blocks',
  )

  // A rule that does not exist cannot be lifted, and a waiver needs its objective.
  assert.equal((await post('/projects/waived/decisions', {
    title: 't', body: 'b', objective_id: 9, waives: 'not_a_rule',
  })).status, 422)
  assert.equal((await post('/projects/waived/decisions', {
    title: 't', body: 'b', waives: 'visual_proof',
  })).status, 422)

  assert.equal((await post('/projects/waived/decisions', {
    title: 'This criterion does not require seeing',
    body: 'it asks for a CSV and counts',
    objective_id: 9,
    waives: 'visual_proof',
  })).status, 201)

  const after = await (await fetch(`${API}/objectives/9/next`)).json()
  assert.deepEqual(
    after.choices.map((c) => c.kind),
    ['accept', 'reject'],
    'it now settles on what it measured',
  )
  assert.doesNotMatch(after.headline, /you have decided/i)

  const detail = await (await fetch(`${API}/objectives/9`)).json()
  assert.equal(detail.waivers.length, 1, 'and the lifted rule travels with the objective')

  const recall = await (await fetch(`${API}/projects/waived/recall`)).json()
  assert.equal(
    recall.decisions.filter((d) => d.waives).length,
    0,
    'an agent is never handed "this does not require seeing" as a project constraint',
  )
})

/**
 * A step nobody has started yet.
 *
 * The gate answers "can it conclude?" — and on something never attempted every
 * true answer it gives is humanly wrong. "Nothing NEW has been produced to
 * judge", "run it AGAIN", "the attempts already made stop counting", and a panel
 * offering to refuse work that does not exist over a tally of zero. Four
 * sentences about a history that never happened, which is how a reader decides
 * the tool is confused and stops trusting the sentences that are right.
 */
test('a step nobody has started is not described as one that failed', async () => {
  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (11,2,'spec','un grep des 4 noms de flags retourne 4 occurrences','feature','ready')`,
  ).run()

  const step = await (await fetch(`${API}/objectives/11/next`)).json()
  assert.match(step.headline, /not been started/)
  assert.doesNotMatch(step.action, /again/i, 'nothing to run "again"')

  const kinds = step.choices.map((c) => c.kind)
  assert.ok(kinds.includes('run'), 'the one thing to do is offered')
  assert.ok(!kinds.includes('accept') && !kinds.includes('reject'), 'nothing to judge yet')

  const rewrite = step.choices.find((c) => c.kind === 'criterion')
  assert.doesNotMatch(rewrite.price, /attempts already made/, 'no attempts to invalidate')

  // And once something HAS run, the wording that speaks of a history comes back.
  db.prepare(
    "INSERT INTO passages (objective_id,harness,started_at,ended_at) VALUES (11,'claude',datetime('now'),datetime('now'))",
  ).run()
  const after = await (await fetch(`${API}/objectives/11/next`)).json()
  assert.doesNotMatch(after.headline, /not been started/)
  assert.match(
    after.choices.find((c) => c.kind === 'criterion').price,
    /attempts already made/,
  )
})

/**
 * Une passe qui n'avance plus, et qui ne le dit à personne.
 *
 * Le run 59 est resté deux heures entre deux tours, sa page de jugement morte —
 * cinq abandons dans le journal de l'ouvrier. Le garde-fou de silence de la
 * boucle n'a pas déclenché, la page de l'objectif annonçait « elle repart dès
 * qu'une réponse arrive », et tous les autres écrans affichaient un `running`
 * en bonne santé. Personne ne surveillait la seule chose qui compte : est-ce que
 * ça progresse encore.
 */
test('un run qui n’avance plus est remonté comme blocage', async () => {
  const { blockers } = await import('../src/blockers.js')
  const nom = (b) => b.kind === 'judge_silent'

  db.prepare(
    `INSERT INTO objectives (id,project_id,title,proof_spec,blast_radius,status)
     VALUES (12,2,'bloque','le test passe','feature','in_progress')`,
  ).run()
  db.prepare(
    `INSERT INTO runs (id,project_id,objective_id,mode,status,turn,machine,pid,taken_at)
     VALUES (99,2,12,'chapter','running',2,'here',1,datetime('now','-3 hours'))`,
  ).run()

  // Un tour qui vient de finir : elle attend, c'est normal.
  db.prepare(
    `INSERT INTO passages (objective_id,harness,started_at,ended_at)
     VALUES (12,'claude',datetime('now','-1 hours'),datetime('now'))`,
  ).run()
  assert.equal(blockers().filter(nom).length, 0, 'un tour qui vient de finir n’est pas une panne')

  // Le même tour, fini il y a une heure : plus rien n'avance.
  db.prepare("UPDATE passages SET ended_at = datetime('now','-1 hours') WHERE objective_id = 12").run()
  const b = blockers().filter(nom)
  assert.equal(b.length, 1)
  assert.match(b[0].title, /turn 2 ended 6\d min ago/)
  assert.equal(b[0].objective, 12)

  // Un tour EN COURS n'est pas une panne, quelle que soit sa durée.
  db.prepare(
    "INSERT INTO passages (objective_id,harness,started_at) VALUES (12,'claude',datetime('now','-2 hours'))",
  ).run()
  assert.equal(blockers().filter(nom).length, 0, 'une passe qui travaille n’est pas un blocage')

  // Et une fois l'arrêt demandé, on cesse de le signaler.
  db.prepare('UPDATE passages SET ended_at = datetime(\'now\',\'-1 hours\') WHERE ended_at IS NULL AND objective_id = 12').run()
  assert.equal(blockers().filter(nom).length, 1)
  db.prepare('UPDATE runs SET cancel_asked = 1 WHERE id = 99').run()
  assert.equal(blockers().filter(nom).length, 0, 'tu as déjà demandé son arrêt')
})
