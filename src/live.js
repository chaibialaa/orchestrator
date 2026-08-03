import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { base, json } from './db/index.js'
import { encodeCwd } from './agent/watch.js'

/**
 * What a pass is doing WHILE it does it.
 *
 * Both halves of every exchange were already kept — `mission` is what went to
 * the harness, `said` is what came back — but only once the pass had ended. For
 * the ten or twenty minutes it runs, the screen said `turn 2 — claude` and
 * nothing else, and the only living account was a log file on disk that the tool
 * never mentioned. Watching your own money being spent should not require
 * `tail -f`.
 *
 * Read from the harness's own transcript, in the window of the open attempt.
 * Nothing is stored: this is a window onto a file, and when the pass ends the
 * recorded `mission`/`said` take over.
 */

/** Where Claude Code files a repository's transcripts. */
function transcriptDir(repoPath) {
  return join(homedir(), '.claude', 'projects', encodeCwd(repoPath))
}

/**
 * One line of the account, or null when the entry says nothing a person needs.
 *
 * Thinking is deliberately dropped. It is the bulk of the file, it is not
 * addressed to anybody, and a live view that scrolls past reasoning nobody reads
 * teaches you to stop looking — which is the state we are trying to leave.
 */
function toEvent(entry) {
  const m = entry.message
  if (!m?.role) return null
  const at = entry.timestamp ?? null
  const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]

  for (const block of content) {
    if (!block || typeof block !== 'object') continue

    if (block.type === 'text' && block.text?.trim()) {
      return { at, kind: m.role === 'assistant' ? 'says' : 'asked', text: block.text.trim().slice(0, 2000) }
    }
    if (block.type === 'tool_use') {
      // The argument that identifies the call, not the whole payload: a file
      // path or a command is what tells you where it is; a 40 kB Write body is
      // what makes the view unreadable.
      const i = block.input ?? {}
      const subject =
        i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.description ?? ''
      return {
        at,
        kind: 'uses',
        tool: block.name,
        text: String(subject).replace(/\s+/g, ' ').slice(0, 300),
      }
    }
    if (block.type === 'tool_result') {
      const c = block.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join(' ') : ''
      if (!text.trim()) continue
      return {
        at,
        kind: block.is_error ? 'refused' : 'got',
        text: text.replace(/\s+/g, ' ').trim().slice(0, 400),
      }
    }
  }
  return null
}

/**
 * The live account of the attempt currently open on this objective.
 *
 * Returns null when nothing is running — the caller then has the recorded
 * mission and reply, which are better than a stale stream.
 */
export function live(objectiveId, { limit = 40 } = {}) {
  const db = base()
  const p = db
    .prepare(
      `SELECT pa.id, pa.harness, pa.started_at, pa.session_id, pa.mission, pr.repo_path, pr.slug
       FROM passages pa
       JOIN objectives o ON o.id = pa.objective_id
       JOIN projects pr ON pr.id = o.project_id
       WHERE pa.objective_id = ? AND pa.ended_at IS NULL
       ORDER BY pa.id DESC LIMIT 1`,
    )
    .get(objectiveId)
  if (!p || !p.repo_path) return null

  const head = {
    passage: p.id,
    harness: p.harness,
    started_at: p.started_at,
    /** What it was told, in full. It is the half a reader most often wants. */
    mission: p.mission ?? null,
  }

  const dir = transcriptDir(p.repo_path)
  if (!existsSync(dir)) return { ...head, events: [], note: 'no transcript directory for this repository' }

  const since = Date.parse(p.started_at.replace(' ', 'T') + 'Z')

  // The session's own file when we know it, otherwise whatever was written into
  // since the attempt opened — a session id is recorded a moment after the start.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f))
    .filter((f) => (p.session_id ? f.includes(p.session_id) : statSync(f).mtimeMs >= since))

  if (!files.length) return { ...head, events: [], note: 'nothing written yet' }

  const events = []
  for (const file of files) {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue // a file being written to is not an error worth reporting
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const entry = json.read(line, null)
      if (!entry) continue
      const at = Date.parse(entry.timestamp ?? '')
      if (!at || at < since) continue
      const ev = toEvent(entry)
      if (ev) events.push(ev)
    }
  }

  events.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  return { ...head, events: events.slice(-limit), total: events.length }
}
