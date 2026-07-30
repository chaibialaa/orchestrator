<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { api, type Objective, type Stats } from '../api'
import Chips from '../components/Chips.vue'
import ChapterRail from '../components/ChapterRail.vue'
import ActivityFeed from '../components/ActivityFeed.vue'
import { formatTokens } from '../labels'

const props = defineProps<{ slug: string }>()

const objectives = ref<Objective[]>([])
const stats = ref<Stats | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const showHelp = ref(false)

async function load() {
  loading.value = true
  error.value = null
  try {
    const [o, s] = await Promise.all([api.objectives(props.slug), api.stats(props.slug)])
    objectives.value = o
    stats.value = s
  } catch (e: any) {
    error.value = e?.message ?? 'error'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.slug, load)

/**
 * The project's tracks. A chapter is an objective that carries others; its steps
 * read in priority order, which IS execution order. Anything that depends on
 * nobody and carries nobody forms a track of its own.
 */
const tracks = computed(() => {
  const all = objectives.value
  const parents = all.filter((o) => all.some((x) => x.parent_id === o.id))
  const byRank = (l: Objective[]) => [...l].sort((a, b) => a.priority - b.priority || a.id - b.id)

  const chapters = byRank(parents).map((c) => ({
    chapter: c,
    steps: byRank(all.filter((o) => o.parent_id === c.id)),
  }))

  const loose = byRank(all.filter((o) => !o.parent_id && !parents.includes(o)))
  const out = loose.length ? [...chapters, { chapter: null, steps: loose }] : chapters

  // The loop follows one chain at a time. Showing the others at the same level
  // made it look like three open fronts: so each chain is dated, the most recent
  // one leads, and the rest are plainly called closed or dormant.
  const lastTouched = (v: { chapter: Objective | null; steps: Objective[] }) =>
    [v.chapter, ...v.steps]
      .map((o) => o?.last_activity ?? '')
      .sort()
      .pop() ?? ''

  const dated = out
    .map((v) => ({ ...v, activity: lastTouched(v) }))
    .sort((a, b) => b.activity.localeCompare(a.activity))

  let activeTaken = false

  return dated.map((v) => {
    const closed = v.steps.every((o) => ['proven', 'abandoned'].includes(o.status))
    const active = !closed && !activeTaken
    if (active) activeTaken = true

    const chain: 'active' | 'dormant' | 'closed' = closed ? 'closed' : active ? 'active' : 'dormant'
    return { ...v, chain }
  })
})

const NEEDS_HUMAN = ['blast_radius', 'no_provable_criterion', 'invariant_regression', 'human_request']

// A halted objective is not necessarily waiting for someone. The loop clears a
// verdict rejection or a stall on its own: counting those as decisions to make
// manufactures a queue that does not exist.
const waiting = computed(() =>
  objectives.value.filter((o) => o.status === 'blocked' && NEEDS_HUMAN.includes(o.halt_reason ?? '')),
)
const autoResumed = computed(() =>
  objectives.value.filter((o) => o.status === 'blocked' && !NEEDS_HUMAN.includes(o.halt_reason ?? '')),
)
const done = computed(() => objectives.value.filter((o) => o.status === 'proven'))

/** How long the open attempt has been running. */
function since(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 60000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h ${String(min % 60).padStart(2, '0')}`
}

/** One sentence saying where this objective stands. */
function story(o: Objective): string {
  const n = o.passages_count ?? 0
  const tries = n === 0 ? 'no attempts' : n === 1 ? '1 attempt' : `${n} attempts`

  if (o.status === 'draft') {
    return 'One question is unanswered: how will we know this is done? Until it has an answer, no agent can pick it up.'
  }
  if (o.status === 'blocked') {
    return `${tries}, then the tool stopped by itself. It is waiting for you to decide.`
  }
  if (o.status === 'in_progress') {
    return o.live_since
      ? `An agent has been on it for ${since(o.live_since)}. ${tries} in total.`
      : `Started, but no agent is on it right now. ${tries}.`
  }
  if (o.status === 'ready') {
    return 'The goal and the way to verify it are clear. The next available agent can take it.'
  }
  if (o.status === 'proven') {
    const e = o.evidences_count ?? 0
    return `Done and verified — ${e} proof${e > 1 ? 's' : ''} produced and accepted.`
  }
  return ''
}

</script>

<template>
  <div v-if="loading" class="text-ink-400">loading…</div>
  <div v-else-if="error" class="card p-4 border-fail/40 text-fail">
    The API is not responding — {{ error }}
    <div class="text-ink-400 mt-1 text-[11px]">
      It should be running on port 4747 (orchestrator serve)
    </div>
  </div>

  <div v-else class="space-y-7">
    <!-- What this page is -->
    <section class="card p-4 border-ink-800">
      <div class="flex items-start gap-4">
        <div class="flex-1">
          <h1 class="text-ink-100 text-[15px]">Where the project stands</h1>
          <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
            Every line is an <strong class="text-ink-300">objective</strong>: something we want to
            make true. An objective is never “done” because an agent said so — it is done when a
            <strong class="text-ink-300">proof</strong> has been produced and accepted. When the tool
            cannot conclude on its own, it stops and shows up under
            <strong class="text-halt">Waiting on you</strong>.
          </p>
        </div>
        <button class="btn shrink-0" @click="showHelp = !showHelp">
          {{ showHelp ? 'hide' : 'how to read this' }}
        </button>
      </div>

      <div v-if="showHelp" class="mt-4 pt-4 border-t border-ink-800 grid md:grid-cols-2 gap-5">
        <div>
          <div class="label mb-2">The states</div>
          <ul class="space-y-1.5">
            <li v-for="s in ['draft', 'ready', 'in_progress', 'blocked', 'proven']" :key="s" class="flex gap-2">
              <Chips kind="status" :value="s" />
            </li>
          </ul>
        </div>
        <div>
          <div class="label mb-2">Risk level decides autonomy</div>
          <ul class="space-y-2">
            <li v-for="b in ['cosmetic', 'feature', 'api', 'critical']" :key="b">
              <Chips kind="blast" :value="b" />
            </li>
          </ul>
          <p class="text-ink-600 text-[11px] mt-2">
            Hover a badge for its explanation.
          </p>
        </div>
      </div>
    </section>

    <!-- Totals -->
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="card p-3.5">
        <div class="label">Verified objectives</div>
        <div class="text-2xl mt-1">
          {{ done.length }}<span class="text-ink-600 text-base">/{{ objectives.length }}</span>
        </div>
        <div class="h-1 bg-ink-800 rounded mt-2 overflow-hidden">
          <div class="h-full bg-proof transition-all" :style="{ width: `${(stats?.proven_ratio ?? 0) * 100}%` }" />
        </div>
      </div>

      <div class="card p-3.5" :class="waiting.length ? 'border-halt/40' : ''">
        <div class="label">Waiting on you</div>
        <div class="text-2xl mt-1" :class="waiting.length ? 'text-halt' : ''">
          {{ waiting.length }}
        </div>
        <div class="text-ink-600 text-[11px] mt-2">
          {{ waiting.length ? 'the tool cannot decide alone' : 'nothing is waiting on you' }}
        </div>
      </div>

      <div class="card p-3.5">
        <div class="label">Usage</div>
        <div class="text-2xl mt-1">{{ formatTokens(stats?.tokens) }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          tokens · {{ stats?.requests ?? 0 }} requests ·
          <span class="text-ink-400">${{ (stats?.cost_usd ?? 0).toFixed(2) }}</span>
        </div>
      </div>

      <div class="card p-3.5">
        <div class="label">Work done</div>
        <div class="text-2xl mt-1">{{ stats?.passages ?? 0 }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          attempts, by
          <Chips
            v-for="h in Object.keys(stats?.harness_split ?? {})"
            :key="h"
            kind="harness"
            :value="h"
            class="ml-0.5"
          />
        </div>
      </div>
    </section>

    <!-- What is waiting for you -->
    <section v-if="waiting.length">
      <h2 class="text-halt text-[14px] mb-1">Waiting for you — {{ waiting.length }}</h2>
      <p class="text-ink-400 mb-3">
        In each of these, the tool chose to stop rather than carry on without certainty.
      </p>
      <div class="space-y-2.5">
        <RouterLink
          v-for="o in waiting"
          :key="o.id"
          :to="`/o/${o.id}`"
          class="card p-4 block border-halt/35 bg-halt/[0.04] hover:border-halt/60 transition-colors"
        >
          <div class="flex items-start gap-3">
            <div class="flex-1">
              <div class="text-ink-100">{{ o.title }}</div>
              <p class="text-ink-400 mt-1.5">{{ story(o) }}</p>
            </div>
            <Chips kind="blast" :value="o.blast_radius" />
          </div>
        </RouterLink>
      </div>
    </section>

    <p v-if="autoResumed.length" class="text-ink-500 text-[13px]">
      {{ autoResumed.length }} objective{{ autoResumed.length > 1 ? 's' : '' }} halted on a reason the
      loop clears by itself — nothing for you to do:
      <span class="text-ink-400">{{ autoResumed.map((o) => `#${o.id}`).join(', ') }}</span>
    </p>

    <!-- The tracks: what comes after what, and where things actually stand. -->
    <section v-if="tracks.length" class="space-y-4">
      <ChapterRail
        v-for="(v, i) in tracks"
        :key="v.chapter?.id ?? `loose-${i}`"
        :chapter="v.chapter"
        :steps="v.steps"
        :chain="v.chain"
        :activity="v.activity"
      />
    </section>

    <ActivityFeed :slug="slug" />

    <RouterLink
      :to="`/p/${slug}/analysis`"
      class="card p-3.5 flex items-baseline gap-3 hover:border-ink-600 transition-colors"
    >
      <span class="text-ink-300">Analysis</span>
      <span class="text-ink-500 text-[12px] flex-1"
        >Why work jams, what it costs, what is measured in production.</span
      >
      <span class="label text-ink-600">open ▸</span>
    </RouterLink>

  </div>
</template>
