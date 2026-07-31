-- Orchestrator's schema. Written in one block rather than stacked as migrations:
-- we start clean, and every column here exists for a reason that cost at least
-- one day of debugging.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  repo_path  TEXT,
  -- Qui prononce le verdict : la conversation qui pilote, un humain, un agent
  -- a third party, or the executor itself (only for something measurable).
  gate_judge TEXT NOT NULL DEFAULT 'gpt' CHECK (gate_judge IN ('human','agent','gpt','self')),
  -- Which connected AI judges, and in which conversation. A URL frozen in
  -- le code interdisait un fil par chantier.
  judge_agent TEXT,
  judge_url   TEXT,
  -- How many exchanges a driving conversation may carry before we stop and ask
  -- for a fresh one. Every turn re-reads the whole thread: past a point it costs
  -- more, answers slower, and starts forgetting the rules it was given at the top.
  judge_message_cap INTEGER NOT NULL DEFAULT 40,
  blast_globs TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS objectives (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id    INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  intent       TEXT,
  -- La condition qui rend l'objectif prenable ET concluable. Sans elle,
  -- personne ne peut s'en saisir : c'est voulu.
  proof_spec   TEXT,
  blast_radius TEXT NOT NULL DEFAULT 'feature'
               CHECK (blast_radius IN ('cosmetic','feature','api','critical')),
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','ready','in_progress','blocked','proven','abandoned')),
  priority     INTEGER NOT NULL DEFAULT 50,
  -- Session continuity, chosen PER OBJECTIVE: useful on a loop of iterations,
  -- dangerous anywhere else — an agent that resumes can "remember" having proven
  -- something without producing any new proof.
  resume_mode  TEXT NOT NULL DEFAULT 'new' CHECK (resume_mode IN ('new','last','named')),
  resume_session TEXT,
  proven_at    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_obj_project ON objectives(project_id, priority);
CREATE INDEX IF NOT EXISTS idx_obj_parent  ON objectives(parent_id);

CREATE TABLE IF NOT EXISTS passages (
  id           INTEGER PRIMARY KEY,
  objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  harness      TEXT NOT NULL,
  -- The short label AND the whole mission. Keeping only the first made it
  -- impossible to reread the order received and judge whether the order was bad
  -- or the execution was: 500 characters of context lost for nothing.
  summary      TEXT,
  mission      TEXT,
  said         TEXT,
  tools_used   TEXT,
  verdict      TEXT CHECK (verdict IS NULL OR verdict IN ('advanced','no_progress','halted','failed')),
  -- A prevented attempt did not try: permissions refused, usage ceiling
  -- d'usage, sonde de diagnostic. Elle ne compte dans aucun garde-fou.
  prevented    INTEGER NOT NULL DEFAULT 0,
  prevented_by TEXT,
  git_before   TEXT,
  git_after    TEXT,
  cost_usd     REAL NOT NULL DEFAULT 0,
  tokens       INTEGER NOT NULL DEFAULT 0,
  requests     INTEGER NOT NULL DEFAULT 0,
  -- Dates as TEXT: in MySQL, the first TIMESTAMP column received an implicit
  -- ON UPDATE that rewrote the start time on every write. Every duration we
  -- measured was noise.
  -- Where the session comes from, and what it inherits. Displayed: the reader
  -- has to know when the mission was not the whole story.
  session_id   TEXT,
  resumed_from TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_pass_obj ON passages(objective_id, started_at);
CREATE INDEX IF NOT EXISTS idx_pass_open ON passages(ended_at);

CREATE TABLE IF NOT EXISTS evidences (
  id           INTEGER PRIMARY KEY,
  objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  passage_id   INTEGER REFERENCES passages(id) ON DELETE SET NULL,
  type         TEXT NOT NULL
               CHECK (type IN ('test','e2e','screenshot','render','diff','invariant','manual')),
  label        TEXT NOT NULL,
  ref          TEXT,
  verdict      TEXT NOT NULL DEFAULT 'inconclusive'
               CHECK (verdict IN ('pass','fail','inconclusive')),
  payload      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ev_obj ON evidences(objective_id, verdict);

CREATE TABLE IF NOT EXISTS halts (
  id           INTEGER PRIMARY KEY,
  objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  passage_id   INTEGER REFERENCES passages(id) ON DELETE SET NULL,
  reason       TEXT NOT NULL CHECK (reason IN (
                 'no_provable_criterion','blast_radius','piege_rule','invariant_regression',
                 'no_new_proof','budget','human_request','verdict_rejected','children_open',
                 -- The driving conversation has grown past what it can carry: every
                 -- turn re-reads the whole thread, so a long one gets slower, more
                 -- expensive, and worse at remembering its own rules. Only a person
                 -- can open a fresh one and hand over its address.
                 'judge_conversation_full','error')),
  detail       TEXT,
  -- How many proofs existed at the moment of the halt. That watermark is what
  -- lets us say "nothing new since the rejection" without trusting the clock.
  evidence_mark INTEGER,
  resolved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_halt_open ON halts(objective_id, resolved_at);

CREATE TABLE IF NOT EXISTS decisions (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  paths        TEXT,
  decided_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resources (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  passage_id   INTEGER REFERENCES passages(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'other',
  mime         TEXT,
  size         INTEGER NOT NULL DEFAULT 0,
  summary      TEXT,
  -- Le fichier reste sur le disque : la base garde son chemin et son empreinte,
  -- not its content. A database that grows several megabytes per screenshot
  -- stops being copyable, and that is the whole point of a single file.
  path         TEXT,
  sha256       TEXT,
  included     INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Noms repris tels quels de l'ancien socle. Renommer des colonnes pendant un
-- a port, for elegance, is exactly the mistake that cost us a whole day: the
-- rule becomes right and the material becomes wrong.
CREATE TABLE IF NOT EXISTS invariants (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  probe_key    TEXT,
  comparison   TEXT NOT NULL DEFAULT 'lte',
  threshold    TEXT,
  unit         TEXT,
  armed        INTEGER NOT NULL DEFAULT 1,
  last_value   TEXT,
  last_status  TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN ('ok','breached','unknown')),
  last_checked_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permissions (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  harness    TEXT NOT NULL,
  -- The tool pattern exactly as the harness writes it, e.g. "Bash(git *)".
  pattern    TEXT NOT NULL,
  label      TEXT,
  decision   TEXT NOT NULL DEFAULT 'ask' CHECK (decision IN ('allow','deny','ask')),
  note       TEXT,
  -- How many times an agent asked for it, and when it last did: that is what
  -- lifts the useful refusals to the top of the permissions screen.
  requested  INTEGER NOT NULL DEFAULT 0,
  last_requested_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, harness, pattern)
);

CREATE TABLE IF NOT EXISTS workflows (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  steps       TEXT,
  stop_when   TEXT,
  absorb      TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS briefs (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','running','proposed','applied','failed')),
  proposal   TEXT,
  error      TEXT,
  harness    TEXT,
  taken_at   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  -- The NATURE of the access, never the command: the binary and its options stay
  -- local, so a hosted server can never make anything run.
  reach       TEXT NOT NULL DEFAULT 'cli' CHECK (reach IN ('cli','browser','api')),
  role        TEXT NOT NULL DEFAULT 'executant' CHECK (role IN ('executant','judge','juge','both')),
  -- WHAT it is, beyond what it can do. A model that writes, a machine rented by
  -- the hour, an image service, a 3D generator: they are not interchangeable, and
  -- they do not fail the same way. A rented machine has to be shut down or it
  -- keeps billing; an image service refuses on quota and says nothing useful.
  -- Capability says "it can do images"; kind says "and it is a web service you
  -- drive through a tab".
  kind        TEXT CHECK (kind IS NULL OR kind IN ('model','machine','service','browser')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 50,
  api_key     TEXT,          -- encrypted at rest, never returned to the browser
  settings    TEXT,
  -- What the agent can DO, beyond executing or judging: image, 3d, render, code.
  -- That is what lets a mission say "for images, use this one" instead of leaving
  -- the executor to guess.
  capabilities TEXT,
  -- Le NOM de la variable d'environnement qui porte son secret. La valeur reste
  -- on the machine: a hosted server never holds anybody else's key.
  env_var     TEXT,
  endpoint    TEXT,
  -- Reachability MEASURED on a machine, never declared from a form.
  last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN ('ok','absent','refused','unknown')),
  last_detail TEXT,
  last_machine TEXT,
  last_checked_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Analysis of the AI memories present on the machine. The inventory is free and
-- can be redone at will; distilling costs one model call per project, so it is
-- asked for and never fires on its own.
CREATE TABLE IF NOT EXISTS scans (
  id         INTEGER PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','running','inventoried','analysed','applied','failed')),
  -- What was FOUND: paths, sizes, dates, guessed project. Always shown before
  -- anything is sent to a model — these files
  -- contiennent des noms de serveurs, des bases, des notes personnelles.
  inventory  TEXT,
  -- What was DRAWN from it, per project. A proposal, never applied on its own.
  result     TEXT,
  error      TEXT,
  machine    TEXT,
  taken_at   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Remote storages for proofs. Files already produced are uploaded there so a
-- teammate can read them without having the repository. Credentials are encrypted
-- at rest; they live here rather than on the machine because the server is what
-- uploads — that is the price of sharing, accepted knowingly.
CREATE TABLE IF NOT EXISTS storages (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL CHECK (provider IN ('gdrive','dropbox')),
  label       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  -- Where to drop: a Drive folder id, or a Dropbox path.
  target      TEXT,
  -- Encrypted JSON: a Google service-account key, or an app token.
  credentials TEXT,
  last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN ('ok','refused','absent','unknown')),
  last_detail TEXT,
  last_sync_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Where each proof was deposited. One row per proof/storage pair: the same proof
-- can live on Drive and on Dropbox, and the absence of a row says plainly "not
-- uploaded yet" instead of leaving it to guesswork.
CREATE TABLE IF NOT EXISTS evidence_remotes (
  id          INTEGER PRIMARY KEY,
  evidence_id INTEGER NOT NULL REFERENCES evidences(id) ON DELETE CASCADE,
  storage_id  INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
  remote_id   TEXT,
  remote_url  TEXT,
  bytes       INTEGER,
  sha256      TEXT,
  sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (evidence_id, storage_id)
);

-- A run the interface asked for, and a local worker will carry out.
--
-- The server NEVER executes anything: it records the intent, a worker on the
-- machine that holds the repository claims it and runs the loop. Same pattern as
-- briefs, and for the same reason — a hosted server that could run commands on
-- someone's machine is indefensible.
--
-- Without this table the tool did not replace anything: every run still had to be
-- typed into a terminal, and the interface was a read-only mirror of work started
-- elsewhere.
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective_id INTEGER REFERENCES objectives(id) ON DELETE CASCADE,
  -- `chapter` closes a chapter; `plan` breaks a brief down. What the worker runs.
  -- `judge` renews the driving conversation: it opens a fresh one, posts the
  -- state into it and keeps the address. It is the only mode that works on the
  -- project rather than on the code.
  mode         TEXT NOT NULL DEFAULT 'chapter' CHECK (mode IN ('chapter','plan','judge')),
  max_turns    INTEGER NOT NULL DEFAULT 8,
  budget       REAL,
  budget_without_progress REAL NOT NULL DEFAULT 120,
  -- Whether the run may write into the driving conversation and execute. False is
  -- a dry read, and it is the default everywhere else in this tool.
  post         INTEGER NOT NULL DEFAULT 1,
  -- After each turn, does the loop carry straight on, or stop and wait for a
  -- person to say "next"? The autopilot is the point, but not everyone wants it
  -- on every chapter.
  hold_between_turns INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','done','failed','cancelled')),
  -- Set by a person while it runs; the worker checks it between turns.
  cancel_asked INTEGER NOT NULL DEFAULT 0,
  machine      TEXT,
  pid          INTEGER,
  turn         INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  error        TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  taken_at     TEXT,
  ended_at     TEXT
);

-- Choices that belong to the installation rather than to a project: which AI the
-- reader talks to in order to drive all this, whether the walkthrough has been
-- gone through. One row per key, so a new one costs a migration of nothing.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
