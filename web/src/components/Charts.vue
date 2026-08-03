<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { api, type Charts } from '../api'
import BarList from './BarList.vue'
import SpendByDay from './SpendByDay.vue'
import { compact, money } from '../viz'

/**
 * Where the effort actually went.
 *
 * The screens said "116 attempts, $2087, 2.3 M tokens" — how much, never where.
 * Which tool the money went through, which day it burned, how far each chapter
 * really is, and how many proofs a command settled rather than a session's own
 * account of itself. All of it was already in the database.
 */
const props = defineProps<{ project?: string }>()

const data = ref<Charts | null>(null)
const failed = ref(false)

async function load() {
  try {
    data.value = await api.charts(props.project)
    failed.value = false
  } catch {
    failed.value = true
  }
}
onMounted(load)
watch(() => props.project, load)

/**
 * Only the chapters somebody has touched.
 *
 * Blockrise has seventeen and fourteen of them have never been started: listing
 * them drew fourteen empty rows above the three that carry the whole project.
 * A chart whose bulk is "nothing happened here" hides the part that did.
 */
const started = computed(() =>
  (data.value?.chapters ?? []).filter((c) => c.attempts > 0 || c.pct > 0),
)
const untouched = computed(() => (data.value?.chapters ?? []).length - started.value.length)

const chapters = computed(() =>
  started.value.map((c) => ({
    name: c.title,
    n: c.pct,
    done: c.pct === 100,
    note: `${c.attempts} attempt${c.attempts === 1 ? '' : 's'} · ${money(Number(c.cost_usd))}`,
    steps: c.steps,
    stepsDone: c.done,
  })),
)

/**
 * The ratio the whole tool exists to move.
 *
 * A proof settled by a command and a session's account of its own work are not
 * the same object, and every screen counted them in one number.
 */
const proof = computed(() => {
  const p = data.value?.proof
  if (!p) return null
  const total = (p.measured ?? 0) + (p.accepted ?? 0) + (p.failing ?? 0) + (p.inconclusive ?? 0)
  return total ? { ...p, total } : null
})
</script>

<template>
  <section v-if="data" class="space-y-6">
    <h2 class="label">Where the effort goes</h2>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      <!-- WHICH TOOLS -->
      <div class="card p-5">
        <div class="flex items-baseline gap-3">
          <h3 class="text-ink-100 text-[13px]">Tools the work went through</h3>
          <span class="label text-ink-600">calls</span>
        </div>
        <!-- Said out loud rather than left for the reader to assume: tool use was
             not recorded from the first day, so this counts the passes that have
             it, not all of them. -->
        <p class="text-ink-500 text-[11px] mt-1">
          from {{ data.tools_from.passages }} of {{ data.tools_from.of }} attempts — the earlier ones
          recorded no tool use
        </p>
        <BarList v-if="data.tools.length" class="mt-4" :rows="data.tools" :format="compact" />
        <p v-else class="text-ink-600 text-[12px] mt-3">Nothing recorded yet.</p>
      </div>

      <!-- WHAT THE DAYS COST -->
      <div class="card p-5">
        <div class="flex items-baseline gap-3">
          <h3 class="text-ink-100 text-[13px]">What each day cost</h3>
          <span class="label text-ink-600">days worked, not calendar days</span>
        </div>
        <!-- What the figure IS. "Spent" reads as an invoice, and it is not one:
             the harnesses run on subscriptions, so this is what the same work
             would cost at published API rates. It is the right number for
             comparing chapters and for a budget guard, and the wrong one to
             expect on a statement. -->
        <p class="text-ink-500 text-[11px] mt-1 leading-relaxed">
          Measured in tokens, valued at published rates — what this work would cost through the
          APIs. The judging conversation is not in it: it runs in a browser on a flat
          subscription, and costs nothing per turn.
        </p>
        <SpendByDay
          v-if="data.spend.length"
          class="mt-3"
          :days="data.spend"
          :harnesses="data.harnesses"
        />
        <p v-else class="text-ink-600 text-[12px] mt-3">Nothing spent yet.</p>

        <!-- The gap in the total, next to the total. A chart that adds up costs
             and says nothing about the attempts nobody priced reports a figure as
             if it were the figure. -->
        <p v-if="data.unpriced?.length" class="text-halt text-[11px] mt-3 leading-relaxed">
          Not in this total:
          <span v-for="(u, i) in data.unpriced" :key="u.harness">
            <span v-if="i">, </span>{{ u.n }} {{ u.harness }} attempt{{ u.n > 1 ? 's' : '' }} and
            {{ (u.tokens / 1e6).toFixed(1) }} M tokens that nothing prices</span
          >. Declare the rates in <span class="num">.orchestrator.json → codexPricing</span>.
        </p>
      </div>

      <!-- HOW FAR EACH CHAPTER IS -->
      <div v-if="chapters.length" class="card p-5">
        <div class="flex items-baseline gap-3">
          <h3 class="text-ink-100 text-[13px]">How far each chapter is</h3>
          <span class="label text-ink-600">steps proven, out of its steps</span>
        </div>
        <BarList
          class="mt-4"
          :rows="chapters"
          :max="100"
          :format="(n) => `${n}%`"
          :trailing="(r: any) => (r.steps ? `${r.stepsDone}/${r.steps}` : 'no steps')"
        />
        <!-- Said, not drawn. Fourteen empty bars are not information. -->
        <p v-if="untouched" class="text-ink-600 text-[11px] mt-3">
          {{ untouched }} more chapter{{ untouched === 1 ? '' : 's' }} planned, never started
        </p>
      </div>

      <!-- WHAT SETTLED THE PROOFS -->
      <div v-if="proof" class="card p-5">
        <div class="flex items-baseline gap-3">
          <h3 class="text-ink-100 text-[13px]">What settled the proofs</h3>
          <span class="label text-ink-600">{{ proof.total }} pieces of evidence</span>
        </div>
        <p class="text-ink-500 text-[11px] mt-1">
          A command that returns pass or fail, and a session's account of its own work, are not the
          same object — and every screen counted them in one number.
        </p>
        <BarList
          class="mt-4"
          :rows="[
            { name: 'settled by a command', n: proof.measured ?? 0, done: true },
            { name: 'accepted by a judge', n: proof.accepted ?? 0 },
            { name: 'came back failing', n: proof.failing ?? 0 },
            { name: 'settled nothing', n: proof.inconclusive ?? 0, other: true },
          ]"
          :format="compact"
        />
      </div>
    </div>

    <p v-if="failed" class="text-ink-600 text-[11px]">
      The figures could not be refreshed — what you see may be stale.
    </p>
  </section>
</template>
