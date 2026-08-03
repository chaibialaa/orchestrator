<script setup lang="ts">
import { computed, ref } from 'vue'
import { MEASURE, OTHER } from '../viz'

/**
 * One measure across many named rows — the honest form for "which tool, which
 * chapter, how much". Horizontal, because the names are words and a word rotated
 * 45° under a column is a name nobody reads.
 *
 * Every bar is the SAME colour: the rows differ in size, not in kind, and
 * colouring by rank would invent a category that does not exist. The tail row —
 * "12 others" — is grey, because it is not a category either.
 */
const props = withDefaults(
  defineProps<{
    rows: { name: string; n: number; other?: boolean; note?: string; done?: boolean }[]
    /** What one unit is, for the tooltip: "calls", "steps". */
    unit?: string
    /** Printed at the end of each bar. Defaults to the raw count. */
    format?: (n: number) => string
    /** Fill to this instead of the largest row — for percentages. */
    max?: number
    /** Rows already carrying their own reading (a chapter at 7/9). */
    trailing?: (row: { name: string; n: number }) => string
  }>(),
  { unit: '' },
)

const top = computed(() => props.max ?? Math.max(1, ...props.rows.map((r) => r.n)))
const hovered = ref<number | null>(null)
const asTable = ref(false)

/**
 * Zero draws nothing. The floor exists so a small value stays visible, and it
 * was applied to zero as well — fifteen chapters that had never started each
 * drew a bar, which is a chart inventing a quantity nobody measured.
 */
const width = (n: number) => (n <= 0 ? '0%' : `${Math.max(1.5, (n / top.value) * 100)}%`)
const print = (n: number) => (props.format ? props.format(n) : String(n))
</script>

<template>
  <div>
    <!-- The numbers, for anyone the bars do not serve: a screen reader, a print,
         or someone who simply wants the figure rather than its length.
         In the flow, not floated: floated, it sat on top of the first row's
         value — "1.1k" and "as numbers" printed over each other. -->
    <div class="flex justify-end -mt-5 mb-1">
      <button
        class="label text-ink-600 hover:text-ink-300 transition-colors"
        @click="asTable = !asTable"
      >
        {{ asTable ? 'as bars' : 'as numbers' }}
      </button>
    </div>

    <table v-if="asTable" class="w-full text-[12px] mt-1">
      <tbody>
        <tr v-for="r in rows" :key="r.name" class="border-b border-ink-850">
          <td class="py-1 text-ink-300">{{ r.name }}</td>
          <td class="py-1 num text-ink-100 text-right">{{ print(r.n) }}</td>
        </tr>
      </tbody>
    </table>

    <ul v-else class="space-y-2 mt-1">
      <li
        v-for="(r, i) in rows"
        :key="r.name"
        class="relative"
        @mouseenter="hovered = i"
        @mouseleave="hovered = null"
      >
        <div class="flex items-baseline gap-3">
          <span class="text-[12px] flex-1 min-w-0 truncate" :class="r.other ? 'text-ink-500' : 'text-ink-300'">
            {{ r.name }}
          </span>
          <span v-if="trailing" class="num text-[11px] text-ink-600">{{ trailing(r) }}</span>
          <span class="num text-[12px] text-ink-100 tabular-nums">{{ print(r.n) }}</span>
        </div>

        <!-- The track says what the bar is a fraction OF. Without it a short bar
             and a small chart look the same. -->
        <div class="mt-1 h-[6px] rounded-[3px] bg-ink-850 overflow-hidden">
          <div
            class="h-full rounded-[3px] transition-[width] duration-300"
            :style="{
              width: width(r.n),
              background: r.other ? OTHER : r.done ? '#3fb950' : MEASURE,
              opacity: hovered === null || hovered === i ? 1 : 0.55,
            }"
          />
        </div>

        <p v-if="r.note && hovered === i" class="text-ink-500 text-[11px] mt-1">{{ r.note }}</p>
      </li>
    </ul>
  </div>
</template>
