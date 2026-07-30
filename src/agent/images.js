import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { attach } from './relay.js'

/**
 * Image generation through web interfaces. This is the most fragile piece of the
 * tool and it should be said plainly: these sites have no API, we drive their
 * page. A redesign of their interface breaks the adapter — not silently, it
 * shows up here, but it breaks it.
 *
 * The strategy is therefore deliberately GENERIC rather than bespoke: find the
 * input field, send, wait for an image that was not there before, fetch it. The
 * fewer precise selectors we depend on, the longer it survives.
 */

export const ADAPTERS = {
  'nano-banana': {
    label: 'Nano Banana',
    url: 'https://gemini.google.com/app',
    match: 'gemini.google.com',
    // What counts as a result: an image big enough to be a rendering, not an
    // avatar and not an interface icon.
    minSize: 256,
  },
  'gpt-web': {
    label: 'GPT (web)',
    url: 'https://chatgpt.com/',
    match: 'chatgpt.com',
    minSize: 256,
  },
}

/** The input field, found through what chat interfaces have in common. */
const JS_TYPE = (text) => `
(() => {
  const box =
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('textarea:not([readonly]):not([disabled])') ||
    document.querySelector('[role="textbox"]');
  if (!box) return 'no input field';

  box.focus();
  const t = ${JSON.stringify(text)};

  if (box.tagName === 'TEXTAREA') {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(box, t);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    box.textContent = '';
    document.execCommand('insertText', false, t);
    if (!box.textContent) {
      box.textContent = t;
      box.dispatchEvent(new InputEvent('input', { bubbles: true, data: t }));
    }
  }
  return 'ok';
})()`

const JS_SEND = `
(() => {
  const box =
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('textarea:not([readonly]):not([disabled])') ||
    document.querySelector('[role="textbox"]');
  if (!box) return 'no field';
  box.focus();
  for (const type of ['keydown', 'keypress', 'keyup']) {
    box.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
  }
  return 'sent';
})()`

/** The images present, above a size — to compare before and after. */
const JS_IMAGES = (min) => `
(() => {
  const seen = [...document.images]
    .filter((i) => i.naturalWidth >= ${min} && i.naturalHeight >= 128)
    .map((i) => i.currentSrc || i.src)
    .filter((s) => s && !s.startsWith('data:image/svg'));
  return JSON.stringify([...new Set(seen)]);
})()`

/**
 * Brings back the image ALREADY DISPLAYED rather than re-downloading it. A
 * `fetch` on a `blob:` URL created by the page fails — verified, "Failed to
 * fetch" — and re-downloading risks getting something other than what we saw
 * anyway. We paint the element onto a canvas and read the pixels.
 */
const JS_DOWNLOAD = (src) => `
(async () => {
  try {
    const img = [...document.images].find((i) => (i.currentSrc || i.src) === ${JSON.stringify(src)});
    if (!img) return JSON.stringify({ error: 'the image left the page' });
    if (!img.complete) await img.decode();

    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);

    const url = c.toDataURL('image/png');
    return JSON.stringify({
      type: 'image/png',
      b64: url.slice(url.indexOf(',') + 1),
      width: c.width,
      height: c.height,
    });
  } catch (e) {
    return JSON.stringify({ error: String(e).slice(0, 200) });
  }
})()`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Asks for an image and waits for it to appear. Returns the path written.
 * Never claims success: with no new image, it says so.
 */
export async function generateImage({
  tool = 'nano-banana',
  prompt,
  out,
  maxWaitMs = 240000,
  port,
} = {}) {
  const adapter = ADAPTERS[tool]
  if (!adapter) {
    throw new Error(`Unknown image tool: ${tool}. Known: ${Object.keys(ADAPTERS).join(', ')}`)
  }
  if (!prompt?.trim()) throw new Error('Empty prompt.')

  const page = await attach(adapter.match, port)

  const before = new Set(JSON.parse(await page.evaluate(JS_IMAGES(adapter.minSize))))

  const typed = await page.evaluate(JS_TYPE(prompt))
  if (typed !== 'ok') throw new Error(`${adapter.label}: ${typed}`)
  await sleep(400)
  await page.evaluate(JS_SEND)

  // We wait for an image that is both NEW and STABLE: these interfaces often
  // show a low-resolution version before the real one. Concluding on the first
  // would yield a degraded proof with nobody noticing.
  const started = Date.now()
  let candidate = null
  let stableFor = 0

  while (Date.now() - started < maxWaitMs) {
    await sleep(2500)
    const now = JSON.parse(await page.evaluate(JS_IMAGES(adapter.minSize)))
    const fresh = now.filter((s) => !before.has(s))

    if (!fresh.length) {
      candidate = null
      continue
    }

    const last = fresh.at(-1)
    if (last === candidate) {
      stableFor += 2500
      if (stableFor >= 5000) break
    } else {
      candidate = last
      stableFor = 0
    }
  }

  if (!candidate) {
    // Telling "nothing was sent" from "it answered without an image": the second
    // is a refusal from the service — quota, free plan, a model that comments
    // instead of producing — and that is not fixable in code.
    const answered = await page.evaluate(
      `(() => document.body.innerText.slice(-1200).includes(${JSON.stringify(prompt.slice(0, 40))}))()`,
    )
    throw new Error(
      answered
        ? `${adapter.label} received the request but produced no image in ` +
          `${Math.round(maxWaitMs / 1000)} s. That is a refusal from the service, not a driver fault: ` +
          `quota reached, free plan, or a model that replied in text. Look at the tab.`
        : `${adapter.label}: the request never even left. Check the tab is open and signed in.`,
    )
  }

  // A heavy image takes time to cross: give it the time.
  const raw = JSON.parse(await page.evaluate(JS_DOWNLOAD(candidate), { timeoutMs: 180000 }))
  if (raw.error) throw new Error(`Download failed: ${raw.error}`)

  const bytes = Buffer.from(raw.b64, 'base64')
  const path = out ?? `image-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)

  return {
    path,
    bytes: bytes.length,
    type: raw.type,
    width: raw.width,
    height: raw.height,
    source: candidate,
    tool,
  }
}
