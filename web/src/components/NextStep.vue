<script setup lang="ts">
import { computed } from 'vue'
import { type NextStep } from '../api'

/**
 * One thing to do next, above everything else on the page.
 *
 * This screen answered four questions well — what is in the way, what waits on
 * you, how far each chapter is, where the money went — and the first one badly:
 * what do I do now. All four were true and none said which to act on first, so
 * the reader ranked them by hand every time. Ranking them is a judgement the
 * tool already makes, so it makes it here.
 */
const props = defineProps<{ step: NextStep | null }>()
const step = computed(() => props.step)

/**
 * The colour says what kind of thing it is, and the three kinds are genuinely
 * different: something is broken, something needs your judgement, or there is
 * simply work to start.
 */
const tone: Record<string, { edge: string; ink: string; word: string }> = {
  unblock: { edge: 'border-fail/40 bg-fail/[0.04]', ink: 'text-fail', word: 'Clear this first' },
  no_criterion: { edge: 'border-halt/40 bg-halt/[0.04]', ink: 'text-halt', word: 'Nothing can take this' },
  stuck: { edge: 'border-halt/40 bg-halt/[0.04]', ink: 'text-halt', word: 'At a standstill' },
  run: { edge: 'border-run/40 bg-run/[0.04]', ink: 'text-run', word: 'Next to run' },
  done: { edge: 'border-proof/40 bg-proof/[0.04]', ink: 'text-proof', word: 'Nothing left' },
}
const DECIDE = { edge: 'border-halt/40 bg-halt/[0.04]', ink: 'text-halt', word: 'Waiting on you' }
const toneOf = (k: string) => tone[k] ?? DECIDE
</script>

<template>
  <RouterLink
    v-if="step"
    :to="step.href"
    class="block border rounded p-5 transition-colors hover:border-ink-600"
    :class="toneOf(step.kind).edge"
  >
    <div class="flex items-baseline gap-3 flex-wrap">
      <span class="label" :class="toneOf(step.kind).ink">{{ toneOf(step.kind).word }}</span>
      <span class="text-ink-100 text-[15px] flex-1 min-w-[14rem]">{{ step.headline }}</span>
      <span v-if="step.objective" class="num text-ink-600 text-[11px]">#{{ step.objective }}</span>
    </div>
    <p class="text-ink-400 mt-2 leading-relaxed max-w-[80ch]">{{ step.why }}</p>
    <p class="text-ink-200 mt-1.5 text-[12px] max-w-[80ch]">→ {{ step.action }}</p>
  </RouterLink>
</template>
