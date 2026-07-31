<script setup lang="ts">
import { computed } from 'vue'
import type { Objective } from '../api'
import { haltLabel } from '../labels'

/**
 * The chapter as a climb, read bottom to top.
 *
 * Order matters and it is not decoration: `priority` IS execution order, so the
 * track shows what came before what. The spine between two steps carries the
 * state of the one you come FROM — solid where the work flowed, dotted where it
 * has not been travelled yet, broken where it stopped. That is the whole point:
 * you should be able to see where the chain breaks without reading a word.
 *
 * Bottom to top because the chapter gate is a summit: everything below it has to
 * hold for it to open.
 */
const props = defineProps<{
  chapter: Objective | null
  steps: Objective[]
  active?: boolean
}>()

type State = {
  key: 'proven' | 'live' | 'halted' | 'paused' | 'ready' | 'draft'
  word: string
  color: string
  node: string
}

const NEEDS_HUMAN = ['blast_radius', 'no_provable_criterion', 'invariant_regression', 'human_request']

function stateOf(o: Objective): State {
  if (o.status === 'proven')
    return { key: 'proven', word: 'proven', color: 'text-proof', node: 'bg-proof border-proof' }

  if (o.status === 'blocked') {
    const yours = NEEDS_HUMAN.includes(o.halt_reason ?? '')
    return {
      key: 'halted',
      word: yours ? 'your call' : 'rejected, to redo',
      color: 'text-halt',
      node: yours ? 'bg-halt border-halt' : 'bg-ink-950 border-halt',
    }
  }

  if (o.status === 'in_progress')
    return o.live_since
      ? { key: 'live', word: 'an agent is on it', color: 'text-run', node: 'bg-run border-run' }
      : { key: 'paused', word: 'started, nobody on it', color: 'text-run', node: 'bg-ink-950 border-run' }

  if (o.status === 'draft')
    return {
      key: 'draft',
      word: 'no proof criterion',
      color: 'text-ink-500',
      node: 'bg-ink-950 border-ink-600 border-dashed',
    }

  return { key: 'ready', word: 'ready to take', color: 'text-ink-400', node: 'bg-ink-950 border-ink-400' }
}

/** Bottom to top: the gate first in the DOM, then the steps in reverse order. */
const climbing = computed(() => [...props.steps].reverse())

const proven = computed(() => props.steps.filter((s) => s.status === 'proven').length)
const left = computed(() => props.steps.length - proven.value)

/**
 * The one step that matters now. A track where every node looks equally
 * important tells you nothing — this is what the eye should land on.
 */
const resumeAt = computed(
  () =>
    props.steps.find((o) => o.live_since) ??
    props.steps.find((o) => o.status === 'blocked') ??
    props.steps.find((o) => o.status === 'in_progress') ??
    props.steps.find((o) => o.status === 'ready') ??
    props.steps.find((o) => o.status === 'draft') ??
    null,
)

/**
 * The spine segment ABOVE a step carries that step's state: you only travel it
 * once the step below has been proven.
 */
function spineAbove(o: Objective): string {
  if (o.status === 'proven') return 'bg-proof/40'
  if (o.status === 'blocked') return 'bg-halt/50'
  return 'bg-transparent border-l border-dashed border-ink-700'
}

function since(iso: string | null | undefined): string {
  if (!iso) return ''
  const min = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 60000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}
</script>

<template>
  <div :class="active ? '' : 'opacity-60 hover:opacity-100 transition-opacity'">
    <!-- THE SUMMIT: the chapter gate -->
    <div class="flex gap-4">
      <div class="w-6 flex flex-col items-center shrink-0">
        <span
          class="text-[15px] leading-none"
          :class="chapter?.status === 'proven' ? 'text-proof' : left ? 'text-ink-600' : 'text-halt'"
          >{{ chapter?.status === 'proven' ? '◆' : '◇' }}</span
        >
      </div>
      <div class="pb-6 -mt-1 min-w-0">
        <RouterLink
          v-if="chapter"
          :to="`/o/${chapter.id}`"
          class="text-ink-100 text-[14px] hover:text-run transition-colors"
        >
          {{ chapter.title }}
        </RouterLink>
        <span v-else class="text-ink-300 text-[14px]">Outside any chapter</span>
        <div
          class="text-[12px] mt-0.5"
          :class="chapter?.status === 'proven' ? 'text-proof' : left ? 'text-ink-500' : 'text-halt'"
        >
          {{
            chapter?.status === 'proven'
              ? 'gate passed'
              : left
                ? `${left} step${left > 1 ? 's' : ''} below it are not proven`
                : 'every step is proven — the gate is what remains'
          }}
        </div>
      </div>
    </div>

    <!-- THE CLIMB, read from the bottom up -->
    <div
      v-for="o in climbing"
      :key="o.id"
      class="flex gap-4 group"
    >
      <!-- the spine and its node -->
      <div class="w-6 flex flex-col items-center shrink-0">
        <span class="w-px flex-1 min-h-[1.25rem]" :class="spineAbove(o)" />
        <RouterLink
          :to="`/o/${o.id}`"
          class="w-3 h-3 rounded-full border-2 shrink-0 transition-transform group-hover:scale-125"
          :class="[stateOf(o).node, stateOf(o).key === 'live' ? 'animate-pulse' : '']"
          :title="stateOf(o).word"
        />
        <!-- No spine below the last node: the climb has a foot. Reading the last
             element without guarding it would throw on a chapter with no steps. -->
        <span
          v-if="o.id !== climbing.at(-1)?.id"
          class="w-px flex-1 min-h-[1.25rem]"
          :class="spineAbove(o)"
        />
      </div>

      <!-- what the step is, and where it stands -->
      <RouterLink
        :to="`/o/${o.id}`"
        class="flex-1 min-w-0 py-2.5 border-b border-ink-850 group-last:border-0"
        :class="resumeAt?.id === o.id ? '' : ''"
      >
        <div class="flex items-baseline gap-2.5 flex-wrap">
          <span class="text-ink-600 text-[11px] tabular-nums">#{{ o.id }}</span>
          <span
            class="text-[13px] leading-snug group-hover:text-run transition-colors"
            :class="o.status === 'proven' ? 'text-ink-400' : 'text-ink-100'"
            >{{ o.title }}</span
          >
          <span
            v-if="resumeAt?.id === o.id"
            class="text-[10px] uppercase tracking-widest text-run border border-run/40 rounded px-1.5 py-px"
            >here</span
          >
        </div>

        <div class="flex items-baseline gap-3 mt-1 text-[11px] flex-wrap">
          <span :class="stateOf(o).color">
            {{ stateOf(o).word
            }}<template v-if="o.live_since"> · {{ since(o.live_since) }}</template>
          </span>
          <span v-if="o.status === 'blocked' && o.halt_reason" class="text-ink-500">
            {{ haltLabel[o.halt_reason] ?? o.halt_reason }}
          </span>
          <span v-if="o.evidences_count" class="text-ink-600">
            {{ o.evidences_count }} proof{{ o.evidences_count > 1 ? 's' : '' }}
          </span>
          <span v-if="o.artifacts_count" class="text-ink-600 group-hover:text-run transition-colors">
            {{ o.artifacts_count }} file{{ o.artifacts_count > 1 ? 's' : '' }} ▸
          </span>
        </div>
      </RouterLink>
    </div>

    <!-- the foot of the climb -->
    <div class="flex gap-4">
      <div class="w-6 flex justify-center shrink-0">
        <span class="text-ink-700 text-[10px] leading-none">▽</span>
      </div>
      <div class="label text-ink-600 -mt-0.5">start</div>
    </div>
  </div>
</template>
