<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api, type Objective, type Stats } from '../api'
import { haltLabel, haltHelp, harnessLabel, formatTokens } from '../labels'

const props = defineProps<{ slug: string }>()

const stats = ref<Stats | null>(null)
const objectives = ref<Objective[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    ;[stats.value, objectives.value] = await Promise.all([api.stats(props.slug), api.objectives(props.slug)])
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.slug, load)

const halts = computed(() =>
  Object.entries(stats.value?.halts_by_reason ?? {}).sort((a, b) => b[1] - a[1]),
)
const maxHalt = computed(() => Math.max(1, ...halts.value.map(([, n]) => n)))

const harnesses = computed(() =>
  Object.entries(stats.value?.harness_split ?? {}).sort((a, b) => b[1] - a[1]),
)
const totalPassages = computed(() => harnesses.value.reduce((n, [, v]) => n + v, 0) || 1)

/** What an objective costs — this is where you see the money go. */
const byObjective = computed(() =>
  [...objectives.value]
    .filter((o) => (o.passages_count ?? 0) > 0)
    .sort((a, b) => (b.passages_count ?? 0) - (a.passages_count ?? 0))
    .slice(0, 10),
)
</script>

<template>
  <div v-if="loading" class="text-ink-400">loading…</div>
  <div v-else class="space-y-7">
    <section class="card p-4 border-ink-800">
      <h1 class="text-ink-100 text-[15px]">Analysis</h1>
      <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
        Where work gets stuck, and what it costs. This page is not for deciding — it is for
        understanding why deciding is needed so often.
      </p>
    </section>

    <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="card p-3.5">
        <div class="label">Usage</div>
        <div class="text-2xl mt-1">{{ formatTokens(stats?.tokens) }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          {{ stats?.requests }} requests · ${{ (stats?.cost_usd ?? 0).toFixed(2) }}
        </div>
      </div>
      <div class="card p-3.5">
        <div class="label">Attempts</div>
        <div class="text-2xl mt-1">{{ stats?.passages }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          {{ stats?.passages ? `$${((stats.cost_usd ?? 0) / stats.passages).toFixed(2)} on average` : '—' }}
        </div>
      </div>
      <div class="card p-3.5">
        <div class="label">Verified objectives</div>
        <div class="text-2xl mt-1">
          {{ stats?.objectives?.proven ?? 0
          }}<span class="text-ink-600 text-base">/{{ objectives.length }}</span>
        </div>
      </div>
      <div class="card p-3.5">
        <div class="label">Halts</div>
        <div class="text-2xl mt-1">{{ halts.reduce((n, [, v]) => n + v, 0) }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          {{ stats?.awaiting_human ?? 0 }} of them waiting on you
        </div>
      </div>
    </section>

    <section v-if="halts.length">
      <h2 class="text-ink-300 text-[14px] mb-1">Why work stops</h2>
      <p class="text-ink-500 mb-3.5 text-[12px] max-w-3xl">
        The most useful number on the page: it says where things actually jam, and therefore what to
        fix first.
      </p>
      <div class="card divide-y divide-ink-850">
        <div v-for="[reason, n] in halts" :key="reason" class="px-4 py-3">
          <div class="flex items-baseline gap-3">
            <span class="text-ink-100 flex-1">{{ haltLabel[reason] ?? reason }}</span>
            <span class="h-1 bg-ink-800 rounded w-40 overflow-hidden">
              <span class="block h-full bg-halt" :style="{ width: `${(n / maxHalt) * 100}%` }" />
            </span>
            <span class="text-ink-400 text-[12px] w-14 text-right tabular-nums">{{ n }} times</span>
          </div>
          <p class="text-ink-500 text-[11px] mt-1 max-w-3xl">{{ haltHelp[reason] }}</p>
        </div>
      </div>
    </section>

    <section v-if="harnesses.length">
      <h2 class="text-ink-300 text-[14px] mb-3">Who does the work</h2>
      <div class="card p-4 space-y-2.5">
        <div v-for="[h, n] in harnesses" :key="h" class="flex items-baseline gap-3">
          <span class="text-ink-100 w-20">{{ harnessLabel[h] ?? h }}</span>
          <span class="h-1 bg-ink-800 rounded flex-1 overflow-hidden">
            <span class="block h-full bg-run" :style="{ width: `${(n / totalPassages) * 100}%` }" />
          </span>
          <span class="text-ink-500 text-[12px] w-24 text-right tabular-nums">
            {{ n }} attempt{{ n > 1 ? 's' : '' }}
          </span>
        </div>
      </div>
    </section>

    <section v-if="byObjective.length">
      <h2 class="text-ink-300 text-[14px] mb-1">Where the effort goes</h2>
      <p class="text-ink-500 mb-3.5 text-[12px]">
        An objective that piles up attempts without concluding is a badly stated objective, not a
        lazy agent.
      </p>
      <div class="card divide-y divide-ink-850">
        <RouterLink
          v-for="o in byObjective"
          :key="o.id"
          :to="`/o/${o.id}`"
          class="flex items-baseline gap-3 px-4 py-2.5 hover:bg-ink-850/40 transition-colors"
        >
          <span class="text-ink-600 text-[11px] w-8">#{{ o.id }}</span>
          <span class="text-ink-300 flex-1 truncate">{{ o.title }}</span>
          <span
            class="label"
            :class="o.status === 'proven' ? 'text-proof' : o.status === 'blocked' ? 'text-halt' : 'text-ink-500'"
            >{{ o.status === 'proven' ? 'proven' : o.status === 'blocked' ? 'halted' : 'in progress' }}</span
          >
          <span class="text-ink-500 text-[12px] w-24 text-right tabular-nums">
            {{ o.passages_count }} attempt{{ (o.passages_count ?? 0) > 1 ? 's' : '' }}
          </span>
          <span class="text-ink-600 text-[11px] w-16 text-right">{{ o.evidences_count }} proofs</span>
        </RouterLink>
      </div>
    </section>
  </div>
</template>
