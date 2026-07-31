<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../api'

/**
 * An objective that has stopped learning, and the two ways out.
 *
 * A halt that only describes the problem leaves the reader where they were —
 * and this one is easy to answer badly, because the tempting answer is "run it
 * again", which is exactly what produced the halt. So the two things that
 * actually change something are here: rewrite what would prove it, or accept
 * that it will not conclude as posed and set it aside.
 *
 * Blockrise chapter 16 is why this exists. Six attempts and $133 went into
 * rediscovering that its criterion was four requirements in prose that nothing
 * could answer at once. Rewritten to read a number the project already computed,
 * it closed in one turn.
 */
const props = defineProps<{
  project: string | null
  objectiveId: number
  /** Null when the halt outlived the objective's title — the id still identifies it. */
  title: string | null
  detail?: string | null
}>()
const emit = defineEmits<{ done: [] }>()

const open = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const criterion = ref('')

async function rewrite() {
  const text = criterion.value.trim()
  if (text.length < 15) {
    error.value = 'Too short to be a criterion — say what would settle it.'
    return
  }
  busy.value = true
  error.value = null
  try {
    await api.updateObjective(props.objectiveId, { proof_spec: text })
    // Only now: the halt was about this criterion, and it is not that one any more.
    await api.clearHalts(props.objectiveId, 'not_converging')
    open.value = false
    emit('done')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not save it'
  } finally {
    busy.value = false
  }
}

async function setAside() {
  busy.value = true
  try {
    await api.updateObjective(props.objectiveId, { status: 'abandoned' })
    await api.clearHalts(props.objectiveId, 'not_converging')
    emit('done')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <article class="card p-4 border-halt/60 bg-halt/[0.06]">
    <div class="flex items-start gap-3 flex-wrap">
      <span class="w-1.5 h-1.5 rounded-full bg-halt self-center mt-1.5 shrink-0" />
      <span class="label text-ink-600 mt-0.5">{{ project }}</span>
      <RouterLink :to="`/o/${objectiveId}`" class="text-ink-100 flex-1 min-w-[12rem] hover:underline">
        {{ title ?? `objective #${objectiveId}` }}
      </RouterLink>
      <button
        v-if="!open"
        class="chip border-halt text-halt bg-halt/10 hover:bg-halt/20"
        @click="open = true"
      >
        Change something
      </button>
    </div>

    <p v-if="detail" class="text-ink-300 mt-2 leading-relaxed max-w-[68ch]">{{ detail }}</p>

    <div v-if="open" class="mt-3 space-y-4 border-l-2 border-halt/40 pl-3">
      <div>
        <span class="label">Rewrite what would prove it</span>
        <p class="text-ink-400 mt-1 max-w-[68ch]">
          The best criterion is one a command can answer. A chapter here spent six attempts on four
          requirements written in prose; rewritten to read a number the project already computed, it
          closed in one turn.
        </p>
        <textarea
          v-model="criterion"
          rows="3"
          placeholder="`orchestrator prove audit` returns pass — it reads the score the project writes for itself, and only passes at or above its own threshold."
          class="mt-2 w-full bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[12px] text-ink-300 focus:outline-none focus:border-run leading-relaxed"
        />
        <button class="btn mt-2" :disabled="busy" @click="rewrite">
          {{ busy ? '…' : 'Save it and let the loop try again' }}
        </button>
      </div>

      <div class="border-t border-ink-850 pt-3">
        <span class="label">Or set it aside</span>
        <p class="text-ink-400 mt-1 max-w-[68ch]">
          It stops being counted and nothing runs on it. What it has already proven stays where it
          is — nothing is deleted.
        </p>
        <button class="chip border-ink-600 text-ink-400 hover:text-fail mt-2" :disabled="busy" @click="setAside">
          set aside
        </button>
      </div>

      <p v-if="error" class="text-fail text-[12px]">{{ error }}</p>
      <button class="label hover:text-ink-300" @click="open = false">cancel</button>
    </div>
  </article>
</template>
