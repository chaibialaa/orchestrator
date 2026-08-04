import { test } from 'node:test'
import assert from 'node:assert/strict'

const { tensionMetrics, tensionDelta, TENSION_GRID } = await import('../src/visual.js')

/**
 * The spatial measures, checked against arithmetic a person can redo by hand.
 *
 * These frames are built pixel by pixel rather than read from a rendering, and
 * that is the point: the expected values below are derived from the formula, not
 * copied from what the code happened to print. A test whose expectation is the
 * previous output only proves the code has not changed — not that it is right.
 */

const grey = (n) => [n, n, n]
const frame = (w, h, at) => {
  const px = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.push(at(x, y))
  return px
}
/** One pixel per tile: the grid is 8 × 8, so an 8 × 8 frame makes tile = pixel. */
const eight = (at) => frame(8, 8, at)

const finite = (m) => {
  for (const s of m.tileDarkShares) assert.ok(Number.isFinite(s), `share ${s} is not finite`)
  for (const k of ['tileDarkStd', 'frameMedianLuma', 'brightestTileMedianLuma', 'brightestTileMedianRatio']) {
    const v = m[k]
    assert.ok(v === null || Number.isFinite(v), `${k} = ${v} is neither null nor finite`)
    assert.ok(!Number.isNaN(v), `${k} is NaN`)
  }
}

test('the grid is 8 × 8 and is not reachable from outside', () => {
  assert.equal(TENSION_GRID, 8)
  const m = tensionMetrics(eight(() => grey(0)), 8, 8)
  assert.equal(m.tileDarkShares.length, 64, '64 tiles, one array entry each')
})

test('a uniformly dark frame is dark everywhere and spread nowhere', () => {
  // Every tile at share 1: the metric measures PLACEMENT, so a frame with no
  // placement scores zero however dark it is. A crushed image must not be able
  // to buy tension by being black.
  const m = tensionMetrics(eight(() => grey(0)), 8, 8)
  assert.deepEqual([...new Set(m.tileDarkShares)], [1], 'every tile fully dark')
  assert.equal(m.tileDarkStd, 0)
  finite(m)
})

test('a uniformly light frame is the same nothing, from the other end', () => {
  const m = tensionMetrics(eight(() => grey(255)), 8, 8)
  assert.deepEqual([...new Set(m.tileDarkShares)], [0])
  assert.equal(m.tileDarkStd, 0)
  assert.equal(m.frameMedianLuma, 1)
  assert.equal(m.brightestTileMedianLuma, 1)
  assert.equal(m.brightestTileMedianRatio, 1)
  finite(m)
})

test('alternating dark and light tiles reach the theoretical maximum spread', () => {
  // 32 tiles at 1 and 32 at 0: mean = 0.5, variance = 0.25, population σ = 0.5 —
  // the largest value the metric can take, and the one that proves the divisor
  // is 64 and not 63. With Bessel's correction σ would be 0.50395, not 0.5.
  const m = tensionMetrics(eight((x, y) => grey((x + y) % 2 ? 255 : 0)), 8, 8)
  assert.equal(m.tileDarkStd, 0.5)
  assert.equal(m.tileDarkShares.filter((s) => s === 1).length, 32)
  assert.equal(m.tileDarkShares.filter((s) => s === 0).length, 32)
  finite(m)
})

test('a single light tile on a dark frame — every number by hand', () => {
  // Background at 25/255 = 0.098, below the 0.15 dark threshold; tile 0 is a
  // single white pixel.
  //   shares          : tile 0 = 0, the other 63 = 1
  //   mean            : 63/64 = 0.984375
  //   variance        : (63·(1/64)² + (63/64)²)/64 = 0.01538086
  //   σ               : 0.1240196…            → 0.124
  //   frame median    : 63 values at 0.098 and one at 1 → 25/255 = 0.098039…
  //   brightest tile  : 1 (tile 0 holds only the white pixel)
  //   ratio           : 255/25 = 10.2 exactly
  const m = tensionMetrics(
    eight((x, y) => (x === 0 && y === 0 ? grey(255) : grey(25))),
    8,
    8,
  )
  assert.equal(m.tileDarkShares[0], 0)
  assert.equal(m.tileDarkShares.filter((s) => s === 1).length, 63)
  assert.equal(m.tileDarkStd, 0.124)
  assert.equal(m.frameMedianLuma, 0.098)
  assert.equal(m.brightestTileMedianLuma, 1)
  assert.equal(m.brightestTileMedianRatio, 10.2)
  finite(m)
})

test('a deterministic gradient, every number by hand', () => {
  // Column c carries grey 32·c, so v = 32c/255. Dark means v < 0.15, i.e.
  // 32c < 38.25, i.e. columns 0 and 1 only.
  //   shares       : 16 tiles at 1 (two columns × 8 rows), 48 at 0
  //   mean         : 0.25
  //   variance     : (16·0.75² + 48·0.25²)/64 = 12/64 = 0.1875
  //   σ            : 0.4330127…                        → 0.433
  //   frame median : 64 values, 8 per level; ranks 31 and 32 are 96/255 and
  //                  128/255 → (96+128)/2/255 = 112/255 = 0.439216…
  //   brightest    : 224/255 = 0.878431…
  //   ratio        : 224/112 = 2 exactly
  const m = tensionMetrics(eight((x) => grey(32 * x)), 8, 8)
  assert.equal(m.tileDarkShares.filter((s) => s === 1).length, 16)
  assert.equal(m.tileDarkStd, 0.433)
  assert.equal(m.frameMedianLuma, 0.439)
  assert.equal(m.brightestTileMedianLuma, 0.878)
  assert.equal(m.brightestTileMedianRatio, 2)
  finite(m)
})

test('the median of an even count is the mean of the two central values', () => {
  // Four pixels in one row of a 1-pixel-tall frame is not enough to exercise the
  // grid, so this rides on the frame median of a 8 × 8 half-and-half image:
  // 32 pixels at 100/255 and 32 at 200/255 → (100+200)/2/255 = 150/255 = 0.588.
  // A rank convention would give 200/255 = 0.784 instead.
  const m = tensionMetrics(
    eight((x, y) => (y < 4 ? grey(100) : grey(200))),
    8,
    8,
  )
  assert.equal(m.frameMedianLuma, 0.588)
  finite(m)
})

test('dimensions not divisible by 8 still partition exactly, tile by tile', () => {
  // 10 wide over 8 columns: the floor partition gives widths 1,1,1,2,1,1,1,2 —
  // ten pixels, no overlap, no gap. Column 3 covers x ∈ [3,5).
  // Everything is dark except the pixel at (4,0), which sits in tile 3 and makes
  // its share 1/2 — which only comes out right if the denominator is that tile's
  // own pixel count and not a global constant.
  const m = tensionMetrics(
    frame(10, 8, (x, y) => (x === 4 && y === 0 ? grey(255) : grey(0))),
    10,
    8,
  )
  assert.equal(m.tileDarkShares.length, 64)
  assert.equal(m.tileDarkShares[3], 0.5, 'the wide tile carries one light pixel out of two')
  const others = m.tileDarkShares.filter((_, i) => i !== 3)
  assert.deepEqual([...new Set(others)], [1], 'every other tile is entirely dark')
  finite(m)
})

test('a frame smaller than the grid leaves empty tiles, and stays defined', () => {
  // 4 wide: columns 0, 2, 4 and 6 come out empty. The array keeps its 64 slots,
  // an empty tile has a share of 0, and it competes for nothing.
  const m = tensionMetrics(frame(4, 4, () => grey(255)), 4, 4)
  assert.equal(m.tileDarkShares.length, 64)
  assert.equal(m.brightestTileMedianLuma, 1, 'the non-empty tiles still have a median')
  finite(m)
})

test('a black frame returns null rather than Infinity or NaN', () => {
  // The division-by-zero case, and the reason it is `null`: 0 would make "the
  // frame is crushed to black" read exactly like "the brightest tile is as dark
  // as the frame", which are opposite pictures. `null` is what the ratios of
  // compareToReference already do on a zero denominator.
  const m = tensionMetrics(eight(() => grey(0)), 8, 8)
  assert.equal(m.frameMedianLuma, 0)
  assert.equal(m.brightestTileMedianLuma, 0)
  assert.equal(m.brightestTileMedianRatio, null)
  assert.notEqual(m.brightestTileMedianRatio, Infinity)
  finite(m)
})

test('two identical frames give deltas of exactly zero', () => {
  const a = tensionMetrics(eight((x) => grey(32 * x)), 8, 8)
  const b = tensionMetrics(eight((x) => grey(32 * x)), 8, 8)
  const d = tensionDelta(a, b)
  assert.equal(d.deltaTileDarkStd, 0)
  assert.equal(d.deltaBrightestTileMedianRatio, 0)
  // Exactly zero, not merely close: a "nothing moved" that reads as 0.0001 is
  // the failure this whole module exists to remove.
  assert.ok(Object.is(d.deltaTileDarkStd, 0) || d.deltaTileDarkStd === 0)
})

test('a known pair gives signed deltas, and the sign is kept', () => {
  const flat = tensionMetrics(eight(() => grey(255)), 8, 8) // std 0, ratio 1
  const gradient = tensionMetrics(eight((x) => grey(32 * x)), 8, 8) // std 0.433, ratio 2

  const up = tensionDelta(gradient, flat)
  assert.equal(up.deltaTileDarkStd, 0.433)
  assert.equal(up.deltaBrightestTileMedianRatio, 1)

  const down = tensionDelta(flat, gradient)
  assert.equal(down.deltaTileDarkStd, -0.433, 'a fall is negative, not an absolute value')
  assert.equal(down.deltaBrightestTileMedianRatio, -1)
})

test('a delta against a null ratio is null, not a number', () => {
  const black = tensionMetrics(eight(() => grey(0)), 8, 8)
  const lit = tensionMetrics(eight((x) => grey(32 * x)), 8, 8)
  assert.equal(black.brightestTileMedianRatio, null)
  assert.equal(tensionDelta(lit, black).deltaBrightestTileMedianRatio, null)
  assert.equal(tensionDelta(black, lit).deltaBrightestTileMedianRatio, null)
  // The dark-share side is still measurable and must not be dragged to null by
  // the other one. A black frame has every tile at share 1, so its spread is 0.
  assert.equal(black.tileDarkStd, 0)
  assert.equal(tensionDelta(lit, black).deltaTileDarkStd, 0.433)
})

test('the same frame measured twice gives the same numbers', () => {
  const build = () => eight((x, y) => grey((x * 29 + y * 7) % 256))
  const a = tensionMetrics(build(), 8, 8)
  const b = tensionMetrics(build(), 8, 8)
  assert.deepEqual(a, b, 'no ordering, no accumulator and no clock leaks into the result')
})

test('every published number is stable at the thousandth', () => {
  const m = tensionMetrics(eight((x, y) => grey((x * 31 + y * 17) % 256)), 8, 8)
  const round3 = (v) => Number(v.toFixed(3))
  for (const s of m.tileDarkShares) assert.equal(s, round3(s))
  for (const k of ['tileDarkStd', 'frameMedianLuma', 'brightestTileMedianLuma', 'brightestTileMedianRatio']) {
    if (m[k] !== null) assert.equal(m[k], round3(m[k]), `${k} carries more than three decimals`)
  }
})
