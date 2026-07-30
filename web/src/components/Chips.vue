<script setup lang="ts">
import { computed } from 'vue'
import {
  statusLabel,
  statusHelp,
  blastLabel,
  blastHelp,
  harnessLabel,
  verdictLabel,
  haltLabel,
  haltHelp,
  evidenceLabel,
} from '../labels'

const props = defineProps<{
  kind: 'status' | 'blast' | 'harness' | 'verdict' | 'evidence' | 'halt'
  value: string
}>()

const styles: Record<string, string> = {
  draft: 'border-ink-600 text-ink-400',
  ready: 'border-run/40 text-run',
  in_progress: 'border-run text-run bg-run/10',
  blocked: 'border-halt text-halt bg-halt/10',
  proven: 'border-proof text-proof bg-proof/10',
  abandoned: 'border-ink-700 text-ink-600 line-through',

  cosmetic: 'border-ink-600 text-ink-400',
  feature: 'border-run/40 text-run',
  api: 'border-halt/60 text-halt',
  critical: 'border-fail text-fail bg-fail/10',

  claude: 'border-ink-600 text-[#d4a373]',
  codex: 'border-ink-600 text-[#8fd0c0]',
  gpt: 'border-ink-600 text-[#9fb4ff]',
  human: 'border-ink-600 text-ink-300',

  advanced: 'border-proof/50 text-proof',
  no_progress: 'border-ink-600 text-ink-400',
  halted: 'border-halt/60 text-halt',
  failed: 'border-fail/60 text-fail',
  pass: 'border-proof/50 text-proof',
  fail: 'border-fail/60 text-fail',
  inconclusive: 'border-ink-600 text-ink-400',
}

const dictionaries: Record<string, Record<string, string>> = {
  status: statusLabel,
  blast: blastLabel,
  harness: harnessLabel,
  verdict: verdictLabel,
  halt: haltLabel,
  evidence: evidenceLabel,
}

const helps: Record<string, Record<string, string>> = {
  status: statusHelp,
  blast: blastHelp,
  halt: haltHelp,
}

const text = computed(() => dictionaries[props.kind]?.[props.value] ?? props.value)
const title = computed(() => helps[props.kind]?.[props.value] ?? '')
</script>

<template>
  <span
    class="chip"
    :class="[styles[value] ?? 'border-ink-600 text-ink-400', title ? 'cursor-help' : '']"
    :title="title"
  >
    {{ text }}
  </span>
</template>
