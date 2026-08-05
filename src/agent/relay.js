import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The relay — a bridge between a ChatGPT conversation and the local harnesses.
 *
 * It goes through Chrome's DevTools protocol, on the user's already-open and
 * already-signed-in tab. Nothing is stored, nothing is sent anywhere except into
 * the designated conversation.
 *
 * IMPORTANT — trust boundary: what GPT says is a REQUEST for work, never a
 * command to run. The text goes to a code harness, which remains subject to the
 * blast radius, the rule pack and the proof gate. The relay short-circuits no
 * guard.
 */

const CDP_PORT = 9222

/**
 * The profile the tool drives. Never the one you browse with.
 *
 * Launching Chrome on a personal profile with a debugging port would reopen
 * somebody's windows under a socket any local process can talk to. This one is
 * separate, holds only the signed-in conversation, and the port binds to
 * 127.0.0.1 — it is not reachable from the network.
 */
const CHROME_PROFILE = join(homedir(), '.chrome-orchestrator')

/**
 * Where Chrome is, asked of the machine rather than assumed.
 *
 * This was one hard-coded macOS path, which is a fine assumption right up to the
 * moment somebody installs the package from npm on Linux — and then the loop
 * fails at the only step nobody thinks to check, with a message about a file
 * that does not exist. The order matters: an explicit choice wins, then the
 * platform's usual homes, then whatever is on the PATH.
 */
const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
}

function chromeBinary() {
  if (process.env.ORCHESTRATOR_CHROME) return process.env.ORCHESTRATOR_CHROME

  for (const p of CHROME_CANDIDATES[process.platform] ?? []) if (existsSync(p)) return p

  // Last resort: the PATH. On Windows `where`, everywhere else `command -v`.
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chrome']) {
    try {
      const found = execFileSync(
        process.platform === 'win32' ? 'where' : '/bin/sh',
        process.platform === 'win32' ? [name] : ['-c', `command -v ${name}`],
        { encoding: 'utf8', timeout: 3000 },
      )
        .trim()
        .split('\n')[0]
      if (found) return found
    } catch {
      /* not there — keep looking */
    }
  }
  return null
}

async function cdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

/**
 * Start the browser the loop drives, and wait for it to answer.
 *
 * This was the last thing left to a person, on the grounds that starting a
 * browser is a decision about the machine. It is not: the profile is dedicated,
 * the session inside it is already signed in, and a loop that stops at three in
 * the morning because a window was closed is not unattended. Signing in stays
 * yours — that one really is a decision, and a password is never mine to type.
 */
async function startBrowser(port) {
  const bin = chromeBinary()
  if (!bin) return false
  spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      /**
       * Chrome throttles what it thinks nobody is watching.
       *
       * Two projects mean two conversation tabs, and only one can be in front:
       * the other has its timers slowed and its renderer backgrounded, so a
       * `Runtime.evaluate` that answers in a second when visible takes longer
       * than the two-minute ceiling when it is not. Both runs stalled at turn 1
       * on a browser that was reachable, signed in, and holding both
       * conversations — the page was not broken, it was asleep.
       */
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Restoring tabs would reopen whatever was on screen when it last died,
      // which is noise the loop then has to search through.
      '--hide-crash-restore-bubble',
    ],
    { detached: true, stdio: 'ignore' },
  ).unref()

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const up = await cdpTargets(port).then(
      () => true,
      () => false,
    )
    if (up) return true
  }
  return false
}

/**
 * Opens a fresh tab and attaches to it.
 *
 * Renewing the driving conversation must not take over the tab someone is
 * reading. The new tab is the orchestrator's; the old one stays where it was.
 */
/**
 * Is the judging browser there, and does it hold the conversation?
 *
 * The most fragile dependency of the whole tool had no presence anywhere: run 59
 * spent two hours reloading a page inside a Chrome that was not running, while
 * every screen showed a healthy `running`. It was found with a curl on 9222.
 *
 * Three separate facts, never merged into one boolean: a browser that is absent,
 * one that is open on nothing, and one that is signed out send a person to fix
 * three different things.
 */
export async function judgeHealth(port = CDP_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(4000),
  }).catch(() => null)

  if (!res?.ok) {
    return { reachable: false, tabs: 0, conversation: false, signed_in: null, port }
  }

  const tabs = await res.json().catch(() => [])
  const conversation = tabs.some((t) => /chatgpt\.com/.test(t.url ?? ''))

  return {
    reachable: true,
    tabs: tabs.length,
    conversation,
    // Asking a browser with no conversation whether it is signed in would answer
    // "no" about a question that was never put to it.
    signed_in: conversation ? await signedIn(port) : null,
    port,
  }
}

/** Start the browser the loop drives. Never signs in — that is the person's. */
export async function startJudgeBrowser(port = CDP_PORT) {
  const already = await judgeHealth(port)
  if (already.reachable) return { ok: true, detail: 'it was already listening', health: already }

  // `startBrowser` already waits for the port to answer, up to thirty seconds.
  if (!(await startBrowser(port))) {
    return { ok: false, detail: `no Chrome answered on port ${port} — is one installed?` }
  }
  return { ok: true, detail: 'it is listening', health: await judgeHealth(port) }
}

export async function openTab(url, port = CDP_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  }).catch(() => null)
  if (!res?.ok) {
    throw new Error(
      `Chrome refused to open a tab on port ${port}` +
        (res ? ` (HTTP ${res.status})` : ' — is it listening?'),
    )
  }
  const tab = await res.json()

  // The tab exists before the page has loaded; attaching by its exact id avoids
  // matching some other chatgpt.com tab that happens to be open.
  for (let i = 0; i < 40; i++) {
    const found = (await cdpTargets(port)).find((t) => t.id === tab.id && t.webSocketDebuggerUrl)
    if (found) return attachTo(found)
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('the tab was opened but never became attachable')
}

/**
 * Opens a DevTools session on the tab whose URL contains `match`.
 *
 * `openIfMissing` is the address to open when no tab matches. Somebody closing a
 * tab is not a decision about the work, and stopping the loop to ask for it back
 * is the kind of interruption this tool exists to remove — so when we know where
 * the conversation lives, we open it and carry on.
 */
async function attachOnce(match, port = CDP_PORT, { openIfMissing = null } = {}) {
  let targets
  try {
    targets = await cdpTargets(port)
  } catch {
    console.error(`    ! nothing on port ${port} — starting the browser`)
    if (!(await startBrowser(port))) {
      // Two different failures, and telling them apart is the whole message:
      // a browser that is missing needs installing, one that is present needs
      // starting — and the second is a line you can paste.
      const bin = chromeBinary()
      throw new Error(
        bin
          ? `Chrome is not listening on port ${port} and could not be started.\n` +
            `  Start it with:  "${bin}" --remote-debugging-port=${port} --user-data-dir=${CHROME_PROFILE}`
          : `No Chrome or Chromium found on this machine (looked in the usual places for ` +
            `${process.platform}, then on the PATH).\n` +
            `  Install one, or point at it: ORCHESTRATOR_CHROME=/path/to/chrome`,
      )
    }
    targets = await cdpTargets(port)
  }

  const tab = targets.find((t) => t.type === 'page' && t.url.includes(match))
  if (tab) return attachTo(tab)

  if (openIfMissing) {
    console.error(`    ! no tab on “${match}” — opening one`)
    return openTab(openIfMissing, port)
  }

  const pages = targets.filter((t) => t.type === 'page').map((t) => t.url.slice(0, 70))
  throw new Error(`no tab matches “${match}”.\n  Open tabs:\n    ${pages.join('\n    ')}`)
}

/**
 * A page that survives its tab being closed.
 *
 * The browser is shared: several projects drive one Chrome, and a third one
 * registering tonight opened its own thread and closed the other two. Both
 * running passes then spent an hour calling `reload()` on a dead connection —
 * a closed tab cannot be reloaded back to life, and the loop only ever reopened
 * its conversation when a run STARTED.
 *
 * So when an evaluate fails, this asks the browser whether the tab is still
 * there. If it is, the failure is real and travels on. If it is gone, the
 * conversation is reopened and the call is made once more. Reopening is not
 * signing in: the session is the person's and untouched.
 */
function survivable(inner, { match, port, openIfMissing }) {
  let cur = inner

  /**
   * Two ways a conversation stops being usable, and only one is a missing tab.
   *
   * A tab can also be LISTED and dead: the target answers `/json/list`, its title
   * and url are right, and its renderer no longer replies to `Runtime.evaluate`
   * at all. That is what happened to the third project tonight — every post
   * looked fine and nothing came back, on a tab that was demonstrably there.
   *
   * `absent` returns the target when it is present, so the caller can close a
   * corpse rather than reload it. Unreachable is neither: a browser that stopped
   * answering is a third failure, and reopening a tab inside it would fail too.
   */
  const cible = async () => {
    const cibles = await cdpTargets(port).catch(() => null)
    if (!cibles) return { joignable: false }
    const t = cibles.find((x) => x.type === 'page' && (x.url ?? '').includes(match))
    return { joignable: true, presente: Boolean(t), id: t?.id }
  }

  const rouvrir = async () => {
    if (!openIfMissing) return false
    const { joignable, presente, id } = await cible()
    if (!joignable) return false

    console.error(
      presente
        ? `    ! the tab on “${match}” is there and no longer answering — replacing it`
        : `    ! the tab on “${match}” is gone — reopening the conversation`,
    )

    try {
      cur.close()
    } catch {
      /* already gone, which is the point */
    }
    // A listed tab whose renderer is dead has to be CLOSED, or the next attach
    // finds it again by url and binds straight back onto the corpse.
    if (presente && id) {
      await fetch(`http://127.0.0.1:${port}/json/close/${id}`).catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
    }
    cur = await attachOnce(match, port, { openIfMissing })
    return true
  }

  return {
    get url() {
      return cur.url
    },
    close: () => cur.close(),
    reload: () => cur.reload(),
    evaluate: async (expression, opts) => {
      try {
        return await cur.evaluate(expression, opts)
      } catch (e) {
        if (await rouvrir()) return cur.evaluate(expression, opts)
        throw e
      }
    },
  }
}

export async function attach(match, port = CDP_PORT, options = {}) {
  const inner = await attachOnce(match, port, options)
  return survivable(inner, { match, port, openIfMissing: options.openIfMissing ?? null })
}

async function attachTo(tab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((ok, ko) => {
    ws.addEventListener('open', ok, { once: true })
    ws.addEventListener('error', () => ko(new Error('DevTools connection refused')), { once: true })
  })

  let seq = 0
  const pending = new Map()

  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    const resolve = pending.get(msg.id)
    if (resolve) {
      pending.delete(msg.id)
      resolve(msg)
    }
  })

  // The timeout is per call: pulling a multi-megabyte image back as base64 from
  // the page takes far more than thirty seconds, and failing on that would lose a
  // rendering already produced and already paid for.
  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} did not answer after ${timeoutMs / 1000} s`))
      }, timeoutMs)
    })

  /**
   * Reload the page and wait for it to be able to run script again.
   *
   * A tab whose renderer has wedged does not recover by being asked again more
   * politely — that is what waiting three times as long amounted to. Reloading
   * is the one thing that unwedges it, and it is safe here: the conversation
   * lives on ChatGPT's servers, so nothing posted is lost. Only the DOM comes
   * back, which is all we ever read.
   */
  const reload = async () => {
    await send('Page.enable', {}, 10000).catch(() => {})
    await send('Page.reload', { ignoreCache: false }, 10000).catch(() => {})
    // Wait for the CONVERSATION, not merely for script to run.
    //
    // Evaluating `1` succeeds the moment the renderer is alive, seconds before
    // React has drawn a single message — so the first read after a reload came
    // back with zero messages, and the loop would have concluded the thread was
    // empty. Caught by testing the reload rather than assuming it.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      const drawn = await send(
        'Runtime.evaluate',
        {
          expression: `document.querySelectorAll('[data-message-author-role]').length`,
          returnByValue: true,
        },
        5000,
      )
        .then((r) => Number(r.result?.result?.value) || 0)
        .catch(() => 0)
      if (drawn > 0) return true
    }
    return false
  }

  const evaluate = async (expression, { timeoutMs = 30000, retries = 1 } = {}) => {
    // Chrome answers when it feels like it. A page that has just swallowed six
    // attachments, or is re-rendering a nine-thousand-character reply, takes well
    // over the default timeout — and that rejection killed an hour of work and
    // $57 already spent, on a chapter whose verdict was never asked for. A slow
    // page is a transient, not a reason to abandon a run.
    //
    // But slow and wedged are different states, and treating them the same cost
    // two loops an afternoon: a tab that had stopped executing script was asked
    // again with a longer timeout, three times, and the run was abandoned after
    // six minutes of waiting on a page that was never going to answer. So the
    // second attempt reloads first. Nobody is asked to press anything.
    let last
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          timeoutMs,
        )
        if (r.result?.exceptionDetails) {
          throw new Error(r.result.exceptionDetails.text ?? 'JS error in the page')
        }
        return r.result?.result?.value
      } catch (e) {
        last = e
        // A JS error inside the page will fail identically every time; only a
        // timeout is worth another go.
        if (!/did not answer/.test(String(e.message))) throw e
        if (attempt < retries) {
          console.error('    ! the page stopped answering — reloading it')
          let back = await reload()

          /**
           * A reload that fails is usually the far end being busy, not broken.
           *
           * Measured here afterwards: the same conversation comes back in 3.6
           * seconds. So when sixty seconds of polling finds nothing, the page is
           * not gone — the service is refusing for a while. Giving up threw away
           * a pass that had already run, advanced, and cost $50; the report
           * simply never left. Two minutes of patience is cheaper than that by a
           * wide margin.
           */
          if (!back) {
            console.error('    ! it did not come back — waiting two minutes before one more try')
            await new Promise((r) => setTimeout(r, 120000))
            back = await reload()
          }

          console.error(back ? '    ✓ back, retrying' : '    ! still nothing — giving up on this call')
          if (!back) throw last
        }
      }
    }
    throw last
  }

  return { evaluate, reload, url: tab.url, close: () => ws.close() }
}

/**
 * Is this browser signed in to the conversation, or looking at a login wall?
 *
 * "A chatgpt.com tab exists" was the test, and it is not the same question: a
 * tab parked on the sign-in page satisfies it perfectly, so the walkthrough
 * would report the browser ready and the first pass would fail against a form.
 *
 * The composer is the signal, checked rather than assumed — a probe on the live
 * page showed the account button selectors matching nothing at all, so guessing
 * would have inverted the answer. Returns null when the browser cannot be
 * reached: not signed in and not knowable are different states, and reporting
 * "signed out" for a browser that is simply absent would send someone off to fix
 * the wrong thing.
 */
export async function signedIn(port = CDP_PORT) {
  let page
  try {
    page = await attach('chatgpt.com', port)
  } catch {
    return null
  }
  try {
    const raw = await page.evaluate(
      `JSON.stringify({
        url: location.href,
        composer: Boolean(document.querySelector('#prompt-textarea, [contenteditable="true"]')),
        login: /log in|sign up|create account/i.test(document.body.innerText.slice(0, 2000)),
      })`,
      { timeoutMs: 8000, retries: 0 },
    )
    const seen = JSON.parse(raw)
    if (/auth\.openai\.com|\/auth\/login/.test(seen.url)) return false
    return seen.composer && !seen.login
  } catch {
    return null
  } finally {
    page.close()
  }
}

/** The assistant's last message, as displayed. */
export const JS_LAST_ASSISTANT = `
(() => {
  const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!nodes.length) return null;
  const last = nodes[nodes.length - 1];
  return last.innerText.trim();
})()
`

/**
 * True while the reply is still being generated.
 *
 * We do NOT trust the stop button's label: it is translated to the interface
 * language, and a selector that never matches makes generation look finished from
 * the very first character.
 */
export const JS_IS_STREAMING = `
(() => {
  if (document.querySelector('[data-testid="stop-button"]')) return true;
  const composerButtons = document.querySelectorAll('form button, main button');
  for (const b of composerButtons) {
    const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
    if (/stop|arrêt|arret|detener|anhalten/i.test(label)) return true;
  }
  return false;
})()
`

/**
 * A robust wait: the text has stopped moving.
 * Interface-independent — the only signal that is never translated.
 */
export async function waitForStable(page, { quietMs = 4000, maxMs = 300000, minLength = 40 } = {}) {
  const started = Date.now()
  let last = null
  let stableSince = null
  let reloaded = false

  while (Date.now() - started < maxMs) {
    const now = await page.evaluate(JS_LAST_ASSISTANT)

    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (stableSince && Date.now() - stableSince >= quietMs) {
      const streaming = await page.evaluate(JS_IS_STREAMING)

      if (!streaming) {
        // ChatGPT's rendering sometimes stalls on a few characters while the
        // reply is complete server-side. A reload settles it.
        if (!reloaded && (last ?? '').length < minLength) {
          reloaded = true
          await page.evaluate('location.reload()')
          await new Promise((r) => setTimeout(r, 9000))
          last = null
          stableSince = null
          continue
        }

        // We NEVER return a fragment. An 18-character reply was once taken for
        // complete, the loop read a "#24" in it and stopped on an invented
        // objective — while GPT was still writing. Better to wait for nothing
        // than to act on a cut-off sentence.
        if ((last ?? '').length < minLength) {
          stableSince = null
          await new Promise((r) => setTimeout(r, 3000))
          continue
        }

        return last
      }

      stableSince = Date.now()
    }

    await new Promise((r) => setTimeout(r, 1000))
  }

  return last
}

/**
 * Checks that a text really landed as the last user message. The evaluation's
 * return value is lost when the page moves after the click: so we do not trust
 * it, we observe the result instead.
 */
/**
 * Confirms a message actually went out. We do NOT compare the raw text: the
 * interface renders markdown, so "## Turn 1" displays as "Turn 1" and
 * a prefix comparison always fails. We look for a word signature, stripped of
 * everything the rendering can change.
 */
const signature = (t) =>
  String(t)
    .replace(/[#*`_>\-\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

export async function confirmPosted(page, text) {
  // A fragment from the START, and only from the start. The interface folds long
  // messages behind "Show more": on a 9,000-character report, only ~700 are in
  // the DOM. Searching in the middle, as this once did, never found anything and
  // the loop stopped on a false alarm while the message had gone out fine.
  const brut = signature(text)
  const debut = Math.min(20, Math.max(0, brut.length - 40))
  const marque = JSON.stringify(brut.slice(debut, debut + 60))
  if (marque.length < 12) return true

  for (let i = 0; i < 10; i++) {
    const ok = await page
      .evaluate(`
        (() => {
          const n = document.querySelectorAll('[data-message-author-role="user"]');
          if (!n.length) return false;
          const vu = n[n.length - 1].innerText
            .replace(/[#*\`_>\\-\\[\\]()]/g, ' ')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase();
          return vu.includes(${marque});
        })()
      `)
      .catch(() => false)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

/**
 * Attaches files to the message being composed.
 *
 * Without this, the conversation judges on a sentence of report — that is, on
 * the executor's word. A visual verdict requires seeing the rendering.
 */
export async function attachFiles(page, files) {
  if (!files.length) return 0

  const payload = files.map((f) => ({
    name: f.name,
    type: f.type,
    b64: f.b64,
  }))

  const r = await page.evaluate(`
(async () => {
  const files = ${JSON.stringify(payload)};
  const input = document.querySelector('input[type=file]');
  if (!input) return 'no file input';

  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }

  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 2500));
  return String(dt.files.length);
})()
  `)

  return Number(r) || 0
}

/** Drops a text into the composer and sends it. */
export function jsPost(text) {
  const payload = JSON.stringify(text)
  return `
(async () => {
  const box = document.querySelector('#prompt-textarea')
    ?? document.querySelector('div[contenteditable="true"]')
    ?? document.querySelector('textarea');
  if (!box) return 'composeur introuvable';

  box.focus();
  const value = ${payload};

  if (box.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    box.innerHTML = '';
    for (const line of value.split('\\n')) {
      const p = document.createElement('p');
      p.textContent = line.length ? line : '';
      box.appendChild(p);
    }
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  await new Promise(r => setTimeout(r, 400));

  // The button stays disabled while a file is still uploading.
  for (let i = 0; i < 40; i++) {
    const b = document.querySelector('[data-testid="send-button"]');
    if (b && !b.disabled) break;
    await new Promise(r => setTimeout(r, 500));
  }

  const send = document.querySelector('[data-testid="send-button"]')
    ?? document.querySelector('button[aria-label*="Send"]')
    ?? document.querySelector('button[aria-label*="Envoyer"]');
  if (!send) return 'bouton envoyer introuvable';
  if (send.disabled) return 'send button disabled';
  send.click();
  return 'ok';
})()
`
}

/**
 * Extracts an instruction addressed to a harness.
 * Expected format in GPT's reply:  @codex: … or @claude: …
 */
/**
 * Le verdict que la conversation prononce sur un objectif.
 * Accepted forms:  #14 validé   ·   #14 refusé   ·   valide #14
 */
/**
 * Reads a verdict out of a reply.
 *
 * We take the FIRST verdict in the text, not the first pattern found: searching
 * l'acceptation sur tout le message avant de chercher le refus faisait gagner
 * a "satisfait" on line 200 against a "#11 refusé" on line 1. The judge states
 * the verdict up top, then explains — the top is what counts.
 *
 * `expected` lets us target one objective: when asking for chapter #11's verdict,
 * a verdict on #12 in the same message is not an answer.
 */
export function parseVerdict(text, { expected = null } = {}) {
  if (!text) return null

  // The explicit marker beats any reading of the prose. Inferring a verdict from
  // a sentence is guessing; `@verdict: #11 rejected` needs no guessing. As long as
  // the judge writes it, there is nothing left to interpret.
  // `\w` does not cover accents: "valid\w*" stops before the é in "validé". The
  // code already documented that for `\b`; the trap is the same.
  const wordPattern = '(valid|accept|approv|refus|rejet|reject)[a-zà-ÿ]*'
  const mark =
    new RegExp(`@verdict\\s*:?\\s*#?(\\d+)\\s+${wordPattern}`, 'i').exec(text) ??
    new RegExp(`@verdict\\s*:?\\s*${wordPattern}\\s+#?(\\d+)`, 'i').exec(text)

  if (mark) {
    const [id, word] = /^\d+$/.test(mark[1]) ? [mark[1], mark[2]] : [mark[2], mark[1]]
    const decision = /^(valid|accept|approv)/i.test(word) ? 'accept' : 'reject'
    if (expected != null && Number(id) !== Number(expected)) return null
    return { id: Number(id), decision, explicite: true }
  }

  // \b does not work after an accent: bound it explicitly.
  const edge = '(?![a-zà-ÿ])'

  // BOTH languages, deliberately. The tool now addresses the judge in English, but
  // the conversations opened before that switch are French and still hold their
  // history — a parser that only spoke one of the two would misread half of them.
  //
  // Negation is handled ONCE, in one place: "non conforme", "not accepted" and
  // "never satisfied" must all read as rejections. Listing only the positive words
  // and hoping made a rejection read as an acceptance — both branches matched at
  // the same index and the accept branch, pushed first, won. Found by a test.
  const neg = '(?:non|not|never|jamais|pas)\\s+'
  const POSITIVE = 'validé|valide|accepté|accepte|conforme|atteint|satisfait|validated|accepted|approved|met|satisfied|passes'
  const NEGATIVE = 'refusé|refuse|rejeté|rejete|insuffisant|refused|rejected|insufficient|fails'

  const yes = `(?<!${neg})(?:${POSITIVE})${edge}`
  const no = `(?:${NEGATIVE}|${neg}(?:${POSITIVE}))${edge}`

  const found = []
  for (const [decision, verbs] of [
    ['accept', yes],
    ['reject', no],
  ]) {
    for (const pattern of [`#(\\d+)[^.\\n]{0,40}?${verbs}`, `${verbs}[^.\\n]{0,30}?#(\\d+)`]) {
      for (const m of text.matchAll(new RegExp(pattern, 'gi'))) {
        found.push({ id: Number(m[1]), decision, at: m.index ?? 0 })
      }
    }
  }

  if (!found.length) return null
  found.sort((a, b) => a.at - b.at)

  if (expected != null) {
    const wanted = found.find((v) => v.id === Number(expected))
    return wanted ? { id: wanted.id, decision: wanted.decision } : null
  }

  return { id: found[0].id, decision: found[0].decision }
}

export function parseDirective(text) {
  if (!text) return null

  const re = /@(codex|claude)\s*:\s*([\s\S]+?)(?=\n@(?:codex|claude)\s*:|$)/i
  const m = text.match(re)
  if (!m) return null

  return { harness: m[1].toLowerCase(), task: m[2].trim() }
}

/**
 * Does the judge declare the work finished? With no marker, "Le chapitre est
 * terminé." is indistinguishable from a comment, and the loop kept asking for an
 * consigne en boucle alors qu'on venait de lui dire qu'il n'y en aurait plus.
 */
export function parseDone(text) {
  if (!text) return null
  const m = /@fini\s*:?\s*(?:#?(\d+))?([^\n]*)/i.exec(text)
  if (!m) return null
  return { id: m[1] ? Number(m[1]) : null, reason: (m[2] ?? '').trim() || null }
}

/**
 * How many exchanges the driving conversation already carries.
 *
 * Every turn re-reads the whole thread. Past a point the conversation costs more
 * per turn, answers slower, and starts forgetting the rules it was given at the
 * top — and none of that announces itself: it just gets quietly worse. Counting
 * is the only way to see it coming.
 */
export async function conversationSize(page) {
  const raw = await page
    .evaluate(
      `(() => JSON.stringify({
        asked: document.querySelectorAll('[data-message-author-role="user"]').length,
        chars: document.body.innerText.length,
      }))()`,
    )
    .catch(() => null)

  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
