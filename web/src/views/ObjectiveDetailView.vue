<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { api, type Objective, type Passage, type Evidence } from '../api'
import Chips from '../components/Chips.vue'
import RunControl from '../components/RunControl.vue'
import Blockers from '../components/Blockers.vue'
import AskWhatToDo from '../components/AskWhatToDo.vue'
import {


  evidenceVerdictLabel,
  formatTokens,
  haltHelp,
  harnessLabel,
} from '../labels'

const props = defineProps<{ id: string }>()

const objective = ref<Objective | null>(null)
const loading = ref(true)
const busyOn = ref(false)
const detailsOpen = ref(false)

/** Setting aside destroys nothing: it stops being counted, and nothing runs on it. */
const dropping = ref(false)
async function setAside() {
  await api.updateObjective(Number(props.id), { status: 'abandoned' })
  dropping.value = false
  await load()
}
const expanded = ref<Set<number>>(new Set())
const preview = ref<{ url: string; name: string; text?: string; id: number } | null>(null)

async function load() {
  loading.value = true
  objective.value = await api.objective(props.id)
  loading.value = false
}

onMounted(load)
watch(() => props.id, load)

async function castVerdict(decision: 'accept' | 'reject') {
  busyOn.value = true
  try {
    await api.verdict(Number(props.id), decision)
    await load()
  } finally {
    busyOn.value = false
  }
}

async function openFile(evidenceId: number, path: string, n: number) {
  const url = api.evidenceFileUrl(evidenceId, n)
  const name = path.split('/').pop() ?? path
  if (/\.(md|json|txt)$/i.test(path)) {
    const text = await fetch(url).then((r) => r.text()).catch(() => 'could not read it')
    preview.value = { url, name, text, id: evidenceId }
  } else {
    preview.value = { url, name, id: evidenceId }
  }
}

function neighbour(step: number) {
  const l = proofs.value
  const i = l.findIndex((e) => e.id === preview.value?.id)
  const s = l[(i + step + l.length) % l.length]
  if (s?.files?.length) openFile(s.id, s.files[0], 0)
}

function toggle(id: number) {
  const s = new Set(expanded.value)
  s.has(id) ? s.delete(id) : s.add(id)
  expanded.value = s
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '—')

function duration(p: Passage) {
  if (!p.ended_at) return 'running'
  const min = Math.round(
    (new Date(p.ended_at).getTime() - new Date(p.started_at).getTime()) / 60000,
  )
  return min < 60 ? `${min} min` : `${(min / 60).toFixed(1)} h`
}

function toolName(t: string) {
  return t.startsWith('mcp__') ? t.split('__').slice(2).join('__') || t : t
}

/** Harness jargon has no business reaching the screen. */
function readableReason(raw: string | null) {
  if (!raw) return ''
  if (/multiple operations|require approval/i.test(raw)) return 'shell command not allowed'
  if (/redirection.*blocked|may only/i.test(raw)) return 'write outside the repository refused'
  if (/permissions to use/i.test(raw)) return 'tool not allowed'
  // Both spellings: reports written before the switch still say « délai ».
  if (/délai|timeout/i.test(raw)) return raw
  if (/[Ss]onde|probe/.test(raw)) return 'diagnostic probe'
  return raw.length > 90 ? raw.slice(0, 90) + '…' : raw
}

const passages = computed(() =>
  [...(objective.value?.passages ?? [])].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  ),
)

/** What produced work — the rest is operational noise. */
const missionOpen = ref<Set<number>>(new Set())
function toggleMission(id: number) {
  const s = new Set(missionOpen.value)
  s.has(id) ? s.delete(id) : s.add(id)
  missionOpen.value = s
}
function missionSize(m: string) {
  const lines = m.split('\n').length
  return `${lines} line${lines > 1 ? 's' : ''}`
}

const useful = computed(() => passages.value.filter((p) => p.verdict === 'advanced' || !p.ended_at))
const noise = computed(() => passages.value.filter((p) => p.verdict !== 'advanced' && p.ended_at))

const proofs = computed(() => {
  const o = objective.value
  if (!o) return []
  const all = [...(o.evidences ?? []), ...(o.passages ?? []).flatMap((p) => p.evidences ?? [])]
  const seen = new Set<number>()
  return all.filter((e) => {
    if (!e.files?.length || seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
})

/** Findings with no file attached: scores, measurements, caveats. */
const findings = computed(() => {
  const o = objective.value
  if (!o) return [] as Evidence[]
  const all = [...(o.evidences ?? []), ...(o.passages ?? []).flatMap((p) => p.evidences ?? [])]
  const seen = new Set<number>()
  return all.filter((e) => {
    if (e.files?.length || seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
})

const openHalts = computed(() => objective.value?.halts?.filter((h) => !h.resolved_at) ?? [])

/** What the checks actually returned, next to the button that acts on them. */
const tally = computed(() => {
  const o = objective.value
  const all = [...(o?.evidences ?? []), ...(o?.passages ?? []).flatMap((p) => p.evidences ?? [])]
  const seen = new Set<number>()
  const unique = all.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
  return {
    pass: unique.filter((e) => e.verdict === 'pass').length,
    fail: unique.filter((e) => e.verdict === 'fail').length,
    inconclusive: unique.filter((e) => e.verdict === 'inconclusive').length,
  }
})

const totals = computed(() => {
  const p = objective.value?.passages ?? []
  return {
    tokens: p.reduce((s, x) => s + (x.tokens ?? 0), 0),
    cost: p.reduce((s, x) => s + Number(x.cost_usd ?? 0), 0),
    // "advanced" counts as delivered even if the attempt was cut short: the
    // work is there. The rest is cost with nothing to show.
    wasted: p
      .filter((x) => x.verdict !== 'advanced')
      .reduce((s, x) => s + Number(x.cost_usd ?? 0), 0),
  }
})

const isImage = (f: string) => /\.(png|jpg|jpeg|webp)$/i.test(f)

/** Which thumbnails have actually arrived — a card waiting must not look like a
 *  card whose file is missing. `error` counts as arrived: the frame then shows
 *  what it can rather than pulsing for ever. */
const loadedThumbs = ref(new Set<number>())

/**
 * The criterion, broken back into the items it is made of.
 *
 * The whole argument this tool makes is that a criterion has to decompose into
 * things checkable one by one — otherwise a failure cannot say where it is. The
 * screen was undoing that argument: it printed the criterion as one running
 * paragraph, so a criterion listing eleven counts and a criterion saying "score
 * >= 78/100" looked exactly alike. One of those cost $22 and the other $634.
 *
 * Split on the separators criteria actually use — line breaks and semicolons —
 * and only when it yields more than one piece. A single-item criterion stays a
 * sentence; turning it into a list of one would just be decoration.
 */
const criterionItems = computed(() => {
  const spec = objective.value?.proof_spec?.trim()
  if (!spec) return []

  const items = spec
    .split(/\n+/)
    .flatMap((block) => block.split(/\s*;\s*/))
    .map((s) => s.trim())
    .filter(Boolean)

  return items.length > 1 ? items : []
})
</script>

<template>
  <div v-if="loading" class="text-ink-400">loading…</div>

  <div v-else-if="objective" class="space-y-8 pb-16">
    <!-- WHAT WAS ASKED -->
    <header>
      <!-- An objective page had no way back to its project: with four projects
           and forty-odd objectives, the only route was the browser's back
           button. -->
      <nav v-if="objective.project" class="label mb-2 flex items-center gap-1.5" aria-label="Breadcrumb">
        <RouterLink :to="`/p/${objective.project}`" class="hover:text-ink-300 transition-colors">
          {{ objective.project }}
        </RouterLink>
        <span class="text-ink-700">›</span>
        <span class="text-ink-600">#{{ objective.id }}</span>
      </nav>

      <div class="flex items-start gap-4 flex-wrap">
        <h1 class="text-[20px] text-ink-100 flex-1 min-w-0">{{ objective.title }}</h1>
        <div class="flex gap-1.5 shrink-0">
          <Chips kind="status" :value="objective.status" />
          <Chips kind="blast" :value="objective.blast_radius" />
        </div>
      </div>

      <p v-if="objective.intent" class="text-ink-400 mt-2 leading-relaxed max-w-3xl">
        {{ objective.intent }}
      </p>

      <div
        class="mt-5 pl-4 border-l-2"
        :class="objective.proof_spec ? 'border-ink-600' : 'border-fail'"
      >
        <div class="label flex items-baseline gap-3">
          <span>What must be true to conclude</span>
          <!-- "items", not "checkable items": the split is mechanical and cannot
               tell a condition from a caveat. A criterion that ends by declaring
               two things out of scope would have had them counted as gates. -->
          <span v-if="criterionItems.length" class="num text-ink-600 text-[11px]">
            {{ criterionItems.length }} items
          </span>
        </div>

        <!-- Listed, not run together: a criterion that cannot be broken into
             items is a criterion a failure cannot point inside of. Seeing it as
             one block is the point. -->
        <ul v-if="criterionItems.length" class="mt-2 space-y-1.5">
          <li
            v-for="(item, i) in criterionItems"
            :key="i"
            class="text-ink-100 text-[14px] leading-relaxed flex gap-2.5"
          >
            <span class="text-ink-700 shrink-0 select-none num text-[11px] mt-1">{{ i + 1 }}</span>
            <span>{{ item }}</span>
          </li>
        </ul>

        <p
          v-else
          class="mt-1.5 leading-relaxed"
          :class="objective.proof_spec ? 'text-ink-100 text-[15px]' : 'text-fail'"
        >
          {{
            objective.proof_spec ??
            'Nobody has answered this question. No agent can take this objective until it has an answer.'
          }}
        </p>

        <!-- A criterion in one piece is not forbidden, but it is worth a word:
             it is the shape that ran up twenty-one passes without concluding. -->
        <p v-if="objective.proof_spec && !criterionItems.length" class="text-halt/80 text-[11px] mt-2">
          One single item — a failure here cannot say which part of it failed.
        </p>
      </div>
    </header>

    <!-- WHY IT IS NOT MOVING — above the decision, because half the time there is
         no decision to take: the editor is closed, or the harness has no tool it
         may use, and no verdict on this page would change that. -->
    <Blockers :objective="Number(objective.id)" compact />

    <!-- THE DECISION -->
    <!-- Shown whether or not the gate is satisfied. It only appeared once
         everything was in place, so an objective the gate refuses offered no way
         to say anything about it — not even "stop, this is going the wrong way",
         which is the one thing worth hearing early. -->
    <section
      v-if="objective.status !== 'proven' && objective.status !== 'abandoned'"
      class="border rounded p-5"
      :class="objective.gate?.ready ? 'border-proof/40 bg-proof/[0.05]' : 'border-ink-700 bg-ink-900/40'"
    >
      <div class="flex items-start gap-5 flex-wrap">
        <div class="flex-1 min-w-[16rem]">
          <div v-if="objective.gate?.ready" class="text-proof text-[15px]">
            Your verdict: is the criterion met?
          </div>
          <div v-else class="text-ink-200 text-[15px]">
            Not ready to conclude — but you can still stop it
          </div>
          <p class="text-ink-300 mt-1.5 leading-relaxed">{{ objective.gate?.detail }}</p>

          <!-- What to check, restated where the decision is taken. Asking for a
               verdict without saying what to look at is asking for a guess: the
               criterion sits further up the page, and the tally of what actually
               passed sat nowhere at all. -->
          <p v-if="objective.proof_spec" class="mt-3 text-ink-200 border-l-2 border-proof/40 pl-3 leading-relaxed">
            {{ objective.proof_spec }}
          </p>

          <div class="mt-2.5 flex items-baseline gap-4 flex-wrap text-[12px]">
            <span class="num" :class="tally.pass ? 'text-proof' : 'text-ink-600'">
              {{ tally.pass }} passing
            </span>
            <span v-if="tally.fail" class="num text-fail">{{ tally.fail }} failing</span>
            <span v-if="tally.inconclusive" class="num text-ink-500">
              {{ tally.inconclusive }} inconclusive
            </span>
            <a v-if="proofs.length" href="#proofs" class="text-run hover:underline">
              look at the {{ proofs.length }} deliverables ↓
            </a>
          </div>

          <!-- The gate can be satisfied without a single check having returned a
               verdict — files alone are inconclusive. Accepting then rests on the
               reader's eyes, which is fine, as long as nobody is told otherwise. -->
          <p v-if="!tally.pass" class="mt-2.5 text-halt leading-relaxed">
            No check returned a verdict here — every proof is a file somebody produced.
            Accepting means you have looked and you are satisfied, not that something measured it.
          </p>
        </div>
        <div class="flex gap-2 shrink-0">
          <button
            class="px-4 py-2 rounded border border-proof text-proof bg-proof/10 hover:bg-proof/20 text-[13px] transition-colors disabled:opacity-40"
            :disabled="busyOn || !objective.gate?.ready"
            :title="objective.gate?.ready ? '' : `The gate refuses: ${objective.gate?.detail ?? ''}`"
            @click="castVerdict('accept')"
          >
            {{ busyOn ? '…' : 'The criterion is met' }}
          </button>
          <button
            class="px-4 py-2 rounded border border-ink-600 text-ink-400 hover:border-fail hover:text-fail text-[13px] transition-colors disabled:opacity-40"
            :disabled="busyOn"
            @click="castVerdict('reject')"
          >
            No, redo it
          </button>
        </div>
      </div>

      <!-- Two verdicts and no way to work.
           A page that says "not ready to conclude" and offers only the buttons
           that conclude leaves you to guess which other screen has the one that
           advances. The run control lived here already — inside the open-halts
           block, so it appeared only while a halt was open. In every other
           state, including the commonest one, this page could not start
           anything. -->
      <div class="mt-5 pt-4 border-t border-ink-800">
        <div class="flex items-baseline gap-4 flex-wrap">
          <span class="label text-ink-500">or work on it</span>
          <RunControl
            v-if="objective.project"
            :slug="objective.project"
            :objective-id="objective.id"
            :proof-spec="objective.proof_spec"
            :label="passages.length ? 'Run it again' : 'Run it'"
          />
          <RouterLink
            :to="`/p/${objective.project}/plan`"
            class="chip border-ink-600 text-ink-300 hover:border-run hover:text-run transition-colors"
          >
            change what would prove it ▸
          </RouterLink>

          <!-- Two clicks rather than a confirm(): a browser dialog blocks
               everything, and this is not urgent enough to freeze a page for. -->
          <!-- No condition needed: this whole card only exists while the
               objective is neither proven nor set aside. -->
          <button
            class="chip ml-auto transition-colors"
            :class="dropping ? 'border-fail text-fail' : 'border-ink-700 text-ink-500 hover:border-fail hover:text-fail'"
            @click="dropping ? setAside() : (dropping = true)"
          >
            {{ dropping ? 'yes — stop counting it' : 'set it aside' }}
          </button>
        </div>

        <!-- When the answer is not "run it again", ask what it should be. The
             request writes itself from the record; the reply proposes. -->
        <AskWhatToDo class="mt-3" :objective-id="objective.id" @applied="load" />

        <!--
          Three attempts in, "run it again" stops being neutral advice.
          The page showed the tally and left the conclusion to the reader, so the
          only visible move was the one that repeats what already happened: ten
          passes and $531 went that way on this very chapter, against a criterion
          that had been over-constrained since its first day. The figures are
          already on the page; what was missing was the sentence they make.
        -->
        <p v-if="passages.length >= 3" class="text-ink-500 text-[12px] mt-3 max-w-[80ch] leading-relaxed">
          {{ passages.length }} attempts so far, {{ tally.pass }} of them settled by something that
          returned a verdict. Another run repeats those unless what you ask for changes — the
          instruction, or the criterion itself.
        </p>
      </div>
    </section>

    <section v-if="objective.status === 'proven'" class="flex items-center gap-3 text-proof">
      <span class="w-2 h-2 rounded-full bg-proof" />
      <span>Accepted{{ objective.proven_at ? ` on ${objective.proven_at.slice(0, 10)}` : '' }}</span>
    </section>

    <!-- WHAT IS WAITING FOR YOU -->
    <section v-if="openHalts.length" class="space-y-2.5">
      <div v-for="h in openHalts" :key="h.id" class="border-l-2 border-halt pl-4 py-1">
        <div class="flex items-center gap-2 flex-wrap">
          <Chips kind="halt" :value="h.reason" />
          <span class="text-ink-600 text-[11px]">{{ h.created_at?.slice(0, 16) }}</span>
        </div>
        <p class="text-ink-300 mt-1.5 leading-relaxed max-w-[68ch]">{{ haltHelp[h.reason] }}</p>
        <p v-if="h.detail" class="text-ink-500 text-[12px] mt-1.5 whitespace-pre-wrap max-w-[68ch]">
          {{ h.detail }}
        </p>


      </div>
    </section>

    <!-- WHAT CAME OUT -->
    <section v-if="proofs.length" id="proofs" class="scroll-mt-20">
      <h2 class="label mb-3">What came out — {{ proofs.length }}</h2>
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <button
          v-for="e in proofs"
          :key="e.id"
          class="text-left group"
          :aria-label="`Open ${e.label}`"
          @click="openFile(e.id, e.files![0], 0)"
        >
          <div
            class="relative aspect-[4/3] bg-ink-950 rounded border overflow-hidden flex items-center justify-center transition-colors"
            :class="
              e.verdict === 'fail'
                ? 'border-fail/40 group-hover:border-fail'
                : e.verdict === 'pass'
                  ? 'border-proof/30 group-hover:border-proof'
                  : 'border-ink-700 group-hover:border-ink-500'
            "
          >
            <!-- Lazy images used to arrive into a full-size black rectangle, and
                 a card waiting looked exactly like a card whose file is gone. A
                 placeholder that says "loading" costs nothing and stops the
                 screen from lying while it waits. -->
            <template v-if="isImage(e.files![0])">
              <span
                v-if="!loadedThumbs.has(e.id)"
                class="absolute text-ink-700 text-[10px] uppercase tracking-widest animate-pulse"
              >
                loading
              </span>
              <img
                :src="api.evidenceFileUrl(e.id, 0, 480)"
                :alt="e.label"
                class="w-full h-full object-cover transition-opacity duration-200"
                :class="loadedThumbs.has(e.id) ? 'opacity-100' : 'opacity-0'"
                loading="lazy"
                decoding="async"
                @load="loadedThumbs.add(e.id)"
                @error="loadedThumbs.add(e.id)"
              />
            </template>
            <span v-else class="text-ink-600 text-[24px] uppercase tracking-widest">
              {{ e.files![0].split('.').pop() }}
            </span>
          </div>
          <div class="mt-2 flex items-start gap-1.5">
            <span
              class="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
              :class="{
                'bg-proof': e.verdict === 'pass',
                'bg-fail': e.verdict === 'fail',
                'bg-ink-600': e.verdict === 'inconclusive',
              }"
            />
            <span class="text-[12px] text-ink-300 leading-snug">{{ e.label }}</span>
          </div>
        </button>
      </div>
    </section>

    <!-- WHAT WAS MEASURED -->
    <section v-if="findings.length">
      <h2 class="label mb-3">What was measured</h2>
      <div class="space-y-2">
        <div v-for="e in findings" :key="e.id" class="flex items-start gap-2.5">
          <span
            class="w-1.5 h-1.5 rounded-full shrink-0 mt-2"
            :class="{
              'bg-proof': e.verdict === 'pass',
              'bg-fail': e.verdict === 'fail',
              'bg-ink-600': e.verdict === 'inconclusive',
            }"
          />
          <div class="flex-1">
            <div class="text-ink-200">{{ e.label }}</div>
            <div v-if="e.ref" class="text-ink-500 text-[12px] mt-0.5">{{ e.ref }}</div>
          </div>
          <span
            class="text-[11px] shrink-0"
            :class="
              e.verdict === 'pass' ? 'text-proof' : e.verdict === 'fail' ? 'text-fail' : 'text-ink-600'
            "
            >{{ evidenceVerdictLabel[e.verdict] }}</span
          >
        </div>
      </div>
    </section>

    <!-- WHAT IT COST -->
    <section v-if="totals.tokens" class="flex items-baseline gap-6 text-[13px] border-t border-ink-800 pt-4">
      <span class="text-ink-400">
        <span class="text-ink-100 text-[15px]">${{ totals.cost.toFixed(2) }}</span> spent
      </span>
      <span v-if="totals.wasted > 0.5" class="text-ink-500">
        ${{ totals.wasted.toFixed(2) }} of it with nothing to show
      </span>
      <span class="text-ink-500">{{ formatTokens(totals.tokens) }} tokens</span>
      <span class="text-ink-500">{{ passages.length }} attempt{{ passages.length === 1 ? '' : 's' }}</span>
    </section>

    <!-- HOW WE GOT THERE -->
    <section v-if="passages.length">
      <button
        class="label hover:text-ink-300 transition-colors"
        @click="detailsOpen = !detailsOpen"
      >
        {{ detailsOpen ? '▾' : '▸' }} How we got there — {{ useful.length }} useful attempt(s)<template v-if="noise.length">, {{ noise.length }} with no effect</template>
      </button>

      <div v-if="detailsOpen" class="mt-4 space-y-4">
        <article
          v-for="p in useful"
          :key="p.id"
          class="border-l-2 pl-4"
          :class="p.verdict === 'advanced' ? 'border-proof/50' : 'border-ink-700'"
        >
          <div class="flex items-center gap-2.5 flex-wrap">
            <Chips kind="harness" :value="p.harness" />
            <Chips v-if="p.verdict" kind="verdict" :value="p.verdict" />
            <span class="text-ink-500 text-[12px]">{{ duration(p) }}</span>
            <span v-if="p.tokens" class="text-ink-500 text-[12px]"
              >{{ formatTokens(p.tokens) }} tokens</span
            >
            <span v-if="Number(p.cost_usd)" class="text-ink-500 text-[12px]"
              >${{ Number(p.cost_usd).toFixed(2) }}</span
            >
            <span
              v-if="p.resumed_from"
              class="text-halt text-[11px]"
              title="this attempt resumed an earlier session: part of its context does not come from its mission"
              >resumed from {{ p.resumed_from.slice(0, 8) }}</span
            >
            <span
              v-if="p.git_before !== p.git_after"
              class="text-ink-600 text-[11px] ml-auto"
              title="repository state before and after"
              >{{ short(p.git_before) }} → {{ short(p.git_after) }}</span
            >
          </div>

          <div v-if="p.tools_used && Object.keys(p.tools_used).length" class="mt-2.5 flex flex-wrap gap-1.5">
            <span
              v-for="(n, t) in p.tools_used"
              :key="t"
              class="text-[11px] text-ink-500"
              :title="String(t)"
            >
              {{ toolName(String(t)) }}<span class="text-ink-700">×{{ n }}</span>
            </span>
          </div>

          <div v-if="p.mission" class="mt-3">
            <button class="label hover:text-ink-300 transition-colors" @click="toggleMission(p.id)">
              {{ missionOpen.has(p.id) ? '▾' : '▸' }} The order it received —
              <span class="text-ink-600">{{ missionSize(p.mission) }}</span>
            </button>
            <pre
              v-if="missionOpen.has(p.id)"
              class="mt-2 p-3 bg-ink-950 border border-ink-800 rounded text-[12px] text-ink-300 whitespace-pre-wrap overflow-x-auto max-h-[28rem]"
            >{{ p.mission }}</pre>
          </div>

          <div v-if="p.said" class="mt-3">
            <button class="label hover:text-ink-300 transition-colors" @click="toggle(p.id)">
              {{ expanded.has(p.id) ? '▾' : '▸' }} Its report
            </button>
            <pre
              v-if="expanded.has(p.id)"
              class="mt-2 p-3 bg-ink-950 border border-ink-800 rounded text-[12px] text-ink-300 whitespace-pre-wrap overflow-x-auto max-h-[28rem]"
            >{{ p.said }}</pre>
          </div>
        </article>

        <div v-if="noise.length" class="border-l-2 border-ink-800 pl-4 pt-1">
          <div class="label mb-2">Attempts with no effect</div>
          <div v-for="p in noise" :key="p.id" class="flex items-baseline gap-2.5 text-[12px] py-0.5">
            <span class="text-ink-600">{{ harnessLabel[p.harness] ?? p.harness }}</span>
            <span class="text-ink-500 flex-1">{{ readableReason(p.prevented_by) || 'nothing to show' }}</span>
            <span class="text-ink-700">{{ duration(p) }}</span>
            <span v-if="Number(p.cost_usd)" class="text-ink-700"
              >${{ Number(p.cost_usd).toFixed(2) }}</span
            >
          </div>
        </div>
      </div>
    </section>

    <!-- Proof panel -->
    <Teleport to="body">
      <div v-if="preview" class="fixed inset-0 z-50 flex">
        <div class="flex-1 bg-ink-950/85 backdrop-blur-sm" @click="preview = null" />
        <aside class="w-[min(820px,92vw)] h-full bg-ink-900 border-l border-ink-700 flex flex-col">
          <header class="px-4 py-3 border-b border-ink-800 flex items-center gap-2.5">
            <span class="text-ink-100 flex-1 truncate text-[13px]">{{ preview.name }}</span>
            <template v-if="proofs.length > 1">
              <button class="btn px-2" @click="neighbour(-1)">‹</button>
              <button class="btn px-2" @click="neighbour(1)">›</button>
            </template>
            <a :href="preview.url" target="_blank" class="btn">full size</a>
            <button class="btn" @click="preview = null">close</button>
          </header>
          <div class="flex-1 overflow-auto p-4 bg-ink-950">
            <pre
              v-if="preview.text !== undefined"
              class="text-[12px] text-ink-300 whitespace-pre-wrap"
            >{{ preview.text }}</pre>
            <img v-else :src="preview.url" :alt="preview.name" class="w-full rounded" />
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>
