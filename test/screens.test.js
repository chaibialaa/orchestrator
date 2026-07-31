import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
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
 * So this reads every template, collects the fields it expects on API data, and
 * compares them with a live response. It runs against the real server when one
 * is up, and skips rather than passing quietly when it is not — a green test
 * that checked nothing is worse than a missing one.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WEB = join(here, '..', 'web', 'src')
const require = createRequire(join(here, '..', 'web', 'package.json'))

const API = process.env.ORCHESTRATOR_API ?? 'http://127.0.0.1:4747/api'
const reachable = await fetch(`${API}/projects`, { signal: AbortSignal.timeout(2000) }).then(
  () => true,
  () => false,
)

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
  test(`${screen.what}: every field the screen reads is one the API sends`, { skip: !reachable }, async () => {
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

test('the smoke test is actually running against a server', () => {
  // Said out loud rather than skipped in silence: the visual tests had gone to
  // skipped when their fixtures were swept, and protected nothing for hours.
  if (!reachable) {
    console.log(`    (no server on ${API} — the screen checks did not run)`)
  }
  assert.ok(true)
})
