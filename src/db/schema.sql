-- Schéma d'Orchestrator. Écrit d'un bloc plutôt qu'empilé en migrations : on
-- repart propre, et chaque colonne qui existe ici a une raison qui a été payée
-- au moins une fois en journée de débogage.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  repo_path  TEXT,
  -- Qui prononce le verdict : la conversation qui pilote, un humain, un agent
  -- tiers, ou l'exécutant lui-même (à n'utiliser que pour du mesurable).
  gate_judge TEXT NOT NULL DEFAULT 'gpt' CHECK (gate_judge IN ('human','agent','gpt','self')),
  -- Quelle IA connectée juge, et dans quelle conversation. Une URL figée dans
  -- le code interdisait un fil par chantier.
  judge_agent TEXT,
  judge_url   TEXT,
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
  -- Continuité de session, choisie PAR OBJECTIF : utile sur une boucle
  -- d'itérations, dangereuse ailleurs — un agent qui reprend peut « se
  -- souvenir » d'avoir prouvé quelque chose sans produire de preuve neuve.
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
  -- L'étiquette courte ET la mission intégrale. Ne garder que la première
  -- empêchait de relire l'ordre reçu pour juger si l'ordre était mauvais ou
  -- l'exécution : on a perdu 500 caractères de contexte pour rien.
  summary      TEXT,
  mission      TEXT,
  said         TEXT,
  tools_used   TEXT,
  verdict      TEXT CHECK (verdict IS NULL OR verdict IN ('advanced','no_progress','halted','failed')),
  -- Une tentative empêchée n'a pas essayé : permissions refusées, plafond
  -- d'usage, sonde de diagnostic. Elle ne compte dans aucun garde-fou.
  prevented    INTEGER NOT NULL DEFAULT 0,
  prevented_by TEXT,
  git_before   TEXT,
  git_after    TEXT,
  cost_usd     REAL NOT NULL DEFAULT 0,
  tokens       INTEGER NOT NULL DEFAULT 0,
  requests     INTEGER NOT NULL DEFAULT 0,
  -- Dates en TEXT : en MySQL, la première colonne TIMESTAMP recevait un
  -- ON UPDATE implicite qui réécrivait l'heure de début à chaque écriture.
  -- Toutes les durées mesurées étaient du bruit.
  -- D'où vient la session, et de quoi elle hérite. Affiché : le lecteur doit
  -- savoir quand la mission n'était pas toute l'histoire.
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
                 'no_new_proof','budget','human_request','verdict_rejected','children_open','error')),
  detail       TEXT,
  -- Combien de preuves existaient au moment de l'arrêt. C'est ce repère qui
  -- permet de dire « rien de neuf depuis le refus » sans dépendre de l'horloge.
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
  -- pas son contenu. Une base qui grossit de plusieurs mégaoctets par capture
  -- cesse d'être copiable, et c'est tout l'intérêt d'un fichier unique.
  path         TEXT,
  sha256       TEXT,
  included     INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Noms repris tels quels de l'ancien socle. Renommer des colonnes pendant un
-- portage, pour l'élégance, c'est exactement la faute qu'on a payée toute la
-- journée d'hier : la règle devient juste et la matière devient fausse.
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
  -- Le motif d'outil tel que le harnais l'écrit, ex. « Bash(git *) ».
  pattern    TEXT NOT NULL,
  label      TEXT,
  decision   TEXT NOT NULL DEFAULT 'ask' CHECK (decision IN ('allow','deny','ask')),
  note       TEXT,
  -- Combien de fois un agent l'a réclamé, et quand la dernière fois : c'est ce
  -- qui fait remonter les refus utiles en haut de l'écran des autorisations.
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
  -- La NATURE de l'accès, jamais la commande : le binaire et ses options
  -- restent locaux, pour qu'un serveur hébergé ne puisse rien faire exécuter.
  reach       TEXT NOT NULL DEFAULT 'cli' CHECK (reach IN ('cli','browser','api')),
  role        TEXT NOT NULL DEFAULT 'executant' CHECK (role IN ('executant','juge','both')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 50,
  api_key     TEXT,          -- chiffrée au repos, jamais renvoyée au navigateur
  settings    TEXT,
  -- Ce que l'agent sait FAIRE, au-delà d'exécuter ou juger : image, 3d, render,
  -- code. C'est ce qui permet à une mission de dire « pour les images, utilise
  -- celui-ci » plutôt que de laisser l'exécutant deviner.
  capabilities TEXT,
  -- Le NOM de la variable d'environnement qui porte son secret. La valeur reste
  -- sur la machine : un serveur hébergé ne détient jamais la clé d'un tiers.
  env_var     TEXT,
  endpoint    TEXT,
  -- Joignabilité MESURÉE sur une machine, jamais déclarée depuis un formulaire.
  last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN ('ok','absent','refused','unknown')),
  last_detail TEXT,
  last_machine TEXT,
  last_checked_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Analyse des mémoires d'IA présentes sur la machine. L'inventaire est gratuit
-- et se refait à volonté ; la distillation coûte un appel de modèle par projet,
-- donc elle se demande, ne se déclenche pas toute seule.
CREATE TABLE IF NOT EXISTS scans (
  id         INTEGER PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','running','inventoried','analysed','applied','failed')),
  -- Ce qui a été TROUVÉ : chemins, tailles, dates, projet deviné. Toujours
  -- montré avant d'envoyer quoi que ce soit à un modèle — ces fichiers
  -- contiennent des noms de serveurs, des bases, des notes personnelles.
  inventory  TEXT,
  -- Ce qui en a été TIRÉ, par projet. Une proposition, jamais appliquée seule.
  result     TEXT,
  error      TEXT,
  machine    TEXT,
  taken_at   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stockages distants pour les preuves. On y envoie les fichiers déjà produits
-- afin qu'un coéquipier puisse les lire sans avoir le dépôt. Les identifiants
-- sont chiffrés au repos ; ils vivent ici et non sur la machine, parce que
-- c'est le serveur qui envoie — c'est le prix du partage, assumé.
CREATE TABLE IF NOT EXISTS storages (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL CHECK (provider IN ('gdrive','dropbox')),
  label       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  -- Où déposer : un identifiant de dossier Drive, ou un chemin Dropbox.
  target      TEXT,
  -- JSON chiffré : clé de compte de service Google, ou jeton d'application.
  credentials TEXT,
  last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN ('ok','refused','absent','unknown')),
  last_detail TEXT,
  last_sync_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Où chaque preuve a été déposée. Une ligne par couple preuve/stockage : la
-- même preuve peut vivre sur Drive et sur Dropbox, et l'absence de ligne dit
-- clairement « pas encore envoyée » au lieu de le laisser deviner.
CREATE TABLE IF NOT EXISTS evidence_remotes (
  id          INTEGER PRIMARY KEY,
  evidence_id INTEGER NOT NULL REFERENCES evidences(id) ON DELETE CASCADE,
  storage_id  INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
  remote_id   TEXT,
  remote_url  TEXT,
  octets      INTEGER,
  sha256      TEXT,
  sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (evidence_id, storage_id)
);
