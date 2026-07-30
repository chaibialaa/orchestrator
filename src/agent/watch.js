/**
 * Le veilleur — enregistre le travail des harnais sans leur coopération.
 *
 * Claude Code et Codex journalisent déjà tout : le répertoire de travail,
 * la consommation par requête, la fin de tâche. On lit leurs traces plutôt
 * que de leur demander de nous prévenir. Un agent ne peut pas oublier de
 * déclarer ce qu'on dérive de ses propres logs.
 */

import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const CLAUDE_ROOT = resolve(homedir(), '.claude/projects')
const CODEX_ROOT = resolve(homedir(), '.codex/sessions')

/**
 * Claude encode le cwd en remplaçant `/` par `-`. Le décodage est AMBIGU
 * (`biro-web` redeviendrait `biro/web`) : on compare les formes encodées.
 */
export function encodeCwd(path) {
  // Le harnais remplace `/`, `_` ET `.` par `-`. N'en traiter qu'un seul faisait
  // chercher les transcripts de `Tycoon_Project` dans un dossier qui n'existe
  // pas : la consommation revenait à zéro et la passe passait pour stérile.
  return path.replace(/[/_.]/g, '-')
}

function listRecent(root, sinceMs, depth = 1) {
  if (!existsSync(root)) return []
  const out = []

  const walk = (dir, level) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory() && level < depth) walk(full, level + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          if (statSync(full).mtimeMs >= sinceMs) out.push(full)
        } catch {
          /* fichier disparu entre-temps */
        }
      }
    }
  }

  walk(root, 0)
  return out
}

export function recentSessions(sinceMs) {
  const sessions = []

  if (existsSync(CLAUDE_ROOT)) {
    for (const dir of readdirSync(CLAUDE_ROOT, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      for (const file of listRecent(join(CLAUDE_ROOT, dir.name), sinceMs, 0)) {
        sessions.push({ harness: 'claude', file, cwd: null, encodedCwd: dir.name })
      }
    }
  }

  for (const file of listRecent(CODEX_ROOT, sinceMs, 4)) {
    sessions.push({ harness: 'codex', file, cwd: null })
  }

  return sessions
}

/**
 * Lit un fichier de session à partir d'un décalage et en extrait ce qui
 * nous intéresse : le répertoire, la consommation, la fin de tâche.
 */
export function readSince(file, offset) {
  let size
  try {
    size = statSync(file).size
  } catch {
    return null
  }

  if (size <= offset) return { offset, cwd: null, tokens: 0, requests: 0, cost: 0, done: false, lastAt: null }

  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(size - offset)
  readSync(fd, buf, 0, buf.length, offset)
  closeSync(fd)

  const text = buf.toString('utf8')
  // La dernière ligne peut être tronquée : on la garde pour le tour suivant.
  const lastNewline = text.lastIndexOf('\n')
  const usable = lastNewline === -1 ? '' : text.slice(0, lastNewline)
  const consumed = offset + Buffer.byteLength(usable, 'utf8') + (lastNewline === -1 ? 0 : 1)

  const result = {
    offset: consumed,
    cwd: null,
    tokens: 0,
    requests: 0,
    cost: 0,
    done: false,
    lastAt: null,
    models: new Set(),
    codexTotal: null,
  }

  for (const line of usable.split('\n')) {
    if (!line.trim()) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }

    if (d.timestamp) result.lastAt = d.timestamp

    // --- Claude Code ---
    const usage = d.message?.usage
    if (usage) {
      const model = d.message?.model ?? 'inconnu'
      result.models.add(model)
      result.requests += 1
      result.tokens +=
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
        (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0)
      result.cost += claudeCost(model, usage)
    }

    // --- Codex ---
    const p = d.payload
    if (p?.cwd && !result.cwd) result.cwd = p.cwd
    if (d.type === 'session_meta' && p?.cwd) result.cwd = p.cwd

    if (p?.type === 'token_count' && p.info?.total_token_usage) {
      // Codex publie un cumul, pas un delta.
      result.codexTotal = p.info.total_token_usage.total_tokens ?? null
    }

    if (p?.type === 'task_complete' || p?.type === 'turn_aborted') result.done = true
  }

  result.models = [...result.models]
  return result
}

const CLAUDE_PRICING = {
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

function claudeCost(model, usage) {
  const key = Object.keys(CLAUDE_PRICING)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k))
  if (!key) return 0

  const [inP, outP] = CLAUDE_PRICING[key]
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0

  return (
    ((usage.input_tokens ?? 0) * inP +
      write5m * inP * 1.25 +
      write1h * inP * 2 +
      (usage.cache_read_input_tokens ?? 0) * inP * 0.1 +
      (usage.output_tokens ?? 0) * outP) /
    1_000_000
  )
}

export { readFileSync }
