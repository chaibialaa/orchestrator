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
  <div v-for="root in roots" :key="root.id" class="card px-5 py-4">
    <!-- ROOT — what was asked for -->
    <div class="relative pl-7">
      <span
        v-if="climbing(root.id).length"
        class="absolute left-[7px] top-[0.9rem] bottom-0 w-px"
        :class="root.status === 'proven' ? 'bg-proof/40' : 'bg-ink-700'"
      />
      <span
        class="absolute left-0 top-[0.35rem] text-[13px] leading-none"
        :class="root.status === 'proven' ? 'text-proof' : 'text-ink-500'"
        >{{ root.status === 'proven' ? '\u25C6' : '\u25C7' }}</span
      >

      <RouterLink :to="`/o/${root.id}`" class="text-ink-100 text-[14px] hover:text-run transition-colors">
        {{ root.title }}
      </RouterLink>
      <div class="text-[12px] mt-0.5 pb-3" :class="stateOf(root).color">
        {{ stateOf(root).word }}
        <span v-if="root.attempts.length" class="text-ink-500">
          · {{ root.attempts.length }} attempt{{ root.attempts.length > 1 ? 's' : '' }} on the chapter
          itself
        </span>
      </div>
    </div>

    <!-- BRANCHES — the steps, read upwards -->
    <div v-for="(o, i) in climbing(root.id)" :key="o.id" class="relative pl-7">
      <!-- Connectors in CSS, not SVG: an <svg> with no height attribute takes the
           format default of 150px, which forced every row of the tree that tall.
           A border follows its content. -->
      <span
        class="absolute left-[7px] top-0 w-px"
        :class="[
          i === climbing(root.id).length - 1 ? 'h-[0.85rem]' : 'bottom-0',
          o.status === 'proven' ? 'bg-proof/40' : o.status === 'blocked' ? 'bg-halt/50' : 'bg-ink-700',
        ]"
      />
      <span class="absolute left-[7px] top-[0.85rem] w-3 h-px bg-ink-700" />

      <div class="py-1.5">
        <!-- the step -->
        <div class="flex items-baseline gap-2 flex-wrap">
          <span
            class="w-2 h-2 rounded-full border-[1.5px] shrink-0 self-center -ml-[1.35rem] mr-[0.6rem] bg-ink-950"
            :class="stateOf(o).dot"
          />
          <span class="num text-ink-600 text-[11px]">#{{ o.id }}</span>
          <RouterLink
            :to="`/o/${o.id}`"
            class="text-[13px] hover:text-run transition-colors"
            :class="o.status === 'proven' ? 'text-ink-300' : 'text-ink-100'"
            >{{ o.title }}</RouterLink
          >
          <span class="text-[11px]" :class="stateOf(o).color">{{ stateOf(o).word }}</span>
          <span v-if="o.halt_reason" class="text-[11px] text-ink-400">
            {{ haltLabel[o.halt_reason] ?? o.halt_reason }}
          </span>
        </div>

        <!-- the tally, and the way into the twigs -->
        <button
          v-if="o.attempts.length"
          class="flex items-baseline gap-2.5 mt-1 text-[11px] group"
          @click="toggle(o.id)"
        >
          <span class="text-ink-500 group-hover:text-ink-300">{{ opened.has(o.id) ? '\u25BE' : '\u25B8' }}</span>
          <span class="num" :class="won(o) ? 'text-proof' : 'text-ink-500'">{{ won(o) }} kept</span>
          <span class="num text-ink-500">{{ lost(o) }} spent</span>
          <span v-if="o.artifacts_count" class="num text-ink-500">{{ o.artifacts_count }} files</span>
        </button>

        <!-- TWIGS — one per attempt, successes and failures side by side -->
        <div v-if="opened.has(o.id)" class="mt-1.5 border-l border-ink-800 pl-3 space-y-0.5">
          <RouterLink
            v-for="a in [...o.attempts].reverse()"
            :key="a.id"
            :to="`/o/${o.id}`"
            class="flex items-center gap-2.5 py-0.5 hover:bg-ink-850/50 rounded-sm -ml-1 pl-1 transition-colors"
          >
            <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="twig(a).mark" />
            <span class="num text-ink-600 text-[10px] w-[4.5rem] shrink-0">{{ when(a.started_at) }}</span>
            <span class="text-[11px] w-[9rem] shrink-0 whitespace-nowrap" :class="twig(a).color">
              {{ twig(a).word }}
            </span>
            <span class="text-[11px] text-ink-500 w-14 shrink-0">
              {{ harnessLabel[a.harness] ?? a.harness }}
            </span>
            <span v-if="a.files" class="num text-[10px] text-ink-500">{{ a.files }} files</span>
            <span v-if="money(a.cost_usd)" class="num text-[10px] text-ink-500 ml-auto">
              {{ money(a.cost_usd) }}
            </span>
          </RouterLink>
        </div>
      </div>
    </div>

    <!-- the foot -->
    <div class="relative pl-7 pt-1">
      <span class="absolute left-[3px] top-1 text-ink-700 text-[9px] leading-none">▽</span>
      <span class="label text-ink-600">start</span>
    </div>
  </div>
</template>
