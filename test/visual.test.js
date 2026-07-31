import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const { measureImage, compareToReference } = await import('../src/visual.js')

const CACHE = '/Users/macbook/.claude/image-cache/b3c9ebee-6e9d-4ef6-a3db-f9bb4c58ee71'
const START = `${CACHE}/12.png`
const TARGET = `${CACHE}/11.png`
const available = existsSync(START) && existsSync(TARGET)

test('colour variety discriminates where the obvious measure does not', { skip: !available }, () => {
  // The finding this module exists for. On the same scene, the share of green
  // pixels was 30.8% at the starting point and 31.2% on the target — so "it needs
  // more vegetation" was simply false, and any criterion written on it would have
  // passed on day one. Distinct colours told the real story: 564 against 1889.
  const start = measureImage(START)
  const target = measureImage(TARGET)

  assert.ok(
    Math.abs(start.greenShare - target.greenShare) < 0.05,
    'green share cannot tell these two apart',
  )
  assert.ok(
    target.distinctColours > start.distinctColours * 2,
    'colour variety can: it is where the gap actually is',
  )
})

test('the comparison names each gap rather than averaging them away', { skip: !available }, () => {
  // One number invites "we are at 72/100", which is what a session then announces
  // about its own work. It also cannot say WHICH of six things is missing.
  const c = compareToReference(START, TARGET)
  assert.ok(c.ratios.distinctColours < 0.5, 'variety is far off')
  assert.ok(c.ratios.greenShare > 0.9, 'and greenery is already there')
  assert.equal(typeof c.caveat, 'string', 'the limit of the measure travels with it')
})
