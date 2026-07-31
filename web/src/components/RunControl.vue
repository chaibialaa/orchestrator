<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api, type Run } from '../api'

/**
 * Start, watch and stop a run from here.
 *
 * Until this existed the interface was a mirror: every loop had to be typed into
 * a terminal, and the screen only reported what had been started elsewhere. A
 * tool meant to replace working directly in Claude Code and Codex cannot ask you
 * to open a terminal to use it.
 *
 * Stopping asks rather than kills. The worker sees the flag between two turns and
 * finishes the one it is in — cutting a session mid-flight throws away work that
 * has already been paid for.
 */
const props = defineProps<{ slug: string; objectiveId: number; label?: string }>()

const runs = ref<Run[]>([])
const busy = ref(false)
const error = ref<string | null>(null)
const showOptions = ref(false)
let timer: number | undefined

const options = ref({ max_turns: 8, budget_without_progress: 120, post: true, hold_between_turns: false })

/** The run that concerns this objective right now, if any. */
const live = computed(
  () =>
    runs.value.find(
      (r) => r.objective_id === props.objectiveId && ['pending', 'running'].includes(r.status),
    ) ?? null,
)

const last = computed(
  () => runs.value.find((r) => r.objective_id === props.objectiveId) ?? null,
)

async function load() {
  try {
    runs.value = await api.runs(props.slug)
    error.value = null
  } catch {
    /* a control that cannot poll must not break the page it sits on */
  }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 5000)
})
onUnmounted(() => window.clearInterval(timer))

async function start() {
  busy.value = true
  error.value = null
  try {
    await api.startRun(props.slug, { objective: props.objectiveId, ...options.value })
    showOptions.value = false
    await load()
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not start it'
  } finally {
    busy.value = false
  }
}

async function stop() {
  if (!live.value) return
  busy.value = true
  try {
    await api.cancelRun(live.value.id)
    await load()
  } finally {
    busy.value = false
  }
}

async function carryOn() {
  if (!live.value) return
  busy.value = true
  try {
    await api.continueRun(live.value.id)
    await load()
  } finally {
    busy.value = false
  }
}

function since(iso: string | null) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 1000))
  if (s < 90) return `${s} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}
</script>

<template>
  <div class="flex items-center gap-2.5 flex-wrap text-[11px]">
    <!-- Running or queued: what it is doing, and the way out. -->
    <template v-if="live">
      <span class="flex items-center gap-1.5">
        <span
          class="w-1.5 h-1.5 rounded-full"
          :class="live.status === 'running' ? 'bg-run animate-pulse' : 'bg-ink-500'"
        />
        <span class="text-run">
          {{ live.status === 'running' ? `turn ${live.turn}` : 'queued' }}
        </span>
      </span>

      <span v-if="live.note" class="text-ink-500">{{ live.note }}</span>
      <span v-if="live.taken_at" class="num text-ink-600">{{ since(live.taken_at) }}</span>
      <span v-if="!live.post" class="text-ink-500">read only</span>

      <button v-if="live.hold_between_turns" class="chip border-run/50 text-run" @click="carryOn">
        carry on
      </button>
      <button class="chip border-ink-600 text-ink-400 hover:text-fail hover:border-fail/60" @click="stop">
        {{ live.cancel_asked ? 'stopping after this turn…' : 'stop' }}
      </button>
    </template>

    <!-- Idle: start it, and say how before you do. -->
    <template v-else>
      <button class="chip border-run/50 text-run hover:bg-run/10" :disabled="busy" @click="start">
        {{ busy ? '…' : (label ?? 'Run this chapter') }}
      </button>
      <button class="text-ink-600 hover:text-ink-300" @click="showOptions = !showOptions">
        {{ showOptions ? 'hide' : 'how' }}
      </button>

      <span v-if="last && last.status !== 'pending'" class="text-ink-600">
        last: {{ last.status }}<template v-if="last.error"> — {{ last.error.slice(0, 60) }}</template>
      </span>
    </template>

    <span v-if="error" class="text-fail">{{ error }}</span>
  </div>

  <!-- The choices that change what a run costs and how far it goes. Folded,
       because a default that works is the common case. -->
  <div v-if="showOptions && !live" class="mt-2 flex items-center gap-4 flex-wrap text-[11px]">
    <label class="flex items-center gap-1.5">
      <span class="text-ink-500">turns</span>
      <input
        v-model.number="options.max_turns"
        type="number"
        min="1"
        max="30"
        class="num w-14 bg-ink-950 border border-ink-800 rounded px-1.5 py-0.5 text-ink-300 focus:outline-none focus:border-run"
      />
    </label>
    <label class="flex items-center gap-1.5" title="What we tolerate spending without a single objective being proven">
      <span class="text-ink-500">stop at $</span>
      <input
        v-model.number="options.budget_without_progress"
        type="number"
        min="10"
        step="10"
        class="num w-16 bg-ink-950 border border-ink-800 rounded px-1.5 py-0.5 text-ink-300 focus:outline-none focus:border-run"
      />
      <span class="text-ink-600">without progress</span>
    </label>
    <label class="flex items-center gap-1.5 text-ink-500">
      <input v-model="options.post" type="checkbox" />
      execute and write to the conversation
    </label>
    <label class="flex items-center gap-1.5 text-ink-500" title="Stop after every turn and wait for you to say carry on">
      <input v-model="options.hold_between_turns" type="checkbox" />
      pause after each turn
    </label>
  </div>
</template>
