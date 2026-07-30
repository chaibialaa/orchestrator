import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { base, json } from './db/index.js'
import { oauthAppPresent, PROVIDER_OF } from './oauth.js'

/**
 * What is standing in the way, derived — never declared.
 *
 * Every blocker below cost real money before it was visible anywhere. Two runs
 * spent $79 discovering that the Unity editor had closed; one project ran for a
 * day with 4 of its 60 tools allowed, and nothing said so — the refusals were
 * buried inside session reports nobody reads while a loop is running.
 *
 * A blocker is worth showing only if it names the ONE action that clears it.
 * Anything else belongs in a log.
 */

/** `blocking` needs a human before any pass can succeed. `warning` costs money but proceeds. */
const BLOCKING = 'blocking'
const WARNING = 'warning'

export function blockers() {
  const db = base()
  const out = []

  // Halts already have their own, richer section on the dashboard. Repeating
  // them here would mean two lists to cross-reference for the same thing: this
  // panel only carries what was visible NOWHERE.
  out.push(...unityClosed(db))
  out.push(...emptyPermissions(db))
  out.push(...undecidedRefusals(db))
  out.push(...storages(db))

  // Blocking first, then by project, so the list reads as a queue of actions
  // rather than a pile of facts.
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === BLOCKING ? -1 : 1))
}

/**
 * A project pinned to a Unity instance cannot do anything without an editor —
 * and the MCP server keeps answering after the editor dies, which is exactly
 * what made two passes believe they could work.
 */
function unityClosed(db) {
  const alive = (() => {
    try {
      execFileSync('pgrep', ['-f', 'Unity.app/Contents/MacOS/Unity'], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  })()
  if (alive) return []

  const expecting = db
    .prepare("SELECT id, slug, name, repo_path FROM projects WHERE repo_path IS NOT NULL")
    .all()
    .map((p) => {
      const f = join(p.repo_path, '.orchestrator.json')
      const conf = existsSync(f) ? json.read(readFileSync(f, 'utf8'), {}) : {}
      return conf?.unity?.instance ? { ...p, instance: conf.unity.instance } : null
    })
    .filter(Boolean)
    // A project with no open objective is not waiting on anyone.
    .filter(
      (p) =>
        db
          .prepare(
            "SELECT COUNT(*) n FROM objectives WHERE project_id = ? AND status NOT IN ('proven','abandoned')",
          )
          .get(p.id).n > 0,
    )

  return expecting.map((p) => ({
    kind: 'unity_closed',
    severity: BLOCKING,
    project: p.slug,
    objective: null,
    title: `No Unity editor running — ${p.name} needs one`,
    detail:
      `Every mission on this project targets the \`${p.instance}\` instance. No editor process exists, ` +
      'so a pass would spend money only to report that it could not act.',
    action: `Open ${p.name} in Unity and start its MCP session. A pass will refuse to start until then.`,
    since: null,
  }))
}

/**
 * In a non-interactive session, a tool that is not on the list is refused
 * without asking. So an empty list does not mean "everything is allowed": it
 * means "nothing will work", and nothing used to say so.
 */
function emptyPermissions(db) {
  // The floor is not arbitrary: a genuinely equipped project has dozens. Below
  // ten, the list was never seeded at all.
  const FLOOR = 10

  return db
    .prepare(
      `SELECT p.id, p.slug, p.name,
              (SELECT COUNT(*) FROM permissions WHERE project_id = p.id AND harness = 'claude' AND decision = 'allow') AS allowed,
              (SELECT COUNT(*) FROM objectives WHERE project_id = p.id AND status NOT IN ('proven','abandoned')) AS ouverts
       FROM projects p`,
    )
    .all()
    .filter((p) => p.openHaltsOf > 0 && p.allowed < FLOOR)
    .map((p) => ({
      kind: 'permissions_unseeded',
      severity: BLOCKING,
      project: p.slug,
      objective: null,
      title: `${p.name} has only ${p.allowed} allowed tool${p.allowed === 1 ? '' : 's'}`,
      detail:
        'A non-interactive session cannot ask for anything: a tool that is not on the allow list is ' +
        'refused silently. The pass runs, bills, and produces nothing.',
      action: 'Open Permissions and allow what this project actually needs, or copy another project’s list.',
      since: null,
    }))
}

/** What an agent asked for and nobody decided. */
function undecidedRefusals(db) {
  return db
    .prepare(
      `SELECT pe.pattern, pe.decision, pe.requested, pe.last_requested_at, p.slug, p.name
       FROM permissions pe JOIN projects p ON p.id = pe.project_id
       WHERE pe.requested > 0 AND pe.decision != 'allow'
       ORDER BY pe.requested DESC LIMIT 12`,
    )
    .all()
    .map((r) => ({
      kind: 'refusal_pending',
      severity: WARNING,
      project: r.slug,
      objective: null,
      title: `${r.pattern} refused ${r.requested}× on ${r.name}`,
      detail: `A session asked for this ${r.requested} time${r.requested === 1 ? '' : 's'} and it is still \`${r.decision}\`.`,
      action: 'Decide it in Permissions — a pending decision reads as a refusal to every pass.',
      since: r.last_requested_at,
    }))
}

/** A storage that can receive nothing, and the proofs queued behind it. */
function storages(db) {
  const out = []

  for (const s of db.prepare('SELECT * FROM storages WHERE enabled = 1').all()) {
    if (!s.credentials) {
      out.push({
        kind: 'storage_unconnected',
        severity: WARNING,
        project: null,
        objective: null,
        title: `${s.label} has no connected account`,
        detail: 'Evidence stays in the repository only, so anyone without a clone cannot read it.',
        action: oauthAppPresent(PROVIDER_OF[s.provider])
          ? 'Open Storage and connect an account — it takes one authorisation, once.'
          : `Register the OAuth app first: orchestrator oauth:set ${PROVIDER_OF[s.provider]} <client_id> <client_secret>`,
        since: null,
      })
      continue
    }
    if (s.last_status === 'refused' || s.last_status === 'absent') {
      out.push({
        kind: 'storage_refused',
        severity: WARNING,
        project: null,
        objective: null,
        title: `${s.label} is not reachable`,
        detail: s.last_detail ?? 'The last check was refused.',
        action: 'Reconnect the account, or point it at a folder that still exists.',
        since: s.last_sync_at,
      })
    }
  }

  return out
}
