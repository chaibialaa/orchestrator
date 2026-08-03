<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { api, type Live } from '../api'

/**
 * What the running pass is doing, while it does it.
 *
 * Both halves of the exchange were already kept — but only once the pass had
 * ended. For the ten or twenty minutes it runs, the screen said `turn 2 — claude`
 * and nothing else, and the only living account was a log file the tool never
 * mentioned. Watching your own money being spent should not require `tail -f`.
 *
 * It sits BEHIND the "a pass is working" band rather than beside it: this is a
 * seventh panel only if it is always open, and it is not.
 */
const props = defineProps<{ objectiveId: number }>()

const data = ref<Live | null>(null)
const open = ref(false)
const showMission = ref(false)
const body = ref<HTMLElement | null>(null)
let timer: number | undefined

async function load() {
  const before = data.value?.total ?? 0
  data.value = await api.live(props.objectiveId).catch(() => null)
  // Follow the tail only when already at the bottom: yanking the view while
  // somebody is reading three screens up is how a live view becomes unusable.
  if (open.value && (data.value?.total ?? 0) > before) {
    await nextTick()
    const el = body.value
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 4000)
})
onUnmounted(() => window.clearInterval(timer))
watch(() => props.objectiveId, load)

const TONE: Record<string, string> = {
  says: 'text-ink-100',
  asked: 'text-run',
  uses: 'text-ink-400',
  got: 'text-ink-600',
  refused: 'text-fail',
}
const WORD: Record<string, string> = {
  says: 'it says',
  asked: 'it was asked',
  uses: 'calls',
  got: 'gets back',
  refused: 'refused',
}

function clock(at: string | null) {
  return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
}
</script>

<template>
  <div v-if="data" class="mt-3">
    <button class="label text-ink-500 hover:text-ink-200 transition-colors" @click="open = !open">
      {{ open ? 'hide what it is doing' : 'watch what it is doing' }}
      <span class="text-ink-600 ml-1">{{ data.total }} steps so far</span>
    </button>

    <div v-if="open" class="mt-2 border border-ink-800 rounded">
      <div class="flex items-baseline gap-3 px-3 py-2 border-b border-ink-800 flex-wrap">
        <span class="num text-ink-500 text-[11px]">{{ data.harness }} · attempt {{ data.passage }}</span>
        <button
          v-if="data.mission"
          class="label text-ink-600 hover:text-ink-300"
          @click="showMission = !showMission"
        >
          {{ showMission ? 'hide what it was told' : 'read what it was told' }}
        </button>
      </div>

      <!-- The instruction, in full. It is the half a reader most often wants,
           and it was only ever visible after the fact. -->
      <pre
        v-if="showMission && data.mission"
        class="px-3 py-2 text-[11px] text-ink-400 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto border-b border-ink-800"
      >{{ data.mission }}</pre>

      <div ref="body" class="max-h-96 overflow-y-auto px-3 py-2 space-y-1.5">
        <p v-if="!data.events.length" class="text-ink-600 text-[11px]">
          {{ data.note ?? 'nothing written yet — it is starting' }}
        </p>
        <div v-for="(e, i) in data.events" :key="i" class="text-[11px] leading-relaxed flex gap-2">
          <span class="num text-ink-700 shrink-0">{{ clock(e.at) }}</span>
          <span class="label shrink-0 w-16" :class="TONE[e.kind]">{{ WORD[e.kind] ?? e.kind }}</span>
          <span class="min-w-0" :class="TONE[e.kind]">
            <span v-if="e.tool" class="num text-ink-300">{{ e.tool }}</span>
            <span v-if="e.tool && e.text" class="text-ink-600"> · </span>{{ e.text }}
          </span>
        </div>
      </div>

      <p class="px-3 py-1.5 text-ink-700 text-[10px] border-t border-ink-800">
        Read from the harness's own transcript, refreshed every 4 s. Reasoning is left out — it is
        the bulk of it and is addressed to nobody.
      </p>
    </div>
  </div>
</template>
