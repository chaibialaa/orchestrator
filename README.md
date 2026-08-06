# Orchestrator

Orchestrator is an observation-only project dashboard and persistent memory for work performed by humans, Codex, Claude, and other tools outside Orchestrator.

It records projects, chapters, objectives, events, decisions, blockers, verdicts, costs, cleanup observations, Git snapshots, and evidence manifests. It does **not** start agents, execute commands, manage workers, control browsers, run Git, or automate project work.

## What it provides

- A global portfolio of tracked and locally detected projects.
- Project chapters with derived progress, blockers, and history.
- Evidence grouped by chapter and pass, with image previews, full-screen navigation, text display, hashes, retention status, and local verification.
- A traceable event journal that separates measured facts, agent statements, human judgments, and system records.
- Human-judgment forms shown only when a judgment has explicitly been requested.
- Multi-machine coordination records for concurrent passes and observed Git state.
- Read-only discovery of local Codex and Claude memory.
- Portable JSON and Markdown exports, plus idempotent JSON import.
- Immutable journal synchronization through Google Drive or Dropbox.
- Token and cost analytics, including clearly labelled API-equivalent estimates from local session counters.

## Architecture

```text
External work (Codex / Claude / humans)
                 |
                 | events, states, evidence references
                 v
        Express ingestion and read API
                 |
                 v
      SQLite append-only event journal
                 |
                 +--> derived project state
                 +--> evidence manifests
                 +--> decisions / blockers / verdicts
                 +--> JSON / Markdown exports
                 |
                 v
          Vue 3 dashboard (read/record)
```

The runtime uses Node.js 20+, Express, SQLite through `better-sqlite3`, Vue 3, TypeScript, and Vite.

`events` is append-only: database triggers reject updates and deletions. Domain tables such as `decisions`, `blockers`, `verdicts`, `costs`, `cleanups`, and `evidence_manifests` are projections linked to their source event.

## Installation

```bash
npm install -g @chaibialaa/orchestrator@beta
orchestrator migrate
orchestrator serve 4173
```

Open `http://127.0.0.1:4173`. The server binds to localhost only.

For repository development:

```bash
npm install
npm --prefix web install
npm run build
npm test
npm start
```

The default database is `~/.orchestrator/orchestrator.db`. Override it with `ORCHESTRATOR_DB=/absolute/path/orchestrator.db`.

## Safe migration

Migration never runs automatically when the server starts. Back up the database first:

```bash
sqlite3 ~/.orchestrator/orchestrator.db \
  "VACUUM INTO '/absolute/path/orchestrator-backup.db'"
orchestrator migrate
```

The legacy migration is transactional and idempotent. It validates SQLite integrity and foreign keys, converts useful historical projects, objectives, passages, proofs, decisions, blockers, verdicts, and costs into the observation model, then removes obsolete execution tables. Do not migrate while an older Orchestrator process is still writing to the database.

## Data and provenance

Every event includes a project, kind, actor, occurrence time, summary, payload, and assertion type:

| Assertion | Meaning |
| --- | --- |
| `measured_fact` | Directly observed or measured result |
| `agent_statement` | Claim reported by Codex, Claude, or another client |
| `human_judgment` | Explicit human assessment |
| `system_record` | Imported or system-generated record |

Available local evidence requires a SHA-256 hash. Large artifacts remain referenced by absolute path or URL rather than being copied into the database by default.

## Ingestion API

`POST /api/ingest` requires an `Idempotency-Key` header. A request may contain one event or a batch of up to 100 events.

```bash
curl -X POST http://127.0.0.1:4173/api/ingest \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: blockrise-ui-proof-001' \
  -d '{
    "project": "blockrise",
    "objective": "chapter-3",
    "kind": "evidence.recorded",
    "actor_kind": "codex",
    "actor": "Codex",
    "assertion": "measured_fact",
    "summary": "Responsive dashboard verified",
    "occurred_at": "2026-08-06T13:00:00Z",
    "payload": {
      "label": "Dashboard screenshot",
      "type": "image",
      "origin": "browser verification",
      "locator_kind": "path",
      "path": "/absolute/path/dashboard.png",
      "sha256": "<sha256>",
      "bytes": 123456,
      "status": "available",
      "retention": "referenced",
      "pass_ref": "203"
    }
  }'
```

Accepted kinds include:

`event.recorded`, `project.updated`, `objective.updated`, `evidence.recorded`, `verdict.recorded`, `decision.recorded`, `blocker.opened`, `blocker.resolved`, `transition.recorded`, `cost.recorded`, `cleanup.observed`, `context.summary`, `work.started`, `work.heartbeat`, `work.finished`, `git.state`, `human_judgment.requested`, and `human_judgment.cancelled`.

Important read endpoints:

```text
GET /api/health
GET /api/projects
GET /api/portfolio
GET /api/projects/:slug
GET /api/projects/:slug/timeline
GET /api/projects/:slug/resume
GET /api/projects/:slug/evidence
GET /api/projects/:slug/coordination
GET /api/projects/:slug/diagram
GET /api/evidence/:uid/verify
GET /api/analytics?project=:slug&days=30
GET /api/memory/local
GET /api/sync
```

There are no run, queue, claim, cancel, worker, agent-launch, process-control, or Git-execution routes.

## Human judgment

A judgment form is derived from an active `human_judgment.requested` event. The reviewer only selects a verdict and writes the judgment; project, chapter, and objective context are already known by the interface. Proven objectives and cancelled requests never display a stale judgment form.

## Multi-machine coordination

External clients may report:

- `git.state`: machine, branch, head commit, and dirty state.
- `work.started`: session, machine, base commit, branch, and path scope.
- `work.heartbeat`: continued activity for a recorded session.
- `work.finished`: completed, failed, or cancelled outcome.

Orchestrator derives overlapping scopes, stale Git bases, and abandoned passes after 15 minutes without a finish or heartbeat. These are observations only: it does not reserve a worker, lock a repository, or run Git commands.

## Local memory and cloud synchronization

`GET /api/memory/local` scans local Codex and Claude histories read-only, groups sessions by working directory, and identifies projects that are not yet tracked. Adding a detected project remains an explicit human action.

Google Drive and Dropbox synchronization exchange immutable, content-addressed journal shards named like:

```text
orchestrator-journal--<machine>--<cursor>--<hash>.json
```

Synchronization imports remote shards and publishes new local shards without deleting or overwriting history. OAuth credentials remain in `~/.orchestrator/oauth.json`; refresh tokens are encrypted in SQLite using `~/.orchestrator/secret.key`. Large evidence files are not uploaded by default.

## Import and export

```text
GET  /api/export/json?project=:slug
GET  /api/export/markdown?project=:slug
POST /api/import
```

JSON exports are complete logical bundles and can be reimported by UID without duplicating existing events. Markdown exports are readable handoff summaries. Referenced evidence metadata remains explicit about missing, external, or locally available bytes.

The CLI can export the complete journal:

```bash
orchestrator export
orchestrator export --markdown
```

## Token and cost analytics

External clients can include `input_tokens`, `output_tokens`, `cached_tokens`, `total_tokens`, `model`, `duration_ms`, `requests`, and `cost_basis` in `cost.recorded`.

For current local Codex sessions, Orchestrator reads the latest local token counters and model name without contacting OpenAI. It can display a public API-equivalent estimate using a dated pricing table. This is **not** the actual cost of a Codex or Claude subscription and is never presented as an invoice. Sessions opened at a parent directory remain machine-wide unless they can be reliably attributed to a project.

## Backup and restore

Use SQLite's consistent backup operation for a live database:

```bash
sqlite3 ~/.orchestrator/orchestrator.db \
  "VACUUM INTO '/absolute/path/orchestrator-backup.db'"
```

Back up referenced evidence separately when its retention matters. To restore, stop the server, preserve the current database under another filename, place the backup at the configured path, and validate it:

```bash
sqlite3 orchestrator.db "PRAGMA integrity_check; PRAGMA foreign_key_check"
```

## Development and verification

```bash
npm run dev
npm run build
npm test
```

The test suite covers migration idempotence, append-only history, ingestion idempotency, evidence integrity, import/export round trips, immutable sync journals, multi-machine pass conflicts, derived-state consistency, analytics, and the absence of execution capabilities in the published runtime.

## Security and limits

- The default server is local-only and has no authentication. Add TLS, authentication, and an explicit CORS policy before exposing it to a network.
- Local records trust the host machine that produced them.
- Evidence verification is on demand, not a background watcher.
- Cloud synchronization covers structured memory, not large evidence artifacts.
- Cleanup records describe an observed state; they never delete resources.
- API-equivalent cost estimates depend on reported token categories and the dated local rate table.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md)
