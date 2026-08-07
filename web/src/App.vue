<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import SystemHealthPanel from "./components/SystemHealthPanel.vue";
import orchestratorMark from "./assets/orchestrator-mark.svg";

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
  payload: Record<string, unknown>;
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
  cloud_providers: string[];
  local_available: boolean;
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
  cloud_evidence: number;
};
type SavedView = { id: string; label: string; context: string; url: string; saved_at: string };
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
  resume = ref<any>(null),
  confidence = ref<any>(null),
  searchResults = ref<any[]>([]),
  searchBusy = ref(false),
  snapshots = ref<any[]>([]),
  snapshotDiff = ref<any>(null),
  snapshotBusy = ref(false),
  localMemory = ref<any>(null),
  portfolio = ref<any>(null),
  portfolioBusy = ref(false),
  attention = ref<any>(null),
  attentionBusy = ref(false),
  briefing = ref<any>(null),
  briefingBusy = ref(false),
  systemHealth = ref<any>(null),
  systemHealthBusy = ref(false),
  syncCenter = ref<any>(null),
  syncCenterBusy = ref(false),
  analytics = ref<any>(null),
  analyticsBusy = ref(false),
  aiWorkspace = ref<any>(null),
  aiWorkspaceBusy = ref(false),
  planning = ref<any>(null),
  planningBusy = ref(false),
  memoryBusy = ref(false);
const clickupForm=ref<any>({workspace_id:"",list_id:"",tag_name:"",token:"",enabled:true,status_mapping:{}})
const clickupResourcesData=ref<any>({workspaces:[],lists:[]})
const clickupListStatusesData=ref<any[]>([])
const clickupSync=ref<any>({active:false,percent:0,message:"Ready"})
const clickupMappingOpen=ref(false)
const planningNeed=ref("")
const clickupLists=computed(()=>clickupResourcesData.value.lists.filter((row:any)=>!clickupForm.value.workspace_id||row.workspace_id===clickupForm.value.workspace_id))
const clickupStatuses=computed(()=>clickupListStatusesData.value.length?clickupListStatusesData.value:clickupResourcesData.value.lists.find((row:any)=>row.id===clickupForm.value.list_id)?.statuses||[])
const statusKinds=[['proposed','Proposed'],['approved','Approved'],['published','Published'],['rejected','Rejected'],['superseded','Superseded']]
function resetClickupMapping(){clickupForm.value.status_mapping={};}
async function openClickupMapping(){clickupMappingOpen.value=true;if(!clickupResourcesData.value.lists.length)await loadClickupResources();else if(!clickupListStatusesData.value.length)await loadClickupStatuses()}
const analyticsDays = ref(30),
  analyticsScope = ref<"project" | "global">("project");
const shareState = ref("Copy context link");
const focusedEvidence = ref(""), pendingEvidence = ref("");
const savedViews = ref<SavedView[]>([]), saveState = ref("Save shortcut");
const savedViewsKey = "orchestrator:saved-views";
const allowedViews = new Set(["search", "briefing", "attention", "health", "sync-center", "projects", "overview", "ai", "planning", "chapters", "evidence", "diagram", "snapshots", "analytics", "memory"]);
const globalViews = new Set(["search", "briefing", "attention", "health", "sync-center", "projects"]);
const isGlobalView = (view: string) => globalViews.has(view);
let restoringNavigation = true;
function applyUrlState() {
  const params = new URLSearchParams(window.location.search), project = params.get("project"), view = params.get("view");
  if (project && projects.value.some(row => row.slug === project)) selected.value = project;
  if (view && allowedViews.has(view)) activeView.value = view as typeof activeView.value;
  selectedChapter.value = params.get("chapter") || "";
  selectedPass.value = params.get("pass") || "";
  pendingEvidence.value = params.get("proof") || "";
  focusedEvidence.value = pendingEvidence.value;
  if (!pendingEvidence.value) {
    previewImage.value = null;
    openPreview.value = "";
  }
}
function urlForContext() {
  const params = new URLSearchParams();
  if (selected.value) params.set("project", selected.value);
  params.set("view", activeView.value);
  if (selectedChapter.value) params.set("chapter", selectedChapter.value);
  if (selectedPass.value) params.set("pass", selectedPass.value);
  const proof = previewImage.value?.uid || openPreview.value || focusedEvidence.value;
  if (proof) params.set("proof", proof);
  return `${window.location.pathname}?${params.toString()}`;
}
let urlTimer: number;
function syncContextUrl() {
  if (restoringNavigation) return;
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => {
    const next = urlForContext();
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.pushState(null, "", next);
  }, 0);
}
async function copyContextLink() {
  await navigator.clipboard.writeText(new URL(urlForContext(), window.location.origin).href);
  shareState.value = "Copied";
  window.setTimeout(() => shareState.value = "Copy context link", 1600);
}
function loadSavedViews() {
  try { savedViews.value = JSON.parse(localStorage.getItem(savedViewsKey) || "[]"); }
  catch { savedViews.value = []; }
}
function persistSavedViews() { localStorage.setItem(savedViewsKey, JSON.stringify(savedViews.value)); }
function saveCurrentView() {
  const chapter = detail.value?.chapters.find(row => row.uid === selectedChapter.value);
  const context = [activeView.value, chapter?.title, selectedPass.value ? `Pass ${selectedPass.value}` : ""].filter(Boolean).join(" · ");
  const url = urlForContext(), id = btoa(unescape(encodeURIComponent(url))).replace(/=+$/g, "");
  savedViews.value = [{ id, label: detail.value?.name || "Project view", context, url, saved_at: new Date().toISOString() }, ...savedViews.value.filter(row => row.id !== id)].slice(0, 8);
  persistSavedViews();
  saveState.value = "Saved";
  window.setTimeout(() => saveState.value = "Save shortcut", 1600);
}
function openSavedView(view: SavedView) {
  window.history.pushState(null, "", view.url);
  restoreFromHistory();
}
function removeSavedView(id: string) {
  savedViews.value = savedViews.value.filter(row => row.id !== id);
  persistSavedViews();
}
const activeView = ref<
    "search" | "briefing" | "attention" | "health" | "sync-center" | "projects" | "overview" | "ai" | "planning" | "chapters" | "evidence" | "diagram" | "snapshots" | "analytics" | "memory"
  >("overview"),
  selectedChapter = ref(""),
  selectedPass = ref(""),
  query = ref(""),
  assertion = ref(""),
  loading = ref(true),
  error = ref("");
const globalQuery=ref("")
const searchType=ref("all"),searchPage=ref(1)
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
  if (!selected.value && projects.value[0]) selected.value = projects.value[0].slug;
  applyUrlState();
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
async function loadAttention(){attentionBusy.value=true;try{attention.value=await api('/attention')}catch(e:any){error.value=e.message}finally{attentionBusy.value=false}}
async function loadBriefing(){briefingBusy.value=true;try{const since=localStorage.getItem('orchestrator:briefing-reviewed')||new Date(Date.now()-86400000).toISOString();briefing.value=await api(`/briefing?since=${encodeURIComponent(since)}`)}catch(e:any){error.value=e.message}finally{briefingBusy.value=false}}
async function loadSystemHealth(){systemHealthBusy.value=true;try{systemHealth.value=await api('/system/health')}catch(e:any){error.value=e.message}finally{systemHealthBusy.value=false}}
async function loadSyncCenter(){syncCenterBusy.value=true;try{syncCenter.value=await api('/clickup/sync-center')}catch(e:any){error.value=e.message}finally{syncCenterBusy.value=false}}
async function syncAllProjects(){syncCenterBusy.value=true;error.value="";try{const request=fetch('/api/clickup/sync-all',{method:'POST'});const poll=window.setInterval(loadSyncCenter,800);const response=await request;window.clearInterval(poll);if(!response.ok)throw new Error((await response.json()).message);await loadSyncCenter()}catch(e:any){error.value=e.message}finally{syncCenterBusy.value=false}}
function markBriefingReviewed(){localStorage.setItem('orchestrator:briefing-reviewed',new Date().toISOString());loadBriefing()}
function openBriefingItem(item:any){selected.value=item.project.slug;window.setTimeout(()=>{selectedChapter.value=item.target.objective_uid||'';selectedPass.value=item.target.pass_ref||'';pendingEvidence.value=item.target.evidence_uid||'';focusedEvidence.value=pendingEvidence.value;activeView.value=item.target.view||'overview'},0)}
function openAttention(item:any){selected.value=item.project.slug;window.setTimeout(()=>{selectedChapter.value=item.target.objective_uid||'';selectedPass.value=item.target.pass_ref||'';activeView.value=item.target.view||'overview'},0)}
async function runSearch(){const value=globalQuery.value.trim();if(value.length<2){searchResults.value=[];return}searchBusy.value=true;try{const data=await api<any>(`/search?q=${encodeURIComponent(value)}&limit=100`);searchResults.value=data.results;searchPage.value=1;activeView.value='search'}catch(e:any){error.value=e.message}finally{searchBusy.value=false}}
function openSearchResult(item:any){selected.value=item.project.slug;window.setTimeout(()=>{selectedChapter.value=item.target.objective_uid||'';selectedPass.value=item.target.pass_ref||'';activeView.value=item.target.view||'overview'},0)}
const filteredSearchResults=computed(()=>searchType.value==='all'?searchResults.value:searchResults.value.filter(item=>item.type===searchType.value))
const searchPages=computed(()=>Math.max(1,Math.ceil(filteredSearchResults.value.length/15)))
const pagedSearchResults=computed(()=>filteredSearchResults.value.slice((searchPage.value-1)*15,searchPage.value*15))
watch(searchType,()=>searchPage.value=1)
const snapshotKey=()=>`orchestrator:snapshots:${selected.value}`
function loadSnapshots(){try{snapshots.value=JSON.parse(localStorage.getItem(snapshotKey())||'[]')}catch{snapshots.value=[]}snapshotDiff.value=null}
async function captureSnapshot(){snapshotBusy.value=true;try{const snapshot=await api<any>(`/projects/${selected.value}/snapshot`);snapshots.value=[snapshot,...snapshots.value.filter(row=>row.state_hash!==snapshot.state_hash)].slice(0,10);localStorage.setItem(snapshotKey(),JSON.stringify(snapshots.value));if(snapshots.value.length>1)await compareSnapshots()}catch(e:any){error.value=e.message}finally{snapshotBusy.value=false}}
async function compareSnapshots(){if(snapshots.value.length<2)return;const response=await fetch('/api/snapshots/compare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({after:snapshots.value[0],before:snapshots.value[1]})});if(!response.ok)throw new Error((await response.json()).message);snapshotDiff.value=await response.json()}
function downloadSnapshot(snapshot:any){const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=`orchestrator-${snapshot.project.slug}-${snapshot.captured_at.replace(/[: ]/g,'-')}.json`;link.click();URL.revokeObjectURL(url)}
async function loadAnalytics() {
  if (!selected.value) return;
  analyticsBusy.value = true;
  try {
    const scope = analyticsScope.value === "project" ? `&project=${selected.value}` : "";
    analytics.value = await api(`/analytics?days=${analyticsDays.value}${scope}`);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    analyticsBusy.value = false;
  }
}
async function loadAiWorkspace() {
  if (!selected.value) return;
  aiWorkspaceBusy.value = true;
  try { aiWorkspace.value = await api(`/projects/${selected.value}/ai-workspace`); }
  catch (e: any) { error.value = e.message; }
  finally { aiWorkspaceBusy.value = false; }
}
async function loadPlanning(){if(!selected.value)return;planningBusy.value=true;try{planning.value=await api(`/projects/${selected.value}/planning`);const connection=planning.value?.clickup;if(connection)clickupForm.value={workspace_id:connection.workspace_id||"",list_id:connection.list_id||"",tag_name:connection.tag_name||selected.value,token:"",enabled:connection.enabled!==0,status_mapping:{...(connection.status_mapping||{})}}}catch(e:any){error.value=e.message}finally{planningBusy.value=false}}
async function loadClickupResources(){planningBusy.value=true;try{clickupResourcesData.value=await api(`/projects/${selected.value}/clickup/resources`);if(!clickupForm.value.workspace_id&&clickupResourcesData.value.workspaces[0])clickupForm.value.workspace_id=clickupResourcesData.value.workspaces[0].id;if(clickupForm.value.list_id)await loadClickupStatuses()}catch(e:any){error.value=e.message}finally{planningBusy.value=false}}
async function loadClickupStatuses(){clickupListStatusesData.value=[];if(!clickupForm.value.list_id)return;try{const data:any=await api(`/projects/${selected.value}/clickup/statuses?list=${encodeURIComponent(clickupForm.value.list_id)}`);clickupListStatusesData.value=data.statuses||[]}catch(e:any){error.value=e.message}}
async function connectPersonalToken(){planningBusy.value=true;error.value="";try{const response=await fetch(`/api/projects/${selected.value}/clickup/token`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:clickupForm.value.token})});if(!response.ok)throw new Error((await response.json()).message);const data=await response.json();clickupForm.value.token="";clickupResourcesData.value=data.resources;await loadPlanning();if(!clickupForm.value.workspace_id&&data.resources.workspaces[0])clickupForm.value.workspace_id=data.resources.workspaces[0].id}catch(e:any){error.value=e.message}finally{planningBusy.value=false}}
async function runClickupSync(){planningBusy.value=true;error.value="";clickupSync.value={active:true,percent:1,message:"Starting synchronization"};const poll=window.setInterval(async()=>{try{clickupSync.value=await api(`/projects/${selected.value}/clickup/progress`)}catch{}},350);try{const response=await fetch(`/api/projects/${selected.value}/clickup/sync`,{method:'POST'});if(!response.ok)throw new Error((await response.json()).message);clickupSync.value={active:false,percent:100,message:"Synchronization complete"};await loadPlanning();await loadProject()}catch(e:any){error.value=e.message;clickupSync.value={active:false,percent:0,message:e.message,error:true}}finally{window.clearInterval(poll);planningBusy.value=false}}
async function planningAction(path:string,body:any={}){planningBusy.value=true;error.value="";try{const response=await fetch(`/api/projects/${selected.value}/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error((await response.json()).message);await loadPlanning();await loadProject()}catch(e:any){error.value=e.message}finally{planningBusy.value=false}}
async function saveClickup(){planningBusy.value=true;try{const response=await fetch(`/api/projects/${selected.value}/clickup`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(clickupForm.value)});if(!response.ok)throw new Error((await response.json()).message);clickupForm.value.token="";await loadPlanning()}catch(e:any){error.value=e.message}finally{planningBusy.value=false}}
function openAiTarget(target:any){if(!target)return;selectedChapter.value=target.objective_uid||'';activeView.value=target.view||'overview'}
const compactNumber=(value:number)=>new Intl.NumberFormat("en",{notation:"compact",maximumFractionDigits:1}).format(value||0)
const money=(value:number)=>new Intl.NumberFormat("en",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(value||0)
const maxDailyCost=computed(()=>Math.max(0,...(analytics.value?.daily||[]).map((row:any)=>row.cost)))
const maxDailyTokens=computed(()=>Math.max(0,...(analytics.value?.daily||[]).map((row:any)=>row.tokens)))
const todayAnalytics=computed(()=>analytics.value?.daily?.find((row:any)=>row.key===new Date().toISOString().slice(0,10))||null)
const attentionItems=computed(()=>{const rows=attention.value?.items||[],groups=new Map<string,any>(),visible=[];for(const item of rows){if(item.type!=='evidence'||item.severity==='blocked'){visible.push(item);continue}const key=item.project.slug,current=groups.get(key)||{...item,id:`evidence-group:${key}`,objective:{uid:null,title:null},title:'Evidence records need verification',detail:'',count:0};current.count++;current.detail=`${current.count} unverified or unhashed evidence records`;groups.set(key,current)}return[...visible,...groups.values()].sort((a:any,b:any)=>String(b.occurred_at).localeCompare(String(a.occurred_at)))})
function openPortfolioProject(project: any) {
  selected.value = project.slug;
  activeView.value = "overview";
}
function openTrackedProject(project: Project) {
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
    await loadAttention();
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
    const visitKey=`orchestrator:last-visit:${selected.value}`,since=localStorage.getItem(visitKey)||new Date(Date.now()-86400000).toISOString();
    [detail.value, diagram.value, coordination.value, resume.value, confidence.value] = await Promise.all([
      api<Detail>(`/projects/${selected.value}`),
      api<Diagram>(`/projects/${selected.value}/diagram`),
      api<any>(`/projects/${selected.value}/coordination`),
      api<any>(`/projects/${selected.value}/resume?since=${encodeURIComponent(since)}`),
      api<any>(`/projects/${selected.value}/confidence`),
    ]);
    localStorage.setItem(visitKey,new Date().toISOString())
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
  if (pendingEvidence.value) {
    const proof = evidence.value.find(row => row.uid === pendingEvidence.value);
    if (proof && isImage(proof)) previewImage.value = proof;
    else if (proof && isText(proof) && openPreview.value !== proof.uid) await previewText(proof);
    pendingEvidence.value = "";
  }
  evidencePage.value = 1;
  passPage.value = 1;
  eventPage.value = 1;
  comparisonIndex.value = 0;
}
watch(selected, () => {
  if (!restoringNavigation) {
    selectedChapter.value = "";
    selectedPass.value = "";
  }
  loadSnapshots();
  loadProject();
  if(activeView.value==='analytics')loadAnalytics()
  if(activeView.value==='ai')loadAiWorkspace()
  if(activeView.value==='planning')loadPlanning()
});
watch([selected, activeView, selectedChapter, selectedPass, previewImage, openPreview], syncContextUrl);
watch(activeView, (view) => {
  if (view === "briefing" && !briefing.value) loadBriefing();
  if (view === "health" && !systemHealth.value) loadSystemHealth();
  if (view === "sync-center") loadSyncCenter();
  if (view === "projects" && !portfolio.value) loadPortfolio();
  if (view === "analytics" && !analytics.value) loadAnalytics();
  if (view === "ai") loadAiWorkspace();
  if (view === "planning") loadPlanning();
});
let timer: number;
let clickupProgressTimer: number;
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
  window.addEventListener("popstate", restoreFromHistory);
  try {
    await loadProjects();
    await loadAttention();
    loadSavedViews();
    restoringNavigation = false;
    window.history.replaceState(null, "", urlForContext());
    clickupProgressTimer=window.setInterval(async()=>{if(activeView.value==='planning'&&selected.value)try{clickupSync.value=await api(`/projects/${selected.value}/clickup/progress`)}catch{}},1500)
  } catch (e: any) {
    error.value = e.message;
    loading.value = false;
  }
});
function restoreFromHistory() {
  restoringNavigation = true;
  applyUrlState();
  window.setTimeout(() => restoringNavigation = false, 0);
}
onBeforeUnmount(() => {
  window.clearInterval(clickupProgressTimer);
  window.removeEventListener("keydown", closeOnEscape);
  window.removeEventListener("popstate", restoreFromHistory);
});
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
const eventLabel = (event: Event) =>
  event.kind === "cleanup.recorded" ? "Cleanup completed" : assertionLabel(event.assertion);
const cleanupDetail = (event: Event) => {
  if (event.kind !== "cleanup.recorded") return "";
  const removed = Array.isArray(event.payload?.removed) ? event.payload.removed.join(", ") : "generated artifacts";
  const preserved = typeof event.payload?.preserved === "string" ? event.payload.preserved : "source and retained evidence";
  return `Removed: ${removed}. Preserved: ${preserved}.`;
};
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
async function downloadProof(proof: Evidence) {
  verifying.value = proof.uid;
  try {
    const response = await fetch(`/api/evidence/${proof.uid}/download`, { method: "POST" });
    if (!response.ok) throw new Error((await response.json()).message);
    await loadMemory();
  } catch (e: any) { error.value = e.message; }
  finally { verifying.value = ""; }
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
    .map(([id, proofs]) => {
      const ordered = [...proofs].sort((a,b) => String(a.created_at).localeCompare(String(b.created_at)));
      return { id, proofs, images: proofs.filter(isImage), started_at: ordered[0]?.created_at || null, latest_at: ordered.at(-1)?.created_at || null };
    })
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
const flowSummary=computed(()=>{const roots=graphNodes.value,current=roots.find(node=>node.phase==='blocked')||roots.find(node=>node.phase==='active')||null,next=roots.find(node=>node.phase==='planned')||null;return{current,next,completed:roots.filter(node=>node.phase==='completed').length,returns:(diagram.value?.edges||[]).filter(edge=>['returns','retry'].includes(edge.type)).length}})
const graphNode = (id: string) =>
  graphNodes.value.find((node) => node.id === id);
const edgeCritical=(edge:{from:string;to:string;type:string})=>{const from=graphNode(edge.from),to=graphNode(edge.to);return edge.type==='precedes'&&Boolean(from&&to&&['active','blocked'].includes(from.phase)&&to.phase==='planned')}
function inspectGraphNode(id:string){const chapter=detail.value?.chapters.find(row=>row.uid===id);if(chapter)inspectChapter(chapter)}
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
        ><img :src="orchestratorMark" alt="" width="40" height="40">
        <div>Orchestrator<small>Project memory</small></div></a
      >
      <section class="nav-section nav-section-global">
        <div class="nav-heading"><span>Workspace</span><small>Global</small></div>
        <nav aria-label="Workspace" class="workspace-nav">
          <button class="all-projects" :class="{ active: activeView === 'briefing' }" @click="activeView = 'briefing'; loadBriefing()"><span>Recent briefing</span><small>What changed</small></button>
          <button class="all-projects" :class="{ active: activeView === 'attention' }" @click="activeView = 'attention'; loadAttention()"><span>Attention center</span><small>{{ attentionItems.length }} signals</small></button>
          <button class="all-projects" :class="{ active: activeView === 'health' }" @click="activeView = 'health'; loadSystemHealth()"><span>System health</span><small>Read-only checks</small></button>
          <button class="all-projects" :class="{ active: activeView === 'sync-center' }" @click="activeView = 'sync-center'; loadSyncCenter()"><span>Sync center</span><small>ClickUp portfolio</small></button>
          <button class="all-projects" :class="{ active: activeView === 'search' }" @click="activeView = 'search'"><span>Search memory</span><small>All records</small></button>
          <button class="all-projects" :class="{ active: activeView === 'projects' }" @click="activeView = 'projects'; loadPortfolio()"><span>All projects</span><small>Global view</small></button>
        </nav>
      </section>
      <section class="nav-section nav-section-projects">
        <div class="nav-heading"><span>Tracked projects</span><small>{{ projects.length }}</small></div>
        <nav aria-label="Tracked projects" class="project-nav">
          <button
            v-for="p in projects"
            :key="p.uid"
            :class="{ active: !isGlobalView(activeView) && selected === p.slug }"
            :aria-current="!isGlobalView(activeView) && selected === p.slug ? 'page' : undefined"
            @click="openTrackedProject(p)"
          >
            <span>{{ p.name }}</span
            ><small>{{ p.open_blockers ? `${p.open_blockers} blocked` : 'On track' }}</small>
          </button>
        </nav>
      </section>
      <section v-if="savedViews.length" class="nav-section nav-section-saved">
        <div class="nav-heading"><span>Saved views</span><small>{{ savedViews.length }}</small></div>
        <nav aria-label="Saved views" class="saved-nav">
          <div v-for="view in savedViews" :key="view.id" class="saved-nav-row">
            <button @click="openSavedView(view)"><span>{{ view.label }}</span><small>{{ view.context }}</small></button>
            <button class="saved-remove" :aria-label="`Remove ${view.label} saved view`" @click="removeSavedView(view.id)">×</button>
          </div>
        </nav>
      </section>
      <div class="boundary">
        <strong>Observation only</strong>
        <p>Orchestrator records state and evidence. It never executes work.</p>
      </div>
    </aside>
    <main id="main-content" tabindex="-1">
      <header>
        <div>
          <p class="eyebrow">{{ activeView === "search" ? "Universal search" : activeView === "briefing" ? "Global resume" : activeView === "attention" ? "Global attention" : activeView === "health" ? "Register integrity" : activeView === "sync-center" ? "Passive connectors" : activeView === "projects" ? "Global portfolio" : "Project record" }}</p>
          <h1>{{ activeView === "search" ? "Search memory" : activeView === "briefing" ? "Recent briefing" : activeView === "attention" ? "Attention center" : activeView === "health" ? "System health" : activeView === "sync-center" ? "Sync center" : activeView === "projects" ? "Projects" : detail?.name || "Project memory" }}</h1>
          <p>
            {{
              activeView === "search" ? "Projects, objectives, events, decisions, evidence, paths and hashes." : activeView === "briefing" ? "Changes across every active project since your last review." : activeView === "attention" ? "Decisions and risks that require a closer look." : activeView === "health" ? "Read-only integrity, backup and evidence-retention checks." : activeView === "sync-center" ? "Scheduled ClickUp registry synchronization across every connected project." : activeView === "projects"
                ? "Tracked work, local discoveries and multi-machine state."
                : detail?.description ||
              "Auditable history and conversation handoff."
            }}
          </p>
        </div>
        <form class="global-search" role="search" @submit.prevent="runSearch"><input v-model="globalQuery" aria-label="Search all project memory" placeholder="Search memory…" minlength="2"><button :disabled="searchBusy || globalQuery.trim().length < 2">{{ searchBusy ? 'Searching…' : 'Search' }}</button></form>
        <div v-if="!isGlobalView(activeView)" class="exports">
          <button @click="copyContextLink">{{ shareState }}</button>
          <button @click="saveCurrentView">{{ saveState }}</button>
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
            'ai',
            'planning',
            'chapters',
            'evidence',
            'diagram',
            'snapshots',
            'analytics',
            'memory',
          ]"
          :key="view"
          v-show="!isGlobalView(activeView)"
          :class="{ active: activeView === view }"
          role="tab"
          :aria-selected="activeView === view"
          :aria-label="`${view} view`"
          @click="activeView = view as any; view === 'projects' && loadPortfolio(); view === 'analytics' && loadAnalytics(); view === 'ai' && loadAiWorkspace(); view === 'planning' && loadPlanning()"
        >
          {{ view }}
        </button>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <section v-if="activeView === 'search'" class="search-screen"><section class="panel search-results"><div class="panel-head"><div><p class="eyebrow">{{ filteredSearchResults.length }} results</p><h2>“{{ globalQuery }}”</h2></div><select v-model="searchType" aria-label="Filter search results by type"><option value="all">All types</option><option v-for="type in [...new Set(searchResults.map(item=>item.type))]" :key="type" :value="type">{{ type }}</option></select></div><p v-if="!searchBusy && !filteredSearchResults.length" class="empty">No matching memory records.</p><button v-for="item in pagedSearchResults" :key="item.id" class="search-row" @click="openSearchResult(item)"><span class="attention-kind">{{ item.type }}</span><div><strong>{{ item.title }}</strong><p>{{ item.project.name }} · {{ item.subtitle }}</p></div><time>{{ date(item.occurred_at) }}</time><span>Open →</span></button><div v-if="filteredSearchResults.length" class="pagination"><button :disabled="searchPage===1" @click="searchPage--">Previous</button><span>{{ filteredSearchResults.length }} results · Page {{ searchPage }} / {{ searchPages }}</span><button :disabled="searchPage===searchPages" @click="searchPage++">Next</button></div></section></section>
      <section v-else-if="activeView === 'briefing'" class="briefing-screen"><div v-if="briefingBusy && !briefing" class="panel empty">Building recent briefing…</div><template v-else-if="briefing"><section class="briefing-summary" aria-label="Briefing summary"><article><span>Changes</span><strong>{{ briefing.summary.events }}</strong></article><article><span>Active projects changed</span><strong>{{ briefing.summary.projects }}</strong></article><article><span>New evidence</span><strong>{{ briefing.summary.evidence }}</strong></article><article><span>Decisions and blockers</span><strong>{{ briefing.summary.decisions + briefing.summary.blockers }}</strong></article></section><section class="panel briefing-projects"><div class="panel-head"><div><p class="eyebrow">Since {{ date(briefing.since) }}</p><h2>Changes by project</h2></div><div class="briefing-actions"><a :href="`/api/briefing/export/json?since=${encodeURIComponent(briefing.since)}`">Export JSON</a><a :href="`/api/briefing/export/markdown?since=${encodeURIComponent(briefing.since)}`">Export Markdown</a><button class="text-button" :disabled="briefingBusy" @click="markBriefingReviewed">Mark all reviewed</button></div></div><p v-if="!briefing.projects.length" class="empty good">No changes since your last review.</p><button v-for="project in briefing.projects" :key="project.slug" class="briefing-project" @click="selected=project.slug;activeView='overview'"><div><strong>{{ project.name }}</strong><p>{{ project.latest_summary }}</p></div><span>{{ project.events }} changes · {{ project.evidence }} evidence · {{ project.decisions }} decisions</span></button></section><section v-if="briefing.recent.length" class="panel briefing-feed"><div class="panel-head"><div><p class="eyebrow">Latest records</p><h2>Activity feed</h2></div></div><button v-for="item in briefing.recent" :key="item.uid" @click="openBriefingItem(item)"><span class="attention-kind">{{ item.kind.replace('.recorded','').replace('.',' ') }}</span><div><strong>{{ item.summary }}</strong><p>{{ item.project.name }}<template v-if="item.objective_title"> · {{ item.objective_title }}</template> · {{ item.actor }}</p></div><time>{{ date(item.occurred_at) }}</time><span>Open →</span></button></section></template></section>
      <section v-else-if="activeView === 'attention'" class="attention-screen">
        <div v-if="attentionBusy && !attention" class="panel empty" role="status" aria-live="polite">Collecting attention signals…</div>
        <template v-else-if="attention">
          <section class="attention-summary" aria-label="Attention summary"><article><span>Actionable signals</span><strong>{{ attentionItems.length }}</strong></article><article><span>Human decisions</span><strong>{{ attention.counts.judgments }}</strong></article><article><span>Open blockers</span><strong>{{ attention.counts.blockers }}</strong></article><article><span>Evidence debt</span><strong>{{ attention.counts.evidence }}</strong></article></section>
          <section class="panel attention-list"><div class="panel-head"><div><p class="eyebrow">Actionable signals</p><h2>Across active projects</h2></div><button class="text-button" :disabled="attentionBusy" @click="loadAttention">Refresh</button></div><p v-if="!attentionItems.length" class="empty good">Nothing currently requires attention.</p><button v-for="item in attentionItems" :key="item.id" class="attention-row" :data-severity="item.severity" @click="openAttention(item)"><span class="attention-kind">{{ item.type.replace('_',' ') }}</span><div><strong>{{ item.title }}</strong><p>{{ item.project.name }}<template v-if="item.objective.title"> · {{ item.objective.title }}</template></p><small>{{ item.detail || 'Open context' }} · {{ date(item.occurred_at) }}</small></div><span class="attention-open">Open →</span></button></section>
        </template>
      </section>
      <SystemHealthPanel v-else-if="activeView === 'health'" :health="systemHealth" :busy="systemHealthBusy" @refresh="loadSystemHealth" />
      <section v-else-if="activeView === 'sync-center'" class="sync-center-screen">
        <div v-if="syncCenterBusy && !syncCenter" class="panel empty" role="status">Loading connector state…</div>
        <template v-else-if="syncCenter">
          <section class="panel sync-center-hero"><div><p class="eyebrow">Portfolio schedule</p><h2>{{ syncCenter.scheduler.enabled ? `Every ${syncCenter.scheduler.minutes} minutes` : 'Scheduled sync disabled' }}</h2><p>Next cycle: {{ date(syncCenter.scheduler.next_run_at) }} · Last started: {{ date(syncCenter.scheduler.last_started_at) }}</p></div><button :disabled="syncCenterBusy || syncCenter.all_progress.active" @click="syncAllProjects">{{ syncCenter.all_progress.active ? `${syncCenter.all_progress.percent}% · ${syncCenter.all_progress.message}` : 'Sync all projects now' }}</button></section>
          <section v-if="syncCenter.all_progress.active || syncCenter.all_progress.percent" class="panel portfolio-sync-progress"><div><span>{{ syncCenter.all_progress.message }}</span><strong>{{ syncCenter.all_progress.percent }}%</strong></div><progress :value="syncCenter.all_progress.percent" max="100"></progress></section>
          <section class="sync-project-grid"><article v-for="connection in syncCenter.connections" :key="connection.slug" class="panel sync-project-card" :data-status="connection.last_status"><div class="panel-head"><div><p class="eyebrow">{{ connection.tag_name || connection.slug }}</p><h2>{{ connection.name }}</h2></div><span class="status" :data-status="connection.last_status">{{ connection.last_status }}</span></div><p>{{ connection.last_detail || 'Never synchronized' }}</p><div class="sync-project-meta"><span>Last {{ date(connection.last_sync_at) }}</span><span>List {{ connection.list_id }}</span></div><div v-if="connection.progress.active" class="mini-sync"><i :style="{width:`${connection.progress.percent}%`}"></i><small>{{ connection.progress.message }}</small></div><button @click="selected=connection.slug;activeView='planning'">Open project settings →</button></article></section>
          <section class="panel sync-history"><div class="panel-head"><div><p class="eyebrow">Audit history</p><h2>Latest synchronization runs</h2></div><button class="secondary" :disabled="syncCenterBusy" @click="loadSyncCenter">Refresh</button></div><p v-if="!syncCenter.history.length" class="empty">No recorded run yet.</p><article v-for="run in syncCenter.history" :key="run.id"><span class="status" :data-status="run.status">{{ run.status }}</span><div><strong>{{ run.project_name }}</strong><p>{{ run.message }}</p></div><span>{{ run.trigger }}</span><span>{{ run.created }} created · {{ run.updated }} updated · {{ run.attachments }} files</span><time>{{ date(run.started_at) }}</time></article></section>
        </template>
      </section>
      <section v-else-if="activeView === 'projects'" class="portfolio-screen">
        <div v-if="portfolioBusy && !portfolio" class="panel empty" role="status" aria-live="polite">Loading local project inventory…</div>
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
              <dl><div><dt>Progress</dt><dd>{{ project.proven }} / {{ project.objectives }}</dd></div><div><dt>Confidence</dt><dd><span class="confidence-pill" :data-level="project.confidence.label">{{ project.confidence.score }} · {{ project.confidence.label }}</span></dd></div><div><dt>Last activity</dt><dd>{{ date(project.last_activity) }}</dd></div><div><dt>Machines</dt><dd>{{ project.machines.length ? project.machines.join(', ') : 'None reported' }}</dd></div><div><dt>Git</dt><dd v-if="project.git">{{ project.git.branch }} · <code>{{ project.git.head_commit?.slice(0,10) }}</code><span :class="{warn:project.git.dirty}">{{ project.git.dirty ? 'dirty' : 'clean' }}</span></dd><dd v-else>Not reported</dd></div></dl>
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
                  <span class="tag" :data-kind="event.kind === 'cleanup.recorded' ? 'cleanup' : event.assertion">{{
                    eventLabel(event)
                  }}</span>
                  <h3>{{ event.summary }}</h3>
                  <p v-if="cleanupDetail(event)" class="event-detail">{{ cleanupDetail(event) }}</p>
                  <p>
                    {{ event.objective_title || event.kind }} ·
                    {{ event.actor }}
                  </p>
                </div>
              </li>
            </ol>
          </section>
          <div class="stack">
            <section v-if="confidence" class="panel confidence-card"><div class="confidence-head"><div><p class="eyebrow">Auditable confidence</p><h2>Project confidence</h2></div><strong :data-level="confidence.label">{{ confidence.score }}</strong></div><div class="confidence-components"><div v-for="(component,key) in confidence.components" :key="key"><span>{{ String(key).replace('_',' ') }}</span><i><b :style="{width:`${component.score}%`}"></b></i><strong>{{ component.score }}</strong></div></div><p>{{ confidence.components.evidence.coverage }}% evidence coverage · {{ confidence.components.blockers.active }} blockers · {{ confidence.components.coordination.conflicts }} pass conflicts</p></section>
            <section v-if="resume" class="panel resume-card"><div class="panel-head"><div><p class="eyebrow">Since your last visit</p><h2>{{ resume.summary.events ? `${resume.summary.events} changes` : 'No new changes' }}</h2></div><small>{{ date(resume.since) }}</small></div><div class="resume-metrics"><span><strong>{{ resume.summary.evidence }}</strong> evidence</span><span><strong>{{ resume.summary.decisions }}</strong> decisions</span><span><strong>{{ resume.summary.blockers }}</strong> blocker updates</span><span><strong>{{ resume.summary.changed_objectives }}</strong> objectives</span></div><p v-if="resume.recent[0]">Latest: {{ resume.recent[0].summary }}</p><p v-else>Your project state is unchanged since the previous visit.</p></section>
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
                    {{ connection.cloud_evidence }} cloud evidence ·
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
                      : "Sync memory + evidence"
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
                  <span class="tag" :data-kind="event.kind === 'cleanup.recorded' ? 'cleanup' : event.assertion">{{
                    eventLabel(event)
                  }}</span>
                  <h3>{{ event.summary }}</h3>
                  <p v-if="cleanupDetail(event)" class="event-detail">{{ cleanupDetail(event) }}</p>
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
            <article
              v-for="pass in pagedPasses"
              :key="pass.id"
              class="pass-row"
              :class="{ selected: selectedPass === pass.id }"
            >
              <button class="pass-select" :aria-pressed="selectedPass === pass.id" @click="selectedPass = selectedPass === pass.id ? '' : pass.id; evidencePage = 1">
                <strong>Pass {{ pass.id }}</strong
                ><span
                  >{{ pass.proofs.length }} evidence records ·
                  {{ pass.images.length }} images</span
                ><time>{{ date(pass.started_at) }}<template v-if="pass.latest_at && pass.latest_at !== pass.started_at"> → {{ date(pass.latest_at) }}</template></time>
              </button>
              <div class="pass-thumbs">
                <button
                  v-for="proof in pass.images.slice(0, 4)"
                  :key="proof.uid"
                  :aria-label="`Open ${proof.label}`"
                  @click="focusedEvidence = proof.uid; previewImage = proof"
                ><img :src="previewUrl(proof)" :alt="proof.label" loading="lazy" /></button><span v-if="!pass.images.length">No image</span>
              </div>
            </article>
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
                <figure role="button" tabindex="0" :aria-label="`Open before image: ${comparisonPair.before.label}`" @click="previewImage = comparisonPair.before" @keydown.enter="previewImage = comparisonPair.before" @keydown.space.prevent="previewImage = comparisonPair.before">
                  <span>Before</span>
                  <img
                    :src="previewUrl(comparisonPair.before)"
                    :alt="comparisonPair.before.label"
                  />
                  <figcaption>{{ comparisonPair.before.label }}</figcaption>
                </figure>
                <figure role="button" tabindex="0" :aria-label="`Open after image: ${comparisonPair.after.label}`" @click="previewImage = comparisonPair.after" @keydown.enter="previewImage = comparisonPair.after" @keydown.space.prevent="previewImage = comparisonPair.after">
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
            <div class="evidence-table" role="list" aria-label="Evidence records">
              <article
                v-for="proof in pagedEvidence"
                :key="proof.uid"
                class="evidence-row"
                :id="`proof-${proof.uid}`"
                :data-focused="focusedEvidence === proof.uid"
                role="listitem"
              >
                <div class="evidence-main">
                  <img
                    v-if="proof.status === 'available' && isImage(proof)"
                    :src="previewUrl(proof)"
                    :alt="proof.label"
                    loading="lazy"
                    role="button"
                    tabindex="0"
                    :aria-label="`Open ${proof.label}`"
                    @click="focusedEvidence = proof.uid; previewImage = proof"
                    @keydown.enter="focusedEvidence = proof.uid; previewImage = proof"
                    @keydown.space.prevent="focusedEvidence = proof.uid; previewImage = proof"
                  />
                  <div>
                    <span class="status" :data-status="proof.status">{{
                      proof.status
                    }}</span>
                    <span v-if="proof.local_available" class="status" data-status="available">local</span>
                    <span v-else-if="proof.cloud_providers.length" class="status" data-status="cloud">cloud-only</span>
                    <h3>{{ proof.label }}</h3>
                    <p>
                      {{ proof.objective_title || "Project-level evidence" }} ·
                      {{
                        proof.pass_ref
                          ? `Pass ${proof.pass_ref}`
                          : "No pass reference"
                      }}
                    </p>
                    <time>Recorded {{ date(proof.created_at) }}</time>
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
                  <div>
                    <dt>Date and time</dt>
                    <dd>{{ date(proof.created_at) }}</dd>
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
                    v-if="!proof.local_available && proof.cloud_providers.length"
                    class="text-button"
                    :disabled="verifying === proof.uid"
                    @click="downloadProof(proof)"
                  >{{ verifying === proof.uid ? "Downloading…" : "Download evidence" }}</button
                  ><button
                    v-if="proof.status === 'available' && isText(proof)"
                    class="text-button"
                    @click="focusedEvidence = proof.uid; previewText(proof)"
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
          <section class="flow-summary" aria-label="Flow summary"><article><span>Current</span><strong>{{ flowSummary.current?.label || 'No active chapter' }}</strong></article><article><span>Next planned</span><strong>{{ flowSummary.next?.label || 'None' }}</strong></article><article><span>Completed</span><strong>{{ flowSummary.completed }} / {{ graphNodes.length }}</strong></article><article><span>Returns</span><strong>{{ flowSummary.returns }}</strong></article></section>
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
                  :class="[`edge-${edge.type}`,{ 'edge-critical': edgeCritical(edge) }]"
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
                role="button"
                tabindex="0"
                :aria-label="`Open ${node.label}, ${node.phase}`"
                @click="inspectGraphNode(node.id)"
                @keydown.enter="inspectGraphNode(node.id)"
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
        <section v-else-if="activeView === 'planning'" class="planning-screen">
          <div v-if="planningBusy && !planning" class="panel empty" role="status">Analysing recorded work…</div>
          <template v-else-if="planning">
            <section class="panel planning-hero"><div><p class="eyebrow">Human-approved planning</p><h2>Proposed chapters and tasks</h2><p>Describe a need or analyse recorded project state and local Codex/Claude memory. Orchestrator never starts the work.</p><textarea v-model="planningNeed" rows="3" placeholder="What outcome, correction or instruction does this project need?"></textarea></div><div class="planning-hero-actions"><button :disabled="planningBusy || !planningNeed.trim()" @click="planningAction('planning/generate',{need:planningNeed});planningNeed=''">Propose from this need</button><button class="secondary" :disabled="planningBusy" @click="planningAction('planning/generate')">{{ planningBusy ? 'Analysing…' : 'Analyse existing work' }}</button></div></section>
            <section class="planning-grid">
              <div class="panel proposal-list"><div class="panel-head"><div><p class="eyebrow">Review queue</p><h2>{{ planning.proposals.filter((p:any)=>p.status==='proposed').length }} proposals</h2></div></div><p v-if="!planning.proposals.length" class="empty">Run the analysis to create deduplicated suggestions.</p>
                <article v-for="proposal in planning.proposals" :key="proposal.uid" class="proposal-card" :data-status="proposal.status"><div><span class="status" :data-status="proposal.status">{{ proposal.status }}</span><small>{{ proposal.kind }} · {{ proposal.source_kind.replace('_',' ') }}</small><h3>{{ proposal.title }}</h3><p>{{ proposal.body || proposal.rationale }}</p><small v-if="proposal.success_criteria">Done when: {{ proposal.success_criteria }}</small><a v-if="proposal.ticket_url" :href="proposal.ticket_url" target="_blank" rel="noreferrer">Open ClickUp ticket →</a></div><div v-if="proposal.status==='proposed'" class="proposal-actions"><button @click="planningAction(`planning/${proposal.uid}/review`,{status:'approved',reviewer:'dashboard'})">Approve</button><button class="secondary" @click="planningAction(`planning/${proposal.uid}/review`,{status:'rejected',reviewer:'dashboard'})">Reject</button></div></article>
              </div>
              <form class="panel clickup-settings" @submit.prevent="saveClickup">
                <div><p class="eyebrow">Optional external registry</p><h2>ClickUp connection</h2><p>Connect once, choose a destination, then publish only approved proposals.</p></div>
                <a v-if="planning.clickup.oauth.available && !planning.clickup.connected" class="clickup-connect" :href="`/api/clickup/oauth/start?project=${selected}`">Connect with ClickUp <span>↗</span></a>
                <div v-if="planning.clickup.connected" class="connected-badge"><span>✓</span><div><strong>ClickUp authorized globally</strong><small>One local token shared by every project · never exported</small></div><button type="button" class="secondary" @click="loadClickupResources">Load destinations</button></div>
                <section v-if="planning.clickup.progress.tickets || planning.clickup.progress.proposals.length" class="clickup-progress"><div><span>Published tickets</span><strong>{{ planning.clickup.progress.tickets }}</strong></div><div v-for="item in planning.clickup.progress.statuses" :key="item.status"><span>{{ item.status }}</span><strong>{{ item.count }}</strong></div><small v-if="planning.clickup.last_sync_at">Updated {{ date(planning.clickup.last_sync_at) }}</small></section>
                <label v-if="clickupResourcesData.workspaces.length">Workspace<select v-model="clickupForm.workspace_id" @change="clickupForm.list_id=''" required><option value="" disabled>Choose workspace</option><option v-for="workspace in clickupResourcesData.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select></label>
                <label v-if="clickupResourcesData.lists.length">Destination list<select v-model="clickupForm.list_id" required @change="loadClickupStatuses"><option value="" disabled>Choose list</option><option v-for="list in clickupLists" :key="list.id" :value="list.id">{{ list.space_name }}<template v-if="list.folder_name"> / {{ list.folder_name }}</template> / {{ list.name }}</option></select></label>
                <label v-if="planning.clickup.connected">Project tag<input v-model="clickupForm.tag_name" required maxlength="80" placeholder="Project label"><small>Created automatically in the selected ClickUp Space when missing.</small></label>
                <section v-if="planning.clickup.connected" class="mapping-summary"><div><strong>Workflow mapping</strong><small>{{ Object.keys(clickupForm.status_mapping || {}).length ? 'Custom mapping for this project' : 'Recommended automatic mapping' }}</small></div><button type="button" class="secondary" @click="openClickupMapping">Configure</button></section>
                <details class="manual-token" :open="!planning.clickup.connected"><summary>{{ planning.clickup.connected ? 'Replace global personal token' : 'Connect Orchestrator to ClickUp' }}</summary><label>Personal API token<input v-model="clickupForm.token" type="password" placeholder="pk_…" autocomplete="new-password"><small>Saved once for Orchestrator. Project destinations remain independent.</small></label><button type="button" class="token-connect" :disabled="planningBusy || !clickupForm.token.startsWith('pk_')" @click="connectPersonalToken">Connect account and load destinations</button></details>
                <label class="check"><input v-model="clickupForm.enabled" type="checkbox"><span>Enable passive synchronization</span></label>
                <section v-if="clickupSync.active || clickupSync.percent" class="sync-progress" :data-error="Boolean(clickupSync.error)" role="status" aria-live="polite"><div><span>{{ clickupSync.message }}</span><strong>{{ clickupSync.percent }}%</strong></div><progress :value="clickupSync.percent" max="100">{{ clickupSync.percent }}%</progress></section>
                <div class="clickup-actions"><button class="primary" :disabled="planningBusy || !clickupForm.list_id">Save destination</button><button type="button" class="secondary" :disabled="planningBusy || !planning.clickup?.enabled || !planning.clickup?.list_id" @click="runClickupSync">Sync full registry</button></div>
                <p v-if="planning.clickup?.last_detail" class="sync-detail" :data-status="planning.clickup.last_status">{{ planning.clickup.last_detail }}</p>
                <div v-if="clickupMappingOpen" class="mapping-modal" role="dialog" aria-modal="true" aria-labelledby="mapping-title" @click.self="clickupMappingOpen=false"><section class="mapping-card"><div class="panel-head"><div><p class="eyebrow">Project-specific routing</p><h2 id="mapping-title">Orchestrator → ClickUp statuses</h2></div><button type="button" class="icon-close secondary" aria-label="Close status mapping" @click="clickupMappingOpen=false">×</button></div><p>Choose a ClickUp status for each Orchestrator state. Leave a row on Recommended to use the semantic default for this list.</p><div class="mapping-grid"><label v-for="kind in statusKinds" :key="kind[0]"><span><strong>{{ kind[1] }}</strong><small>Orchestrator</small></span><span aria-hidden="true">→</span><select v-model="clickupForm.status_mapping[kind[0]]"><option value="">Recommended</option><option v-for="status in clickupStatuses" :key="status.status" :value="status.status">{{ status.status }}</option></select></label></div><p v-if="!clickupStatuses.length" class="oauth-note">Load destinations and select a ClickUp list to retrieve its available statuses.</p><div class="mapping-actions"><button type="button" class="secondary" @click="resetClickupMapping">Use recommended defaults</button><button type="button" @click="clickupMappingOpen=false">Apply mapping</button></div></section></div>
              </form>
            </section>
          </template>
        </section>
        <section v-else-if="activeView === 'ai'" class="ai-workspace-screen">
          <div v-if="aiWorkspaceBusy && !aiWorkspace" class="panel empty" role="status">Building AI workspace…</div>
          <template v-else-if="aiWorkspace">
            <section class="panel ai-next" :data-kind="aiWorkspace.next.kind"><div><p class="eyebrow">What should I work on next?</p><h2>{{ aiWorkspace.next.title }}</h2><p>{{ aiWorkspace.next.reason }}</p></div><button @click="openAiTarget(aiWorkspace.next.target)">Open context →</button></section>
            <section class="ai-summary" aria-label="AI workspace summary"><article><span>Professional capabilities</span><strong>{{ aiWorkspace.summary.features }}</strong></article><article><span>Ready</span><strong>{{ aiWorkspace.summary.ready }}</strong></article><article><span>Need attention</span><strong>{{ aiWorkspace.summary.attention }}</strong></article><article><span>Confidence</span><strong>{{ aiWorkspace.summary.confidence }}</strong></article></section>
            <section class="panel ai-toolbar"><div><p class="eyebrow">Conversation continuity</p><h2>Agent-ready handoff</h2><p>Immutable memory, current Git context and next safe action. Orchestrator does not execute it.</p></div><div><a :href="`/api/projects/${selected}/handoff.md`">Download Markdown</a><a :href="`/api/projects/${selected}/handoff.json`">Download JSON</a><button :disabled="aiWorkspaceBusy" @click="loadAiWorkspace">Refresh</button></div></section>
            <section class="ai-feature-grid">
              <article v-for="feature in aiWorkspace.features" :key="feature.id" class="panel ai-feature" :data-status="feature.status">
                <div class="ai-feature-head"><span class="ai-feature-state">{{ feature.status }}</span><strong v-if="feature.metric !== null">{{ feature.metric }}</strong></div>
                <h3>{{ feature.title }}</h3><p>{{ feature.summary }}</p>
                <ul v-if="feature.items.length"><li v-for="(item,index) in feature.items.slice(0,4)" :key="index"><strong>{{ item.title || item.name || item.agent || item.command || item.summary || item.kind }}</strong><small v-if="item.status || item.detail || item.reason">{{ item.status || item.detail || item.reason }}</small></li></ul>
                <p v-else class="empty compact">No recorded item.</p>
              </article>
            </section>
          </template>
        </section>
        <section v-else-if="activeView === 'snapshots'" class="snapshots-screen"><section class="panel snapshot-actions"><div><p class="eyebrow">Portable checkpoints</p><h2>Project snapshots</h2><p>Metadata and derived state only. Evidence files remain referenced.</p></div><button :disabled="snapshotBusy" @click="captureSnapshot">{{ snapshotBusy ? 'Capturing…' : 'Capture snapshot' }}</button></section><section v-if="snapshotDiff" class="panel snapshot-diff"><div class="panel-head"><div><p class="eyebrow">Latest comparison</p><h2>{{ snapshotDiff.identical ? 'No state change' : 'Changes detected' }}</h2></div><span>{{ snapshotDiff.before.state_hash.slice(7,15) }} → {{ snapshotDiff.after.state_hash.slice(7,15) }}</span></div><div class="snapshot-metrics"><article><strong>{{ snapshotDiff.summary.status_changes }}</strong><span>Status changes</span></article><article><strong>{{ snapshotDiff.summary.added_evidence }}</strong><span>New evidence</span></article><article><strong>{{ snapshotDiff.summary.opened_blockers }}</strong><span>Opened blockers</span></article><article><strong>{{ snapshotDiff.summary.confidence_delta > 0 ? '+' : '' }}{{ snapshotDiff.summary.confidence_delta }}</strong><span>Confidence</span></article></div><ul><li v-for="change in snapshotDiff.status_changes" :key="change.uid"><strong>{{ change.title }}</strong><span>{{ change.before || 'new' }} → {{ change.after }}</span></li></ul></section><section class="panel snapshot-list"><div class="panel-head"><div><p class="eyebrow">Local browser archive</p><h2>Captured states</h2></div><span>{{ snapshots.length }} / 10</span></div><p v-if="!snapshots.length" class="empty">No snapshot captured in this browser.</p><article v-for="snapshot in snapshots" :key="snapshot.state_hash"><div><strong>{{ date(snapshot.captured_at) }}</strong><code>{{ snapshot.state_hash }}</code><p>Event {{ snapshot.cursor.event_id }} · Confidence {{ snapshot.confidence.score }}</p></div><button @click="downloadSnapshot(snapshot)">Download JSON</button></article></section></section>
        <section v-else-if="activeView === 'analytics'" class="analytics-screen">
          <div v-if="analyticsBusy && !analytics" class="panel empty" role="status" aria-live="polite">Loading reported usage…</div>
          <template v-else-if="analytics">
            <section class="panel analytics-toolbar" aria-label="Analytics controls">
              <div><p class="eyebrow">Usage scope</p><h2>{{ analyticsScope === 'project' ? detail?.name : 'All projects' }}</h2><p>Reported events and read-only local estimates.</p></div>
              <div class="analytics-controls">
                <label>Scope<select v-model="analyticsScope" @change="loadAnalytics"><option value="project">Current project</option><option value="global">All projects</option></select></label>
                <label>Period<select v-model="analyticsDays" @change="loadAnalytics"><option :value="7">7 days</option><option :value="30">30 days</option><option :value="90">90 days</option><option :value="365">1 year</option></select></label>
              </div>
            </section>
            <section class="analytics-metrics">
              <article><span>Cost today</span><strong>{{ todayAnalytics && todayAnalytics.cost > 0 ? money(todayAnalytics.cost) : '—' }}</strong><small>{{ todayAnalytics?.unknown_costs ? `${todayAnalytics.unknown_costs} records have unknown cost` : 'No cost reported today' }}</small></article>
              <article><span>Reported cost · {{ analyticsDays }} days</span><strong>{{ money(analytics.totals.cost) }}</strong><small>{{ money(analytics.totals.measured_cost) }} measured · {{ money(analytics.totals.estimated_cost) }} estimated</small></article>
              <article><span>Codex API equivalent · today</span><strong>{{ analyticsScope === 'project' ? money(analytics.local_today?.machine_total?.estimated_cost || 0) : '—' }}</strong><small>{{ analyticsScope === 'project' ? `Estimated from ${compactNumber(analytics.local_today?.machine_total?.total_tokens || 0)} local tokens · not an invoice` : 'Select one project for local usage' }}</small></article>
              <article><span>Total tokens</span><strong>{{ compactNumber(analytics.totals.total_tokens) }}</strong><small>{{ compactNumber(analytics.totals.input_tokens) }} input · {{ compactNumber(analytics.totals.output_tokens) }} output</small></article>
              <article><span>Cached tokens</span><strong>{{ compactNumber(analytics.totals.cached_tokens) }}</strong><small>{{ analytics.totals.token_records }} records include token usage</small></article>
              <article><span>Efficiency</span><strong>{{ analytics.efficiency?.cost_per_proven == null ? '—' : money(analytics.efficiency.cost_per_proven) }}</strong><small>Cost per proven objective · {{ analytics.totals.unknown_costs }} unknown costs</small></article>
            </section>
            <div class="analytics-grid">
              <section class="panel chart-panel"><div class="panel-head"><div><p class="eyebrow">Reported spend</p><h2>Cost by day</h2></div><span class="scope-note">Measured + estimated</span></div><p v-if="!analytics.daily.length" class="empty">No cost records in this period.</p><div v-else class="bar-chart" role="img" aria-label="Daily reported costs"><div v-for="day in analytics.daily" :key="day.key" class="bar-column"><span>{{ day.cost > 0 ? money(day.cost) : day.unknown_costs ? '—' : money(0) }}</span><i :style="{height:`${maxDailyCost && day.cost ? Math.max(3,day.cost/maxDailyCost*100) : 3}%`}"></i><small>{{ day.key.slice(5) }}</small></div></div></section>
              <section class="panel chart-panel"><div class="panel-head"><div><p class="eyebrow">Model usage</p><h2>Tokens by day</h2></div><span class="scope-note">Externally reported only</span></div><p v-if="!analytics.totals.token_records" class="empty">No token usage has been reported yet. Future Codex/Claude clients can publish it through cost.recorded.</p><div v-else class="bar-chart tokens" role="img" aria-label="Daily reported tokens"><div v-for="day in analytics.daily" :key="day.key" class="bar-column"><span>{{ compactNumber(day.tokens) }}</span><i :style="{height:`${maxDailyTokens ? Math.max(3,day.tokens/maxDailyTokens*100) : 3}%`}"></i><small>{{ day.key.slice(5) }}</small></div></div></section>
            </div>
            <section class="panel analytics-table"><div class="panel-head"><div><p class="eyebrow">Attribution</p><h2>Models and sources</h2></div></div><p v-if="!analytics.models.length" class="empty">No attributed usage for this scope and period.</p><article v-for="model in analytics.models" :key="model.key"><strong>{{ model.key }}</strong><div><span>{{ money(model.cost) }}</span><span>{{ compactNumber(model.tokens) }} tokens</span><span>{{ model.records }} records</span><span>{{ model.unknown_costs }} unknown costs</span></div></article><article v-for="model in analytics.local_today?.machine_total?.models || []" :key="`local-${model.model}`"><strong>{{ model.model }} · local today</strong><div><span>≈ {{ money(model.estimated_cost) }}</span><span>{{ compactNumber(model.total_tokens) }} tokens</span><span>{{ model.sessions }} sessions</span><span>API equivalent</span></div></article><p class="analytics-note">Local estimates apply the public API token rate to observed Codex usage. They are not subscription charges or invoices. Pricing table: {{ analytics.local_today?.pricing_version || 'not applicable to this scope' }}. Orchestrator remains observation-only.</p></section>
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
          autofocus
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
              }} · {{ date(previewImage.created_at) }}</span
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
