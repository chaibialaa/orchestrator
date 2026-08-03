<script setup lang="ts">
import { computed, ref } from 'vue'
import { CATEGORICAL, dayLabel, money } from '../viz'

/**
 * What the days cost, split by who did the work.
 *
 * Only the days that exist. Filling the gaps with zeros would draw a floor
 * across nights nobody worked and make a week of two sessions look like a week
 * of seven — the chart would be saying something the database never said.
 *
 * Stacked, not two rows of bars: the question is "what did that day cost", and
 * the split is the answer's second half. One axis, never two.
 */
const props = defineProps<{
  days: { day: string; total: number; by: Record<string, number> }[]
  harnesses: string[]
}>()

/** Fixed order, so a harness keeps its colour whatever else is on screen. */
const order = computed(() => [...props.harnesses].sort())
const colour = (h: string) => CATEGORICAL[order.value.indexOf(h)] ?? CATEGORICAL[0]

const top = computed(() => Math.max(1, ...props.days.map((d) => d.total)))
const hovered = ref<string | null>(null)
const asTable = ref(false)

const label: Record<string, string> = { claude: 'Claude', codex: 'Codex', human: 'By hand' }
const named = (h: string) => label[h] ?? h
</script>

<template>
  <div>
    <div class="flex items-baseline gap-4 flex-wrap">
      <!-- Two series, so a legend is not optional. -->
      <span v-for="h in order" :key="h" class="flex items-center gap-1.5 text-[11px] text-ink-400">
        <span class="w-2.5 h-2.5 rounded-[2px]" :style="{ background: colour(h) }" />
        {{ named(h) }}
      </span>
      <button
        class="label text-ink-600 hover:text-ink-300 transition-colors ml-auto"
        @click="asTable = !asTable"
      >
        {{ asTable ? 'as bars' : 'as numbers' }}
      </button>
    </div>

    <table v-if="asTable" class="w-full text-[12px] mt-3">
      <tbody>
        <tr v-for="d in days" :key="d.day" class="border-b border-ink-850">
          <td class="py-1 num text-ink-400">{{ dayLabel(d.day) }}</td>
          <td v-for="h in order" :key="h" class="py-1 num text-ink-300 text-right">
            {{ d.by[h] ? money(d.by[h]) : '—' }}
          </td>
          <td class="py-1 num text-ink-100 text-right">{{ money(d.total) }}</td>
        </tr>
      </tbody>
    </table>

    <div v-else class="mt-4 flex items-end gap-2 h-[132px] overflow-x-auto">
      <div
        v-for="d in days"
        :key="d.day"
        class="flex-1 min-w-[26px] flex flex-col justify-end items-stretch h-full"
        @mouseenter="hovered = d.day"
        @mouseleave="hovered = null"
      >
        <!-- The reading, on the bar it belongs to, only while pointed at: a
             number over every column is noise, a chart with none is a picture. -->
        <div class="text-[10px] num text-center h-[14px]" :class="hovered === d.day ? 'text-ink-200' : 'text-transparent'">
          {{ money(d.total) }}
        </div>
        <div class="flex flex-col justify-end h-full gap-[2px]">
          <div
            v-for="h in order"
            :key="h"
            :style="{
              height: `${((d.by[h] ?? 0) / top) * 100}%`,
              background: colour(h),
              opacity: hovered === null || hovered === d.day ? 1 : 0.5,
            }"
            class="rounded-[3px] first:rounded-b-none last:rounded-t-[4px]"
            :title="`${named(h)} — ${money(d.by[h] ?? 0)}`"
          />
        </div>
        <div class="text-[10px] num text-ink-600 text-center mt-1.5">{{ dayLabel(d.day) }}</div>
      </div>
    </div>
  </div>
</template>
