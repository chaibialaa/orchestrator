import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

/**
 * What can be counted in a rendering, and what cannot.
 *
 * A visual objective is where this tool has bled the most: a score announced by
 * the session that produced the image is recorded as inconclusive, correctly,
 * and thirteen attempts on Atlas #11 produced no passing proof because of it.
 * The way out is not a better judge — it is separating the two questions.
 *
 *   Is it FINISHED?  Countable, and answered here. Below the floor, the work is
 *                    certainly not done, whatever anyone thinks of it.
 *   Is it GOOD?      Not countable, and not attempted here. That is the judging
 *                    conversation's call, looking at the image.
 *
 * These numbers set the floor. They cannot be gamed into meaning quality —
 * random noise scores well on colour variety — which is exactly why they are a
 * floor and not a verdict.
 */

/**
 * The one threshold below which a pixel is dark.
 *
 * Named rather than written twice. `shadowShare` and the per-tile dark shares
 * answer the same question at two scales — how much of this is in the dark —
 * and a second literal would let them drift apart on a later edit. Extracting it
 * changes no value: it is the 0.15 `shadowShare` has always compared against.
 */
const DARK = 0.15

/** Decode a PNG into pixels. No dependency: the format is small enough to read. */
function decodePng(file) {
  const data = readFileSync(file)
  let pos = 8
  let idat = Buffer.alloc(0)
  let width = 0
  let height = 0
  let colour = 0

  while (pos < data.length) {
    const length = data.readUInt32BE(pos)
    const type = data.toString('ascii', pos + 4, pos + 8)
    const chunk = data.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      colour = chunk[9]
    }
    if (type === 'IDAT') idat = Buffer.concat([idat, chunk])
    pos += 12 + length
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour]
  if (!channels) throw new Error(`unsupported PNG colour type ${colour}`)

  const raw = inflateSync(idat)
  const stride = width * channels
  const pixels = []
  let prev = Buffer.alloc(stride)
  let i = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[i++]
    const line = Buffer.from(raw.subarray(i, i + stride))
    i += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + a) & 255
      else if (filter === 2) line[x] = (line[x] + b) & 255
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    for (let x = 0; x < stride; x += channels) pixels.push([line[x], line[x + 1], line[x + 2]])
    prev = line
  }
  // The dimensions travel with the pixels. A flat list was enough while every
  // measure was a global scalar; a measure that says WHERE cannot be computed
  // from a list that has forgotten how wide it is.
  return { pixels, width, height }
}

/** Downscale first: we are measuring composition, not compression artefacts. */
function sample(file, side = 96) {
  if (!existsSync(file)) throw new Error(`no such image: ${file}`)
  const out = join(mkdtempSync(join(tmpdir(), 'orch-visual-')), 'sample.png')
  execFileSync('/usr/bin/sips', ['-z', String(side), String(side), '-s', 'format', 'png', file, '--out', out], {
    stdio: 'ignore',
    timeout: 20000,
  })
  return decodePng(out)
}

/**
 * WHERE the dark and the light sit, which no global scalar can say.
 *
 * `shadowShare` = 0.104 does not tell a wall left in the dark against a lit
 * façade from a grey veil laid evenly over the whole frame. The two images carry
 * the same number and only one of them has any tension in it. What follows keeps
 * the same axis of value and the same dark threshold as the six frozen measures,
 * and only stops throwing the position away.
 *
 * The grid is 8 × 8 and is NOT reachable from the command line. A grid figure a
 * caller could vary at the moment of proving is a lever for choosing the result
 * afterwards.
 */
export const TENSION_GRID = 4
const LEGACY_DIAGNOSTIC_GRID = 8

/** The value axis of `toHsv`, on its own: v = max(R, G, B) / 255. */
const lumaOf = (r, g, b) => Math.max(r, g, b) / 255

const round3 = (x) => Number(x.toFixed(3))

/**
 * Ascending median, mean of the two central values on an even count.
 *
 * Not the rank convention of `at(q)` used by `contrast`: the ratio below divides
 * two medians, and picking a rank makes the quotient jump by a whole
 * quantisation step the moment one pixel crosses the middle. `at()` is neither
 * called nor touched here.
 */
function median(values) {
  if (!values.length) return null
  const v = Float64Array.from(values).sort()
  const n = v.length
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2
}

/** Rank percentile used by the frozen contrast metric: sorted[floor(q*n)]. */
function percentile(values, q) {
  if (!values.length) return null
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function darkShares(lumas, width, height, grid) {
  const edge = (i, n) => Math.floor((i * n) / grid)
  const shares = new Float64Array(grid * grid)
  for (let row = 0; row < grid; row++) {
    const y0 = edge(row, height)
    const y1 = edge(row + 1, height)
    for (let col = 0; col < grid; col++) {
      const x0 = edge(col, width)
      const x1 = edge(col + 1, width)
      let count = 0
      let dark = 0
      for (let y = y0; y < y1; y++) {
        const base = y * width
        for (let x = x0; x < x1; x++) {
          count++
          if (lumas[base + x] < DARK) dark++
        }
      }
      shares[row * grid + col] = count ? dark / count : 0
    }
  }
  return shares
}

/**
 * The spatial measures, on an already-decoded frame.
 *
 * Separated from `measureImage` so the numbers can be tested against arithmetic
 * a person can do by hand, on frames built pixel by pixel, rather than only
 * against renderings whose expected values nobody can derive.
 */
export function tensionMetrics(pixels, width, height) {
  const G = LEGACY_DIAGNOSTIC_GRID
  // Floor-partition: the upper bound of one tile is the lower bound of the next,
  // and ⌊8·W/8⌋ = W. Every pixel lands in exactly one tile whether or not the
  // side divides by 8; tiles then differ in size by at most one pixel, and each
  // dark share is divided by its OWN tile's count.
  const edge = (i, n) => Math.floor((i * n) / G)

  const lumas = new Float64Array(pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]
    lumas[i] = lumaOf(p[0], p[1], p[2])
  }

  // #50 contractual shadow axis: a fixed 4×4 row-major grid and the exact
  // max-minus-min range of the sixteen unrounded per-tile dark shares.
  const shadowShares = darkShares(lumas, width, height, TENSION_GRID)
  const tileShadowSpread = shadowShares.length
    ? Math.max(...shadowShares) - Math.min(...shadowShares)
    : 0

  // #50 contractual subject-vs-frame axis. The subject is the central third
  // on each axis; the frame is its complement. Percentiles use the same rank
  // convention as frozen contrast, and epsilon is one 8-bit code value.
  const subject = []
  const surroundingFrame = []
  const sx0 = Math.floor(width / 3)
  const sx1 = Math.floor((2 * width) / 3)
  const sy0 = Math.floor(height / 3)
  const sy1 = Math.floor((2 * height) / 3)
  for (let y = 0; y < height; y++) {
    const base = y * width
    for (let x = 0; x < width; x++) {
      const target = x >= sx0 && x < sx1 && y >= sy0 && y < sy1 ? subject : surroundingFrame
      target.push(lumas[base + x])
    }
  }
  const keyFill = (region) => {
    const p90 = percentile(region, 0.9)
    const p10 = percentile(region, 0.1)
    if (p90 === null || p10 === null) return null
    const epsilon = 1 / 255
    return Math.log2(p90 + epsilon) - Math.log2(p10 + epsilon)
  }
  const subjectKeyFill = keyFill(subject)
  const frameKeyFill = keyFill(surroundingFrame)
  const subjectKeyFillAdvantage =
    subjectKeyFill === null || frameKeyFill === null ? null : subjectKeyFill - frameKeyFill

  const shares = new Float64Array(G * G)
  let brightest = null

  for (let row = 0; row < G; row++) {
    const y0 = edge(row, height)
    const y1 = edge(row + 1, height)
    for (let col = 0; col < G; col++) {
      const x0 = edge(col, width)
      const x1 = edge(col + 1, width)
      const tile = []
      let dark = 0
      for (let y = y0; y < y1; y++) {
        const base = y * width
        for (let x = x0; x < x1; x++) {
          const v = lumas[base + x]
          tile.push(v)
          if (v < DARK) dark++
        }
      }
      // An empty tile — only reachable below 8 pixels a side — keeps its slot in
      // the array of 64 at a share of 0, and stands for no median at all.
      shares[row * G + col] = tile.length ? dark / tile.length : 0
      const m = median(tile)
      if (m !== null && (brightest === null || m > brightest)) brightest = m
    }
  }

  // Population, not sample: the 64 tiles are not drawn from a wider population
  // whose spread we would be estimating. They ARE the population.
  let mean = 0
  for (const s of shares) mean += s
  mean /= shares.length
  let variance = 0
  for (const s of shares) variance += (s - mean) ** 2
  variance /= shares.length

  const frame = median(lumas)
  // `null` and not 0 on a frame crushed to black: this is the convention the
  // ratios of `compareToReference` already follow, and 0 would make "the frame
  // is black" indistinguishable from "the brightest tile is as dark as the
  // frame", which are opposite images.
  const ratio = frame && brightest !== null ? brightest / frame : null

  return {
    tileShadowShares: Array.from(shadowShares, round3),
    tileShadowSpread: round3(tileShadowSpread),
    subjectKeyFillAdvantage:
      subjectKeyFillAdvantage === null ? null : round3(subjectKeyFillAdvantage),
    // Legacy diagnostics retained additively for consumers of the first #51
    // pass. They are not contractual tension axes after the 2026-08-05 review.
    tileDarkShares: Array.from(shares, round3),
    tileDarkStd: round3(Math.sqrt(variance)),
    frameMedianLuma: frame === null ? null : round3(frame),
    brightestTileMedianLuma: brightest === null ? null : round3(brightest),
    brightestTileMedianRatio: ratio === null ? null : round3(ratio),
  }
}

/**
 * How the tension moved between two renderings of the SAME camera.
 *
 * Signed, and deliberately not absolute: tension that rises and tension that
 * falls are not the same fact, and a floor on an absolute value would accept a
 * regression it was written to refuse.
 *
 * Computed on the PUBLISHED values of each image — already at the thousandth —
 * so the delta is exactly the subtraction of the two numbers a reader can see in
 * the archived JSON, rather than a third number only the code can reproduce.
 *
 * Nothing here checks that the two frames come from one camera. Pixels cannot
 * establish that, and guessing it is worse than leaving it to the caller.
 */
export function tensionDelta(current, reference) {
  const d = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : round3(a - b))
  return {
    deltaTileDarkStd: d(current.tileDarkStd, reference.tileDarkStd),
    deltaBrightestTileMedianRatio: d(current.brightestTileMedianRatio, reference.brightestTileMedianRatio),
  }
}

const toHsv = (r, g, b) => {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const d = max - min
  let h = 0
  if (d) {
    if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6
    else if (max === G) h = ((B - R) / d + 2) / 6
    else h = ((R - G) / d + 4) / 6
  }
  return [h, max ? d / max : 0, max]
}

/**
 * Measure one rendering.
 *
 * `distinctColours` is the one that discriminates. Measured on three images of
 * the same scene, the share of green pixels was 30.8% at the starting point and
 * 31.2% on the target — so "it needs more vegetation" was simply false. Distinct
 * colours went 564 → 1889. What was missing was not green; it was variety
 * within it, which is what detail, materials and lighting produce.
 */
export function measureImage(file, side = 96) {
  const { pixels, width, height } = sample(file, side)
  if (side === 96 && (width !== 96 || height !== 96 || pixels.length !== 9216)) {
    throw new Error(`visual sample invariant failed: expected 96x96/9216, got ${width}x${height}/${pixels.length}`)
  }
  const hsv = pixels.map(([r, g, b]) => toHsv(r, g, b))

  const saturation = hsv.reduce((n, [, s]) => n + s, 0) / hsv.length
  const brightness = hsv.reduce((n, [, , v]) => n + v, 0) / hsv.length

  const buckets = new Map()
  for (const [h, s, v] of hsv) {
    if (s <= 0.15 || v <= 0.1) continue
    const k = Math.floor(h * 24)
    buckets.set(k, (buckets.get(k) ?? 0) + 1)
  }
  const hues = [...buckets.values()].filter((n) => n > pixels.length * 0.005).length

  // Quantised to 5 bits a channel: two shades a person cannot tell apart should
  // not count as two colours.
  const distinctColours = new Set(pixels.map(([r, g, b]) => `${r >> 3},${g >> 3},${b >> 3}`)).size

  const green = pixels.filter(([r, g, b]) => g > r + 12 && g > b + 12).length / pixels.length

  /**
   * The value range — the axis that carries "tension", and the one nothing here
   * could measure.
   *
   * A session complained that an atmosphere lacked tension, and every measure
   * this file had was about colour: an image can be saturated, varied, eleven
   * hues, and still read flat, because tension in a picture is contrast of VALUE
   * — deep shadow against light, not more colours. Written on a criterion, the
   * palette measures would have passed while the complaint stood.
   *
   * Three numbers rather than one, on purpose, and none of them a score:
   * `contrast` is the spread between the dark and light ends (p95 − p5, immune to
   * a single blown pixel), `shadowShare` and `highlightShare` say where the
   * pixels actually sit. A flat scene has a narrow spread and almost nothing at
   * either end; a tense one puts weight in the dark and keeps a light edge.
   */
  const values = hsv.map(([, , v]) => v).sort((a, b) => a - b)
  const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0
  const contrast = at(0.95) - at(0.05)
  const shadowShare = values.filter((v) => v < DARK).length / values.length
  const highlightShare = values.filter((v) => v > 0.85).length / values.length

  return {
    pixels: pixels.length,
    saturation: Number(saturation.toFixed(3)),
    brightness: Number(brightness.toFixed(3)),
    /** p95 − p5 of value: how far the image travels between its dark and light ends. */
    contrast: Number(contrast.toFixed(3)),
    shadowShare: Number(shadowShare.toFixed(3)),
    highlightShare: Number(highlightShare.toFixed(3)),
    hues,
    distinctColours,
    greenShare: Number(green.toFixed(3)),
    // Added beside the six, never inside them: the frozen numbers above are
    // computed by exactly the loops that produced them before, on the same
    // sample, and a replay of the baseline has to give them back to the
    // thousandth on every line of the corpus.
    ...tensionMetrics(pixels, width, height),
  }
}

/**
 * How far a rendering is from a reference, per measure.
 *
 * Deliberately NOT a single score. One number invites "we are at 72/100", which
 * is what a session then announces about its own work — and a single number
 * cannot say which of six things is missing. Each ratio names its own gap.
 */
export function compareToReference(image, reference, side = 96) {
  const got = measureImage(image, side)
  const want = measureImage(reference, side)

  const ratio = (a, b) => (b ? Number((a / b).toFixed(3)) : null)

  return {
    image: got,
    reference: want,
    ratios: {
      saturation: ratio(got.saturation, want.saturation),
      brightness: ratio(got.brightness, want.brightness),
      hues: ratio(got.hues, want.hues),
      distinctColours: ratio(got.distinctColours, want.distinctColours),
      greenShare: ratio(got.greenShare, want.greenShare),
    },
    // Stated, not implied: someone will otherwise read these ratios as a verdict.
    caveat:
      'These bound the floor, not the quality. Random noise scores well on colour variety. ' +
      'Below the floor the work is certainly unfinished; above it, whether it is right is a ' +
      'judgement, and belongs to whoever is looking at the image.',
  }
}
