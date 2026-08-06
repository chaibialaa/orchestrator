<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

type Project = {
  uid: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  objectives: number;
  open_blockers: number;
  proofs: number;
};
type Objective = {
  uid: string;
  id: number;
  title: string;
  status: string;
  priority: number;
  event_count: number;
  evidence_count: number;
  last_activity: string | null;
  parent_id: number | null;
};
type Chapter = Objective & {
  objective_count: number;
  proven_count: number;
  progress: number;
  children: Objective[];
};
type Event = {
  uid: string;
  kind: string;
  assertion: string;
  summary: string;
  occurred_at: string;
  actor: string;
  objective_title: string | null;
};
type Evidence = {
  uid: string;
  label: string;
  type: string;
  origin: string;
  locator_kind: string;
  locator: string | null;
  sha256: string | null;
  bytes: number | null;
  retention: string;
  status: string;
  created_at: string;
  objective_title: string | null;
  pass_ref: string | null;
};
type Detail = Omit<Project, "objectives"> & {
  objectives: Objective[];
  chapters: Chapter[];
  blockers: Array<{ uid: string; title: string; detail: string | null; objective_id: number; objective_uid: string | null; objective_title: string | null; pass_ref: string | null }>;
  decisions: Array<{ uid: string; title: string; body: string }>;
  judgment_requests: Array<{
    uid: string;
    objective_id: number;
    summary: string;
    occurred_at: string;
  }>;
};
type SyncConnection = {
  provider: string;
  label: string;
  enabled: number;
  last_status: string;
  last_detail: string | null;
  last_pull_at: string | null;
  last_push_at: string | null;
  shard_count: number;
  pending_events: number;
};
type DiagramNode = {
  id: string;
  label: string;
  status: string;
  phase: string;
  priority: number;
  evidence_count: number;
  fail_count: number;
  blocker_count: number;
};
type Diagram = {
  project: { name: string };
  nodes: DiagramNode[];
  edges: Array<{ from: string; to: string; type: string }>;
};

const projects = ref<Project[]>([]),
  selected = ref(""),
  detail = ref<Detail | null>(null),
  events = ref<Event[]>([]),
  evidence = ref<Evidence[]>([]);
const connections = ref<SyncConnection[]>([]),
  syncing = ref("");
const diagram = ref<Diagram | null>(null),
  coordination = ref<any>({
    active: [],
    recent: [],
    latest_git: null,
    counts: { active: 0, stale: 0, conflicts: 0, abandoned: 0 },
  }),
  localMemory = ref<any>(null),
  portfolio = ref<any>(null),
  portfolioBusy = ref(false),
  analytics = ref<any>(null),
  analyticsBusy = ref(false),
  memoryBusy = ref(false);
const activeView = ref<
    "projects" | "overview" | "chapters" | "evidence" | "diagram" | "analytics" | "memory"
  >("overview"),
  selectedChapter = ref(""),
  selectedPass = ref(""),
  query = ref(""),
  assertion = ref(""),
  loading = ref(true),
  error = ref("");
const openPreview = ref(""),
  textPreviews = ref<Record<string, string>>({}),
  previewErrors = ref<Record<string, string>>({});
const previewImage = ref<Evidence | null>(null);
const verification = ref<Record<string, any>>({}),
  verifying = ref(""),
  comparisonIndex = ref(0);
const evidenceType = ref<"all" | "images" | "text">("all"),
  evidencePage = ref(1),
  passPage = ref(1),
  eventPage = ref(1);
const judgmentText = ref(""),
  judgmentVerdict = ref<"pass" | "fail" | "inconclusive">("inconclusive"),
  judgmentBusy = ref(false);
const api = async <T,>(path: string): Promise<T> => {
  const response = await fetch(`/api${path}`);
  if (!response.ok) throw new Error((await response.json()).message);
  return response.json();
};
async function loadProjects() {
  projects.value = await api("/projects");
  connections.value = await api("/sync");
  if (!selected.value && projects.value[0])
    selected.value = projects.value[0].slug;
}
async function loadPortfolio() {
  portfolioBusy.value = true;
  try {
    portfolio.value = await api("/portfolio");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    portfolioBusy.value = false;
  }
}
async function loadAnalytics() {
  if (!selected.value) return;
  analyticsBusy.value = true;
  try {
    analytics.value = await api(`/analytics?project=${selected.value}&days=30`);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    analyticsBusy.value = false;
  }
}
const compactNumber=(value:number)=>new Intl.NumberFormat("en",{notation:"compact",maximumFractionDigits:1}).format(value||0)
const money=(value:number)=>new Intl.NumberFormat("en",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(value||0)
const maxDailyCost=computed(()=>Math.max(0,...(analytics.value?.daily||[]).map((row:any)=>row.cost)))
const maxDailyTokens=computed(()=>Math.max(0,...(analytics.value?.daily||[]).map((row:any)=>row.tokens)))
const todayAnalytics=computed(()=>analytics.value?.daily?.find((row:any)=>row.key===new Date().toISOString().slice(0,10))||null)
function openPortfolioProject(project: any) {
  selected.value = project.slug;
  activeView.value = "overview";
}
async function setPortfolioTracking(project: any) {
  const status = project.status === "archived" ? "active" : "archived";
  portfolioBusy.value = true;
  try {
    const response = await fetch("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `portfolio-status:${project.uid}:${status}:${Date.now()}` },
      body: JSON.stringify({ project: project.slug, kind: "project.updated", actor_kind: "human", actor: "dashboard", assertion: "human_judgment", summary: `Project tracking ${status}`, payload: { status } }),
    });
    if (!response.ok) throw new Error((await response.json()).message);
    await loadProjects();
    await loadPortfolio();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    portfolioBusy.value = false;
  }
}
async function loadProject() {
  if (!selected.value) return;
  loading.value = true;
  error.value = "";
  try {
    [detail.value, diagram.value, coordination.value] = await Promise.all([
      api<Detail>(`/projects/${selected.value}`),
      api<Diagram>(`/projects/${selected.value}/diagram`),
      api<any>(`/projects/${selected.value}/coordination`),
    ]);
    await loadMemory();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
async function loadMemory() {
  if (!selected.value) return;
  const p = new URLSearchParams();
  if (query.value) p.set("q", query.value);
  if (assertion.value) p.set("assertion", assertion.value);
  if (selectedChapter.value) p.set("objective", selectedChapter.value);
  const ep = new URLSearchParams();
  if (selectedChapter.value) ep.set("objective", selectedChapter.value);
  [events.value, evidence.value] = await Promise.all([
    api<Event[]>(`/projects/${selected.value}/timeline?${p}`),
    api<Evidence[]>(`/projects/${selected.value}/evidence?${ep}`),
  ]);
  evidencePage.value = 1;
  passPage.value = 1;
  eventPage.value = 1;
  comparisonIndex.value = 0;
}
watch(selected, () => {
  selectedChapter.value = "";
  selectedPass.value = "";
  loadProject();
  if(activeView.value==='analytics')loadAnalytics()
});
let timer: number;
watch([query, assertion, selectedChapter, selectedPass], () => {
  clearTimeout(timer);
  timer = window.setTimeout(loadMemory, 200);
});
const closeOnEscape = (event: KeyboardEvent) => {
  if (event.key === "Escape") previewImage.value = null;
  if (event.key === "ArrowLeft" && previewImage.value) moveImage(-1);
  if (event.key === "ArrowRight" && previewImage.value) moveImage(1);
};
onMounted(async () => {
  window.addEventListener("keydown", closeOnEscape);
  try {
    await loadProjects();
  } catch (e: any) {
    error.value = e.message;
    loading.value = false;
  }
});
onBeforeUnmount(() => window.removeEventListener("keydown", closeOnEscape));
const progress = computed(() => {
  const all = detail.value?.objectives || [];
  return all.length
    ? Math.round(
        (all.filter((o) => o.status === "proven").length / all.length) * 100,
      )
    : 0;
});
const assertionLabel = (v: string) =>
  ({
    measured_fact: "Measured fact",
    agent_statement: "Agent statement",
    human_judgment: "Human judgment",
    system_record: "System record",
  })[v] || v;
const date = (v: string | null) =>
  v
    ? new Date(v).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "No activity yet";
const bytes = (v: number | null) =>
  v == null
    ? "Unknown size"
    : v < 1024
      ? `${v} B`
      : v < 1048576
        ? `${(v / 1024).toFixed(1)} KB`
        : `${(v / 1048576).toFixed(1)} MB`;
const previewUrl = (proof: Evidence) => `/api/evidence/${proof.uid}/content`;
const isImage = (proof: Evidence) =>
  /\.(png|jpe?g|webp|gif)$/i.test(proof.locator || "");
const isText = (proof: Evidence) =>
  /\.(txt|md|json|csv|log)$/i.test(proof.locator || "");
async function previewText(proof: Evidence) {
  if (openPreview.value === proof.uid) {
    openPreview.value = "";
    return;
  }
  openPreview.value = proof.uid;
  if (textPreviews.value[proof.uid]) return;
  previewErrors.value[proof.uid] = "";
  try {
    const response = await fetch(previewUrl(proof));
    if (!response.ok) throw new Error((await response.json()).message);
    textPreviews.value[proof.uid] = await response.text();
  } catch (e: any) {
    previewErrors.value[proof.uid] = e.message;
  }
}
async function verifyProof(proof: Evidence) {
  verifying.value = proof.uid;
  try {
    verification.value[proof.uid] = await api(`/evidence/${proof.uid}/verify`);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    verifying.value = "";
  }
}
const scopedEvidence = computed(() =>
  evidence.value.filter(
    (p) =>
      (!selectedPass.value || String(p.pass_ref) === selectedPass.value) &&
      (evidenceType.value === "all" ||
        (evidenceType.value === "images" && isImage(p)) ||
        (evidenceType.value === "text" && isText(p))),
  ),
);
const previewImages = computed(() =>
  evidence.value.filter(
    (proof) => proof.status === "available" && isImage(proof),
  ),
);
const comparisonPairs = computed(() => {
  const groups = new Map<string, { before?: Evidence; after?: Evidence }>();
  for (const proof of evidence.value.filter(
    (p) => p.status === "available" && isImage(p),
  )) {
    const before = /(^|[\s_-])before(?=$|[\s_.-])/i.test(proof.label),
      after = /(^|[\s_-])after(?=$|[\s_.-])/i.test(proof.label);
    if (before === after) continue;
    const key = `${proof.objective_title}|${proof.pass_ref}|${proof.label
      .toLowerCase()
      .replace(/(^|[\s_-])(before|after)(?=$|[\s_.-])/g, "$1{state}")
      .replace(/\.(png|jpe?g|webp)$/, "")}`;
    const pair = groups.get(key) || {};
    if (before) pair.before = proof;
    if (after) pair.after = proof;
    groups.set(key, pair);
  }
  return [...groups.values()].filter(
    (pair): pair is { before: Evidence; after: Evidence } =>
      Boolean(pair.before && pair.after),
  );
});
const comparisonPair = computed(
  () => comparisonPairs.value[comparisonIndex.value] || null,
);
const previewImageIndex = computed(() =>
  previewImage.value
    ? previewImages.value.findIndex(
        (proof) => proof.uid === previewImage.value?.uid,
      )
    : -1,
);
function moveImage(direction: number) {
  if (!previewImages.value.length) return;
  const current = Math.max(0, previewImageIndex.value),
    next =
      (current + direction + previewImages.value.length) %
      previewImages.value.length;
  previewImage.value = previewImages.value[next];
}
const evidencePages = computed(() =>
  Math.max(1, Math.ceil(scopedEvidence.value.length / 20)),
);
const pagedEvidence = computed(() =>
  scopedEvidence.value.slice(
    (evidencePage.value - 1) * 20,
    evidencePage.value * 20,
  ),
);
const passGroups = computed(() => {
  const groups = new Map<string, Evidence[]>();
  for (const proof of evidence.value) {
    if (!proof.pass_ref) continue;
    const k = String(proof.pass_ref);
    groups.set(k, [...(groups.get(k) || []), proof]);
  }
  return [...groups.entries()]
    .map(([id, proofs]) => ({ id, proofs, images: proofs.filter(isImage) }))
    .sort((a, b) => Number(b.id) - Number(a.id));
});
const passPages = computed(() =>
  Math.max(1, Math.ceil(passGroups.value.length / 10)),
);
const pagedPasses = computed(() =>
  passGroups.value.slice((passPage.value - 1) * 10, passPage.value * 10),
);
const eventPages = computed(() =>
  Math.max(1, Math.ceil(events.value.length / 20)),
);
const pagedEvents = computed(() =>
  events.value.slice((eventPage.value - 1) * 20, eventPage.value * 20),
);
const judgmentRequest = computed(() => {
  const chapter = detail.value?.chapters.find(
    (c) => c.uid === selectedChapter.value,
  );
  return chapter
    ? detail.value?.judgment_requests.find(
        (request) => request.objective_id === chapter.id,
      )
    : null;
});
const blockedContext = computed(() =>
  detail.value?.blockers.find(
    (blocker) => blocker.objective_uid === selectedChapter.value,
  ),
);
const graphNodes = computed(() => {
  const roots =
    diagram.value?.nodes.filter(
      (node) =>
        !diagram.value?.edges.some(
          (edge) => edge.type === "contains" && edge.to === node.id,
        ),
    ) || [];
  return roots.map((node, index) => {
    const row = Math.floor(index / 3),
      slot = index % 3,
      col = row % 2 ? 2 - slot : slot;
    return {
      ...node,
      x: 50 + col * 330,
      y: 55 + row * 150,
      width: 260,
      height: 82,
    };
  });
});
const graphHeight = computed(() =>
  Math.max(300, Math.ceil(graphNodes.value.length / 3) * 150 + 80),
);
const graphNode = (id: string) =>
  graphNodes.value.find((node) => node.id === id);
function graphPath(edge: { from: string; to: string; type: string }) {
  const a = graphNode(edge.from),
    b = graphNode(edge.to);
  if (!a || !b) return "";
  if (edge.type === "retry")
    return `M ${a.x + a.width} ${a.y + 20} C ${a.x + a.width + 85} ${a.y - 45}, ${a.x + a.width + 85} ${a.y + a.height + 45}, ${a.x + a.width} ${a.y + a.height - 18}`;
  if (edge.type === "returns")
    return `M ${a.x} ${a.y + 40} C ${a.x - 90} ${a.y + 40}, ${b.x - 90} ${b.y + 40}, ${b.x} ${b.y + 40}`;
  return `M ${a.x + a.width / 2} ${a.y + a.height} C ${a.x + a.width / 2} ${(a.y + b.y + a.height) / 2}, ${b.x + b.width / 2} ${(a.y + b.y + a.height) / 2}, ${b.x + b.width / 2} ${b.y}`;
}
function inspectChapter(chapter: Chapter) {
  selectedChapter.value = chapter.uid;
  selectedPass.value = "";
  if (chapter.status === "blocked") {
    const blocker = detail.value?.blockers.find(
      (item) => item.objective_id === chapter.id,
    );
    if (blocker?.pass_ref) selectedPass.value = String(blocker.pass_ref);
    activeView.value = "evidence";
  } else activeView.value = "chapters";
}
async function sync(provider: string) {
  syncing.value = provider;
  error.value = "";
  try {
    await fetch(`/api/sync/${provider}`, { method: "POST" }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).message);
    });
    connections.value = await api("/sync");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    syncing.value = "";
  }
}
async function toggleProject() {
  if (!detail.value) return;
  const status = detail.value.status === "archived" ? "active" : "archived";
  const response = await fetch("/api/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": `project-status:${detail.value.uid}:${status}:${Date.now()}`,
    },
    body: JSON.stringify({
      project: detail.value.slug,
      kind: "project.updated",
      actor_kind: "human",
      actor: "dashboard",
      assertion: "human_judgment",
      summary: `Project tracking ${status}`,
      payload: { status },
    }),
  });
  if (!response.ok) throw new Error((await response.json()).message);
  await loadProjects();
  await loadProject();
}
async function scanMemory() {
  memoryBusy.value = true;
  error.value = "";
  try {
    localMemory.value = await api("/memory/local");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    memoryBusy.value = false;
  }
}
async function addDiscovered(project: any) {
  memoryBusy.value = true;
  try {
    const response = await fetch("/api/memory/local/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projects: [project] }),
    });
    if (!response.ok) throw new Error((await response.json()).message);
    await loadProjects();
    await scanMemory();
    await loadPortfolio();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    memoryBusy.value = false;
  }
}
async function recordJudgment() {
  if (!selectedChapter.value || !judgmentText.value.trim()) return;
  judgmentBusy.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `human-judgment:${selectedChapter.value}:${Date.now()}`,
      },
      body: JSON.stringify({
        project: selected.value,
        objective: selectedChapter.value,
        kind: "verdict.recorded",
        actor_kind: "human",
        actor: "dashboard user",
        assertion: "human_judgment",
        summary: judgmentText.value.trim(),
        payload: {
          verdict: judgmentVerdict.value,
          rationale: judgmentText.value.trim(),
        },
        source: "orchestrator dashboard",
      }),
    });
    if (!response.ok) throw new Error((await response.json()).message);
    judgmentText.value = "";
    judgmentVerdict.value = "inconclusive";
    await loadProject();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    judgmentBusy.value = false;
  }
}
</script>

<template>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <div class="shell">
    <aside>
      <a class="brand" href="#" @click.prevent="activeView = 'projects'; loadPortfolio()"
        ><span>O</span>
        <div>Orchestrator<small>Project memory</small></div></a
      >
      <p class="nav-title">Projects</p>
      <nav aria-label="Projects">
        <button class="all-projects" :class="{ active: activeView === 'projects' }" @click="activeView = 'projects'; loadPortfolio()"><span>All projects</span><small>Global view</small></button>
        <button
          v-for="p in projects"
          :key="p.uid"
          :class="{ active: activeView !== 'projects' && selected === p.slug }"
          :aria-current="activeView !== 'projects' && selected === p.slug ? 'page' : undefined"
          @click="selected = p.slug"
        >
          <span>{{ p.name }}</span
          ><small>{{ p.open_blockers ? `${p.open_blockers} blocked` : 'On track' }}</small>
        </button>
      </nav>
      <div class="boundary">
        <strong>Observation only</strong>
        <p>Orchestrator records state and evidence. It never executes work.</p>
      </div>
    </aside>
    <main id="main-content" tabindex="-1">
      <header>
        <div>
          <p class="eyebrow">{{ activeView === "projects" ? "Global portfolio" : "Project record" }}</p>
          <h1>{{ activeView === "projects" ? "Projects" : detail?.name || "Project memory" }}</h1>
          <p>
            {{
              activeView === "projects"
                ? "Tracked work, local discoveries and multi-machine state."
                : detail?.description ||
              "Auditable history and conversation handoff."
            }}
          </p>
        </div>
        <div v-if="activeView !== 'projects'" class="exports">
          <button v-if="detail" @click="toggleProject">
            {{
              detail.status === "archived"
                ? "Enable tracking"
                : "Disable tracking"
            }}</button
          ><a :href="`/api/export/json?project=${selected}`">Export JSON</a
          ><a :href="`/api/export/markdown?project=${selected}`"
            >Export Markdown</a
          >
        </div>
      </header>
      <div class="tabs" role="tablist">
        <button
          v-for="view in [
            'projects',
            'overview',
            'chapters',
            'evidence',
            'diagram',
            'analytics',
            'memory',
          ]"
          :key="view"
          :class="{ active: activeView === view }"
          role="tab"
          :aria-selected="activeView === view"
          :aria-label="`${view} view`"
          @click="activeView = view as any; view === 'projects' && loadPortfolio(); view === 'analytics' && loadAnalytics()"
        >
          {{ view }}
        </button>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <section v-if="activeView === 'projects'" class="portfolio-screen">
        <div v-if="portfolioBusy && !portfolio" class="panel empty">Loading local project inventory…</div>
        <template v-else-if="portfolio">
          <section class="portfolio-summary">
            <article><span>Tracked projects</span><strong>{{ portfolio.projects.length }}</strong></article>
            <article><span>Active tracking</span><strong>{{ portfolio.projects.filter((p:any) => p.status !== 'archived').length }}</strong></article>
            <article><span>Detected locally</span><strong>{{ portfolio.detected.length }}</strong></article>
            <article><span>Cloud providers</span><strong>{{ portfolio.sync.filter((s:any) => s.last_status === 'ok').length }} / {{ portfolio.sync.length }}</strong></article>
          </section>
          <section class="panel portfolio-list">
            <div class="panel-head"><div><p class="eyebrow">Tracked memory</p><h2>All projects</h2></div><span class="scope-note">Independent of the selected project</span></div>
            <article v-for="project in portfolio.projects" :key="project.uid" class="portfolio-row" :data-tracking="project.status">
              <div class="portfolio-main"><span class="status" :data-status="project.status">{{ project.status === 'archived' ? 'inactive' : project.status }}</span><h3>{{ project.name }}</h3><p>{{ project.last_summary || 'No recorded activity' }}</p><code v-if="project.local_memory">{{ project.local_memory.path }}</code></div>
              <dl><div><dt>Progress</dt><dd>{{ project.proven }} / {{ project.objectives }}</dd></div><div><dt>Last activity</dt><dd>{{ date(project.last_activity) }}</dd></div><div><dt>Machines</dt><dd>{{ project.machines.length ? project.machines.join(', ') : 'None reported' }}</dd></div><div><dt>Git</dt><dd v-if="project.git">{{ project.git.branch }} · <code>{{ project.git.head_commit?.slice(0,10) }}</code><span :class="{warn:project.git.dirty}">{{ project.git.dirty ? 'dirty' : 'clean' }}</span></dd><dd v-else>Not reported</dd></div></dl>
              <div class="portfolio-actions"><button @click="openPortfolioProject(project)">Open project</button><button class="secondary" :disabled="portfolioBusy" @click="setPortfolioTracking(project)">{{ project.status === 'archived' ? 'Enable tracking' : 'Disable tracking' }}</button></div>
            </article>
          </section>
          <section class="panel detected-projects"><div class="panel-head"><div><p class="eyebrow">Local Codex and Claude memory</p><h2>Detected, not tracked</h2></div><span class="scope-note">{{ portfolio.detected.length }} candidates</span></div><p v-if="!portfolio.detected.length" class="empty good">Every detected local project is already tracked.</p><article v-for="project in portfolio.detected" :key="project.path"><div><h3>{{ project.name }}</h3><code>{{ project.path }}</code><p>{{ project.sessions }} sessions · {{ project.sources.join(' + ') }} · {{ date(project.last_activity) }}</p></div><button :disabled="portfolioBusy" @click="addDiscovered(project)">Add to Orchestrator</button></article></section>
          <section class="panel portfolio-sync"><div class="panel-head"><div><p class="eyebrow">Shared memory</p><h2>Cloud status</h2></div></div><article v-for="connection in portfolio.sync" :key="connection.provider"><strong>{{ connection.label }}</strong><span :data-status="connection.last_status">{{ connection.last_status }}</span><p>{{ connection.shard_count }} immutable journals · Last pull {{ date(connection.last_pull_at) }}</p></article></section>
        </template>
      </section>
      <template v-else-if="detail">
        <section class="metrics" aria-label="Project metrics">
          <article>
            <span>Overall progress</span><strong>{{ progress }}%</strong>
            <div class="bar"><i :style="{ width: `${progress}%` }"></i></div>
          </article>
          <article>
            <span>Chapters</span><strong>{{ detail.chapters.length }}</strong
            ><small
              >{{
                detail.chapters.filter((c) => c.progress === 100).length
              }}
              complete</small
            >
          </article>
          <article>
            <span>Open blockers</span
            ><strong :class="{ warn: detail.blockers.length }">{{
              detail.blockers.length
            }}</strong
            ><small>{{ detail.blockers.length ? "Need attention" : "No active blockers" }}</small>
          </article>
          <article>
            <span>Evidence records</span
            ><strong>{{
              projects.find((p) => p.slug === selected)?.proofs || 0
            }}</strong
            ><small>Available and hashed</small>
          </article>
        </section>

        <div v-if="activeView === 'overview'" class="grid">
          <section class="panel timeline">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Persistent memory</p>
                <h2>Latest evolution</h2>
              </div>
            </div>
            <ol>
              <li v-for="event in events.slice(0, 20)" :key="event.uid">
                <time>{{ date(event.occurred_at) }}</time>
                <div>
                  <span class="tag" :data-kind="event.assertion">{{
                    assertionLabel(event.assertion)
                  }}</span>
                  <h3>{{ event.summary }}</h3>
                  <p>
                    {{ event.objective_title || event.kind }} ·
                    {{ event.actor }}
                  </p>
                </div>
              </li>
            </ol>
          </section>
          <div class="stack">
            <section class="panel">
              <div class="panel-head">
                <div>
                  <p class="eyebrow">Current state</p>
                  <h2>Chapter progress</h2>
                </div>
                <button class="text-button" @click="activeView = 'chapters'">
                  View all
                </button>
              </div>
              <button
                v-for="chapter in detail.chapters.slice(0, 6)"
                :key="chapter.uid"
                class="chapter-row"
                @click="inspectChapter(chapter)"
              >
                <div>
                  <h3>{{ chapter.title }}</h3>
                  <p>
                    {{ chapter.evidence_count }} evidence ·
                    {{ chapter.event_count }} events
                  </p>
                </div>
                <strong>{{ chapter.progress }}%</strong>
                <div class="bar">
                  <i :style="{ width: `${chapter.progress}%` }"></i>
                </div>
              </button>
            </section>
            <section class="panel">
              <div class="panel-head">
                <div>
                  <p class="eyebrow">Multi-machine memory</p>
                  <h2>Immutable cloud journals</h2>
                  <p class="scope-note">
                    Each machine publishes new records without overwriting
                    another machine.
                  </p>
                </div>
              </div>
              <article
                v-for="connection in connections"
                :key="connection.provider"
                class="sync-row"
              >
                <div>
                  <strong>{{ connection.label }}</strong
                  ><span :data-status="connection.last_status">{{
                    connection.last_status
                  }}</span>
                  <p>{{ connection.last_detail || "Never synchronized" }}</p>
                  <small
                    >{{ connection.shard_count }} known journals ·
                    {{ connection.pending_events }} local events pending · Last
                    push: {{ date(connection.last_push_at) }}</small
                  >
                </div>
                <button
                  :disabled="Boolean(syncing)"
                  @click="sync(connection.provider)"
                >
                  {{
                    syncing === connection.provider
                      ? "Synchronizing…"
                      : "Sync journals"
                  }}
                </button>
              </article>
            </section>
            <section class="panel coordination">
              <div class="panel-head">
                <div>
                  <p class="eyebrow">Multi-machine coordination</p>
                  <h2>Pass activity</h2>
                  <p class="scope-note">
                    Reported state only · 15 minute heartbeat window
                  </p>
                </div>
                <div class="coord-counts">
                  <span>{{ coordination.counts.active }} active</span
                  ><span :class="{ warn: coordination.counts.conflicts }"
                    >{{ coordination.counts.conflicts }} conflicts</span
                  >
                </div>
              </div>
              <div v-if="coordination.latest_git" class="git-state">
                <strong>{{ coordination.latest_git.branch }}</strong
                ><code>{{
                  coordination.latest_git.head_commit?.slice(0, 10)
                }}</code
                ><span :class="{ warn: coordination.latest_git.dirty }">{{
                  coordination.latest_git.dirty
                    ? "Uncommitted changes"
                    : "Clean working tree"
                }}</span>
              </div>
              <p v-if="!coordination.active.length" class="empty good">
                No active pass reported.
              </p>
              <article
                v-for="pass in coordination.active"
                :key="pass.session_id"
                class="pass-activity"
                :data-state="pass.overlaps.length ? 'conflict' : pass.status"
              >
                <div>
                  <span
                    class="status"
                    :data-status="
                      pass.overlaps.length ? 'blocked' : pass.status
                    "
                    >{{ pass.overlaps.length ? "conflict" : pass.status }}</span
                  >
                  <h3>{{ pass.summary }}</h3>
                  <p>
                    {{ pass.session_id }} · {{ pass.machine }} ·
                    {{ pass.branch }}
                  </p>
                </div>
                <dl>
                  <div>
                    <dt>Base</dt>
                    <dd>
                      <code>{{ pass.base_commit.slice(0, 10) }}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Last signal</dt>
                    <dd>{{ date(pass.last_seen_at) }}</dd>
                  </div>
                  <div>
                    <dt>Files</dt>
                    <dd>{{ pass.paths.join(", ") }}</dd>
                  </div>
                </dl>
                <p v-if="pass.stale" class="coord-alert">
                  Base commit differs from the latest reported Git state.
                </p>
                <p v-if="pass.overlaps.length" class="coord-alert">
                  Overlaps {{ pass.overlaps.join(", ") }}
                </p>
              </article>
              <details
                v-if="
                  coordination.recent.some(
                    (pass: any) => pass.status === 'abandoned',
                  )
                "
              >
                <summary>
                  Abandoned passes ({{ coordination.counts.abandoned }})
                </summary>
                <p
                  v-for="pass in coordination.recent.filter(
                    (item: any) => item.status === 'abandoned',
                  )"
                  :key="pass.session_id"
                  class="abandoned-pass"
                >
                  {{ pass.session_id }} · {{ pass.machine }} · last signal
                  {{ date(pass.last_seen_at) }}
                </p>
              </details>
            </section>
          </div>
        </div>

        <section v-else-if="activeView === 'chapters'" class="chapters-layout">
          <div class="chapter-list panel">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Structure and progress</p>
                <h2>Chapters</h2>
              </div>
              <button
                v-if="selectedChapter"
                class="text-button"
                @click="selectedChapter = ''"
              >
                Show all history
              </button>
            </div>
            <button
              v-for="chapter in detail.chapters"
              :key="chapter.uid"
              class="chapter-card"
              :class="{ selected: selectedChapter === chapter.uid }"
              @click="inspectChapter(chapter)"
            >
              <div class="chapter-top">
                <span class="status" :data-status="chapter.status">{{
                  chapter.status
                }}</span
                ><strong>{{ chapter.progress }}%</strong>
              </div>
              <h3>{{ chapter.title }}</h3>
              <p>
                {{ chapter.proven_count }} of
                {{ chapter.objective_count }} objectives proven ·
                {{ chapter.evidence_count }} evidence records
              </p>
              <div class="bar">
                <i :style="{ width: `${chapter.progress}%` }"></i>
              </div>
              <small>Last evolution: {{ date(chapter.last_activity) }}</small>
            </button>
          </div>
          <section class="panel timeline">
            <div class="panel-head">
              <div>
                <p class="eyebrow">
                  {{ selectedChapter ? "Selected chapter" : "All chapters" }}
                </p>
                <h2>Evolution history</h2>
              </div>
              <div class="filters">
                <input
                  v-model="query"
                  aria-label="Search history"
                  placeholder="Search history…"
                /><select v-model="assertion" aria-label="Provenance">
                  <option value="">All provenance</option>
                  <option value="measured_fact">Measured facts</option>
                  <option value="agent_statement">Agent statements</option>
                  <option value="human_judgment">Human judgments</option>
                  <option value="system_record">System records</option>
                </select>
              </div>
            </div>
            <form
              v-if="judgmentRequest"
              class="judgment-box"
              @submit.prevent="recordJudgment"
            >
              <div>
                <p class="eyebrow">Human judgment requested</p>
                <h3>{{ judgmentRequest.summary }}</h3>
                <p>
                  {{
                    detail.chapters.find((c) => c.uid === selectedChapter)
                      ?.title
                  }}
                </p>
              </div>
              <textarea
                v-model="judgmentText"
                required
                placeholder="Write your judgment…"
                aria-label="Human judgment"
              ></textarea>
              <div>
                <select v-model="judgmentVerdict" aria-label="Judgment verdict">
                  <option value="pass">Pass</option>
                  <option value="fail">Fail</option>
                  <option value="inconclusive">Inconclusive</option></select
                ><button
                  :disabled="judgmentBusy || !judgmentText.trim()"
                  type="submit"
                >
                  {{ judgmentBusy ? "Recording…" : "Record judgment" }}
                </button>
              </div>
            </form>
            <p v-if="!events.length" class="empty">No matching history.</p>
            <ol>
              <li v-for="event in pagedEvents" :key="event.uid">
                <time>{{ date(event.occurred_at) }}</time>
                <div>
                  <span class="tag" :data-kind="event.assertion">{{
                    assertionLabel(event.assertion)
                  }}</span>
                  <h3>{{ event.summary }}</h3>
                  <p>
                    {{ event.objective_title || event.kind }} ·
                    {{ event.actor }}
                  </p>
                </div>
              </li>
            </ol>
            <div class="pagination">
              <button :disabled="eventPage === 1" @click="eventPage--">
                Previous</button
              ><span>Page {{ eventPage }} / {{ eventPages }}</span
              ><button
                :disabled="eventPage === eventPages"
                @click="eventPage++"
              >
                Next
              </button>
            </div>
          </section>
        </section>

        <section v-else-if="activeView === 'evidence'" class="evidence-screen">
          <section class="panel pass-browser">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Evidence by pass</p>
                <h2>Passes</h2>
              </div>
              <span class="scope-note">{{ passGroups.length }} passes</span>
            </div>
            <button
              v-for="pass in pagedPasses"
              :key="pass.id"
              class="pass-row"
              :class="{ selected: selectedPass === pass.id }"
              @click="
                selectedPass = selectedPass === pass.id ? '' : pass.id;
                evidencePage = 1;
              "
            >
              <div>
                <strong>Pass {{ pass.id }}</strong
                ><span
                  >{{ pass.proofs.length }} evidence records ·
                  {{ pass.images.length }} images</span
                >
              </div>
              <div class="pass-thumbs">
                <img
                  v-for="proof in pass.images.slice(0, 4)"
                  :key="proof.uid"
                  :src="previewUrl(proof)"
                  :alt="proof.label"
                  loading="lazy"
                  @click.stop="previewImage = proof"
                /><span v-if="!pass.images.length">No image</span>
              </div>
            </button>
            <div class="pagination">
              <button :disabled="passPage === 1" @click="passPage--">
                Previous</button
              ><span>Page {{ passPage }} / {{ passPages }}</span
              ><button :disabled="passPage === passPages" @click="passPage++">
                Next
              </button>
            </div>
          </section>
          <section class="panel evidence-view">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Auditable material</p>
                <h2>Evidence manifest</h2>
                <p class="scope-note">
                  Scope:
                  {{
                    selectedPass
                      ? `pass ${selectedPass}`
                      : selectedChapter
                        ? "selected chapter"
                        : "whole project"
                  }}
                </p>
              </div>
              <div class="evidence-filters">
                <select
                  v-model="selectedChapter"
                  aria-label="Filter evidence by chapter"
                  @change="selectedPass = ''"
                >
                  <option value="">Whole project</option>
                  <option
                    v-for="chapter in detail.chapters"
                    :key="chapter.uid"
                    :value="chapter.uid"
                  >
                    {{ chapter.title }}
                  </option></select
                ><select
                  v-model="evidenceType"
                  aria-label="Filter evidence by content type"
                  @change="evidencePage = 1"
                >
                  <option value="all">All evidence</option>
                  <option value="images">Images</option>
                  <option value="text">Text files</option>
                </select>
              </div>
            </div>
            <div v-if="selectedChapter" class="evidence-context">
              <div>
                <span>Evidence for chapter</span
                ><strong>{{
                  detail.chapters.find((c) => c.uid === selectedChapter)?.title
                }}</strong
                ><small v-if="selectedPass"
                  >Filtered further to pass {{ selectedPass }}</small
                >
              </div>
              <button
                @click="
                  selectedChapter = '';
                  selectedPass = '';
                "
              >
                Show whole project
              </button>
            </div>
            <section v-if="blockedContext" class="blocked-context">
              <div>
                <p class="eyebrow">Blocked chapter</p>
                <h3>{{ blockedContext.title }}</h3>
                <p>{{ blockedContext.detail || "No additional blocker detail." }}</p>
                <small>{{ blockedContext.pass_ref ? `Related pass ${blockedContext.pass_ref}` : "No pass reference was recorded" }}</small>
              </div>
              <form v-if="judgmentRequest" class="blocked-decision" @submit.prevent="recordJudgment">
                <strong>Human decision requested</strong>
                <textarea v-model="judgmentText" required placeholder="Write your judgment…" aria-label="Human judgment"></textarea>
                <div><select v-model="judgmentVerdict" aria-label="Judgment verdict"><option value="pass">Pass</option><option value="fail">Fail</option><option value="inconclusive">Inconclusive</option></select><button :disabled="judgmentBusy || !judgmentText.trim()" type="submit">{{ judgmentBusy ? "Recording…" : "Record judgment" }}</button></div>
              </form>
              <p v-else class="decision-not-requested">No human judgment requested for this blocker.</p>
            </section>
            <section v-if="comparisonPair" class="comparison">
              <div class="comparison-head">
                <div>
                  <p class="eyebrow">Before / after</p>
                  <h3>Visual comparison</h3>
                  <p>
                    {{ comparisonPair.before.objective_title }} ·
                    {{
                      comparisonPair.before.pass_ref
                        ? `Pass ${comparisonPair.before.pass_ref}`
                        : "No pass reference"
                    }}
                  </p>
                </div>
                <select
                  v-model.number="comparisonIndex"
                  aria-label="Choose before and after comparison"
                >
                  <option
                    v-for="(pair, index) in comparisonPairs"
                    :key="pair.before.uid + pair.after.uid"
                    :value="index"
                  >
                    Comparison {{ index + 1 }} / {{ comparisonPairs.length }}
                  </option>
                </select>
              </div>
              <div class="comparison-grid">
                <figure @click="previewImage = comparisonPair.before">
                  <span>Before</span>
                  <img
                    :src="previewUrl(comparisonPair.before)"
                    :alt="comparisonPair.before.label"
                  />
                  <figcaption>{{ comparisonPair.before.label }}</figcaption>
                </figure>
                <figure @click="previewImage = comparisonPair.after">
                  <span>After</span>
                  <img
                    :src="previewUrl(comparisonPair.after)"
                    :alt="comparisonPair.after.label"
                  />
                  <figcaption>{{ comparisonPair.after.label }}</figcaption>
                </figure>
              </div>
            </section>
            <p v-if="!scopedEvidence.length" class="empty">
              No evidence recorded for this selection.
            </p>
            <div class="evidence-table" role="table">
              <article
                v-for="proof in pagedEvidence"
                :key="proof.uid"
                class="evidence-row"
                role="row"
              >
                <div class="evidence-main">
                  <img
                    v-if="proof.status === 'available' && isImage(proof)"
                    :src="previewUrl(proof)"
                    :alt="proof.label"
                    loading="lazy"
                    @click="previewImage = proof"
                  />
                  <div>
                    <span class="status" :data-status="proof.status">{{
                      proof.status
                    }}</span>
                    <h3>{{ proof.label }}</h3>
                    <p>
                      {{ proof.objective_title || "Project-level evidence" }} ·
                      {{
                        proof.pass_ref
                          ? `Pass ${proof.pass_ref}`
                          : "No pass reference"
                      }}
                    </p>
                  </div>
                </div>
                <dl>
                  <div>
                    <dt>Type</dt>
                    <dd>{{ proof.type }}</dd>
                  </div>
                  <div>
                    <dt>Origin</dt>
                    <dd>{{ proof.origin }}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{{ bytes(proof.bytes) }}</dd>
                  </div>
                  <div>
                    <dt>Retention</dt>
                    <dd>{{ proof.retention }}</dd>
                  </div>
                </dl>
                <div class="proof-ref">
                  <code :title="proof.sha256 || ''">{{
                    proof.sha256
                      ? proof.sha256.slice(0, 16) + "…"
                      : "No verified hash"
                  }}</code
                  ><button
                    v-if="proof.locator_kind === 'path'"
                    class="text-button"
                    :disabled="verifying === proof.uid"
                    @click="verifyProof(proof)"
                  >
                    {{ verifying === proof.uid ? "Verifying…" : "Verify file" }}
                  </button
                  ><button
                    v-if="proof.status === 'available' && isText(proof)"
                    class="text-button"
                    @click="previewText(proof)"
                  >
                    {{
                      openPreview === proof.uid ? "Close text" : "Read text"
                    }}</button
                  ><a
                    v-else-if="proof.locator_kind === 'url' && proof.locator"
                    :href="proof.locator"
                    target="_blank"
                    rel="noreferrer"
                    >Open source</a
                  ><span v-else :title="proof.locator || ''">{{
                    proof.locator || "No locator"
                  }}</span>
                  <strong
                    v-if="verification[proof.uid]"
                    class="verification"
                    :data-verification="verification[proof.uid].verification"
                  >
                    {{ verification[proof.uid].verification
                    }}{{
                      verification[proof.uid].size_matches === false
                        ? " · size changed"
                        : ""
                    }}
                  </strong>
                </div>
                <div v-if="openPreview === proof.uid" class="text-preview">
                  <p v-if="previewErrors[proof.uid]" class="error">
                    {{ previewErrors[proof.uid] }}
                  </p>
                  <pre v-else>{{ textPreviews[proof.uid] || "Loading…" }}</pre>
                </div>
              </article>
            </div>
            <div class="pagination">
              <button :disabled="evidencePage === 1" @click="evidencePage--">
                Previous</button
              ><span
                >{{ scopedEvidence.length }} records · Page {{ evidencePage }} /
                {{ evidencePages }}</span
              ><button
                :disabled="evidencePage === evidencePages"
                @click="evidencePage++"
              >
                Next
              </button>
            </div>
          </section>
        </section>
        <section v-else-if="activeView === 'diagram'" class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Flow, returns and current state</p>
              <h2>Project flow diagram</h2>
            </div>
            <div class="diagram-legend">
              <span data-phase="completed">Completed</span
              ><span data-phase="active">Active</span
              ><span data-phase="blocked">Blocked / return</span
              ><span data-phase="planned">Planned</span>
            </div>
          </div>
          <div class="graph-scroll">
            <svg
              class="project-graph"
              :style="{ height: `${graphHeight}px` }"
              :viewBox="`0 0 1040 ${graphHeight}`"
              role="img"
              :aria-label="`${diagram?.project.name} project flow`"
            >
              <defs>
                <marker
                  id="arrow-flow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
                <marker
                  id="arrow-return"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              <g class="graph-edges">
                <path
                  v-for="(edge, index) in diagram?.edges.filter(
                    (e) => e.type !== 'contains',
                  )"
                  :key="index"
                  :d="graphPath(edge)"
                  :class="`edge-${edge.type}`"
                  :marker-end="
                    edge.type === 'returns' || edge.type === 'retry'
                      ? 'url(#arrow-return)'
                      : 'url(#arrow-flow)'
                  "
                />
              </g>
              <g
                v-for="(node, index) in graphNodes"
                :key="node.id"
                class="graph-node"
                :data-phase="node.phase"
              >
                <rect
                  :x="node.x"
                  :y="node.y"
                  :width="node.width"
                  :height="node.height"
                  rx="8"
                />
                <text :x="node.x + 14" :y="node.y + 20" class="node-order">
                  {{ index + 1 }} · {{ node.phase.toUpperCase() }}
                </text>
                <text :x="node.x + 14" :y="node.y + 42" class="node-title">
                  {{
                    node.label.length > 34
                      ? node.label.slice(0, 34) + "…"
                      : node.label
                  }}
                </text>
                <text :x="node.x + 14" :y="node.y + 64" class="node-meta">
                  {{ node.evidence_count }} evidence ·
                  {{ node.fail_count }} fails · {{ node.blocker_count }} returns
                </text>
              </g>
            </svg>
          </div>
          <section class="dependency-list">
            <h3>Contained objectives</h3>
            <p
              v-for="edge in diagram?.edges.filter(
                (e) => e.type === 'contains',
              )"
              :key="edge.from + edge.to"
            >
              {{ diagram?.nodes.find((n) => n.id === edge.from)?.label }} →
              {{ diagram?.nodes.find((n) => n.id === edge.to)?.label }}
            </p>
          </section>
        </section>
        <section v-else-if="activeView === 'analytics'" class="analytics-screen">
          <div v-if="analyticsBusy && !analytics" class="panel empty">Loading reported usage…</div>
          <template v-else-if="analytics">
            <section class="analytics-metrics">
              <article><span>Cost today</span><strong>{{ todayAnalytics && todayAnalytics.cost > 0 ? money(todayAnalytics.cost) : '—' }}</strong><small>{{ todayAnalytics?.unknown_costs ? `${todayAnalytics.unknown_costs} records have unknown cost` : 'No cost reported today' }}</small></article>
              <article><span>Reported cost · 30 days</span><strong>{{ money(analytics.totals.cost) }}</strong><small>{{ money(analytics.totals.measured_cost) }} measured · {{ money(analytics.totals.estimated_cost) }} estimated</small></article>
              <article><span>Codex API equivalent · today</span><strong>{{ money(analytics.local_today?.machine_total?.estimated_cost || 0) }}</strong><small>Estimated from {{ compactNumber(analytics.local_today?.machine_total?.total_tokens || 0) }} local tokens · not an invoice</small></article>
              <article><span>Total tokens</span><strong>{{ compactNumber(analytics.totals.total_tokens) }}</strong><small>{{ compactNumber(analytics.totals.input_tokens) }} input · {{ compactNumber(analytics.totals.output_tokens) }} output</small></article>
              <article><span>Cached tokens</span><strong>{{ compactNumber(analytics.totals.cached_tokens) }}</strong><small>{{ analytics.totals.token_records }} records include token usage</small></article>
              <article><span>Efficiency</span><strong>{{ analytics.efficiency?.cost_per_proven == null ? '—' : money(analytics.efficiency.cost_per_proven) }}</strong><small>Cost per proven objective · {{ analytics.totals.unknown_costs }} unknown costs</small></article>
            </section>
            <div class="analytics-grid">
              <section class="panel chart-panel"><div class="panel-head"><div><p class="eyebrow">Reported spend</p><h2>Cost by day</h2></div><span class="scope-note">Measured + estimated</span></div><p v-if="!analytics.daily.length" class="empty">No cost records in this period.</p><div v-else class="bar-chart" role="img" aria-label="Daily reported costs"><div v-for="day in analytics.daily" :key="day.key" class="bar-column"><span>{{ day.cost > 0 ? money(day.cost) : day.unknown_costs ? '—' : money(0) }}</span><i :style="{height:`${maxDailyCost && day.cost ? Math.max(3,day.cost/maxDailyCost*100) : 3}%`}"></i><small>{{ day.key.slice(5) }}</small></div></div></section>
              <section class="panel chart-panel"><div class="panel-head"><div><p class="eyebrow">Model usage</p><h2>Tokens by day</h2></div><span class="scope-note">Externally reported only</span></div><p v-if="!analytics.totals.token_records" class="empty">No token usage has been reported yet. Future Codex/Claude clients can publish it through cost.recorded.</p><div v-else class="bar-chart tokens" role="img" aria-label="Daily reported tokens"><div v-for="day in analytics.daily" :key="day.key" class="bar-column"><span>{{ compactNumber(day.tokens) }}</span><i :style="{height:`${maxDailyTokens ? Math.max(3,day.tokens/maxDailyTokens*100) : 3}%`}"></i><small>{{ day.key.slice(5) }}</small></div></div></section>
            </div>
            <section class="panel analytics-table"><div class="panel-head"><div><p class="eyebrow">Attribution</p><h2>Models and sources</h2></div></div><article v-for="model in analytics.models" :key="model.key"><strong>{{ model.key }}</strong><div><span>{{ money(model.cost) }}</span><span>{{ compactNumber(model.tokens) }} tokens</span><span>{{ model.records }} records</span><span>{{ model.unknown_costs }} unknown costs</span></div></article><article v-for="model in analytics.local_today?.machine_total?.models || []" :key="`local-${model.model}`"><strong>{{ model.model }} · local today</strong><div><span>≈ {{ money(model.estimated_cost) }}</span><span>{{ compactNumber(model.total_tokens) }} tokens</span><span>{{ model.sessions }} sessions</span><span>API equivalent</span></div></article><p class="analytics-note">Local estimates apply the public API token rate to observed Codex usage. They are not subscription charges or invoices. Pricing table: {{ analytics.local_today?.pricing_version }}. Orchestrator remains observation-only.</p></section>
          </template>
        </section>
        <section v-else class="panel memory-import">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Global machine inventory</p>
              <h2>Local Codex and Claude memory</h2>
              <p class="scope-note">
                Read-only scan of local conversation histories. Nothing is
                imported automatically.
              </p>
            </div>
            <button
              class="scan-button"
              :disabled="memoryBusy"
              @click="scanMemory"
            >
              {{ memoryBusy ? "Scanning…" : "Scan this machine" }}
            </button>
          </div>
          <p v-if="!localMemory" class="empty">
            Scan to discover projects from existing Codex and Claude sessions.
          </p>
          <template v-else
            ><div class="scan-summary">
              <span
                v-for="inventory in localMemory.inventories"
                :key="inventory.source + inventory.root"
                ><strong>{{ inventory.files }}</strong>
                {{ inventory.source }} sessions</span
              ><span
                ><strong>{{ localMemory.projects.length }}</strong> project
                paths</span
              >
            </div>
            <div class="discovered-list">
              <article
                v-for="project in localMemory.projects"
                :key="project.path"
                :class="{ tracked: project.tracked }"
              >
                <div>
                  <span>{{ project.sources.join(" + ") }}</span>
                  <h3>{{ project.name }}</h3>
                  <code>{{ project.path }}</code>
                  <p>
                    {{ project.sessions }} sessions · last activity
                    {{ date(project.last_activity) }}
                  </p>
                </div>
                <button
                  v-if="!project.tracked"
                  :disabled="memoryBusy"
                  @click="addDiscovered(project)"
                >
                  Add to Orchestrator</button
                ><strong v-else>Already tracked</strong>
              </article>
            </div></template
          >
        </section>
      </template>
      <div
        v-if="previewImage"
        class="lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="previewImage.label"
        @click.self="previewImage = null"
      >
        <button
          class="lightbox-close"
          aria-label="Close image"
          @click="previewImage = null"
        >
          ×</button
        ><button
          v-if="previewImages.length > 1"
          class="lightbox-nav previous"
          aria-label="Previous image"
          @click="moveImage(-1)"
        >
          ‹
        </button>
        <figure>
          <img :src="previewUrl(previewImage)" :alt="previewImage.label" />
          <figcaption>
            <strong>{{ previewImage.label }}</strong
            ><span
              >{{ previewImageIndex + 1 }} / {{ previewImages.length }} ·
              {{ previewImage.objective_title || "Project evidence" }} ·
              {{
                previewImage.pass_ref
                  ? `Pass ${previewImage.pass_ref}`
                  : "No pass reference"
              }}</span
            >
          </figcaption>
        </figure>
        <button
          v-if="previewImages.length > 1"
          class="lightbox-nav next"
          aria-label="Next image"
          @click="moveImage(1)"
        >
          ›
        </button>
      </div>
    </main>
  </div>
</template>
