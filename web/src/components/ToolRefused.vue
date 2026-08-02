<script setup lang="ts">
import { ref } from 'vue'
import { api, http } from '../api'

/**
 * A pass stopped by a permission, not by the work.
 *
 * A refused tool used to be counted in a log line and nowhere else: the session
 * carried on without it, produced something degraded, and the verdict then
 * described an obstacle that had nothing to do with what was asked. One pass
 * spent $110 and 150 M tokens with "3 tool(s) refused" buried in its own output.
 *
 * It is now a halt, so it reaches the browser notification and this screen — and
 * the run is SUSPENDED rather than killed, so saying yes resumes the work
 * instead of asking for it to be queued again. Which is why this card exists
 * separately from the one that asks you to look at a running build: the question
 * is not "did you see it", it is "may it".
 */
const props = defineProps<{
  objectiveId: number
  project: string | null
  title: string | null
  detail: string | null
  haltId: number
}>()
const emit = defineEmits<{ done: [] }>()

const busy = ref(false)
const error = ref<string | null>(null)

/** The tool names, pulled back out of the sentence they were written into. */
const tools = (props.detail?.match(/could not use: ([^.]+)\./)?.[1] ?? '').trim()

async function carryOn() {
  busy.value = true
  error.value = null
  try {
    // Release every run of this project that is waiting, then clear the halt.
    // In that order: clearing first would let the loop meet the same wall before
    // the hold is lifted, and report it twice.
    const runs = await api.runs(props.project ?? undefined)
    for (const r of runs.filter((x) => x.hold_between_turns && x.status === 'running')) {
      await http.patch(`/runs/${r.id}`, { hold_between_turns: false })
    }
    await api.clearHalts(props.objectiveId, 'human_request')
    emit('done')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not carry on'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="card p-4 border-halt/40 bg-halt/[0.04]">
    <div class="flex items-baseline gap-3 flex-wrap">
      <span class="label text-halt">{{ project }}</span>
      <RouterLink :to="`/o/${objectiveId}`" class="text-ink-100 flex-1 min-w-[12rem] hover:underline">
        {{ title }}
      </RouterLink>
      <span class="chip border-halt/60 text-halt">suspended, not stopped</span>
    </div>

    <p class="text-ink-300 mt-2 leading-relaxed">
      The pass could not use
      <code v-if="tools" class="text-ink-100">{{ tools }}</code>
      <span v-else>a tool it needed</span>. It is not the work that failed, and a verdict taken on
      this attempt would judge the obstacle rather than the work.
    </p>

    <div class="mt-3 flex items-center gap-2.5 flex-wrap">
      <RouterLink
        v-if="project"
        :to="`/p/${project}/permissions`"
        class="chip border-run/60 text-run hover:bg-run/10"
      >
        allow it →
      </RouterLink>
      <button
        class="chip border-proof/60 text-proof hover:bg-proof/10 disabled:opacity-40"
        :disabled="busy"
        @click="carryOn"
      >
        {{ busy ? 'carrying on…' : 'done — carry on' }}
      </button>
      <span class="text-ink-600 text-[11px]">the run is waiting; it resumes where it stopped</span>
    </div>

    <p v-if="error" class="text-fail text-[12px] mt-2">{{ error }}</p>
  </div>
</template>
