import { base, json } from './db/index.js'

/**
 * The figures behind the charts — derived from the same rows as everything else.
 *
 * The screens carried the totals as prose: "116 attempts, $2087, 2.3 M tokens".
 * That answers how much, never where — which tool the money actually went
 * through, which day it burned, which chapter is nearly done and which has not
 * started. All of it was already in the database and none of it was legible.
 *
 * Nothing here is stored. If a series would be empty, it comes back empty rather
 * than zero-filled: a chart that draws a flat line for days nobody worked is a
 * chart that lies quietly.
 */

/** Only what a person recognises. `mcp__UnityMCP__manage_editor` is noise at 40px. */
function readableTool(name) {
  if (!name.startsWith('mcp__')) return name
  const parts = name.split('__')
  // mcp__<server>__<tool> → "<tool> (server)"
  return parts.length >= 3 ? `${parts.slice(2).join('__')} (${parts[1]})` : name
}

export function charts({ project } = {}) {
  const db = base()
  const p = project
    ? db.prepare('SELECT id, slug FROM projects WHERE slug = ?').get(project)
    : null
  if (project && !p) return null

  const scope = p ? 'AND o.project_id = @pid' : ''
  const args = p ? { pid: p.id } : {}

  const passages = db
    .prepare(
      `SELECT pa.tools_used, pa.harness, pa.cost_usd, pa.tokens, pa.started_at, pa.verdict, pa.prevented
       FROM passages pa JOIN objectives o ON o.id = pa.objective_id
       WHERE 1=1 ${scope}`,
    )
    .all(args)

  // ── which tools the work actually went through ──────────────────────────────
  const tally = new Map()
  let counted = 0
  for (const row of passages) {
    const used = json.read(row.tools_used ?? '', null)
    if (!used || typeof used !== 'object') continue
    counted++
    const entries = Array.isArray(used) ? used.map((k) => [k, 1]) : Object.entries(used)
    for (const [name, n] of entries) {
      const k = readableTool(String(name))
      tally.set(k, (tally.get(k) ?? 0) + (Number(n) || 1))
    }
  }
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1])
  const TOP = 10
  const tools = sorted.slice(0, TOP).map(([name, n]) => ({ name, n }))
  const rest = sorted.slice(TOP).reduce((s, [, n]) => s + n, 0)
  if (rest) tools.push({ name: `${sorted.length - TOP} others`, n: rest, other: true })

  // ── what it cost, by day and by harness ─────────────────────────────────────
  //
  // Fourteen days, and only the days that exist. Padding the gaps with zeros
  // would draw "we worked and spent nothing" on days nobody opened the machine.
  const byDay = new Map()
  const harnesses = new Set()
  for (const row of passages) {
    if (!row.started_at) continue
    const day = row.started_at.slice(0, 10)
    harnesses.add(row.harness)
    const d = byDay.get(day) ?? { day, total: 0, by: {} }
    const c = Number(row.cost_usd ?? 0)
    d.total += c
    d.by[row.harness] = (d.by[row.harness] ?? 0) + c
    byDay.set(day, d)
  }
  const spend = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14)

  // ── how far each chapter actually is ────────────────────────────────────────
  //
  // Not a percentage of anything declared: proven children over children, plus
  // the chapter's own state. A chapter with no steps reports on itself, so it
  // reads 0 or 100 rather than dividing by zero.
  const chapters = p
    ? db
        .prepare(
          `SELECT o.id, o.title, o.status, o.priority,
                  (SELECT COUNT(*) FROM objectives c WHERE c.parent_id = o.id AND c.status != 'abandoned') AS steps,
                  (SELECT COUNT(*) FROM objectives c WHERE c.parent_id = o.id AND c.status = 'proven') AS done,
                  (SELECT COUNT(*) FROM passages pa JOIN objectives c ON c.id = pa.objective_id
                    WHERE c.id = o.id OR c.parent_id = o.id) AS attempts,
                  (SELECT COALESCE(SUM(pa.cost_usd),0) FROM passages pa JOIN objectives c ON c.id = pa.objective_id
                    WHERE c.id = o.id OR c.parent_id = o.id) AS cost_usd
           FROM objectives o
           WHERE o.project_id = ? AND o.parent_id IS NULL AND o.status != 'abandoned'
           ORDER BY o.priority, o.id`,
        )
        .all(p.id)
        .map((c) => ({
          ...c,
          pct: c.steps ? Math.round((c.done / c.steps) * 100) : c.status === 'proven' ? 100 : 0,
        }))
    : []

  /**
   * Where a proof comes from — the argument this whole tool makes.
   *
   * A proof settled by a command and a session's account of its own work are not
   * the same object, and the screens counted them in one number. The gap between
   * a $22 chapter and a $634 one is exactly this ratio.
   */
  const proof = db
    .prepare(
      `SELECT
         SUM(CASE WHEN e.type IN ('test','e2e','invariant') AND e.verdict = 'pass' THEN 1 ELSE 0 END) measured,
         SUM(CASE WHEN e.type NOT IN ('test','e2e','invariant') AND e.verdict = 'pass' THEN 1 ELSE 0 END) accepted,
         SUM(CASE WHEN e.verdict = 'fail' THEN 1 ELSE 0 END) failing,
         SUM(CASE WHEN e.verdict IS NULL OR e.verdict = 'inconclusive' THEN 1 ELSE 0 END) inconclusive
       FROM evidences e JOIN objectives o ON o.id = e.objective_id
       WHERE 1=1 ${scope}`,
    )
    .get(args)

  return {
    tools,
    /** Said out loud: half the attempts predate the recording of tool use. */
    tools_from: { passages: counted, of: passages.length },
    spend,
    harnesses: [...harnesses],
    chapters,
    proof,
  }
}
