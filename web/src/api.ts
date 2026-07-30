import axios from 'axios'

export const http = axios.create({
  // Le serveur sert l'interface ET l'API : un chemin relatif suit le port
  // sur lequel on l'a lancé, sans rien à configurer.
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
  | 'error'

export interface Project {
  id: number
  slug: string
  name: string
  repo_path: string | null
  gate_judge?: string
  judge_agent?: string | null
  judge_url?: string | null
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
  reach: 'cli' | 'browser' | 'api'
  role: 'executant' | 'juge' | 'both'
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
    octets: number
    projets: Record<string, { nombre: number; octets: number; fichiers: string[] }>
  } | null
  result: Record<
    string,
    {
      titre?: string
      contexte?: string
      contraintes?: string[]
      contradictions?: string[]
      perime?: string[]
      sources?: string[]
      sources_nombre?: number
      laisses_nombre?: number
      releve_sous?: string
      erreur?: string
    }
  > | null
  error: string | null
  machine: string | null
  created_at: string
  taken_at?: string | null
  fingerprint?: string | null
  attente_minutes?: number | null
  perime?: boolean
}

export interface Activite {
  type: 'en_cours' | 'tentative' | 'verdict' | 'arret'
  quand: string
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
  envois: number
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

  // Réordonner d'un seul appel : envoyer N patchs laisserait l'ordre à moitié
  // appliqué si l'un d'eux échoue en route.
  reorderObjectives: (slug: string, ordre: { id: number; priority: number }[]) =>
    http.patch(`/projects/${slug}/objectives/reorder`, { ordre }).then((r) => r.data),

  updateProject: (slug: string, payload: Partial<Project>) =>
    http.patch<Project>(`/projects/${slug}`, payload).then((r) => r.data),

  activity: (slug?: string) =>
    http
      .get<{ en_cours: Activite[]; fil: Activite[] }>(`/activity${slug ? `?project=${slug}` : ''}`)
      .then((r) => r.data),

  storages: () => http.get<Storage[]>('/storages').then((r) => r.data),
  createStorage: (payload: { provider: string; label: string; target?: string | null; credentials?: unknown }) =>
    http.post<Storage>('/storages', payload).then((r) => r.data),
  updateStorage: (id: number, payload: Record<string, unknown>) =>
    http.patch<Storage>(`/storages/${id}`, payload).then((r) => r.data),
  deleteStorage: (id: number) => http.delete(`/storages/${id}`).then(() => undefined),
  prepareStorage: (id: number, payload?: { nom?: string; partager_avec?: string }) =>
    http
      .post<{ dossier: { id: string; nom: string; url: string; partage: string | null } }>(
        `/storages/${id}/prepare`,
        payload ?? {},
      )
      .then((r) => r.data),
  checkStorage: (id: number) => http.post<Storage>(`/storages/${id}/check`).then((r) => r.data),
  syncStorage: (id: number) =>
    http
      .post<{ envoyes: { fichier: string; url: string | null }[]; echecs: { fichier: string; erreur: string }[]; restant: number }>(
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
  // `w` demande une vignette : sans lui on sert l'original, qui pèse
  // plusieurs mégaoctets et laisse la grille de preuves vide le temps qu'il
  // arrive. La visionneuse, elle, veut la pleine résolution.
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
