<script setup lang="ts">
import { ref, watch } from 'vue'
import { api } from '../api'

/**
 * Where you actually decide.
 *
 * The page said "you alone can settle which of the two to give up" and offered
 * one button: run it again. The instruction named a decision and the screen had
 * nowhere to take it — so the only visible move was the one that repeats what
 * already failed, which is exactly the loop this tool exists to break.
 *
 * A decision written here is not a note. `session:start` injects the project's
 * decisions into every session that follows, and the breakdown is told not to
 * contradict them: it changes what the next pass is allowed to do. That is why
 * it asks for a sentence rather than a click on "A" or "B" — a branch label
 * means nothing to a session that never read the analysis.
 */
const props = defineProps<{ slug: string; objectiveId: number; question: string; prefill?: string }>()
const emit = defineEmits<{ recorded: [] }>()

const text = ref('')

// Picking a branch above writes the sentence here; it stays editable, because
// those are the model's words about your choice and you may not mean them.
watch(
  () => props.prefill,
  (v) => {
    if (v) text.value = v
  },
)
const busy = ref(false)
const error = ref<string | null>(null)

async function record() {
  if (!text.value.trim()) return
  busy.value = true
  error.value = null
  try {
    await api.createDecision(props.slug, {
      title: `Arbitration on #${props.objectiveId}`,
      body: text.value.trim(),
      objective_id: props.objectiveId,
    })
    text.value = ''
    emit('recorded')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? e?.message ?? 'it was refused'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mt-4 border-t border-halt/30 pt-4">
    <label class="block">
      <span class="label text-halt">Your decision — write it in a sentence</span>
      <p class="text-ink-500 text-[11px] mt-1 max-w-[80ch]">
        Every session that follows is handed this, and is told not to contradict it. Say what you are
        giving up, not only what you want: “the standalone performance barrier is out of scope for
        this chapter, it becomes its own objective” settles it — “make it faster” does not.
      </p>
      <textarea
        v-model="text"
        rows="3"
        class="mt-2 w-full bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[12px] text-ink-200 leading-relaxed resize-y focus:outline-none focus:border-halt"
        :placeholder="question.slice(0, 120)"
      />
    </label>
    <div class="flex items-center gap-3 mt-2">
      <button
        class="chip border-halt text-halt bg-halt/10 hover:bg-halt/20"
        :disabled="busy || !text.trim()"
        @click="record"
      >
        {{ busy ? '…' : 'record this decision' }}
      </button>
      <span v-if="error" class="text-fail text-[11px]">{{ error }}</span>
    </div>
  </div>
</template>
