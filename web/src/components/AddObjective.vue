<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { api } from '../api'

/**
 * Add a chapter, or a step inside one, from where you are looking at them.
 *
 * Both were possible only on the plan page, reached by a link in the corner —
 * so the project page showed two chapters with no steps, no way to add one, and
 * no hint that anywhere else would let you. An action that exists somewhere else
 * is an action most people never find.
 *
 * The criterion is asked for here rather than later. An objective without one
 * cannot be started — the gate says so and refuses — and filling it in at the
 * moment you are thinking about the work costs nothing, where coming back to it
 * costs remembering.
 */
const props = defineProps<{ slug: string; parentId?: number; nextPriority?: number }>()
const emit = defineEmits<{ created: [] }>()

const open = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const draft = ref({ title: '', proof_spec: '', blast_radius: 'feature' })

/**
 * `autofocus` is an attribute the browser honours when it PARSES the document,
 * and this field is inserted long after that — so it did nothing, and the first
 * thing typed went nowhere. Caught by typing into it.
 */
const field = ref<HTMLInputElement | null>(null)
watch(open, async (isOpen) => {
  if (!isOpen) return
  await nextTick()
  field.value?.focus()
})

const isStep = computed(() => Boolean(props.parentId))

async function create() {
  const title = draft.value.title.trim()
  if (!title) return
  busy.value = true
  error.value = null
  try {
    await api.createObjective(props.slug, {
      title,
      proof_spec: draft.value.proof_spec.trim() || null,
      blast_radius: draft.value.blast_radius as 'cosmetic' | 'feature' | 'api' | 'critical',
      ...(props.parentId ? { parent_id: props.parentId } : {}),
      priority: props.nextPriority ?? 10,
    })
    draft.value = { title: '', proof_spec: '', blast_radius: 'feature' }
    open.value = false
    emit('created')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not add it'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="text-[11px]">
    <button
      v-if="!open"
      class="chip border-ink-700 text-ink-500 hover:text-ink-200 hover:border-ink-600"
      @click="open = true"
    >
      + {{ isStep ? 'step' : 'chapter' }}
    </button>

    <div v-else class="border-l-2 border-run/40 pl-3 space-y-2">
      <input
        ref="field"
        v-model="draft.title"
        :placeholder="isStep ? 'what this step does' : 'what this chapter is for'"
        class="w-full bg-ink-950 border border-ink-800 rounded px-2 py-1.5 text-[12px] text-ink-200 focus:outline-none focus:border-run"
        @keyup.escape="open = false"
      />

      <textarea
        v-model="draft.proof_spec"
        rows="2"
        placeholder="what would prove it is finished — a command that passes, a number crossing a threshold, an image showing something named"
        class="w-full bg-ink-950 border border-ink-800 rounded px-2 py-1.5 text-[12px] text-ink-300 focus:outline-none focus:border-run leading-relaxed"
      />

      <div class="flex items-center gap-3 flex-wrap">
        <label class="flex items-center gap-1.5 text-ink-500">
          risk
          <select
            v-model="draft.blast_radius"
            class="bg-ink-950 border border-ink-800 rounded px-1.5 py-1 text-ink-300 focus:outline-none focus:border-run"
          >
            <option value="cosmetic">visual only</option>
            <option value="feature">a visible function</option>
            <option value="api">data or a shared interface</option>
            <option value="critical">money, payroll, production</option>
          </select>
        </label>

        <button class="btn" :disabled="busy || !draft.title.trim()" @click="create">
          {{ busy ? '…' : 'Add' }}
        </button>
        <button class="label hover:text-ink-300" @click="open = false">cancel</button>
      </div>

      <p v-if="!draft.proof_spec.trim()" class="text-ink-600 max-w-[62ch]">
        Without a criterion it is saved as a draft and nothing can start it — which is honest, and
        reversible: write one later and it becomes runnable.
      </p>
      <p v-if="error" class="text-fail">{{ error }}</p>
    </div>
  </div>
</template>
