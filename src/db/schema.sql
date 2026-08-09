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
  project_type TEXT NOT NULL DEFAULT 'software' CHECK(project_type IN ('software','game','web','api','mobile','ai','infrastructure','documentation','other')),
  validation_profile TEXT NOT NULL DEFAULT '{}',
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
  due_at TEXT,
  estimate_minutes INTEGER CHECK(estimate_minutes IS NULL OR estimate_minutes >= 0),
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
CREATE TABLE IF NOT EXISTS evidence_cloud (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('gdrive','dropbox')),
  sha256 TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  bytes INTEGER,
  source_bytes INTEGER,
  mime TEXT,
  transport_sha256 TEXT,
  optimized INTEGER NOT NULL DEFAULT 0 CHECK(optimized IN (0,1)),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','missing')),
  uploaded_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  downloaded_at TEXT,
  local_path TEXT,
  UNIQUE(provider, sha256)
);
CREATE INDEX IF NOT EXISTS idx_evidence_cloud_sha ON evidence_cloud(sha256);
CREATE TABLE IF NOT EXISTS work_proposals (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('chapter','task','instruction','corrective')),
  title TEXT NOT NULL,
  body TEXT,
  success_criteria TEXT,
  rationale TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('codex_memory','claude_memory','project_state','rejected_ticket','human')),
  source_ref TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','rejected','published','superseded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_proposals_project ON work_proposals(project_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS objective_dependencies (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(objective_id != depends_on_id),
  UNIQUE(objective_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_objective_dependencies_project ON objective_dependencies(project_id,objective_id);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  provider TEXT,
  entity_type TEXT NOT NULL,
  entity_uid TEXT NOT NULL,
  local_value TEXT NOT NULL,
  incoming_value TEXT NOT NULL,
  incoming_machine_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','ignored')),
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON sync_conflicts(status,created_at DESC);
CREATE TABLE IF NOT EXISTS management_reports (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  period_days INTEGER NOT NULL,
  summary TEXT NOT NULL,
  report_json TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_management_reports_generated ON management_reports(generated_at DESC);
CREATE TABLE IF NOT EXISTS management_reviews (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  cadence TEXT NOT NULL CHECK(cadence IN ('daily','weekly')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  project_slugs TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  followups TEXT NOT NULL DEFAULT '[]',
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_management_reviews_created ON management_reviews(created_at DESC);
CREATE TABLE IF NOT EXISTS clickup_accounts (
  id INTEGER PRIMARY KEY CHECK(id=1),
  token TEXT NOT NULL,
  auth_kind TEXT NOT NULL DEFAULT 'personal' CHECK(auth_kind IN ('personal','oauth')),
  workspace_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clickup_connections (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT,
  list_id TEXT NOT NULL,
  tag_name TEXT,
  tag_color TEXT,
  status_mapping TEXT,
  token TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  last_status TEXT NOT NULL DEFAULT 'unknown' CHECK(last_status IN ('ok','error','unknown')),
  last_detail TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clickup_ticket_links (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposal_id INTEGER REFERENCES work_proposals(id) ON DELETE SET NULL,
  objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  ticket_id TEXT NOT NULL,
  ticket_url TEXT,
  ticket_status TEXT,
  sync_hash TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clickup_sync_runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled')),
  status TEXT NOT NULL CHECK(status IN ('running','ok','error')),
  percent INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  attachments INTEGER NOT NULL DEFAULT 0,
  rejected_imported INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_clickup_sync_runs_project ON clickup_sync_runs(project_id,started_at DESC);
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
  ,failure_count INTEGER NOT NULL DEFAULT 0
  ,next_retry_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_imports (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('codex','claude')),
  adapter_version INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('parsed','partial','unsupported','error')),
  records_found INTEGER NOT NULL DEFAULT 0,
  parse_errors INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source,source_path,source_sha256)
);

CREATE TABLE IF NOT EXISTS access_tokens (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '["read"]',
  machine_id TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
