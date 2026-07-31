<script setup lang="ts">
import { onMounted, ref, computed, onUnmounted } from 'vue'
import { api, type Dashboard, type Review } from '../api'
import Chips from '../components/Chips.vue'
import ActivityFeed from '../components/ActivityFeed.vue'
import Blockers from '../components/Blockers.vue'
import NewProject from '../components/NewProject.vue'
import JudgeFull from '../components/JudgeFull.vue'
import NotConverging from '../components/NotConverging.vue'
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
    announce()
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

/**
 * One question, asked once: is anything waiting on a person?
 *
 * Verdicts, halts and breached measurements used to be three sections with three
 * headings and three paragraphs. They are the same question, and splitting them
 * made the answer something the reader had to assemble.
 */
const needsYou = computed(
  () =>
    (review.value?.ready.length ?? 0) +
    (data.value?.open_halts.length ?? 0) +
    breachedInvariants.value.length,
)

/** decimal(20,4) arrives with trailing zeros: we do not show them. */
function num(v: string | null) {
  if (v === null) return '—'
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : v
}

function ago(iso: string | null) {
  if (!iso) return '—'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

/**
 * Tell the reader once, when it starts — not only while they are looking.
 *
 * A loop that stops at three in the morning waited until someone happened to
 * open the page. Permission cannot be asked for without a click, so it is a
 * choice offered rather than a prompt sprung on arrival.
 */
const notify = ref(typeof Notification !== 'undefined' && Notification.permission === 'granted')
const canAskNotify = computed(
  () => typeof Notification !== 'undefined' && Notification.permission === 'default',
)

async function enableNotifications() {
  if (typeof Notification === 'undefined') return
  notify.value = (await Notification.requestPermission()) === 'granted'
}

/** Halts already announced, so a re-poll every 15 s does not re-announce them. */
const announced = new Set<number>()

function announce() {
  if (!notify.value) return
  for (const h of data.value?.open_halts ?? []) {
    if (announced.has(h.id)) continue
    announced.add(h.id)
    new Notification(`${h.project} — the loop stopped`, {
      body: haltHelp[h.reason] ?? h.reason,
      tag: `halt-${h.id}`,
    })
  }
}

const statusOrder = ['proven', 'in_progress', 'blocked', 'ready', 'draft'] as const

function barSegments(p: Dashboard['projects'][number]) {
  const total = p.total_objectives || 1
  return statusOrder
    .map((s) => ({ status: s, n: p.objectives[s] ?? 0 }))
    .filter((x) => x.n > 0)
    .map((x) => ({ ...x, pct: (x.n / total) * 100 }))
}

const segColor: Record<string, string> = {
  proven: 'bg-proof',
  in_progress: 'bg-run',
  blocked: 'bg-halt',
  ready: 'bg-ink-600',
  draft: 'bg-ink-700',
}
</script>

<template>
  <div v-if="loading" class="text-ink-400">loading…</div>
  <div v-else-if="error" class="card p-4 border-fail/40 text-fail">
    The API is not responding — {{ error }}
  </div>

  <div v-else-if="data" class="space-y-8">
    <!-- One line of orientation, and the totals as context rather than as subject.
         Four large number cards competed with the things that actually need a
         decision; they belong in the margin. -->
    <header class="flex items-end gap-6 flex-wrap border-b border-ink-800 pb-4">
      <div class="flex-1 min-w-[16rem]">
        <h1 class="text-ink-100 text-[17px]">Overview</h1>
        <p class="text-ink-400 mt-1">
          An objective is done only once proof has been produced and accepted.
        </p>
      </div>

      <dl class="flex items-end gap-7 text-[12px]">
        <div>
          <dt class="label">Verified</dt>
          <dd class="num text-[18px] text-ink-100 mt-0.5">
            {{ t!.proven }}<span class="text-ink-600 text-[13px]">/{{ t!.objectives }}</span>
          </dd>
        </div>
        <div>
          <dt class="label">Attempts</dt>
          <dd class="num text-[18px] text-ink-100 mt-0.5">{{ t!.passages }}</dd>
        </div>
        <div>
          <dt class="label">Spent</dt>
          <dd class="num text-[18px] text-ink-100 mt-0.5">${{ t!.cost_usd.toFixed(0) }}</dd>
        </div>
        <div>
          <dt class="label">Tokens</dt>
          <dd class="num text-[18px] text-ink-100 mt-0.5">{{ formatTokens(t!.tokens) }}</dd>
        </div>
      </dl>
    </header>

    <p v-if="!needsYou" class="text-ink-500 -mt-4">
      <span class="label">Needs you</span>
      — nothing. The loop handles what it can handle on its own.
    </p>

    <!-- Two columns because these are two different questions, and stacking them
         full-width made the second look like more of the first. On the left, what
         wants a decision from you; on the right, conditions that will make a pass
         fail before it starts. Below 1280px they stack — there is no honest way to
         put two columns on a narrow screen. -->
    <div
      class="grid grid-cols-1 gap-8 items-start"
      :class="needsYou ? 'xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]' : ''"
    >
    <section v-if="needsYou">
      <h2 class="label mb-3">
        Needs you
        <span class="text-halt normal-case tracking-normal text-[12px] ml-1">— {{ needsYou }}</span>
      </h2>

      <button
        v-if="canAskNotify"
        class="label hover:text-ink-300 float-right -mt-7"
        title="Be told when a loop stops, without keeping this page open"
        @click="enableNotifications"
      >
        notify me
      </button>



      <!-- Not `v-else`: the paragraph it paired with moved out of this section,
           and a `v-else` whose `v-if` is gone is dropped by the compiler without a
           word. The heading kept counting two things and showed neither. -->
      <div class="space-y-2.5">
        <!-- Verdicts: everything is there, only the judgement is missing. -->
        <article
          v-for="o in review?.ready ?? []"
          :key="`v${o.id}`"
          class="card p-4 border-proof/35 bg-proof/[0.04]"
        >
          <div class="flex items-start gap-3 flex-wrap">
            <span class="label text-ink-600 mt-0.5">{{ o.project }}</span>
            <RouterLink :to="`/o/${o.id}`" class="text-ink-100 flex-1 min-w-[12rem] hover:underline">
              {{ o.title }}
            </RouterLink>
            <Chips kind="blast" :value="o.blast_radius" />
          </div>

          <p v-if="o.proof_spec" class="text-ink-400 mt-2 leading-relaxed">{{ o.proof_spec }}</p>

          <div class="flex items-center gap-4 mt-3 text-[12px] flex-wrap">
            <span class="text-proof num">{{ o.evidences_pass }} passing</span>
            <span v-if="o.evidences_fail" class="text-fail num">{{ o.evidences_fail }} failing</span>
            <span class="text-ink-500 num">{{ o.passages }} attempts</span>

            <div class="ml-auto flex gap-1.5">
              <button
                class="chip border-proof text-proof bg-proof/10 hover:bg-proof/20"
                :disabled="busyOn === o.id"
                @click="castVerdict(o.id, 'accept')"
              >
                {{ busyOn === o.id ? '…' : 'The criterion is met' }}
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
        </article>

        <!-- The one halt that has its own way out, rather than a description of
             the chore it expects from you. -->
        <JudgeFull
          v-for="h in data.open_halts.filter((x) => x.reason === 'judge_conversation_full')"
          :key="`j${h.id}`"
          :project="h.project"
          :objective-id="h.objective_id"
          :detail="h.detail"
          @done="load"
        />

        <!-- The halt whose tempting answer — run it again — is the very thing
             that produced it. It gets the two ways out that change something. -->
        <NotConverging
          v-for="h in data.open_halts.filter((x) => x.reason === 'not_converging')"
          :key="`n${h.id}`"
          :project="h.project"
          :objective-id="h.objective_id"
          :title="h.objective_title"
          :detail="h.detail"
          @done="load"
        />

        <!-- Halts: the tool stopped on purpose. -->
        <RouterLink
          v-for="h in data.open_halts.filter((x) => !['judge_conversation_full', 'not_converging'].includes(x.reason))"
          :key="`h${h.id}`"
          :to="`/o/${h.objective_id}`"
          class="card p-4 block border-halt/35 bg-halt/[0.04] hover:border-halt/60 transition-colors"
        >
          <div class="flex items-start gap-3 flex-wrap">
            <span class="label text-ink-600 mt-0.5">{{ h.project }}</span>
            <span class="text-ink-100 flex-1 min-w-[12rem]">{{ h.objective_title }}</span>
            <Chips kind="halt" :value="h.reason" />
          </div>
          <p class="text-ink-400 mt-2 leading-relaxed">{{ haltHelp[h.reason] }}</p>
          <p
            v-if="h.detail"
            class="text-ink-500 text-[12px] mt-2 border-l-2 border-ink-700 pl-3 whitespace-pre-wrap"
          >
            {{ h.detail.slice(0, 240) }}
          </p>
        </RouterLink>

        <!-- Measurements taken on the live site, out of bounds. -->
        <div v-if="breachedInvariants.length" class="card p-4 border-fail/40">
          <div class="label text-fail mb-2">Out of bounds in production</div>
          <div v-for="i in breachedInvariants" :key="i.id" class="flex items-baseline gap-3 py-0.5">
            <span class="label text-ink-600 w-20 shrink-0">{{ i.project }}</span>
            <span class="text-ink-100 flex-1">{{ i.statement }}</span>
            <span class="text-fail num">{{ num(i.last_value) }}</span>
          </div>
        </div>
      </div>
    </section>

      <!-- Alone, it gets the width instead of a 900px card holding 68 characters
           of text: two caps fighting each other left a third of every card empty. -->
      <Blockers :columns="needsYou ? 1 : 2" :class="needsYou ? 'xl:sticky xl:top-16' : ''" />
    </div>

    <ActivityFeed compact />

    <!-- ═══ WHERE THE PROJECTS STAND ═══ -->
    <section>
      <div class="flex items-baseline gap-3 mb-3">
        <h2 class="label">Projects — {{ data.projects.length }}</h2>
        <NewProject class="ml-auto" @created="load" />
      </div>
      <!-- Cards on a grid rather than a stack of full-width rows. A project is a
           thing you compare against other projects; laid out one per line at 1400px
           you compare a name on the left with a repository path a screen away. -->
      <div class="grid gap-3 grid-cols-1 md:grid-cols-2 2xl:grid-cols-3">
        <RouterLink
          v-for="p in data.projects"
          :key="p.slug"
          :to="`/p/${p.slug}`"
          class="card p-4 block hover:border-ink-600 transition-colors"
        >
          <div class="flex items-baseline gap-3 flex-wrap">
            <span class="text-ink-100 text-[14px]">{{ p.name }}</span>
            <span class="num text-ink-400 text-[12px]">
              <span class="text-proof">{{ p.proven }}</span
              >/{{ p.total_objectives }}
            </span>
            <span v-if="p.awaiting_human" class="text-halt text-[12px]">
              {{ p.awaiting_human }} waiting on you
            </span>
            <span
              v-if="p.invariants.breached"
              class="text-fail text-[12px]"
              title="A measurement taken on the live site is out of bounds"
            >
              {{ p.invariants.breached }} out of bounds
            </span>
            <span class="ml-auto text-ink-600 text-[11px] shrink-0">{{ ago(p.last_activity) }}</span>
          </div>

          <!-- The bar IS the project: what is proven, what is moving, what is stuck. -->
          <div class="h-1.5 bg-ink-800 rounded mt-3 overflow-hidden flex">
            <div
              v-for="seg in barSegments(p)"
              :key="seg.status"
              :class="segColor[seg.status]"
              :style="{ width: `${seg.pct}%` }"
              :title="`${seg.n} ${statusLabel[seg.status]}`"
            />
          </div>

          <div class="flex items-center gap-4 mt-2.5 text-[11px] text-ink-600 flex-wrap">
            <span class="num">{{ p.passages }} attempts</span>
            <span v-if="p.tokens" class="num">{{ formatTokens(p.tokens) }} tokens</span>
            <span v-if="p.cost_usd" class="num">${{ p.cost_usd.toFixed(2) }}</span>
            <code v-if="p.repo_path" class="num w-full truncate text-ink-700">{{ p.repo_path }}</code>
          </div>
        </RouterLink>
      </div>
    </section>
  </div>
</template>
