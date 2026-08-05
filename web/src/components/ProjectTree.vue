<script setup lang="ts">
import ChapterClosure from './ChapterClosure.vue'
import AddObjective from './AddObjective.vue'
import { computed, ref } from 'vue'
import { haltLabel, harnessLabel } from '../labels'
import { api, type TreeNode, type TreeAttempt } from '../api'
import RunControl from './RunControl.vue'

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

/**
 * `stalled` maps an objective to the condition holding it up, in three words.
 *
 * The track showed a chapter "in progress" with no attempt running and no
 * explanation — the explanation being a closed editor, stated on a different
 * page. A step nothing can run on should say so on its own line.
 */
const props = defineProps<{ nodes: TreeNode[]; slug: string; stalled?: Record<number, string> }>()
const emit = defineEmits<{ changed: [] }>()

/** Where the next one goes, so a new step lands after the existing ones. */
const nextPriority = (id: number) => (climbing(id).length + 1) * 10

/**
 * Set aside, never delete.
 *
 * The plan page has done this for a while and this one had no way to undo a
 * mistake — you could add a step and then only reach for the database. Nothing
 * is destroyed: what it proved stays, it simply stops being counted and nothing
 * runs on it.
 */
const setting = ref<number | null>(null)
async function setAside(id: number) {
  setting.value = id
  try {
    await api.updateObjective(id, { status: 'abandoned' })
    emit('changed')
  } finally {
    setting.value = null
  }
}

/** Which chapter's before-and-after is open, if any. */
const showing = ref<number | null>(null)

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

/**
 * Its place in the order, said out loud.
 *
 * The track flows in two balanced COLUMNS, so chapter 3 sits opposite chapter 0
 * and the sequence is read down the left then down the right. The order is the
 * plan — it decides what runs next — and the layout was the only thing carrying
 * it. A rank costs one number and survives any arrangement of the page.
 */
const rankOf = computed(() => {
  const m = new Map<number, number>()
  roots.value.forEach((r, i) => m.set(r.id, i + 1))
  return m
})

/**
 * The whole chapter, not just its heading.
 *
 * A chapter can read `proven` while a step under it is still open — the gate
 * refuses to conclude one whose parts are unfinished, but nothing stops a
 * chapter proven before a step was added afterwards. The tint answers "is there
 * anything left in here", so it asks the same of every level.
 */
function allDone(root: TreeNode) {
  if (root.status !== 'proven') return false
  return childrenOf(root.id).every((c) => c.status === 'proven' || c.status === 'abandoned')
}

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

/**
 * A chapter nobody has touched yet.
 *
 * Untouched is the overwhelming majority — fifteen of twenty-six here — and each
 * one was drawing a full card, a hundred and twenty pixels tall, to say that
 * nothing had happened. The chapter that was one item from closing, five
 * attempts and $312 in, looked exactly the same as the one nobody had opened.
 * Same card, same button, same weight.
 */
function untouched(root: TreeNode) {
  return (
    root.status === 'ready' &&
    !root.attempts.length &&
    !childrenOf(root.id).some((c) => c.attempts.length || c.status !== 'ready')
  )
}

/** Where the work actually is: running first, then stuck, then merely started. */
const RANK: Record<string, number> = { in_progress: 0, blocked: 1 }

const live = computed(() =>
  props.nodes
    .filter((n) => !n.parent_id && n.status in RANK)
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.priority - b.priority),
)

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
  <!-- Chapters side by side. Each is an independent block, and one per line meant
       a card 1456px wide carrying text that ends a third of the way across —
       every row asking the eye to travel past a screen of nothing. The tree
       inside a card is unaffected: it reads top to bottom either way.

       CSS columns rather than a grid: a grid aligns rows, so a short chapter
       beside a long one leaves a hole the height of the difference. Columns pack.
       The order becomes down-then-across, which is what a column of chapters
       reads like anyway. -->
  <!-- Where the work is, before the plan of where it goes. The track below is in
       execution order, which answers "what comes next" and not "what is moving
       right now" — and the second question is the one you open this screen
       with. Absent when nothing is moving: an empty band is furniture. -->
  <section v-if="live.length" class="mb-5">
    <div class="label mb-2">Moving now — {{ live.length }}</div>
    <div class="card divide-y divide-ink-800 border-run/30">
      <RouterLink
        v-for="o in live"
        :key="o.id"
        :to="`/o/${o.id}`"
        class="px-4 py-2.5 flex items-baseline gap-3 hover:bg-ink-850/40 transition-colors"
      >
        <span
          class="w-1.5 h-1.5 rounded-full shrink-0 self-center"
          :class="[stateOf(o).dot, o.live_since ? 'animate-pulse' : '']"
        />
        <span class="text-ink-100 text-[13px] flex-1 min-w-0 truncate">{{ o.title }}</span>
        <!-- This band answers "what is moving right now", so it is the first place
             that owes an answer when the honest one is "nothing, and here is why".
             It said "started, nobody on it" and stopped there. -->
        <span v-if="stalled?.[o.id]" class="chip border-fail/50 text-fail shrink-0">
          {{ stalled[o.id] }}
        </span>
        <span class="text-[12px] shrink-0" :class="stateOf(o).color">{{ stateOf(o).word }}</span>
        <span v-if="o.attempts.length" class="num text-ink-600 text-[11px] shrink-0">
          {{ o.attempts.length }} attempt{{ o.attempts.length > 1 ? 's' : '' }}
        </span>
      </RouterLink>
    </div>
  </section>

  <div class="xl:columns-2 gap-4 [column-fill:balance]">
  <template v-for="root in roots" :key="root.id">
  <!-- Untouched keeps its PLACE in the track — the order is the plan — at the
       height of what it actually has to say. Filtering the quiet ones into their
       own pass grouped them all into one column, and the track stopped reading
       in order. -->
  <RouterLink
    v-if="untouched(root)"
    :to="`/o/${root.id}`"
    class="card px-5 py-2.5 mb-2 break-inside-avoid flex items-baseline gap-3 hover:border-ink-600 transition-colors"
  >
    <span class="text-ink-700 text-[13px] leading-none">&#9671;</span>
    <span class="text-ink-400 text-[13px] flex-1 min-w-0 truncate">{{ root.title }}</span>
    <span v-if="stalled?.[root.id]" class="chip border-fail/50 text-fail shrink-0">
      {{ stalled[root.id] }}
    </span>
    <span class="label text-ink-700 shrink-0">not started</span>
  </RouterLink>

  <!-- A finished chapter reads as finished from across the room.
       The track carries nineteen cards of identical weight, and telling the done
       ones from the rest meant reading a word inside each. The tint is very
       light on purpose: it groups without shouting, and the word stays. -->
  <div
    v-else
    class="card px-5 py-4 mb-4 break-inside-avoid"
    :class="allDone(root) ? 'border-proof/25 bg-proof/[0.035]' : ''"
  >
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

      <span class="num text-[11px] text-ink-600 shrink-0 mr-2" title="its place in the running order">
        {{ rankOf.get(root.id) }}<span class="text-ink-700">/{{ roots.length }}</span>
      </span>
      <RouterLink :to="`/o/${root.id}`" class="text-ink-100 text-[14px] hover:text-run transition-colors">
        {{ root.title }}
      </RouterLink>
      <!-- Where a finished chapter earns a second look: what it was, what it
           became, and which proof actually settled it. -->
      <button
        v-if="root.status === 'proven'"
        class="label text-ink-600 hover:text-proof ml-2"
        title="before and after, and what settled it"
        @click="showing = root.id"
      >
        before / after
      </button>
      <span v-if="stalled?.[root.id]" class="chip border-fail/50 text-fail ml-2 align-middle">
        at a standstill — {{ stalled[root.id] }}
      </span>
      <div class="text-[12px] mt-0.5" :class="stateOf(root).color">
        {{ stateOf(root).word }}
        <span v-if="root.attempts.length" class="text-ink-500">
          · {{ root.attempts.length }} attempt{{ root.attempts.length > 1 ? 's' : '' }} on the chapter
          itself
        </span>
      </div>

      <!-- Start it from here. The whole point of the tool. -->
      <div class="mt-2 pb-3">
        <RunControl :slug="slug" :objective-id="root.id" :proof-spec="root.proof_spec" />
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
          <span v-if="stalled?.[o.id]" class="chip border-fail/50 text-fail">
            at a standstill — {{ stalled[o.id] }}
          </span>
          <span v-if="o.halt_reason" class="text-[11px] text-ink-400">
            {{ haltLabel[o.halt_reason] ?? o.halt_reason }}
          </span>

          <!-- Adding was possible and undoing was not: a step added by mistake
               could only be reached through the database. -->
          <button
            v-if="o.status !== 'proven'"
            class="label text-ink-800 hover:text-fail ml-auto shrink-0"
            :disabled="setting === o.id"
            title="stop counting it — nothing is deleted"
            @click="setAside(o.id)"
          >
            {{ setting === o.id ? '…' : 'set aside' }}
          </button>
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

    <!-- Adding a step was possible only on the plan page, behind a link in the
         corner. So this page showed chapters with no steps, no way to add one,
         and no hint that anywhere else would let you. -->
    <div class="pl-7 mt-2.5">
      <AddObjective
        :slug="slug"
        :parent-id="root.id"
        :next-priority="nextPriority(root.id)"
        @created="emit('changed')"
      />
    </div>
  </div>
  </template>
  </div>

  <ChapterClosure v-if="showing" :objective-id="showing" @close="showing = null" />
</template>
