import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

/**
 * The AI memories left on the machine: project instructions, harness memory,
 * Codex rules, Cursor rules. They hold what was learned — and nobody ever
 * rereads them, because they are scattered.
 *
 * Two stages, deliberately separate:
 *   1. the INVENTORY, free, which says what exists and where;
 *   2. the DISTILLATION, which costs a model call and only runs on request.
 *
 * We only read DECLARED roots. These files contain names of servers, databases
 * and personal notes: nobody should find out after the fact what went off to a
 * model.
 */

const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'Library', 'Temp'])
const EXTENSIONS = /\.(md|mdc|txt)$/i

/** The places where AIs file away what they know. */
export function transcriptRoots(repos = []) {
  const h = homedir()
  return [
    { source: 'harness', path: join(h, '.claude', 'projects'), depth: 3 },
    { source: 'global', path: join(h, '.claude', 'CLAUDE.md') },
    { source: 'codex', path: join(h, '.codex', 'memories'), depth: 2 },
    { source: 'codex', path: join(h, '.codex', 'rules'), depth: 2 },
    ...repos.flatMap((d) => [
      { source: 'repo', path: join(d, 'CLAUDE.md'), project: basename(d) },
      { source: 'repo', path: join(d, 'AGENTS.md'), project: basename(d) },
      { source: 'repo', path: join(d, '.claude'), depth: 2, project: basename(d) },
      { source: 'repo', path: join(d, '.cursor'), depth: 2, project: basename(d) },
    ]),
  ]
}

function walk(path, depth, out, level = 0) {
  if (!existsSync(path)) return out
  const st = statSync(path)

  if (st.isFile()) {
    if (EXTENSIONS.test(path)) out.push({ path, size: st.size, modified: st.mtime.toISOString() })
    return out
  }
  if (level >= depth) return out

  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (SKIP.has(e.name) || (e.name.startsWith('.') && level > 0)) continue
    walk(join(path, e.name), depth, out, level + 1)
  }
  return out
}

/**
 * The harness encodes the repository path into its folder name, replacing both
 * `/` AND `_` with `-`. Decoding is therefore ambiguous: `htdocs-Tycoon-Project`
 * could be `htdocs/Tycoon/Project` or `htdocs/Tycoon_Project`. So we ENCODE the
 * paths we know and compare — the same method as the transcript reader, for the
 * same reason.
 */
const encode = (path) => path.replace(/[/_.]/g, '-')

function projectOf(file, hint, repos) {
  if (hint) return hint

  const m = /\.claude\/projects\/([^/]+)\//.exec(file)
  if (!m) return 'unknown'

  // The most SPECIFIC repository that matches: without this, everything would
  // land on the shared root and one project would swallow the others.
  const candidates = repos
    .map((d) => ({ d, e: encode(d) }))
    .filter(({ e }) => m[1] === e)
    .sort((a, b) => b.e.length - a.e.length)

  if (candidates.length) return basename(candidates[0].d)

  // No known repository: keep the raw folder rather than inventing a name. A
  // wrong attribution is worth less than no attribution.
  return m[1]
}

/** The inventory: what exists, where, and which project it belongs to. */
export function inventoryMemories(repos = []) {
  const files = []

  for (const r of transcriptRoots(repos)) {
    for (const f of walk(r.path, r.depth ?? 1, [])) {
      files.push({
        ...f,
        source: r.source,
        project: projectOf(f.path, r.project, repos),
        name: basename(f.path),
      })
    }
  }

  const byProject = {}
  for (const f of files) {
    const p = (byProject[f.project] ??= { files: [], bytes: 0 })
    p.files.push(f)
    p.bytes += f.size
  }

  return {
    total: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    projects: Object.fromEntries(
      Object.entries(byProject)
        .map(([name, p]) => [
          name,
          { count: p.files.length, bytes: p.bytes, files: p.files.map((f) => f.path) },
        ])
        .sort((a, b) => b[1].bytes - a[1].bytes),
    ),
  }
}

/**
 * Assembles a project's material for distillation. We cap it: past the cap we
 * take the most recent files and SAY what was left out, rather than truncating in
 * silence and passing it off as a complete read.
 */
export function assembleContext(files, { byteCap = 400_000 } = {}) {
  const sorted = [...files]
    .map((c) => ({ path: c, ...statSync(c) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  const taken = []
  const skipped = []
  let total = 0

  for (const f of sorted) {
    if (total + f.size > byteCap) {
      skipped.push(f.path)
      continue
    }
    total += f.size
    taken.push(f.path)
  }

  const body = sorted.length
    ? taken.map((c) => `\n===== ${c} =====\n${readFileSync(c, 'utf8')}`).join('\n')
    : ''

  return { body, taken, skipped, bytes: total }
}

/** The distillation instruction. We do not want a summary: we want what is USABLE. */
export function memoryInstruction(project, body) {
  return [
    `Here is everything AI assistants have memorised under “${project}”, gathered on this machine.`,
    '',
    'Careful: this memory may cover SEVERAL projects — it was written from a folder that contains them',
    'all. If that is the case, produce one context per distinct project you find in it, and never mix',
    'their constraints together.',
    '',
    'Distil it into a context usable by an agent picking this project up tomorrow knowing nothing about it.',
    '',
    'Rules:',
    '- keep what still CONSTRAINS the work: settled decisions, verified traps, imposed conventions;',
    '- throw away what is dated, resolved, or specific to one session — a fixed bug is not a constraint;',
    '- if two sources contradict each other, say so and give the more recent one;',
    '- one line per item, phrased as a rule you can apply, not as a memory;',
    '- invent nothing: if a piece of information is missing, it is missing.',
    '',
    'Reply ONLY with a JSON object, with no text around it:',
    '{"projects":[{"name":"…","title":"…","context":"…markdown…","constraints":["…"],"contradictions":["…"],"stale":["…"]}]}',
    '',
    '--- MATERIAL ---',
    body,
    '--- END ---',
  ].join('\n')
}

/**
 * A fingerprint of the memories' state: file count, bytes, and the most recent
 * modification date. Two identical fingerprints mean nothing has moved — and
 * therefore that a scan is still valid. Far cheaper than rereading three
 * thousand files to make sure.
 */
export function memoryFingerprint(inventory) {
  const all = Object.values(inventory.projects ?? {}).flatMap((p) => p.files ?? [])
  let mostRecent = 0
  let bytes = 0
  for (const c of all) {
    try {
      const st = statSync(c)
      bytes += st.size
      if (st.mtimeMs > mostRecent) mostRecent = st.mtimeMs
    } catch {
      /* a vanished file counts as a change: it simply will not be weighed */
    }
  }
  return `${all.length}:${bytes}:${Math.round(mostRecent / 1000)}`
}
