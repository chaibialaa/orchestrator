<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, type Objective } from '../api'

/**
 * Run a chapter's steps one after another, without coming back between each.
 *
 * The queue could only take one objective at a time, so a chapter of eight steps
 * meant eight visits to this page — which is the interruption the tool exists to
 * remove. Here you tick what should run and it is queued in order; the worker
 * takes them one after another.
 *
 * Sequential, and only sequential. Two agents in one working tree overwrite each
 * other's edits, so "in parallel" is not a mode this can offer honestly on a
 * single repository. What it can offer is nobody needed between one step and
 * the next.
 */
const props = defineProps<{ slug: string; chapter: Objective; steps: Objective[] }>()
const emit = defineEmits<{ queued: [] }>()

const open = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const stopOnFailure = ref(true)
const chosen = ref<Set<number>>(new Set())

/** Only what can actually run: a step with no criterion is refused by the gate. */
const runnable = computed(() =>
  props.steps.filter((s) => s.status !== 'proven' && s.status !== 'abandoned' && s.proof_spec?.trim()),
)

const undefinedSteps = computed(() => props.steps.filter((s) => !s.proof_spec?.trim()))

function toggle(id: number) {
  const next = new Set(chosen.value)
  next.has(id) ? next.delete(id) : next.add(id)
  chosen.value = next
}

function start() {
  open.value = true
  chosen.value = new Set(runnable.value.map((s) => s.id))
}

async function queue() {
  const objectives = runnable.value.filter((s) => chosen.value.has(s.id)).map((s) => s.id)
  if (!objectives.length) return
  busy.value = true
  error.value = null
  try {
    await api.startSeries(props.slug, { objectives, stop_on_failure: stopOnFailure.value })
    open.value = false
    emit('queued')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not queue it'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="runnable.length" class="text-[11px]">
    <button v-if="!open" class="chip border-run/50 text-run hover:bg-run/10" @click="start">
      Run {{ runnable.length }} step{{ runnable.length > 1 ? 's' : '' }} in order
    </button>

    <div v-else class="mt-2 border-l-2 border-run/40 pl-3 space-y-2">
      <p class="text-ink-400 max-w-[68ch]">
        Queued in this order, one after another. Nobody is needed between two steps.
      </p>

      <label
        v-for="s in runnable"
        :key="s.id"
        class="flex items-baseline gap-2 cursor-pointer hover:text-ink-200"
        :class="chosen.has(s.id) ? 'text-ink-200' : 'text-ink-500'"
      >
        <input
          type="checkbox"
          :checked="chosen.has(s.id)"
          class="mt-0.5"
          @change="toggle(s.id)"
        />
        <span class="num text-ink-600">#{{ s.id }}</span>
        <span class="truncate">{{ s.title }}</span>
      </label>

      <p v-if="undefinedSteps.length" class="text-ink-600 max-w-[68ch]">
        {{ undefinedSteps.length }} step{{ undefinedSteps.length > 1 ? 's are' : ' is' }} left out:
        no criterion says how they would be proven, and the tool refuses to start those.
      </p>

      <label class="flex items-center gap-1.5 text-ink-500">
        <input v-model="stopOnFailure" type="checkbox" />
        stop the series if a step fails
      </label>
      <p class="text-ink-600 max-w-[68ch] -mt-1">
        A step that failed is often why the next one cannot work either. Unticked, the series
        carries on regardless.
      </p>

      <p v-if="error" class="text-fail max-w-[68ch] leading-relaxed">{{ error }}</p>

      <div class="flex items-center gap-2">
        <button class="btn" :disabled="busy || !chosen.size" @click="queue">
          {{ busy ? '…' : `Queue ${chosen.size}` }}
        </button>
        <button class="label hover:text-ink-300" @click="open = false">cancel</button>
      </div>
    </div>
  </div>
</template>
