PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','blocked','completed','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS objectives (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  intent TEXT,
  success_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','in_progress','blocked','proven','abandoned')),
  priority INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','codex','claude','system','import')),
  actor TEXT NOT NULL,
  assertion TEXT NOT NULL CHECK(assertion IN ('measured_fact','agent_statement','human_judgment','system_record')),
  summary TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  idempotency_key TEXT NOT NULL UNIQUE,
  source TEXT
  ,machine_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_timeline ON events(project_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_objective ON events(objective_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS evidence_manifests (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  origin TEXT NOT NULL,
  locator_kind TEXT NOT NULL CHECK(locator_kind IN ('path','url','embedded','missing')),
  locator TEXT,
  sha256 TEXT,
  bytes INTEGER,
  mime TEXT,
  retention TEXT NOT NULL DEFAULT 'referenced' CHECK(retention IN ('referenced','included','external','missing','deleted')),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','missing','unverified','deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK((status = 'available' AND sha256 IS NOT NULL) OR status != 'available')
);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence_manifests(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('proposed','accepted','superseded','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_shards (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  shard_name TEXT NOT NULL,
  remote_id TEXT,
  sha256 TEXT NOT NULL,
  machine_id TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  direction TEXT NOT NULL CHECK(direction IN ('pulled','pushed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, shard_name)
);
CREATE TABLE IF NOT EXISTS blockers (
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','inconclusive')), rationale TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  amount REAL, currency TEXT NOT NULL DEFAULT 'USD', known INTEGER NOT NULL DEFAULT 1 CHECK(known IN (0,1)), category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cleanups (
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  resource TEXT NOT NULL, observed_state TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_connections (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE CHECK(provider IN ('gdrive','dropbox')),
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  target TEXT,
  credentials TEXT NOT NULL,
  remote_file_id TEXT,
  last_status TEXT NOT NULL DEFAULT 'unknown' CHECK(last_status IN ('ok','error','unknown')),
  last_detail TEXT,
  last_pull_at TEXT,
  last_push_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_local_event_id INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
