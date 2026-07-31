import axios from 'axios'

export const http = axios.create({
  // One server holds both the interface AND the API: a relative path follows
  // whatever port it was started on, with nothing to configure.
  baseURL: import.meta.env.VITE_API_URL ?? '/api',
})

export type BlastRadius = 'cosmetic' | 'feature' | 'api' | 'critical'
export type ObjectiveStatus = 'draft' | 'ready' | 'in_progress' | 'blocked' | 'proven' | 'abandoned'
export type Harness = 'claude' | 'codex' | 'gpt' | 'human'
export type Verdict = 'advanced' | 'no_progress' | 'halted' | 'failed'
export type EvidenceType = 'test' | 'e2e' | 'screenshot' | 'render' | 'diff' | 'invariant' | 'manual'
export type HaltReason =
  | 'no_provable_criterion'
  | 'blast_radius'
  | 'piege_rule'
  | 'invariant_regression'
  | 'no_new_proof'
  | 'budget'
  | 'human_request'
  | 'verdict_rejected'
  | 'children_open'
  // Every turn re-reads the whole thread, so a long one gets slower, dearer, and
  // worse at remembering its own rules. A fresh conversation is the only way out.
  | 'judge_conversation_full'
  /** Repeated attempts, no passing proof: trying again changes nothing on its own. */
  | 'not_converging'
  | 'error'

export interface Project {
  id: number
  slug: string
  name: string
  repo_path: string | null
  gate_judge?: string
  judge_agent?: string | null
  judge_url?: string | null
  /** How many exchanges the thread may carry before we stop and ask for a fresh one. */
  judge_message_cap?: number
  /** How full it was the last time a loop looked. Measured, never declared. */
  judge_messages_seen?: number | null
  judge_seen_at?: string | null
}

export interface Evidence {
  id: number
  passage_id: number | null
  type: EvidenceType
  label: string
  ref: string | null
  verdict: 'pass' | 'fail' | 'inconclusive'
  created_at: string
  files?: string[]
}

export interface Passage {
  id: number
  objective_id: number
  harness: Harness
  summary: string | null
  mission: string | null
  verdict: Verdict | null
  git_before: string | null
  git_after: string | null
  cost_usd: string | null
  tokens: number | null
  requests: number
  said: string | null
  tools_used: Record<string, number> | null
  prevented: boolean
  prevented_by: string | null
  session_id: string | null
  resumed_from: string | null
  started_at: string
  ended_at: string | null
  evidences: Evidence[]
}

export interface Halt {
  id: number
  reason: HaltReason
  detail: string | null
  resolved_at: string | null
  created_at: string
}

export interface Objective {
  id: number
  project_id: number
  parent_id: number | null
  title: string
  intent: string | null
  proof_spec: string | null
  blast_radius: BlastRadius
  status: ObjectiveStatus
  priority: number
  proven_at: string | null
  resume_mode?: 'new' | 'last' | 'named'
  resume_session?: string | null
  last_session?: string | null
  live_since?: string | null
  last_activity?: string | null
  halt_reason?: string | null
  harnesses?: string | null
  artifacts_count?: number
  passages_count?: number
  evidences_count?: number
  open_halts_count?: number
  gate?: { ok: boolean; reason: string | null; detail: string | null; ready?: boolean }
  passages?: Passage[]
  halts?: Halt[]
  evidences?: Evidence[]
  children?: Objective[]
}

export interface Decision {
  id: number
  title: string
  body: string
  paths: string[]
  decided_at: string
  objective_id: number | null
}

export interface Workflow {
  id: number
  project_id: number
  name: string
  description: string | null
  steps: { do: string; label?: string; harness?: string }[]
  stop_when: {
    halts?: string[]
    budget?: number
    budget_sans_progres?: number
    max_turns?: number
    tours_steriles?: number
  } | null
  absorb: string[] | null
  active: boolean
}

export interface ProposedStep {
  title: string
  proof_spec?: string | null
  blast_radius?: BlastRadius | null
}

export interface Brief {
  id: number
  project_id: number
  body: string
  status: 'pending' | 'running' | 'proposed' | 'applied' | 'failed'
  proposal: { chapter: string; intent?: string | null; steps: ProposedStep[] } | null
  error: string | null
  harness: string | null
  created_at: string
}

export interface Agent {
  id: number
  name: string
  label: string
  /** What it IS: a model, a machine billed by the hour, a service, a web interface. */
  /** `source` supplies material rather than work: an asset library, a store. */
  kind: 'model' | 'machine' | 'service' | 'browser' | 'source' | null
  reach: 'cli' | 'browser' | 'api'
  role: 'executant' | 'judge' | 'both'
  enabled: boolean
  priority: number
  settings: Record<string, any> | null
  has_key: boolean
  key_hint: string | null
  last_status: 'ok' | 'absent' | 'refused' | 'unknown'
  last_detail: string | null
  last_machine: string | null
  last_checked_at: string | null
}

export interface Scan {
  id: number
  status: 'pending' | 'running' | 'inventoried' | 'analysed' | 'applied' | 'failed'
  inventory: {
    total: number
    bytes: number
    projects: Record<string, { count: number; bytes: number; files: string[] }>
  } | null
  result: Record<
    string,
    {
      title?: string
      context?: string
      constraints?: string[]
      contradictions?: string[]
      stale?: string[]
      sources?: string[]
      sources_count?: number
      skipped_count?: number
      written_to?: string
      error?: string
    }
  > | null
  error: string | null
  machine: string | null
  created_at: string
  taken_at?: string | null
  fingerprint?: string | null
  waiting_minutes?: number | null
  stale?: boolean
}

export interface Activity {
  type: 'live' | 'attempt' | 'verdict' | 'halt'
  at: string
  objective_id: number
  objective_title: string | null
  project: string | null
  harness?: string
  verdict?: string | null
  cost_usd?: number | string | null
  tokens?: number | null
  prevented?: number
  prevented_by?: string | null
  resumed_from?: string | null
  summary?: string | null
  started_at?: string
  ended_at?: string | null
  label?: string
  payload?: { judged_by?: string } | null
  reason?: string
  detail?: string | null
  resolved_at?: string | null
}

/** What is in the way, derived from traces — never typed. Every entry names its action. */
export interface Blocker {
  kind: string
  /** The same title without the project's name, so N projects share one card. */
  group?: string
  severity: 'blocking' | 'warning'
  project: string | null
  objective: number | null
  title: string
  detail: string
  action: string
  since: string | null
}

export type TreeAttempt = {
  id: number
  harness: string
  verdict: string | null
  prevented: number
  cost_usd: number | string | null
  tokens: number | null
  started_at: string
  ended_at: string | null
  files: number
}

export type TreeNode = {
  id: number
  parent_id: number | null
  title: string
  status: string
  priority: number
  blast_radius: string
  proof_spec: string | null
  live_since: string | null
  halt_reason: string | null
  artifacts_count: number
  attempts: TreeAttempt[]
}

/** An MCP server, as each harness's own configuration declares it. */
export interface McpServer {
  name: string
  /** `UnityMCP` and `unityMCP` are one server; the harnesses use them verbatim. */
  aliases: string[]
  versions: string[]
  disagrees: boolean
  entries: {
    harness: string
    /** The project path it is declared for, or null when it is global. */
    scope: string | null
    name: string
    command: string | null
    pin: { package: string; version: string } | null
  }[]
}

/** A file a PERSON put into the process — a mock-up, a screenshot of what broke. */
export interface Attachment {
  id: number
  project_id: number
  kind: 'brief' | 'run' | 'project'
  owner_id: number | null
  name: string
  mime: string | null
  bytes: number
  /** Absolute path on this machine: it is what a pass is told to open. */
  path: string
  note: string | null
  created_at: string
}

/** The state of the installation, measured on request — never a stored answer. */
export interface Setup {
  controller: 'claude' | 'codex' | 'none' | null
  walkthrough_done: boolean
  harnesses: { claude: string | null; codex: string | null }
  /** `signedIn` is null when the browser could not be reached — not the same as false. */
  browser: { listening: boolean; judgeTab: string | null; signedIn: boolean | null; port: number }
  projects: {
    slug: string
    name: string
    repo_path: string | null
    repo_exists: boolean
    has_judge: boolean
    allowed_tools: number
  }[]
  storages: number
  workers_seen: number
}

/** A run the interface asked for; a local worker carries it out. */
export interface Run {
  id: number
  project: string
  project_id: number
  objective_id: number | null
  objective_title: string | null
  mode: 'chapter' | 'plan'
  max_turns: number
  budget: number | null
  budget_without_progress: number
  post: boolean
  hold_between_turns: boolean
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  cancel_asked: boolean
  /** Slipped in front of what was already waiting. */
  jump: boolean
  /** Part of a series that drops what follows it when it fails. */
  series_stops_on_failure: boolean
  /** Queued knowingly beside another pass in the same checkout. */
  alongside: boolean
  /** Why it was slipped in front — written when it was queued. */
  reason: string | null
  machine: string | null
  turn: number
  note: string | null
  error: string | null
  requested_at: string
  taken_at: string | null
  ended_at: string | null
}

/** What is connected, and what is actually used. Both derived, neither declared. */
export interface Wiring {
  agents: {
    name: string
    label: string
    kind: 'model' | 'machine' | 'service' | 'browser' | null
    reach: string
    role: string
    enabled: boolean
    capabilities: string[]
    reachable: 'ok' | 'refused' | 'absent' | 'unknown'
    detail: string | null
    checked_at: string | null
    machine: string | null
    passes: number
  }[]
  servers: {
    name: string
    calls: number
    tools: { tool: string; calls: number; by: Record<string, number> }[]
  }[]
}

export interface Storage {
  id: number
  provider: 'gdrive' | 'dropbox'
  label: string
  enabled: boolean
  target: string | null
  has_credentials: boolean
  last_status: 'ok' | 'refused' | 'absent' | 'unknown'
  last_detail: string | null
  last_sync_at: string | null
  uploads: number
  /** How we authenticate: a connected account is not fixed the same way a key is. */
  auth_kind: 'oauth' | 'service_account' | 'token' | null
  /** Who the connected account belongs to — derived from the token, never typed. */
  account: string | null
  /** Is the OAuth app registered on this machine? */
  oauth_ready: boolean
}

export interface Stats {
  objectives: Record<ObjectiveStatus, number>
  proven_ratio: number
  passages: number
  halts_by_reason: Record<string, number>
  harness_split: Record<string, number>
  tokens: number
  requests: number
  cost_usd: number
  awaiting_human: number
}

export interface ProjectRollup {
  slug: string
  name: string
  repo_path: string | null
  objectives: Partial<Record<ObjectiveStatus, number>>
  total_objectives: number
  proven: number
  awaiting_human: number
  passages: number
  tokens: number
  requests: number
  cost_usd: number
  last_activity: string | null
  invariants: { total: number; breached: number; unknown: number }
}

export interface Dashboard {
  projects: ProjectRollup[]
  totals: {
    projects: number
    objectives: number
    proven: number
    awaiting_human: number
    passages: number
    tokens: number
    requests: number
    cost_usd: number
  }
  halts_by_reason: { reason: HaltReason; n: number; open: number }[]
  harness_split: { harness: Harness; n: number; tokens: number; cost: number }[]
  open_halts: {
    id: number
    reason: HaltReason
    detail: string | null
    created_at: string
    objective_id: number
    objective_title: string | null
    blast_radius: BlastRadius | null
    project: string | null
  }[]
  recent: {
    id: number
    harness: Harness
    verdict: Verdict | null
    tokens: number | null
    cost_usd: string | null
    started_at: string
    ended_at: string | null
    summary: string | null
    objective_id: number
    objective_title: string | null
    project: string | null
  }[]
  invariants: {
    id: number
    project: string | null
    name: string
    statement: string
    last_value: string | null
    last_status: 'ok' | 'breached' | 'unknown'
    last_checked_at: string | null
    armed: boolean
  }[]
}

export interface ResourceItem {
  id: number
  objective_id: number | null
  name: string
  kind: 'image' | 'markdown' | 'text' | 'data' | 'other'
  mime: string | null
  size: number
  summary: string | null
  included: boolean
  created_at: string
}

export interface ReviewLine {
  id: number
  title: string
  project: string | null
  gate_judge: string | null
  blast_radius: BlastRadius
  status: ObjectiveStatus
  proof_spec: string | null
  evidences_pass: number
  evidences_fail: number
  passages: number
  cost_usd: number
  reason: string | null
  detail: string | null
}

export interface Review {
  ready: ReviewLine[]
  in_progress: ReviewLine[]
  counts: { ready: number; in_progress: number }
}

export const api = {
  review: () => http.get<Review>('/review').then((r) => r.data),
  verdict: (id: number, decision: 'accept' | 'reject') =>
    http.post(`/objectives/${id}/verdict/${decision}`).then((r) => r.data),

  projects: () => http.get<Project[]>('/projects').then((r) => r.data),
  objectives: (slug: string) =>
    http.get<Objective[]>(`/projects/${slug}/objectives`).then((r) => r.data),
  objective: (id: number | string) => http.get<Objective>(`/objectives/${id}`).then((r) => r.data),
  stats: (slug: string) => http.get<Stats>(`/projects/${slug}/stats`).then((r) => r.data),
  graph: (slug: string) => http.get<{ mermaid: string }>(`/projects/${slug}/graph`).then((r) => r.data),
  decisions: (slug: string) => http.get<Decision[]>(`/projects/${slug}/decisions`).then((r) => r.data),
  createObjective: (slug: string, payload: Partial<Objective>) =>
    http.post<Objective>(`/projects/${slug}/objectives`, payload).then((r) => r.data),
  updateObjective: (id: number, payload: Partial<Objective>) =>
    http.patch<Objective>(`/objectives/${id}`, payload).then((r) => r.data),
  resolveHalt: (id: number) => http.patch<Halt>(`/halts/${id}/resolve`).then((r) => r.data),

  // Reorder in a single call: sending N patches would leave the order half
  // applied if one of them fails on the way.
  reorderObjectives: (slug: string, ordre: { id: number; priority: number }[]) =>
    http.patch(`/projects/${slug}/objectives/reorder`, { ordre }).then((r) => r.data),

  /** Clear the open halts of one KIND on an objective — `resolveHalt` above takes an id. */
  clearHalts: (objectiveId: number, reason: string) =>
    http.post(`/objectives/${objectiveId}/halts/resolve`, { reason }).then((r) => r.data),

  mcp: () => http.get<McpServer[]>('/mcp').then((r) => r.data),

  attachments: (slug: string, kind?: string, ownerId?: number) =>
    http
      .get<Attachment[]>(`/projects/${slug}/attachments`, { params: { kind, owner_id: ownerId } })
      .then((r) => r.data),
  addAttachment: (
    slug: string,
    payload: { kind: string; owner_id?: number; name: string; mime: string; data: string; note?: string },
  ) => http.post<Attachment>(`/projects/${slug}/attachments`, payload).then((r) => r.data),
  removeAttachment: (id: number) => http.delete(`/attachments/${id}`).then((r) => r.data),
  attachmentUrl: (id: number, w?: number) =>
    `${http.defaults.baseURL}/attachments/${id}/file${w ? `?w=${w}` : ''}`,

  /** Queue several objectives to run one after another. Whole, or not at all. */
  startSeries: (
    slug: string,
    payload: {
      objectives: number[]
      stop_on_failure?: boolean
      max_turns?: number
      budget_without_progress?: number
      post?: boolean
      alongside?: boolean
    },
  ) =>
    http
      .post<{ queued: number[]; objectives: number[] }>(`/projects/${slug}/runs/series`, payload)
      .then((r) => r.data),

  setup: () => http.get<Setup>('/setup').then((r) => r.data),
  /** Fill a project's empty rule list from one that already works. Existing rules win. */
  copyPermissions: (slug: string, from: string) =>
    http
      .post<{ added: number; from: string; skipped: number }>(`/projects/${slug}/permissions/copy`, { from })
      .then((r) => r.data),
  saveSetup: (payload: { controller?: string; walkthrough_done?: boolean }) =>
    http.patch('/setup', payload).then((r) => r.data),

  updateProject: (slug: string, payload: Partial<Project>) =>
    http.patch<Project>(`/projects/${slug}`, payload).then((r) => r.data),

  activity: (slug?: string) =>
    http
      .get<{ live: Activity[]; feed: Activity[] }>(`/activity${slug ? `?project=${slug}` : ''}`)
      .then((r) => r.data),

  blockers: () => http.get<Blocker[]>('/blockers').then((r) => r.data),
  createProject: (payload: {
    slug: string
    name: string
    repo_path?: string
    judge_url?: string
    gate_judge?: string
  }) => http.post<Project>('/projects', payload).then((r) => r.data),
  wiring: () => http.get<Wiring>('/wiring').then((r) => r.data),

  runs: (slug?: string) =>
    http.get<Run[]>(`/runs${slug ? `?project=${slug}` : ''}`).then((r) => r.data),
  startRun: (
    slug: string,
    payload: {
      objective?: number
      mode?: 'chapter' | 'plan' | 'judge'
      max_turns?: number
      budget?: number | null
      budget_without_progress?: number
      post?: boolean
      jump?: boolean
      alongside?: boolean
      reason?: string
      hold_between_turns?: boolean
    },
  ) => http.post<Run>(`/projects/${slug}/runs`, payload).then((r) => r.data),
  cancelRun: (id: number) => http.post<Run>(`/runs/${id}/cancel`).then((r) => r.data),
  continueRun: (id: number) => http.post<Run>(`/runs/${id}/continue`).then((r) => r.data),
  /** The project branched: chapters, their steps, and every attempt each one took. */
  tree: (slug: string) =>
    http
      .get<{ project: { slug: string; name: string }; objectives: TreeNode[] }>(
        `/projects/${slug}/tree`,
      )
      .then((r) => r.data),
  storages: () => http.get<Storage[]>('/storages').then((r) => r.data),
  createStorage: (payload: { provider: string; label: string; target?: string | null; credentials?: unknown }) =>
    http.post<Storage>('/storages', payload).then((r) => r.data),
  updateStorage: (id: number, payload: Record<string, unknown>) =>
    http.patch<Storage>(`/storages/${id}`, payload).then((r) => r.data),
  deleteStorage: (id: number) => http.delete(`/storages/${id}`).then(() => undefined),
  prepareStorage: (id: number, payload?: { name?: string; partager_avec?: string }) =>
    http
      .post<{ folder: { id: string; name: string; url: string; sharedWith: string | null } }>(
        `/storages/${id}/prepare`,
        payload ?? {},
      )
      .then((r) => r.data),
  connectStorage: (id: number) =>
    http.post<{ url: string; provider: string }>(`/storages/${id}/connect`).then((r) => r.data),
  runCheck: (id: number) => http.post<Storage>(`/storages/${id}/check`).then((r) => r.data),
  syncStorage: (id: number) =>
    http
      .post<{ uploaded: { file: string; url: string | null }[]; failures: { file: string; error: string }[]; remaining: number }>(
        `/storages/${id}/sync`,
      )
      .then((r) => r.data),

  scans: () => http.get<Scan[]>('/scans').then((r) => r.data),
  createScan: () => http.post<Scan>('/scans').then((r) => r.data),
  createProjectFromScan: (
    id: number,
    payload: { slug: string; name?: string; repo_path?: string | null; title?: string; body: string; sources?: string[] },
  ) => http.post<Project>(`/scans/${id}/creer`, payload).then((r) => r.data),
  applyScan: (id: number, slug: string, payload: { title?: string; body: string; sources?: string[] }) =>
    http.post(`/scans/${id}/apply/${slug}`, payload).then((r) => r.data),
  deleteScan: (id: number) => http.delete(`/scans/${id}`).then(() => undefined),

  agents: () => http.get<Agent[]>('/agents').then((r) => r.data),
  createAgent: (payload: Partial<Agent> & { api_key?: string }) =>
    http.post<Agent>('/agents', payload).then((r) => r.data),
  updateAgent: (id: number, payload: Partial<Agent> & { api_key?: string }) =>
    http.patch<Agent>(`/agents/${id}`, payload).then((r) => r.data),
  deleteAgent: (id: number) => http.delete(`/agents/${id}`).then(() => undefined),
  reorderAgents: (ordre: { id: number; priority: number }[]) =>
    http.patch('/agents/reorder', { ordre }).then((r) => r.data),

  briefs: (slug: string) => http.get<Brief[]>(`/projects/${slug}/briefs`).then((r) => r.data),
  createBrief: (slug: string, body: string) =>
    http.post<Brief>(`/projects/${slug}/briefs`, { body }).then((r) => r.data),
  brief: (id: number) => http.get<Brief>(`/briefs/${id}`).then((r) => r.data),
  applyBrief: (
    id: number,
    payload: { chapter: string; intent?: string | null; steps: ProposedStep[] },
  ) => http.post<Objective>(`/briefs/${id}/apply`, payload).then((r) => r.data),
  deleteBrief: (id: number) => http.delete(`/briefs/${id}`).then(() => undefined),

  workflows: (slug: string) => http.get<Workflow[]>(`/projects/${slug}/workflows`).then((r) => r.data),
  createWorkflow: (slug: string, payload: Partial<Workflow>) =>
    http.post<Workflow>(`/projects/${slug}/workflows`, payload).then((r) => r.data),
  updateWorkflow: (id: number, payload: Partial<Workflow>) =>
    http.patch<Workflow>(`/workflows/${id}`, payload).then((r) => r.data),
  deleteWorkflow: (id: number) => http.delete(`/workflows/${id}`).then(() => undefined),

  dashboard: () => http.get<Dashboard>('/dashboard').then((r) => r.data),
  // `w` asks for a thumbnail: without it we serve the original, which weighs
  // several megabytes and leaves the proof grid blank while it arrives. The
  // viewer, on the other hand, wants full resolution.
  evidenceFileUrl: (id: number, n = 0, w?: number) =>
    `${http.defaults.baseURL}/evidences/${id}/file?n=${n}${w ? `&w=${w}` : ''}`,

  resources: (slug: string) =>
    http.get<ResourceItem[]>(`/projects/${slug}/resources`).then((r) => r.data),
  uploadResource: (slug: string, file: File, summary: string) => {
    const form = new FormData()
    form.append('file', file)
    if (summary) form.append('summary', summary)
    return http.post<ResourceItem>(`/projects/${slug}/resources`, form).then((r) => r.data)
  },
  updateResource: (id: number, payload: Partial<ResourceItem>) =>
    http.patch<ResourceItem>(`/resources/${id}`, payload).then((r) => r.data),
  deleteResource: (id: number) => http.delete(`/resources/${id}`).then(() => undefined),
  resourceUrl: (id: number) => `${http.defaults.baseURL}/resources/${id}/raw`,
}
