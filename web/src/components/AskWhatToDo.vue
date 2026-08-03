<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api, type Brief } from '../api'

/**
 * Ask what to do about an objective that will not conclude.
 *
 * The request writes itself, from the record: how many attempts, what came back
 * failing, where it halted, how the last run ended. Asking a person to describe
 * what went wrong is asking them to summarise ten sessions they did not read,
 * and a summary written from memory flatters the work in a way the traces do
 * not.
 *
 * It PROPOSES. Nothing is applied until you press apply — an objective silently
 * re-aimed by a machine is precisely what this tool exists to make impossible.
 * And the answer it is most useful for giving is the one nobody asked for on
 * chapter 3: this cannot be proven as written, and here are the two
 * requirements that contradict each other.
 */
const props = defineProps<{ objectiveId: number }>()
const emit = defineEmits<{ applied: [] }>()

const brief = ref<Brief | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
let timer: number | undefined

/** The rewritten criterion, editable before it is applied. It is a proposal. */
const criterion = ref('')

/** What was already asked about this objective, if anything. */
async function existing() {
  const b = await api.recalibration(props.objectiveId).catch(() => null)
  if (!b) return
  brief.value = b
  const p: any = b.proposal
  if (p?.criterion) criterion.value = p.criterion
  if (b.status === 'pending' || b.status === 'running') poll()
}
onMounted(existing)
watch(() => props.objectiveId, existing)

async function ask() {
  busy.value = true
  error.value = null
  try {
    brief.value = await api.recalibrate(props.objectiveId)
    poll()
  } catch (e: any) {
    error.value = e?.response?.data?.error ?? e?.message ?? 'the request was refused'
  } finally {
    busy.value = false
  }
}

function poll() {
  window.clearInterval(timer)
  timer = window.setInterval(async () => {
    if (!brief.value) return
    const b = await api.brief(brief.value.id).catch(() => null)
    if (!b) return
    brief.value = b
    if (b.status === 'proposed' || b.status === 'failed' || b.status === 'applied') {
      window.clearInterval(timer)
      const p: any = b.proposal
      if (p?.criterion) criterion.value = p.criterion
    }
  }, 3000)
}
onUnmounted(() => window.clearInterval(timer))

async function apply() {
  if (!brief.value) return
  busy.value = true
  try {
    const p: any = brief.value.proposal
    await api.applyRecalibration(brief.value.id, {
      criterion: criterion.value.trim() || undefined,
      steps: p?.steps ?? [],
    })
    brief.value = null
    emit('applied')
  } catch (e: any) {
    error.value = e?.response?.data?.error ?? e?.message ?? 'it was refused'
  } finally {
    busy.value = false
  }
}

const VERDICT: Record<string, { word: string; ink: string }> = {
  provable: { word: 'It can be proven as written', ink: 'text-proof' },
  unmeasurable: { word: 'Nothing can measure this as written', ink: 'text-halt' },
  over_constrained: { word: 'Over-constrained — this needs a decision, not a rewrite', ink: 'text-fail' },
  too_big: { word: 'Too big for one session — it wants splitting', ink: 'text-halt' },
}
</script>

<template>
  <div>
    <button
      v-if="!brief"
      class="chip border-ink-600 text-ink-300 hover:border-run hover:text-run transition-colors"
      :disabled="busy"
      @click="ask"
    >
      {{ busy ? '…' : 'ask what to do ▸' }}
    </button>

    <div v-else class="border border-ink-700 rounded p-4 mt-3">
      <div v-if="brief.status === 'pending' || brief.status === 'running'" class="text-ink-400 text-[12px]">
        Reading its history — {{ brief.status === 'pending' ? 'waiting for the worker' : 'thinking' }}.
        This takes a minute and costs a short session.
      </div>

      <p v-else-if="brief.status === 'failed'" class="text-fail text-[12px]">
        {{ brief.error ?? 'it came back unusable' }}
      </p>

      <template v-else-if="brief.proposal">
        <div class="flex items-baseline gap-3 flex-wrap">
          <span class="label" :class="VERDICT[(brief.proposal as any).verdict]?.ink ?? 'text-ink-300'">
            {{ VERDICT[(brief.proposal as any).verdict]?.word ?? (brief.proposal as any).verdict }}
          </span>
        </div>
        <p class="text-ink-300 mt-2 leading-relaxed max-w-[80ch]">{{ (brief.proposal as any).why }}</p>

        <!-- Two requirements that cannot both hold is not a criterion problem.
             Showing them apart from the rewrite is the whole point: one of them
             has to be given up, and only you can say which. -->
        <ul
          v-if="(brief.proposal as any).contradiction?.length"
          class="mt-3 space-y-1 border-l-2 border-fail/40 pl-3"
        >
          <li v-for="(c, i) in (brief.proposal as any).contradiction" :key="i" class="text-ink-200 text-[12px]">
            {{ c }}
          </li>
        </ul>
        <p v-if="(brief.proposal as any).decision_needed" class="text-halt text-[12px] mt-2 max-w-[80ch]">
          Only you can settle: {{ (brief.proposal as any).decision_needed }}
        </p>

        <label class="block mt-4">
          <span class="label">The criterion it proposes — edit before applying</span>
          <textarea
            v-model="criterion"
            rows="4"
            class="mt-1 w-full bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[12px] text-ink-300 leading-relaxed resize-y focus:outline-none focus:border-run"
          />
        </label>

        <p v-if="(brief.proposal as any).steps?.length" class="text-ink-400 text-[12px] mt-2">
          It also proposes {{ (brief.proposal as any).steps.length }} step(s), which will be created
          under this objective.
        </p>

        <div class="flex items-center gap-2 mt-3">
          <button
            class="chip border-proof text-proof bg-proof/10 hover:bg-proof/20"
            :disabled="busy"
            @click="apply"
          >
            {{ busy ? '…' : 'apply it' }}
          </button>
          <button class="chip border-ink-700 text-ink-500 hover:text-ink-300" @click="brief = null">
            leave it
          </button>
        </div>
      </template>

      <p v-if="error" class="text-fail text-[11px] mt-2">{{ error }}</p>
    </div>
  </div>
</template>
