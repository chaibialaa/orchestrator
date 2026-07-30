<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Objective } from '../api'
import { haltLabel, harnessLabel } from '../labels'

const props = defineProps<{
  chapter: Objective | null
  steps: Objective[]
  chain?: 'active' | 'dormant' | 'closed'
  activity?: string
}>()

const isActive = computed(() => (props.chain ?? 'active') === 'active')
const expanded = ref(false)
const visible = computed(() => isActive.value || expanded.value)

/** How long nothing has moved on this chain. */
const idleFor = computed(() => {
  if (!props.activity) return 'never started'
  const d = Math.floor((Date.now() - new Date(props.activity + 'Z').getTime()) / 86400000)
  if (d >= 1) return `nothing for ${d} day${d > 1 ? 's' : ''}`
  const h = Math.floor((Date.now() - new Date(props.activity + 'Z').getTime()) / 3600000)
  return h >= 1 ? `nothing for ${h} h` : 'idle'
})

const chainBadge = computed(() =>
  props.chain === 'closed'
    ? { label: 'chain finished', color: 'text-proof' }
    : props.chain === 'dormant'
      ? { label: `dormant — ${idleFor.value}`, color: 'text-ink-500' }
      : { label: 'chain the loop is following', color: 'text-run' },
)

type State = {
  key: string
  label: string
  color: string
  border: string
  fill: string
  pulses: boolean
}

function since(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 60000))
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
}

/** A step's state, in one word and one colour. */
function state(o: Objective): State {
  if (o.status === 'proven')
    return {
      key: 'proven', label: 'proven',
      color: 'text-proof', border: 'border-proof', fill: 'bg-proof', pulses: false,
    }

  if (o.status === 'blocked') {
    const needsHuman = ['blast_radius', 'no_provable_criterion', 'invariant_regression', 'human_request']
    const yours = needsHuman.includes(o.halt_reason ?? '')
    return {
      key: 'blocked',
      label: yours ? 'your call' : 'rejected, to redo',
      color: 'text-halt',
      border: 'border-halt',
      fill: yours ? 'bg-halt' : 'bg-transparent',
      pulses: false,
    }
  }

  if (o.status === 'in_progress')
    return o.live_since
      ? {
          key: 'live', label: `agent · ${since(o.live_since)}`,
          color: 'text-run', border: 'border-run', fill: 'bg-run', pulses: true,
        }
      : {
          key: 'paused', label: 'started, paused',
          color: 'text-run', border: 'border-run', fill: 'bg-transparent', pulses: false,
        }

  if (o.status === 'draft')
    return {
      key: 'draft', label: 'needs a criterion',
      color: 'text-ink-500', border: 'border-ink-600', fill: 'bg-transparent', pulses: false,
    }

  return {
    key: 'ready', label: 'ready to take',
    color: 'text-ink-400', border: 'border-ink-400', fill: 'bg-transparent', pulses: false,
  }
}

/** Who actually worked on this step. */
function harnesses(o: Objective): string[] {
  return (o.harnesses ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => harnessLabel[h] ?? h)
}

const provenCount = computed(() => props.steps.filter((s) => s.status === 'proven').length)

/** The one step a human or an agent should land on now. */
const resumeFrom = computed(() => {
  const s = props.steps
  return (
    s.find((o) => o.live_since) ??
    s.find((o) => o.status === 'blocked') ??
    s.find((o) => o.status === 'in_progress') ??
    s.find((o) => o.status === 'ready') ??
    s.find((o) => o.status === 'draft') ??
    null
  )
})

const resumeText = computed(() => {
  const o = resumeFrom.value
  if (!o) return null
  const e = state(o)
  if (e.key === 'live') return `#${o.id} ${o.title} — an agent has been on it for ${since(o.live_since!)}`
  if (e.key === 'blocked')
    return `#${o.id} ${o.title} — ${haltLabel[o.halt_reason ?? ''] ?? 'halted'}`
  if (e.key === 'paused') return `#${o.id} ${o.title} — started then left, nobody on it`
  if (e.key === 'draft') return `#${o.id} ${o.title} — its proof criterion is missing`
  return `#${o.id} ${o.title} — ready, no agent has taken it`
})

/** What the chapter still needs in order to close, said plainly. */
const gateLabel = computed(() => {
  if (!props.chapter) return null
  if (props.chapter.status === 'proven') return { label: 'passed', color: 'text-proof' }
  const left = props.steps.length - provenCount.value
  return {
    label: left > 0 ? `${left} step${left > 1 ? 's' : ''} before the gate` : 'every step is proven',
    color: left > 0 ? 'text-ink-500' : 'text-halt',
  }
})
</script>

<template>
  <section class="card p-5" :class="isActive ? '' : 'opacity-70 hover:opacity-100 transition-opacity'">
    <header class="flex items-baseline gap-3 flex-wrap" :class="visible ? 'mb-6' : ''">
      <RouterLink
        v-if="chapter"
        :to="`/o/${chapter.id}`"
        class="text-ink-100 hover:text-run transition-colors"
      >
        {{ chapter.title }}
      </RouterLink>
      <span v-else class="text-ink-300">Outside any chapter</span>
      <span class="label" :class="chainBadge.color">{{ chainBadge.label }}</span>
      <span class="label ml-auto">
        <span class="text-proof">{{ provenCount }}</span
        ><span class="text-ink-600">/{{ steps.length }} proven</span>
      </span>
      <button v-if="!isActive" class="label hover:text-ink-300 transition-colors" @click="expanded = !expanded">
        {{ expanded ? '▾ collapse' : '▸ show the track' }}
      </button>
    </header>

    <!-- The track: read left to right, in execution order. -->
    <ol v-if="visible" class="flex items-start overflow-x-auto pb-1 -mx-1">
      <li
        v-for="(o, i) in steps"
        :key="o.id"
        class="flex items-start shrink-0 w-[11.5rem]"
      >
        <div class="w-full pr-3">
        <RouterLink :to="`/o/${o.id}`" class="group block">
          <span class="flex items-center h-3">
            <span
              class="w-2.5 h-2.5 rounded-full shrink-0 border"
              :class="[state(o).border, state(o).fill, state(o).pulses ? 'animate-pulse' : '']"
            />
            <span
              v-if="i < steps.length - 1 || chapter"
              class="flex-1 h-px"
              :class="o.status === 'proven' ? 'bg-proof/50' : 'bg-ink-700'"
              :style="o.status === 'proven' ? '' : 'background-image:repeating-linear-gradient(90deg,#272c38 0 3px,transparent 3px 6px);background-color:transparent'"
            />
          </span>
          <div class="mt-2.5">
            <div class="text-ink-600 text-[11px]">#{{ o.id }}</div>
            <div
              class="text-[12px] leading-snug mt-0.5 group-hover:text-run transition-colors line-clamp-2"
              :class="o.status === 'proven' ? 'text-ink-400' : 'text-ink-100'"
              :title="o.title"
            >
              {{ o.title }}
            </div>
            <div class="text-[11px] mt-1" :class="state(o).color">{{ state(o).label }}</div>
          </div>
        </RouterLink>

        <div v-if="harnesses(o).length || o.artifacts_count" class="mt-1.5 flex items-baseline gap-2 flex-wrap">
          <span
            v-for="h in harnesses(o)"
            :key="h"
            class="text-[10px] text-ink-500 border border-ink-700 rounded px-1 py-px"
            :title="`work done by ${h}`"
            >{{ h }}</span
          >
          <RouterLink
            v-if="o.artifacts_count"
            :to="`/o/${o.id}#proofs`"
            class="text-[10px] text-ink-500 hover:text-run underline decoration-ink-700 underline-offset-2 transition-colors"
            :title="'see the files produced and the proofs'"
            >{{ o.artifacts_count }} file{{ o.artifacts_count > 1 ? 's' : '' }}</RouterLink
          >
        </div>
        </div>
      </li>

      <!-- Terminus: the chapter gate. -->
      <li v-if="chapter" class="flex items-start shrink-0 w-[11.5rem]">
        <div class="w-full pr-3">
          <span class="flex items-center h-3">
            <span
              class="text-[13px] leading-none -mt-0.5"
              :class="chapter.status === 'proven' ? 'text-proof' : 'text-ink-600'"
              >{{ chapter.status === 'proven' ? '◆' : '◇' }}</span
            >
          </span>
          <div class="mt-2.5">
            <div class="text-ink-600 text-[11px]">gate</div>
            <div class="text-[12px] leading-snug mt-0.5 text-ink-300">Close the chapter</div>
            <div class="text-[11px] mt-1" :class="gateLabel?.color">{{ gateLabel?.label }}</div>
          </div>
        </div>
      </li>
    </ol>

    <RouterLink
      v-if="resumeFrom && isActive"
      :to="`/o/${resumeFrom.id}`"
      class="mt-5 pt-3.5 border-t border-ink-800 flex items-baseline gap-2 group"
    >
      <span class="label shrink-0">resume here</span>
      <span class="text-[13px] text-ink-300 group-hover:text-run transition-colors">{{
        resumeText
      }}</span>
    </RouterLink>
  </section>
</template>
