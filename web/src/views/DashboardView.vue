<script setup lang="ts">
import { onMounted, ref, computed, onUnmounted } from 'vue'
import { api, type Dashboard, type Review } from '../api'
import Chips from '../components/Chips.vue'
import ActivityFeed from '../components/ActivityFeed.vue'
import Blockers from '../components/Blockers.vue'
import { formatTokens, haltHelp, statusLabel } from '../labels'

const data = ref<Dashboard | null>(null)
const review = ref<Review | null>(null)
const busyOn = ref<number | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
let timer: number | undefined

async function castVerdict(id: number, decision: 'accept' | 'reject') {
  busyOn.value = id
  try {
    await api.verdict(id, decision)
    await load()
  } finally {
    busyOn.value = null
  }
}

async function load() {
  try {
    data.value = await api.dashboard()
    review.value = await api.review()
    error.value = null
  } catch (e: any) {
    error.value = e?.message ?? 'error'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 15000)
})
onUnmounted(() => window.clearInterval(timer))

const t = computed(() => data.value?.totals)

const breachedInvariants = computed(
  () => data.value?.invariants.filter((i) => i.last_status === 'breached') ?? [],
)

/** decimal(20,4) arrives with trailing zeros: we do not show them. */
function num(v: string | null) {
  if (v === null) return '—'
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString('fr-FR', { maximumFractionDigits: 4 }) : v
}

function ago(iso: string | null) {
  if (!iso) return '—'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

const statusOrder = ['blocked', 'in_progress', 'ready', 'draft', 'proven'] as const

function barSegments(p: Dashboard['projects'][number]) {
  const total = p.total_objectives || 1
  return statusOrder
    .map((s) => ({ status: s, n: p.objectives[s] ?? 0 }))
    .filter((x) => x.n > 0)
    .map((x) => ({ ...x, pct: (x.n / total) * 100 }))
}

const segColor: Record<string, string> = {
  blocked: 'bg-halt',
  in_progress: 'bg-run',
  ready: 'bg-run/40',
  draft: 'bg-ink-400/50',
  proven: 'bg-proof' }
</script>

<template>
  <div v-if="loading" class="text-ink-400">loading…</div>
  <div v-else-if="error" class="card p-4 border-fail/40 text-fail">
    The API is not responding — {{ error }}
  </div>

  <div v-else-if="data" class="space-y-7">
    <section class="card p-4 border-ink-800">
      <h1 class="text-ink-100 text-[15px]">Overview</h1>
      <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
        Every tracked project, ordered by what needs a decision from you. An objective is only
        “done” once proof has been produced and accepted — everything else is work in progress,
        not work finished.
      </p>
    </section>

    <!-- Before the numbers: what stops progress. A counter going up never tells
         you a loop has been spinning on nothing for an hour. -->
    <Blockers />

    <!-- Totals -->
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="card p-3.5" :class="t!.awaiting_human ? 'border-halt/40' : ''">
        <div class="label">Waiting on you</div>
        <div class="text-2xl mt-1" :class="t!.awaiting_human ? 'text-halt' : ''">
          {{ t!.awaiting_human }}
        </div>
        <div class="text-ink-600 text-[11px] mt-2">
          {{ t!.awaiting_human ? 'unresolved halts' : 'nothing is waiting on you' }}
        </div>
      </div>

      <div class="card p-3.5">
        <div class="label">Verified objectives</div>
        <div class="text-2xl mt-1">
          {{ t!.proven }}<span class="text-ink-600 text-base">/{{ t!.objectives }}</span>
        </div>
        <div class="h-1 bg-ink-800 rounded mt-2 overflow-hidden">
          <div
            class="h-full bg-proof transition-all"
            :style="{ width: `${t!.objectives ? (t!.proven / t!.objectives) * 100 : 0}%` }"
          />
        </div>
      </div>

      <div class="card p-3.5">
        <div class="label">Usage</div>
        <div class="text-2xl mt-1">{{ formatTokens(t!.tokens) }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          tokens · {{ t!.requests }} requests ·
          <span class="text-ink-400">${{ t!.cost_usd.toFixed(2) }}</span>
        </div>
      </div>

      <div class="card p-3.5">
        <div class="label">Work done</div>
        <div class="text-2xl mt-1">{{ t!.passages }}</div>
        <div class="text-ink-600 text-[11px] mt-2 flex flex-wrap gap-1 items-center">
          attempts
          <Chips v-for="h in data.harness_split" :key="h.harness" kind="harness" :value="h.harness" />
        </div>
      </div>
    </section>

    <ActivityFeed compact />

    <!-- Your verdict -->
    <section v-if="review?.ready.length">
      <h2 class="text-proof text-[14px] mb-1">Ready — only your verdict is missing — {{ review.ready.length }}</h2>
      <p class="text-ink-400 mb-3 max-w-3xl">
        The work is done and the proof is there. An objective never declares itself finished:
        this is the one move the loop never makes for you.
      </p>
      <div class="space-y-2.5">
        <div v-for="o in review.ready" :key="o.id" class="card p-4 border-proof/35 bg-proof/[0.04]">
          <div class="flex items-start gap-3 flex-wrap">
            <span class="text-ink-600 text-[11px] uppercase tracking-widest">{{ o.project }}</span>
            <RouterLink :to="`/o/${o.id}`" class="text-ink-100 flex-1 hover:underline">{{ o.title }}</RouterLink>
            <Chips kind="blast" :value="o.blast_radius" />
          </div>

          <p v-if="o.proof_spec" class="text-ink-400 mt-2 text-[12px]">Criterion: {{ o.proof_spec }}</p>

          <div class="flex items-center gap-4 mt-3 text-[12px] flex-wrap">
            <span class="text-proof">{{ o.evidences_pass }} passing proof(s)</span>
            <span v-if="o.evidences_fail" class="text-fail">{{ o.evidences_fail }} failing</span>
            <span class="text-ink-400">{{ o.passages }} attempts</span>
            <span v-if="o.cost_usd" class="text-ink-400">${{ o.cost_usd.toFixed(2) }}</span>

            <div class="ml-auto flex gap-1.5">
              <button
                class="chip border-proof text-proof bg-proof/10 hover:bg-proof/20"
                :disabled="busyOn === o.id"
                @click="castVerdict(o.id, 'accept')"
              >
                {{ busyOn === o.id ? '…' : 'I accept' }}
              </button>
              <button
                class="chip border-fail/60 text-fail hover:bg-fail/10"
                :disabled="busyOn === o.id"
                @click="castVerdict(o.id, 'reject')"
              >
                No
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- What is waiting -->
    <section v-if="data.open_halts.length">
      <h2 class="text-halt text-[14px] mb-1">Waiting for you — {{ data.open_halts.length }}</h2>
      <p class="text-ink-400 mb-3">
        In each of these, the tool chose to stop rather than carry on without certainty.
      </p>
      <div class="space-y-2.5">
        <RouterLink
          v-for="h in data.open_halts"
          :key="h.id"
          :to="`/o/${h.objective_id}`"
          class="card p-4 block border-halt/35 bg-halt/[0.04] hover:border-halt/60 transition-colors"
        >
          <div class="flex items-start gap-3 flex-wrap">
            <span class="text-ink-600 text-[11px] uppercase tracking-widest">{{ h.project }}</span>
            <span class="text-ink-100 flex-1">{{ h.objective_title }}</span>
            <Chips kind="halt" :value="h.reason" />
            <Chips v-if="h.blast_radius" kind="blast" :value="h.blast_radius" />
          </div>
          <p class="text-ink-400 mt-2">{{ haltHelp[h.reason] }}</p>
          <p v-if="h.detail" class="text-ink-500 text-[12px] mt-2 border-l-2 border-ink-700 pl-3 whitespace-pre-wrap">
            {{ h.detail.slice(0, 240) }}
          </p>
        </RouterLink>
      </div>
    </section>

    <!-- Breached invariants -->
    <section v-if="breachedInvariants.length">
      <h2 class="text-fail text-[14px] mb-1">Production measurements out of bounds</h2>
      <p class="text-ink-400 mb-3">Something just broke for real, not in a test.</p>
      <div class="card p-4 space-y-2 border-fail/40">
        <div v-for="i in breachedInvariants" :key="i.id" class="flex items-center gap-3">
          <span class="text-ink-600 text-[11px] uppercase tracking-widest w-24">{{ i.project }}</span>
          <span class="text-ink-100 flex-1">{{ i.statement }}</span>
          <span class="text-fail">measured {{ num(i.last_value) }}</span>
        </div>
      </div>
    </section>

    <!-- Projects -->
    <section>
      <h2 class="text-ink-100 text-[14px] mb-3">Projects — {{ data.projects.length }}</h2>
      <div class="space-y-2.5">
        <RouterLink
          v-for="p in data.projects"
          :key="p.slug"
          :to="`/p/${p.slug}`"
          class="card p-4 block hover:border-ink-600 transition-colors"
        >
          <div class="flex items-baseline gap-3 flex-wrap">
            <span class="text-ink-100 text-[14px]">{{ p.name }}</span>
            <code v-if="p.repo_path" class="text-ink-600 text-[11px]">{{ p.repo_path }}</code>
            <span class="ml-auto text-ink-400 text-[11px]">{{ ago(p.last_activity) }}</span>
          </div>

          <div class="h-1.5 bg-ink-800 rounded mt-3 overflow-hidden flex">
            <div
              v-for="seg in barSegments(p)"
              :key="seg.status"
              :class="segColor[seg.status]"
              :style="{ width: `${seg.pct}%` }"
              :title="`${seg.n} ${statusLabel[seg.status]}`"
            />
          </div>

          <div class="flex items-center gap-4 mt-3 text-[12px] flex-wrap">
            <span class="text-ink-400">
              <span class="text-proof">{{ p.proven }}</span
              >/{{ p.total_objectives }} verified
            </span>
            <span v-if="p.awaiting_human" class="text-halt">
              {{ p.awaiting_human }} waiting on you
            </span>
            <span class="text-ink-400">{{ p.passages }} attempts</span>
            <span v-if="p.tokens" class="text-ink-400">{{ formatTokens(p.tokens) }} tokens</span>
            <span v-if="p.cost_usd" class="text-ink-400">${{ p.cost_usd.toFixed(2) }}</span>
            <span
              v-if="p.invariants.total"
              class="ml-auto"
              :class="p.invariants.breached ? 'text-fail' : 'text-ink-400'"
            >
              {{ p.invariants.total }} invariant{{ p.invariants.total > 1 ? 's' : '' }}
              <template v-if="p.invariants.breached">— {{ p.invariants.breached }} breached</template>
              <template v-else-if="p.invariants.unknown">— never measured</template>
            </span>
          </div>
        </RouterLink>
      </div>
    </section>

    <div class="grid lg:grid-cols-2 gap-5">
      <!-- Recent activity -->
      <section>
        <h2 class="text-ink-100 text-[14px] mb-3">Latest attempts</h2>
        <div class="card divide-y divide-ink-800">
          <RouterLink
            v-for="r in data.recent"
            :key="r.id"
            :to="`/o/${r.objective_id}`"
            class="p-3 flex items-start gap-2.5 hover:bg-ink-850 transition-colors"
          >
            <span
              class="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
              :class="{
                'bg-proof': r.verdict === 'advanced',
                'bg-ink-600': r.verdict === 'no_progress',
                'bg-halt': r.verdict === 'halted',
                'bg-fail': r.verdict === 'failed',
                'bg-run animate-pulse': !r.verdict }"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-baseline gap-2 flex-wrap">
                <Chips kind="harness" :value="r.harness" />
                <span class="text-ink-300 truncate">{{ r.objective_title }}</span>
              </div>
              <div class="text-ink-600 text-[11px] mt-1">
                {{ r.project }} · {{ ago(r.started_at) }}
                <template v-if="r.tokens"> · {{ formatTokens(r.tokens) }} tokens</template>
              </div>
            </div>
          </RouterLink>
          <div v-if="!data.recent.length" class="p-3 text-ink-600">no attempts yet</div>
        </div>
      </section>

      
    </div>

    
  </div>
</template>
