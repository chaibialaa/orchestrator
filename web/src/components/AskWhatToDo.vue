<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
const props = defineProps<{ objectiveId: number; current: string | null }>()
const emit = defineEmits<{ applied: [] }>()

/**
 * Replacing the criterion is a separate, deliberate act.
 *
 * The first real use of this button replaced a four-item criterion with the
 * model's one-line summary of it — a reply that MEANT "leave it alone" and was
 * read as "here is the new text". Off by default; the current text is what sits
 * in the box until you decide otherwise.
 */
const replace = ref(false)

/** What the apply actually did, said afterwards rather than left to infer. */
const done = ref<string | null>(null)

const brief = ref<(Brief & { actionable?: boolean }) | null>(null)
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
  seed(b)
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
    error.value = e?.response?.data?.message ?? e?.message ?? 'the request was refused'
  } finally {
    busy.value = false
  }
}

/**
 * The box starts from what the objective SAYS today.
 *
 * A proposal is a proposal: pre-filling with it and hiding the original is how a
 * paraphrase gets applied by somebody who only meant to accept the diagnosis.
 */
function seed(b: Brief) {
  const p: any = b.proposal
  criterion.value = p?.criterion ?? props.current ?? ''
  replace.value = false
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
      seed(b)
    }
  }, 3000)
}
onUnmounted(() => window.clearInterval(timer))

async function apply() {
  if (!brief.value) return
  busy.value = true
  try {
    const p: any = brief.value.proposal
    const r = await api.applyRecalibration(brief.value.id, {
      criterion: replace.value ? criterion.value.trim() : undefined,
      steps: p?.steps ?? [],
      replace_criterion: replace.value,
      shrink_ok: shrinkOk.value,
    })
    done.value =
      (r.criterion_replaced ? 'The criterion was replaced.' : 'The criterion was left as it was.') +
      (r.steps ? ` ${r.steps} step(s) created under this objective.` : ' No steps were created.')
    brief.value = null
    emit('applied')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? e?.message ?? 'it was refused'
    // A refusal on the size is a question, not a wall: confirming once more is
    // the answer, and the button says so rather than repeating the same refusal.
    if (/shorter than the one it replaces/.test(error.value ?? '')) shrinkOk.value = true
  } finally {
    busy.value = false
  }
}

const shrinkOk = ref(false)

/** Is there anything this apply could actually write? */
const applicable = computed(() => {
  const p: any = brief.value?.proposal
  return Boolean(p?.criterion?.trim() || p?.steps?.length)
})

const VERDICT: Record<string, { word: string; ink: string }> = {
  provable: { word: 'It can be proven as written', ink: 'text-proof' },
  unmeasurable: { word: 'Nothing can measure this as written', ink: 'text-halt' },
  over_constrained: { word: 'Over-constrained — this needs a decision, not a rewrite', ink: 'text-fail' },
  too_big: { word: 'Too big for one session — it wants splitting', ink: 'text-halt' },
}
</script>

<template>
  <div>
    <!-- What just happened, said here rather than left to infer from a page that
         looks the same afterwards. It stays until the next thing is asked. -->
    <p v-if="done" class="text-proof text-[12px] mb-2 flex items-baseline gap-2">
      <span>✓ {{ done }}</span>
      <button class="label text-ink-600 hover:text-ink-300" @click="done = null">dismiss</button>
    </p>

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

        <!-- Off by default, and the box holds what the objective says TODAY until
             it is ticked. Accepting a diagnosis and rewriting the target are two
             decisions, and only one of them was being asked for. -->
        <label v-if="brief.actionable !== false" class="flex items-baseline gap-2 mt-4 cursor-pointer">
          <input v-model="replace" type="checkbox" class="accent-run" />
          <span class="text-ink-300 text-[12px]">
            replace the criterion
            <span v-if="!(brief.proposal as any).criterion" class="text-ink-600">
              — it did not propose a new one
            </span>
          </span>
        </label>

        <label v-if="replace && brief.actionable !== false" class="block mt-2">
          <span class="label">What it would become — edit before applying</span>
          <textarea
            v-model="criterion"
            rows="5"
            class="mt-1 w-full bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[12px] text-ink-300 leading-relaxed resize-y focus:outline-none focus:border-run"
          />
          <span v-if="current" class="label text-ink-600 mt-1 block">
            it is {{ current.length }} characters today, {{ criterion.length }} after
          </span>
        </label>

        <p v-if="(brief.proposal as any).steps?.length" class="text-ink-400 text-[12px] mt-2">
          It also proposes {{ (brief.proposal as any).steps.length }} step(s), which will be created
          under this objective.
        </p>

        <div class="flex items-center gap-2 mt-3">
          <template v-if="brief.actionable !== false">
            <!-- Nothing to apply is a real answer, and it had a button anyway.
                 `instrument_missing` proposes no criterion and no steps — there
                 is nothing to write — so pressing apply could only ever fail,
                 and it did: a bare 422 where a sentence belonged. What this
                 verdict asks for is a decision, and that box is below. -->
            <button
              v-if="applicable"
              class="chip border-proof text-proof bg-proof/10 hover:bg-proof/20"
              :disabled="busy"
              @click="apply"
            >
              {{ busy ? '…' : shrinkOk ? 'yes — apply it anyway' : 'apply it' }}
            </button>
            <span v-else class="text-ink-500 text-[11px]">
              Nothing to apply — it proposes no criterion and no steps. What it asks for is a
              decision, below.
            </span>
            <button class="chip border-ink-700 text-ink-500 hover:text-ink-300" @click="brief = null">
              leave it
            </button>
          </template>

          <!-- Already acted on, and still worth reading: a judgement does not stop
               being true because it was used. Asking again is a new session and
               says so. -->
          <template v-else>
            <span class="label text-ink-600">
              read on {{ brief.created_at?.slice(0, 16) }} · already acted on
            </span>
            <button
              class="chip border-ink-700 text-ink-500 hover:border-run hover:text-run ml-auto"
              :disabled="busy"
              @click="ask"
            >
              {{ busy ? '…' : 'ask again ▸' }}
            </button>
          </template>
        </div>
      </template>

      <p v-if="error" class="text-fail text-[11px] mt-2">{{ error }}</p>
    </div>
  </div>
</template>
