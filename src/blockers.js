import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { base, json } from './db/index.js'
import { oauthAppPresent, PROVIDER_OF } from './oauth.js'
import { mcpServers } from './mcp.js'

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
  out.push(...codexRulesNotEnforced(db))
  out.push(...mcpVersionsDisagree())
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
      group: 'The Unity editor is closed',
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
              (SELECT COUNT(*) FROM objectives WHERE project_id = p.id AND status NOT IN ('proven','abandoned')) AS open_objectives
       FROM projects p`,
    )
    .all()
    // This read `p.openHaltsOf`, a column no query ever selected: `undefined > 0`
    // is false, so the rule written to catch a project running on 4 of its 60
    // tools never fired once — including on the day that happened.
    .filter((p) => p.open_objectives > 0 && p.allowed < FLOOR)
    .map((p) => ({
      kind: 'permissions_unseeded',
      group: 'No allowed tools — a pass cannot do anything',
      severity: BLOCKING,
      project: p.slug,
      objective: null,
      title: `${p.name} has only ${p.allowed} allowed tool${p.allowed === 1 ? '' : 's'} for Claude`,
      detail:
        'A non-interactive session cannot ask for anything: a tool that is not on the allow list is ' +
        'refused silently. The pass runs, bills, and produces nothing.',
      action: 'Open Permissions and allow what this project actually needs, or copy another project’s list.',
      since: null,
    }))
}

/**
 * Codex is launched with `--dangerously-bypass-approvals-and-sandbox`, so the
 * rules the screen shows for it are never handed to it and never apply.
 *
 * The bypass was chosen knowingly: in non-interactive mode every MCP tool call
 * is refused for want of approval, and the only flag that unblocks it also
 * removes the sandbox — without it there is no autopilot on a Unity project.
 * That trade is defensible. Displaying `deny Bash(git push*)` beside it, as
 * though something were holding the line, is not.
 */
function codexRulesNotEnforced(db) {
  return db
    .prepare(
      `SELECT p.slug, p.name, p.repo_path, COUNT(*) AS denied
       FROM permissions pe JOIN projects p ON p.id = pe.project_id
       WHERE pe.harness = 'codex' AND pe.decision = 'deny'
       GROUP BY p.slug, p.name, p.repo_path`,
    )
    .all()
    .filter((p) => p.denied > 0)
    .map((p) => {
      // Looked for, not assumed. A hook someone deleted is a hook that is gone,
      // and a screen that keeps claiming it is there is worse than one that
      // never claimed anything.
      const held = p.repo_path && guardedAgainstPush(p.repo_path)
      return {
        kind: 'codex_rules_not_enforced',
        group: held ? 'Pushing is held by the repository — the other rules are not' : 'Codex’s rules are not enforced',
        severity: WARNING,
        project: p.slug,
        objective: null,
        title: held
          ? `On ${p.name}, pushing is held by the repository — the other rules are not`
          : `The ${p.denied} rules shown for Codex on ${p.name} are not enforced`,
        detail: held
          ? 'A pre-push hook refuses to publish unless ORCHESTRATOR_ALLOW_PUSH=1 is set on the ' +
            'command, so pushes and tag pushes are stopped for every harness — Codex included, ' +
            'sandbox bypassed or not. `sudo` and `rm -rf` are not git operations and nothing ' +
            'inside a repository can catch them.'
          : 'Codex runs with approvals and sandbox bypassed — the only way it can reach Unity ' +
            'without someone at the screen. It is never handed this list, so nothing here stops ' +
            'it pushing, tagging or deleting. The rules are a wish, not a barrier.',
        action: held
          ? 'Nothing further here. To hold sudo or rm -rf you would have to run the harness as a ' +
            'user that cannot do them — the repository is the wrong place for it.'
          : 'To hold these for real, enforce them in the repository itself (a pre-push hook binds ' +
            'every harness, sandboxed or not) — or accept them as documentation and say so.',
        since: null,
      }
    })
}

/** Does this repository refuse to publish on its own? Read from disk, every time. */
function guardedAgainstPush(repoPath) {
  const hook = join(repoPath, '.git', 'hooks', 'pre-push')
  if (!existsSync(hook)) return false
  try {
    return readFileSync(hook, 'utf8').includes('ORCHESTRATOR_ALLOW_PUSH')
  } catch {
    return false
  }
}

/**
 * Two harnesses pointing at different versions of the same MCP server.
 *
 * Nothing in a trace explains this. One project's Unity work succeeds and
 * another's refuses, both "correctly", and the only difference is a version
 * pinned in a file nobody looks at. mcpforunityserver 10.0.0 cannot target a
 * named Unity instance: with two editors open it declines to act rather than
 * write into the wrong one — right behaviour, incomprehensible symptom.
 */
function mcpVersionsDisagree() {
  return mcpServers()
    .filter((s) => s.disagrees)
    .map((s) => ({
      kind: 'mcp_version_split',
      severity: WARNING,
      project: null,
      objective: null,
      title: `${s.name}: the harnesses are on different versions`,
      detail:
        s.entries
          .filter((e) => e.pin)
          .map((e) => `${e.harness} ${e.scope ? e.scope.split('/').pop() : 'globally'} → ${e.pin.version}`)
          .join(' · ') +
        '. The same tool call can succeed on one and be refused on the other, and no trace says why.',
      action:
        'Pin one version everywhere, in the harnesses’ own configuration — ~/.claude.json and ' +
        '~/.codex/config.toml. Orchestrator reads those files; it does not keep a copy to drift from them.',
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
      group: 'An agent asked for something and nobody answered',
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
        group: 'A storage was declared but never connected',
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
        group: 'A storage is refusing what we send it',
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
