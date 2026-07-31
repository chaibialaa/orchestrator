import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const { measureImage, compareToReference } = await import('../src/visual.js')

// Two images written by test/fixtures/make.js: same masses, same green share,
// one flat and one varied. The first version of this test read images from the
// conversation's cache, which is swept — so it silently skipped and protected
// nothing. A test that depends on a file somebody else's housekeeping deletes is
// not a test.
const here = dirname(fileURLToPath(import.meta.url))
const FLAT = join(here, 'fixtures/flat.png')
const VARIED = join(here, 'fixtures/varied.png')

test('colour variety discriminates where the obvious measure does not', () => {
  // The finding this module exists for. On three real renderings of one scene the
  // share of green was 30.8% at the starting point and 31.2% on the target — so
  // "it needs more vegetation" was false, and a criterion written on it would
  // have passed on day one. Distinct colours told the real story: 564 to 1889.
  // The fixtures reproduce exactly that: identical green, variety far apart.
  const flat = measureImage(FLAT)
  const varied = measureImage(VARIED)

  assert.equal(flat.greenShare, varied.greenShare, 'green cannot tell them apart')
  assert.ok(varied.distinctColours > flat.distinctColours * 2, 'variety can')
})

test('the comparison names each gap rather than averaging them away', () => {
  // One number invites "we are at 72/100", which is what a session then announces
  // about its own work — and it cannot say WHICH of six things is missing.
  const c = compareToReference(FLAT, VARIED)
  assert.ok(c.ratios.distinctColours < 0.5, 'variety is far off')
  assert.equal(c.ratios.greenShare, 1, 'and greenery is already there')
  assert.equal(typeof c.caveat, 'string', 'the limit of the measure travels with it')
})
