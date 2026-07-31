<script setup lang="ts">
import { computed, ref } from 'vue'
import { haltLabel, harnessLabel } from '../labels'
import type { TreeNode, TreeAttempt } from '../api'

/**
 * The project as a tree, drawn bottom to top.
 *
 * A line per chapter hides the shape of the work: eleven attempts on one step and
 * one on the next look identical on a line. Branching is the point — you should
 * see at a glance where effort piled up and where it kept failing.
 *
 * Three levels: the chapter that was asked for is the root at the top; the steps
 * fan out below it in execution order; each step's attempts hang off it, one twig
 * per try, coloured by what came of it. Connectors are SVG, so a branch is a real
 * line rather than a border pretending to be one.
 */

const props = defineProps<{ nodes: TreeNode[] }>()

/** Which steps show their attempts. A tree that expands everything is a list. */
const opened = ref<Set<number>>(new Set())
function toggle(id: number) {
  const s = new Set(opened.value)
  s.has(id) ? s.delete(id) : s.add(id)
  opened.value = s
}

const roots = computed(() =>
  props.nodes.filter((n) => !n.parent_id).sort((a, b) => a.priority - b.priority || a.id - b.id),
)

function childrenOf(id: number) {
  return props.nodes
    .filter((n) => n.parent_id === id)
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
}

/**
 * Bottom to top: the last step sits closest to the root, so reading upwards
 * follows the order the work was done in.
 */
function climbing(id: number) {
  return [...childrenOf(id)].reverse()
}

const NEEDS_HUMAN = ['blast_radius', 'no_provable_criterion', 'invariant_regression', 'human_request']

function stateOf(o: TreeNode) {
  if (o.status === 'proven') return { word: 'proven', color: 'text-proof', dot: 'bg-proof border-proof' }
  if (o.status === 'blocked') {
    const yours = NEEDS_HUMAN.includes(o.halt_reason ?? '')
    return {
      word: yours ? 'your call' : 'rejected, to redo',
      color: 'text-halt',
      dot: yours ? 'bg-halt border-halt' : 'bg-ink-950 border-halt',
    }
  }
  if (o.status === 'in_progress')
    return o.live_since
      ? { word: 'an agent is on it', color: 'text-run', dot: 'bg-run border-run' }
      : { word: 'started, nobody on it', color: 'text-run', dot: 'bg-ink-950 border-run' }
  if (o.status === 'draft')
    return { word: 'no proof criterion', color: 'text-ink-500', dot: 'bg-ink-950 border-ink-600' }
  return { word: 'ready to take', color: 'text-ink-400', dot: 'bg-ink-950 border-ink-400' }
}

/** An attempt is a twig: what it was worth decides its colour, nothing else. */
function twig(a: TreeAttempt) {
  if (a.prevented) return { word: 'prevented', color: 'text-ink-600', mark: 'bg-ink-700' }
  if (a.verdict === 'advanced') return { word: 'moved it forward', color: 'text-proof', mark: 'bg-proof' }
  if (a.verdict === 'failed') return { word: 'failed', color: 'text-fail', mark: 'bg-fail' }
  if (a.verdict === 'halted') return { word: 'stopped', color: 'text-halt', mark: 'bg-halt' }
  if (!a.ended_at) return { word: 'running', color: 'text-run', mark: 'bg-run animate-pulse' }
  return { word: 'demonstrated nothing', color: 'text-ink-500', mark: 'bg-ink-600' }
}

const won = (o: TreeNode) => o.attempts.filter((a) => a.verdict === 'advanced').length
const lost = (o: TreeNode) => o.attempts.filter((a) => a.verdict !== 'advanced' && a.ended_at).length

function money(v: number | string | null) {
  const n = Number(v ?? 0)
  return n >= 0.01 ? `$${n.toFixed(2)}` : null
}

function when(iso: string) {
  const d = new Date(iso.replace(' ', 'T') + 'Z')
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div v-for="root in roots" :key="root.id" class="card p-5 pb-4">
    <!-- ROOT — what was asked for -->
    <div class="flex gap-3">
      <div class="w-7 flex justify-center shrink-0">
        <span
          class="text-[16px] leading-none"
          :class="root.status === 'proven' ? 'text-proof' : 'text-ink-600'"
          >{{ root.status === 'proven' ? '◆' : '◇' }}</span
        >
      </div>
      <div class="min-w-0 flex-1 -mt-1">
        <RouterLink :to="`/o/${root.id}`" class="text-ink-100 text-[14px] hover:text-run transition-colors">
          {{ root.title }}
        </RouterLink>
        <div class="text-[12px] mt-0.5" :class="stateOf(root).color">
          {{ stateOf(root).word }}
          <span v-if="root.attempts.length" class="text-ink-600">
            · {{ root.attempts.length }} attempt{{ root.attempts.length > 1 ? 's' : '' }} on the
            chapter itself
          </span>
        </div>
      </div>
    </div>

    <!-- BRANCHES — the steps, read upwards -->
    <div v-for="(o, i) in climbing(root.id)" :key="o.id" class="flex gap-3">
      <!-- the connector: a real fork, drawn -->
      <svg class="w-7 shrink-0 self-stretch" preserveAspectRatio="none" viewBox="0 0 28 100">
        <!-- trunk running through, except past the last step -->
        <line
          x1="14"
          y1="0"
          x2="14"
          y2="100"
          :stroke="o.status === 'proven' ? '#3fb950' : o.status === 'blocked' ? '#f0883e' : '#272c38'"
          :stroke-opacity="o.status === 'proven' ? 0.45 : 0.7"
          :stroke-dasharray="o.status === 'proven' || o.status === 'blocked' ? '0' : '3 4'"
          stroke-width="1.5"
          :class="i === climbing(root.id).length - 1 ? 'hidden' : ''"
        />
        <line
          v-if="i === climbing(root.id).length - 1"
          x1="14"
          y1="0"
          x2="14"
          y2="34"
          :stroke="o.status === 'proven' ? '#3fb950' : '#272c38'"
          stroke-opacity="0.45"
          stroke-width="1.5"
        />
        <!-- the arm reaching out to this step -->
        <line x1="14" y1="34" x2="26" y2="34" stroke="#272c38" stroke-width="1.5" />
      </svg>

      <div class="flex-1 min-w-0 py-2.5 border-b border-ink-850 last:border-0">
        <!-- the step itself -->
        <div class="flex items-baseline gap-2.5 flex-wrap">
          <span
            class="w-2.5 h-2.5 rounded-full border-2 shrink-0 self-center"
            :class="stateOf(o).dot"
          />
          <span class="num text-ink-600 text-[11px]">#{{ o.id }}</span>
          <RouterLink
            :to="`/o/${o.id}`"
            class="text-[13px] leading-snug hover:text-run transition-colors"
            :class="o.status === 'proven' ? 'text-ink-400' : 'text-ink-100'"
            >{{ o.title }}</RouterLink
          >
          <span class="text-[11px]" :class="stateOf(o).color">{{ stateOf(o).word }}</span>
          <span v-if="o.halt_reason" class="text-[11px] text-ink-500">
            {{ haltLabel[o.halt_reason] ?? o.halt_reason }}
          </span>
        </div>

        <!-- the tally, and the way into the twigs -->
        <button
          v-if="o.attempts.length"
          class="flex items-baseline gap-3 mt-1.5 text-[11px] hover:text-ink-300 transition-colors"
          @click="toggle(o.id)"
        >
          <span class="text-ink-600">{{ opened.has(o.id) ? '▾' : '▸' }}</span>
          <span class="num" :class="won(o) ? 'text-proof' : 'text-ink-600'">{{ won(o) }} kept</span>
          <span class="num" :class="lost(o) ? 'text-ink-500' : 'text-ink-700'">{{ lost(o) }} spent</span>
          <span v-if="o.artifacts_count" class="num text-ink-600">{{ o.artifacts_count }} files</span>
        </button>

        <!-- TWIGS — one per attempt, successes and failures side by side -->
        <div v-if="opened.has(o.id)" class="mt-2 ml-1 space-y-px">
          <RouterLink
            v-for="a in [...o.attempts].reverse()"
            :key="a.id"
            :to="`/o/${o.id}`"
            class="flex items-baseline gap-2.5 py-1 pl-3 border-l border-ink-800 hover:border-ink-600 transition-colors"
          >
            <span class="w-1.5 h-1.5 rounded-full shrink-0 self-center" :class="twig(a).mark" />
            <span class="num text-ink-700 text-[10px] w-[4.5rem] shrink-0">{{ when(a.started_at) }}</span>
            <span class="text-[11px] w-24 shrink-0" :class="twig(a).color">{{ twig(a).word }}</span>
            <span class="text-[11px] text-ink-600">{{ harnessLabel[a.harness] ?? a.harness }}</span>
            <span v-if="a.files" class="num text-[10px] text-ink-600">{{ a.files }} files</span>
            <span v-if="money(a.cost_usd)" class="num text-[10px] text-ink-600 ml-auto">
              {{ money(a.cost_usd) }}
            </span>
          </RouterLink>
        </div>
      </div>
    </div>

    <!-- the foot -->
    <div class="flex gap-3">
      <div class="w-7 flex justify-center shrink-0">
        <span class="text-ink-700 text-[10px] leading-none">▽</span>
      </div>
      <div class="label text-ink-600 -mt-0.5">start</div>
    </div>
  </div>
</template>
