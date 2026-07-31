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
  return pixels
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
  const pixels = sample(file, side)
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

  return {
    pixels: pixels.length,
    saturation: Number(saturation.toFixed(3)),
    brightness: Number(brightness.toFixed(3)),
    hues,
    distinctColours,
    greenShare: Number(green.toFixed(3)),
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
