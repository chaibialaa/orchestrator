#!/usr/bin/env node
/**
 * Orchestrator local agent — a thin client.
 *
 * It NEVER runs a command received from the server: only the keys declared in
 * .orchestrator.json (proofs.*) are executable. That rule, and that rule alone,
 * is what will make a hosted version defensible.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { resolve, relative, basename, dirname, join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { RULES, checkFile } from './rules.js'
import { recentSessions, readSince, encodeCwd } from './watch.js'
import { generateImage, ADAPTERS } from './images.js'
import { inventoryMemories, assembleContext, memoryInstruction, memoryFingerprint } from './memories.js'
import { attach, parseDirective, parseVerdict, parseDone, jsPost, attachFiles, waitForStable, confirmPosted, conversationSize, JS_LAST_ASSISTANT, JS_IS_STREAMING } from './relay.js'

/**
 * Claude pricing in $/million tokens: [input, output].
 * Cache writes cost ×1.25 (5 min TTL) or ×2 (1 h TTL) of the input rate; cache
 * reads ×0.1.
 */
const PRICING = {
  'claude-fable-5': [10, 50],
  'claude-mythos-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-opus-4-5': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-sonnet-4-6': [3, 15],
  'claude-sonnet-4-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
}

/** Model ids sometimes carry a suffix (`[1m]`, a date): match on the prefix. */
function priceFor(model) {
  const key = Object.keys(PRICING)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k))
  return key ? PRICING[key] : [0, 0]
}

/** Claude Code files its transcripts by encoded working directory. */
function defaultTranscriptDir() {
  // One source for this rule: it lived in two places, one of them was fixed and
  // the other was not, and the fault survived whole.
  const slug = encodeCwd(process.cwd())
  return resolve(homedir(), '.claude/projects', slug)
}

const GLOBAL_CONFIG = resolve(homedir(), '.orchestrator/config.json')
const PROJECT_CONFIG = '.orchestrator.json'

function loadConfig() {
  const global = existsSync(GLOBAL_CONFIG) ? JSON.parse(readFileSync(GLOBAL_CONFIG, 'utf8')) : {}
  const project = existsSync(PROJECT_CONFIG) ? JSON.parse(readFileSync(PROJECT_CONFIG, 'utf8')) : {}

  return {
    apiUrl: process.env.ORCHESTRATOR_API ?? global.apiUrl ?? 'http://localhost:4747/api',
    token: process.env.ORCHESTRATOR_TOKEN ?? global.token ?? null,
    project: project.project ?? null,
    blastRadius: project.blastRadius ?? [],
    proofs: project.proofs ?? {},
    probes: project.probes ?? {},
    transcripts: project.transcripts ?? null,
    env: project.env ?? {},
    sessionTimeoutMin: project.sessionTimeoutMin ?? null,
    codexPricing: project.codexPricing ?? {},
    binaries: { ...(global.binaries ?? {}), ...(project.binaries ?? {}) },
    // A secret left empty in the file does not overwrite the one in the
    // environment: `{ "RUNPOD_API_KEY": "" }` would erase the real key when the
    // agent starts.
    secrets: Object.fromEntries(Object.entries(project.secrets ?? {}).filter(([, v]) => v !== '' && v != null)),
    deliverableDirs: project.deliverableDirs ?? null,
    deliverableIgnore: project.deliverableIgnore ?? null,
    // Directories outside the repository that a mission is allowed to READ.
    // Without them, the refusals have nothing to do with the tool list: the
    // harness bounds its access to the working directory, and an `ls` on Unity's
    // log is refused even when Bash is entirely allowed. Three passes were lost to
    // this, blaming the permissions.
    readDirs: project.readDirs ?? [],
    unity: project.unity ?? null,
  }
}

/**
 * Is a Unity editor running? We look at the process, not at the MCP server: the
 * server keeps answering after the editor has died, and that is exactly what made
 * two sessions believe they could work.
 */
function editeurUnityVivant() {
  try {
    // Unity Hub carries the same name without the editor binary: target the full
    // path, otherwise the Hub alone would be enough to say "all good".
    execFileSync('pgrep', ['-f', 'Unity.app/Contents/MacOS/Unity'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const config = loadConfig()

async function call(method, path, body, { soft = false } = {}) {
  const upload = () =>
    fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

  // A pass lasts minutes; between two calls the kept-alive connection dies
  // server-side and the next write goes nowhere (EPIPE). It looked like a size
  // problem — a 93 kB inventory went through, an 83 kB result failed: it was the
  // silence, not the weight.
  let res
  try {
    res = await upload()
  } catch (e) {
    const mort = ['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET'].some((c) => String(e?.cause?.code ?? e?.code ?? e?.message).includes(c))
    if (!mort) throw e
    await pause(300)
    res = await upload()
  }

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    // A refusal from the proof gate is not a failure: it is the product. So it
    // must NOT kill a running loop — otherwise one objective that refuses to
    // conclude takes the whole chapter with it, including the other steps that
    // asked for nothing.
    if (data.gate) {
      console.error(`\n  gate refused — ${data.gate.reason}`)
      console.error(`  ${data.gate.detail}\n`)
      if (soft) return null
      if (process.env.ORCHESTRATOR_BOUCLE === '1') return { gate: data.gate, refus: true }
      process.exit(2)
    }
    // Dans une boucle longue, une erreur ponctuelle ne doit pas tout tuer.
    if (soft) return null

    console.error(`HTTP ${res.status}: ${String(JSON.stringify(data)).slice(0, 300)}`)
    process.exit(1)
  }

  return data
}

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** The real state comes from git, never from an agent's report. */
function head() {
  return git('rev-parse', 'HEAD')
}

function gitAt(repo, ...args) {
  return git('-C', repo, ...args)
}

/** Empreintes de contenu des commits d'une plage — insensibles au SHA. */
function patchIds(repo, range) {
  try {
    const out = execFileSync(
      '/bin/sh',
      ['-c', `git -C '${repo}' log --format=%H ${range} | while read s; do git -C '${repo}' show "$s" | git patch-id --stable; done`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    )
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')[0])
  } catch {
    return []
  }
}

function changedPaths(from, to) {
  const out = git('diff', '--name-only', `${from}..${to}`)
  return out ? out.split('\n').filter(Boolean) : []
}

function matchesGlob(path, glob) {
  const rx = new RegExp(
    '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  )
  return rx.test(path)
}

const STATE_FILE = resolve(homedir(), '.orchestrator/state.json')

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

/** Hooks receive their payload as JSON on stdin. */
async function readHookInput() {
  if (process.stdin.isTTY) return {}
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

const commands = {
  /**
   * SessionStart hook: injects the project memory into the context and opens an
   * attempt if an objective is takeable. Nothing to type.
   */
  async 'session:start'() {
    const input = await readHookInput()
    if (!config.project) return process.exit(0)

    const recall = await call('GET', `/projects/${config.project}/recall`)
    const objectives = await call('GET', `/projects/${config.project}/objectives`)

    const takeable = objectives
      .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
      .sort((a, b) => a.priority - b.priority)

    const lines = [`# Memory — ${recall.project.name}`, '']

    for (const d of recall.decisions) {
      lines.push(`## ${d.title} (${d.decided_at.slice(0, 10)})`)
      lines.push(d.body)
      if (d.paths?.length) lines.push(`Paths concerned: ${d.paths.join(', ')}`)
      lines.push('')
    }

    for (const r of recall.resources) {
      lines.push(`## Document — ${r.name}${r.summary ? ` : ${r.summary}` : ''}`)
      if (r.content) lines.push(r.content)
      else lines.push(`File: ${r.url}`)
      lines.push('')
    }

    let passageId = null
    // Started by `orchestrator do` / `relay`: the parent already manages the
    // attempt. We inject the context, we do not open a second one.
    const managed = process.env.ORCHESTRATOR_MANAGED === '1'

    if (takeable.length) {
      const objective = takeable[0]
      lines.push(`## Objective in progress — #${objective.id} ${objective.title}`)
      lines.push(`Rayon de souffle : ${objective.blast_radius}`)
      lines.push(`Proof required: ${objective.proof_spec}`)

      const passage = managed
        ? null
        : await call('POST', `/objectives/${objective.id}/passages`, {
            harness: 'claude',
            git_before: head(),
          }).catch(() => null)

      if (managed) lines.push('Attempt already opened by the orchestrator.')

      if (passage?.id) {
        passageId = passage.id
        const state = readState()
        state[input.session_id ?? 'inconnu'] = { passageId, project: config.project }
        writeState(state)
        lines.push(`Attempt #${passageId} opened — proofs attach to it.`)
      }
    } else {
      lines.push('## No takeable objective')
      lines.push('Everything is proven, halted, or has no proof criterion defined.')
    }

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: lines.join('\n'),
        },
        suppressOutput: true,
      }),
    )
  },

  /**
   * SessionEnd hook: reads the real usage, closes the attempt.
   * The verdict is derived from the proofs, it is never declared.
   */
  async 'session:end'() {
    const input = await readHookInput()
    const state = readState()
    const entry = state[input.session_id ?? '']
    if (!entry?.passageId) return process.exit(0)

    const passage = await call('GET', `/passages/${entry.passageId}`).catch(() => null)
    if (!passage || passage.ended_at) return process.exit(0)

    await commands['usage:scan'](entry.passageId).catch(() => {})

    const fresh = await call('GET', `/passages/${entry.passageId}`)
    const proven = (fresh.evidences ?? []).some((e) => e.verdict === 'pass')

    await call('PATCH', `/passages/${entry.passageId}`, {
      verdict: proven ? 'advanced' : 'no_progress',
      git_after: head(),
    })

    delete state[input.session_id]
    writeState(state)

    console.log(
      JSON.stringify({
        systemMessage: `Orchestrator — attempt #${entry.passageId} closed (${proven ? 'moved it forward' : 'demonstrated nothing'}).`,
      }),
    )
  },

  /** PostToolUse hook on `git commit`: resyncs the repository's real state. */
  async 'git:sync'() {
    const input = await readHookInput()
    const state = readState()
    const entry = state[input.session_id ?? '']
    if (!entry?.passageId) return process.exit(0)

    const sha = head()
    if (!sha) return process.exit(0)

    await call('PATCH', `/passages/${entry.passageId}`, { git_after: sha }).catch(() => {})
    process.exit(0)
  },

  async context(path) {
    if (!path) fail('usage: orchestrator context <chemin>')
    const rel = relative(process.cwd(), resolve(path)) || path
    const data = await call('GET', `/projects/${config.project}/context?path=${encodeURIComponent(rel)}`)

    if (data.requires_human) {
      console.log(`\n  RAYON DE SOUFFLE — ${data.blast_radius_hit.join(', ')}`)
      console.log('  Ce chemin exige une validation humaine.\n')
    }

    for (const d of data.decisions) {
      console.log(`\n  ▸ ${d.title}  (${d.decided_at.slice(0, 10)})`)
      console.log(`    ${d.body}`)
    }

    if (!data.decisions.length && !data.requires_human) console.log('  no decision attached to this path')
  },

  async 'passage:start'(objectiveId, harness) {
    if (!objectiveId || !harness) fail('usage: orchestrator passage:start <objectiveId> <claude|codex|gpt|human>')
    const passage = await call('POST', `/objectives/${objectiveId}/passages`, {
      harness,
      git_before: head(),
    })
    console.log(passage.id)
  },

  async 'passage:end'(passageId, verdict, ...summary) {
    if (!passageId || !verdict) fail('usage: orchestrator passage:end <passageId> <advanced|no_progress|halted|failed> [summary]')
    const passage = await call('PATCH', `/passages/${passageId}`, {
      verdict,
      git_after: head(),
      summary: summary.join(' ') || undefined,
    })
    console.log(`passage ${passage.id} clos — ${passage.verdict}`)
  },

  async evidence(passageId, type, verdict, ...label) {
    if (!passageId || !type || !verdict) {
      fail('usage: orchestrator evidence <passageId> <test|e2e|screenshot|render|diff|invariant|manual> <pass|fail|inconclusive> <label>')
    }
    const evidence = await call('POST', `/passages/${passageId}/evidences`, {
      type,
      verdict,
      label: label.join(' ') || type,
    })
    console.log(`proof ${evidence.id} — ${evidence.type}/${evidence.verdict}`)
  },

  /** Runs a proof DECLARED locally and publishes its verdict. */
  async prove(passageId, key) {
    if (!passageId || !key) fail(`usage: orchestrator prove <passageId> <${Object.keys(config.proofs).join('|') || 'key'}>`)

    const command = config.proofs[key]
    if (!command) {
      fail(`Proof “${key}” is not declared in .orchestrator.json — refusing to run an undeclared command.`)
    }

    let verdict = 'pass'
    try {
      execFileSync('/bin/sh', ['-c', command], { stdio: 'inherit' })
    } catch {
      verdict = 'fail'
    }

    await call('POST', `/passages/${passageId}/evidences`, {
      type: key === 'e2e' ? 'e2e' : 'test',
      verdict,
      label: key,
      ref: command,
    })
    console.log(`proof “${key}” → ${verdict}`)
    if (verdict === 'fail') process.exit(1)
  },

  /**
   * Checks the real diff: blast radius first, then the trap pack.
   * Exits 2 if something must stop the loop.
   */
  async guard(from, to = 'HEAD') {
    if (!from) fail('usage: orchestrator guard <sha-before> [sha-after]')

    const paths = changedPaths(from, to)
    const hits = paths.filter((p) => config.blastRadius.some((g) => matchesGlob(p, g)))
    let stop = false

    if (hits.length) {
      console.error(`\n  STOP — blast radius`)
      hits.forEach((h) => console.error(`    ${h}`))
      stop = true
    }

    const findings = []
    for (const p of paths) {
      if (!existsSync(p)) continue
      try {
        findings.push(...checkFile(p, readFileSync(p, 'utf8')))
      } catch {
        // binary or unreadable file: outside the rules' scope
      }
    }

    const halts = findings.filter((f) => f.severity === 'halt')
    const warns = findings.filter((f) => f.severity === 'warn')

    if (halts.length) {
      console.error(`\n  STOP — ${halts.length} project rule(s) broken`)
      for (const f of halts) {
        console.error(`    ${f.path}:${f.line}  [${f.rule}]`)
        console.error(`      ${f.why}`)
        console.error(`      ${f.code}`)
      }
      stop = true
    }

    if (warns.length) {
      console.error(`\n  À VÉRIFIER — ${warns.length} signalement(s)`)
      for (const f of warns) {
        console.error(`    ${f.path}:${f.line}  [${f.rule}] ${f.why}`)
      }
    }

    if (stop) {
      console.error('')
      // process.exit() tronque la sortie encore en tampon : on pose le code.
      process.exitCode = 2
      return
    }

    console.log(
      `${paths.length} files modified — blast radius clean, ${RULES.length} rules checked`,
    )
  },

  /** Runs the rule pack over given paths, outside any git context. */
  async lint(...paths) {
    if (!paths.length) fail('usage: orchestrator lint <file…>')

    const findings = []
    for (const p of paths) {
      const full = resolve(p)
      if (!existsSync(full)) continue
      const shown = relative(process.cwd(), full)
      const label = shown.startsWith('..') ? full : shown || p
      findings.push(...checkFile(label, readFileSync(full, 'utf8')))
    }

    if (!findings.length) return console.log(`no violation — ${RULES.length} rules checked`)

    for (const f of findings) {
      console.log(`  ${f.severity === 'halt' ? 'STOP' : 'to check'}  ${f.path}:${f.line}  [${f.rule}]`)
      console.log(`    ${f.why}`)
      console.log(`    ${f.code}`)
    }

    process.exitCode = findings.some((f) => f.severity === 'halt') ? 2 : 0
  },

  /** Drops a file (< 5 MB) into the project memory. */
  async remember(file, ...summary) {
    if (!file) fail('usage: orchestrator remember <file> [summary]')

    const path = resolve(file)
    if (!existsSync(path)) fail(`file not found: ${path}`)

    const bytes = statSync(path).size
    if (bytes > 5 * 1024 * 1024) {
      fail(`${(bytes / 1024 / 1024).toFixed(1)} MB — past 5 MB, reference the file rather than storing it.`)
    }

    const form = new FormData()
    form.append('file', new Blob([readFileSync(path)]), basename(path))
    if (summary.length) form.append('summary', summary.join(' '))

    const res = await fetch(`${config.apiUrl}/projects/${config.project}/resources`, {
      method: 'POST',
      headers: { Accept: 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
      body: form,
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) fail(data.message ?? `HTTP ${res.status}`)

    console.log(`stored — ${data.name} (${data.kind}, ${(data.size / 1024).toFixed(1)} kB)`)
  },

  /** The context bundle to load when a work session starts. */
  async recall() {
    const data = await call('GET', `/projects/${config.project}/recall`)

    console.log(`\n# Contexte ${data.project.name}\n`)
    console.log(`## Decisions (${data.decisions.length})\n`)
    for (const d of data.decisions) {
      console.log(`### ${d.title}  — ${d.decided_at.slice(0, 10)}`)
      console.log(`${d.body}`)
      if (d.paths?.length) console.log(`Chemins : ${d.paths.join(', ')}`)
      console.log('')
    }

    console.log(`## Ressources incluses (${data.resources.length})\n`)
    for (const r of data.resources) {
      console.log(`### ${r.name}  (${r.kind}, ${(r.size / 1024).toFixed(1)} ko)`)
      if (r.summary) console.log(`${r.summary}`)
      if (r.content) console.log(`\n${r.content}`)
      else console.log(`File: ${r.url}`)
      console.log('')
    }
  },

  /**
   * Reads the REAL usage from the harness transcripts and publishes it. No
   * cooperation from the agent is required: the harness already logs every request
   * with its model, its timestamp and its counters.
   */
  async 'usage:scan'(passageId, transcriptDir) {
    if (!passageId) fail('usage: orchestrator usage:scan <passageId> [dossier-transcripts]')

    const passage = await call('GET', `/passages/${passageId}`)
    const since = new Date(passage.started_at).getTime()
    const until = passage.ended_at ? new Date(passage.ended_at).getTime() : Date.now()

    // Absence de transcripts : on ne sait pas mesurer, on ne bloque pas.
    const dir = transcriptDir ?? config.transcripts ?? defaultTranscriptDir()
    if (!existsSync(dir)) {
      return console.error(`transcripts not found (${dir}) — usage not measured`)
    }

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => resolve(dir, f))
      .filter((f) => statSync(f).mtimeMs >= since)

    if (!files.length) {
      return console.log('no transcript modified since the attempt began')
    }

    const totals = {}
    let requests = 0

    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue

        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }

        const usage = entry.message?.usage
        const at = Date.parse(entry.timestamp ?? '')
        if (!usage || !at || at < since || at > until) continue

        const model = entry.message?.model ?? 'inconnu'
        totals[model] ??= { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0, n: 0 }
        const t = totals[model]

        t.input += usage.input_tokens ?? 0
        t.output += usage.output_tokens ?? 0
        t.cacheRead += usage.cache_read_input_tokens ?? 0
        // Cache creation is billed differently depending on its lifetime.
        t.cache5m += usage.cache_creation?.ephemeral_5m_input_tokens ?? 0
        t.cache1h += usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
        t.n += 1
        requests += 1
      }
    }

    if (!requests) return console.log('no request found inside the attempt window')

    let tokens = 0
    let cost = 0

    console.log('')
    for (const [model, t] of Object.entries(totals)) {
      const [inPrice, outPrice] = priceFor(model)
      const modelTokens = t.input + t.output + t.cache5m + t.cache1h + t.cacheRead
      // Écriture de cache : ×1,25 (5 min) ou ×2 (1 h). Lecture : ×0,1.
      const modelCost =
        (t.input * inPrice +
          t.cache5m * inPrice * 1.25 +
          t.cache1h * inPrice * 2 +
          t.cacheRead * inPrice * 0.1 +
          t.output * outPrice) /
        1_000_000

      tokens += modelTokens
      cost += modelCost

      console.log(`  ${model}`)
      console.log(
        `    ${t.n} requests · ${modelTokens.toLocaleString('en-US')} tokens · $${modelCost.toFixed(3)}`,
      )
      console.log(
        `    input ${t.input.toLocaleString('en-US')} · output ${t.output.toLocaleString('en-US')} · ` +
          `cache written ${(t.cache5m + t.cache1h).toLocaleString('en-US')} · cache read ${t.cacheRead.toLocaleString('en-US')}`,
      )
    }

    const updated = await call('POST', `/passages/${passageId}/usage`, {
      tokens,
      cost_usd: Number(cost.toFixed(3)),
    })

    console.log(
      `\n  published → ${updated.tokens.toLocaleString('en-US')} tokens · $${updated.cost_usd} on attempt ${passageId}\n`,
    )
  },

  /** One request's usage, accumulated on the attempt. */
  async usage(passageId, tokens, cost) {
    if (!passageId || !tokens) fail('usage: orchestrator usage <passageId> <tokens> [cost $]')
    const passage = await call('POST', `/passages/${passageId}/usage`, {
      tokens: Number(tokens),
      cost_usd: cost ? Number(cost) : undefined,
    })
    console.log(`${passage.requests} demandes · ${passage.tokens} tokens · $${passage.cost_usd}`)
  },

  /**
   * The REAL state of the repositories, derived from git alone.
   * `git branch --contains` lies about squashes: we compare by patch-id.
   */
  async inventory(root = process.cwd()) {
    const base = resolve(root)
    const repos = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(resolve(base, e.name, '.git')))
      .map((e) => resolve(base, e.name))

    if (!repos.length) return console.log(`no git repository under ${base}`)

    const rows = []

    for (const repo of repos) {
      const at = (...args) => git('-C', repo, ...args)

      const branch = at('rev-parse', '--abbrev-ref', 'HEAD') ?? '?'
      const status = at('status', '--porcelain') ?? ''
      const dirty = status.split('\n').filter(Boolean).length

      const upstream = at('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
      let ahead = 0
      let behind = 0

      if (upstream) {
        const counts = at('rev-list', '--left-right', '--count', `${upstream}...HEAD`)
        if (counts) {
          const [b, a] = counts.split(/\s+/).map(Number)
          behind = b
          ahead = a
        }
      }

      // Local commits whose CONTENT does not exist upstream.
      // Ancestry lies after a squash or a rebase: we compare by patch-id.
      let unpushed = []
      let alreadyUpstream = 0

      if (upstream && ahead > 0) {
        const upstreamPatches = patchIds(repo, `${upstream}~200..${upstream}`)

        for (const line of (at('log', '--format=%H %s', `${upstream}..HEAD`) ?? '')
          .split('\n')
          .filter(Boolean)) {
          const sha = line.slice(0, 40)
          const subject = line.slice(41)
          const [patch] = patchIds(repo, `${sha}~1..${sha}`)

          if (patch && upstreamPatches.includes(patch)) alreadyUpstream += 1
          else unpushed.push(`${sha.slice(0, 7)} ${subject}`)
        }
      }

      rows.push({
        name: basename(repo),
        branch,
        dirty,
        ahead,
        behind,
        upstream: upstream ?? null,
        unpushed,
        alreadyUpstream,
        lastCommit: at('log', '-1', '--format=%cr — %s') ?? '',
      })
    }

    rows.sort(
      (a, b) => b.dirty + b.unpushed.length * 100 - (a.dirty + a.unpushed.length * 100),
    )

    const inFlight = rows.filter((r) => r.dirty > 0 || r.unpushed.length > 0)
    const clean = rows.filter((r) => r.dirty === 0 && r.unpushed.length === 0)

    console.log(`\n  ${rows.length} repositories — ${inFlight.length} with work in flight\n`)

    for (const r of inFlight) {
      const flags = []
      if (r.dirty) flags.push(`${r.dirty} uncommitted file(s)`)
      if (r.unpushed.length) flags.push(`${r.unpushed.length} commit(s) NON POUSSÉ(S)`)
      if (r.alreadyUpstream) flags.push(`${r.alreadyUpstream} already upstream (squash)`)
      if (r.behind) flags.push(`${r.behind} en retard`)
      if (!r.upstream) flags.push('no upstream')

      console.log(`  ${r.name}  [${r.branch}]`)
      console.log(`    ${flags.join(' · ')}`)
      for (const c of r.unpushed.slice(0, 5)) console.log(`      ↑ ${c}`)
      if (r.unpushed.length > 5) console.log(`      ↑ … ${r.unpushed.length - 5} de plus`)
      console.log(`    dernier : ${r.lastCommit}`)
      console.log('')
    }

    if (clean.length) {
      console.log(`  À jour : ${clean.map((r) => r.name).join(', ')}\n`)
    }
  },

  /**
   * Runs the probes DECLARED locally and publishes each measurement.
   * The server says what to measure by key; it never says how.
   */
  async 'invariants:check'() {
    if (!config.project) fail('no project in .orchestrator.json')

    const invariants = await call('GET', `/projects/${config.project}/invariants`)
    if (!invariants.length) return console.log('no invariant declared')

    let breached = 0

    for (const inv of invariants) {
      const probe = config.probes?.[inv.probe_key]

      if (!probe) {
        console.log(`  ?  ${inv.name} — probe “${inv.probe_key}” not declared locally`)
        continue
      }

      let raw
      try {
        raw = execFileSync('/bin/sh', ['-c', probe], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      } catch {
        console.log(`  ?  ${inv.name} — the probe failed`)
        continue
      }

      const value = Number(raw.split('\n').pop())
      if (!Number.isFinite(value)) {
        console.log(`  ?  ${inv.name} — the probe did not return a count: “${raw.slice(0, 40)}”`)
        continue
      }

      const result = await call('POST', `/invariants/${inv.id}/readings`, { value })
      const mark = result.holds ? 'ok' : 'FRANCHI'
      console.log(`  ${result.holds ? '·' : '!'}  ${inv.name} = ${value} ${inv.unit ?? ''} — ${mark}`)

      if (!result.holds) {
        breached += 1
        if (result.halt) {
          console.log(`     halt created on objective #${result.halt.objective_id}`)
        }
      }
    }

    if (breached) {
      console.error(`\n  ${breached} invariant(s) franchi(s)\n`)
      process.exitCode = 2
    }
  },

  /**
   * The watcher. Observes Claude and Codex sessions, opens and closes attempts by
   * itself. No agent has to remember to call in.
   */
  async watch(intervalArg) {
    const interval = Number(intervalArg ?? 5) * 1000
    const idleMs = 90 * 1000

    const projects = (await call('GET', '/projects')).filter((p) => p.repo_path)
    if (!projects.length) fail('no project has a repo_path')

    console.log(`\n  veilleur actif — ${projects.length} projets suivis, cycle ${interval / 1000}s`)
    for (const p of projects) console.log(`    ${p.slug}  ${p.repo_path}`)
    console.log('')

    const tracked = new Map()
    let firstPass = true

    // Codex gives the cwd in the clear; Claude only gives an encoded form that is
    // ambiguous to decode — so we compare encodings, never the reverse.
    const matchProject = (cwd, encodedCwd) => {
      if (cwd) {
        return projects.find((p) => cwd === p.repo_path || cwd.startsWith(p.repo_path + '/')) ?? null
      }
      if (encodedCwd) {
        return (
          projects.find((p) => {
            const enc = encodeCwd(p.repo_path)
            return encodedCwd === enc || encodedCwd.startsWith(enc + '-')
          }) ?? null
        )
      }
      return null
    }

    const tick = async () => {
      const since = firstPass ? Date.now() - 5 * 60 * 1000 : Date.now() - 10 * 60 * 1000
      firstPass = false

      for (const s of recentSessions(since)) {
        let state = tracked.get(s.file)

        // First encounter with a pre-existing file: seek to the end. The watcher
        // only records what happens after it starts; it does not re-bill history.
        if (!state) {
          let size = 0
          try {
            size = statSync(s.file).size
          } catch {
            continue
          }
          state = { offset: size, passageId: null, project: null, sent: 0 }
          tracked.set(s.file, state)
          continue
        }

        const read = readSince(s.file, state.offset)
        if (!read) continue

        state.offset = read.offset
        const cwd = read.cwd ?? s.cwd
        const project = state.project ?? matchProject(cwd, s.encodedCwd)

        if (!project) {
          tracked.set(s.file, state)
          continue
        }
        state.project = project

        // Opening: first activity observed on a tracked project.
        if (!state.passageId && (read.requests > 0 || read.codexTotal !== null)) {
          const objectives = await call('GET', `/projects/${project.slug}/objectives`)
          const target = objectives
            .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
            .sort((a, b) => a.priority - b.priority)[0]

          if (!target) {
            console.log(`  ·  ${s.harness} active on ${project.slug} — no takeable objective, not recorded`)
            tracked.set(s.file, state)
            continue
          }

          const passage = await call('POST', `/objectives/${target.id}/passages`, {
            harness: s.harness,
            git_before: gitAt(project.repo_path, 'rev-parse', 'HEAD'),
            summary: `${s.harness} session observed — ${basename(s.file)}`,
          }).catch(() => null)

          if (!passage?.id) {
            tracked.set(s.file, state)
            continue
          }

          state.passageId = passage.id
          state.objectiveId = target.id
          console.log(`  →  attempt #${passage.id} opened — ${s.harness} on ${project.slug} / objective #${target.id}`)
        }

        // Consommation : Claude publie des deltas, Codex un cumul.
        if (state.passageId) {
          const delta = read.codexTotal !== null ? read.codexTotal - state.sent : read.tokens

          if (delta > 0) {
            state.sent = read.codexTotal !== null ? read.codexTotal : state.sent + delta
            await call('POST', `/passages/${state.passageId}/usage`, {
              tokens: delta,
              cost_usd: read.cost > 0 ? Number(read.cost.toFixed(3)) : undefined,
            }).catch(() => {})
          }

          if (read.lastAt) state.lastAt = Date.parse(read.lastAt)
        }

        tracked.set(s.file, state)
      }

      // Closing: task finished or prolonged silence.
      for (const [file, state] of tracked) {
        if (!state.passageId) continue
        const quiet = state.lastAt && Date.now() - state.lastAt > idleMs
        if (!quiet) continue

        await closePassage(state, file)
        tracked.delete(file)
      }
    }

    const closePassage = async (state, file) => {
      const repo = state.project.repo_path
      const before = (await call('GET', `/passages/${state.passageId}`).catch(() => null))?.git_before
      const after = gitAt(repo, 'rev-parse', 'HEAD')

      // The rule pack decides, not the agent.
      let findings = []
      if (before && after && before !== after) {
        const changed = (gitAt(repo, 'diff', '--name-only', `${before}..${after}`) ?? '')
          .split('\n')
          .filter(Boolean)

        for (const rel of changed) {
          const full = resolve(repo, rel)
          if (!existsSync(full)) continue
          try {
            findings.push(...checkFile(rel, readFileSync(full, 'utf8')))
          } catch {
            /* binaire */
          }
        }
      }

      const halts = findings.filter((f) => f.severity === 'halt')
      const fresh = await call('GET', `/passages/${state.passageId}`).catch(() => null)
      const proven = (fresh?.evidences ?? []).some((e) => e.verdict === 'pass')

      if (halts.length) {
        await call('POST', `/objectives/${state.objectiveId}/halts`, {
          reason: 'piege_rule',
          passage_id: state.passageId,
          detail: halts
            .slice(0, 5)
            .map((f) => `${f.path}:${f.line} [${f.rule}] ${f.why}`)
            .join('\n'),
        }).catch(() => {})
      }

      await call('PATCH', `/passages/${state.passageId}`, {
        verdict: halts.length ? 'halted' : proven ? 'advanced' : 'no_progress',
        git_after: after,
      }).catch(() => {})

      console.log(
        `  ←  attempt #${state.passageId} closed — ${halts.length ? `STOP (${halts.length} rule(s))` : proven ? 'moved it forward' : 'demonstrated nothing'}  [${basename(file)}]`,
      )
    }

    await tick()
    setInterval(() => {
      tick().catch((e) => console.error('  !  cycle en erreur :', e.message))
    }, interval)
  },

  /**
   * The relay: GPT decides, a harness executes, the result goes back to GPT.
   * Runs until it blocks — no more instruction, or a guard that refuses.
   *
   * By default it writes NOTHING into the conversation: `--post` required.
   */
  async relay(...argv) {
    const opts = parseFlags(argv)
    const match = opts.gpt ?? 'chatgpt.com'
    const max = Number(opts.max ?? 5)
    const willPost = Boolean(opts.post)

    if (!config.project) fail('no project: run the relay from a repository that has .orchestrator.json')

    const page = await attach(match).catch((e) => {
      fail(e.message)
    })

    // Which instructions this run has already executed. `chapter` has its own;
    // `relay` referenced that one without declaring it, and crashed on the first
    // directive. A pre-existing fault, in a command nobody had exercised.
    const instructionsDone = new Set()

    console.log(`\n  relay attached to ${page.url.slice(0, 80)}`)
    console.log(`  project ${config.project} · ${max} turns max · ${willPost ? 'EXECUTION AND WRITING ACTIVE' : 'read only — nothing will be executed or posted (--post to act)'}\n`)

    let lastSeen = null

    for (let turn = 1; turn <= max; turn++) {
      // 1. Wait for GPT to finish writing — we trust the text going still, not
      //    the label on a translated button.
      const message = await readJudge(page)

      if (!message || message === lastSeen) {
        console.log(`  turn ${turn} — nothing new from GPT. Stopping.`)
        break
      }
      lastSeen = message

      // The conversation may pronounce a verdict before giving what comes next.
      // We target the objective whose verdict we are waiting on when we have just
      // asked for one: a verdict on another objective does not answer the question
      // asked, and recording it muddles both.
      const verdict = parseVerdict(message)
      if (verdict) {
        const r = await call(
          'POST',
          `/objectives/${verdict.id}/verdict/${verdict.decision}/gpt`,
          null,
          { soft: true },
        )
        if (r) {
          console.log(
            `  verdict from the conversation — #${verdict.id} ${verdict.decision === 'accept' ? 'accepted' : 'rejected'}`,
          )
        }
      }

      const fini = parseDone(message)
      if (fini && !parseDirective(message)) {
        console.log(
          `\n  END DECLARED by the judge${fini.id ? ` sur #${fini.id}` : ''}` +
            `${fini.reason ? ` — ${fini.reason}` : ''}\n`,
        )
        break
      }

      const directive = parseDirective(message)
      if (!directive) {
        console.log(`  turn ${turn} — no @codex: / @claude: instruction in the reply. Stopping.`)
        console.log(`  dernier message : ${message.slice(0, 200)}…\n`)
        break
      }

      console.log(`  turn ${turn} — GPT → ${directive.harness}`)
      console.log(`    « ${directive.task.slice(0, 160)}${directive.task.length > 160 ? '…' : ''} »`)

      // 2. Execute in the named harness, under the usual guards.
      //    Without --post we do NOT execute: a probe announced as "read only" that
      //    starts a real session spends money and, worse, competes with the loop
      //    over the same resources.
      if (!willPost) {
        console.log(`\n    ── read only: nothing was executed ──`)
        console.log(`    ${directive.harness} would receive ${directive.task.length} characters of mission.`)
        console.log(`    Run again with --post to execute and report back.\n`)
        break
      }

      instructionsDone.add(`${directive.harness}:${directive.task.slice(0, 200)}`)
      const outcome = await runHarness(directive.harness, directive.task)

      console.log(
        `    → ${outcome.verdict}${outcome.halts.length ? ` — ${outcome.halts.length} rule(s) broken` : ''}`,
      )

      // 3. Report back to GPT.
      const report = buildReport(turn, directive, outcome)

      if (!willPost) {
        console.log(`\n    ── what would be posted ──\n${indent(report)}\n`)
      } else {
        const posted = await postToJudgeWrapped(page).evaluate(jsPost(report)).catch(() => undefined)

        // The return value can be lost if the page moves: observe instead.
        const landed = await confirmPosted(page, report)

        if (!landed) {
          console.error(`    !  publication impossible : ${posted ?? 'sans retour, et message absent'}`)
          break
        }
        console.log(`    ↑ posted to GPT`)
      }

      if (outcome.stop) {
        console.log(`\n  BLOCKED — ${outcome.stopReason}. The relay stops.\n`)
        break
      }

      await pause(3000)
    }

    page.close()
  },

  /**
   * The context block to paste into the driving conversation.
   * Derived from the real state: it cannot lie about what is blocking.
   */
  /**
   * Posts the full state into the driving conversation. That is the only way to
   * hand it the formatting rules: the loop itself only posts reports.
   */
  async 'brief:post'(...argv) {
    const opts = parseFlags(argv)
    const page = await attach(opts.gpt ?? 'chatgpt.com').catch((e) => fail(e.message))

    const capture = []
    const vrai = console.log
    console.log = (...a) => capture.push(a.join(' '))
    await commands.brief(...argv)
    console.log = vrai

    const texte = capture.join('\n')
    console.log(`\n  relay attached to ${page.url.slice(0, 80)}`)

    if (!opts.post) {
      console.log('  read only — add --post to write\n')
      console.log(texte)
      return
    }

    await postToJudgeWrapped(page).evaluate(jsPost(texte))
    const ok = await confirmPosted(page, texte).catch(() => false)
    console.log(ok ? '  ↑ state posted into the conversation\n' : '  ⚠ send not confirmed — check the page\n')
  },

  async brief(...argv) {
    if (!config.project) fail('no project in .orchestrator.json')

    const opts = parseFlags(argv)
    const all = await call('GET', `/projects/${config.project}/objectives`)

    // Cadrer sur un arbre d'objectifs : la conversation qui pilote n'a pas
    // besoin de voir les chantiers voisins.
    const scope = opts.objective ? Number(opts.objective) : null
    const objectives = scope
      ? all.filter((o) => o.id === scope || o.parent_id === scope)
      : all
    const recall = await call('GET', `/projects/${config.project}/recall`)
    const invariants = await call('GET', `/projects/${config.project}/invariants`)

    const out = []
    const w = (s = '') => out.push(s)

    w(`## Orchestrator state — project ${recall.project.name}`)
    w()

    const stopped = objectives.filter((o) => o.status === 'blocked')

    // An absorbable halt waits for nobody: the loop clears it itself. Announcing
    // it as a "human decision" freezes an objective that could be taken.
    const blocked = []
    const absorbable = []
    for (const o of stopped) {
      const full = await call('GET', `/objectives/${o.id}`)
      const openHaltsOf = (full.halts ?? []).filter((x) => !x.resolved_at)
      ;(openHaltsOf.some((h) => HUMAN_HALTS.includes(h.reason)) ? blocked : absorbable).push({ ...o, openHaltsOf })
    }
    const takeable = objectives
      .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
      .sort((a, b) => a.priority - b.priority)
    const draft = objectives.filter((o) => o.status === 'draft')

    if (blocked.length) {
      w('### Waiting on a human decision — no agent can go around this')
      for (const o of blocked) {
        w(`- **#${o.id} ${o.title}** — ${BLAST_FR[o.blast_radius] ?? o.blast_radius}`)
        for (const h of o.openHaltsOf) {
          w(`  - ${HALT_FR[h.reason] ?? h.reason} : ${(h.detail ?? '').replace(/\n/g, ' ')}`)
        }
      }
      w()
    }

    if (absorbable.length) {
      w('### Halted on a reason the loop clears itself — still takeable')
      for (const o of absorbable) {
        w(`- **#${o.id} ${o.title}**`)
        for (const h of o.openHaltsOf) {
          w(`  - ${HALT_FR[h.reason] ?? h.reason} : ${(h.detail ?? '').replace(/\n/g, ' ')}`)
        }
      }
      w()
    }

    if (takeable.length) {
      w('### Takeable now')
      for (const o of takeable) {
        w(`- **#${o.id} ${o.title}** — ${BLAST_FR[o.blast_radius] ?? o.blast_radius}`)
        if (o.proof_spec) w(`  - proof required: ${o.proof_spec}`)
      }
      w()
    }

    if (draft.length) {
      w('### Not takeable — the proof criterion is missing')
      for (const o of draft) w(`- #${o.id} ${o.title}`)
      w()
    }

    if (recall.decisions.length) {
      w('### Constraints already learned — do not rediscover them')
      for (const d of recall.decisions) {
        w(`- **${d.title}** — ${d.body.replace(/\n/g, ' ')}`)
      }
      w()
    }

    if (config.blastRadius.length) {
      w('### Blast radius — a diff that touches this stops the loop')
      w(config.blastRadius.map((g) => `\`${g}\``).join(' · '))
      w()
    }

    if (invariants.length) {
      w('### Production measurements')
      for (const i of invariants) {
        const state =
          i.last_status === 'breached'
            ? `BREACHED — measured ${trimNumber(i.last_value)}`
            : i.last_status === 'ok'
              ? `ok — measured ${trimNumber(i.last_value)}`
              : 'never measured'
        w(`- ${i.name} ${signOf(i.comparison)} ${trimNumber(i.threshold)} ${i.unit ?? ''} → ${state}`)
        if (i.last_status === 'breached' && i.description) w(`  - ${i.description}`)
      }
      w()
    }

    const inbox = await call('GET', '/toolbox', null, { soft: true })
    if (inbox && Object.keys(inbox).length) {
      w('### The tools available')
      w('Grouped by what they can do, in no particular order — which one fits is')
      w('yours to decide from the work at hand. Name the one you choose in the')
      w('mission: without that, the executor improvises.')
      w()
      // Measured, not guessed: a session's context saturates near the context
      // window after roughly 80 tool calls, and every call past that point re-reads
      // a full window. One pass made 393 requests and consumed 89 M tokens, 97 % of
      // it cache re-reads. The cost is `requests × window`, so the only lever that
      // moves is the NUMBER of round trips — and the judge is the one who writes
      // the mission that makes them.
      w('**Ask for batched calls.** A session\'s context saturates after roughly eighty')
      w('tool calls, and every call past that point re-reads the whole window. Cost is')
      w('the number of round trips, not their size. So when a mission needs many')
      w('operations of the same kind, require them in one batched call — `batch_execute`')
      w('over fifty separate `execute_code`, one query returning a list over fifty')
      w('queries. Say it in the mission: the executor will not do it on its own.')
      for (const [capacite, outils] of Object.entries(inbox)) {
        const dispo = outils.filter((o) => o.joignable !== 'absent')
        if (!dispo.length) continue
        // What each one IS, not only how it is reached. A rented machine keeps
        // billing until it is shut down; an image service refuses on quota and
        // says nothing useful about it. A mission that treats them as
        // interchangeable wastes one of them.
        const NATURE = {
          model: 'a model',
          machine: 'a rented machine — it bills until it is shut down',
          service: 'a service',
          browser: 'a web interface driven through a tab',
        }
        w(`- **${capacite}** : ${dispo.map((o) => {
          const acces = o.reach === 'api'
            ? `by API${o.env_var ? `, key in \`$${o.env_var}\`` : ''}`
            : o.reach === 'browser'
              ? `through the browser (${o.settings?.match ?? 'dedicated tab'})`
              : 'locally'
          const nature = o.kind ? `${NATURE[o.kind] ?? o.kind}, ` : ''
          return `${o.label} — ${nature}${acces}`
        }).join(' · ')}`)
        // The note belongs to the tool that carries it. Attaching it to whichever
        // came first put one tool's caveat under another's name.
        for (const o of dispo) {
          if (o.settings?.note) w(`  - ${o.label} — worth knowing: ${o.settings.note}`)
        }
      }
      w()
    }

    w('### How to answer')
    w('Answer exactly as you always have: a reasoned verdict, a reading of the images, the')
    w('working mode, then the full mission. Shorten nothing — this is not a chat channel,')
    w('it is a production order.')
    w()
    w('**Three markers, each alone on its line.** They are not decoration: a tool reads')
    w('your reply and is not allowed to guess. A sentence like "the chapter is finished"')
    w('or "everything looks satisfied" is indistinguishable from a comment, and the loop')
    w('spins on nothing.')
    w()
    w('```')
    w('@verdict: #14 accepted        ← or "rejected". Your judgement, unambiguous.')
    w('@fini: #11 reason            ← only when there is nothing left to produce.')
    w('@claude:                     ← or @codex:, followed by the full mission.')
    w('```')
    w()
    w('Put `@verdict` down the moment you judge something, **before** your explanations.')
    w('Put `@fini` down only when you give no mission after it.')
    w()
    w('```')
    w('@claude:')
    w('<the full mission — as many lines, sections and separators as it takes: required')
    w(' reading, documentary hierarchy, prohibitions, objective, composition, loop')
    w(' format, scoring, gate, deliverables. Everything after the marker is passed to')
    w(' the harness word for word, and nothing else reaches it: what is not inside this')
    w(' block does not exist for it.>')
    w('```')
    w()
    w('`@codex:` for the other harness. Cite the target objective number (`#12`) inside')
    w('the mission — that is what attaches it to the right objective.')
    w()
    w('Without a marker, the loop stops — that is deliberate.')
    w('An instruction aimed at a halted objective, or one with no proof criterion, will be refused by the tool.')

    console.log(out.join('\n'))
  },

  /**
   * Runs an instruction in a harness, framed by an attempt and the guards, and
   * returns the report ready to paste into the driving conversation. This is step 3
   * of the loop, without a browser.
   */
  async do(harness, ...rest) {
    if (!['codex', 'claude'].includes(harness)) {
      fail('usage: orchestrator do <codex|claude> [--probe] "<memoryInstruction>"')
    }

    // A diagnostic probe is not an attempt: it attaches to no objective and counts
    // in no guardrail.
    const probe = rest.includes('--probe')
    const task = rest.filter((a) => a !== '--probe').join(' ').trim()
    if (!task) fail('empty instruction')

    if (probe) {
      console.log(`\n  ${harness} — probe (no objective)\n`)
      const [bin, args] =
        harness === 'codex'
          ? [harnessBin('codex'), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', task]]
          : [harnessBin('claude'), ['-p', task]]
      try {
        console.log(
          execFileSync(bin, args, {
            encoding: 'utf8',
            cwd: process.cwd(),
            env: { ...process.env, ...config.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 32 * 1024 * 1024,
            timeout: 10 * 60 * 1000,
          }).trim(),
        )
      } catch (e) {
        console.error(`${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message)
        process.exitCode = 1
      }
      return
    }

    console.log(`\n  ${harness} — instruction received`)
    console.log(`  « ${task.slice(0, 200)}${task.length > 200 ? '…' : ''} »\n`)

    const outcome = await runHarness(harness, task)

    console.log(`  verdict : ${outcome.verdict}`)
    if (outcome.stopReason) console.log(`  STOP: ${outcome.stopReason}`)
    console.log('')
    console.log('  ── report to paste into the conversation ──')
    console.log('')
    console.log(buildReport(1, { harness, task }, outcome))
    console.log('')

    if (outcome.stop) process.exitCode = 2
  },

  /**
   * Writes the permissions decided in the tool into the harness configuration.
   * The decision is made once, it applies everywhere.
   */
  async 'permissions:sync'(harness = 'claude') {
    if (!config.project) fail('no project in .orchestrator.json')

    const eff = await call('GET', `/projects/${config.project}/permissions/effective/${harness}`)
    const file = resolve(process.cwd(), '.claude/settings.json')

    if (harness !== 'claude') {
      console.log(`writing ${harness} config: not implemented yet`)
      return
    }

    let settings = {}
    if (existsSync(file)) {
      try {
        settings = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        fail(`${file} is unreadable — not overwriting it`)
      }
    }

    settings.permissions = {
      ...(settings.permissions ?? {}),
      allow: eff.allow,
      deny: eff.deny,
      ask: eff.ask,
    }

    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')

    console.log(`  ${eff.allow.length} allowed · ${eff.deny.length} refused · ${eff.ask.length} undecided`)
    console.log(`  written to ${relative(process.cwd(), file)}`)
  },

  /** Remonte dans l'outil les outils qu'une session s'est vu refuser. */
  async 'permissions:collect'(transcriptArg) {
    if (!config.project) fail('no project in .orchestrator.json')

    const dir = config.transcripts ?? defaultTranscriptDir()
    const file =
      transcriptArg ??
      (existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => resolve(dir, f))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
        : null)

    if (!file || !existsSync(file)) return console.log('no transcript to comb through')

    const found = new Set()
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('permission')) continue
      const m = line.match(/requested permissions to use ([A-Za-z0-9_()*.\- ]+?)(?:,|\\n|")/)
      if (m) found.add(m[1].trim())
    }

    if (!found.size) return console.log('no permission refusal in this transcript')

    const res = await call('POST', `/projects/${config.project}/permissions/requested`, {
      patterns: [...found],
      harness: 'claude',
    })

    console.log(`  ${res.length} tool(s) reported:`)
    for (const p of res) console.log(`    ${p.decision === 'ask' ? 'À TRANCHER' : p.decision}  ${p.pattern}`)
  },

  /**
   * Closes a chapter: runs until the parent objective is proven, absorbing the
   * problems the loop knows how to handle and stopping ONLY on what genuinely
   * calls for a human decision.
   */
  /**
   * Breaks a free-form brief into a chapter plus provable steps. The local agent
   * makes the call — the server never starts anything itself — and returns a
   * PROPOSAL: a human applies it from the screen, or does not.
   *
   * usage: orchestrator plan [--watch] [--every 8]
   */
  async plan(...argv) {
    const opts = parseFlags(argv)
    if (!config.project) fail('no project: run this from a repository that has .orchestrator.json')

    const looping = Boolean(opts.watch)
    const pauseMs = Number(opts.every ?? 8) * 1000

    console.log(
      `\n  brief breakdown — project ${config.project}` +
        (looping ? ` · watching, checks every ${pauseMs / 1000} s` : ' · one pass') +
        '\n',
    )

    do {
      const pris = await call('POST', `/projects/${config.project}/briefs/claim`, { harness: 'claude' }, { soft: true })
      const brief = pris?.brief

      if (!brief) {
        if (!looping) {
          console.log('  no brief waiting.\n')
          return
        }
        await pause(pauseMs)
        continue
      }

      console.log(`  brief #${brief.id} — ${brief.body.length} characters`)

      // The breakdown has to know the constraints already settled, otherwise it
      // proposes criteria the project has already ruled out.
      const recall = await call('GET', `/projects/${config.project}/recall`, null, { soft: true })
      const constraints = (recall?.decisions ?? [])
        .slice(0, 8)
        .map((d) => `- ${d.title} : ${String(d.body).slice(0, 240)}`)
        .join('\n')
      const proofs = Object.entries(config.proofs ?? {})
        .map(([k, v]) => `- ${k} : ${v}`)
        .join('\n')

      const memoryInstruction = [
        'Break the request below into ONE chapter and its execution steps.',
        '',
        'Rules for the breakdown:',
        '- every step must be completable in a single agent session;',
        '- every step carries a VERIFIABLE proof criterion, written as a condition, not as an intention. A command that passes, a number crossing a threshold, a screenshot showing something named. Never "it is clean" or "it works better";',
        '- the steps are in the order they must be executed;',
        '- between 2 and 12 steps. If the request only justifies one, do not invent more;',
        '- blast_radius: cosmetic (visual), feature (visible function), api (data or shared interface), critical (money, payroll, production).',
        proofs ? `\nProof commands declared by this project — reuse them as they are when they fit:\n${proofs}` : '',
        constraints ? `\nConstraints already settled on this project — do not contradict them:\n${constraints}` : '',
        '',
        '--- LA DEMANDE ---',
        brief.body,
        '--- FIN ---',
        '',
        'Reply ONLY with a JSON object, with no text around it and no code fence:',
        '{"chapter":"…","intent":"…","steps":[{"title":"…","proof_spec":"…","blast_radius":"feature"}]}',
      ]
        .filter(Boolean)
        .join('\n')

      let raw = ''
      try {
        // Breaking a brief down needs no tools: we refuse all repository access so
        // the pass stays short, cheap and side-effect free.
        raw = execFileSync(
          'claude',
          ['-p', memoryInstruction, '--disallowed-tools', 'Bash', 'Write', 'Edit', 'NotebookEdit'],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            // Third-party service secrets live on THIS machine and only enter the
      // process for the duration of the session. The server never had them: it
      // only knows the NAME of the expected variable.
      env: { ...process.env, ...(config.secrets ?? {}), ...config.env, ORCHESTRATOR_MANAGED: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      } catch (e) {
        console.error(`    harness failed: ${e.message}`)
        await call('PATCH', `/briefs/${brief.id}/propose`, { error: e.message.slice(0, 900) }, { soft: true })
        continue
      }

      const proposal = extraireJson(raw)

      if (!proposal?.chapter || !Array.isArray(proposal.steps) || !proposal.steps.length) {
        console.error('    unusable reply: no readable JSON breakdown')
        await call(
          'PATCH',
          `/briefs/${brief.id}/propose`,
          { error: `Unusable reply from the harness.\n\n${raw.slice(0, 900)}` },
          { soft: true },
        )
        continue
      }

      const r = await call('PATCH', `/briefs/${brief.id}/propose`, { proposal: proposal }, { soft: true })
      console.log(
        r
          ? `    → ${proposal.steps.length} step(s) proposed · “${proposal.chapter}”`
          : `    → the server refused the proposal`,
      )
      const sans = proposal.steps.filter((e) => !e.proof_spec).length
      if (sans) console.log(`    ${sans} step(s) with no proof criterion — they will stay undefined.`)
    } while (looping)
  },

  /**
   * Observes what is actually reachable FROM THIS MACHINE and reports it.
   * Reachability is not a checkbox on a form: a missing binary or a closed Chrome
   * are not declared, they are observed.
   *
   * usage: orchestrator agents:check
   */
  async 'agents:check'() {
    const agents = await call('GET', '/agents')
    const machine = hostname()
    const results = []

    for (const a of agents) {
      let status = 'unknown'
      let detail = null

      if (!a.enabled) {
        status = 'unknown'
        detail = 'disabled — not checked'
      } else if (a.reach === 'cli') {
        // We look ONLY for binaries this machine declares it knows. Probing by the
        // agent's name found anything at all: "gpt" resolved to /usr/sbin/gpt,
        // macOS's partitioning tool, and the screen proudly announced a reachable
        // harness that does not exist.
        const connus = { ...(config.binaries ?? {}), claude: harnessBin('claude'), codex: harnessBin('codex') }
        const bin = connus[a.name]

        if (!bin) {
          status = 'unknown'
          detail = `no binary declared for “${a.name}” — add it under binaries in .orchestrator.json`
        } else {
          try {
            const path = execFileSync(
              '/bin/sh',
              ['-c', `command -v ${JSON.stringify(bin)} 2>/dev/null || { test -x ${JSON.stringify(bin)} && echo ${JSON.stringify(bin)}; }`],
              { encoding: 'utf8' },
            ).trim()
            if (path) {
              status = 'ok'
              detail = path.split('\n')[0].slice(0, 200)
            } else {
              status = 'absent'
              detail = `introuvable : ${bin}`
            }
          } catch {
            status = 'absent'
            detail = `introuvable : ${bin}`
          }
        }
      } else if (a.reach === 'browser') {
        const port = a.settings?.cdp_port ?? 9222
        const match = a.settings?.match ?? 'chatgpt.com'
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2500) })
          const tabs = await res.json()
          const target = tabs.find((t) => t.type === 'page' && String(t.url).includes(match))
          if (target) {
            status = 'ok'
            detail = String(target.url).slice(0, 200)
          } else {
            status = 'refused'
            detail = `navigateur joignable sur ${port}, mais aucun onglet ${match}`
          }
        } catch {
          status = 'absent'
          detail = `no browser listening on port ${port}`
        }
      } else if (a.reach === 'api') {
        // A key lives server-side: this machine can say nothing about it.
        status = a.has_key ? 'unknown' : 'absent'
        detail = a.has_key ? 'key set — only verifiable server-side' : 'no key set'
      }

      results.push({ name: a.name, status, detail })
      const mark = { ok: '●', absent: '○', refused: '◐', unknown: '·' }[status]
      console.log(`  ${mark} ${a.label.padEnd(32)} ${status.padEnd(8)} ${detail ?? ''}`)
    }

    await call('POST', '/agents/checkin', { machine, results }, { soft: true })
    console.log(`\n  scan sent from ${machine}\n`)
  },

  /**
   * Generates an image through a web interface and writes it to disk.
   * usage: orchestrator image "<prompt>" [--tool nano-banana] [--out path.png]
   */
  async image(...argv) {
    const opts = parseFlags(argv)
    const prompt = argv
      .filter(
        (a) =>
          !a.startsWith('--') &&
          !['tool', 'out'].includes(argv[argv.indexOf(a) - 1]?.replace('--', '')),
      )
      .join(' ')
      .trim()

    if (!prompt) {
      console.log(`usage: orchestrator image "<prompt>" [--tool ${Object.keys(ADAPTERS).join('|')}] [--out file.png]`)
      return
    }

    const tool = opts.tool ?? opts.outil ?? 'nano-banana'
    console.log(`\n  ${ADAPTERS[tool]?.label ?? tool} — request sent, waiting for the image…\n`)

    try {
      const r = await generateImage({ tool, prompt, out: opts.out })
      console.log(`  ✔ ${r.path} — ${r.width}×${r.height}, ${(r.bytes / 1024).toFixed(0)} kB\n`)
    } catch (e) {
      console.error(`  ✖ ${e.message}\n`)
      process.exitCode = 1
    }
  },

  /**
   * Scans and distils the machine's AI memories, project by project. The inventory
   * is free and is shown before anything is sent; distilling only runs afterwards,
   * and returns a PROPOSAL a human applies or does not.
   *
   * usage: orchestrator memory:scan [--watch] [--repos a,b] [--analyse]
   */
  async 'memory:scan'(...argv) {
    const opts = parseFlags(argv)
    const looping = Boolean(opts.watch)

    const repos = (opts.repos ? String(opts.repos).split(',') : [])
      .map((d) => resolve(d.trim()))
      .filter(Boolean)

    // With no repositories named, we take the ones the tool already tracks: those
    // at least are declared somewhere, and we do not go rummaging through the disk.
    if (!repos.length) {
      const projects = await call('GET', '/projects', null, { soft: true })
      for (const p of projects ?? []) if (p.repo_path) repos.push(p.repo_path)
    }

    do {
      const pris = looping
        ? (await call('POST', '/scans/claim', { machine: hostname() }, { soft: true }))?.scan
        : { id: null }

      if (looping && !pris) {
        await pause(Number(opts.every ?? 8) * 1000)
        continue
      }

      console.log(`\n  memory scan — ${repos.length} declared repository(ies)\n`)
      const inv = inventoryMemories(repos)

      console.log(`  ${inv.total} fichier(s) · ${(inv.bytes / 1024).toFixed(0)} ko`)
      for (const [project, p] of Object.entries(inv.projects)) {
        console.log(`    ${project.padEnd(26)} ${String(p.count).padStart(4)} fichiers · ${(p.bytes / 1024).toFixed(0)} ko`)
      }

      if (pris?.id) {
        await call(
          'PATCH',
          `/scans/${pris.id}`,
          { inventory: inv, status: 'inventoried', fingerprint: memoryFingerprint(inv) },
          { soft: true },
        )
      }

      if (!opts.analyser) {
        console.log(`\n  inventory only. Run again with --analyse to distil (one model call per project).\n`)
        if (!looping) return
        continue
      }

      const results = {}

      for (const [project, p] of Object.entries(inv.projects)) {
        if (project === 'inconnu' || p.count < 2) continue

        const { body, taken: read, skipped, bytes } = assembleContext(p.files)
        console.log(
          `\n  ${project} — ${read.length} file(s) read, ${(bytes / 1024).toFixed(0)} ko` +
            (skipped.length ? ` · ${skipped.length} set aside, too large` : ''),
        )

        let raw
        try {
          raw = execFileSync(
            'claude',
            ['-p', memoryInstruction(project, body), '--disallowed-tools', 'Bash', 'Write', 'Edit'],
            { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ORCHESTRATOR_MANAGED: '1' } },
          )
        } catch (e) {
          console.error(`    failed: ${String(e.message).slice(0, 160)}`)
          results[project] = { error: String(e.message).slice(0, 400), sources: read, skipped }
          continue
        }

        const distille = extraireJson(raw)
        if (!Array.isArray(distille?.projects) || !distille.projects.length) {
          console.error(`    unusable reply`)
          results[project] = { error: 'unusable reply', sources: read, skipped }
          continue
        }

        // A shared root yields several projects: file them separately rather than
        // letting one overwrite the other.
        for (const block of distille.projects) {
          const key = block.name?.trim() || project
          // Path lists repeat for every sub-project under the same root: 594 paths
          // × 10 projects blew the request up. We keep the counts, which is what we
          // display, plus a readable sample.
          results[key] = {
            ...block,
            written_to: project,
            sources_count: read.length,
            sources: read.slice(0, 30),
            skipped_count: skipped.length,
          }
          console.log(
            `    → ${key} : ${(block.constraints ?? []).length} contrainte(s)` +
              `${(block.contradictions ?? []).length ? `, ${block.contradictions.length} contradiction(s)` : ''}` +
              `${(block.stale ?? []).length ? `, ${block.stale.length} stale` : ''}`,
          )
        }
      }

      // Distilling costs money: it is written to disk BEFORE being sent. A
      // transport failure must never erase work already paid for — that happened,
      // and it all had to be redone.
      const fallbackFile = join(homedir(), '.orchestrator', `memoires-${Date.now()}.json`)
      mkdirSync(dirname(fallbackFile), { recursive: true })
      writeFileSync(fallbackFile, JSON.stringify({ inventaire: inv, results }, null, 2))

      let sent = false
      if (pris?.id) {
        sent = Boolean(
          await call('PATCH', `/scans/${pris.id}`, { result: results, status: 'analysed' }, { soft: true }),
        )
      }

      console.log(`\n  ${Object.keys(results).length} project(s) distilled`)
      console.log(sent ? `  → visible in the overview.` : `  → the upload failed, everything is in ${fallbackFile}`)
      console.log()
    } while (looping)
  },

  /**
   * Watches the memories: compares their state to the last scan's fingerprint and
   * says so when they have moved. A scan that ages without saying so is worse than
   * no scan — you believe you are reading the present.
   *
   * usage: orchestrator memory:watch [--every 300]
   */
  async 'memory:watch'(...argv) {
    const opts = parseFlags(argv)
    const pauseMs = Number(opts.every ?? 300) * 1000

    const projects = await call('GET', '/projects', null, { soft: true })
    const repos = (projects ?? []).map((p) => p.repo_path).filter(Boolean)

    console.log(`\n  watching the memories — ${repos.length} repository(ies), every ${pauseMs / 1000} s\n`)

    let dernierSignale = null

    for (;;) {
      const scans = await call('GET', '/scans', null, { soft: true })
      const latest = (scans ?? []).find((s) => s.fingerprint)

      if (!latest) {
        console.log(`  no scan with a fingerprint — run “orchestrator memory:scan” first`)
        if (!opts.every) return
        await pause(pauseMs)
        continue
      }

      const current = memoryFingerprint(inventoryMemories(repos))
      const moved = current !== latest.fingerprint

      await call(
        'PATCH',
        `/scans/${latest.id}`,
        { fingerprint_seen: current, seen_at: new Date().toISOString() },
        { soft: true },
      )

      if (moved && current !== dernierSignale) {
        dernierSignale = current
        console.log(`  ${new Date().toLocaleTimeString('en-GB')} — the memories have changed since scan #${latest.id}`)
      } else if (!moved) {
        dernierSignale = null
      }

      if (!opts.every) return
      await pause(pauseMs)
    }
  },

  /**
   * The worker: it takes the runs the interface asked for and carries them out.
   *
   * The server records intents and executes nothing — that rule is what would make
   * a hosted version defensible, and it is not negotiable. So a process on the
   * machine that actually holds the repository polls for work, claims it, and runs
   * the loop. Same shape as `plan --watch`, for the same reason.
   *
   * Until this existed, every run had to be typed into a terminal and the
   * interface was a read-only mirror of work started somewhere else — which is not
   * a tool, it is a dashboard.
   *
   * usage: orchestrator work [--every 5]
   */
  async work(...argv) {
    const opts = parseFlags(argv)
    if (!config.project) fail('no project: run this from a repository that has .orchestrator.json')

    const every = Math.max(2, Number(opts.every ?? 5)) * 1000
    console.log(`\n  worker on ${config.project} — checking every ${every / 1000} s\n`)

    // Anything left `running` on this machine has no process behind it any more:
    // this worker is the process, and it has just started. Releasing them is what
    // stops a killed worker from blocking its objective for good.
    const freed = await call('POST', '/runs/release', { machine: hostname() }, { soft: true }).catch(
      () => null,
    )
    if (freed?.released?.length) {
      console.log(`  released ${freed.released.length} run(s) whose worker had stopped\n`)
    }

    for (;;) {
      const claimed = await call(
        'POST',
        `/projects/${config.project}/runs/claim`,
        { machine: hostname(), pid: process.pid },
        { soft: true },
      ).catch(() => null)

      const run = claimed?.run
      if (!run) {
        await pause(every)
        continue
      }

      console.log(
        `  run #${run.id} — ${run.mode}${run.objective_id ? ` on #${run.objective_id}` : ''}` +
          `${run.post ? '' : ' · read only'}`,
      )

      const argsFor =
        run.mode === 'plan'
          ? ['--once']
          : [
              '--objective',
              String(run.objective_id),
              '--max-turns',
              String(run.max_turns),
              '--budget',
              String(run.budget ?? 0),
              '--budget-sans-progres',
              String(run.budget_without_progress),
              ...(run.post ? ['--post'] : []),
              '--run',
              String(run.id),
            ]

      try {
        await commands[run.mode === 'plan' ? 'plan' : 'chapter'](...argsFor)
        await call('PATCH', `/runs/${run.id}`, { status: 'done' }, { soft: true }).catch(() => {})
        console.log(`  run #${run.id} — finished\n`)
      } catch (e) {
        // A run that throws must not take the worker with it: the next one in the
        // queue has nothing to do with this failure.
        await call(
          'PATCH',
          `/runs/${run.id}`,
          { status: 'failed', error: String(e.message).slice(0, 500) },
          { soft: true },
        ).catch(() => {})
        console.error(`  run #${run.id} — failed: ${String(e.message).slice(0, 160)}\n`)
      }
    }
  },

  async chapter(...argv) {
    // Inside a loop, a gate refusal is information to act on, not a reason to die:
    // it is in fact exactly what we are trying to produce.
    process.env.ORCHESTRATOR_BOUCLE = '1'
    const opts = parseFlags(argv)
    const chapterId = Number(opts.objective ?? opts.chapter)
    // Set when the interface asked for this run: it is what lets the loop report
    // its turn and be stopped from the screen rather than from a terminal.
    const runId = opts.run ? Number(opts.run) : null
    if (!chapterId) fail('usage: orchestrator chapter --objective <id> [--budget 60] [--max-turns 12] [--post]')

    let budget = Number(opts.budget ?? 0)
    let maxTurns = Number(opts['max-turns'] ?? 12)
    // The real guardrail: what we tolerate spending WITHOUT an objective moving
    // forward. Neither dollars nor turn counts measure progress; this one does. An
    // expensive turn that proves an objective is cheap.
    let budgetWithoutProgress = Number(opts['budget-sans-progres'] ?? 40)

    // The declared workflow beats these defaults: it is what says where to stop,
    // what to absorb, and how far to go. Command-line options still win — they are
    // explicit.
    const workflows = await call('GET', `/projects/${config.project}/workflows`, null, { soft: true })
    const wf = (workflows ?? []).find((w) => w.active && (!opts.workflow || w.name === opts.workflow))

    let stopReasons = HUMAN_HALTS
    let sterileTurns = 3

    if (wf) {
      stopReasons = wf.stop_when?.halts ?? HUMAN_HALTS
      sterileTurns = wf.stop_when?.tours_steriles ?? 3
      if (!opts.budget && wf.stop_when?.budget) budget = Number(wf.stop_when.budget)
      if (!opts['budget-sans-progres'] && wf.stop_when?.budget_sans_progres) {
        budgetWithoutProgress = Number(wf.stop_when.budget_sans_progres)
      }
      if (!opts['max-turns'] && wf.stop_when?.max_turns) maxTurns = Number(wf.stop_when.max_turns)

      console.log(`\n  workflow « ${wf.name} »`)
      for (const [i, e] of (wf.steps ?? []).entries()) {
        console.log(`    ${i + 1}. ${e.label ?? e.do}`)
      }
      console.log(`    stops on: ${stopReasons.join(', ')}`)
      console.log(`    absorbe      : ${(wf.absorb ?? []).join(', ') || '—'}`)
    }
    const willPost = Boolean(opts.post)

    // The driving conversation is declared by the project, no longer frozen in the
    // code: a project can have its own thread, and the judge can be an AI other
    // than ChatGPT.
    const project = (await call('GET', '/projects', null, { soft: true }))?.find(
      (p) => p.slug === config.project,
    )
    const match = opts.gpt ?? project?.judge_url ?? 'chatgpt.com'
    if (project?.judge_url) {
      console.log(`  judge: ${project.judge_agent ?? 'gpt'} — ${project.judge_url.slice(0, 72)}`)
    }

    if (!config.project) fail('no project: run this from a repository that has .orchestrator.json')

    const page = await attach(match).catch((e) => fail(e.message))

    console.log(
      `\n  chapter #${chapterId} · ${maxTurns} turns max${budget ? ` · budget $${budget}` : ' · free budget'}` +
        ` · stops at $${budgetWithoutProgress} without progress · ${willPost ? 'EXECUTION ACTIVE' : 'read only — nothing will be executed'}\n`,
    )

    let lastSeen = null
    let spent = 0
    let consecutiveEmpty = 0
    let sterile = 0
    let spentSinceProgress = 0
    let tokensWithoutProgress = 0
    // 60 M tokens with no proof: the order of magnitude of an expensive Claude
    // pass, so a bound that lets work happen without letting it drift.
    const plafondJetons = Number(opts['plafond-jetons'] ?? 60_000_000)
    let provenBefore = null
    let demandeFaite = false
    const instructionsDone = new Set()

    for (let turn = 1; turn <= maxTurns; turn++) {
      // 1. Le chapitre est-il clos ?
      const chapter = await call('GET', `/objectives/${chapterId}`)

      // An objective proven since the last turn: the counter resets.
      const proven = (chapter.children ?? []).filter((c) => c.status === 'proven').length
      if (provenBefore !== null && proven > provenBefore) {
        console.log(`  (+${proven - provenBefore} objective(s) proven — unproductivity counter reset)`)
        spentSinceProgress = 0
        sterile = 0
        tokensWithoutProgress = 0
      }
      provenBefore = proven

      if (chapter.status === 'proven') {
        console.log(`\n  CHAPTER CLOSED — #${chapterId} is proven.\n`)
        break
      }

      // All the work is done but the verdict belongs to a human: the loop has
      // finished its part. Continuing would be spinning.
      const children = chapter.children ?? []
      const restants = children.filter((c) => !['proven', 'abandoned'].includes(c.status))

      if (children.length && !restants.length) {
        const judge = project?.gate_judge ?? 'gpt'
        const gate = chapter.gate ?? {}

        // Every part proven does not mean the chapter has passed ITS gate: it has
        // a criterion of its own. If the gate is asking for work, requesting a
        // verdict would send the loop in circles — the judge accepts, the gate
        // refuses, round again.
        if (!gate.ok && !gate.ready && willPost && !demandeFaite) {
          demandeFaite = true
          console.log(`\n  All ${children.length} sub-objectives are proven, but the chapter does not conclude:`)
          console.log(`  ${gate.detail ?? gate.reason}\n`)

          await postToJudgeWrapped(page)
            .evaluate(
              jsPost(
                `The ${children.length} sub-objectives of chapter **#${chapterId} ${chapter.title}** are proven, ` +
                  `but the chapter itself cannot conclude:\n\n> ${gate.detail ?? gate.reason}\n\n` +
                  `What had to be true to conclude it:\n> ${chapter.proof_spec ?? '(not stated)'}\n\n` +
                  `So a verdict is not what is needed, **work on the chapter itself** is. ` +
                  `Donne la mission qui le rendra concluable, comme d'habitude.`,
              ),
            )
            .catch(() => {})

          // We do NOT skip the rest of the turn: that is the part which reads the
          // reply and executes the mission. A `continue` here asked the question
          // again without ever listening — the loop was talking to itself.
          await pause(5000)
        }

        // The chapter needs work: let the turn run normally rather than concluding
        // or handing back.
        if (!gate.ok && !gate.ready) {
          // rien : on tombe dans la lecture du message, plus bas
        } else {

        // Handing back to a human when the project's judge IS the conversation
        // makes no sense: the loop knows who to ask, and stopping there left a
        // finished chapter lying around for days.
        if (judge !== 'human' && willPost) {
          console.log(`\n  WORK FINISHED — all ${children.length} sub-objectives are proven.`)
          console.log(`  Fetching the chapter's verdict from the judge.\n`)

          const proofs = (chapter.evidences ?? []).length
          await postToJudgeWrapped(page)
            .evaluate(
              jsPost(
                `All ${children.length} sub-objectives of chapter **#${chapterId} ${chapter.title}** are proven:\n` +
                  children.map((e) => `- #${e.id} ${e.title}`).join('\n') +
                  `\n\nWhat had to be true to conclude the chapter:\n> ${chapter.proof_spec ?? '(not stated)'}` +
                  `\n\n${proofs} proof(s) are attached to the chapter itself.` +
                  `\n\n**Pronounce the CHAPTER's verdict**, not its steps': write "@verdict: #${chapterId} accepted" or "@verdict: #${chapterId} rejected".` +
                  ` If it is rejected, give the follow-up mission as usual.`,
              ),
            )
            .catch(() => {})

          // We wait for its verdict like any other: same loop, not a special case.
          const reponse = await readJudge(page)
          const v = reponse ? parseVerdict(reponse) : null

          if (v && Number(v.id) === Number(chapterId)) {
            const r = await call('POST', `/objectives/${chapterId}/verdict/${v.decision}/gpt`, null, { soft: true })
            console.log(
              `  chapter verdict — #${chapterId} ${v.decision === 'accept' ? 'accepted' : 'rejected'}` +
                (r?.status === 'proven' ? ' · CHAPTER CLOSED' : ''),
            )
            if (v.decision === 'reject') {
              lastSeen = reponse
              continue
            }
          } else {
            console.log(`  aucun verdict lisible sur le chapitre. À reprendre au prochain tour.`)
          }
          break
        }

        console.log(`\n  WORK FINISHED — all ${children.length} sub-objectives are proven.`)
        console.log(`  The chapter's verdict is yours: this project requires a human judge.\n`)
        break
        }
      }

      const humanHalt = (chapter.halts ?? []).find(
        (h) => !h.resolved_at && stopReasons.includes(h.reason),
      )
      if (humanHalt) {
        console.log(`\n  STOP — ${humanHalt.reason} on the chapter. A human decision is required.`)
        console.log(`  ${humanHalt.detail}\n`)
        break
      }

      // 2. Ce que dit GPT.
      const message = await readJudge(page)

      // An UNCHANGED message is not silence: it may carry a mission that was never
      // executed. Atlas stopped on "GPT is not answering any more" while its last
      // reply contained the consolidation mission, simply because it had already
      // been READ. What counts is not whether the text changed, it is whether its
      // instruction was honoured.
      const consigneVue = message ? parseDirective(message) : null
      const memoryFingerprint = consigneVue ? `${consigneVue.harness}:${consigneVue.task.slice(0, 200)}` : null
      const dejaFaite = memoryFingerprint ? instructionsDone.has(memoryFingerprint) : false

      if (!message || (message === lastSeen && (!memoryFingerprint || dejaFaite))) {
        consecutiveEmpty += 1
        if (consecutiveEmpty >= 2) {
          console.log(
            `\n  ARRÊT — ${
              dejaFaite
                ? 'the conversation is repeating an instruction already executed without giving a new one.'
                : 'GPT stopped answering after two waits.'
            }\n`,
          )
          break
        }
        console.log(`  turn ${turn} — nothing new, waiting again`)
        await pause(8000)
        continue
      }

      if (message === lastSeen && memoryFingerprint && !dejaFaite) {
        console.log(`  turn ${turn} — same message, but its instruction was never executed`)
      }

      consecutiveEmpty = 0
      lastSeen = message

      // The conversation may pronounce a verdict before giving what comes next.
      // We target the objective whose verdict we are waiting on when we have just
      // asked for one: a verdict on another objective does not answer the question
      // asked, and recording it muddles both.
      const verdict = parseVerdict(message)
      if (verdict) {
        const r = await call(
          'POST',
          `/objectives/${verdict.id}/verdict/${verdict.decision}/gpt`,
          null,
          { soft: true },
        )
        if (r) {
          console.log(
            `  verdict from the conversation — #${verdict.id} ${verdict.decision === 'accept' ? 'accepted' : 'rejected'}`,
          )
          // A proof has just been accepted: the unproductivity counter no longer
          // has any reason to exist. Without this, the loop stops for "nothing
          // proven" on the very turn where it just proved something, because the
          // recount only happens on the next one.
          if (verdict.decision === 'accept') {
            spentSinceProgress = 0
            tokensWithoutProgress = 0
            sterile = 0
            provenBefore = null
          }
        }
      }

      const fini = parseDone(message)
      if (fini && !parseDirective(message)) {
        console.log(
          `\n  END DECLARED by the judge${fini.id ? ` sur #${fini.id}` : ''}` +
            `${fini.reason ? ` — ${fini.reason}` : ''}\n`,
        )
        break
      }

      const directive = parseDirective(message)
      if (!directive) {
        console.log(`  turn ${turn} — no instruction in the reply. Asking again.`)
        if (willPost) {
          await postToJudgeWrapped(page).evaluate(
            jsPost(
              'No usable instruction in your reply. End with `@claude:` or `@codex:` alone on its line, followed by the full mission citing the target objective number — everything after that marker is passed to the harness word for word. Or say explicitly that the chapter is finished.',
            ),
          )
        }
        await pause(5000)
        continue
      }

      // A turn costs on the order of $15-25: if what is left of the budget cannot
      // absorb one, better to stop than to cut it off mid-flight.
      // With no known rate for a harness, a dollar budget cannot see it: on
      // Blockrise all the useful work came from Codex and the guardrail would never
      // have fired. So we bound on TOKENS, which are always measurable. An invented
      // figure would be worse; so would no guardrail at all.
      if (tokensWithoutProgress >= plafondJetons) {
        console.log(
          `\n  STOP — ${(tokensWithoutProgress / 1e6).toFixed(1)} M tokens consumed without a single objective being proven.` +
            `\n  Dollar cost is not measurable for this harness, so the bound is on tokens.\n`,
        )
        break
      }

      if (spentSinceProgress >= budgetWithoutProgress) {
        console.log(
          `\n  STOP — $${spentSinceProgress.toFixed(2)} spent without a single objective being proven.\n  This is no longer a question of means: the approach is not converging.\n`,
        )
        if (willPost) {
          await postToJudgeWrapped(page)
            .evaluate(
              jsPost(
                `$${spentSinceProgress.toFixed(2)} spent without any objective being proven. The loop stops: this is not a lack of budget, it is that the approach is not converging. The method, the proof criterion, or the breakdown has to change.`,
              ),
            )
            .catch(() => {})
        }
        break
      }

      const remaining = budget ? budget - spent : Infinity
      if (budget && remaining < 15) {
        console.log(`\n  STOP — $${remaining.toFixed(2)} left, not enough for a turn. Spent $${spent.toFixed(2)}.\n`)
        if (willPost) {
          await postToJudgeWrapped(page)
            .evaluate(
              jsPost(
                `Budget nearly exhausted: $${spent.toFixed(2)} spent of $${budget}. There is not enough left to run a full turn, so the loop stops here rather than cutting a session off mid-work.`,
              ),
            )
            .catch(() => {})
        }
        break
      }

      // The Unity editor is a dependency we cannot satisfy ourselves — and its
      // absence is expensive: two passes discovered it AFTER the fact, for $79 and
      // zero files. One second of checking beats a session report that concludes
      // "please open Unity".
      if (config.unity?.instance && !editeurUnityVivant()) {
        console.log(`\n  STOP — no Unity editor alive, and the mission requires one.`)
        console.log(`  Open the project in Unity, then run again: nothing was spent.\n`)
        await call('POST', `/objectives/${chapterId}/halts`, {
          reason: 'human_request',
          detail:
            `The mission requires the Unity instance “${config.unity.instance}” and no editor is running. ` +
            'Nobody but you can open it.',
        }).catch(() => {})
        break
      }

      // A conversation that has grown past its cap is not a failure of the work —
      // it is a container that is full. Only a person can open a fresh thread and
      // hand over its address, so the loop stops and says exactly that.
      const size = await conversationSize(page)
      const cap = Number(project?.judge_message_cap ?? 40)
      if (size && cap > 0 && size.asked >= cap) {
        console.log(
          `\n  CONVERSATION FULL — ${size.asked} exchanges, cap is ${cap}.` +
            `\n  Open a new conversation with the judge and set its address on the project.\n`,
        )
        await call('POST', `/objectives/${chapterId}/halts`, {
          reason: 'judge_conversation_full',
          detail:
            `The driving conversation carries ${size.asked} exchanges (cap ${cap}). Every turn ` +
            `re-reads the whole thread, so it now costs more, answers slower, and starts losing ` +
            `the rules it was given at the top. Open a fresh conversation, paste the state into ` +
            `it, and set its address on the project.`,
        }).catch(() => {})
        break
      }

      console.log(`  turn ${turn} — ${directive.harness}${budget ? ` · $${remaining.toFixed(2)} left` : ''}`)

      // A run launched from the interface reports where it is, and obeys a stop
      // asked for from there. Between two turns, never inside one: killing a
      // session mid-flight throws away work already paid for.
      if (runId) {
        const state = await call(
          'PATCH',
          `/runs/${runId}`,
          { turn, note: `turn ${turn} — ${directive.harness} on #${directive.task.match(/#(\d+)/)?.[1] ?? '?'}` },
          { soft: true },
        ).catch(() => null)

        if (state?.cancel_asked) {
          console.log('\n  STOP asked from the interface — the loop ends here.\n')
          await call('PATCH', `/runs/${runId}`, { status: 'cancelled' }, { soft: true }).catch(() => {})
          break
        }

        if (state?.hold_between_turns) {
          console.log('  holding — waiting for "carry on" from the interface')
          for (;;) {
            await pause(5000)
            const now = await call('GET', `/runs`, null, { soft: true }).catch(() => null)
            const mine = (now ?? []).find((r) => r.id === runId)
            if (!mine || mine.cancel_asked || !mine.hold_between_turns) break
          }
          const after = ((await call('GET', '/runs', null, { soft: true }).catch(() => null)) ?? []).find(
            (r) => r.id === runId,
          )
          if (after?.cancel_asked) {
            await call('PATCH', `/runs/${runId}`, { status: 'cancelled' }, { soft: true }).catch(() => {})
            break
          }
        }
      }

      // 3. Execute — never without --post, same default as the relay: a mode
      //    announced as "read only" must start no real session.
      if (!willPost) {
        console.log(`\n  read only — nothing was executed.`)
        console.log(`  ${directive.harness} would receive ${directive.task.length} characters of mission on #${(directive.task.match(/#(\d+)/) ?? [])[1] ?? '?'}.`)
        console.log(`  Run again with --post to execute.\n`)
        break
      }

      instructionsDone.add(`${directive.harness}:${directive.task.slice(0, 200)}`)
      const outcome = await runHarness(directive.harness, directive.task)
      const passage = outcome.passageId
        ? await call('GET', `/passages/${outcome.passageId}`).catch(() => null)
        : null
      const coutTour = Number(passage?.cost_usd ?? 0)
      spent += coutTour
      spentSinceProgress += coutTour
      tokensWithoutProgress += Number(passage?.tokens ?? 0)

      console.log(
        `    → ${outcome.verdict}${outcome.denied?.length ? ` · ${outcome.denied.length} tool(s) refused` : ''} · total $${spent.toFixed(2)}`,
      )

      // Saturation, said out loud. A session's context reaches the window after
      // roughly 150 requests; past that every call re-reads a full window, so the
      // last hundred requests cost as much as the first three hundred. Measured:
      // 393 requests → 89 M tokens, 97 % of it cache re-reads. We do not stop the
      // loop for it — the work may well be worth it — but nobody should discover
      // this in a bill.
      const requests = Number(passage?.requests ?? 0)
      if (requests > 150) {
        const perRequest = Math.round(Number(passage?.tokens ?? 0) / requests / 1000)
        console.log(
          `    ! ${requests} requests, ~${perRequest} k of context re-read each — this session saturated its window.` +
            `\n      The mission asks for too many round trips; batched calls would cost a fraction.`,
        )
      }

      // Absorbing a stall is useful once or twice — GPT changes angle. Past that,
      // insisting costs without adding anything: that is the moment to change
      // approach, not to start over.
      // Usage ceiling reached: that is not a task failure, it is a wait. We sleep
      // until the reset rather than burning turns.
      // A usage ceiling is not a task failure, it is a wait — and it is OUR
      // plumbing, not the judge's business. Nothing is said to the conversation:
      // it cannot act on it, and telling it invites exactly what we would then
      // have to forbid — a verdict on a turn that never ran, a change of approach,
      // a round trip that teaches nobody anything.
      if (outcome.limitReset) {
        const announced = Math.max(0, outcome.limitReset - Date.now())

        // We never sleep on the announced hour. A ceiling lifts for reasons that
        // hour cannot know — a different account, an upgraded plan, an early
        // reset. The loop once slept three hours through a ceiling that had gone
        // in five minutes, and nothing could wake it. So: probe cheaply, cap the
        // wait, and retry regardless. A retry against a ceiling still standing
        // costs nothing — the harness refuses before doing any work.
        const CAP = 30 * 60 * 1000
        const waitMs = Math.min(announced, CAP)
        console.log(
          `\n  USAGE CEILING — announced in ${Math.ceil(announced / 60000)} min. ` +
            `Probing every 2 min, retrying in ${Math.ceil(waitMs / 60000)} min at the latest.\n`,
        )

        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          await pause(Math.min(120000, deadline - Date.now()))
          if (await harnessAvailable(directive.harness)) {
            console.log('  ceiling lifted — resuming\n')
            break
          }
        }

        lastSeen = null
        turn -= 1
        continue
      }

      // A turn that wrote files is not sterile, even if git does not track them
      // yet. Looking only at `changed` made the 63 new files Codex produced
      // invisible, and the loop stopped on "no file is moving" at the very moment
      // the work was coming out.
      const aBouge = Boolean(outcome.changed?.length || outcome.produits?.length)
      sterile = aBouge ? 0 : sterile + 1

      if (sterile >= sterileTurns) {
        console.log(`\n  STOP — ${sterileTurns} turns without a single file moving. This is no longer a problem to absorb.\n`)
        if (willPost) {
          await postToJudgeWrapped(page)
            .evaluate(
              jsPost(
                'Three consecutive turns without a single file moving. The loop stops: this is no longer a one-off obstacle, it is the approach failing to take. A human decision is needed — change method, revisit the proof criterion, or give this objective up.',
              ),
            )
            .catch(() => {})
        }
        break
      }

      // 4. Report back, whatever happened.
      // Attach the renderings BEFORE the text: the conversation has to see before
      // it judges, otherwise it rules on the executor's word.
      let joints = 0
      if (willPost && outcome.produits?.length) {
        const load = (c, type) => {
          try {
            const abs = resolve(process.cwd(), c)
            if (statSync(abs).size > 2 * 1024 * 1024) return null
            return { name: basename(c), type, b64: readFileSync(abs).toString('base64') }
          } catch {
            return null
          }
        }

        const images = outcome.produits
          .filter((c) => /\.(png|jpe?g|webp)$/i.test(c))
          .slice(0, 4)
          .map((c) => load(c, /\.png$/i.test(c) ? 'image/png' : 'image/jpeg'))
          .filter(Boolean)

        // TEXT deliverables too: a chapter whose proof is a Markdown register or a
        // JSON manifest cannot be judged on the session's account. The judge has to
        // read the files, not their names.
        const textes = outcome.produits
          .filter((c) => /\.(md|json|csv|txt|svg)$/i.test(c))
          .slice(0, 6)
          .map((c) =>
            load(
              c,
              /\.json$/i.test(c) ? 'application/json' : /\.svg$/i.test(c) ? 'image/svg+xml' : 'text/markdown',
            ),
          )
          .filter(Boolean)

        const aJoindre = [...images, ...textes]
        if (aJoindre.length) {
          joints = await attachFiles(page, aJoindre).catch(() => 0)
          if (joints) {
            console.log(
              `    ${joints} attachment(s)` +
                (images.length ? ` · ${images.length} rendu(s)` : '') +
                (textes.length ? ` · ${textes.length} document(s)` : ''),
            )
          }
        }
      }

      const report = buildReport(turn, directive, { ...outcome, joints })
      if (willPost) {
        await postToJudgeWrapped(page).evaluate(jsPost(report)).catch(() => {})
        const landed = await confirmPosted(page, report)
        console.log(landed ? '    ↑ posted' : '    !  posting not confirmed')
        if (!landed) break
      } else {
        console.log(`\n${indent(report)}\n`)
      }

      // 5. What actually stops it.
      if (budget && spent >= budget) {
        console.log(`\n  STOP — budget of $${budget} reached (spent $${spent.toFixed(2)}).\n`)
        if (willPost) {
          await postToJudgeWrapped(page).evaluate(
            jsPost(`Budget of $${budget} reached after ${turn} turns. The loop stops here; the chapter is not closed.`),
          )
        }
        break
      }

      // A refusal whose cause is "this objective is waiting on a decision" is not
      // absorbable: a decision is precisely what is missing.
      const needsHuman =
        stopReasons.includes(outcome.haltReason) ||
        /human decision|proof criterion|does not exist/.test(outcome.stopReason ?? '')

      if (outcome.stop && needsHuman) {
        console.log(`\n  ARRÊT — ${outcome.stopReason}\n`)
        if (willPost) {
          await postToJudgeWrapped(page)
            .evaluate(
              jsPost(
                `The loop stops: ${outcome.stopReason}. A human decision is needed before going on — either clear the halt, or state the proof criterion, or aim at another objective.`,
              ),
            )
            .catch(() => {})
        }
        break
      }

      if (outcome.stop) {
        // A broken rule or a stall: the loop reports it to GPT and carries on — it
        // is a problem it knows how to handle.
        console.log(`    (problem absorbed: ${outcome.stopReason})`)
        await resolveHalts(outcome.objectiveId)
      }

      await pause(4000)
    }

    page.close()
  },

  async halt(objectiveId, reason, ...detail) {
    if (!objectiveId || !reason) fail('usage: orchestrator halt <objectiveId> <reason> [detail]')
    await call('POST', `/objectives/${objectiveId}/halts`, { reason, detail: detail.join(' ') || null })
    console.log(`halt recorded — ${reason}`)
  },

  async next() {
    const objectives = await call('GET', `/projects/${config.project}/objectives`)
    const ready = objectives
      .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
      .sort((a, b) => a.priority - b.priority)

    if (!ready.length) return console.log('no objective available — everything is proven, blocked, or has no proof defined')

    const o = ready[0]
    console.log(`#${o.id}  [${o.blast_radius}]  ${o.title}`)
    console.log(`preuve attendue : ${o.proof_spec}`)
  },
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/** decimal(20,4) arrives with its trailing zeros. */
const trimNumber = (v) => (v === null || v === undefined ? '—' : String(Number(v)))
const signOf = (c) => ({ lte: '≤', lt: '<', gte: '≥', gt: '>', eq: '=' })[c] ?? c

/** Technical vocabulary stays in the database; what comes out reads plainly. */
const BLAST_FR = {
  cosmetic: 'sans risque',
  feature: 'limited risk',
  api: 'touches a shared resource',
  critical: 'critique',
}
/**
 * Pulls the first JSON object out of a reply. Models happily wrap their JSON in
 * prose or code fences: refusing over that would waste the call, when we know
 * exactly where to cut.
 */
function extraireJson(texte) {
  const t = String(texte ?? '').replace(/```(?:json)?/gi, '')
  const debut = t.indexOf('{')
  if (debut < 0) return null

  let profondeur = 0
  let chaine = false
  let echap = false

  for (let i = debut; i < t.length; i++) {
    const c = t[i]
    if (echap) { echap = false; continue }
    if (c === '\\') { echap = true; continue }
    if (c === '"') { chaine = !chaine; continue }
    if (chaine) continue
    if (c === '{') profondeur++
    else if (c === '}' && --profondeur === 0) {
      try {
        return JSON.parse(t.slice(debut, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

const HALT_FR = {
  no_provable_criterion: 'nobody knows how to verify it',
  blast_radius: 'too risky to decide alone',
  piege_rule: 'a project rule is broken',
  invariant_regression: 'a production measurement degraded',
  no_new_proof: 'several attempts, nothing demonstrated',
  budget: 'budget atteint',
  human_request: 'stop requested',
  verdict_rejected: 'rejected at verdict, to be redone',
  children_open: 'sub-objectives are still open',
  error: 'erreur technique',
}
const indent = (text) => text.split('\n').map((l) => `    │ ${l}`).join('\n')

function parseFlags(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

/**
 * The halt reasons that REALLY need a human. The others, the loop reports to the
 * driving conversation and carries on: that is the difference between "I am stuck"
 * and "I cannot decide".
 */
const HUMAN_HALTS = ['blast_radius', 'no_provable_criterion', 'invariant_regression', 'budget', 'human_request']

/** Clears the halts the loop knows how to handle, so it does not block itself. */
async function resolveHalts(objectiveId) {
  if (!objectiveId) return
  const o = await call('GET', `/objectives/${objectiveId}`, null, { soft: true }).catch(() => null)
  for (const h of o?.halts ?? []) {
    if (h.resolved_at || HUMAN_HALTS.includes(h.reason)) continue
    await call('PATCH', `/halts/${h.id}/resolve`, null, { soft: true }).catch(() => {})
  }
}

/**
 * A harness binary is NEVER a hard-coded path: it depends on the machine. In
 * order — the environment variable, then `binaries` in .orchestrator.json, and
 * failing that the PATH decides.
 *
 *   ORCHESTRATOR_CODEX_BIN=/path/to/codex
 *   "binaries": { "codex": "/path/to/codex" }
 */
function harnessBin(harness) {
  return process.env[`ORCHESTRATOR_${harness.toUpperCase()}_BIN`] ?? config.binaries?.[harness] ?? harness
}

const CODEX_SESSIONS = resolve(homedir(), '.codex/sessions')

function latestClaudeTranscript(sinceMs) {
  const dir = config.transcripts ?? defaultTranscriptDir()
  if (!existsSync(dir)) return null
  return (
    readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => resolve(dir, f))
      .filter((f) => statSync(f).mtimeMs >= sinceMs)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
  )
}

/** Codex files its rollouts by year/month/day — you have to walk down. */
function latestCodexRollout(sinceMs) {
  if (!existsSync(CODEX_SESSIONS)) return null
  const found = []

  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = resolve(dir, e.name)
      if (e.isDirectory() && depth < 4) walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          if (statSync(full).mtimeMs >= sinceMs) found.push(full)
        } catch {
          /* disparu */
        }
      }
    }
  }

  walk(CODEX_SESSIONS, 0)

  // The right rollout is the one whose cwd is this project, not the most recent by
  // date: other Codex sessions run elsewhere in parallel.
  const here = process.cwd()
  for (const f of found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)) {
    for (const line of readFileSync(f, 'utf8').split('\n').slice(0, 5)) {
      try {
        const cwd = JSON.parse(line)?.payload?.cwd
        if (cwd && (cwd === here || here.startsWith(cwd + '/'))) return f
      } catch {
        /* ligne partielle */
      }
    }
  }

  return null
}

/**
 * Codex pricing in $/million: [input, output, cache read].
 * Set them in .orchestrator.json → codexPricing. With no known rate we count the
 * tokens and invent no cost — a wrong figure inside a budget guardrail is worse
 * than no figure at all.
 */
function codexPricing(model) {
  const table = config.codexPricing ?? {}
  const key = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((k) => (model ?? '').startsWith(k))
  return key ? table[key] : null
}

function codexDiagnostics(file) {
  const denied = new Set()
  const tools = {}
  let lastMessage = null
  let usage = null
  let model = null

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const p = d.payload
    if (p?.type === 'agent_message' && p.message) lastMessage = p.message
    if (p?.type === 'mcp_tool_call_end' && p.result?.is_error) {
      denied.add(String(p.invocation?.tool ?? p.tool ?? 'MCP tool'))
    }

    // Every Codex pass reported zero tokens and zero cost, which made it look
    // free next to Claude. It was never free — it was never measured. `usage` and
    // `model` were declared here, assigned nowhere, returned nowhere, while the
    // rollout carried a `token_count` event on every turn all along.
    if (p?.type === 'token_count' && p.info?.total_token_usage) usage = p.info.total_token_usage
    if (p?.type === 'turn_context' && p.model) model = p.model
    if (p?.type === 'session_meta' && p.payload?.model) model = p.payload.model

    // Codex names its tools differently: `custom_tool_call` for its own, plus the
    // MCP calls. Counting both is what lets anyone see where a pass spent itself.
    const toolName =
      p?.type === 'custom_tool_call' || p?.type === 'function_call'
        ? p.name
        : p?.type === 'mcp_tool_call_begin'
          ? (p.invocation?.tool ?? p.tool)
          : null
    if (toolName) tools[String(toolName)] = (tools[String(toolName)] ?? 0) + 1
  }

  // The caller wants a token count and, when a rate is known, a cost. With no
  // rate we still publish the tokens: an unmeasured harness looks free, and
  // "free" is the one thing it certainly is not.
  const rate = codexPricing(model)
  const tokens = usage?.total_tokens ?? 0
  const cost = rate
    ? ((usage?.input_tokens ?? 0) * (rate[0] ?? 0) +
        (usage?.output_tokens ?? 0) * (rate[1] ?? 0) +
        (usage?.cached_input_tokens ?? 0) * (rate[2] ?? 0)) /
      1e6
    : 0

  return {
    denied: [...denied],
    lastMessage,
    tools,
    model,
    tokens,
    cost,
    pricingKnown: Boolean(rate),
    limitReset: parseLimitReset(lastMessage),
  }
}

/**
 * A session can fail without breaking anything: refused on its tools, it consumes
 * and writes nothing. The report has to say why, otherwise it announces "no file
 * modified" and makes someone rule on a false premise.
 */
/** "resets 2:10pm" → the reset time, in epoch milliseconds. */
export function parseLimitReset(text) {
  // Both spellings: the harness message is English, but a French locale writes
  // « réinitialise ». Losing either one loses the reset time entirely.
  const m = /(?:resets|réinitialis\w*)\s+(\d{1,2})[:h](\d{2})\s*(am|pm)?/i.exec(text ?? '')
  if (!m) {
    // Ceiling announced with no reset time: we do not know when it comes back, but
    // we do know the task is not what failed. One hour of waiting beats counting it
    // as a sterile attempt.
    return /(?:session|usage|rate)\s+limit|limite d'usage|plafond atteint/i.test(text ?? '')
      ? Date.now() + 3600 * 1000
      : null
  }

  let h = Number(m[1])
  const min = Number(m[2])
  const suffix = (m[3] ?? '').toLowerCase()
  if (suffix === 'pm' && h < 12) h += 12
  if (suffix === 'am' && h === 12) h = 0

  const at = new Date()
  at.setHours(h, min, 0, 0)
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
  return at.getTime()
}

function sessionDiagnostics(sinceMs, harness = 'claude') {
  const file =
    harness === 'codex' ? latestCodexRollout(sinceMs) : latestClaudeTranscript(sinceMs)

  if (!file) return { denied: [], lastMessage: null, tools: {}, sessionId: null }

  // The transcript's name IS the session id. We derive it, we ask nobody for it:
  // an agent cannot forget to declare what we read ourselves.
  const sessionId = basename(file).replace(/\.jsonl$/, '')

  if (harness === 'codex') return { ...codexDiagnostics(file), sessionId }

  const denied = new Set()
  const tools = {}
  let lastMessage = null

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }

    for (const c of d.message?.content ?? []) {
      if (c?.type === 'tool_use' && c.name) tools[c.name] = (tools[c.name] ?? 0) + 1
      if (c?.type === 'tool_result' && c.is_error) {
        const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
        const m = txt.match(/permissions to use ([A-Za-z0-9_()*.\- ]+?)(?:,|$|")/)
        if (m) denied.add(m[1].trim())
        else if (/require approval|was blocked|not granted/i.test(txt)) {
          denied.add(txt.slice(0, 90).replace(/\s+/g, ' '))
        }
      }
      if (c?.type === 'text' && d.message?.role === 'assistant') lastMessage = c.text
    }
  }

  // `tools` was built and then dropped on the floor: the field existed, the
  // column existed, and every row was NULL. Which is why nobody could say where
  // four hundred tool calls went, on the passes that cost the most.
  return { denied: [...denied], lastMessage, sessionId, tools, limitReset: parseLimitReset(lastMessage) }
}

/**
 * Starts a harness on a task, framed by an attempt, and lets the guards decide.
 * The harness has nothing to declare: everything is derived.
 */
async function runHarness(harness, task) {
  const objectives = await call('GET', `/projects/${config.project}/objectives`)

  // The instruction names an objective by number: we honour it. With no number we
  // fall back on priority — but we never guess in place of an explicit choice.
  const named = task.match(/#(\d+)/)
  let target

  if (named) {
    const id = Number(named[1])
    const o = objectives.find((x) => x.id === id)

    if (!o) {
      return {
        verdict: 'refused',
        halts: [],
        stop: true,
        stopReason: `the instruction names objective #${id}, which does not exist in this project`,
        output: '',
      }
    }
    // Refuse only on a halt that REQUIRES a human. The other reasons are
    // absorbable: the loop clears them and carries on. Otherwise a plain stall
    // freezes the objective as surely as a missing decision.
    const full = await call('GET', `/objectives/${id}`, null, { soft: true })
    const openHalts = (full?.halts ?? []).filter((h) => !h.resolved_at)
    const blocking = openHalts.filter((h) => HUMAN_HALTS.includes(h.reason))

    if (blocking.length) {
      return {
        verdict: 'refused',
        halts: [],
        stop: true,
        haltReason: blocking[0].reason,
        stopReason: `objective #${id} is waiting on a human decision — ${blocking[0].reason}: ${(blocking[0].detail ?? '').slice(0, 160)}`,
        output: '',
      }
    }

    if (openHalts.length) {
      console.log(`  (${openHalts.length} absorbable halt(s) cleared on #${id})`)
      await resolveHalts(id)
    }
    if (!o.proof_spec) {
      return {
        verdict: 'refused',
        halts: [],
        stop: true,
        stopReason: `objective #${id} has no proof criterion: nobody could say when it is finished`,
        output: '',
      }
    }
    target = o
  } else {
    target = objectives
      .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
      .sort((a, b) => a.priority - b.priority)[0]
  }

  if (!target) {
    return {
      verdict: 'refused',
      halts: [],
      stop: true,
      stopReason: 'no takeable objective (everything is proven, halted, or has no proof criterion)',
      output: '',
    }
  }

  console.log(`  objective targeted: #${target.id} ${target.title}`)

  // Continuity: resuming a session keeps the cache warm and saves a great deal —
  // but it carries state nobody can see. So we only take it if the objective asks
  // for it, and we say so.
  const mode = target.resume_mode ?? 'new'
  const reprise =
    mode === 'named' ? target.resume_session : mode === 'last' ? target.last_session : null

  if (mode !== 'new' && !reprise) {
    console.log(`  continuity requested (${mode}) but no session to resume — fresh session`)
  } else if (reprise) {
    console.log(`  resuming session ${String(reprise).slice(0, 8)} — the mission is not the whole story`)
  }

  const passage = await call('POST', `/objectives/${target.id}/passages`, {
    harness,
    resumed_from: reprise ?? null,
    git_before: head(),
    // The summary serves as a label; the whole mission is what was actually handed
    // to the harness — that is what has to be rereadable in order to judge whether
    // the order was good or the execution bad.
    summary: task.split('\n').find((l) => l.trim())?.slice(0, 200) ?? task.slice(0, 200),
    mission: task,
  })

  // A non-interactive session cannot ask for anything: we hand it explicitly what
  // the Permissions screen decided. Refusals stay refused — they beat allowances.
  // A read failure must NOT read as "no permissions". The silent fallback that
  // used to be here sent a session off with an empty list: it worked without being
  // able to do anything, it billed, and the report blamed the permissions when it
  // was the API that had not answered — a plain server restart was enough to cause
  // it.
  let perms
  try {
    perms = await call('GET', `/projects/${config.project}/permissions/effective/${harness}`)
  } catch (e) {
    throw new Error(
      `Permissions unreadable (${String(e.message).slice(0, 100)}) — pass cancelled. ` +
        'Starting a session without its list means paying for a refusal on every tool.',
    )
  }

  if (!perms.allow?.length) {
    throw new Error(
      `No tool allowed for “${harness}” on this project — pass cancelled. ` +
        'In a non-interactive session a tool off the list is refused without asking: nothing could succeed.',
    )
  }

  const before = head()
  const startedAt = Date.now()

  // The working tree may already be dirty: photograph its state first, otherwise
  // we charge the session for what somebody else left lying around.
  const dirtyBefore = new Set(
    (git('status', '--porcelain') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim()),
  )

  let output = ''
  let crashed = false
  let timedOut = false

  try {
    const [bin, args] =
      // `workspace-write` and no more: Codex writes into the repository, never
      // outside it. The blast radius then rules on the diff.
      harness === 'codex'
        ? [
            harnessBin('codex'),
            // In non-interactive mode, EVERY MCP tool call is refused for want of
            // approval — verified: approval_policy=never, trust_level trusted and a
            // trusted project all three fail. The only flag that unblocks it also
            // removes the sandbox. Decision taken knowingly: without it, Codex
            // cannot touch Unity without a human at the screen, so no autopilot.
            reprise
              ? ['exec', 'resume', String(reprise), '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', task]
              : ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', task],
          ]
        : [
            harnessBin('claude'),
            // The instruction FIRST: --allowed-tools and --disallowed-tools are
            // variadic and would swallow any text placed after them.
            [
              '-p',
              task,
              // La reprise vient AVANT les listes d'outils, qui sont variadiques.
              ...(reprise ? ['--resume', String(reprise)] : []),
              // One `--add-dir` per directory: this is what was missing when a
              // refusal said "may only list files in the working directory" while
              // the tool was allowed. Allowing a tool and allowing a path are two
              // different things.
              ...config.readDirs.flatMap((d) => ['--add-dir', d]),
              ...(perms.allow?.length ? ['--allowed-tools', ...perms.allow] : []),
              ...(perms.deny?.length ? ['--disallowed-tools', ...perms.deny] : []),
            ],
          ]

    output = execFileSync(bin, args, {
      encoding: 'utf8',
      cwd: process.cwd(),
      // The project's variables settle the ambiguities nobody is there to settle —
      // the Unity instance, for instance.
      // Third-party service secrets live on THIS machine and only enter the process
      // for the duration of the session. The server never had them: it only knows
      // the NAME of the expected variable.
      env: { ...process.env, ...(config.secrets ?? {}), ...config.env, ORCHESTRATOR_MANAGED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      // No default timeout: a session ends when it has ended. An arbitrary timeout
      // kills work in progress and bills all of it for nothing. The real guardrail
      // is the budget, which bounds the spend — not the duration.
      ...(config.sessionTimeoutMin ? { timeout: config.sessionTimeoutMin * 60 * 1000 } : {}),
    })
  } catch (e) {
    crashed = true
    // ETIMEDOUT / SIGTERM: WE cut it off, not the session.
    timedOut = e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT'
    output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || String(e.message)
  }

  const after = head()

  // Guards: blast radius then rule pack, on the real diff.
  const committed = before && after && before !== after ? changedPaths(before, after) : []

  const dirtyNow = (git('status', '--porcelain') ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim())

  // Seuls les fichiers salis PENDANT la session comptent.
  const newlyDirty = dirtyNow.filter((f) => !dirtyBefore.has(f))
  const changed = [...new Set([...committed, ...newlyDirty])]

  const blast = changed.filter((p) => config.blastRadius.some((g) => matchesGlob(p, g)))

  const findings = []
  for (const rel of changed) {
    const full = resolve(process.cwd(), rel)
    if (!existsSync(full)) continue
    try {
      findings.push(...checkFile(rel, readFileSync(full, 'utf8')))
    } catch {
      /* binaire */
    }
  }

  const diag = sessionDiagnostics(startedAt, harness)

  // A session stripped of its tools did not fail: it was prevented.
  const remontables = diag.denied.filter((d) => /^[A-Za-z0-9_()*.\- ]+$/.test(d))

  if (remontables.length) {
    await call(
      'POST',
      `/projects/${config.project}/permissions/requested`,
      { patterns: remontables, harness },
      { soft: true },
    ).catch(() => {})
  }

  const halts = findings.filter((f) => f.severity === 'halt')
  let stop = false
  let stopReason = null

  let haltReason = null

  if (blast.length) {
    stop = true
    haltReason = 'blast_radius'
    stopReason = `blast radius touched: ${blast.join(', ')}`
    await call('POST', `/objectives/${target.id}/halts`, {
      reason: 'blast_radius',
      passage_id: passage.id,
      detail: stopReason,
    }, { soft: true }).catch(() => {})
  } else if (halts.length) {
    stop = true
    haltReason = 'piege_rule'
    stopReason = `${halts.length} project rule(s) broken`
    await call('POST', `/objectives/${target.id}/halts`, {
      reason: 'piege_rule',
      passage_id: passage.id,
      detail: halts.map((f) => `${f.path}:${f.line} [${f.rule}] ${f.why}`).join('\n'),
    }, { soft: true }).catch(() => {})
  }

  // A session cut off by the timeout did not fail: it was interrupted. If it
  // produced something, we keep the work.
  const resultats = extraireResultats(diag.lastMessage)

  // A deliverable is DERIVED, it is not declared. Citing a path proves nothing: a
  // session that writes "GAME_VISION.md was not modified" cites the file without
  // having produced it. Only the last write time says so, and that cannot be
  // narrated. So we sweep the deliverable folders looking for what actually moved
  // DURING the session, and of the cited paths we keep only those that pass the
  // same test.
  const dansLaFenetre = (chemin) => {
    try {
      const t = statSync(chemin).mtimeMs
      return t >= startedAt - 5000 && t <= Date.now() + 5000
    } catch {
      return false
    }
  }

  // A deliverable can land anywhere: limiting the sweep to Review/ and Docs/ made
  // us miss six screenshots written into ArtSource/. So we sweep the whole
  // repository, setting aside what no session deliberately produces — tool caches,
  // dependencies, and the loop's own log.
  const IGNORES = new Set(
    config.deliverableIgnore ?? [
      '.git', 'node_modules', 'Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds',
      'UserSettings', 'vendor', 'dist', '.venv', '__pycache__',
    ],
  )
  const journalBoucle = basename(process.env.ORCHESTRATOR_LOG ?? 'orchestrator-chapter-11.log')

  const balayer = (dossier, sortie = []) => {
    let entrees
    try {
      entrees = readdirSync(dossier, { withFileTypes: true })
    } catch {
      return sortie
    }
    for (const e of entrees) {
      const complet = join(dossier, e.name)
      if (e.isDirectory()) {
        if (!IGNORES.has(e.name) && !e.name.startsWith('.')) balayer(complet, sortie)
      } else if (
        !e.name.startsWith('.') &&
        e.name !== journalBoucle &&
        !/^orchestrator-.*\.log$/.test(e.name) &&
        dansLaFenetre(complet)
      ) {
        sortie.push(relative(process.cwd(), complet))
      }
    }
    return sortie
  }

  const racines = config.deliverableDirs ?? ['.']
  const surDisque = racines.flatMap((r) => balayer(resolve(process.cwd(), r)))
  const cites = resultats.chemins.filter((c) => dansLaFenetre(resolve(process.cwd(), c)))

  // Les images d'abord : ce sont elles qui permettent de juger.
  const dateDe = (c) => {
    try {
      return statSync(resolve(process.cwd(), c)).mtimeMs
    } catch {
      return 0
    }
  }
  const produits = [...new Set([...surDisque, ...cites])].sort((a, b) => {
    const img = (x) => (/\.(png|jpe?g|webp)$/i.test(x) ? 0 : 1)
    return img(a) - img(b) || dateDe(b) - dateDe(a)
  })
  const aProduit = changed.length > 0 || produits.length > 0

  const verdict = stop
    ? 'halted'
    : timedOut
      ? aProduit
        ? 'advanced'
        : 'no_progress'
      : crashed
        ? 'failed'
        : aProduit
          ? 'advanced'
          : 'no_progress'

  // Tokens are read from the harness traces, they are not declared.
  if (harness === 'codex') {
    if (diag.tokens) {
      await call(
        'POST',
        `/passages/${passage.id}/usage`,
        { tokens: diag.tokens, cost_usd: diag.cost > 0 ? Number(diag.cost.toFixed(3)) : undefined },
        { soft: true },
      ).catch(() => {})

      console.log(
        `  ${diag.model ?? 'codex'} — ${diag.tokens.toLocaleString('fr-FR')} tokens` +
          (diag.pricingKnown
            ? ` · $${diag.cost.toFixed(3)}`
            : ' · cost unknown (no rate in .orchestrator.json → codexPricing)'),
      )
    }
  } else {
    await commands['usage:scan'](passage.id).catch(() => {})
  }

  // Prevented: it did not try. Does not count as a stall.
  const prevented =
    (diag.denied.length > 0 || Boolean(diag.limitReset)) && changed.length === 0

  await call('PATCH', `/passages/${passage.id}`, {
    verdict,
    git_after: after,
    prevented,
    prevented_by: prevented
      ? diag.limitReset
        ? "Plafond d'usage du harnais atteint"
        : diag.denied.slice(0, 10).join(', ')
      : timedOut
        ? `Cut off by the ${config.sessionTimeoutMin} min timeout, it was still working`
        : null,
    said: diag.lastMessage ? diag.lastMessage.slice(-6000) : null,
    tools_used: diag.tools ?? null,
    session_id: diag.sessionId ?? null,
  }, { soft: true }).catch(() => {})

  // Record what the session actually produced, as proof.
  for (const produced of produits.slice(0, 8)) {
    const type = /\.(png|jpg)$/i.test(produced) ? 'render' : 'diff'
    await call(
      'POST',
      `/passages/${passage.id}/evidences`,
      {
        type,
        label: `Deliverable produced — ${basename(produced)}`,
        ref: produced,
        verdict: resultats.atteint ? 'pass' : 'inconclusive',
      },
      { soft: true },
    ).catch(() => {})
  }

  for (const sc of resultats.scores.slice(0, 6)) {
    await call(
      'POST',
      `/passages/${passage.id}/evidences`,
      {
        type: 'manual',
        label: `${sc.quoi} : ${sc.obtenu}/${sc.total}`,
        ref: 'Score announced by the session',
        verdict: resultats.atteint ? 'pass' : 'inconclusive',
      },
      { soft: true },
    ).catch(() => {})
  }

  const frais = await call('GET', `/passages/${passage.id}`, null, { soft: true }).catch(() => null)

  return {
    verdict,
    resultats,
    produits,
    proofSpec: target.proof_spec,
    cout: Number(frais?.cost_usd ?? 0),
    halts,
    blast,
    changed,
    stop,
    stopReason,
    haltReason,
    output,
    denied: diag.denied,
    lastMessage: diag.lastMessage,
    limitReset: diag.limitReset ?? null,
    timedOut,
    passageId: passage.id,
    objectiveId: target.id,
  }
}

/**
 * A session that meets a criterion SAYS so. The git diff does not: screenshots are
 * untracked, the scene may not be saved yet, and Unity reimports unrelated assets.
 * Measuring file movement to judge the work is a bad indicator in both directions
 * — it misses success and reports noise.
 */
function extraireResultats(said) {
  if (!said) return { scores: [], chemins: [], atteint: false }

  // A score is announced, not inferred from a number spotted in a table. It takes
  // the word "score" or some bold emphasis, plus a coherent label.
  const scores = []
  for (const ligne of said.split('\n')) {
    if (/^\s*\|/.test(ligne)) continue // table row: data, not a verdict

    const m = /(?:score|poste|total|plan|critère|criterion|note|mark)[^\n:]{0,50}?[:—-]?\s*\**\s*(\d{1,3})\s*\/\s*(\d{1,3})/i.exec(ligne)
    if (!m) continue

    const obtenu = Number(m[1])
    const total = Number(m[2])
    if (total < 4 || total > 100 || obtenu > total) continue

    const quoi = ligne
      .slice(0, m.index + 60)
      .replace(/[*#|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)

    scores.push({ quoi, obtenu, total })
  }

  const chemins = [...said.matchAll(/`?((?:Review|Docs|Assets)\/[\w./-]+\.(?:png|jpg|md|json|unity))`?/g)]
    .map((m) => m[1])

  const atteint = /objectif atteint|critère (?:est )?(?:rempli|satisfait)|plancher (?:atteint|tenu)|gate (?:atteint|passé)|objective met|criterion (?:is )?(?:met|satisfied)|floor (?:met|held)|gate (?:reached|passed)/i.test(said)

  return { scores, chemins: [...new Set(chemins)], atteint }
}

/**
 * The same surface as `page`, whose `evaluate` reports a failure instead of
 * throwing. Used only for posting: reading a reply must still fail loudly, since
 * acting on a message we could not read would be worse than stopping.
 */
const postToJudgeWrapped = (page) => ({
  evaluate: (expression) =>
    page.evaluate(expression, { timeoutMs: 120000 }).catch((e) => {
      console.log(`    ! the message could not be posted (${String(e.message).slice(0, 70)}) — the loop carries on`)
      return null
    }),
})

/**
 * Is the harness answering again? Asked with the cheapest possible question — a
 * prompt whose reply is one word, no tools, no repository access.
 *
 * The point is that a ceiling does not only lift at the announced hour: a
 * different account, an upgraded plan, an early reset. Waiting on the clock made
 * the loop sleep three hours through a ceiling that had gone in five minutes,
 * with no way for anyone to wake it.
 */
async function harnessAvailable(harness) {
  try {
    const [bin, args] =
      harness === 'codex'
        ? [harnessBin('codex'), ['exec', '--skip-git-repo-check', 'Reply with the single word: ok']]
        : [
            harnessBin('claude'),
            ['-p', 'Reply with the single word: ok', '--disallowed-tools', 'Bash', 'Write', 'Edit', 'Read'],
          ]

    const out = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ORCHESTRATOR_MANAGED: '1' },
    })
    // A ceiling answers with its own message rather than failing outright, so a
    // successful exit is not enough — the text has to be free of it.
    return !parseLimitReset(out)
  } catch {
    return false
  }
}

/**
 * Reads the judge's latest reply, tolerating a browser that stalls.
 *
 * Chrome is shared by every loop running at once. When it hangs — a page
 * re-rendering a nine-thousand-character reply, six attachments landing at once —
 * `Runtime.evaluate` never answers, and an unhandled rejection killed EVERY loop
 * at the same second. Hours of work, twice.
 *
 * A browser that stalls is a transient. We wait, we try again, and we only give
 * up on the turn — never on the run.
 */
async function readJudge(page, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      // `waitForStable`, NOT readJudge. A blanket rename replaced this call too
      // and the helper called itself — infinite recursion, and every loop died on
      // a stack overflow the moment it tried to read a reply.
      return await waitForStable(page)
    } catch (e) {
      console.log(`    ! the browser did not answer (${String(e.message).slice(0, 50)}) — retry ${i + 1}/${attempts}`)
      await pause(15000)
    }
  }
  return null
}

function buildReport(turn, directive, outcome) {
  const lines = [
    `## Turn ${turn} — objective #${outcome.objectiveId ?? '?'}`,
    '',
    // NO cost and NO token count here, deliberately. Neither helps judge whether
    // the criterion is met, and both bias the judgement: a judge shown $50 already
    // spent feels pressure to accept it. Spending is the human's business — it is
    // derived from the traces and shown on the dashboard, never argued to the judge.
    `**Harness** ${directive.harness} · **tool verdict** ${outcome.verdict}`,
    '',
    `**What had to be true** ${outcome.proofSpec ?? '(not specified)'}`,
    '',
  ]

  if (outcome.resultats?.scores?.length) {
    lines.push('**Scores recorded**')
    for (const sc of outcome.resultats.scores.slice(0, 6)) {
      lines.push(`- ${sc.quoi} : ${sc.obtenu}/${sc.total}`)
    }
    lines.push('')
  }

  if (outcome.produits?.length) {
    const total = outcome.produits.length
    lines.push(`**Deliverables produced** — ${total} file${total > 1 ? 's' : ''}`)
    for (const c of outcome.produits.slice(0, 12)) lines.push(`- ${c}`)
    if (total > 12) lines.push(`- … and ${total - 12} more, not listed here`)
    if (outcome.joints) {
      const images = outcome.produits.filter((c) => /\.(png|jpe?g|webp)$/i.test(c)).length
      lines.push(
        '',
        `The ${outcome.joints} most recent attachments are on this message` +
          (images > outcome.joints ? ` (sur ${images} produits)` : '') +
          ` — judge on the image, not on the announced score.`,
      )
    }
    lines.push('')
  }

  if (outcome.changed?.length) {
    lines.push(`Tracked files modified (${outcome.changed.length}): ${outcome.changed.slice(0, 12).join(', ')}${outcome.changed.length > 12 ? '…' : ''}`)
  } else if (!outcome.produits?.length) {
    lines.push(
      'No file modified, no deliverable produced.',
    )
  }

  if (outcome.blast?.length) {
    lines.push('', `STOP — blast radius: ${outcome.blast.join(', ')}. Nothing was accepted, a human decision is required.`)
  }

  if (outcome.halts?.length) {
    lines.push('', 'STOP — project rules broken:')
    for (const f of outcome.halts.slice(0, 6)) lines.push(`- ${f.path}:${f.line} — ${f.why}`)
  }

  if (outcome.timedOut) {
    lines.push(
      '',
      'INTERRUPTED — the session hit the maximum timeout while it was still working. This is not a task failure: the work already produced is kept, but it is incomplete.',
    )
  }

  if (outcome.denied?.length) {
    lines.push(
      '',
      `PREVENTED — ${outcome.denied.length} tool(s) refused to the session. It did not fail, it could not act:`,
    )
    for (const d of outcome.denied.slice(0, 8)) lines.push(`- ${d}`)
    lines.push('These refusals are surfaced in the Permissions screen to be decided.')
  }

  if (outcome.lastMessage) {
    // The session report IS the structured deliverable: the project's doctrine sets
    // its outline. Truncating it means throwing away what we paid for.
    lines.push('', '---', '', '### Rapport de la session', '', outcome.lastMessage.slice(-9000))
  } else {
    const tail = (outcome.output ?? '').trim().split('\n').slice(-25).join('\n')
    if (tail) lines.push('', 'Sortie du harnais (fin) :', '```', tail.slice(0, 3000), '```')
  }

  if (outcome.limitReset) {
    lines.push(
      '',
      '---',
      '',
      '**Nothing to decide on this turn.** The loop is waiting for the harness to reset and will replay the same instruction. You can use the wait to sharpen the mission if you think it can be improved, but do not pronounce a verdict.',
    )
  } else if (!outcome.stop) {
    lines.push(
      '',
      '---',
      '',
      `**Over to you.** Rule on #${outcome.objectiveId ?? '?'} — write "@verdict: #${outcome.objectiveId} accepted" or "@verdict: #${outcome.objectiveId} rejected" — then give the next mission, complete and structured as usual, introduced by \`@claude:\` or \`@codex:\` alone on its line and citing the target objective number. Everything after that marker is passed to the harness word for word, and nothing else reaches it. Without a marker, the loop stops.`,
    )
  }

  return lines.join('\n')
}

// This file is no longer an entry point: the package's single CLI calls these
// commands. That is what lets `orchestrator serve` and `orchestrator chapter` be
// the same command, installed once.
export { commands }
