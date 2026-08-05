import { test } from 'node:test'
import assert from 'node:assert/strict'

const { tensionMetrics, tensionDelta, TENSION_GRID } = await import('../src/visual.js')

const grey = (n) => [n, n, n]
const frame = (w, h, at) => {
  const pixels = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push(at(x, y))
  return pixels
}

test('the contractual shadow grid is fixed at 4x4 and row-major', () => {
  assert.equal(TENSION_GRID, 4)
  const m = tensionMetrics(frame(4, 4, (x, y) => grey(y * 4 + x === 6 ? 0 : 255)), 4, 4)
  assert.equal(m.tileShadowShares.length, 16)
  assert.equal(m.tileShadowShares[6], 1)
  assert.equal(m.tileShadowShares.filter((v) => v === 0).length, 15)
})

test('uniform frames have no tile shadow spread', () => {
  assert.equal(tensionMetrics(frame(4, 4, () => grey(0)), 4, 4).tileShadowSpread, 0)
  assert.equal(tensionMetrics(frame(4, 4, () => grey(255)), 4, 4).tileShadowSpread, 0)
})

test('one dark tile gives the known max-minus-min spread', () => {
  const m = tensionMetrics(frame(4, 4, (x, y) => grey(x === 0 && y === 0 ? 0 : 255)), 4, 4)
  assert.equal(m.tileShadowSpread, 1)
})

test('a checkerboard of whole dark and light tiles reaches spread one', () => {
  const m = tensionMetrics(frame(4, 4, (x, y) => grey((x + y) % 2 ? 255 : 0)), 4, 4)
  assert.equal(m.tileShadowSpread, 1)
  assert.equal(m.tileShadowShares.filter((v) => v === 1).length, 8)
})

test('a known fractional spread is max share minus min share', () => {
  // Each 2x2 tile has two dark pixels except tile 0 (zero) and tile 15 (four).
  const m = tensionMetrics(
    frame(8, 8, (x, y) => {
      const tile = Math.floor(y / 2) * 4 + Math.floor(x / 2)
      if (tile === 0) return grey(255)
      if (tile === 15) return grey(0)
      return grey(x % 2 ? 255 : 0)
    }),
    8,
    8,
  )
  assert.equal(m.tileShadowSpread, 1)
  assert.equal(m.tileShadowShares[1], 0.5)
})

test('non-divisible dimensions partition exactly with each tile own denominator', () => {
  // Width 5 over 4 columns gives widths 1,1,1,2. One light pixel in the last
  // otherwise-dark tile makes its share 1/2.
  const m = tensionMetrics(frame(5, 4, (x, y) => grey(x === 4 && y === 0 ? 255 : 0)), 5, 4)
  assert.equal(m.tileShadowShares[3], 0.5)
  assert.equal(m.tileShadowShares[0], 1)
  assert.equal(m.tileShadowSpread, 0.5)
})

const epsilon = 1 / 255
const expectedStops = (high, low) => Math.log2(high / 255 + epsilon) - Math.log2(low / 255 + epsilon)

test('a more modelled central subject has a positive key/fill advantage', () => {
  // On 6x6 the subject is x,y in [2,4). Give its four pixels one low and three
  // high values: rank p10=50, p90=200. The uniform frame has KF=0.
  const m = tensionMetrics(
    frame(6, 6, (x, y) => {
      if (x >= 2 && x < 4 && y >= 2 && y < 4) return grey(x === 2 && y === 2 ? 50 : 200)
      return grey(100)
    }),
    6,
    6,
  )
  assert.equal(m.subjectKeyFillAdvantage, Number(expectedStops(200, 50).toFixed(3)))
  assert.ok(m.subjectKeyFillAdvantage > 0)
})

test('a flatter subject than its frame has a negative advantage', () => {
  const m = tensionMetrics(
    frame(6, 6, (x, y) => {
      if (x >= 2 && x < 4 && y >= 2 && y < 4) return grey(100)
      return grey((x + y) % 3 ? 200 : 50)
    }),
    6,
    6,
  )
  assert.equal(m.subjectKeyFillAdvantage, Number((-expectedStops(200, 50)).toFixed(3)))
})

test('equal modelling in subject and frame gives zero', () => {
  const m = tensionMetrics(frame(6, 6, (x, y) => grey((x + y) % 2 ? 200 : 50)), 6, 6)
  assert.equal(m.subjectKeyFillAdvantage, 0)
})

test('absence of a valid subject region publishes null', () => {
  const m = tensionMetrics(frame(1, 4, () => grey(100)), 1, 4)
  assert.equal(m.subjectKeyFillAdvantage, null)
})

test('subject bounds on non-divisible dimensions use floor thirds', () => {
  // Width/height 7 -> central region [2,4), exactly four pixels.
  const m = tensionMetrics(
    frame(7, 7, (x, y) => (x >= 2 && x < 4 && y >= 2 && y < 4 ? grey(x === 2 && y === 2 ? 50 : 200) : grey(100))),
    7,
    7,
  )
  assert.equal(m.subjectKeyFillAdvantage, Number(expectedStops(200, 50).toFixed(3)))
})

test('legacy diagnostics and deltas remain available for compatibility', () => {
  const a = tensionMetrics(frame(8, 8, () => grey(255)), 8, 8)
  const b = tensionMetrics(frame(8, 8, (x) => grey(32 * x)), 8, 8)
  assert.equal(a.tileDarkShares.length, 64)
  assert.equal(typeof a.tileDarkStd, 'number')
  assert.ok('brightestTileMedianRatio' in a)
  assert.equal(tensionDelta(a, a).deltaTileDarkStd, 0)
  assert.equal(tensionDelta(b, a).deltaBrightestTileMedianRatio, 1)
})

test('all new published values are stable at the thousandth', () => {
  const m = tensionMetrics(frame(8, 8, (x, y) => grey((x * 31 + y * 17) % 256)), 8, 8)
  for (const value of [...m.tileShadowShares, m.tileShadowSpread, m.subjectKeyFillAdvantage]) {
    if (value !== null) assert.equal(value, Number(value.toFixed(3)))
  }
})
