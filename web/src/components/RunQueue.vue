<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api, type Objective, type Run } from '../api'

/**
 * What is running, what is waiting, and in which order it will actually be taken.
 *
 * The queue was invisible: you started runs and hoped. That is bearable until a
 * loop breaks something — then the fix has to go in front of six queued chapters,
 * and there was no way to say so short of cancelling them all.
 *
 * Slipping in front does not interrupt anything. The run in flight finishes its
 * turn; the injected one is simply the next one taken.
 */
const props = defineProps<{ slug: string; objectives: Objective[] }>()

const runs = ref<Run[]>([])
const open = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
let timer: number | undefined

const draft = ref({ objective: null as number | null, reason: '', post: true })

async function load() {
  try {
    runs.value = await api.runs(props.slug)
  } catch {
    /* a queue that cannot poll must not break the page it sits on */
  }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 5000)
})
onUnmounted(() => window.clearInterval(timer))

const running = computed(() => runs.value.filter((r) => r.status === 'running'))

/** The claim order, exactly as the worker will apply it: what jumped first, then age. */
const waiting = computed(() =>
  runs.value
    .filter((r) => r.status === 'pending')
    .sort((a, b) => Number(b.jump) - Number(a.jump) || a.id - b.id),
)

/** Only what can be worked on: a proven chapter is not a place to inject a fix. */
const targets = computed(() =>
  props.objectives.filter((o) => o.status !== 'proven' && o.status !== 'abandoned'),
)

async function inject() {
  if (!draft.value.objective) return
  busy.value = true
  error.value = null
  try {
    await api.startRun(props.slug, {
      mode: 'chapter',
      objective: draft.value.objective,
      jump: true,
      reason: draft.value.reason.trim() || undefined,
      post: draft.value.post,
    })
    draft.value = { objective: null, reason: '', post: true }
    open.value = false
    await load()
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not queue it'
  } finally {
    busy.value = false
  }
}

async function drop(id: number) {
  await api.cancelRun(id)
  await load()
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
  <section v-if="running.length || waiting.length || open" class="card p-4">
    <div class="flex items-baseline gap-3 flex-wrap">
      <h2 class="text-ink-100 text-[14px]">The queue</h2>
      <span class="text-ink-600 text-[11px]">
        {{ running.length }} running · {{ waiting.length }} waiting
      </span>
      <button class="chip border-ink-600 text-ink-400 hover:text-ink-100 ml-auto" @click="open = !open">
        {{ open ? 'cancel' : 'Put a command in front' }}
      </button>
    </div>

    <!-- Injection. Nothing is interrupted: the turn in flight finishes first. -->
    <div v-if="open" class="mt-3 space-y-2.5 border-l-2 border-run/40 pl-3">
      <p class="text-ink-400">
        This goes next, ahead of everything already waiting. The run in flight is not interrupted —
        it finishes its turn first.
      </p>

      <label class="block">
        <span class="label">On which objective</span>
        <select
          v-model.number="draft.objective"
          class="mt-1 w-full max-w-xl bg-ink-950 border border-ink-800 rounded px-2 py-1.5 text-[12px] text-ink-300 focus:outline-none focus:border-run"
        >
          <option :value="null">choose…</option>
          <option v-for="o in targets" :key="o.id" :value="o.id">#{{ o.id }} — {{ o.title }}</option>
        </select>
      </label>

      <label class="block">
        <span class="label">Why it cannot wait</span>
        <input
          v-model="draft.reason"
          placeholder="the last pass deleted the lighting setup"
          class="mt-1 w-full bg-ink-950 border border-ink-800 rounded px-2 py-1.5 text-[12px] text-ink-300 focus:outline-none focus:border-run"
        />
        <span class="text-ink-600 text-[11px] block mt-1">
          Kept with the run, so the order can be explained later.
        </span>
      </label>

      <label class="flex items-center gap-1.5 text-ink-500 text-[11px]">
        <input v-model="draft.post" type="checkbox" />
        execute and write to the conversation
      </label>

      <p v-if="error" class="text-fail text-[12px]">{{ error }}</p>

      <button class="btn" :disabled="busy || !draft.objective" @click="inject">
        {{ busy ? '…' : 'Queue it next' }}
      </button>
    </div>

    <!-- In flight. Shown but never re-ordered: it is already being carried. -->
    <div v-if="running.length" class="mt-3 space-y-1">
      <div v-for="r in running" :key="r.id" class="flex items-baseline gap-3 text-[12px] flex-wrap">
        <span class="w-1.5 h-1.5 rounded-full bg-run animate-pulse self-center shrink-0" />
        <span class="text-ink-100">{{ r.objective_title ?? r.mode }}</span>
        <span class="text-run text-[11px]">turn {{ r.turn }}</span>
        <span v-if="r.note" class="text-ink-500 text-[11px]">{{ r.note }}</span>
        <span class="num text-ink-600 text-[11px] ml-auto">{{ since(r.taken_at) }}</span>
      </div>
    </div>

    <!-- Waiting, in the order they will be taken. -->
    <ol v-if="waiting.length" class="mt-3 space-y-1">
      <li v-for="(r, i) in waiting" :key="r.id" class="flex items-baseline gap-3 text-[12px] flex-wrap">
        <span class="num text-ink-600 w-4 shrink-0">{{ i + 1 }}</span>
        <span class="text-ink-300">{{ r.objective_title ?? r.mode }}</span>
        <span v-if="r.jump" class="chip border-run/50 text-run">in front</span>
        <span v-if="r.reason" class="text-ink-500 text-[11px]">{{ r.reason }}</span>
        <button class="label hover:text-fail ml-auto" @click="drop(r.id)">remove</button>
      </li>
    </ol>
  </section>
</template>
