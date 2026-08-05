import { test } from 'node:test'
import assert from 'node:assert/strict'

const { numericFields, diffMeasurements, MeasurementDiffError, publishedMeasurement } = await import(
  '../src/visual.js'
)

/**
 * The differential, on objects rather than on images.
 *
 * The arithmetic is settled here, where every expected value can be done by
 * hand; the CLI tests settle the contract a criterion depends on. The point of
 * this file is that NOTHING below names a metric of the project: the mechanism
 * is generic, and a test written against `saturation` would pass just as well
 * against a hard-coded list, which is what #52 exists to refuse.
 */

const base = { file: 'a.png', alpha: 1, beta: 2.5, gamma: -3 }

test('a measurement compared to itself moves nothing at all', () => {
  const d = diffMeasurements(base, { ...base })
  assert.deepEqual(d.delta, { alpha: 0, beta: 0, gamma: 0 })
  for (const k of d.fields) assert.equal(d.delta[k], 0)
})

test('a value that rose gives a positive delta, one that fell a negative one', () => {
  const d = diffMeasurements({ up: 1, down: 10, flat: 4 }, { up: 3, down: 2, flat: 4 })
  assert.equal(d.delta.up, 2)
  assert.equal(d.delta.down, -8)
  assert.equal(d.delta.flat, 0)
})

test('the direction is after minus before, and never the other way round', () => {
  const forwards = diffMeasurements({ x: 0.144 }, { x: 0.285 })
  const backwards = diffMeasurements({ x: 0.285 }, { x: 0.144 })
  assert.equal(forwards.delta.x, 0.141)
  assert.equal(backwards.delta.x, -0.141)
})

test('only first-level finite numbers are compared', () => {
  const shape = {
    file: 'a.png',
    label: 'text',
    flag: true,
    off: false,
    missing: null,
    list: [1, 2, 3],
    nested: { inner: 5 },
    real: 7,
  }
  assert.deepEqual(numericFields(shape), ['real'])
  const d = diffMeasurements(shape, { ...shape, real: 9 })
  assert.deepEqual(Object.keys(d.delta), ['real'])
  assert.deepEqual(d.fields, ['real'])
})

test('a nested number is not reached, so no array or object becomes a scalar delta', () => {
  const d = diffMeasurements({ n: 1, list: [1, 2], deep: { n: 1 } }, { n: 2, list: [9, 9], deep: { n: 9 } })
  assert.deepEqual(Object.keys(d.delta), ['n'])
})

test('a numeric field nobody has heard of is compared without a list being touched', () => {
  // The whole claim of #52, at the smallest scale a test can hold it: the field
  // below exists in no source file, no constant and no documentation.
  const before = { ...base, freshlyInventedMeasure: 10 }
  const after = { ...base, freshlyInventedMeasure: 14.25 }
  const d = diffMeasurements(before, after)
  assert.ok(d.fields.includes('freshlyInventedMeasure'))
  assert.equal(d.delta.freshlyInventedMeasure, 4.25)
})

test('the discovered set is derived from a real published measurement, not from a constant', () => {
  // Same mechanism against the actual contract object: whatever numbers
  // `publishedMeasurement` carries are exactly the fields that get compared.
  const m = {
    saturation: 0.1,
    hues: 2,
    distinctColours: 3,
    contrast: 0.4,
    shadowShare: 0.5,
    highlightShare: 0.6,
    tileShadowShares: [0, 1],
    tileShadowSpread: 0.7,
    subjectKeyFillAdvantage: 0.8,
    tileDarkShares: [0, 1],
    tileDarkStd: 0.9,
    frameMedianLuma: 1,
    brightestTileMedianLuma: 1.1,
    brightestTileMedianRatio: 1.2,
  }
  const published = publishedMeasurement(m, 'x.png')
  const expected = Object.entries(published)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k]) => k)
  assert.deepEqual(numericFields(published), expected)
  assert.ok(!expected.includes('file'), 'a filename is not a measure')
  assert.ok(!expected.includes('tileShadowShares'), 'an array has no scalar delta')
  assert.ok(!expected.includes('tileDarkShares'))
})

test('a numeric field present only in after is named and refused', () => {
  assert.throws(
    () => diffMeasurements({ a: 1 }, { a: 1, onlyAfter: 2 }),
    (e) => e instanceof MeasurementDiffError && /absent from before: onlyAfter/.test(e.message),
  )
})

test('a numeric field present only in before is named and refused', () => {
  assert.throws(
    () => diffMeasurements({ a: 1, onlyBefore: 2 }, { a: 1 }),
    (e) => e instanceof MeasurementDiffError && /absent from after: onlyBefore/.test(e.message),
  )
})

test('a field that turned null on one side is a missing field, not a zero', () => {
  // `null` means "not measured". Treating it as 0 would report a fall to zero.
  assert.throws(() => diffMeasurements({ a: 1, r: 1.2 }, { a: 1, r: null }), MeasurementDiffError)
})

test('NaN is refused rather than published', () => {
  assert.throws(
    () => diffMeasurements({ a: 1 }, { a: NaN }),
    (e) => e instanceof MeasurementDiffError && /after\.a is NaN/.test(e.message),
  )
})

test('Infinity is refused rather than published', () => {
  assert.throws(
    () => diffMeasurements({ a: Infinity }, { a: 1 }),
    (e) => e instanceof MeasurementDiffError && /before\.a is Infinity/.test(e.message),
  )
  assert.throws(() => diffMeasurements({ a: 1 }, { a: -Infinity }), MeasurementDiffError)
})

test('the field order is the key order of after, and it is stable', () => {
  const after = { zulu: 1, alpha: 2, mike: 3 }
  const before = { mike: 0, zulu: 0, alpha: 0 }
  const d = diffMeasurements(before, after)
  assert.deepEqual(d.fields, ['zulu', 'alpha', 'mike'])
  assert.deepEqual(Object.keys(d.delta), ['zulu', 'alpha', 'mike'])
  assert.deepEqual(diffMeasurements(before, after).fields, d.fields, 'two runs agree')
})

test('the delta is published at the thousandth, with no binary residue', () => {
  assert.equal(diffMeasurements({ x: 0.144 }, { x: 0.285 }).delta.x, 0.141)
  assert.equal(diffMeasurements({ x: 0.1 }, { x: 0.3 }).delta.x, 0.2)
  const d = diffMeasurements({ x: 1 / 3 }, { x: 2 / 3 }).delta.x
  assert.equal(d, Number(d.toFixed(3)))
})

test('a zero delta is a plain zero and never a negative zero', () => {
  const d = diffMeasurements({ same: 0.5, zero: 0 }, { same: 0.5, zero: 0 })
  for (const k of d.fields) {
    assert.equal(Object.is(d.delta[k], -0), false, `${k} came out as -0`)
    assert.equal(d.delta[k], 0)
    assert.equal(d.delta[k].toFixed(3), '0.000')
  }
  // The case that produces -0 without normalisation: a rounded-away fall.
  const tiny = diffMeasurements({ x: 0.0004 }, { x: 0 }).delta.x
  assert.equal(Object.is(tiny, -0), false)
  assert.equal(tiny.toFixed(3), '0.000')
})

test('before and after values travel with the delta, so the subtraction is checkable', () => {
  const d = diffMeasurements({ x: 0.144 }, { x: 0.285 })
  assert.equal(d.before.x, 0.144)
  assert.equal(d.after.x, 0.285)
  assert.equal(d.delta.x, Number((d.after.x - d.before.x).toFixed(3)))
})

test('something that is not a measurement is refused by name', () => {
  assert.throws(() => diffMeasurements(null, { a: 1 }), MeasurementDiffError)
  assert.throws(() => diffMeasurements({ a: 1 }, 'nope'), MeasurementDiffError)
})
