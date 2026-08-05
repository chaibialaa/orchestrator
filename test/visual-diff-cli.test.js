import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * `visual --diff before after` as a criterion actually calls it.
 *
 * The count of numeric fields is never typed in below. Every structural
 * assertion derives it from what `visual <image> --json` reported a moment
 * earlier — which is the only way a test says something about the mechanism
 * rather than about a number somebody counted on the day they wrote it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '../src/cli.js')
const FLAT = join(here, 'fixtures/flat.png')
const VARIED = join(here, 'fixtures/varied.png')

const run = (...argv) => {
  const p = spawnSync(process.execPath, [CLI, 'visual', ...argv], { encoding: 'utf8' })
  const last = p.stdout.trim().split('\n').pop() ?? ''
  let json = null
  try {
    json = JSON.parse(last)
  } catch {
    /* the failing paths refuse before measuring and print no JSON at all */
  }
  return { code: p.status, out: p.stdout, err: p.stderr, json }
}

/** The numeric contract of the mono-image line, read off the command itself. */
const monoNumericFields = (file) => {
  const m = run(file, '--json').json
  return Object.entries(m)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k]) => k)
}

test('an image against itself is exactly zero on every numeric field', () => {
  const r = run('--diff', FLAT, FLAT, '--json')
  assert.equal(r.code, 0)
  const expected = monoNumericFields(FLAT)
  assert.deepEqual(Object.keys(r.json.delta), expected, 'the delta covers the mono-image numbers')
  assert.ok(expected.length > 0)
  for (const k of expected) {
    assert.equal(r.json.delta[k], 0, `${k} moved against itself`)
    assert.equal(Object.is(r.json.delta[k], -0), false, `${k} came out as -0`)
  }
})

test('the human report prints exactly 0.000 for every field of an identity', () => {
  const r = run('--diff', FLAT, FLAT)
  assert.equal(r.code, 0)
  for (const k of monoNumericFields(FLAT)) {
    assert.match(r.out, new RegExp(`^\\s+${k}\\s+\\S+ -> \\S+\\s+0\\.000$`, 'm'), `${k} not printed as 0.000`)
  }
  assert.match(r.out, /Non-zero fields: 0/)
  assert.ok(!/[+-]0\.000/.test(r.out), 'a zero must carry no sign at all')
})

test('the delta keys are exactly the numeric keys the two measurements share', () => {
  const r = run('--diff', FLAT, VARIED, '--json')
  assert.equal(r.code, 0)
  const flat = new Set(monoNumericFields(FLAT))
  const varied = monoNumericFields(VARIED)
  const common = varied.filter((k) => flat.has(k))
  assert.deepEqual(Object.keys(r.json.delta), common)
  assert.deepEqual(r.json.fields, common)
})

test('no array or object ever appears as a scalar delta', () => {
  const r = run('--diff', FLAT, VARIED, '--json')
  for (const [k, v] of Object.entries(r.json.delta)) {
    assert.equal(typeof v, 'number', `${k} is not a number`)
    assert.ok(Number.isFinite(v))
  }
  assert.ok(!('tileShadowShares' in r.json.delta), 'a 16-value array has no scalar delta')
  assert.ok(!('tileDarkShares' in r.json.delta))
  assert.ok(!('file' in r.json.delta), 'a filename is not a measure')
})

test('two different images move at least three numeric fields, and each is named', () => {
  const r = run('--diff', FLAT, VARIED)
  assert.equal(r.code, 0)
  const j = run('--diff', FLAT, VARIED, '--json').json
  const nonZero = Object.entries(j.delta).filter(([, v]) => v !== 0).map(([k]) => k)
  assert.ok(nonZero.length >= 3, `only ${nonZero.length} field(s) moved`)
  assert.deepEqual(j.nonZeroFields, nonZero)
  assert.match(r.out, new RegExp(`Non-zero fields: ${nonZero.length}`))
  for (const k of nonZero) {
    assert.match(r.out, new RegExp(`^\\s+- ${k}: \\S+ -> \\S+ = [+-]\\d`, 'm'), `${k} is not named with its values`)
  }
})

test('the sign follows after minus before, both ways round', () => {
  const forwards = run('--diff', FLAT, VARIED, '--json').json
  const backwards = run('--diff', VARIED, FLAT, '--json').json
  for (const k of forwards.fields) {
    assert.equal(
      forwards.delta[k],
      Number((forwards.after.metrics[k] - forwards.before.metrics[k]).toFixed(3)),
      `${k} is not after − before`,
    )
    assert.equal(backwards.delta[k], forwards.delta[k] === 0 ? 0 : -forwards.delta[k], `${k} did not flip`)
  }
})

test('the JSON says which side is which, and carries both values', () => {
  const r = run('--diff', FLAT, VARIED, '--json').json
  assert.equal(r.direction, 'delta = after - before')
  assert.equal(r.before.file, FLAT)
  assert.equal(r.after.file, VARIED)
  for (const k of r.fields) {
    assert.equal(typeof r.before.metrics[k], 'number')
    assert.equal(typeof r.after.metrics[k], 'number')
  }
})

test('under --json stdout is the JSON and nothing else', () => {
  const p = spawnSync(process.execPath, [CLI, 'visual', '--diff', FLAT, VARIED, '--json'], { encoding: 'utf8' })
  assert.equal(p.status, 0)
  assert.equal(p.stdout.trim().split('\n').length, 1)
  assert.doesNotThrow(() => JSON.parse(p.stdout))
})

test('the human report names the order it compares in', () => {
  const r = run('--diff', FLAT, VARIED)
  assert.match(r.out, /before: .*flat\.png/)
  assert.match(r.out, /after: +.*varied\.png/)
  assert.match(r.out, /delta = after - before/)
  assert.match(r.out, /same camera/, 'whose responsibility that is stays on the report')
})

test('--diff with no file refuses', () => {
  const r = run('--diff')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /--diff needs two files/)
  assert.ok(!/ {4}at /.test(r.err), 'a bad argument is a usage message, not a crash')
})

test('--diff with a single file refuses instead of comparing it to itself', () => {
  const r = run('--diff', FLAT, '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /--diff needs two files/)
})

test('--diff with three files refuses', () => {
  const r = run('--diff', FLAT, VARIED, FLAT, '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /exactly two files/)
})

test('a missing before file is refused, and the side is named', () => {
  const r = run('--diff', join(here, 'fixtures/does-not-exist.png'), VARIED, '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /--diff before/)
  assert.ok(!/ {4}at /.test(r.err))
})

test('a missing after file is refused, and the side is named', () => {
  const r = run('--diff', FLAT, join(here, 'fixtures/does-not-exist.png'), '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /--diff after/)
})

test('a file that is not readable as an image is refused', () => {
  const r = run('--diff', FLAT, CLI, '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /--diff after/)
})

test('--diff and --tension-ref are not combined', () => {
  const r = run('--diff', FLAT, VARIED, '--tension-ref', FLAT, '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /--diff and --tension-ref/)
  assert.ok(!r.json, 'neither comparison silently wins')
})

test('a mono-image threshold in diff mode is refused rather than applied to one side', () => {
  const r = run('--diff', FLAT, VARIED, '--min-hues', '99', '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /--diff takes no other flag/)
})

test('a mono-image path beside --diff is refused as ambiguous', () => {
  const r = run(FLAT, '--diff', FLAT, VARIED, '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /third image path/)
})

test('the mono-image reading is untouched by the differential', () => {
  // The same file read alone still carries the six, the #51 axes and the
  // diagnostics, and the diff reports exactly those numbers back.
  const mono = run(VARIED, '--json').json
  const d = run('--diff', VARIED, VARIED, '--json').json
  for (const k of monoNumericFields(VARIED)) {
    assert.equal(d.before.metrics[k], mono[k], `${k} disagrees between the two readings`)
    assert.equal(d.after.metrics[k], mono[k])
  }
  assert.ok(!('mode' in mono), 'the mono-image line gained no key')
})
