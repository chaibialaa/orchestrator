#!/usr/bin/env node
/**
 * Agent local Orchestrator — client mince.
 *
 * Il n'exécute JAMAIS une commande reçue du serveur : seules les clés
 * déclarées dans .orchestrator.json (proofs.*) sont exécutables. C'est
 * cette règle, et elle seule, qui rendra une version hébergée défendable.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { resolve, relative, basename, dirname, join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { RULES, checkFile } from './rules.js'
import { recentSessions, readSince, encodeCwd } from './watch.js'
import { genererImage, ADAPTATEURS } from './images.js'
import { inventorier, assembler, consigne, empreinte } from './memoires.js'
import { attach, parseDirective, parseVerdict, parseFini, jsPost, attachFiles, waitForStable, confirmPosted, JS_LAST_ASSISTANT, JS_IS_STREAMING } from './relay.js'

/**
 * Tarifs Claude en $/million de tokens : [entrée, sortie].
 * L'écriture de cache coûte ×1,25 (TTL 5 min) ou ×2 (TTL 1 h) le tarif
 * d'entrée ; la lecture de cache ×0,1.
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

/** Les identifiants portent parfois un suffixe (`[1m]`, date) : on préfixe. */
function priceFor(model) {
  const key = Object.keys(PRICING)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k))
  return key ? PRICING[key] : [0, 0]
}

/** Claude Code range ses transcripts par répertoire de travail encodé. */
function defaultTranscriptDir() {
  // Une seule source pour cette règle : elle vivait à deux endroits, l'un des
  // deux a été corrigé et pas l'autre, et la panne est restée entière.
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
    // Un secret laissé vide dans le fichier n'écrase pas celui de l'environnement :
    // `{ "RUNPOD_API_KEY": "" }` effacerait la vraie clé au lancement de l'agent.
    secrets: Object.fromEntries(Object.entries(project.secrets ?? {}).filter(([, v]) => v !== '' && v != null)),
    deliverableDirs: project.deliverableDirs ?? null,
    deliverableIgnore: project.deliverableIgnore ?? null,
  }
}

const config = loadConfig()

async function call(method, path, body, { soft = false } = {}) {
  const envoyer = () =>
    fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

  // Une passe dure des minutes ; entre deux appels, la connexion gardée en
  // réserve meurt côté serveur et l'écriture suivante part dans le vide
  // (EPIPE). Ça avait l'air d'un problème de taille — l'inventaire de 93 ko
  // passait, le résultat de 83 ko échouait : c'était le silence, pas le poids.
  let res
  try {
    res = await envoyer()
  } catch (e) {
    const mort = ['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET'].some((c) => String(e?.cause?.code ?? e?.code ?? e?.message).includes(c))
    if (!mort) throw e
    await pause(300)
    res = await envoyer()
  }

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    // Un refus de la porte de preuve n'est pas une panne : c'est le produit.
    // Il ne doit donc PAS tuer une boucle en cours — sinon un objectif qui
    // refuse de conclure emporte tout le chapitre avec lui, y compris les
    // autres étapes qui n'ont rien demandé.
    if (data.gate) {
      console.error(`\n  refus du gate — ${data.gate.reason}`)
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

/** L'état réel vient de git, jamais du rapport d'un agent. */
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

/** Les hooks reçoivent leur charge utile en JSON sur stdin. */
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
   * Hook SessionStart : injecte la mémoire du projet dans le contexte et
   * ouvre une tentative si un objectif est prenable. Rien à taper.
   */
  async 'session:start'() {
    const input = await readHookInput()
    if (!config.project) return process.exit(0)

    const recall = await call('GET', `/projects/${config.project}/recall`)
    const objectives = await call('GET', `/projects/${config.project}/objectives`)

    const takeable = objectives
      .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
      .sort((a, b) => a.priority - b.priority)

    const lines = [`# Mémoire ${recall.project.name}`, '']

    for (const d of recall.decisions) {
      lines.push(`## ${d.title} (${d.decided_at.slice(0, 10)})`)
      lines.push(d.body)
      if (d.paths?.length) lines.push(`Chemins concernés : ${d.paths.join(', ')}`)
      lines.push('')
    }

    for (const r of recall.resources) {
      lines.push(`## Document — ${r.name}${r.summary ? ` : ${r.summary}` : ''}`)
      if (r.content) lines.push(r.content)
      else lines.push(`Fichier : ${r.url}`)
      lines.push('')
    }

    let passageId = null
    // Lancé par `orchestrator do` / `relay` : le parent gère déjà la
    // tentative. On injecte le contexte, on n'en ouvre pas une seconde.
    const managed = process.env.ORCHESTRATOR_MANAGED === '1'

    if (takeable.length) {
      const objective = takeable[0]
      lines.push(`## Objectif en cours — #${objective.id} ${objective.title}`)
      lines.push(`Rayon de souffle : ${objective.blast_radius}`)
      lines.push(`Preuve attendue : ${objective.proof_spec}`)

      const passage = managed
        ? null
        : await call('POST', `/objectives/${objective.id}/passages`, {
            harness: 'claude',
            git_before: head(),
          }).catch(() => null)

      if (managed) lines.push('Tentative déjà ouverte par l’orchestrateur.')

      if (passage?.id) {
        passageId = passage.id
        const state = readState()
        state[input.session_id ?? 'inconnu'] = { passageId, project: config.project }
        writeState(state)
        lines.push(`Tentative #${passageId} ouverte — les preuves s'y rattachent.`)
      }
    } else {
      lines.push('## Aucun objectif prenable')
      lines.push('Tout est prouvé, arrêté, ou sans critère de preuve défini.')
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
   * Hook SessionEnd : lit la consommation réelle, clôt la tentative.
   * Le verdict se déduit des preuves, il ne se déclare pas.
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
        systemMessage: `Orchestrator — tentative #${entry.passageId} close (${proven ? 'a fait avancer' : "n'a rien démontré"}).`,
      }),
    )
  },

  /** Hook PostToolUse sur `git commit` : recale l'état réel du dépôt. */
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

    if (!data.decisions.length && !data.requires_human) console.log('  aucune décision liée à ce chemin')
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
    if (!passageId || !verdict) fail('usage: orchestrator passage:end <passageId> <advanced|no_progress|halted|failed> [résumé]')
    const passage = await call('PATCH', `/passages/${passageId}`, {
      verdict,
      git_after: head(),
      summary: summary.join(' ') || undefined,
    })
    console.log(`passage ${passage.id} clos — ${passage.verdict}`)
  },

  async evidence(passageId, type, verdict, ...label) {
    if (!passageId || !type || !verdict) {
      fail('usage: orchestrator evidence <passageId> <test|e2e|screenshot|render|diff|invariant|manual> <pass|fail|inconclusive> <libellé>')
    }
    const evidence = await call('POST', `/passages/${passageId}/evidences`, {
      type,
      verdict,
      label: label.join(' ') || type,
    })
    console.log(`preuve ${evidence.id} — ${evidence.type}/${evidence.verdict}`)
  },

  /** Exécute une preuve DÉCLARÉE localement et publie son verdict. */
  async prove(passageId, key) {
    if (!passageId || !key) fail(`usage: orchestrator prove <passageId> <${Object.keys(config.proofs).join('|') || 'clé'}>`)

    const command = config.proofs[key]
    if (!command) {
      fail(`Preuve « ${key} » non déclarée dans .orchestrator.json — refus d'exécuter une commande non déclarée.`)
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
    console.log(`preuve « ${key} » → ${verdict}`)
    if (verdict === 'fail') process.exit(1)
  },

  /**
   * Vérifie le diff réel : rayon de souffle d'abord, puis le pack de pièges.
   * Sort en 2 si quelque chose doit arrêter la boucle.
   */
  async guard(from, to = 'HEAD') {
    if (!from) fail('usage: orchestrator guard <sha-avant> [sha-après]')

    const paths = changedPaths(from, to)
    const hits = paths.filter((p) => config.blastRadius.some((g) => matchesGlob(p, g)))
    let stop = false

    if (hits.length) {
      console.error(`\n  ARRÊT — rayon de souffle`)
      hits.forEach((h) => console.error(`    ${h}`))
      stop = true
    }

    const findings = []
    for (const p of paths) {
      if (!existsSync(p)) continue
      try {
        findings.push(...checkFile(p, readFileSync(p, 'utf8')))
      } catch {
        // fichier binaire ou illisible : hors périmètre des règles
      }
    }

    const halts = findings.filter((f) => f.severity === 'halt')
    const warns = findings.filter((f) => f.severity === 'warn')

    if (halts.length) {
      console.error(`\n  ARRÊT — ${halts.length} règle(s) du projet enfreinte(s)`)
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
      `${paths.length} fichiers modifiés — rayon de souffle propre, ${RULES.length} règles passées`,
    )
  },

  /** Passe le pack de règles sur des chemins donnés, hors contexte git. */
  async lint(...paths) {
    if (!paths.length) fail('usage: orchestrator lint <fichier…>')

    const findings = []
    for (const p of paths) {
      const full = resolve(p)
      if (!existsSync(full)) continue
      const shown = relative(process.cwd(), full)
      const label = shown.startsWith('..') ? full : shown || p
      findings.push(...checkFile(label, readFileSync(full, 'utf8')))
    }

    if (!findings.length) return console.log(`aucune infraction — ${RULES.length} règles passées`)

    for (const f of findings) {
      console.log(`  ${f.severity === 'halt' ? 'ARRÊT' : 'à vérifier'}  ${f.path}:${f.line}  [${f.rule}]`)
      console.log(`    ${f.why}`)
      console.log(`    ${f.code}`)
    }

    process.exitCode = findings.some((f) => f.severity === 'halt') ? 2 : 0
  },

  /** Dépose un fichier (< 5 Mo) dans la mémoire du projet. */
  async remember(file, ...summary) {
    if (!file) fail('usage: orchestrator remember <fichier> [résumé]')

    const path = resolve(file)
    if (!existsSync(path)) fail(`fichier introuvable : ${path}`)

    const bytes = statSync(path).size
    if (bytes > 5 * 1024 * 1024) {
      fail(`${(bytes / 1024 / 1024).toFixed(1)} Mo — au-delà de 5 Mo, référence le fichier plutôt que de le mémoriser.`)
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

    console.log(`mémorisé — ${data.name} (${data.kind}, ${(data.size / 1024).toFixed(1)} ko)`)
  },

  /** Le paquet de contexte à charger au démarrage d'une session de travail. */
  async recall() {
    const data = await call('GET', `/projects/${config.project}/recall`)

    console.log(`\n# Contexte ${data.project.name}\n`)
    console.log(`## Décisions (${data.decisions.length})\n`)
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
      else console.log(`Fichier : ${r.url}`)
      console.log('')
    }
  },

  /**
   * Lit la consommation RÉELLE dans les transcripts du harnais et la publie.
   * Aucune coopération de l'agent n'est requise : le harnais journalise déjà
   * chaque requête avec son modèle, son horodatage et ses compteurs.
   */
  async 'usage:scan'(passageId, transcriptDir) {
    if (!passageId) fail('usage: orchestrator usage:scan <passageId> [dossier-transcripts]')

    const passage = await call('GET', `/passages/${passageId}`)
    const since = new Date(passage.started_at).getTime()
    const until = passage.ended_at ? new Date(passage.ended_at).getTime() : Date.now()

    // Absence de transcripts : on ne sait pas mesurer, on ne bloque pas.
    const dir = transcriptDir ?? config.transcripts ?? defaultTranscriptDir()
    if (!existsSync(dir)) {
      return console.error(`transcripts introuvables (${dir}) — consommation non mesurée`)
    }

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => resolve(dir, f))
      .filter((f) => statSync(f).mtimeMs >= since)

    if (!files.length) {
      return console.log('aucun transcript modifié depuis le début de la tentative')
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
        // La création de cache se facture différemment selon sa durée de vie.
        t.cache5m += usage.cache_creation?.ephemeral_5m_input_tokens ?? 0
        t.cache1h += usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
        t.n += 1
        requests += 1
      }
    }

    if (!requests) return console.log('aucune requête trouvée dans la fenêtre de la tentative')

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
        `    ${t.n} requêtes · ${modelTokens.toLocaleString('fr-FR')} tokens · $${modelCost.toFixed(3)}`,
      )
      console.log(
        `    entrée ${t.input.toLocaleString('fr-FR')} · sortie ${t.output.toLocaleString('fr-FR')} · ` +
          `cache écrit ${(t.cache5m + t.cache1h).toLocaleString('fr-FR')} · cache lu ${t.cacheRead.toLocaleString('fr-FR')}`,
      )
    }

    const updated = await call('POST', `/passages/${passageId}/usage`, {
      tokens,
      cost_usd: Number(cost.toFixed(3)),
    })

    console.log(
      `\n  publié → ${updated.tokens.toLocaleString('fr-FR')} tokens · $${updated.cost_usd} sur la tentative ${passageId}\n`,
    )
  },

  /** Consommation d'une demande, cumulée sur la tentative. */
  async usage(passageId, tokens, cost) {
    if (!passageId || !tokens) fail('usage: orchestrator usage <passageId> <tokens> [coût $]')
    const passage = await call('POST', `/passages/${passageId}/usage`, {
      tokens: Number(tokens),
      cost_usd: cost ? Number(cost) : undefined,
    })
    console.log(`${passage.requests} demandes · ${passage.tokens} tokens · $${passage.cost_usd}`)
  },

  /**
   * L'état RÉEL des dépôts, dérivé de git seul.
   * `git branch --contains` ment sur les squash : on compare par patch-id.
   */
  async inventory(root = process.cwd()) {
    const base = resolve(root)
    const repos = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(resolve(base, e.name, '.git')))
      .map((e) => resolve(base, e.name))

    if (!repos.length) return console.log(`aucun dépôt git sous ${base}`)

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

      // Commits locaux dont le CONTENU n'existe pas en amont.
      // L'ascendance ment après un squash ou un rebase : on compare par patch-id.
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

    console.log(`\n  ${rows.length} dépôts — ${inFlight.length} avec du travail en vol\n`)

    for (const r of inFlight) {
      const flags = []
      if (r.dirty) flags.push(`${r.dirty} fichier(s) non commité(s)`)
      if (r.unpushed.length) flags.push(`${r.unpushed.length} commit(s) NON POUSSÉ(S)`)
      if (r.alreadyUpstream) flags.push(`${r.alreadyUpstream} déjà en amont (squash)`)
      if (r.behind) flags.push(`${r.behind} en retard`)
      if (!r.upstream) flags.push('aucun amont')

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
   * Exécute les sondes DÉCLARÉES localement et publie chaque mesure.
   * Le serveur dit quoi mesurer par une clé ; il ne dit jamais comment.
   */
  async 'invariants:check'() {
    if (!config.project) fail('aucun projet dans .orchestrator.json')

    const invariants = await call('GET', `/projects/${config.project}/invariants`)
    if (!invariants.length) return console.log('aucun invariant déclaré')

    let breached = 0

    for (const inv of invariants) {
      const probe = config.probes?.[inv.probe_key]

      if (!probe) {
        console.log(`  ?  ${inv.name} — sonde « ${inv.probe_key} » non déclarée localement`)
        continue
      }

      let raw
      try {
        raw = execFileSync('/bin/sh', ['-c', probe], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      } catch {
        console.log(`  ?  ${inv.name} — la sonde a échoué`)
        continue
      }

      const value = Number(raw.split('\n').pop())
      if (!Number.isFinite(value)) {
        console.log(`  ?  ${inv.name} — la sonde n'a pas renvoyé un nombre : « ${raw.slice(0, 40)} »`)
        continue
      }

      const result = await call('POST', `/invariants/${inv.id}/readings`, { value })
      const mark = result.holds ? 'ok' : 'FRANCHI'
      console.log(`  ${result.holds ? '·' : '!'}  ${inv.name} = ${value} ${inv.unit ?? ''} — ${mark}`)

      if (!result.holds) {
        breached += 1
        if (result.halt) {
          console.log(`     arrêt créé sur l'objectif #${result.halt.objective_id}`)
        }
      }
    }

    if (breached) {
      console.error(`\n  ${breached} invariant(s) franchi(s)\n`)
      process.exitCode = 2
    }
  },

  /**
   * Le veilleur. Observe les sessions Claude et Codex, ouvre et clôt les
   * tentatives tout seul. Aucun agent n'a besoin de penser à appeler.
   */
  async watch(intervalArg) {
    const interval = Number(intervalArg ?? 5) * 1000
    const idleMs = 90 * 1000

    const projects = (await call('GET', '/projects')).filter((p) => p.repo_path)
    if (!projects.length) fail('aucun projet avec repo_path')

    console.log(`\n  veilleur actif — ${projects.length} projets suivis, cycle ${interval / 1000}s`)
    for (const p of projects) console.log(`    ${p.slug}  ${p.repo_path}`)
    console.log('')

    const tracked = new Map()
    let firstPass = true

    // Codex donne le cwd en clair ; Claude ne donne qu'une forme encodée
    // ambiguë à décoder — on compare donc les encodages, jamais l'inverse.
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

        // Première rencontre d'un fichier déjà existant : on se cale à la fin.
        // Le veilleur n'enregistre que ce qui se produit après son démarrage,
        // il ne refacture pas l'historique.
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

        // Ouverture : première activité observée sur un projet suivi.
        if (!state.passageId && (read.requests > 0 || read.codexTotal !== null)) {
          const objectives = await call('GET', `/projects/${project.slug}/objectives`)
          const target = objectives
            .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
            .sort((a, b) => a.priority - b.priority)[0]

          if (!target) {
            console.log(`  ·  ${s.harness} actif sur ${project.slug} — aucun objectif prenable, non enregistré`)
            tracked.set(s.file, state)
            continue
          }

          const passage = await call('POST', `/objectives/${target.id}/passages`, {
            harness: s.harness,
            git_before: gitAt(project.repo_path, 'rev-parse', 'HEAD'),
            summary: `Session ${s.harness} observée — ${basename(s.file)}`,
          }).catch(() => null)

          if (!passage?.id) {
            tracked.set(s.file, state)
            continue
          }

          state.passageId = passage.id
          state.objectiveId = target.id
          console.log(`  →  tentative #${passage.id} ouverte — ${s.harness} sur ${project.slug} / objectif #${target.id}`)
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

      // Clôture : tâche terminée ou silence prolongé.
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

      // Le pack de règles décide, pas l'agent.
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
        `  ←  tentative #${state.passageId} close — ${halts.length ? `ARRÊT (${halts.length} règle(s))` : proven ? 'a fait avancer' : "n'a rien démontré"}  [${basename(file)}]`,
      )
    }

    await tick()
    setInterval(() => {
      tick().catch((e) => console.error('  !  cycle en erreur :', e.message))
    }, interval)
  },

  /**
   * Le relais : GPT décide, un harnais exécute, le résultat repart chez GPT.
   * Tourne jusqu'au blocage — plus de consigne, ou une garde qui refuse.
   *
   * Par défaut il n'écrit RIEN dans la conversation : `--post` requis.
   */
  async relay(...argv) {
    const opts = parseFlags(argv)
    const match = opts.gpt ?? 'chatgpt.com'
    const max = Number(opts.max ?? 5)
    const willPost = Boolean(opts.post)

    if (!config.project) fail('aucun projet : lancer le relais depuis un dépôt avec .orchestrator.json')

    const page = await attach(match).catch((e) => {
      fail(e.message)
    })

    console.log(`\n  relais branché sur ${page.url.slice(0, 80)}`)
    console.log(`  projet ${config.project} · ${max} tours max · ${willPost ? 'EXÉCUTION + ÉCRITURE ACTIVES' : 'lecture seule — rien ne sera exécuté ni posté (--post pour agir)'}\n`)

    let lastSeen = null

    for (let turn = 1; turn <= max; turn++) {
      // 1. Attendre que GPT ait fini d'écrire — on se fie au texte qui
      //    cesse de bouger, pas au libellé d'un bouton traduit.
      const message = await waitForStable(page)

      if (!message || message === lastSeen) {
        console.log(`  tour ${turn} — rien de neuf côté GPT. Arrêt.`)
        break
      }
      lastSeen = message

      // La conversation peut prononcer un verdict avant de donner la suite.
      // On vise l'objectif dont on attend le verdict quand on vient d'en
      // demander un : un verdict sur un autre objectif ne répond pas à la
      // question posée, et l'enregistrer brouille les deux.
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
            `  verdict de la conversation — #${verdict.id} ${verdict.decision === 'accept' ? 'validé' : 'refusé'}`,
          )
          // Une preuve vient d'être acceptée : le compteur d'improductivité
          // n'a plus lieu d'être. Sans ça, la boucle s'arrête pour « rien de
          // prouvé » sur le tour même où elle vient de prouver quelque chose,
          // parce que le recomptage n'arrive qu'au tour suivant.
          if (verdict.decision === 'accept') {
            depenseDepuisProgres = 0
            jetonsSansProgres = 0
            sterile = 0
            prouvesAvant = null
          }
        }
      }

      const fini = parseFini(message)
      if (fini && !parseDirective(message)) {
        console.log(
          `\n  FIN DÉCLARÉE par le juge${fini.id ? ` sur #${fini.id}` : ''}` +
            `${fini.raison ? ` — ${fini.raison}` : ''}\n`,
        )
        break
      }

      const directive = parseDirective(message)
      if (!directive) {
        console.log(`  tour ${turn} — aucune consigne @codex: / @claude: dans la réponse. Arrêt.`)
        console.log(`  dernier message : ${message.slice(0, 200)}…\n`)
        break
      }

      console.log(`  tour ${turn} — GPT → ${directive.harness}`)
      console.log(`    « ${directive.task.slice(0, 160)}${directive.task.length > 160 ? '…' : ''} »`)

      // 2. Exécuter dans le harnais désigné, sous les gardes habituelles.
      //    Sans --post, on n'exécute PAS : une sonde annoncée « lecture seule »
      //    qui lance une vraie session dépense de l'argent et, pire, entre en
      //    concurrence avec la boucle sur les mêmes ressources.
      if (!willPost) {
        console.log(`\n    ── lecture seule : rien n'a été exécuté ──`)
        console.log(`    ${directive.harness} recevrait ${directive.task.length} caractères de mission.`)
        console.log(`    Relancer avec --post pour exécuter et rendre compte.\n`)
        break
      }

      consignesFaites.add(`${directive.harness}:${directive.task.slice(0, 200)}`)
      const outcome = await runHarness(directive.harness, directive.task)

      console.log(
        `    → ${outcome.verdict}${outcome.halts.length ? ` — ${outcome.halts.length} règle(s) enfreinte(s)` : ''}`,
      )

      // 3. Rendre compte à GPT.
      const report = buildReport(turn, directive, outcome)

      if (!willPost) {
        console.log(`\n    ── ce qui serait posté ──\n${indent(report)}\n`)
      } else {
        const posted = await page.evaluate(jsPost(report)).catch(() => undefined)

        // Le retour peut se perdre si la page bouge : on constate plutôt.
        const landed = await confirmPosted(page, report)

        if (!landed) {
          console.error(`    !  publication impossible : ${posted ?? 'sans retour, et message absent'}`)
          break
        }
        console.log(`    ↑ posté chez GPT`)
      }

      if (outcome.stop) {
        console.log(`\n  BLOCAGE — ${outcome.stopReason}. Le relais s'arrête.\n`)
        break
      }

      await pause(3000)
    }

    page.close()
  },

  /**
   * Le bloc de contexte à coller dans la conversation qui pilote.
   * Dérivé de l'état réel : il ne peut pas mentir sur ce qui bloque.
   */
  /**
   * Poste l'état complet dans la conversation qui pilote. C'est le seul
   * moyen de lui transmettre les règles de forme : la boucle, elle, ne
   * poste que des comptes rendus.
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
    console.log(`\n  relais branché sur ${page.url.slice(0, 80)}`)

    if (!opts.post) {
      console.log('  lecture seule — ajouter --post pour écrire\n')
      console.log(texte)
      return
    }

    await page.evaluate(jsPost(texte))
    const ok = await confirmPosted(page, texte).catch(() => false)
    console.log(ok ? '  ↑ état posté dans la conversation\n' : '  ⚠ envoi non confirmé — vérifie la page\n')
  },

  async brief(...argv) {
    if (!config.project) fail('aucun projet dans .orchestrator.json')

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

    w(`## État Orchestrator — projet ${recall.project.name}`)
    w()

    const arretes = objectives.filter((o) => o.status === 'blocked')

    // Un arrêt absorbable n'attend personne : la boucle le lève elle-même.
    // L'annoncer comme « décision humaine » gèle un objectif prenable.
    const blocked = []
    const absorbables = []
    for (const o of arretes) {
      const full = await call('GET', `/objectives/${o.id}`)
      const ouverts = (full.halts ?? []).filter((x) => !x.resolved_at)
      ;(ouverts.some((h) => HUMAN_HALTS.includes(h.reason)) ? blocked : absorbables).push({ ...o, ouverts })
    }
    const takeable = objectives
      .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
      .sort((a, b) => a.priority - b.priority)
    const draft = objectives.filter((o) => o.status === 'draft')

    if (blocked.length) {
      w('### En attente d’une décision humaine — aucun agent ne peut passer outre')
      for (const o of blocked) {
        w(`- **#${o.id} ${o.title}** — ${BLAST_FR[o.blast_radius] ?? o.blast_radius}`)
        for (const h of o.ouverts) {
          w(`  - ${HALT_FR[h.reason] ?? h.reason} : ${(h.detail ?? '').replace(/\n/g, ' ')}`)
        }
      }
      w()
    }

    if (absorbables.length) {
      w('### Arrêtés sur un motif que la boucle lève elle-même — reste prenable')
      for (const o of absorbables) {
        w(`- **#${o.id} ${o.title}**`)
        for (const h of o.ouverts) {
          w(`  - ${HALT_FR[h.reason] ?? h.reason} : ${(h.detail ?? '').replace(/\n/g, ' ')}`)
        }
      }
      w()
    }

    if (takeable.length) {
      w('### Prenable maintenant')
      for (const o of takeable) {
        w(`- **#${o.id} ${o.title}** — ${BLAST_FR[o.blast_radius] ?? o.blast_radius}`)
        if (o.proof_spec) w(`  - preuve exigée : ${o.proof_spec}`)
      }
      w()
    }

    if (draft.length) {
      w('### Non prenable — il manque le critère de preuve')
      for (const o of draft) w(`- #${o.id} ${o.title}`)
      w()
    }

    if (recall.decisions.length) {
      w('### Contraintes déjà apprises — ne pas les redécouvrir')
      for (const d of recall.decisions) {
        w(`- **${d.title}** — ${d.body.replace(/\n/g, ' ')}`)
      }
      w()
    }

    if (config.blastRadius.length) {
      w('### Rayon de souffle — un diff qui touche ça arrête la boucle')
      w(config.blastRadius.map((g) => `\`${g}\``).join(' · '))
      w()
    }

    if (invariants.length) {
      w('### Mesures de production')
      for (const i of invariants) {
        const state =
          i.last_status === 'breached'
            ? `FRANCHI — mesuré ${trimNum(i.last_value)}`
            : i.last_status === 'ok'
              ? `ok — mesuré ${trimNum(i.last_value)}`
              : 'jamais mesuré'
        w(`- ${i.name} ${signOf(i.comparison)} ${trimNum(i.threshold)} ${i.unit ?? ''} → ${state}`)
        if (i.last_status === 'breached' && i.description) w(`  - ${i.description}`)
      }
      w()
    }

    const boite = await call('GET', '/toolbox', null, { soft: true })
    if (boite && Object.keys(boite).length) {
      w('### Les outils dont dispose l’exécutant')
      w('Nomme-les dans la mission quand elle en a besoin — sans ça, il improvise.')
      for (const [capacite, outils] of Object.entries(boite)) {
        const dispo = outils.filter((o) => o.joignable !== 'absent')
        if (!dispo.length) continue
        w(`- **${capacite}** : ${dispo.map((o) => {
          const acces = o.reach === 'api'
            ? `par API${o.env_var ? `, clé dans \`$${o.env_var}\`` : ''}`
            : o.reach === 'browser'
              ? `via le navigateur (${o.settings?.match ?? 'onglet dédié'})`
              : 'en local'
          return `${o.label} — ${acces}`
        }).join(' · ')}`)
        const premier = dispo[0]
        if (premier.settings?.note) w(`  - à savoir : ${premier.settings.note}`)
      }
      w()
    }

    w('### Comment répondre')
    w('Réponds comme tu l’as toujours fait : verdict motivé, lecture visuelle, mode de')
    w('travail, puis la mission complète. Ne raccourcis rien — ce n’est pas un canal de')
    w('chat, c’est un ordre de production.')
    w()
    w('**Trois marqueurs, chacun seul sur sa ligne.** Ils ne sont pas de la décoration :')
    w('un outil lit ta réponse et n’a pas le droit de deviner. Une phrase comme « le')
    w('chapitre est terminé » ou « tout semble satisfait » ne se distingue pas d’un')
    w('commentaire, et la boucle tourne à vide.')
    w()
    w('```')
    w('@verdict: #14 validé          ← ou « refusé ». Ton jugement, sans ambiguïté.')
    w('@fini: #11 raison             ← seulement s’il n’y a plus rien à produire.')
    w('@claude:                      ← ou @codex:, suivi de la mission complète.')
    w('```')
    w()
    w('Pose `@verdict` dès que tu juges quelque chose, **avant** tes explications.')
    w('Pose `@fini` uniquement quand tu ne donnes aucune mission derrière.')
    w()
    w('```')
    w('@claude:')
    w('<la mission complète — autant de lignes, de sections et de séparateurs qu’il')
    w(' faut : lectures obligatoires, hiérarchie documentaire, interdictions,')
    w(' objectif, composition, format de boucle, barème, gate, livrables. Tout ce')
    w(' qui suit le marqueur est transmis mot pour mot au harnais, et rien d’autre')
    w(' ne lui parvient : ce qui n’est pas dans ce bloc n’existe pas pour lui.>')
    w('```')
    w()
    w('`@codex:` pour l’autre harnais. Cite le numéro d’objectif visé (`#12`) dans la')
    w('mission — c’est ce qui la rattache au bon objectif.')
    w()
    w('Sans marqueur, la boucle s’arrête — c’est voulu.')
    w('Une consigne qui vise un objectif bloqué ou sans critère de preuve sera refusée par l’outil.')

    console.log(out.join('\n'))
  },

  /**
   * Exécute une consigne dans un harnais, encadrée par une tentative et
   * les gardes, et rend le compte rendu prêt à coller dans la conversation
   * qui pilote. C'est l'étape 3 de la boucle, sans navigateur.
   */
  async do(harness, ...rest) {
    if (!['codex', 'claude'].includes(harness)) {
      fail('usage: orchestrator do <codex|claude> [--probe] "<consigne>"')
    }

    // Une sonde de diagnostic n'est pas une tentative : elle ne s'attache
    // à aucun objectif et ne compte dans aucun garde-fou.
    const probe = rest.includes('--probe')
    const task = rest.filter((a) => a !== '--probe').join(' ').trim()
    if (!task) fail('consigne vide')

    if (probe) {
      console.log(`\n  ${harness} — sonde (hors objectif)\n`)
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

    console.log(`\n  ${harness} — consigne reçue`)
    console.log(`  « ${task.slice(0, 200)}${task.length > 200 ? '…' : ''} »\n`)

    const outcome = await runHarness(harness, task)

    console.log(`  verdict : ${outcome.verdict}`)
    if (outcome.stopReason) console.log(`  ARRÊT : ${outcome.stopReason}`)
    console.log('')
    console.log('  ── compte rendu à coller dans la conversation ──')
    console.log('')
    console.log(buildReport(1, { harness, task }, outcome))
    console.log('')

    if (outcome.stop) process.exitCode = 2
  },

  /**
   * Projette les autorisations décidées dans l'outil vers la configuration
   * du harnais. La décision se prend une fois, elle s'applique partout.
   */
  async 'permissions:sync'(harness = 'claude') {
    if (!config.project) fail('aucun projet dans .orchestrator.json')

    const eff = await call('GET', `/projects/${config.project}/permissions/effective/${harness}`)
    const file = resolve(process.cwd(), '.claude/settings.json')

    if (harness !== 'claude') {
      console.log(`projection ${harness} : pas encore implémentée`)
      return
    }

    let settings = {}
    if (existsSync(file)) {
      try {
        settings = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        fail(`${file} est illisible — je ne l'écrase pas`)
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

    console.log(`  ${eff.allow.length} autorisés · ${eff.deny.length} refusés · ${eff.ask.length} à trancher`)
    console.log(`  écrit dans ${relative(process.cwd(), file)}`)
  },

  /** Remonte dans l'outil les outils qu'une session s'est vu refuser. */
  async 'permissions:collect'(transcriptArg) {
    if (!config.project) fail('aucun projet dans .orchestrator.json')

    const dir = config.transcripts ?? defaultTranscriptDir()
    const file =
      transcriptArg ??
      (existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => resolve(dir, f))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
        : null)

    if (!file || !existsSync(file)) return console.log('aucun transcript à dépouiller')

    const found = new Set()
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('permission')) continue
      const m = line.match(/requested permissions to use ([A-Za-z0-9_()*.\- ]+?)(?:,|\\n|")/)
      if (m) found.add(m[1].trim())
    }

    if (!found.size) return console.log('aucun refus de permission dans ce transcript')

    const res = await call('POST', `/projects/${config.project}/permissions/requested`, {
      patterns: [...found],
      harness: 'claude',
    })

    console.log(`  ${res.length} outil(s) remontés :`)
    for (const p of res) console.log(`    ${p.decision === 'ask' ? 'À TRANCHER' : p.decision}  ${p.pattern}`)
  },

  /**
   * Ferme un chapitre : tourne jusqu'à ce que l'objectif parent soit prouvé,
   * en absorbant les problèmes que la boucle sait traiter et en ne s'arrêtant
   * QUE sur ce qui réclame vraiment une décision humaine.
   */
  /**
   * Découpe un brief libre en chapitre + étapes prouvables. L'agent local fait
   * l'appel — le serveur ne lance jamais rien lui-même — et rend une
   * PROPOSITION : c'est l'humain qui l'applique depuis l'écran, ou pas.
   *
   * usage : orchestrator plan [--watch] [--every 8]
   */
  async plan(...argv) {
    const opts = parseFlags(argv)
    if (!config.project) fail('aucun projet : lancer depuis un dépôt avec .orchestrator.json')

    const boucle = Boolean(opts.watch)
    const pause_s = Number(opts.every ?? 8) * 1000

    console.log(
      `\n  découpage de briefs — projet ${config.project}` +
        (boucle ? ` · en veille, vérifie toutes les ${pause_s / 1000} s` : ' · une passe') +
        '\n',
    )

    do {
      const pris = await call('POST', `/projects/${config.project}/briefs/claim`, { harness: 'claude' }, { soft: true })
      const brief = pris?.brief

      if (!brief) {
        if (!boucle) {
          console.log('  aucun brief en attente.\n')
          return
        }
        await pause(pause_s)
        continue
      }

      console.log(`  brief #${brief.id} — ${brief.body.length} caractères`)

      // Le découpage doit connaître les contraintes déjà tranchées, sinon il
      // propose des critères que le projet a déjà écartés.
      const recall = await call('GET', `/projects/${config.project}/recall`, null, { soft: true })
      const contraintes = (recall?.decisions ?? [])
        .slice(0, 8)
        .map((d) => `- ${d.title} : ${String(d.body).slice(0, 240)}`)
        .join('\n')
      const preuves = Object.entries(config.proofs ?? {})
        .map(([k, v]) => `- ${k} : ${v}`)
        .join('\n')

      const consigne = [
        "Découpe la demande ci-dessous en UN chapitre et ses étapes d'exécution.",
        '',
        "Règles de découpage :",
        "- chaque étape doit être achevable en une seule session d'agent ;",
        "- chaque étape porte un critère de preuve VÉRIFIABLE, écrit comme une condition, pas comme une intention. Une commande qui passe, un nombre qui franchit un seuil, une capture qui montre quelque chose de nommé. Jamais « c'est propre » ni « ça marche mieux » ;",
        "- les étapes sont dans l'ordre où elles doivent être exécutées ;",
        "- entre 2 et 12 étapes. Si la demande n'en justifie qu'une, n'en invente pas ;",
        "- blast_radius : cosmetic (visuel), feature (fonction visible), api (données ou interface partagée), critical (argent, paie, production).",
        preuves ? `\nCommandes de preuve déclarées par ce projet — réutilise-les telles quelles quand elles conviennent :\n${preuves}` : '',
        contraintes ? `\nContraintes déjà tranchées sur ce projet — ne les contredis pas :\n${contraintes}` : '',
        '',
        '--- LA DEMANDE ---',
        brief.body,
        '--- FIN ---',
        '',
        'Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans bloc de code :',
        '{"chapter":"…","intent":"…","steps":[{"title":"…","proof_spec":"…","blast_radius":"feature"}]}',
      ]
        .filter(Boolean)
        .join('\n')

      let brut = ''
      try {
        // Découper n'exige aucun outil : on refuse tout accès au dépôt pour
        // que la passe reste courte, bon marché et sans effet de bord.
        brut = execFileSync(
          'claude',
          ['-p', consigne, '--disallowed-tools', 'Bash', 'Write', 'Edit', 'NotebookEdit'],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            // Les secrets des services tiers vivent sur CETTE machine et n'entrent
      // dans le processus que le temps de la session. Le serveur ne les a
      // jamais eus : il ne connaît que le NOM de la variable attendue.
      env: { ...process.env, ...(config.secrets ?? {}), ...config.env, ORCHESTRATOR_MANAGED: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      } catch (e) {
        console.error(`    échec du harnais : ${e.message}`)
        await call('PATCH', `/briefs/${brief.id}/propose`, { error: e.message.slice(0, 900) }, { soft: true })
        continue
      }

      const proposition = extraireJson(brut)

      if (!proposition?.chapter || !Array.isArray(proposition.steps) || !proposition.steps.length) {
        console.error("    réponse inexploitable : pas de découpage JSON lisible")
        await call(
          'PATCH',
          `/briefs/${brief.id}/propose`,
          { error: `Réponse inexploitable du harnais.\n\n${brut.slice(0, 900)}` },
          { soft: true },
        )
        continue
      }

      const r = await call('PATCH', `/briefs/${brief.id}/propose`, { proposal: proposition }, { soft: true })
      console.log(
        r
          ? `    → ${proposition.steps.length} étape(s) proposée(s) · « ${proposition.chapter} »`
          : `    → le serveur a refusé la proposition`,
      )
      const sans = proposition.steps.filter((e) => !e.proof_spec).length
      if (sans) console.log(`    ${sans} étape(s) sans critère de preuve — elles resteront à préciser.`)
    } while (boucle)
  },

  /**
   * Constate ce qui est réellement joignable DEPUIS CETTE MACHINE et le
   * remonte. La joignabilité ne se coche pas dans un formulaire : un binaire
   * absent ou un Chrome fermé ne se déclarent pas, ils se constatent.
   *
   * usage : orchestrator agents:check
   */
  async 'agents:check'() {
    const agents = await call('GET', '/agents')
    const machine = hostname()
    const resultats = []

    for (const a of agents) {
      let status = 'unknown'
      let detail = null

      if (!a.enabled) {
        status = 'unknown'
        detail = 'désactivé — non vérifié'
      } else if (a.reach === 'cli') {
        // On ne cherche QUE des binaires que cette machine déclare connaître.
        // Sonder au nom de l'agent trouvait n'importe quoi : « gpt » résolvait
        // vers /usr/sbin/gpt, l'outil de partitionnement de macOS, et l'écran
        // annonçait fièrement un harnais joignable qui n'existe pas.
        const connus = { ...(config.binaries ?? {}), claude: harnessBin('claude'), codex: harnessBin('codex') }
        const bin = connus[a.name]

        if (!bin) {
          status = 'unknown'
          detail = `aucun binaire déclaré pour « ${a.name} » — ajoute-le dans binaries de .orchestrator.json`
        } else {
          try {
            const chemin = execFileSync(
              '/bin/sh',
              ['-c', `command -v ${JSON.stringify(bin)} 2>/dev/null || { test -x ${JSON.stringify(bin)} && echo ${JSON.stringify(bin)}; }`],
              { encoding: 'utf8' },
            ).trim()
            if (chemin) {
              status = 'ok'
              detail = chemin.split('\n')[0].slice(0, 200)
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
          const onglets = await res.json()
          const cible = onglets.find((t) => t.type === 'page' && String(t.url).includes(match))
          if (cible) {
            status = 'ok'
            detail = String(cible.url).slice(0, 200)
          } else {
            status = 'refused'
            detail = `navigateur joignable sur ${port}, mais aucun onglet ${match}`
          }
        } catch {
          status = 'absent'
          detail = `aucun navigateur en écoute sur le port ${port}`
        }
      } else if (a.reach === 'api') {
        // Une clé vit côté serveur : cette machine ne peut rien en dire.
        status = a.has_key ? 'unknown' : 'absent'
        detail = a.has_key ? 'clé posée — vérifiable seulement côté serveur' : 'aucune clé posée'
      }

      resultats.push({ name: a.name, status, detail })
      const marque = { ok: '●', absent: '○', refused: '◐', unknown: '·' }[status]
      console.log(`  ${marque} ${a.label.padEnd(32)} ${status.padEnd(8)} ${detail ?? ''}`)
    }

    await call('POST', '/agents/checkin', { machine, resultats }, { soft: true })
    console.log(`\n  relevé transmis depuis ${machine}\n`)
  },

  /**
   * Génère une image par une interface web et la pose sur le disque.
   * usage : orchestrator image "<prompt>" [--outil nano-banana] [--out chemin.png]
   */
  async image(...argv) {
    const opts = parseFlags(argv)
    const prompt = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.replace('--', '') !== 'outil' && argv[argv.indexOf(a) - 1]?.replace('--', '') !== 'out').join(' ').trim()

    if (!prompt) {
      console.log(`usage: orchestrator image "<prompt>" [--outil ${Object.keys(ADAPTATEURS).join('|')}] [--out fichier.png]`)
      return
    }

    const outil = opts.outil ?? 'nano-banana'
    console.log(`\n  ${ADAPTATEURS[outil]?.label ?? outil} — demande envoyée, j'attends l'image…\n`)

    try {
      const r = await genererImage({ outil, prompt, sortie: opts.out })
      console.log(`  ✔ ${r.chemin} — ${r.largeur}×${r.hauteur}, ${(r.octets / 1024).toFixed(0)} ko\n`)
    } catch (e) {
      console.error(`  ✖ ${e.message}\n`)
      process.exitCode = 1
    }
  },

  /**
   * Relève et distille les mémoires d'IA de la machine, projet par projet.
   * L'inventaire est gratuit et s'affiche avant tout envoi ; la distillation
   * ne part qu'ensuite, et rend une PROPOSITION que l'humain applique ou non.
   *
   * usage : orchestrator memory:scan [--watch] [--depots a,b] [--analyser]
   */
  async 'memory:scan'(...argv) {
    const opts = parseFlags(argv)
    const boucle = Boolean(opts.watch)

    const depots = (opts.depots ? String(opts.depots).split(',') : [])
      .map((d) => resolve(d.trim()))
      .filter(Boolean)

    // Sans dépôts nommés, on prend ceux que l'outil suit déjà : eux au moins
    // sont déclarés quelque part, on ne part pas fouiller le disque.
    if (!depots.length) {
      const projets = await call('GET', '/projects', null, { soft: true })
      for (const p of projets ?? []) if (p.repo_path) depots.push(p.repo_path)
    }

    do {
      const pris = boucle
        ? (await call('POST', '/scans/claim', { machine: hostname() }, { soft: true }))?.scan
        : { id: null }

      if (boucle && !pris) {
        await pause(Number(opts.every ?? 8) * 1000)
        continue
      }

      console.log(`\n  relevé des mémoires — ${depots.length} dépôt(s) déclaré(s)\n`)
      const inv = inventorier(depots)

      console.log(`  ${inv.total} fichier(s) · ${(inv.octets / 1024).toFixed(0)} ko`)
      for (const [projet, p] of Object.entries(inv.projets)) {
        console.log(`    ${projet.padEnd(26)} ${String(p.nombre).padStart(4)} fichiers · ${(p.octets / 1024).toFixed(0)} ko`)
      }

      if (pris?.id) {
        await call(
          'PATCH',
          `/scans/${pris.id}`,
          { inventory: inv, status: 'inventoried', fingerprint: empreinte(inv) },
          { soft: true },
        )
      }

      if (!opts.analyser) {
        console.log(`\n  inventaire seul. Relance avec --analyser pour distiller (un appel de modèle par projet).\n`)
        if (!boucle) return
        continue
      }

      const resultats = {}

      for (const [projet, p] of Object.entries(inv.projets)) {
        if (projet === 'inconnu' || p.nombre < 2) continue

        const { corps, pris: lus, laisses, octets } = assembler(p.fichiers)
        console.log(
          `\n  ${projet} — ${lus.length} fichier(s) lus, ${(octets / 1024).toFixed(0)} ko` +
            (laisses.length ? ` · ${laisses.length} laissé(s) de côté, trop volumineux` : ''),
        )

        let brut
        try {
          brut = execFileSync(
            'claude',
            ['-p', consigne(projet, corps), '--disallowed-tools', 'Bash', 'Write', 'Edit'],
            { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ORCHESTRATOR_MANAGED: '1' } },
          )
        } catch (e) {
          console.error(`    échec : ${String(e.message).slice(0, 160)}`)
          resultats[projet] = { erreur: String(e.message).slice(0, 400), sources: lus, laisses }
          continue
        }

        const distille = extraireJson(brut)
        if (!Array.isArray(distille?.projets) || !distille.projets.length) {
          console.error(`    réponse inexploitable`)
          resultats[projet] = { erreur: 'réponse inexploitable', sources: lus, laisses }
          continue
        }

        // Une racine partagée rend plusieurs projets : on les range séparément
        // plutôt que d'écraser l'un par l'autre.
        for (const sous of distille.projets) {
          const cle = sous.nom?.trim() || projet
          // Les listes de chemins se répètent pour chaque sous-projet d'une même
          // racine : 594 chemins × 10 projets ont fait sauter l'envoi. On garde
          // les comptes, qui sont ce qu'on affiche, et un échantillon lisible.
          resultats[cle] = {
            ...sous,
            releve_sous: projet,
            sources_nombre: lus.length,
            sources: lus.slice(0, 30),
            laisses_nombre: laisses.length,
          }
          console.log(
            `    → ${cle} : ${(sous.contraintes ?? []).length} contrainte(s)` +
              `${(sous.contradictions ?? []).length ? `, ${sous.contradictions.length} contradiction(s)` : ''}` +
              `${(sous.perime ?? []).length ? `, ${sous.perime.length} périmé(s)` : ''}`,
          )
        }
      }

      // La distillation coûte de l'argent : elle est écrite sur disque AVANT
      // d'être envoyée. Un échec de transport ne doit jamais effacer un travail
      // déjà payé — c'est arrivé, et il a fallu tout refaire.
      const secours = join(homedir(), '.orchestrator', `memoires-${Date.now()}.json`)
      mkdirSync(dirname(secours), { recursive: true })
      writeFileSync(secours, JSON.stringify({ inventaire: inv, resultats }, null, 2))

      let envoye = false
      if (pris?.id) {
        envoye = Boolean(
          await call('PATCH', `/scans/${pris.id}`, { result: resultats, status: 'analysed' }, { soft: true }),
        )
      }

      console.log(`\n  ${Object.keys(resultats).length} projet(s) distillé(s)`)
      console.log(envoye ? `  → visibles dans la vue d'ensemble.` : `  → l'envoi a échoué, tout est dans ${secours}`)
      console.log()
    } while (boucle)
  },

  /**
   * Veille sur les mémoires : compare leur état à l'empreinte du dernier
   * relevé et le signale quand elles ont bougé. Un relevé qui vieillit sans
   * le dire est pire qu'aucun relevé — on croit lire l'état du moment.
   *
   * usage : orchestrator memory:watch [--every 300]
   */
  async 'memory:watch'(...argv) {
    const opts = parseFlags(argv)
    const pause_s = Number(opts.every ?? 300) * 1000

    const projets = await call('GET', '/projects', null, { soft: true })
    const depots = (projets ?? []).map((p) => p.repo_path).filter(Boolean)

    console.log(`\n  veille sur les mémoires — ${depots.length} dépôt(s), toutes les ${pause_s / 1000} s\n`)

    let dernierSignale = null

    for (;;) {
      const scans = await call('GET', '/scans', null, { soft: true })
      const dernier = (scans ?? []).find((s) => s.fingerprint)

      if (!dernier) {
        console.log(`  aucun relevé avec empreinte — lance d'abord « orchestrator memory:scan »`)
        if (!opts.every) return
        await pause(pause_s)
        continue
      }

      const actuelle = empreinte(inventorier(depots))
      const bouge = actuelle !== dernier.fingerprint

      await call(
        'PATCH',
        `/scans/${dernier.id}`,
        { fingerprint_seen: actuelle, seen_at: new Date().toISOString() },
        { soft: true },
      )

      if (bouge && actuelle !== dernierSignale) {
        dernierSignale = actuelle
        console.log(`  ${new Date().toLocaleTimeString('fr-FR')} — les mémoires ont changé depuis le relevé #${dernier.id}`)
      } else if (!bouge) {
        dernierSignale = null
      }

      if (!opts.every) return
      await pause(pause_s)
    }
  },

  async chapter(...argv) {
    // Dans une boucle, un refus du gate est une information à traiter, pas une
    // raison de mourir : c'est même exactement ce qu'on cherche à produire.
    process.env.ORCHESTRATOR_BOUCLE = '1'
    const opts = parseFlags(argv)
    const chapterId = Number(opts.objective ?? opts.chapter)
    if (!chapterId) fail('usage: orchestrator chapter --objective <id> [--budget 60] [--max-turns 12] [--post]')

    let budget = Number(opts.budget ?? 0)
    let maxTurns = Number(opts['max-turns'] ?? 12)
    // Le vrai garde-fou : ce qu'on tolère de dépenser SANS qu'un objectif
    // avance. Ni les dollars ni le nombre de tours ne mesurent l'avancement ;
    // celui-ci le fait. Un tour cher qui prouve un objectif est bon marché.
    let budgetSansProgres = Number(opts['budget-sans-progres'] ?? 40)

    // Le workflow déclaré prime sur mes valeurs par défaut : c'est lui qui
    // dit ce qui arrête, ce qu'on absorbe, et jusqu'où on va. Les options en
    // ligne de commande restent prioritaires — elles sont explicites.
    const workflows = await call('GET', `/projects/${config.project}/workflows`, null, { soft: true })
    const wf = (workflows ?? []).find((w) => w.active && (!opts.workflow || w.name === opts.workflow))

    let stopReasons = HUMAN_HALTS
    let toursSteriles = 3

    if (wf) {
      stopReasons = wf.stop_when?.halts ?? HUMAN_HALTS
      toursSteriles = wf.stop_when?.tours_steriles ?? 3
      if (!opts.budget && wf.stop_when?.budget) budget = Number(wf.stop_when.budget)
      if (!opts['budget-sans-progres'] && wf.stop_when?.budget_sans_progres) {
        budgetSansProgres = Number(wf.stop_when.budget_sans_progres)
      }
      if (!opts['max-turns'] && wf.stop_when?.max_turns) maxTurns = Number(wf.stop_when.max_turns)

      console.log(`\n  workflow « ${wf.name} »`)
      for (const [i, e] of (wf.steps ?? []).entries()) {
        console.log(`    ${i + 1}. ${e.label ?? e.do}`)
      }
      console.log(`    s'arrête sur : ${stopReasons.join(', ')}`)
      console.log(`    absorbe      : ${(wf.absorb ?? []).join(', ') || '—'}`)
    }
    const willPost = Boolean(opts.post)

    // La conversation qui pilote est déclarée par le projet, plus figée dans
    // le code : un chantier peut avoir son propre fil, et le juge peut être
    // une autre IA que ChatGPT.
    const projet = (await call('GET', '/projects', null, { soft: true }))?.find(
      (p) => p.slug === config.project,
    )
    const match = opts.gpt ?? projet?.judge_url ?? 'chatgpt.com'
    if (projet?.judge_url) {
      console.log(`  juge : ${projet.judge_agent ?? 'gpt'} — ${projet.judge_url.slice(0, 72)}`)
    }

    if (!config.project) fail('aucun projet : lancer depuis un dépôt avec .orchestrator.json')

    const page = await attach(match).catch((e) => fail(e.message))

    console.log(
      `\n  chapitre #${chapterId} · ${maxTurns} tours max${budget ? ` · budget $${budget}` : ' · budget libre'}` +
        ` · arrêt à $${budgetSansProgres} sans progrès · ${willPost ? 'EXÉCUTION ACTIVE' : 'lecture seule — rien ne sera exécuté'}\n`,
    )

    let lastSeen = null
    let spent = 0
    let consecutiveEmpty = 0
    let sterile = 0
    let depenseDepuisProgres = 0
    let jetonsSansProgres = 0
    // 60 M de jetons sans preuve : l'ordre de grandeur d'une passe Claude
    // coûteuse, donc une borne qui laisse travailler sans laisser dériver.
    const plafondJetons = Number(opts['plafond-jetons'] ?? 60_000_000)
    let prouvesAvant = null
    let demandeFaite = false
    const consignesFaites = new Set()

    for (let turn = 1; turn <= maxTurns; turn++) {
      // 1. Le chapitre est-il clos ?
      const chapter = await call('GET', `/objectives/${chapterId}`)

      // Un objectif prouvé depuis le dernier tour : le compteur repart.
      const prouves = (chapter.children ?? []).filter((c) => c.status === 'proven').length
      if (prouvesAvant !== null && prouves > prouvesAvant) {
        console.log(`  (+${prouves - prouvesAvant} objectif(s) prouvé(s) — compteur d'improductivité remis à zéro)`)
        depenseDepuisProgres = 0
        sterile = 0
        jetonsSansProgres = 0
      }
      prouvesAvant = prouves

      if (chapter.status === 'proven') {
        console.log(`\n  CHAPITRE CLOS — #${chapterId} est prouvé.\n`)
        break
      }

      // Tout le travail est fait mais le verdict revient à l'humain : la
      // boucle a terminé sa part. Continuer serait tourner à vide.
      const enfants = chapter.children ?? []
      const restants = enfants.filter((c) => !['proven', 'abandoned'].includes(c.status))

      if (enfants.length && !restants.length) {
        const juge = projet?.gate_judge ?? 'gpt'
        const gate = chapter.gate ?? {}

        // Toutes les parties prouvées ne veut pas dire que le chapitre a
        // franchi SON gate : il a son propre critère. Si le gate réclame du
        // travail, demander un verdict ferait tourner la boucle en rond —
        // le juge valide, le gate refuse, on recommence.
        if (!gate.ok && !gate.ready && willPost && !demandeFaite) {
          demandeFaite = true
          console.log(`\n  Les ${enfants.length} sous-objectifs sont prouvés, mais le chapitre ne conclut pas :`)
          console.log(`  ${gate.detail ?? gate.reason}\n`)

          await page
            .evaluate(
              jsPost(
                `Les ${enfants.length} sous-objectifs du chapitre **#${chapterId} ${chapter.title}** sont prouvés, ` +
                  `mais le chapitre lui-même ne peut pas conclure :\n\n> ${gate.detail ?? gate.reason}\n\n` +
                  `Ce qui devait être vrai pour le conclure :\n> ${chapter.proof_spec ?? '(non énoncé)'}\n\n` +
                  `Ce n'est donc pas un verdict qu'il faut, c'est **du travail sur le chapitre lui-même**. ` +
                  `Donne la mission qui le rendra concluable, comme d'habitude.`,
              ),
            )
            .catch(() => {})

          // On NE saute PAS la suite du tour : c'est elle qui lit la réponse
          // et exécute la mission. Un `continue` ici reposait la question sans
          // jamais écouter — la boucle se parlait à elle-même.
          await pause(5000)
        }

        // Le chapitre a besoin de travail : on laisse le tour se dérouler
        // normalement plutôt que de conclure ou de rendre la main.
        if (!gate.ok && !gate.ready) {
          // rien : on tombe dans la lecture du message, plus bas
        } else {

        // Renvoyer la main à l'humain quand le juge du projet est la
        // conversation n'a aucun sens : la boucle sait à qui demander, et
        // s'arrêter là laissait un chapitre fini traîner des jours.
        if (juge !== 'human' && willPost) {
          console.log(`\n  TRAVAIL TERMINÉ — les ${enfants.length} sous-objectifs sont prouvés.`)
          console.log(`  Je vais chercher le verdict du chapitre auprès du juge.\n`)

          const preuves = (chapter.evidences ?? []).length
          await page
            .evaluate(
              jsPost(
                `Les ${enfants.length} sous-objectifs du chapitre **#${chapterId} ${chapter.title}** sont tous prouvés :\n` +
                  enfants.map((e) => `- #${e.id} ${e.title}`).join('\n') +
                  `\n\nCe qui devait être vrai pour conclure le chapitre :\n> ${chapter.proof_spec ?? '(non énoncé)'}` +
                  `\n\n${preuves} preuve(s) sont rattachées au chapitre lui-même.` +
                  `\n\n**Prononce le verdict du CHAPITRE**, pas de ses étapes : écris « #${chapterId} est validé » ou « #${chapterId} refusé ».` +
                  ` S'il est refusé, donne la mission de reprise comme d'habitude.`,
              ),
            )
            .catch(() => {})

          // On attend son verdict comme n'importe quel autre : c'est la même
          // boucle, pas un cas particulier.
          const reponse = await waitForStable(page)
          const v = reponse ? parseVerdict(reponse) : null

          if (v && Number(v.id) === Number(chapterId)) {
            const r = await call('POST', `/objectives/${chapterId}/verdict/${v.decision}/gpt`, null, { soft: true })
            console.log(
              `  verdict du chapitre — #${chapterId} ${v.decision === 'accept' ? 'validé' : 'refusé'}` +
                (r?.status === 'proven' ? ' · CHAPITRE CLOS' : ''),
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

        console.log(`\n  TRAVAIL TERMINÉ — les ${enfants.length} sous-objectifs sont prouvés.`)
        console.log(`  Le verdict du chapitre revient à toi : ce projet exige un juge humain.\n`)
        break
        }
      }

      const humanHalt = (chapter.halts ?? []).find(
        (h) => !h.resolved_at && stopReasons.includes(h.reason),
      )
      if (humanHalt) {
        console.log(`\n  ARRÊT — ${humanHalt.reason} sur le chapitre. Une décision humaine est requise.`)
        console.log(`  ${humanHalt.detail}\n`)
        break
      }

      // 2. Ce que dit GPT.
      const message = await waitForStable(page)

      // Un message INCHANGÉ n'est pas un silence : il peut porter une mission
      // qu'on n'a jamais exécutée. Atlas s'est arrêté sur « GPT ne répond
      // plus » alors que sa dernière réponse contenait la mission de
      // consolidation, simplement parce qu'elle avait déjà été LUE. Ce qui
      // compte n'est pas si le texte a changé, c'est si sa consigne a été
      // honorée.
      const consigneVue = message ? parseDirective(message) : null
      const empreinte = consigneVue ? `${consigneVue.harness}:${consigneVue.task.slice(0, 200)}` : null
      const dejaFaite = empreinte ? consignesFaites.has(empreinte) : false

      if (!message || (message === lastSeen && (!empreinte || dejaFaite))) {
        consecutiveEmpty += 1
        if (consecutiveEmpty >= 2) {
          console.log(
            `\n  ARRÊT — ${
              dejaFaite
                ? 'la conversation répète une consigne déjà exécutée sans en donner de nouvelle.'
                : 'GPT ne répond plus après deux attentes.'
            }\n`,
          )
          break
        }
        console.log(`  tour ${turn} — rien de neuf, nouvelle attente`)
        await pause(8000)
        continue
      }

      if (message === lastSeen && empreinte && !dejaFaite) {
        console.log(`  tour ${turn} — même message, mais sa consigne n'a jamais été exécutée`)
      }

      consecutiveEmpty = 0
      lastSeen = message

      // La conversation peut prononcer un verdict avant de donner la suite.
      // On vise l'objectif dont on attend le verdict quand on vient d'en
      // demander un : un verdict sur un autre objectif ne répond pas à la
      // question posée, et l'enregistrer brouille les deux.
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
            `  verdict de la conversation — #${verdict.id} ${verdict.decision === 'accept' ? 'validé' : 'refusé'}`,
          )
          // Une preuve vient d'être acceptée : le compteur d'improductivité
          // n'a plus lieu d'être. Sans ça, la boucle s'arrête pour « rien de
          // prouvé » sur le tour même où elle vient de prouver quelque chose,
          // parce que le recomptage n'arrive qu'au tour suivant.
          if (verdict.decision === 'accept') {
            depenseDepuisProgres = 0
            jetonsSansProgres = 0
            sterile = 0
            prouvesAvant = null
          }
        }
      }

      const fini = parseFini(message)
      if (fini && !parseDirective(message)) {
        console.log(
          `\n  FIN DÉCLARÉE par le juge${fini.id ? ` sur #${fini.id}` : ''}` +
            `${fini.raison ? ` — ${fini.raison}` : ''}\n`,
        )
        break
      }

      const directive = parseDirective(message)
      if (!directive) {
        console.log(`  tour ${turn} — aucune consigne dans la réponse. Je redemande.`)
        if (willPost) {
          await page.evaluate(
            jsPost(
              'Pas de consigne exploitable dans ta réponse. Termine par `@claude:` ou `@codex:` seul sur sa ligne, suivi de la mission complète citant le numéro d’objectif visé — tout ce qui suit ce marqueur est transmis mot pour mot au harnais. Ou dis explicitement que le chapitre est terminé.',
            ),
          )
        }
        await pause(5000)
        continue
      }

      // Un tour coûte de l'ordre de $15-25 : si le reste du budget ne peut
      // pas l'absorber, mieux vaut s'arrêter que de le couper en plein vol.
      // Sans tarif connu pour un harnais, le budget en dollars ne le voit pas :
      // sur Blockrise, tout le travail utile venait de Codex et le garde-fou
      // n'aurait jamais déclenché. On borne alors sur les JETONS, qui sont
      // toujours mesurables. Un chiffre inventé serait pire ; pas de garde-fou
      // du tout aussi.
      if (jetonsSansProgres >= plafondJetons) {
        console.log(
          `\n  ARRÊT — ${(jetonsSansProgres / 1e6).toFixed(1)} M de jetons consommés sans qu'un objectif soit prouvé.` +
            `\n  Le coût en dollars n'est pas mesurable pour ce harnais ; la borne porte donc sur les jetons.\n`,
        )
        break
      }

      if (depenseDepuisProgres >= budgetSansProgres) {
        console.log(
          `\n  ARRÊT — $${depenseDepuisProgres.toFixed(2)} dépensés sans qu'un seul objectif soit prouvé.\n  Ce n'est plus une question de moyens : l'approche ne converge pas.\n`,
        )
        if (willPost) {
          await page
            .evaluate(
              jsPost(
                `$${depenseDepuisProgres.toFixed(2)} dépensés sans qu'aucun objectif ne soit prouvé. La boucle s'arrête : ce n'est pas un manque de budget, c'est que l'approche ne converge pas. Il faut revoir la méthode, le critère de preuve, ou découper autrement.`,
              ),
            )
            .catch(() => {})
        }
        break
      }

      const reste = budget ? budget - spent : Infinity
      if (budget && reste < 15) {
        console.log(`\n  ARRÊT — il reste $${reste.toFixed(2)}, insuffisant pour un tour. Dépensé $${spent.toFixed(2)}.\n`)
        if (willPost) {
          await page
            .evaluate(
              jsPost(
                `Budget presque épuisé : $${spent.toFixed(2)} dépensés sur $${budget}. Il ne reste pas de quoi mener un tour complet, la boucle s'arrête ici plutôt que d'interrompre une session en plein travail.`,
              ),
            )
            .catch(() => {})
        }
        break
      }

      console.log(`  tour ${turn} — ${directive.harness}${budget ? ` · reste $${reste.toFixed(2)}` : ''}`)

      // 3. Exécuter — jamais sans --post, même défaut que le relais : un mode
      //    annoncé « lecture seule » ne doit lancer aucune session réelle.
      if (!willPost) {
        console.log(`\n  lecture seule — rien n'a été exécuté.`)
        console.log(`  ${directive.harness} recevrait ${directive.task.length} caractères de mission sur #${(directive.task.match(/#(\d+)/) ?? [])[1] ?? '?'}.`)
        console.log(`  Relancer avec --post pour exécuter.\n`)
        break
      }

      consignesFaites.add(`${directive.harness}:${directive.task.slice(0, 200)}`)
      const outcome = await runHarness(directive.harness, directive.task)
      const passage = outcome.passageId
        ? await call('GET', `/passages/${outcome.passageId}`).catch(() => null)
        : null
      const coutTour = Number(passage?.cost_usd ?? 0)
      spent += coutTour
      depenseDepuisProgres += coutTour
      jetonsSansProgres += Number(passage?.tokens ?? 0)

      console.log(
        `    → ${outcome.verdict}${outcome.denied?.length ? ` · ${outcome.denied.length} outil(s) refusés` : ''} · cumulé $${spent.toFixed(2)}`,
      )

      // Absorber un piétinement est utile une fois ou deux — GPT change
      // d'angle. Au-delà, insister coûte sans rien apporter : c'est le
      // moment de changer d'approche, pas de recommencer.
      // Plafond d'usage atteint : ce n'est pas un echec de la tache, c'est
      // une attente. On dort jusqu'a la reprise plutot que de bruler des tours.
      if (outcome.limitReset) {
        const attente = outcome.limitReset - Date.now()
        const minutes = Math.ceil(attente / 60000)

        if (attente > 0 && attente < 6 * 3600 * 1000) {
          console.log(`\n  PLAFOND D'USAGE — reprise dans ${minutes} min. La boucle attend.\n`)
          if (willPost) {
            await page
              .evaluate(
                jsPost(
                  `Plafond d'usage atteint sur le harnais. Ce n'est pas un echec de la tache : la boucle attend ${minutes} minutes et reprendra la meme consigne. Ne change pas d'approche pour cette raison.`,
                ),
              )
              .catch(() => {})
          }
          await pause(attente + 30000)
          lastSeen = null
          turn -= 1
          continue
        }
      }

      // Un tour qui a écrit des fichiers n'est pas stérile, même si git ne les
      // suit pas encore. Ne regarder que `changed` rendait invisibles les 63
      // fichiers neufs produits par Codex, et la boucle s'arrêtait sur
      // « aucun fichier ne bouge » au moment même où le travail sortait.
      const aBouge = Boolean(outcome.changed?.length || outcome.produits?.length)
      sterile = aBouge ? 0 : sterile + 1

      if (sterile >= toursSteriles) {
        console.log(`\n  ARRÊT — ${toursSteriles} tours sans qu’un seul fichier bouge. Ce n’est plus un problème à absorber.\n`)
        if (willPost) {
          await page
            .evaluate(
              jsPost(
                'Trois tours consécutifs sans qu’aucun fichier ne bouge. La boucle s’arrête : ce n’est plus un obstacle ponctuel, c’est l’approche qui ne prend pas. Il faut une décision humaine — changer de méthode, revoir le critère de preuve, ou renoncer à cet objectif.',
              ),
            )
            .catch(() => {})
        }
        break
      }

      // 4. Rendre compte, quoi qu'il arrive.
      // Joindre les rendus AVANT le texte : la conversation doit voir avant
      // de juger, sinon elle prononce sur la parole de l'exécutant.
      let joints = 0
      if (willPost && outcome.produits?.length) {
        const charger = (c, type) => {
          try {
            const abs = resolve(process.cwd(), c)
            if (statSync(abs).size > 2 * 1024 * 1024) return null
            return { nom: basename(c), type, b64: readFileSync(abs).toString('base64') }
          } catch {
            return null
          }
        }

        const images = outcome.produits
          .filter((c) => /\.(png|jpe?g|webp)$/i.test(c))
          .slice(0, 4)
          .map((c) => charger(c, /\.png$/i.test(c) ? 'image/png' : 'image/jpeg'))
          .filter(Boolean)

        // Les livrables TEXTE aussi : un chapitre dont la preuve est un
        // registre Markdown ou un manifeste JSON ne peut pas être jugé sur le
        // récit de la session. Le juge doit lire les fichiers, pas leur nom.
        const textes = outcome.produits
          .filter((c) => /\.(md|json|csv|txt|svg)$/i.test(c))
          .slice(0, 6)
          .map((c) =>
            charger(
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
              `    ${joints} pièce(s) jointe(s)` +
                (images.length ? ` · ${images.length} rendu(s)` : '') +
                (textes.length ? ` · ${textes.length} document(s)` : ''),
            )
          }
        }
      }

      const report = buildReport(turn, directive, { ...outcome, joints })
      if (willPost) {
        await page.evaluate(jsPost(report)).catch(() => {})
        const landed = await confirmPosted(page, report)
        console.log(landed ? '    ↑ posté' : '    !  publication non confirmée')
        if (!landed) break
      } else {
        console.log(`\n${indent(report)}\n`)
      }

      // 5. Ce qui arrête vraiment.
      if (budget && spent >= budget) {
        console.log(`\n  ARRÊT — budget de $${budget} atteint (dépensé $${spent.toFixed(2)}).\n`)
        if (willPost) {
          await page.evaluate(
            jsPost(`Budget de $${budget} atteint après ${turn} tours. La boucle s’arrête ici, le chapitre n’est pas clos.`),
          )
        }
        break
      }

      // Un refus dont la cause est « cet objectif attend une décision »
      // n'est pas absorbable : c'est précisément une décision qui manque.
      const needsHuman =
        stopReasons.includes(outcome.haltReason) ||
        /décision humaine|critère de preuve|n’existe pas/.test(outcome.stopReason ?? '')

      if (outcome.stop && needsHuman) {
        console.log(`\n  ARRÊT — ${outcome.stopReason}\n`)
        if (willPost) {
          await page
            .evaluate(
              jsPost(
                `La boucle s’arrête : ${outcome.stopReason}. Il faut une décision de l’humain avant de continuer — soit lever l’arrêt, soit préciser le critère de preuve, soit viser un autre objectif.`,
              ),
            )
            .catch(() => {})
        }
        break
      }

      if (outcome.stop) {
        // Une règle enfreinte ou un piétinement : la boucle le signale à GPT
        // et continue — c'est un problème qu'elle sait traiter.
        console.log(`    (problème absorbé : ${outcome.stopReason})`)
        await resolveHalts(outcome.objectiveId)
      }

      await pause(4000)
    }

    page.close()
  },

  async halt(objectiveId, reason, ...detail) {
    if (!objectiveId || !reason) fail('usage: orchestrator halt <objectiveId> <motif> [détail]')
    await call('POST', `/objectives/${objectiveId}/halts`, { reason, detail: detail.join(' ') || null })
    console.log(`arrêt enregistré — ${reason}`)
  },

  async next() {
    const objectives = await call('GET', `/projects/${config.project}/objectives`)
    const ready = objectives
      .filter((o) => ['ready', 'in_progress'].includes(o.status) && !o.open_halts_count)
      .sort((a, b) => a.priority - b.priority)

    if (!ready.length) return console.log('aucun objectif disponible — tout est prouvé, bloqué ou sans preuve définie')

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

/** decimal(20,4) arrive avec ses zéros de queue. */
const trimNum = (v) => (v === null || v === undefined ? '—' : String(Number(v)))
const signOf = (c) => ({ lte: '≤', lt: '<', gte: '≥', gt: '>', eq: '=' })[c] ?? c

/** Le vocabulaire technique reste dans la base ; ce qui sort parle français. */
const BLAST_FR = {
  cosmetic: 'sans risque',
  feature: 'risque limité',
  api: 'touche à une ressource partagée',
  critical: 'critique',
}
/**
 * Récupère le premier objet JSON d'une réponse. Les modèles encadrent volontiers
 * leur JSON de prose ou de balises de code : refuser pour ça gaspillerait
 * l'appel, alors qu'on sait où couper.
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
  no_provable_criterion: 'on ne sait pas comment le vérifier',
  blast_radius: 'trop risqué pour décider seul',
  piege_rule: 'une règle du projet est enfreinte',
  invariant_regression: 'une mesure de production s’est dégradée',
  no_new_proof: 'plusieurs essais, rien de démontré',
  budget: 'budget atteint',
  human_request: 'arrêt demandé',
  verdict_rejected: 'refusé au verdict, à reprendre',
  children_open: 'des sous-objectifs sont encore ouverts',
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
 * Les motifs d'arrêt qui exigent VRAIMENT un humain. Les autres, la boucle
 * les signale à la conversation qui pilote et continue : c'est la différence
 * entre « je bute » et « je ne peux pas décider ».
 */
const HUMAN_HALTS = ['blast_radius', 'no_provable_criterion', 'invariant_regression', 'budget', 'human_request']

/** Lève les arrêts que la boucle sait traiter, pour ne pas se bloquer elle-même. */
async function resolveHalts(objectiveId) {
  if (!objectiveId) return
  const o = await call('GET', `/objectives/${objectiveId}`, null, { soft: true }).catch(() => null)
  for (const h of o?.halts ?? []) {
    if (h.resolved_at || HUMAN_HALTS.includes(h.reason)) continue
    await call('PATCH', `/halts/${h.id}/resolve`, null, { soft: true }).catch(() => {})
  }
}

/**
 * Le binaire d'un harnais n'est JAMAIS un chemin en dur : il dépend de la
 * machine. Dans l'ordre — la variable d'environnement, puis `binaries` de
 * .orchestrator.json, et à défaut le PATH tranche.
 *
 *   ORCHESTRATOR_CODEX_BIN=/chemin/vers/codex
 *   "binaries": { "codex": "/chemin/vers/codex" }
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

/** Codex range ses rollouts par année/mois/jour — il faut descendre. */
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

  // Le bon rollout est celui dont le cwd est ce projet, pas le plus récent
  // en date : d'autres sessions Codex tournent ailleurs en parallèle.
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
 * Tarifs Codex en $/million : [entrée, sortie, cache lu].
 * Renseignables dans .orchestrator.json → codexPricing. Sans tarif connu,
 * on compte les tokens et on n'invente pas de coût — un chiffre faux dans
 * un garde-fou budgétaire est pire que pas de chiffre du tout.
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
      denied.add(String(p.invocation?.tool ?? p.tool ?? 'outil MCP'))
    }
  }

  const limitReset = parseLimitReset(lastMessage)
  return { denied: [...denied], lastMessage, tools, limitReset }
}

/**
 * Une session peut échouer sans rien casser : refusée sur ses outils, elle
 * consomme et n'écrit rien. Le compte rendu doit dire pourquoi, sinon il
 * annonce « aucun fichier modifié » et fait arbitrer sur une fausse prémisse.
 */
/** « resets 2:10pm » → l'heure de reprise, en millisecondes epoch. */
export function parseLimitReset(text) {
  const m = /(?:resets|réinitialis\w*)\s+(\d{1,2})[:h](\d{2})\s*(am|pm)?/i.exec(text ?? '')
  if (!m) {
    // Plafond annoncé sans heure de reprise : on ne sait pas quand ça revient,
    // mais on sait que ce n'est pas la tâche qui a échoué. Une heure d'attente
    // vaut mieux que de compter ça comme une tentative stérile.
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

  // Le nom du transcript EST l'identifiant de session. On le dérive, on ne le
  // demande à personne : un agent ne peut pas oublier de déclarer ce qu'on lit.
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

  return { denied: [...denied], lastMessage, sessionId, limitReset: parseLimitReset(lastMessage) }
}

/**
 * Lance un harnais sur une tâche, encadré par une tentative, et laisse les
 * gardes trancher. Le harnais n'a rien à déclarer : tout est dérivé.
 */
async function runHarness(harness, task) {
  const objectives = await call('GET', `/projects/${config.project}/objectives`)

  // La consigne désigne un objectif par son numéro : on l'honore.
  // Sans numéro, on retombe sur la priorité — mais on ne devine jamais
  // à la place d'une désignation explicite.
  const named = task.match(/#(\d+)/)
  let target

  if (named) {
    const id = Number(named[1])
    const o = objectives.find((x) => x.id === id)

    if (!o) {
      return {
        verdict: 'refusé',
        halts: [],
        stop: true,
        stopReason: `la consigne désigne l’objectif #${id}, qui n’existe pas dans ce projet`,
        output: '',
      }
    }
    // Refuser seulement sur un arrêt qui EXIGE un humain. Les autres motifs
    // sont absorbables : la boucle les lève et poursuit. Sinon un simple
    // piétinement gèle l'objectif aussi sûrement qu'une décision manquante.
    const full = await call('GET', `/objectives/${id}`, null, { soft: true })
    const openHalts = (full?.halts ?? []).filter((h) => !h.resolved_at)
    const blocking = openHalts.filter((h) => HUMAN_HALTS.includes(h.reason))

    if (blocking.length) {
      return {
        verdict: 'refusé',
        halts: [],
        stop: true,
        haltReason: blocking[0].reason,
        stopReason: `l’objectif #${id} attend une décision humaine — ${blocking[0].reason} : ${(blocking[0].detail ?? '').slice(0, 160)}`,
        output: '',
      }
    }

    if (openHalts.length) {
      console.log(`  (${openHalts.length} arrêt(s) absorbable(s) levé(s) sur #${id})`)
      await resolveHalts(id)
    }
    if (!o.proof_spec) {
      return {
        verdict: 'refusé',
        halts: [],
        stop: true,
        stopReason: `l’objectif #${id} n’a pas de critère de preuve : on ne saurait pas dire quand c’est fini`,
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
      verdict: 'refusé',
      halts: [],
      stop: true,
      stopReason: 'aucun objectif prenable (tout est prouvé, arrêté, ou sans critère de preuve)',
      output: '',
    }
  }

  console.log(`  objectif ciblé : #${target.id} ${target.title}`)

  // Continuité : reprendre une session garde le cache chaud et fait gagner
  // beaucoup — mais elle transporte de l'état que personne ne voit. On ne la
  // prend donc QUE si l'objectif la demande, et on l'annonce.
  const mode = target.resume_mode ?? 'new'
  const reprise =
    mode === 'named' ? target.resume_session : mode === 'last' ? target.last_session : null

  if (mode !== 'new' && !reprise) {
    console.log(`  continuité demandée (${mode}) mais aucune session à reprendre — session neuve`)
  } else if (reprise) {
    console.log(`  reprise de la session ${String(reprise).slice(0, 8)} — la mission n'est pas toute l'histoire`)
  }

  const passage = await call('POST', `/objectives/${target.id}/passages`, {
    harness,
    resumed_from: reprise ?? null,
    git_before: head(),
    // Le résumé sert d'étiquette ; la mission intégrale est ce qui a
    // réellement été transmis au harnais — c'est elle qu'on doit pouvoir
    // relire pour juger si l'ordre était bon ou l'exécution mauvaise.
    summary: task.split('\n').find((l) => l.trim())?.slice(0, 200) ?? task.slice(0, 200),
    mission: task,
  })

  // Une session non interactive ne peut rien demander : on lui passe
  // explicitement ce que l'espace Autorisations a tranché. Les refus
  // restent refusés — ils priment sur les autorisations.
  const perms = await call(
    'GET',
    `/projects/${config.project}/permissions/effective/${harness}`,
  ).catch(() => ({ allow: [], deny: [] }))

  const before = head()
  const startedAt = Date.now()

  // L'arbre de travail est peut-être déjà sale : on photographie son état
  // avant, sinon on impute à la session ce qu'un autre a laissé traîner.
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
      // `workspace-write` et pas davantage : Codex écrit dans le dépôt,
      // jamais ailleurs. Le rayon de souffle tranche ensuite sur le diff.
      harness === 'codex'
        ? [
            harnessBin('codex'),
            // En mode non interactif, TOUT appel d'outil MCP est refusé faute
            // d'approbation — vérifié : approval_policy=never, trust_level
            // trusted et projet de confiance échouent tous les trois. Le seul
            // drapeau qui débloque retire aussi le bac à sable. Décision prise
            // en connaissance de cause : sans lui, Codex ne peut pas toucher
            // Unity sans un humain devant l'écran, donc pas d'autopilote.
            reprise
              ? ['exec', 'resume', String(reprise), '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', task]
              : ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', task],
          ]
        : [
            harnessBin('claude'),
            // La consigne EN TÊTE : --allowed-tools et --disallowed-tools
            // sont variadiques et avaleraient le texte placé après eux.
            [
              '-p',
              task,
              // La reprise vient AVANT les listes d'outils, qui sont variadiques.
              ...(reprise ? ['--resume', String(reprise)] : []),
              ...(perms.allow?.length ? ['--allowed-tools', ...perms.allow] : []),
              ...(perms.deny?.length ? ['--disallowed-tools', ...perms.deny] : []),
            ],
          ]

    output = execFileSync(bin, args, {
      encoding: 'utf8',
      cwd: process.cwd(),
      // Les variables du projet lèvent les ambiguïtés que personne
      // n'est là pour trancher — l'instance Unity, par exemple.
      // Les secrets des services tiers vivent sur CETTE machine et n'entrent
      // dans le processus que le temps de la session. Le serveur ne les a
      // jamais eus : il ne connaît que le NOM de la variable attendue.
      env: { ...process.env, ...(config.secrets ?? {}), ...config.env, ORCHESTRATOR_MANAGED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      // Aucun délai par défaut : une session finit quand elle a fini. Un
      // délai arbitraire tue le travail en cours et facture tout pour rien.
      // Le vrai garde-fou est le budget, qui borne la dépense — pas la durée.
      ...(config.sessionTimeoutMin ? { timeout: config.sessionTimeoutMin * 60 * 1000 } : {}),
    })
  } catch (e) {
    crashed = true
    // ETIMEDOUT / SIGTERM : c'est NOUS qui avons coupé, pas la session.
    timedOut = e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT'
    output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || String(e.message)
  }

  const after = head()

  // Gardes : rayon de souffle puis pack de règles, sur le diff réel.
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

  // Une session privée de ses outils n'a pas échoué : elle a été empêchée.
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
    stopReason = `rayon de souffle touché : ${blast.join(', ')}`
    await call('POST', `/objectives/${target.id}/halts`, {
      reason: 'blast_radius',
      passage_id: passage.id,
      detail: stopReason,
    }, { soft: true }).catch(() => {})
  } else if (halts.length) {
    stop = true
    haltReason = 'piege_rule'
    stopReason = `${halts.length} règle(s) du projet enfreinte(s)`
    await call('POST', `/objectives/${target.id}/halts`, {
      reason: 'piege_rule',
      passage_id: passage.id,
      detail: halts.map((f) => `${f.path}:${f.line} [${f.rule}] ${f.why}`).join('\n'),
    }, { soft: true }).catch(() => {})
  }

  // Une session coupée par le timeout n'a pas échoué : elle a été
  // interrompue. Si elle a produit, on garde le travail.
  const resultats = extraireResultats(diag.lastMessage)

  // Un livrable se DÉRIVE, il ne se déclare pas. Citer un chemin ne prouve
  // rien : une session qui écrit « GAME_VISION.md n'a pas été modifié » cite
  // le fichier sans l'avoir produit. Seule la date de dernière écriture le
  // dit, et elle ne se raconte pas. On balaie donc les dossiers de livrables
  // à la recherche de ce qui a réellement bougé PENDANT la session, et on ne
  // retient des chemins cités que ceux qui passent le même test.
  const dansLaFenetre = (chemin) => {
    try {
      const t = statSync(chemin).mtimeMs
      return t >= startedAt - 5000 && t <= Date.now() + 5000
    } catch {
      return false
    }
  }

  // Un livrable peut atterrir n'importe où : limiter le balayage à Review/ et
  // Docs/ a fait rater six captures écrites dans ArtSource/. On balaie donc
  // tout le dépôt, en écartant ce qu'aucune session ne produit délibérément —
  // caches d'outils, dépendances, et le journal de la boucle elle-même.
  const IGNORES = new Set(
    config.deliverableIgnore ?? [
      '.git', 'node_modules', 'Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds',
      'UserSettings', 'vendor', 'dist', '.venv', '__pycache__',
    ],
  )
  const journalBoucle = basename(process.env.ORCHESTRATOR_LOG ?? 'orchestrator-chapitre-11.log')

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

  // Les tokens se lisent dans les traces du harnais, ils ne se déclarent pas.
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
            : ' · coût inconnu (tarif absent de .orchestrator.json → codexPricing)'),
      )
    }
  } else {
    await commands['usage:scan'](passage.id).catch(() => {})
  }

  // Empêchée : elle n'a pas essayé. Ne compte pas comme un piétinement.
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
        ? `Interrompue par le délai de ${config.sessionTimeoutMin} min, elle travaillait encore`
        : null,
    said: diag.lastMessage ? diag.lastMessage.slice(-6000) : null,
    tools_used: diag.tools ?? null,
    session_id: diag.sessionId ?? null,
  }, { soft: true }).catch(() => {})

  // Enregistrer ce que la session a réellement produit, comme preuve.
  for (const chemin of produits.slice(0, 8)) {
    const type = /\.(png|jpg)$/i.test(chemin) ? 'render' : 'diff'
    await call(
      'POST',
      `/passages/${passage.id}/evidences`,
      {
        type,
        label: `Livrable produit — ${basename(chemin)}`,
        ref: chemin,
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
        ref: 'Score annoncé par la session',
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
 * Une session qui atteint un critère le DIT. Le diff git ne le dit pas :
 * les captures ne sont pas suivies, la scène peut n'être pas encore
 * sauvegardée, et Unity réimporte des assets sans rapport. Mesurer le
 * mouvement des fichiers pour juger du travail est un mauvais indicateur
 * dans les deux sens — il rate le succès et signale du bruit.
 */
function extraireResultats(said) {
  if (!said) return { scores: [], chemins: [], atteint: false }

  // Un score est annoncé, pas déduit d'un chiffre croisé dans un tableau.
  // Il faut le mot « score » ou une mise en gras, et un libellé cohérent.
  const scores = []
  for (const ligne of said.split('\n')) {
    if (/^\s*\|/.test(ligne)) continue // ligne de tableau : données, pas verdict

    const m = /(?:score|poste|total|plan|critère|note)[^\n:]{0,50}?[:—-]?\s*\**\s*(\d{1,3})\s*\/\s*(\d{1,3})/i.exec(ligne)
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

  const atteint = /objectif atteint|critère (?:est )?(?:rempli|satisfait)|plancher (?:atteint|tenu)|gate (?:atteint|passé)/i.test(said)

  return { scores, chemins: [...new Set(chemins)], atteint }
}

function buildReport(turn, directive, outcome) {
  const lines = [
    `## Tour ${turn} — objectif #${outcome.objectiveId ?? '?'}`,
    '',
    `**Harnais** ${directive.harness} · **verdict de l’outil** ${outcome.verdict}` +
      (outcome.cout ? ` · **coût** $${outcome.cout.toFixed(2)}` : ''),
    '',
    `**Ce qui devait être vrai** ${outcome.proofSpec ?? '(non spécifié)'}`,
    '',
  ]

  if (outcome.resultats?.scores?.length) {
    lines.push('**Scores relevés**')
    for (const sc of outcome.resultats.scores.slice(0, 6)) {
      lines.push(`- ${sc.quoi} : ${sc.obtenu}/${sc.total}`)
    }
    lines.push('')
  }

  if (outcome.produits?.length) {
    const total = outcome.produits.length
    lines.push(`**Livrables produits** — ${total} fichier${total > 1 ? 's' : ''}`)
    for (const c of outcome.produits.slice(0, 12)) lines.push(`- ${c}`)
    if (total > 12) lines.push(`- … et ${total - 12} autre(s), non listés ici`)
    if (outcome.joints) {
      const images = outcome.produits.filter((c) => /\.(png|jpe?g|webp)$/i.test(c)).length
      lines.push(
        '',
        `Les ${outcome.joints} pièces les plus récentes sont jointes à ce message` +
          (images > outcome.joints ? ` (sur ${images} produits)` : '') +
          ` — juge sur l’image, pas sur le score annoncé.`,
      )
    }
    lines.push('')
  }

  if (outcome.changed?.length) {
    lines.push(`Fichiers suivis modifiés (${outcome.changed.length}) : ${outcome.changed.slice(0, 12).join(', ')}${outcome.changed.length > 12 ? '…' : ''}`)
  } else if (!outcome.produits?.length) {
    lines.push(
      outcome.limitReset
        ? "Aucun fichier modifié — la session n'a pas pu travailler, voir le plafond ci-dessous."
        : 'Aucun fichier modifié, aucun livrable produit.',
    )
  }

  if (outcome.limitReset) {
    lines.push(
      '',
      "PLAFOND D'USAGE — le harnais a refusé la session avant qu'elle ne commence. Ce n'est **pas** un échec de la tâche et ce n'est pas un motif de refus : rien n'a été tenté. Ne change pas d'approche pour cette raison, et ne prononce pas de verdict sur ce tour. La boucle attend la reprise et rejouera la même consigne.",
    )
  }

  if (outcome.blast?.length) {
    lines.push('', `ARRÊT — rayon de souffle : ${outcome.blast.join(', ')}. Rien n'a été validé, une décision humaine est requise.`)
  }

  if (outcome.halts?.length) {
    lines.push('', 'ARRÊT — règles du projet enfreintes :')
    for (const f of outcome.halts.slice(0, 6)) lines.push(`- ${f.path}:${f.line} — ${f.why}`)
  }

  if (outcome.timedOut) {
    lines.push(
      '',
      'INTERROMPUE — la session a atteint le délai maximum alors qu’elle travaillait encore. Ce n’est pas un échec de la tâche : le travail déjà produit est conservé, mais il est incomplet.',
    )
  }

  if (outcome.denied?.length) {
    lines.push(
      '',
      `EMPÊCHÉE — ${outcome.denied.length} outil(s) refusés à la session. Elle n’a pas échoué, elle n’a pas pu agir :`,
    )
    for (const d of outcome.denied.slice(0, 8)) lines.push(`- ${d}`)
    lines.push('Ces refus sont remontés dans l’espace Autorisations pour être tranchés.')
  }

  if (outcome.lastMessage) {
    // Le rapport de la session EST le livrable structuré : la doctrine du
    // projet en fixe le plan. Le tronquer revient à jeter ce qu'on a payé.
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
      "**Rien à trancher sur ce tour.** La boucle attend la reprise du harnais et rejouera la même consigne. Tu peux profiter de l'attente pour préciser la mission si tu la juges perfectible, mais ne prononce pas de verdict.",
    )
  } else if (!outcome.stop) {
    lines.push(
      '',
      '---',
      '',
      `**À toi.** Prononce-toi sur #${outcome.objectiveId ?? '?'} — écris « #${outcome.objectiveId} est validé » ou « #${outcome.objectiveId} refusé » — puis donne la mission suivante, complète et structurée comme d’habitude, introduite par \`@claude:\` ou \`@codex:\` seul sur sa ligne et citant le numéro d’objectif visé. Tout ce qui suit ce marqueur est transmis mot pour mot au harnais, et rien d’autre ne lui parvient. Sans marqueur, la boucle s’arrête.`,
    )
  }

  return lines.join('\n')
}

// Ce fichier n'est plus un point d'entrée : le CLI unique du paquet appelle
// ces commandes. C'est ce qui permet à `orchestrator serve` et à
// `orchestrator chapter` d'être la même commande installée une seule fois.
export { commands }
