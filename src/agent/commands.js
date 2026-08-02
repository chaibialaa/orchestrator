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
import { attach, openTab, parseDirective, parseVerdict, parseDone, jsPost, attachFiles, waitForStable, confirmPosted, conversationSize, JS_LAST_ASSISTANT, JS_IS_STREAMING } from './relay.js'

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
    // Which branch a pass works on. Unset = the branch you are on, unchanged.
    branch: project.branch ?? null,
    // What to shut down after every pass, whatever its verdict. Declared here
    // because the server must never hold a command it could run on your machine.
    teardown: project.teardown ?? {},
    transcripts: project.transcripts ?? null,
    env: project.env ?? {},
    sessionTimeoutMin: project.sessionTimeoutMin ?? null,
    // What a pass is allowed to spend of the shared session window. Both null by
    // default: a project that says nothing behaves exactly as before.
    harnessModel: project.harnessModel ?? global.harnessModel ?? null,
    maxTurns: project.maxTurns ?? global.maxTurns ?? null,
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
    // The attachments directory is always readable: a file someone put into the
    // process is useless if the agent cannot open it. It lives outside the
    // repository on purpose — a person's screenshot in a working tree becomes a
    // change to review.
    readDirs: [...(project.readDirs ?? []), join(homedir(), '.orchestrator', 'attachments')],
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

/**
 * Harnesses that are actually given their allow list, and therefore constrained
 * by it. Anything not in here shows rules on screen that nothing enforces.
 */
const ENFORCED_ALLOWLIST = new Set(['claude'])

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

    // Throwing rather than exiting: inside a worker, one bad answer from the API
    // must fail the run in progress, not the process that carries every run after it.
    fail(`HTTP ${res.status}: ${String(JSON.stringify(data)).slice(0, 300)}`)
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

/**
 * Can this repository be committed to at all?
 *
 * Nothing here may assume a git repository, let alone a configured one. These
 * projects have both; somebody else's may have neither, and a loop that fails
 * because `user.email` is unset would be failing at the wrong thing entirely.
 *
 * Returns why it cannot, rather than a bare false — a safety net that quietly
 * does nothing is the worst kind.
 */
function gitReady() {
  if (git('rev-parse', '--git-dir') === null) return { ok: false, why: 'not a git repository' }
  if (!git('config', 'user.email') || !git('config', 'user.name')) {
    return { ok: false, why: 'git has no user.name / user.email here' }
  }
  return { ok: true }
}

/**
 * A commit of everything currently uncommitted, WITHOUT touching the working
 * tree, the index, or any branch.
 *
 * `git stash create` builds the commit object and hands back its hash; nothing
 * moves. Verified on Blockrise: 167 changed entries before, 167 after, and a
 * 127-file commit to fall back on. Kept alive under `refs/orchestrator/` so
 * garbage collection cannot take it.
 *
 * What it does NOT cover, said out loud because it matters: files git does not
 * track. Blockrise has forty of those. A restore point that silently omits them
 * would be worse than none, because it would be trusted.
 */
function restorePoint(label) {
  const ready = gitReady()
  if (!ready.ok) return { made: false, why: ready.why }

  const dirty = git('status', '--porcelain')
  if (!dirty) return { made: false, why: 'nothing uncommitted to save' }

  const sha = git('stash', 'create', `orchestrator: before ${label}`)
  if (!sha || sha.length < 40) return { made: false, why: 'git could not build one' }

  const ref = `refs/orchestrator/${label.replace(/[^\w.-]+/g, '-')}`
  git('update-ref', ref, sha)

  const untracked = dirty.split('\n').filter((l) => l.startsWith('??')).length
  return { made: true, sha: sha.slice(0, 12), ref, untracked }
}

/**
 * Commit the work an accepted verdict has just blessed.
 *
 * An accepted objective is the one moment where the tree is known good — proved
 * and judged — which makes it the only honest place to put a marker. Between
 * two of them the state is provisional, and committing it would be recording a
 * guess.
 *
 * Committed, never pushed: publishing is a decision, and a pre-push hook already
 * refuses to do it unattended.
 *
 * Silent when git is not there or not configured. These projects have both, but
 * somebody else's may have neither, and a loop that fell over because
 * `user.email` was unset would be failing at entirely the wrong thing.
 */
function commitAccepted(objectiveId) {
  const ready = gitReady()
  if (!ready.ok) return

  if (!git('status', '--porcelain')) return // nothing to record

  git('add', '-A')
  const done = git(
    'commit',
    '-m',
    `orchestrator: #${objectiveId} accepted`,
    '-m',
    'Committed at the verdict, the one moment the tree is known good — proved and\njudged. Not pushed: publishing is a decision.',
  )
  if (done !== null) console.log(`    ✓ committed — #${objectiveId} accepted`)
}

/**
 * Which branch this pass works on — YOUR choice, never assumed.
 *
 * Everything went into whichever branch happened to be checked out, and an
 * accepted verdict committed straight into it. On a repository where you work on
 * `pre-prod` that is not a policy, it is an accident waiting to be noticed.
 *
 * Three answers, and the default is the one that changes nothing:
 *   nothing declared        → the branch you are on. Today's behaviour, untouched.
 *   "orchestrator/{id}-{slug}" → one branch per objective, created if absent.
 *   "some-branch"           → that one, whatever the objective.
 *
 * It REFUSES rather than forces. Switching a branch under uncommitted work is
 * how work disappears, and no policy is worth that: a dirty tree keeps the
 * branch it is on, and says so.
 */
function chooseBranch(objectiveId, title) {
  const modele = config.branch
  if (!modele) return { ok: true, branch: git('rev-parse', '--abbrev-ref', 'HEAD'), moved: false }

  const ready = gitReady()
  if (!ready.ok) return { ok: true, branch: null, moved: false, why: ready.why }

  const slug = String(title ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

  const voulue = modele.replace(/\{id\}/g, String(objectiveId ?? '')).replace(/\{slug\}/g, slug)
  const actuelle = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (actuelle === voulue) return { ok: true, branch: voulue, moved: false }

  if (git('status', '--porcelain')) {
    return {
      ok: false,
      branch: actuelle,
      moved: false,
      why:
        `the working tree has uncommitted changes, so switching to “${voulue}” would carry them along ` +
        `or lose them. Commit or stash them, or clear \`branch\` from .orchestrator.json.`,
    }
  }

  const existe = git('rev-parse', '--verify', voulue) !== null
  const fait = existe ? git('checkout', voulue) : git('checkout', '-b', voulue)
  if (fait === null) return { ok: false, branch: actuelle, moved: false, why: `git refused to switch to “${voulue}”` }

  console.log(`    ⑂ ${existe ? 'on' : 'created'} branch ${voulue}`)
  return { ok: true, branch: voulue, moved: true }
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

        // The declared checks were shown to the breakdown agent and to nobody
        // else, so the agent doing the work had no idea a command existed that
        // could return a verdict. It produced files; files are recorded as
        // "deliverable produced", which is `inconclusive` — and a chapter whose
        // criterion needs a passing proof could never conclude. On one chapter
        // that cost $133 across six attempts to keep rediscovering.
        /**
         * Another agent is in this same checkout right now.
         *
         * Two passes on one repository overwrite each other's edits, and each
         * one's `git status` charges it for what the other left lying around.
         * The queue refuses this by default; when it was accepted knowingly, the
         * least we owe the agent is the name of what is already being held.
         */
        const others = (await call('GET', `/runs?project=${config.project}`, null, { soft: true }).catch(
          () => null,
        ))?.filter((r) => r.status === 'running' && r.objective_id && r.objective_id !== objective?.id)
        if (others?.length) {
          lines.push('')
          lines.push('ANOTHER AGENT IS WORKING IN THIS SAME CHECKOUT, right now:')
          for (const r of others) {
            lines.push(`  #${r.objective_id} — ${r.objective_title ?? ''} (turn ${r.turn})`)
          }
          lines.push('Stay off what belongs to it. Touch only what your own objective needs, and')
          lines.push('do not revert, reformat or tidy anything you did not come here to change —')
          lines.push('the diff you leave is attributed to you, and so is the one you undo.')
        }

        /**
         * Files a person put into the process, named with their paths.
         *
         * Storing them was the easy half. An agent that is not told they exist
         * will not go looking in a directory it has never heard of, and a
         * mock-up nobody opens is a mock-up nobody matched.
         */
        const attached = await call(
          'GET',
          `/projects/${config.project}/attachments?kind=project`,
          null,
          { soft: true },
        ).catch(() => null)
        if (attached?.length) {
          lines.push('')
          lines.push('Files provided for this project — read them before you start:')
          for (const a of attached.slice(0, 12)) {
            lines.push(`  ${a.name}${a.note ? ` — ${a.note}` : ''}`)
            lines.push(`    ${a.path}`)
          }
        }

        // Named in the plan by the breakdown, and unknown to the agent doing the
        // work unless it is told here too — a source nobody mentions is a source
        // nobody uses, and the step gets modelled from scratch anyway.
        const known = await call('GET', '/agents', null, { soft: true }).catch(() => null)
        const usable = (known ?? []).filter((a) => a.enabled && a.kind === 'source')
        if (usable.length) {
          lines.push('')
          lines.push('Material available to draw on rather than make:')
          for (const a of usable) {
            lines.push(
              `  ${a.label}${a.capabilities?.length ? ` — ${a.capabilities.join(', ')}` : ''}` +
                (a.last_detail ? ` · ${String(a.last_detail).slice(0, 140)}` : ''),
            )
          }
        }

        /**
         * How to ask a person to check something, and when.
         *
         * This is what a non-interactive session lost. Working by hand, Codex
         * would stop and say "open the game and tell me whether X, Y and Z" —
         * and that was often the only real proof, because a still image says
         * nothing about how a thing plays. Driven by the loop it cannot say it:
         * there is nobody listening at that moment, and it was never told there
         * is a way to leave the question behind.
         */
        lines.push('')
        lines.push('If the only honest proof is a person looking at the running thing — how it')
        lines.push('plays, whether a route works, whether something feels right — do NOT guess')
        lines.push('and do not settle for a screenshot. Stop and ask:')
        lines.push(`  orchestrator halt ${objective.id} human_request "open the game and confirm: …"`)
        lines.push('Name exactly what to look at and what would count as wrong. The pass ends')
        lines.push('cleanly, the question appears on screen, and nothing is billed for guessing.')

        const declared = Object.keys(config.proofs ?? {})
        if (declared.length) {
          lines.push('')
          lines.push('Checks this project declares. Running one attaches its verdict — pass or fail —')
          lines.push('to the attempt. A file on its own is only ever recorded as inconclusive.')
          for (const key of declared) {
            lines.push(`  orchestrator prove ${passageId} ${key}`)
          }
        }
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

      /**
       * A reading becomes a PROOF, not just a row that changed colour.
       *
       * `invariant` sits in the list of proof types the gate accepts for a
       * critical objective — and nothing had ever produced one on real work. The
       * check updated the invariant and stopped there, so an objective whose
       * criterion is "this invariant holds in production" could satisfy it and
       * still have nothing the gate could read. Across this whole install the
       * only `invariant` proof was a fixture.
       *
       * Only for an invariant attached to an objective: a project-wide gauge is
       * a gauge, and filing it against nothing would be noise.
       */
      if (inv.objective_id && result.holds !== null) {
        await call(
          'POST',
          `/objectives/${inv.objective_id}/evidences`,
          {
            type: 'invariant',
            verdict: result.holds ? 'pass' : 'fail',
            label: `${inv.name} = ${value} ${inv.unit ?? ''} (${inv.comparison} ${inv.threshold})`,
            ref: config.probes?.[inv.probe_key] ?? null,
            payload: { probe: inv.probe_key, value, comparison: inv.comparison, threshold: inv.threshold },
          },
          { soft: true },
        ).catch(() => {})
      }
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
      // `relay` drives no chapter of its own, so there is nothing to bound the
      // fallback to: the mission's own number decides, as before.
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

  /**
   * Open a fresh driving conversation and hand it the state, without a person.
   *
   * A thread fills up — every turn re-reads the whole of it — and the loop stops
   * and says so. Until now clearing that meant opening ChatGPT yourself, pasting
   * the state in and copying the address back: the one thing the tool exists to
   * remove. It opens its own tab so the one you are reading is left alone.
   *
   * usage: orchestrator judge:renew [--halt <objectiveId>]
   */
  async 'judge:renew'(...argv) {
    if (!config.project) fail('no project in .orchestrator.json')
    const opts = parseFlags(argv)

    // The state first: if the brief cannot be built there is no point opening
    // anything. A conversation created and left empty is worse than none — it
    // becomes the project's judge while knowing nothing.
    const capture = []
    const real = console.log
    console.log = (...a) => capture.push(a.join(' '))
    try {
      await commands.brief()
    } finally {
      console.log = real
    }
    const text = capture.join('\n').trim()
    if (!text) fail('the state came out empty — refusing to open a conversation with nothing in it')

    console.log('\n  opening a new conversation…')
    const page = await openTab('https://chatgpt.com/').catch((e) => fail(e.message))

    try {
      // The composer is not there on first paint, and posting into nothing fails
      // silently: the message is simply never typed.
      let ready = false
      for (let i = 0; i < 60 && !ready; i++) {
        ready = await page
          .evaluate(`Boolean(document.querySelector('#prompt-textarea, [contenteditable="true"]'))`)
          .catch(() => false)
        if (!ready) await pause(500)
      }
      if (!ready) fail('the page never showed a composer — is the session still signed in?')

      await page.evaluate(jsPost(text))
      const landed = await confirmPosted(page, text).catch(() => false)
      if (!landed) fail('the state was not posted — nothing was changed')

      // The address only exists once the first message has been sent: before
      // that the page is chatgpt.com with no conversation behind it.
      let url = null
      for (let i = 0; i < 40 && !url; i++) {
        const href = await page.evaluate('location.href').catch(() => null)
        if (typeof href === 'string' && /\/c\/[0-9a-f-]{8,}/i.test(href)) url = href
        else await pause(500)
      }
      if (!url) fail('the conversation was written to but never took an address')

      await call('PATCH', `/projects/${config.project}`, { judge_url: url, judge_messages_seen: 1 })
      console.log(`  new conversation: ${url}`)

      // The halt that asked for this is cleared here, and only here: it is a
      // human-decision halt, so nothing else would ever clear it.
      const objectiveId = opts.halt ? Number(opts.halt) : null
      if (objectiveId) {
        const o = await call('GET', `/objectives/${objectiveId}`, null, { soft: true }).catch(() => null)
        for (const h of o?.halts ?? []) {
          if (h.resolved_at || h.reason !== 'judge_conversation_full') continue
          await call('PATCH', `/halts/${h.id}/resolve`, null, { soft: true }).catch(() => {})
          console.log(`  halt #${h.id} cleared`)
        }
      }
      console.log('')
    } finally {
      page.close()
    }
  },

  async brief(...argv) {
    if (!config.project) fail('no project in .orchestrator.json')

    const opts = parseFlags(argv)
    const all = await call('GET', `/projects/${config.project}/objectives`)

    // Cadrer sur un arbre d'objectifs : la conversation qui pilote n'a pas
    // besoin de voir les chantiers voisins.
    const scope = opts.objective ? Number(opts.objective) : null
    // What was set aside is out of the picture. The conversation cannot know an
    // objective was dropped unless the state it reads stops mentioning it — and
    // it kept asking for #11 by number, three passes in a row, because the brief
    // still listed it among the work.
    const objectives = (scope ? all.filter((o) => o.id === scope || o.parent_id === scope) : all).filter(
      (o) => o.status !== 'abandoned',
    )
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
      const m = line.match(/requested permissions to use ([A-Za-z0-9_()*.~/\- ]+?)(?:,|\\n|")/)
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

      /**
       * What this project can DRAW ON, not only what it can run.
       *
       * A breakdown that does not know an asset library is available plans to
       * model everything from scratch — a different chapter, a different budget,
       * a different number of weeks. Knowing changes the plan, so it belongs in
       * the breakdown and not only in the session that executes it.
       */
      /**
       * The reference material, measured rather than described.
       *
       * "Make it look like this image" is the most natural way to state a visual
       * target and the least usable one: a breakdown that only reads the sentence
       * writes "improve the vegetation", which is satisfied on day one. Attached
       * images are measured here, so the target arrives as numbers the plan can
       * put in a criterion.
       */
      const attached = await call(
        'GET',
        `/projects/${config.project}/attachments?kind=project`,
        null,
        { soft: true },
      ).catch(() => null)

      let references = ''
      for (const a of (attached ?? []).slice(0, 6)) {
        const line = `- ${a.name}${a.note ? ` — ${a.note}` : ''}\n  ${a.path}`
        if (!/\.(png|jpe?g|webp)$/i.test(a.name)) {
          references += `${line}\n`
          continue
        }
        try {
          const { measureImage } = await import('../visual.js')
          const m = measureImage(a.path)
          references +=
            `${line}\n  measured: saturation ${m.saturation}, ${m.hues} hues, ` +
            `${m.distinctColours} distinct colours, ${(m.greenShare * 100).toFixed(1)}% green\n`
        } catch {
          references += `${line}\n`
        }
      }

      const agents = await call('GET', '/agents', null, { soft: true }).catch(() => null)
      const sources = (agents ?? [])
        .filter((a) => a.enabled && a.kind === 'source')
        .map((a) => `- ${a.label}${a.capabilities?.length ? ` (${a.capabilities.join(', ')})` : ''}` +
          (a.last_detail ? ` — ${String(a.last_detail).slice(0, 120)}` : ''))
        .join('\n')

      const memoryInstruction = [
        'Break the request below into chapters and their execution steps.',
        '',
        'Rules for the breakdown:',
        '- ONE chapter if the request is one piece of work. If it is already a plan with',
        '  its own chapters or phases, keep them — do not flatten a plan of eighteen',
        '  chapters into one, and do not invent chapters a short request does not have;',
        '- every step must be completable in a single agent session;',
        '- every step carries a VERIFIABLE proof criterion, written as a condition, not as an intention. A command that passes, a number crossing a threshold, a screenshot showing something named. Never "it is clean" or "it works better";',
        '- a step you cannot write a checkable criterion for gets `proof_spec: null`. That is honest, and the tool refuses to start it until someone writes one. Inventing a criterion nobody can check is what makes a chapter run six times and conclude never;',
        '- the steps are in the order they must be executed;',
        '- between 2 and 12 steps per chapter. If a chapter only justifies one, do not invent more;',
        '- blast_radius: cosmetic (visual), feature (visible function), api (data or shared interface), critical (money, payroll, production).',
        proofs ? `\nProof commands declared by this project — reuse them as they are when they fit:\n${proofs}` : '',
        sources
          ? `\nMaterial this project can draw on rather than make. Prefer taking and adapting over` +
            ` building from nothing, and say in the step which source you mean to use:\n${sources}`
          : '',
        constraints ? `\nConstraints already settled on this project — do not contradict them:\n${constraints}` : '',
        '',
        '--- LA DEMANDE ---',
        brief.body,
        '--- FIN ---',
        '',
        references
          ? `\nReference material provided for this project. Where an image is measured,` +
            ` use those numbers in the criteria — a target stated as a picture becomes a target` +
            ` a command can check:\n${references}`
          : '',
        '',
        'Two things you must return besides the plan, and they matter as much:',
        '- `assumptions`: everything you had to decide that the request did not say.',
        '  Write each one as a sentence somebody can contradict in five words. "The grass',
        '  is animated, not a static texture" is useful; "high quality" is not. This is',
        '  what replaces a conversation: the reader disagrees with one line instead of',
        '  rejecting the whole plan.',
        '- `unknowns`: what you could not settle and what would settle it. Naming a gap',
        '  is worth more than filling it with a guess that reads like a decision.',
        '',
        'Reply ONLY with a JSON object, with no text around it and no code fence.',
        'One chapter:',
        '{"chapter":"…","intent":"…","assumptions":["…"],"unknowns":["…"],"steps":[{"title":"…","proof_spec":"…","blast_radius":"feature"}]}',
        'Several:',
        '{"chapters":[{"chapter":"…","intent":"…","steps":[…]}],"assumptions":["…"],"unknowns":["…"]}',
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

      // Either shape is accepted and normalised here, so nothing downstream has to
      // know which one came back.
      if (Array.isArray(proposal?.chapters) && proposal.chapters.length) {
        proposal.chapters = proposal.chapters.filter((c) => c?.chapter && Array.isArray(c.steps) && c.steps.length)
      }
      const single = proposal?.chapter && Array.isArray(proposal.steps) && proposal.steps.length
      if (!single && !proposal?.chapters?.length) {
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
          ? proposal.chapters?.length
            ? `    → ${proposal.chapters.length} chapters, ${proposal.chapters.reduce((n, c) => n + c.steps.length, 0)} steps proposed`
            : `    → ${proposal.steps.length} step(s) proposed · “${proposal.chapter}”`
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
  /**
   * What a rendering measurably contains, and how far it is from a reference.
   *
   * usage: orchestrator visual <image.png> [--ref target.png] [--min-colours 1500] [--min-hues 7] [--min-saturation 0.5]
   *
   * Exits 1 when a floor is not met, so it can be declared as a proof in
   * .orchestrator.json and produce a real pass/fail — rather than a score the
   * session announces about its own work, which is recorded as inconclusive and
   * is why thirteen attempts on one objective proved nothing.
   */
  async visual(...argv) {
    const opts = parseFlags(argv)
    const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true)
    if (!file) fail('usage: orchestrator visual <image.png> [--ref target.png] [--min-colours N] [--min-hues N] [--min-saturation X]')

    const { measureImage, compareToReference } = await import('../visual.js')

    const m = measureImage(file)
    console.log(`\n  ${basename(file)}`)
    console.log(`    saturation ${m.saturation} · ${m.hues} hues · ${m.distinctColours} distinct colours · green ${(m.greenShare * 100).toFixed(1)}%`)

    if (opts.ref) {
      const c = compareToReference(file, opts.ref)
      console.log(`\n  against ${basename(opts.ref)}`)
      for (const [k, v] of Object.entries(c.ratios)) {
        console.log(`    ${k.padEnd(16)} ${v === null ? '—' : `${(v * 100).toFixed(0)}% of the reference`}`)
      }
    }

    // Floors only where one was asked for: a threshold nobody set is not a
    // threshold that failed.
    const failures = []
    if (opts['min-colours'] && m.distinctColours < Number(opts['min-colours'])) {
      failures.push(`distinct colours ${m.distinctColours} < ${opts['min-colours']}`)
    }
    if (opts['min-saturation'] && m.saturation < Number(opts['min-saturation'])) {
      failures.push(`saturation ${m.saturation} < ${opts['min-saturation']}`)
    }
    /**
     * A floor on hues, because criteria were already asking for one.
     *
     * `hues` was reported and could not be required: a criterion written as
     * "saturation >= 0,20 and at least 7 hues" named a reader able to settle
     * only half of it, and the other half fell back on somebody reading the
     * line. Distinct colours are not a substitute — 226 shades of the same
     * beige are 226 colours and four hues.
     */
    if (opts['min-hues'] && m.hues < Number(opts['min-hues'])) {
      failures.push(`hues ${m.hues} < ${opts['min-hues']}`)
    }

    if (failures.length) {
      console.log(`\n  below the floor: ${failures.join(' · ')}\n`)
      process.exitCode = 1
      return
    }
    if (opts['min-colours'] || opts['min-saturation'] || opts['min-hues']) console.log('\n  floors met\n')
    else console.log('')
  },

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

    /**
     * A pass is running only while a process carries it.
     *
     * `running` was a word written once and never checked again, so a worker that
     * was killed left its objective claimed for good — and the screen went on
     * reporting work that had stopped. Asking the operating system costs nothing
     * and is the only answer that cannot go stale.
     */
    const sweepDeadRuns = async () => {
      const carried = await call('GET', `/runs/carried?machine=${encodeURIComponent(hostname())}`, null, {
        soft: true,
      }).catch(() => null)
      const dead = (carried?.runs ?? [])
        .filter((r) => {
          if (!r.pid) return true
          try {
            process.kill(r.pid, 0) // signal 0 asks: does it exist? It sends nothing.
            return false
          } catch {
            return true // no such process, or it is not ours to signal
          }
        })
        .map((r) => r.id)
      if (!dead.length) return
      const freed = await call('POST', '/runs/release', { machine: hostname(), ids: dead }, { soft: true }).catch(
        () => null,
      )
      if (freed?.released?.length) {
        console.log(`  released ${freed.released.join(', ')} — nothing was carrying them\n`)
      }
    }

    await sweepDeadRuns()

    /**
     * How long the API has been unreachable.
     *
     * A worker survives the server going away — it keeps polling and picks up
     * where it left off — but it did so in complete silence, so a server that
     * stayed down looked exactly like a queue with nothing in it. Nobody would
     * have known until they wondered why nothing had run all night.
     */
    let mute = 0

    for (;;) {
      await sweepDeadRuns()
      const claimed = await call(
        'POST',
        `/projects/${config.project}/runs/claim`,
        { machine: hostname(), pid: process.pid },
        { soft: true },
      ).catch(() => null)

      // `claim` answers `{run: null}` when there is simply nothing to do, and
      // throws when the server is gone — two very different silences.
      if (claimed === null) {
        mute++
        // Once, then hourly: a line every five seconds would bury the log it is
        // trying to make readable.
        if (mute === 1 || (mute * every) % 3600000 < every) {
          console.error(
            `  ! the API has not answered for ${Math.round((mute * every) / 60000)} min` +
              ` (${config.apiUrl}) — still trying`,
          )
        }
      } else if (mute) {
        console.log(`  the API is back after ${Math.round((mute * every) / 60000)} min\n`)
        mute = 0
      }

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
        run.mode === 'judge'
          ? (run.objective_id ? ['--halt', String(run.objective_id)] : [])
          : run.mode === 'plan'
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
        const command = { plan: 'plan', judge: 'judge:renew' }[run.mode] ?? 'chapter'
        await commands[command](...argsFor)
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

    /**
     * Why this run ended, recorded next to the fact that it did.
     *
     * `done` was carrying a closed chapter, a misread reply and a leftover
     * ending from another objective all at once. Left null on purpose when no
     * branch claims it: "ended without saying why" is the finding, not a gap to
     * paper over.
     */
    let issue = null

    /** One decision per run: the same wall met on three turns is one wall. */
    let suspenduPourOutil = false

    /**
     * When the judge last said anything at all.
     *
     * Its page went unreachable and the loop spent over an hour on it —
     * reload, wait two minutes, give up, reload — never advancing a turn, never
     * ending, never reporting. Every retry underneath IS bounded; what was
     * missing is a bound on the whole thing, and a wall clock does not depend
     * on understanding how the retries interleave.
     *
     * Twenty minutes: far past a service refusing for a while, far short of a
     * night spent reloading a dead tab.
     */
    let dernierMotDuJuge = Date.now()
    const SILENCE_MAX = 20 * 60 * 1000
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

    // If the tab is gone, we know exactly which address to reopen: somebody
    // closing a window is not a decision about the work.
    const page = await attach(match, undefined, { openIfMissing: project?.judge_url }).catch((e) =>
      fail(e.message),
    )

    console.log(
      `\n  chapter #${chapterId} · ${maxTurns} turns max${budget ? ` · budget $${budget}` : ' · free budget'}` +
        ` · stops at $${budgetWithoutProgress} without progress · ${willPost ? 'EXECUTION ACTIVE' : 'read only — nothing will be executed'}\n`,
    )

    let lastSeen = null
    let spent = 0
    let consecutiveEmpty = 0
    let sterile = 0
    // The last turn's image measurements, so the next report can say what moved.
    let measuredLastTurn = null

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
        issue = 'chapter_closed'
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
        issue = 'steps_done_awaiting_verdict'
        break
        }
      }

      const humanHalt = (chapter.halts ?? []).find(
        (h) => !h.resolved_at && stopReasons.includes(h.reason),
      )

      /**
       * A halt raised because a TOOL was refused suspends; it does not stop.
       *
       * Every human halt broke out of the loop, which would have turned the
       * suspension into a death: the run would end, and saying yes on the
       * permissions screen would leave nothing to say yes to — it would have to
       * be queued from scratch. `hold_between_turns` is already waiting a few
       * lines below, and waiting is the whole point here: the obstacle is one
       * click away and the work is untouched.
       */
      if (humanHalt && suspenduPourOutil) {
        console.log(`  waiting — a tool is still refused. Allow it, then press "carry on".`)

        // Waiting IN PLACE. `continue` would have advanced the for-loop counter,
        // so a suspension of a few minutes would have burned every remaining
        // turn at eight seconds apiece and called it a run.
        for (;;) {
          await pause(5000)
          const runs = (await call('GET', '/runs', null, { soft: true }).catch(() => null)) ?? []
          const mine = runs.find((r) => r.id === runId)
          if (!mine || mine.cancel_asked) break
          if (!mine.hold_between_turns) break
        }

        const apres = ((await call('GET', '/runs', null, { soft: true }).catch(() => null)) ?? []).find(
          (r) => r.id === runId,
        )
        if (apres?.cancel_asked) {
          await call('PATCH', `/runs/${runId}`, { status: 'cancelled' }, { soft: true }).catch(() => {})
          issue = 'cancelled_from_screen'
          break
        }

        // Carried on: the halt goes with it, and the wall is allowed to be met
        // again if it was not actually removed.
        await call('POST', `/objectives/${chapterId}/halts/resolve`, {}, { soft: true }).catch(() => {})
        suspenduPourOutil = false
        console.log(`  carrying on\n`)
      }

      if (humanHalt) {
        console.log(`\n  STOP — ${humanHalt.reason} on the chapter. A human decision is required.`)
        console.log(`  ${humanHalt.detail}\n`)
        issue = 'needs_you'
        break
      }

      // 2. Ce que dit GPT.
      // `let`: a reply caught mid-pause is re-read further down, and the longer
      // look replaces it.
      let message = await readJudge(page)

      if (message) {
        dernierMotDuJuge = Date.now()
      } else if (Date.now() - dernierMotDuJuge > SILENCE_MAX) {
        const min = Math.round((Date.now() - dernierMotDuJuge) / 60000)
        console.log(`\n  STOP — the judge's page has been unreachable for ${min} min.`)
        console.log(`  Nothing was advancing; reopen the conversation and start the chapter again.\n`)
        issue = 'judge_page_unreachable'
        break
      }

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
          issue = 'judge_silent'
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
            commitAccepted(verdict.id)
          }
        }
      }

      const fini = parseDone(message)

      /**
       * An ending that names another objective is a leftover, not an answer.
       *
       * The conversation keeps its last message between runs. Run 37 opened on
       * #46 while the thread still ended on `@fini: #41`, written hours earlier
       * — and the loop closed on the spot, without a single turn, announcing an
       * ending for a chapter nobody had asked about. It is the same mistake as
       * honouring the number the judge names over the one the run targets, on
       * the one path that had been left out of that fix.
       *
       * A `@fini` carrying no number stays valid: it can only be about the
       * chapter in hand.
       */
      if (fini?.id && Number(fini.id) !== Number(chapterId)) {
        console.log(
          `  turn ${turn} — the reply still closes #${fini.id}; this run works #${chapterId}. ` +
            `Waiting for an answer about this one.`,
        )
        if (willPost) {
          await postToJudgeWrapped(page)
            .evaluate(
              jsPost(
                `That ending closes #${fini.id}. This run works #${chapterId} — give the mission for it, ` +
                  `after \`@claude:\` or \`@codex:\` alone on its line, or close #${chapterId} explicitly ` +
                  `with \`@fini: #${chapterId} <reason>\`.`,
              ),
            )
            .catch(() => {})
        }
        await pause(5000)
        continue
      }

      if (fini && !parseDirective(message)) {
        console.log(
          `\n  END DECLARED by the judge${fini.id ? ` sur #${fini.id}` : ''}` +
            `${fini.reason ? ` — ${fini.reason}` : ''}\n`,
        )
        issue = 'declared_done'
        break
      }

      let directive = parseDirective(message)

      /**
       * A reply that pronounces a verdict and then goes quiet is usually not
       * finished — it is paused.
       *
       * Every reply in this protocol ends on one of three things: a `@claude:`
       * or `@codex:` directive, an `@fini`, or nothing (and then it is genuinely
       * unusable). `waitForStable` returns after four seconds of quiet, and
       * ChatGPT routinely pauses longer than that while it attaches a file or
       * runs its Sources step — both of which sit exactly between the body of a
       * reply and its last line.
       *
       * That is how a perfectly good answer got answered with "no usable
       * instruction": the verdict at the top had been read, the `@fini: #41` at
       * the bottom had not been written yet. The judge then rewrote the same
       * reply, correctly, three times over, and the loop stopped on the grounds
       * that it had stopped answering.
       *
       * So when a verdict is in hand but no terminator is, give the page one
       * longer, quieter look before telling anybody their reply is unusable.
       */
      if (!directive && !parseDone(message) && verdict && willPost) {
        console.log(`  turn ${turn} — verdict read, no terminator yet. Waiting for the end of the reply.`)
        const complet = await waitForStable(page, { quietMs: 15000, maxMs: 120000 }).catch(() => null)

        if (complet && complet !== message && complet.length > message.length) {
          message = complet
          lastSeen = complet
          directive = parseDirective(message)

          const finiTardif = parseDone(message)
          if (finiTardif && !directive) {
            console.log(
              `\n  END DECLARED by the judge${finiTardif.id ? ` sur #${finiTardif.id}` : ''}` +
                `${finiTardif.reason ? ` — ${finiTardif.reason}` : ''}` +
                `\n  (read on the second look: the first one caught the reply mid-pause)\n`,
            )
            break
          }
        }
      }

      if (!directive) {
        console.log(`  turn ${turn} — no instruction in the reply. Asking again.`)
        if (willPost) {
          await postToJudgeWrapped(page).evaluate(
            jsPost(
              // The last sentence used to read "Or say explicitly that the chapter
              // is finished" — without ever naming the marker that is actually
              // parsed. A judge writing "the chapter is finished" in prose is
              // never understood, and has no way to find that out.
              'No usable instruction in your reply. End with `@claude:` or `@codex:` alone on its line, followed by the full mission citing the target objective number — everything after that marker is passed to the harness word for word. Or, to close the chapter, write `@fini: #<number> <reason>` — that exact marker, on its own line, is the only wording read as an ending.',
            ),
          )
        }
        await pause(5000)
        continue
      }

      /**
       * The harness, once asking has demonstrably not worked.
       *
       * Telling the judge which harness to use is a sentence in a prompt, and it
       * was ignored twice running on objectives whose criterion names a command:
       * once a measurement went to Claude, once a five-minute Claude pass at $4
       * ended on "the criterion is satisfied" without a single number. The same
       * measurement given to Codex closed #41 in three minutes for nothing.
       *
       * This does not take the choice away in general — only after the judge has
       * had a go at an objective whose criterion names a command and produced no
       * measurement at all. The first attempt stays entirely its call.
       */
      if (directive.harness === 'claude') {
        const raison = await forceMeasuringHarness(chapterId)
        if (raison) {
          console.log(`  routing — sent to codex instead: ${raison}`)
          directive.harness = 'codex'
        }
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
        issue = 'no_progress_budget'
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
        issue = 'no_unity_editor'
        break
      }

      // A conversation that has grown past its cap is not a failure of the work —
      // it is a container that is full. Only a person can open a fresh thread and
      // hand over its address, so the loop stops and says exactly that.
      const size = await conversationSize(page)
      const cap = Number(project?.judge_message_cap ?? 40)

      // Report it so the screen can show how full the thread is without opening a
      // browser. Derived from the page each turn, never declared.
      if (size && project?.slug) {
        await call(
          'PATCH',
          `/projects/${project.slug}`,
          { judge_messages_seen: size.asked },
          { soft: true },
        ).catch(() => {})
      }
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
        issue = 'judge_conversation_full'
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
          issue = 'cancelled_from_screen'
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
        issue = 'read_only'
        break
      }

      instructionsDone.add(`${directive.harness}:${directive.task.slice(0, 200)}`)
      const outcome = await runHarness(directive.harness, directive.task, chapterId)
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

      /**
       * A refusal is not a result. It suspends, it does not fail.
       *
       * A tool the session was not allowed to use was counted in the log and
       * nowhere else: the pass carried on without it, worked degraded, produced
       * something bancal, and the loop moved to the next turn. The verdict then
       * describes an obstacle that has nothing to do with the work asked for —
       * one pass spent $110 and 150 M tokens with "3 tool(s) refused" buried in
       * its own log.
       *
       * Nothing new is invented here; four things that already existed are
       * finally joined. The halt makes the browser notification fire and puts
       * the objective under "Needs you"; `hold_between_turns` keeps the run
       * ALIVE and waiting instead of killing it, so saying yes resumes it rather
       * than requiring it to be queued again. The refused patterns are already
       * reported to the permissions screen, where `allow` is one click.
       *
       * Once per run: the same wall on three turns is one decision, not three.
       */
      /**
       * Only a refused TOOL suspends. A refused sentence does not.
       *
       * `denied` carries two different things: patterns the allow list could
       * hold — `Bash(python3 *)`, `mcp__…` — and the harness's own prose when it
       * turned something down for another reason. The first time this fired it
       * caught "This Bash command contains multiple operations… Output
       * redirection": a compound command the agent wrote itself, which no
       * permission can express and nothing you allow would fix.
       *
       * Suspending on that would stop the run and send you to a screen looking
       * for a pattern that does not exist. It is logged and the pass carries on.
       */
      const motifs = (outcome.denied ?? []).filter((d) => /^[A-Za-z0-9_()*.~/\- ]+$/.test(d))

      if (outcome.denied?.length && !motifs.length) {
        console.log(`    (refused for a reason no permission covers — not suspending)`)
      }

      if (motifs.length && !suspenduPourOutil) {
        suspenduPourOutil = true

        const outils = motifs.slice(0, 6).join(', ')
        console.log(`\n  SUSPENDED — ${motifs.length} tool(s) refused: ${outils}`)
        console.log(`  Allow them on the permissions screen, then press "carry on".\n`)

        await call(
          'POST',
          `/objectives/${chapterId}/halts`,
          {
            reason: 'human_request',
            passage_id: outcome.passageId ?? null,
            detail:
              `Tool refused — the pass could not use: ${outils}. It is not the work that failed, ` +
              `it is a permission missing on this project, and a verdict taken on this attempt would ` +
              `judge the obstacle rather than the work. The run is suspended, not stopped: allow what ` +
              `is needed under “What it may do”, then press “carry on”.`,
          },
          { soft: true },
        ).catch(() => {})

        if (runId) {
          await call('PATCH', `/runs/${runId}`, { hold_between_turns: true }, { soft: true }).catch(() => {})
        }
      }

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

      /**
       * Measure what the pass produced, and hand the numbers to the judge.
       *
       * This is the correction to what cost Atlas #11 twenty-one attempts and
       * $634. Its criterion asked for a score; the session announced one — 72/100
       * — and the report carried that sentence and nothing else. Measured
       * afterwards, those renders sit at 163 distinct colours against 1090 for
       * the least demanding reference: a factor of six, not the six points the
       * score claimed. Twenty-one passes optimised furniture because nothing ever
       * told them the lighting had not moved.
       *
       * Derived, never declared — the same rule as cost and deliverables. A
       * session cannot mark its own homework.
       */
      const measured = await measureDeliverables(outcome.produits ?? [])
      if (measured.length) {
        console.log(
          `    ${measured.length} image(s) measured · ` +
            measured
              .slice(0, 2)
              .map((m) => `${m.name}: ${m.distinctColours} colours, sat ${m.saturation}`)
              .join(' · '),
        )
      }

      // Kept from turn to turn so the report can say whether anything moved. The
      // comparison is the whole point: one measurement is a fact, two are a
      // trend, and #11 needed the trend.
      const report = buildReport(turn, directive, {
        ...outcome,
        joints,
        measured,
        previous: measuredLastTurn,
      })
      if (measured.length) measuredLastTurn = measured
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

      await shareNewProofs()

      await pause(4000)
    }

    /**
     * Falling out of the loop without a branch having claimed an outcome means
     * the turns ran out. That is a real ending and it gets its own word; what it
     * must never do is pass for a chapter that closed.
     */
    if (runId) {
      await call(
        'PATCH',
        `/runs/${runId}`,
        { outcome: issue ?? 'out_of_turns' },
        { soft: true },
      ).catch(() => {})
    }

    console.log(`  run ended — ${issue ?? 'out_of_turns'}\n`)

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

/**
 * Refuse to go further.
 *
 * This used to call `process.exit`, which no `try` can catch — so the worker's
 * catch block, written precisely so that one bad run would not take the whole
 * worker with it, never ran. One malformed run killed the loop and left its own
 * record marked `running` for good. Throwing lets the caller decide: the CLI
 * exits, the worker fails that run and takes the next one.
 */
class Refusal extends Error {}

function fail(message) {
  throw new Refusal(message)
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
/**
 * Send whatever proof this turn produced to the shared storages.
 *
 * It was a button on the Tools screen and nothing else, so proofs reached a
 * teammate's Drive only when somebody remembered to press it. A loop meant to
 * run overnight cannot depend on that. The upload itself stays on the server —
 * the credentials live there and must not travel — so this only asks.
 *
 * Bounded, soft and silent on failure: sharing is a courtesy to whoever reads
 * the results later, never a reason to fail a turn that has already been paid
 * for. The button remains, for the backlog that predates this.
 */
async function shareNewProofs() {
  const storages = await call('GET', '/storages', null, { soft: true }).catch(() => null)
  for (const st of storages ?? []) {
    if (!st.enabled || !st.has_credentials) continue
    const r = await call('POST', `/storages/${st.id}/sync`, { limite: 25 }, { soft: true }).catch(
      () => null,
    )
    if (r?.uploaded?.length) console.log(`    ↗ ${r.uploaded.length} proof(s) shared to ${st.label}`)
  }
}

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
        // `/` and `~` belong in a tool name: every path-bearing Bash pattern has
        // one. Without them the capture stopped at the first slash, so
        // `Bash(node ../orchestrator/src/cli.js *)` — refused on two projects for
        // days — was never once reported back, and the screen went on showing
        // nothing undecided while the loop paid for the refusal every turn.
        const m = txt.match(/permissions to use ([A-Za-z0-9_()*.~/\- ]+?)(?:,|$|")/)
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
/**
 * `withinChapter` bounds the fallback. The mission names an objective and we
 * honour it; with no number we fall back on priority — and that fallback used to
 * range over the whole project, so a run launched on chapter #41 opened a pass
 * on #11, a chapter that had just been deliberately set aside and replaced. It
 * simply had a lower priority number.
 */
/**
 * Put out what the pass left burning.
 *
 * A session opens things that outlive it, and the tool had no notion of that at
 * all: it closed the browser tab it used to talk to the judge, and nothing else.
 * A rented GPU keeps billing by the hour until somebody remembers it. An editor
 * left in play mode holds the project and quietly poisons the performance
 * counters of the NEXT pass — which is how a measurement ends up wrong for a
 * reason nobody can see in it.
 *
 * Declared per project, like `proofs` and `probes`, and for the same reason: the
 * server never holds a command it could run on your machine. It says when, the
 * repository says what.
 *
 *   "teardown": { "runpod": "…", "unity_exit_play": "…" }
 *
 * Two rules, both learned the hard way:
 *
 * It runs whatever the verdict — failed, halted, prevented, cut off by a
 * ceiling. A leak is likeliest exactly when the pass went badly, which is when
 * an early return would have skipped this.
 *
 * It never throws. A teardown that failed must not lose a pass that has already
 * been paid for; it says so and gets out of the way.
 */
async function runTeardown(passageId = null) {
  const entries = Object.entries(config.teardown ?? {})
  if (!entries.length) return

  const report = []

  for (const [name, command] of entries) {
    try {
      const out = execFileSync('/bin/sh', ['-c', command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
        // The same environment the session had. Without it, the one command that
        // matters most — the one that closes a rented machine — has no key to
        // close it with, and would fail silently every time.
        env: { ...process.env, ...(config.secrets ?? {}), ...config.env },
      })
        .trim()
        .split('\n')
        .pop()

      console.log(`    ⏻ ${name}${out ? ` — ${out.slice(0, 70)}` : ''}`)
      report.push({ name, ok: true, said: out.slice(0, 200) })
    } catch (e) {
      // Said, not swallowed: something is still running and still costing.
      const why = String(e.stderr || e.message).trim().split('\n').pop() ?? ''
      console.log(`    ⏻ ${name} — DID NOT SHUT DOWN: ${why.slice(0, 70)}`)
      report.push({ name, ok: false, said: why.slice(0, 200) })
    }
  }

  const leaking = report.filter((r) => !r.ok)
  if (leaking.length) {
    console.log(`\n  ${leaking.length} thing(s) the pass could not shut down: ${leaking.map((r) => r.name).join(', ')}\n`)
  }

  if (passageId) {
    await call(
      'POST',
      `/passages/${passageId}/evidences`,
      {
        type: leaking.length ? 'manual' : 'diff',
        label: leaking.length
          ? `Teardown incomplete — still up: ${leaking.map((r) => r.name).join(', ')}`
          : `Teardown — ${report.length} service(s) shut down`,
        verdict: leaking.length ? 'fail' : 'inconclusive',
        payload: { teardown: report },
      },
      { soft: true },
    ).catch(() => {})
  }
}

/**
 * Should this objective's next attempt be measured by Codex rather than asked
 * of Claude again?
 *
 * Answers with the reason, or null to leave the judge's choice alone. Three
 * conditions, all of them observable — none of them an opinion:
 *   the criterion names something that runs;
 *   at least one attempt has already been made;
 *   not one of them produced a proof of a measured type.
 *
 * Silent on any API trouble: a routing preference is never worth killing a pass
 * over.
 */
async function forceMeasuringHarness(objectiveId) {
  try {
    const o = await call('GET', `/objectives/${objectiveId}`, null, { soft: true })
    const spec = o?.proof_spec ?? o?.objective?.proof_spec ?? ''
    if (!/orchestrator\s+\w|python3\s|\bexit\s*0\b|node\s+\S+\.js/i.test(spec)) return null

    const passages = o?.passages ?? []
    if (!passages.length) return null

    const MESURE = ['test', 'e2e', 'invariant']
    const mesuree = [...(o?.evidences ?? []), ...passages.flatMap((p) => p.evidences ?? [])].some((e) =>
      MESURE.includes(e.type),
    )
    if (mesuree) return null

    return `criterion names a command, ${passages.length} attempt(s), no measured proof yet`
  } catch {
    return null
  }
}

/**
 * Did this file record a command being run, or is it prose about one?
 *
 * Everything a pass produced was filed the same way: an image became a
 * `render`, and every other file a `diff` — a deliverable. So the one artefact
 * that settles anything, the transcript of a command with its exit code, was
 * stored as indistinguishable from a markdown report. The automatic path could
 * therefore never create a `test`, `e2e` or `invariant`, which are exactly the
 * three types this tool counts as measured. Six proofs out of 434 across the
 * install, and the reason was here, not in anyone's habits.
 *
 * Deliberately hard to satisfy: it wants BOTH a command line and an exit code,
 * each at the start of its own line, before it will call a file a measurement.
 * A report that merely mentions a command stays a deliverable.
 */
function traceDUneCommande(chemin) {
  try {
    if (!existsSync(chemin)) return null
    if (/\.(png|jpg|jpeg|webp|gif|pdf|zip|mp4|mov)$/i.test(chemin)) return null
    // A transcript is small. Anything huge is a dump, and reading it into memory
    // to look for two words is not worth the risk.
    if (statSync(chemin).size > 512 * 1024) return null

    const texte = readFileSync(chemin, 'utf8')
    if (!/^[ \t]*(command|commande)[ \t]*:/im.test(texte)) return null

    const codes = [...texte.matchAll(/^[ \t]*exit(?:[ \t]+code)?[ \t]*:[ \t]*(-?\d+)/gim)].map((m) =>
      Number(m[1]),
    )
    if (!codes.length) return null

    return { codes, passed: codes.every((c) => c === 0) }
  } catch {
    // Unreadable, binary, or gone since: then it is simply not a measurement.
    return null
  }
}

async function runHarness(harness, task, withinChapter = null) {
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

    /**
     * A run names its chapter; the conversation names a step. When the two
     * disagree, the number in the text used to win in silence — `withinChapter`
     * arrived here as a parameter and was never read once.
     *
     * A run queued on #42 worked #41 instead, and the only trace of it was a run
     * note reading "on #42" beside a turn note reading "on #41". Same failure as
     * #11, one path further along: the guard below catches `abandoned` only, so a
     * live objective walks straight past it.
     *
     * The chapter itself is allowed — working it is what closes it — and so is
     * any of its descendants, which are precisely its steps. Anything else is a
     * disagreement the operator has to see, not one the loop settles alone.
     */
    if (withinChapter && id !== Number(withinChapter)) {
      const seen = new Set()
      let up = o.parent_id
      let isStep = false

      while (up && !seen.has(up)) {
        if (up === Number(withinChapter)) {
          isStep = true
          break
        }
        seen.add(up)
        up = objectives.find((x) => x.id === up)?.parent_id
      }

      if (!isStep) {
        return {
          verdict: 'refused',
          halts: [],
          stop: true,
          stopReason:
            `the run works chapter #${withinChapter}, and the instruction names #${id}, which is ` +
            `neither that chapter nor one of its steps. Point the run at the right chapter, or tell ` +
            `the conversation which one it is working on — do not let the two drift apart in silence.`,
          output: '',
        }
      }
    }

    /**
     * An objective set aside is not worked on, even when the mission names it.
     *
     * The driving conversation has no way of knowing it was dropped — it goes on
     * asking for #11 because that is what it was discussing. Honouring the number
     * blindly meant a chapter deliberately replaced kept being worked, three
     * times in a row, each time under a different status it had been quietly
     * given back.
     */
    if (o.status === 'abandoned') {
      return {
        verdict: 'refused',
        halts: [],
        stop: true,
        stopReason:
          `objective #${id} was set aside. The conversation is still asking for it — tell it what ` +
          `replaced it, or reopen the objective if setting it aside was a mistake.`,
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
    const inScope = withinChapter
      ? objectives.filter((o) => o.id === withinChapter || o.parent_id === withinChapter)
      : objectives

    target = inScope
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

  // Only for harnesses whose list is actually handed to them. Claude receives
  // `--allowed-tools`, so an empty list really does mean every call is refused
  // and the pass would bill for nothing. Codex is launched with approvals and
  // sandbox bypassed and never sees the list at all — applying a Claude-shaped
  // rule to it blocked a harness that had just produced fourteen advancing
  // passes, in the name of a protection that was not in force.
  if (ENFORCED_ALLOWLIST.has(harness) && !perms.allow?.length) {
    throw new Error(
      `No tool allowed for “${harness}” on this project — pass cancelled. ` +
        'In a non-interactive session a tool off the list is refused without asking: nothing could succeed.',
    )
  }

  const before = head()
  const startedAt = Date.now()

  /**
   * A way back, before anything runs.
   *
   * The rules shown for Codex include "no rm -rf", and they have never stopped
   * anything — it runs sandbox-bypassed and is never handed the list. Rather
   * than reword a prohibition that cannot be enforced, make the damage
   * reversible: what cannot be forbidden can at least be undone.
   *
   * It costs nothing when there is nothing to save, and says nothing when git is
   * absent or unconfigured — somebody else's project may have neither.
   */
  // The branch you chose, before anything is written. Refusing here costs a
  // pass that has not started; discovering it afterwards costs one that has.
  const branche = chooseBranch(target.id, target.title)
  if (!branche.ok) {
    return {
      verdict: 'refused',
      halts: [],
      stop: true,
      stopReason: `cannot work on the branch this project asks for: ${branche.why}`,
      output: '',
    }
  }

  const saved = restorePoint(`${harness}-${before?.slice(0, 7) ?? 'nohead'}`)
  if (saved.made) {
    console.log(
      `    ↩ restore point ${saved.sha}` +
        (saved.untracked ? ` — ${saved.untracked} untracked file(s) NOT covered` : ''),
    )
  }

  // The working tree may already be dirty: photograph its state first, otherwise
  // we charge the session for what somebody else left lying around.
  const dirtyBefore = new Set(
    (git('status', '--porcelain') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim()),
  )

  /**
   * Hand the keys back.
   *
   * A session rents a machine, starts a remote job, leaves an editor in play
   * mode — and it is the only thing in the whole system that knows what it
   * started. Nobody can write that command ahead of time: the identifier of a
   * pod does not exist until the pass creates it.
   *
   * So the order to close travels WITH the mission rather than being declared
   * against it. Appended, never woven in: the instruction from the conversation
   * still reaches the harness word for word, and this follows it.
   *
   * It cannot cover a pass that dies before reading it — a crash, a ceiling, the
   * timeout. That is what `teardown` in `.orchestrator.json` is for, and why it
   * runs whatever the verdict.
   */
  const missionAvecCles =
    `${task}\n\n---\n` +
    `Before you finish: anything you started during this pass that outlives it — a rented machine, ` +
    `a remote job, a server, an editor left in play mode — shut it down, and state in one line what ` +
    `you shut down, or that there was nothing. You are the only one who knows what you started.`

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
              ? ['exec', 'resume', String(reprise), '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', missionAvecCles]
              : ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', missionAvecCles],
          ]
        : [
            harnessBin('claude'),
            // The instruction FIRST: --allowed-tools and --disallowed-tools are
            // variadic and would swallow any text placed after them.
            [
              '-p',
              missionAvecCles,
              // La reprise vient AVANT les listes d'outils, qui sont variadiques.
              ...(reprise ? ['--resume', String(reprise)] : []),
              /**
               * Two bounds that were not being passed at all.
               *
               * Attempt 112 made 321 requests and read 114 M tokens in twenty-one
               * minutes — 112 M of them cache reads, the same ~350 k context re-read
               * on every request — and took the whole Claude session window down with
               * it. Nothing capped it while it ran: the token guard only speaks once
               * the pass is over.
               *
               * Both stay unset by default, so nothing changes for a project that
               * says nothing. `harnessModel` lets mechanical work run somewhere
               * cheaper than Opus; `maxTurns` stops one pass from spending the
               * window every other pass also needs.
               */
              ...(config.harnessModel ? ['--model', String(config.harnessModel)] : []),
              ...(config.maxTurns ? ['--max-turns', String(config.maxTurns)] : []),
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
  const remontables = diag.denied.filter((d) => /^[A-Za-z0-9_()*.~/\- ]+$/.test(d))

  if (remontables.length) {
    await call(
      'POST',
      `/projects/${config.project}/permissions/requested`,
      { patterns: remontables, harness },
      { soft: true },
    ).catch(() => {})
  }

  await runTeardown(passage.id)

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

  /**
   * Did this pass rewrite the thing that judges it?
   *
   * A criterion names its reader — a gate script, a manifest, a command. Nothing
   * stopped the session that is being examined from editing the examination, and
   * a chapter went from twenty-eight checks to eighty-six that way, each pass
   * adding demands and then failing the ones it had just added. The target moved
   * away as fast as the work approached it.
   *
   * Not forbidden: sometimes a gate genuinely lacks a check, and finding that out
   * is the work. But it stops being invisible. A criterion is supposed to be
   * fixed before the work starts, and a criterion rewritten mid-pass by the party
   * under examination is a different thing wearing the same name.
   */
  const juge = [...(String(target.proof_spec ?? '').matchAll(/[\w./-]+\.(?:py|sh|mjs|js|json)\b/g))].map(
    (m) => m[0],
  )
  const jugeTouche = juge.filter((f) => [...changed, ...produits].some((p) => p.endsWith(f)))

  if (jugeTouche.length) {
    console.log(`\n  ! this pass edited what judges it: ${jugeTouche.join(', ')}\n`)
    await call(
      'POST',
      `/passages/${passage.id}/evidences`,
      {
        type: 'manual',
        verdict: 'inconclusive',
        label: `Rewrote its own criterion's reader — ${jugeTouche.join(', ')}`,
        payload: {
          files: jugeTouche,
          note:
            'The criterion names this file and the pass under examination changed it. ' +
            'Legitimate when a check was genuinely missing; worth a human eye either way.',
        },
      },
      { soft: true },
    ).catch(() => {})
  }

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
    /**
     * `prevented` keeps its strict meaning — it did not try, so no guard counts
     * it. But the REASON was being thrown away in the one case that costs most:
     * a pass that had already produced work and was then cut off by the
     * harness's usage ceiling. It changed files, so `prevented` is false, so
     * nothing was recorded, and the attempt reads as a plain `failed`.
     *
     * Attempt 112 was exactly that: 114 M tokens, $79, cut off by a ceiling
     * announced for 84 minutes later — filed as a failure with no explanation.
     * It then counted as "no progress" and stopped the run on the grounds that
     * a great many tokens had proved nothing. The ceiling had.
     */
    prevented_by: prevented
      ? diag.limitReset
        ? "Plafond d'usage du harnais atteint"
        : diag.denied.slice(0, 10).join(', ')
      : diag.limitReset
        ? "Plafond d'usage du harnais atteint — la passe travaillait déjà, elle a été coupée en cours"
        : timedOut
          ? `Cut off by the ${config.sessionTimeoutMin} min timeout, it was still working`
          : null,
    said: diag.lastMessage ? diag.lastMessage.slice(-6000) : null,
    tools_used: diag.tools ?? null,
    session_id: diag.sessionId ?? null,
  }, { soft: true }).catch(() => {})

  // Record what the session actually produced, as proof.
  for (const produced of produits.slice(0, 8)) {
    const mesure = traceDUneCommande(produced)
    const type = /\.(png|jpg)$/i.test(produced) ? 'render' : mesure ? 'test' : 'diff'

    await call(
      'POST',
      `/passages/${passage.id}/evidences`,
      {
        type,
        label: mesure
          ? `Command run — ${basename(produced)} (exit ${mesure.codes.join(', ')})`
          : `Deliverable produced — ${basename(produced)}`,
        ref: produced,
        // A command's own exit code decides, not whether the objective was
        // reached: those are two different questions, and conflating them is how
        // a failing measurement ended up filed as inconclusive.
        verdict: mesure ? (mesure.passed ? 'pass' : 'fail') : resultats.atteint ? 'pass' : 'inconclusive',
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

/**
 * What the renders of this pass actually contain.
 *
 * Four at most: the point is to say whether the images moved, not to bill a
 * measurement of every file. Failures are silent — an unreadable image is not a
 * reason to lose a pass that has already been paid for.
 */
async function measureDeliverables(produced) {
  const images = produced.filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).slice(0, 4)
  if (!images.length) return []

  let measureImage
  try {
    ;({ measureImage } = await import('../visual.js'))
  } catch {
    return []
  }

  const out = []
  for (const rel of images) {
    try {
      const m = measureImage(resolve(process.cwd(), rel))
      out.push({ name: basename(rel), ...m })
    } catch {
      /* unreadable, or not really an image: say nothing rather than fail a pass */
    }
  }
  return out
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
          (images > outcome.joints ? ` (of ${images} produced)` : '') +
          ` — judge on the image, not on the announced score.`,
      )
    }
  }

  /**
   * What the images measurably contain, and whether it moved.
   *
   * The line that would have ended Atlas #11 at the third attempt instead of the
   * twenty-first: its renders never changed on any measure while four passes
   * added furniture and the session reported "72/100" each time. A number the
   * session did not choose is the only kind a judge can use.
   */
  if (outcome.measured?.length) {
    lines.push('**Measured in the images** — read from the files, not reported by the session')
    for (const m of outcome.measured) {
      lines.push(
        `- ${m.name} — saturation ${m.saturation}, ${m.hues} hues, ` +
          `${m.distinctColours} distinct colours, ${(m.greenShare * 100).toFixed(1)}% green`,
      )
    }

    if (outcome.previous?.length) {
      const before = outcome.previous
      const avg = (list, key) => list.reduce((n, m) => n + m[key], 0) / list.length
      const moved = ['saturation', 'distinctColours', 'hues'].filter(
        (k) => Math.abs(avg(outcome.measured, k) - avg(before, k)) > (k === 'saturation' ? 0.01 : 1),
      )
      lines.push(
        '',
        moved.length
          ? `Against the previous attempt: ${moved.join(', ')} moved.`
          : 'Against the previous attempt: NOTHING moved on any of these measures. ' +
            'Whatever was changed, it is not visible in the images.',
      )
    }
    lines.push('')
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
      `**Over to you.** Rule on #${outcome.objectiveId ?? '?'} — write "@verdict: #${outcome.objectiveId} accepted" or "@verdict: #${outcome.objectiveId} rejected" — then give the next mission, complete and structured as usual, introduced by \`@claude:\` or \`@codex:\` alone on its line and citing the target objective number. Everything after that marker is passed to the harness word for word, and nothing else reaches it. To close the chapter instead, write \`@fini: #<number> <reason>\` — that exact marker, on its own line. Without either, the loop stops.`,
      '',
      /**
       * Which harness gets the work, said with the figures rather than as a
       * preference.
       *
       * The judge picks by naming a marker, and nothing had ever told it that the
       * choice costs anything. On this install it chose Codex once, by itself,
       * and that single pass proved an objective twenty-three attempts of Claude
       * had not. The gap is not small enough to leave to chance.
       */
      `**Which harness.** Work whose criterion is settled by running something — \`orchestrator visual\`, a gate script, a count, a replay, a re-measurement — goes to \`@codex:\`. Measured here: the decisive measurement on Atlas #41 took 496 000 tokens and three minutes through Codex and closed the objective; comparable work on Blockrise ran to 398 million tokens over three Claude passes, proved nothing, and exhausted the session window both projects share. Send designing, judging and code that has to be written to \`@claude:\`; send running, measuring and verifying to \`@codex:\`.`,
    )
  }

  return lines.join('\n')
}

// This file is no longer an entry point: the package's single CLI calls these
// commands. That is what lets `orchestrator serve` and `orchestrator chapter` be
// the same command, installed once.
export { commands, Refusal, gitReady, restorePoint }
