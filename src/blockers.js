import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { base, json } from './db/index.js'
import { oauthAppPresent, PROVIDER_OF } from './oauth.js'
import { mcpServers } from './mcp.js'
import { editorRunning, editorFor } from './unity.js'

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
 *
 * Naming it is not enough, though. "Open Permissions and allow what this project
 * needs" was printed on the overview while the permissions screen was four
 * clicks away through a project it did not name — so each card now carries the
 * way there, derived here rather than guessed by whichever page draws it.
 */

/** `blocking` needs a human before any pass can succeed. `warning` costs money but proceeds. */
const BLOCKING = 'blocking'
const WARNING = 'warning'

/**
 * Which objectives a project-wide condition is actually stopping.
 *
 * A blocker that names only its project leaves the join to the reader: "the
 * Unity editor is closed on Blockrise" sits on one screen, "chapter 3 has not
 * moved in a day" on another, and nothing says they are the same sentence. The
 * database already knows which objectives were going to run — naming them costs
 * one query and turns a fact into a consequence.
 *
 * Started or halted only — NOT everything that could run. Blockrise has fifteen
 * chapters ready to be picked up; a closed editor does not hold those up, nobody
 * asked for them. Marking all sixteen would put a red flag on the whole track
 * and teach the reader to ignore it. What is at a standstill is what somebody is
 * already waiting on.
 */
function stopped(db, projectId) {
  return db
    .prepare(
      `SELECT id, title, status FROM objectives
       WHERE project_id = ? AND status IN ('in_progress','blocked')
       ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END, priority, id`,
    )
    .all(projectId)
}

/**
 * Keep only what concerns one project, or one objective.
 *
 * The panel was mounted in exactly one place — the overview — while every screen
 * where a person asks "why is this not moving?" showed nothing. Scoping belongs
 * here rather than in the page: the same rule then answers the project header,
 * the chapter row and the objective screen.
 */
export function blockersFor({ project, objective } = {}) {
  const all = blockers()
  if (objective != null) {
    const id = Number(objective)
    return all.filter((b) => b.objective === id || b.stops?.some((s) => s.id === id))
  }
  // A condition with no project — two MCP versions, a storage nobody connected —
  // holds on this project too. Warnings stay folded away, so it is not noise.
  if (project) return all.filter((b) => b.project === project || b.project == null)
  return all
}

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
  out.push(...projectHasNoContext(db))
  out.push(...nothingMeasuresIt(db))
  out.push(...undecidedRefusals(db))
  out.push(...storages(db))

  /**
   * One shape, whichever condition fired.
   *
   * `stops`, `link`, `copy_from` and `chore` each belong to some kinds and not
   * others, so the fields a client could count on depended on which blockers
   * happened to be true that minute — and a screen written against a day when
   * Unity was closed reads a key that is simply absent the day it is open. The
   * shape is declared here once; a kind fills in what it has.
   */
  const SHAPE = { group: null, objective: null, stops: [], link: null, copy_from: [], chore: null, since: null }

  // Blocking first, then by project, so the list reads as a queue of actions
  // rather than a pile of facts.
  return out
    .map((b) => ({ ...SHAPE, ...b }))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === BLOCKING ? -1 : 1))
}

/**
 * A project pinned to a Unity instance cannot do anything without an editor —
 * and the MCP server keeps answering after the editor dies, which is exactly
 * what made two passes believe they could work.
 */
function unityClosed(db) {
  if (editorRunning()) return []

  const expecting = db
    .prepare("SELECT id, slug, name, repo_path FROM projects WHERE repo_path IS NOT NULL")
    .all()
    .map((p) => {
      const f = join(p.repo_path, '.orchestrator.json')
      const conf = existsSync(f) ? json.read(readFileSync(f, 'utf8'), {}) : {}
      return conf?.unity?.instance ? { ...p, instance: conf.unity.instance } : null
    })
    .filter(Boolean)
    // A project with nothing an agent could pick up is not waiting on anyone.
    //
    // This read "not proven and not abandoned", which counts drafts — and a draft
    // is held by its own missing criterion, not by an editor. Atlas, whose only
    // open item is a draft, was reporting a BLOCKING condition that stopped
    // nothing: a red card naming no consequence, on the one screen meant to say
    // what to go and do.
    .filter(
      (p) =>
        db
          .prepare(
            "SELECT COUNT(*) n FROM objectives WHERE project_id = ? AND status IN ('in_progress','blocked','ready')",
          )
          .get(p.id).n > 0,
    )

  return expecting.map((p) => {
    /**
     * Can the machine open it itself?
     *
     * The version is not a preference: opening a project with a different editor
     * upgrades it, silently, across every asset. So we look for the exact one
     * `ProjectVersion.txt` asks for, and offer the button only if it is there.
     * An offer that would fail is worse than no offer.
     */
    const found = editorFor(p.repo_path)
    const wanted = found.version ? { version: found.version, installed: Boolean(found.path) } : null

    return {
      kind: 'unity_closed',
      group: 'The Unity editor is closed',
      severity: BLOCKING,
      project: p.slug,
      objective: null,
      stops: stopped(db, p.id),
      title: `No Unity editor running — ${p.name} needs one`,
      detail:
        `Every mission on this project targets the \`${p.instance}\` instance. No editor process exists, ` +
        'so a pass would spend money only to report that it could not act.',
      action: wanted?.installed
        ? `Open it from here — the worker in the repository starts Unity ${wanted.version}, and the ` +
          'MCP bridge comes up with the editor. It answers once it has finished importing.'
        : wanted
          ? `This project wants Unity ${wanted.version}, which is not installed on this machine. ` +
            'Install that exact version — another one would upgrade the project.'
          : `Open ${p.name} in Unity. A pass will refuse to start until then.`,
      // The screen holds a NAME, never a command: what it does lives on the
      // machine that has the repository.
      chore: wanted?.installed ? { kind: 'open_unity', label: `Open Unity ${wanted.version}` } : null,
      since: null,
    }
  })
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
      stops: stopped(db, p.id),
      title: `${p.name} has only ${p.allowed} allowed tool${p.allowed === 1 ? '' : 's'} for Claude`,
      detail:
        'A non-interactive session cannot ask for anything: a tool that is not on the allow list is ' +
        'refused silently. The pass runs, bills, and produces nothing.',
      action: 'Open Permissions and allow what this project actually needs, or copy another project’s list.',
      link: { to: `/p/${p.slug}/permissions`, label: 'Open Permissions' },
      // Offered on the card itself: the list of every other project that has one,
      // so the fix is a click rather than a screen to learn.
      copy_from: db
        .prepare(
          `SELECT p2.slug, p2.name, COUNT(*) n FROM permissions pe
             JOIN projects p2 ON p2.id = pe.project_id
            WHERE pe.harness = 'claude' AND pe.decision = 'allow' AND p2.id != ?
            GROUP BY p2.slug, p2.name HAVING n >= ${FLOOR} ORDER BY n DESC`,
        )
        .all(p.id),
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

/**
 * A project that has told the tool nothing about itself.
 *
 * A breakdown is only as good as what it knows. Iberis carries no decision and
 * no document, so a plan for it would say "log in and test" — while the way to
 * test it here is to forge a JWT, never a password. That knowledge exists in
 * somebody's head and in a conversation; the plan generator cannot reach either.
 *
 * Not blocking: a plan can be written without it. Worth saying, because the plan
 * will be confidently wrong rather than visibly incomplete, and that costs more.
 */
function projectHasNoContext(db) {
  return db
    .prepare(
      `SELECT p.slug, p.name,
              (SELECT COUNT(*) FROM decisions WHERE project_id = p.id) AS decisions,
              (SELECT COUNT(*) FROM resources WHERE project_id = p.id) AS documents,
              (SELECT COUNT(*) FROM objectives WHERE project_id = p.id AND status NOT IN ('proven','abandoned')) AS open
       FROM projects p`,
    )
    .all()
    .filter((p) => p.open > 0 && p.decisions === 0 && p.documents === 0)
    .map((p) => ({
      kind: 'no_project_context',
      severity: WARNING,
      project: p.slug,
      objective: null,
      title: `${p.name} has told the tool nothing about itself`,
      detail:
        'No decision, no document. A breakdown for this project can only produce what it would ' +
        'produce for any project — and the things that make a plan right here are exactly the ' +
        'ones nothing has recorded: how to authenticate in local testing, which database it ' +
        'talks to, what must never be touched.',
      action:
        'Record what a newcomer would get wrong, as decisions on the project. The breakdown reads ' +
        'them and stops contradicting what was already settled.',
      link: { to: `/p/${p.slug}/memory`, label: 'What it knows' },
      since: null,
    }))
}

/**
 * An objective nothing can measure.
 *
 * The number that settles the argument: of 385 pieces of evidence across this
 * whole install, FOUR came from a command. Of the 33 that carry a passing
 * verdict, 18 are judgements. `orchestrator prove` — the one path that produces
 * a measured pass or fail — has barely been used.
 *
 * That is what separates the cheap objective from the dear one, not difficulty:
 *
 *   #24  "a palette in hex, heights in metres, a density per hectare"   3 passes   $22
 *   #11  "a score of at least 78/100"                                  21 passes  $634
 *
 * An aggregate score cannot be produced by any single deliverable and tells an
 * agent nothing about where the missing points are. Worse, on #11 every score
 * was labelled "announced by the session" — and a session scoring its own work
 * is recorded inconclusive, correctly, so the objective could never conclude
 * however long it ran.
 *
 * I tried first to catch this by the ratio of evidence to passing evidence. It
 * did not separate them: 65:1 against 21:1, and the 21:1 succeeded. Reaching
 * for a threshold that fits is how a check ends up measuring nothing. This
 * measures the thing itself — has anything here ever been settled by a command?
 */
function nothingMeasuresIt(db) {
  const MEASURED = ['test', 'e2e', 'invariant']
  const ENOUGH_TRIES = 3

  /**
   * Count it, every time, instead of quoting it.
   *
   * This advice used to end on "four proofs out of 385" — written into the
   * string on the day it was true. It was still saying 4 of 385 when the install
   * held 417 pieces of evidence and 6 measured ones: a figure that reads as a
   * live count and is in fact a memory. The same mistake this very blocker
   * exists to catch, made by the sentence that catches it.
   */
  const tally = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM evidences) AS total,
              (SELECT COUNT(*) FROM evidences
                WHERE type IN ('test','e2e','invariant') AND verdict = 'pass') AS measured`,
    )
    .get()

  return db
    .prepare(
      `SELECT o.id, o.title, p.slug,
              (SELECT COUNT(*) FROM passages WHERE objective_id = o.id) AS attempts,
              (SELECT COALESCE(SUM(cost_usd),0) FROM passages WHERE objective_id = o.id) AS spent,
              (SELECT COUNT(*) FROM evidences WHERE objective_id = o.id) AS made,
              (SELECT COUNT(*) FROM evidences
                WHERE objective_id = o.id AND type IN ('test','e2e','invariant')) AS measured
       FROM objectives o JOIN projects p ON p.id = o.project_id
       WHERE o.status NOT IN ('proven','abandoned')`,
    )
    .all()
    .filter((o) => o.attempts >= ENOUGH_TRIES && o.measured === 0)
    .map((o) => ({
      kind: 'nothing_measures_it',
      severity: WARNING,
      project: o.slug,
      objective: o.id,
      title: `${o.title.slice(0, 55)} — ${o.attempts} attempts, nothing measured`,
      detail:
        `${o.made} pieces of evidence and $${Number(o.spent).toFixed(0)} spent, and not one of them ` +
        `came from a command — no ${MEASURED.join(', ')}. Everything here rests on a session's ` +
        'account of its own work, which is recorded as inconclusive by design. An objective in ' +
        'that state cannot conclude, however long it runs.',
      action:
        'Name a command in the criterion — `orchestrator prove <key>` — or state the value, count ' +
        `or threshold something can read. Across this install, ${tally.measured} proof(s) out of ` +
        `${tally.total} came from a command; that is the difference between a $22 chapter and a ` +
        '$634 one.',
      link: { to: `/o/${o.id}`, label: 'Open the objective' },
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
      link: { to: `/p/${r.slug}/permissions`, label: 'Open Permissions' },
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
        link: { to: '/setup', label: 'Open Storage' },
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
        link: { to: '/setup', label: 'Open Storage' },
        since: s.last_sync_at,
      })
    }
  }

  return out
}
