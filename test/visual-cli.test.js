import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * The command as a criterion actually calls it.
 *
 * The unit tests settle the arithmetic; these settle the contract a proof
 * depends on — which keys come out, and which exit code. A metric that is right
 * and reports exit 0 whatever the threshold proves nothing.
 *
 * No threshold below is typed in by hand. Each one is derived from the value the
 * command itself reported a moment earlier, which is the only way a "hardened
 * threshold fails" test says something about the mechanism rather than about a
 * number somebody guessed.
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
    /* the failing paths that refuse before measuring print no JSON at all */
  }
  return { code: p.status, out: p.stdout, err: p.stderr, json }
}

const LEGACY = ['saturation', 'hues', 'distinctColours', 'contrast', 'shadowShare', 'highlightShare']
const TENSION = [
  'tileShadowShares',
  'tileShadowSpread',
  'subjectKeyFillAdvantage',
  'tileDarkShares',
  'tileDarkStd',
  'frameMedianLuma',
  'brightestTileMedianLuma',
  'brightestTileMedianRatio',
]

/** The thousandth is the output contract, so the smallest step that clears a value. */
const STEP = 0.001
const justAbove = (v) => Number((v + STEP).toFixed(3))
const justBelow = (v) => Number((v - STEP).toFixed(3))

test('the old invocation still works and still carries the six', () => {
  const r = run(FLAT, '--json')
  assert.equal(r.code, 0)
  assert.ok(r.json, 'stdout is still JSON on its own with --json')
  for (const k of LEGACY) assert.ok(k in r.json, `${k} is gone from the JSON line`)
  assert.equal(typeof r.json.file, 'string')
})

test('the new keys are added, and the six keep their place at the front', () => {
  const r = run(FLAT, '--json')
  for (const k of TENSION) assert.ok(k in r.json, `${k} missing`)
  assert.equal(r.json.tileShadowShares.length, 16, 'the contractual 4 × 4 grid is inspectable')
  assert.equal(r.json.tileDarkShares.length, 64, 'the legacy 8 × 8 diagnostic remains inspectable')
  assert.deepEqual(Object.keys(r.json).slice(0, 7), ['file', ...LEGACY], 'the frozen keys did not move')
})

test('contractual shadow thresholds pass relaxed and fail just beyond the value', () => {
  const value = run(VARIED, '--json').json.tileShadowSpread
  assert.equal(run(VARIED, '--min-tile-shadow-spread', String(justBelow(value)), '--json').code, 0)
  assert.notEqual(run(VARIED, '--min-tile-shadow-spread', String(justAbove(value)), '--json').code, 0)
  assert.equal(run(VARIED, '--max-tile-shadow-spread', String(justAbove(value)), '--json').code, 0)
  assert.notEqual(run(VARIED, '--max-tile-shadow-spread', String(justBelow(value)), '--json').code, 0)
})

test('contractual subject key/fill thresholds pass relaxed and fail just beyond the value', () => {
  const value = run(VARIED, '--json').json.subjectKeyFillAdvantage
  assert.equal(run(VARIED, '--min-subject-key-fill-advantage', String(justBelow(value)), '--json').code, 0)
  assert.notEqual(run(VARIED, '--min-subject-key-fill-advantage', String(justAbove(value)), '--json').code, 0)
  assert.equal(run(VARIED, '--max-subject-key-fill-advantage', String(justAbove(value)), '--json').code, 0)
  assert.notEqual(run(VARIED, '--max-subject-key-fill-advantage', String(justBelow(value)), '--json').code, 0)
})

test('without a reference there are no delta keys at all', () => {
  const r = run(FLAT, '--json')
  assert.ok(!('deltaTileDarkStd' in r.json), 'a delta with nothing to compare would be a fiction')
  assert.ok(!('deltaBrightestTileMedianRatio' in r.json))
  assert.ok(!('tensionRef' in r.json))
})

test('with a reference the deltas appear, signed, beside the reference measurement', () => {
  const r = run(VARIED, '--tension-ref', FLAT, '--json')
  assert.equal(r.code, 0)
  assert.ok('deltaTileDarkStd' in r.json)
  assert.ok('deltaBrightestTileMedianRatio' in r.json)
  assert.equal(r.json.tensionRef.file, 'flat.png')
  // The delta is exactly the subtraction of the two published numbers, so a
  // reader can redo it from the archive without reopening the images.
  assert.equal(
    r.json.deltaTileDarkStd,
    Number((r.json.tileDarkStd - r.json.tensionRef.tileDarkStd).toFixed(3)),
  )
})

test('an image against itself moves nothing', () => {
  const r = run(FLAT, '--tension-ref', FLAT, '--json')
  assert.equal(r.code, 0)
  assert.equal(r.json.deltaTileDarkStd, 0)
  assert.equal(r.json.deltaBrightestTileMedianRatio, 0)
})

test('a missing reference refuses cleanly instead of throwing a stack', () => {
  const r = run(FLAT, '--tension-ref', join(here, 'fixtures/does-not-exist.png'), '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /tension-ref/)
  assert.ok(!/ {4}at /.test(r.err), 'a bad argument is a usage message, not a crash')
})

test('a reference that is not readable as an image refuses too', () => {
  const r = run(FLAT, '--tension-ref', CLI, '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /tension-ref/)
})

test('--tension-ref with no value refuses', () => {
  const r = run(FLAT, '--tension-ref', '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /tension-ref/)
})

test('a delta threshold without a reference refuses and names the flag', () => {
  const r = run(FLAT, '--min-delta-tile-dark-std', '0', '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /--min-delta-tile-dark-std/)
  assert.match(r.err, /--tension-ref/)
})

test('a relaxed threshold passes and a threshold just past the measured value fails', () => {
  const measured = run(FLAT, '--json').json

  // tile dark std — floor relaxed, then a ceiling one step under the value.
  assert.equal(run(FLAT, '--min-tile-dark-std', '0', '--json').code, 0)
  assert.notEqual(
    run(FLAT, '--max-tile-dark-std', String(justBelow(measured.tileDarkStd)), '--json').code,
    0,
    'a ceiling below the measured spread must refuse',
  )

  // brightest-tile ratio — the same pair, in the other direction.
  assert.equal(run(FLAT, '--max-brightest-tile-ratio', '1000', '--json').code, 0)
  assert.notEqual(
    run(FLAT, '--min-brightest-tile-ratio', String(justAbove(measured.brightestTileMedianRatio)), '--json').code,
    0,
    'a floor above the measured ratio must refuse',
  )
})

test('each delta threshold hardens on its own measured value', () => {
  const measured = run(VARIED, '--tension-ref', FLAT, '--json').json
  const base = [VARIED, '--tension-ref', FLAT, '--json']

  assert.equal(run(...base, '--min-delta-tile-dark-std', '-10', '--max-delta-tile-dark-std', '10').code, 0)
  assert.notEqual(
    run(...base, '--min-delta-tile-dark-std', String(justAbove(measured.deltaTileDarkStd))).code,
    0,
  )
  assert.notEqual(
    run(...base, '--max-delta-tile-dark-std', String(justBelow(measured.deltaTileDarkStd))).code,
    0,
  )

  assert.equal(run(...base, '--min-delta-brightest-tile-ratio', '-10').code, 0)
  assert.notEqual(
    run(...base, '--min-delta-brightest-tile-ratio', String(justAbove(measured.deltaBrightestTileMedianRatio)))
      .code,
    0,
  )
  assert.notEqual(
    run(...base, '--max-delta-brightest-tile-ratio', String(justBelow(measured.deltaBrightestTileMedianRatio)))
      .code,
    0,
  )
})

test('a threshold of zero is honoured as a threshold, not read as absent', () => {
  // `--min-delta-tile-dark-std 0` is the most useful floor there is — "it must
  // not have gone down" — and the truthiness test the six legacy flags use would
  // drop it silently.
  const r = run(FLAT, '--tension-ref', VARIED, '--min-delta-tile-dark-std', '0', '--json')
  const delta = r.json.deltaTileDarkStd
  if (delta < 0) assert.notEqual(r.code, 0, 'a negative delta must fail a floor of 0')
  else assert.equal(r.code, 0)
})

test('a threshold with no number refuses rather than being read as 1', () => {
  const r = run(FLAT, '--min-tile-dark-std', '--json')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /min-tile-dark-std/)
})

test('the JSON line is printed on the failing path too', () => {
  const r = run(FLAT, '--min-tile-dark-std', '99', '--json')
  assert.notEqual(r.code, 0)
  assert.ok(r.json, 'a gate reads the last line whether the run passed or failed')
  assert.ok('saturation' in r.json, 'and the six are still on it')
})

test('the historical floors still pass and still say so', () => {
  // The shape of the accepted proof of an earlier objective: three floors met,
  // the sentence printed, exit 0. Both halves are part of what was accepted.
  const m = run(VARIED, '--json').json
  const r = run(
    VARIED,
    '--min-saturation',
    String(justBelow(m.saturation)),
    '--min-hues',
    String(m.hues),
    '--min-colours',
    String(m.distinctColours),
  )
  assert.equal(r.code, 0)
  assert.match(r.out, /floors met/)
})

test('the historical failing path still fails', () => {
  const r = run(FLAT, '--min-colours', '999999', '--json')
  assert.equal(r.code, 1, 'the exit code a criterion was written against')
  assert.ok(r.json)
})

test('the six numbers do not move when a tension flag is added', () => {
  // The whole compatibility claim, at the smallest scale a test can hold it.
  const plain = run(VARIED, '--json').json
  const withTension = run(VARIED, '--tension-ref', FLAT, '--min-tile-dark-std', '0', '--json').json
  for (const k of LEGACY) assert.equal(withTension[k], plain[k], `${k} moved`)
})
