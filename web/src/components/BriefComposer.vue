<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api, type Brief, type Breakdown, type BlastRadius, type ProposedStep } from '../api'
import { blastLabel } from '../labels'

const props = defineProps<{ slug: string }>()

/**
 * This screen reads breakdowns. A brief can now also carry a recalibration —
 * a judgement on one objective — which has a verdict where this has chapters.
 * The list above drops those; this states, in the type, which shape is expected.
 */
const plan = (b: Brief) => b.proposal as Breakdown | null
const emit = defineEmits<{ applied: [] }>()

const text = ref('')
const briefs = ref<Brief[]>([])
const sending = ref(false)
const error = ref<string | null>(null)
let poller: ReturnType<typeof setInterval> | null = null

/** A local copy of the breakdown, so it can be corrected before it counts. */
const draft = ref<Record<number, { chapter: string; intent: string; steps: ProposedStep[] }>>({})

async function load() {
  try {
    // A brief attached to an objective is a judgement on that objective, shown
    // where the objective is. It has no chapters, and this screen is about chapters.
    briefs.value = (await api.briefs(props.slug)).filter((b) => !b.objective_id)
    for (const b of briefs.value) {
      if (b.status === 'proposed' && b.proposal && !draft.value[b.id]) {
        draft.value = {
          ...draft.value,
          [b.id]: {
            // A multi-chapter plan is shown through its first chapter here; the
            // rest is applied whole. Reading `.chapter` on a `{chapters:[…]}`
            // proposal gave `undefined` and an empty step list — the shape that
            // has cost this project seven defects today.
            chapter: plan(b)!.chapter ?? plan(b)!.chapters?.[0]?.chapter ?? '',
            intent: plan(b)!.intent ?? plan(b)!.chapters?.[0]?.intent ?? '',
            steps: (plan(b)!.steps ?? plan(b)!.chapters?.[0]?.steps ?? []).map((e) => ({ ...e })),
          },
        }
      }
    }
  } catch {
    /* the composer is not essential: it must not take the page down */
  }
}

onMounted(() => {
  load()
  // We are waiting on an agent running elsewhere: without polling, the screen
  // would sit on "waiting" long after the proposal had arrived.
  poller = setInterval(() => {
    if (briefs.value.some((b) => b.status === 'pending' || b.status === 'running')) load()
  }, 4000)
})
onBeforeUnmount(() => poller && clearInterval(poller))

async function submit() {
  const body = text.value.trim()
  if (body.length < 20) {
    error.value = 'Too short to break down — describe what you want to end up with.'
    return
  }
  sending.value = true
  error.value = null
  try {
    const b = await api.createBrief(props.slug, body)
    briefs.value = [b, ...briefs.value]
    text.value = ''
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'the request failed'
  } finally {
    sending.value = false
  }
}

async function apply(b: Brief) {
  const d = draft.value[b.id]
  if (!d) return
  try {
    await api.applyBrief(b.id, { chapter: d.chapter, intent: d.intent || null, steps: d.steps })
    await load()
    emit('applied')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'the plan could not be created'
  }
}

async function discard(b: Brief) {
  await api.deleteBrief(b.id).catch(() => undefined)
  briefs.value = briefs.value.filter((x) => x.id !== b.id)
}

function removeStep(id: number, i: number) {
  const d = draft.value[id]
  if (d) d.steps = d.steps.filter((_, n) => n !== i)
}

const RISKS: BlastRadius[] = ['cosmetic', 'feature', 'api', 'critical']
const busyOn = (b: Brief) => b.status === 'pending' || b.status === 'running'
</script>

<template>
  <section class="card p-5">
    <h2 class="text-ink-100 text-[14px]">Describe it all at once</h2>
    <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
      Paste your request exactly as you wrote it — a prompt, a spec, some notes. An agent breaks it
      into a chapter and steps, each with a proof criterion. It
      <strong class="text-ink-300">proposes</strong>: nothing enters the plan before you have read it
      and accepted it.
    </p>

    <form class="mt-4" @submit.prevent="submit">
      <textarea
        v-model="text"
        rows="7"
        class="w-full bg-ink-950 border border-ink-800 rounded px-3 py-2.5 text-[13px] text-ink-300 leading-relaxed focus:outline-none focus:border-run"
        placeholder="E.g. — Rework the Excel employee import: accept .xlsx and .csv, reject duplicate staff numbers with a clear message, produce a downloadable report of rejected rows, and cover all of it with tests…"
      />
      <div class="flex items-center gap-3 mt-2.5">
        <button class="btn" :disabled="sending || text.trim().length < 20">
          {{ sending ? 'sending…' : 'break it down' }}
        </button>
        <span class="text-ink-600 text-[11px]">
          The breakdown runs on your machine, through the agent — start
          <code class="text-ink-400">orchestrator plan --watch</code> if it is not already watching.
        </span>
      </div>
    </form>

    <p v-if="error" class="mt-3 text-fail text-[12px]">{{ error }}</p>

    <div v-if="briefs.length" class="mt-5 space-y-3">
      <article
        v-for="b in briefs"
        :key="b.id"
        class="border border-ink-800 rounded p-3.5"
        :class="b.status === 'failed' ? 'border-fail/40' : ''"
      >
        <header class="flex items-baseline gap-3 flex-wrap">
          <span class="label text-ink-600">brief #{{ b.id }}</span>
          <span
            class="label"
            :class="{
              'text-run': busyOn(b),
              'text-halt': b.status === 'proposed',
              'text-proof': b.status === 'applied',
              'text-fail': b.status === 'failed',
            }"
          >
            {{
              b.status === 'pending'
                ? 'waiting for an agent'
                : b.status === 'running'
                  ? 'breaking it down'
                  : b.status === 'proposed'
                    ? 'to review'
                    : b.status === 'applied'
                      ? 'applied to the plan'
                      : 'failed'
            }}
          </span>
          <button class="label hover:text-fail ml-auto" @click="discard(b)">discard</button>
        </header>

        <p v-if="busyOn(b)" class="text-ink-500 text-[12px] mt-2">
          {{ b.body.slice(0, 160) }}{{ b.body.length > 160 ? '…' : '' }}
        </p>

        <!-- What it had to decide that you did not say.
             This is what replaces the back-and-forth: instead of reading a plan
             and guessing where it misunderstood, you disagree with one line. A
             wrong assumption here costs a sentence; the same one discovered
             three chapters in costs the chapters. -->
        <section v-if="plan(b)?.assumptions?.length" class="mt-3">
          <span class="label">What it assumed</span>
          <ul class="mt-1.5 space-y-1">
            <li
              v-for="(a, i) in plan(b)!.assumptions"
              :key="i"
              class="text-ink-300 text-[12px] flex items-baseline gap-2 max-w-[68ch]"
            >
              <span class="text-ink-600 shrink-0">·</span>
              <span>{{ a }}</span>
            </li>
          </ul>
          <p class="text-ink-600 text-[11px] mt-1.5 max-w-[68ch]">
            Wrong on any of these? Say so in a new brief rather than correcting the steps — the
            plan follows from them.
          </p>
        </section>

        <!-- What it could not settle. Naming a gap beats filling it with a guess
             that reads like a decision. -->
        <section v-if="plan(b)?.unknowns?.length" class="mt-3">
          <span class="label text-halt">What it could not settle</span>
          <ul class="mt-1.5 space-y-1">
            <li
              v-for="(u, i) in plan(b)!.unknowns"
              :key="i"
              class="text-halt text-[12px] flex items-baseline gap-2 max-w-[68ch]"
            >
              <span class="shrink-0">·</span>
              <span>{{ u }}</span>
            </li>
          </ul>
        </section>

        <pre
          v-if="b.status === 'failed'"
          class="mt-2 text-[11px] text-ink-400 whitespace-pre-wrap max-h-40 overflow-y-auto"
          >{{ b.error }}</pre
        >

        <div v-if="b.status === 'proposed' && draft[b.id]" class="mt-3 space-y-2.5">
          <input
            v-model="draft[b.id].chapter"
            class="w-full bg-transparent text-ink-100 border-b border-ink-800 focus:border-run focus:outline-none pb-1"
          />

          <div
            v-for="(e, i) in draft[b.id].steps"
            :key="i"
            class="border border-ink-800 rounded p-2.5"
          >
            <div class="flex items-baseline gap-2">
              <span class="text-ink-600 text-[11px]">{{ i + 1 }}</span>
              <input
                v-model="e.title"
                class="flex-1 bg-transparent text-ink-100 border-b border-transparent hover:border-ink-700 focus:border-run focus:outline-none"
              />
              <button class="label hover:text-fail" title="remove" @click="removeStep(b.id, i)">
                ×
              </button>
            </div>
            <textarea
              v-model="e.proof_spec"
              rows="4"
              placeholder="What will prove this is finished"
              class="mt-2 w-full bg-ink-950 border rounded px-2.5 py-1.5 text-[12px] text-ink-300 leading-relaxed resize-y focus:outline-none focus:border-run"
              :class="e.proof_spec ? 'border-ink-800' : 'border-halt/40'"
            />
            <div class="flex items-center gap-2 mt-2">
              <span class="label">Risk</span>
              <select
                v-model="e.blast_radius"
                class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
              >
                <option v-for="r in RISKS" :key="r" :value="r">{{ blastLabel[r] }}</option>
              </select>
              <span v-if="!e.proof_spec" class="text-halt text-[11px]"
                >without a criterion, this step stays undefined</span
              >
            </div>
          </div>

          <div class="flex items-center gap-3 pt-1">
            <button class="btn" @click="apply(b)">create this plan</button>
            <span class="text-ink-600 text-[11px]"
              >{{ draft[b.id].steps.length }} step(s) · broken down by
              {{ b.harness ?? 'an agent' }}</span
            >
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
