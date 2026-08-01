<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../api'

/**
 * An agent asking you to look at the running thing.
 *
 * The one thing working by hand did that the loop took away. Codex would stop
 * and say "open the game and tell me whether X, Y and Z" — and that was often
 * the only honest proof, because a still image says nothing about how something
 * plays. Driven non-interactively it cannot say that to anybody, so it stopped
 * asking and started guessing.
 *
 * The question lands here instead, and the answer becomes a proof: `pass` if you
 * saw it, `fail` if you did not. A person's eyes on a running build are evidence
 * — the only kind for some things — and they belong in the record like any
 * other, not in a conversation nobody reads again.
 */
const props = defineProps<{
  objectiveId: number
  project: string | null
  title: string | null
  question: string | null
  haltId: number
}>()
const emit = defineEmits<{ answered: [] }>()

const busy = ref<'pass' | 'fail' | null>(null)
const note = ref('')
const error = ref<string | null>(null)

async function answer(verdict: 'pass' | 'fail') {
  busy.value = verdict
  error.value = null
  try {
    await api.addEvidence(props.objectiveId, {
      type: 'manual',
      verdict,
      label:
        (verdict === 'pass' ? 'Checked in the running build: yes' : 'Checked in the running build: no') +
        (note.value.trim() ? ` — ${note.value.trim()}` : ''),
      ref: 'seen by a person, in the running thing',
    })
    // The question has been answered; leaving it open would ask it again.
    await api.clearHalts(props.objectiveId, 'human_request')
    emit('answered')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not record it'
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <article class="card p-4 border-run/50 bg-run/[0.05]">
    <div class="flex items-start gap-3 flex-wrap">
      <span class="relative flex w-2 h-2 mt-1.5 shrink-0">
        <span class="absolute inline-flex w-full h-full rounded-full bg-run opacity-70 animate-ping" />
        <span class="relative inline-flex w-2 h-2 rounded-full bg-run" />
      </span>
      <span class="label text-ink-600 mt-0.5">{{ project }}</span>
      <RouterLink :to="`/o/${objectiveId}`" class="text-ink-100 flex-1 min-w-[12rem] hover:underline">
        {{ title ?? `objective #${objectiveId}` }}
      </RouterLink>
      <span class="chip border-run/50 text-run">it is asking you</span>
    </div>

    <!-- The question verbatim. Rewording it would lose the detail that made it
         worth asking. -->
    <p v-if="question" class="mt-2.5 text-ink-200 leading-relaxed border-l-2 border-run/40 pl-3 max-w-[68ch] whitespace-pre-wrap">
      {{ question }}
    </p>

    <input
      v-model="note"
      placeholder="what you saw, if it is worth recording (optional)"
      class="mt-3 w-full max-w-2xl bg-ink-950 border border-ink-800 rounded px-2.5 py-1.5 text-[12px] text-ink-300 focus:outline-none focus:border-run"
      @keyup.enter="answer('pass')"
    />

    <div class="flex items-center gap-2 mt-3 flex-wrap">
      <button
        class="chip border-proof text-proof bg-proof/10 hover:bg-proof/20"
        :disabled="busy !== null"
        @click="answer('pass')"
      >
        {{ busy === 'pass' ? '…' : 'I looked — it is there' }}
      </button>
      <button
        class="chip border-fail/60 text-fail hover:bg-fail/10"
        :disabled="busy !== null"
        @click="answer('fail')"
      >
        {{ busy === 'fail' ? '…' : 'I looked — it is not' }}
      </button>
      <span class="text-ink-600 text-[11px]">
        Either way it is recorded as a proof: eyes on a running build are evidence.
      </span>
    </div>

    <p v-if="error" class="text-fail text-[12px] mt-2">{{ error }}</p>
  </article>
</template>
