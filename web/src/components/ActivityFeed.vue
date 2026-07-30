<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, type Activity } from '../api'
import { haltLabel, harnessLabel, formatTokens } from '../labels'

const props = defineProps<{ slug?: string; compact?: boolean }>()

const feed = ref<Activity[]>([])
const busyOn = ref<Activity[]>([])
const nowStamp = ref(Date.now())
let tic: ReturnType<typeof setInterval> | null = null
let clock: ReturnType<typeof setInterval> | null = null

async function load() {
  try {
    const d = await api.activity(props.slug)
    feed.value = d.feed
    busyOn.value = d.live
  } catch {
    /* a feed that fails to load must not take the page down with it */
  }
}

onMounted(() => {
  load()
  // What is running moves fast; the past does not. We only poll quickly when
  // something is live, and otherwise leave the server alone.
  tic = setInterval(() => load(), busyOn.value.length ? 4000 : 12000)
  clock = setInterval(() => (nowStamp.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  tic && clearInterval(tic)
  clock && clearInterval(clock)
})

/** Dates arrive in UTC with no zone: add it, or every reading is an hour off. */
function ms(iso: string) {
  return new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z').getTime()
}

function since(iso: string) {
  const s = Math.max(0, Math.round((nowStamp.value - ms(iso)) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  const h = Math.floor(s / 3600)
  return h < 24 ? `${h} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(h / 24)} j`
}

const ROW: Record<Activity['type'], { dot: string; color: string }> = {
  live: { dot: 'bg-run animate-pulse', color: 'text-run' },
  attempt: { dot: 'bg-ink-600', color: 'text-ink-400' },
  verdict: { dot: 'bg-proof', color: 'text-proof' },
  halt: { dot: 'bg-halt', color: 'text-halt' },
}

/** What happened, in one sentence — not in table jargon. */
function phrase(e: Activity): string {
  if (e.type === 'live') {
    return `${harnessLabel[e.harness ?? ''] ?? e.harness} is working${e.resumed_from ? ` (resumed from ${e.resumed_from.slice(0, 8)})` : ''}`
  }
  if (e.type === 'verdict') {
    const by = e.payload?.judged_by
    // Both spellings on purpose: rows written before the switch to English
    // still carry the French label, and they must keep reading correctly.
    const withdrawn = /retiré|withdrawn/.test(e.label ?? '')
    return withdrawn
      ? `verdict withdrawn — ${by === 'gpt' ? 'the conversation' : by} took it back`
      : `${by === 'gpt' ? 'the conversation' : by === 'human' ? 'you' : by} accepted it`
  }
  if (e.type === 'halt') {
    return `${haltLabel[e.reason ?? ''] ?? e.reason}${e.resolved_at ? ' — cleared' : ''}`
  }
  if (e.prevented) return `${harnessLabel[e.harness ?? ''] ?? e.harness} — prevented, nothing attempted`
  const v = { advanced: 'moved it forward', no_progress: 'demonstrated nothing', halted: 'stopped', failed: 'failed' }
  return `${harnessLabel[e.harness ?? ''] ?? e.harness} ${v[e.verdict as keyof typeof v] ?? 'finished'}`
}

const cost = (e: Activity) => {
  const c = Number(e.cost_usd ?? 0)
  return c ? `$${c.toFixed(2)}` : null
}

const lines = computed(() => (props.compact ? feed.value.slice(0, 6) : feed.value))
</script>

<template>
  <section>
    <h2 class="text-ink-300 text-[14px] mb-1">
      What is happening
      <span v-if="busyOn.length" class="text-run">— {{ busyOn.length }} running</span>
      <span v-else class="text-ink-600">— nothing running</span>
    </h2>
    <p v-if="!compact" class="text-ink-500 mb-3.5 text-[12px]">
      In time order. A table tells you where things stand; this tells you what is moving.
    </p>

    <div class="card divide-y divide-ink-850">
      <RouterLink
        v-for="(e, i) in lines"
        :key="`${e.type}-${e.objective_id}-${e.at}-${i}`"
        :to="`/o/${e.objective_id}`"
        class="flex items-baseline gap-3 px-4 py-2.5 hover:bg-ink-850/40 transition-colors"
      >
        <span class="w-1.5 h-1.5 rounded-full shrink-0 self-center" :class="ROW[e.type].dot" />
        <span class="text-ink-600 text-[11px] w-14 shrink-0 tabular-nums">
          {{ e.type === 'live' ? since(e.started_at ?? e.at) : since(e.at) }}
        </span>
        <span class="text-[12px] shrink-0" :class="ROW[e.type].color">{{ phrase(e) }}</span>
        <span class="text-ink-300 text-[12px] flex-1 truncate">
          <span class="text-ink-600">#{{ e.objective_id }}</span> {{ e.objective_title }}
        </span>
        <span v-if="!slug && e.project" class="label text-ink-600 shrink-0">{{ e.project }}</span>
        <span v-if="e.tokens" class="text-ink-600 text-[11px] shrink-0">{{ formatTokens(e.tokens) }}</span>
        <span v-if="cost(e)" class="text-ink-500 text-[11px] shrink-0 tabular-nums">{{ cost(e) }}</span>
      </RouterLink>

      <p v-if="!lines.length" class="px-4 py-4 text-ink-500 text-[12px]">
        Nothing yet. The feed fills up as soon as an agent starts.
      </p>
    </div>
  </section>
</template>
