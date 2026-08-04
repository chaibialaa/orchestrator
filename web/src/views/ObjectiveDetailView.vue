<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { api, type Objective, type ObjectiveStep, type Passage, type Evidence } from '../api'
import Chips from '../components/Chips.vue'
import RunControl from '../components/RunControl.vue'
import Blockers from '../components/Blockers.vue'
import AskWhatToDo from '../components/AskWhatToDo.vue'
import LiveFeed from '../components/LiveFeed.vue'
import DecisionBox from '../components/DecisionBox.vue'
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

/**
 * What to do, before what it is.
 *
 * The page opened on "In progress" and "Not ready to conclude" — two states, no
 * instruction. Someone who did not build this cannot tell from those whether
 * they are waiting on a machine, on a decision of their own, or on nothing.
 */
const step = ref<ObjectiveStep | null>(null)

/** Which branch is picked, and the sentence it writes. Both stay editable. */
const chosen = ref<number | null>(null)
const prefill = ref('')
const showWhy = ref(false)

/** Which option is being taken. Only its control is shown. */
const doing = ref<string | null>(null)

/** Lifting a halt is an act, and it belongs on the halt. */
const clearing = ref<number | null>(null)
async function clear(id: number) {
  clearing.value = id
  try {
    await api.resolveHalt(id)
    await load()
  } finally {
    clearing.value = null
  }
}

function choose(i: number, opt: { label: string; gives_up: string; then: string }) {
  chosen.value = i
  // The sentence says what is GIVEN UP, because that is what makes a decision a
  // decision — and it lands in a box that stays editable: these are the model's
  // words about your choice, not your words.
  prefill.value = `${opt.label}. We give up: ${opt.gives_up} Next: ${opt.then}`
}

async function load() {
  loading.value = true
  objective.value = await api.objective(props.id)
  step.value = await api.objectiveNext(Number(props.id)).catch(() => null)
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

const waiveWhy = ref('')
const waiveError = ref<string | null>(null)

/**
 * Lift the "it has to be seen" rule, here and nowhere else.
 *
 * The reason is required rather than optional: a waiver with no stated ground
 * reads later exactly like a rule that was never there.
 */
async function waiveVisual() {
  if (!objective.value?.project) return
  busyOn.value = true
  waiveError.value = null
  try {
    await api.createDecision(objective.value.project, {
      title: 'This criterion does not require seeing',
      body: waiveWhy.value.trim(),
      objective_id: Number(props.id),
      waives: 'visual_proof',
    })
    waiveWhy.value = ''
    doing.value = null
    await load()
  } catch (e: any) {
    waiveError.value = e?.response?.data?.message ?? e?.message ?? 'it was refused'
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

        <!-- A rule was lifted here. It reads next to the criterion it applies to,
             where anyone weighing what was proven will meet it. -->
        <p
          v-for="w in objective.waivers ?? []"
          :key="w.decided_at"
          class="text-halt/90 text-[11px] mt-2 border-l-2 border-halt/40 pl-2.5 leading-relaxed"
        >
          <span class="label text-ink-600">waived {{ w.decided_at?.slice(0, 10) }}</span>
          {{ w.waives === 'visual_proof' ? 'settling this does not require seeing it' : w.waives }} — {{ w.body }}
        </p>
      </div>
    </header>

    <!-- THE INSTRUCTION, first. Everything under it is the evidence for it. -->
    <section
      v-if="step"
      class="border rounded p-5"
      :class="{
        'border-fail/40 bg-fail/[0.04]': step.tone === 'blocked',
        'border-halt/40 bg-halt/[0.04]': step.tone === 'decide',
        'border-run/40 bg-run/[0.04]': step.tone === 'work',
        'border-proof/40 bg-proof/[0.04]': step.tone === 'done',
      }"
    >
      <div class="flex items-baseline gap-3 flex-wrap">
        <span
          class="label"
          :class="{
            'text-fail': step.tone === 'blocked',
            'text-halt': step.tone === 'decide',
            'text-run': step.tone === 'work',
            'text-proof': step.tone === 'done',
          }"
        >
          {{
            step.tone === 'blocked'
              ? 'Nothing can run'
              : step.tone === 'decide'
                ? 'Waiting on you'
                : step.tone === 'work'
                  ? 'What to do next'
                  : 'Finished'
          }}
        </span>
        <span class="text-ink-100 text-[15px]">{{ step.headline }}</span>
        <!-- A rule that refuses and a reading of THIS objective are not the same
             authority, and the reader is entitled to know which is speaking. -->
        <span v-if="step.from" class="label text-ink-600 ml-auto">
          {{
            step.from === 'analysis'
              ? 'from a reading of this objective'
              : step.from === 'halt'
                ? 'the loop stopped itself'
                : step.from === 'running'
                  ? 'measured on this machine'
                  : 'your decision, recorded'
          }}
        </span>
      </div>
      <!-- The contradiction, one short line each. It arrives structured; printing
           it as a paragraph made the reader find it again. -->
      <ul v-if="step.why" class="mt-2 space-y-1">
        <li
          v-for="(line, i) in step.why.split('\n').filter(Boolean)"
          :key="i"
          class="text-ink-400 text-[12px] leading-relaxed flex gap-2"
        >
          <span class="text-ink-700">·</span><span>{{ line }}</span>
        </li>
      </ul>

      <!-- The question, one sentence. The reasoning behind it is folded away: it
           is there to be checked, not to be distilled by whoever must decide. -->
      <!-- No reading measure on two lines: an 80-character cap inside a full-width
           card leaves half of it empty, which reads as a layout that broke rather
           than as a line somebody chose to keep short. The cap stays on the folded
           reasoning below, where the paragraphs are long enough to need it. -->
      <p v-if="step.action" class="text-ink-100 mt-3 leading-relaxed">
        → {{ step.options?.length ? step.action.split(/(?<=[.!?])\s/)[0] : step.action }}
      </p>
      <button
        v-if="step.options?.length && step.reasoning"
        class="label text-ink-600 hover:text-ink-300 mt-1"
        @click="showWhy = !showWhy"
      >
        {{ showWhy ? 'hide the reasoning' : 'read the reasoning behind it' }}
      </button>
      <p
        v-if="showWhy && step.reasoning"
        class="text-ink-500 text-[12px] mt-2 leading-relaxed max-w-[80ch] whitespace-pre-line border-l-2 border-ink-800 pl-3"
      >{{ step.reasoning }}</p>

      <!-- What can be done, always, in the same shape.
           Everything else on this page states a fact; this is the only thing that
           says what to do, so it is the only thing shown until one is picked.
           Picking reveals that option's control and nothing else — the page used
           to show the run control, the verdict buttons, the decision box and the
           ask button all at once, and asked the reader to work out which. -->
      <div
        v-if="step.choices?.length && !step.options?.length"
        class="mt-4 grid gap-2.5"
        :class="step.choices.length > 1 ? 'md:grid-cols-2' : ''"
      >
        <button
          v-for="c in step.choices"
          :key="c.kind"
          class="text-left border rounded p-3.5 transition-colors"
          :class="doing === c.kind ? 'border-run bg-run/10' : 'border-ink-700 hover:border-ink-600'"
          @click="doing = doing === c.kind ? null : c.kind"
        >
          <div class="flex items-baseline gap-2">
            <span
              class="w-3 h-3 rounded-full border shrink-0 self-center"
              :class="doing === c.kind ? 'border-run bg-run' : 'border-ink-600'"
            />
            <span class="text-ink-100 text-[13px]">{{ c.label }}</span>
          </div>
          <p class="text-ink-400 text-[12px] mt-1.5 leading-relaxed">
            <span class="label text-ink-600">it costs</span> {{ c.price }}
          </p>
        </button>
      </div>

      <!-- The control for the one that was picked, and only that one. -->
      <div v-if="doing" class="mt-4 pt-4 border-t border-run/20">
        <RunControl
          v-if="doing === 'run' && objective.project"
          :slug="objective.project"
          :objective-id="objective.id"
          :proof-spec="objective.proof_spec"
          :instruction="step.from === 'decision' ? (step.why ?? '') : ''"
          label="Start it"
        />
        <div v-else-if="doing === 'accept' || doing === 'reject'" class="flex items-center gap-2">
          <button
            class="chip"
            :class="doing === 'accept' ? 'border-proof text-proof bg-proof/10' : 'border-fail/60 text-fail'"
            :disabled="busyOn"
            @click="castVerdict(doing === 'accept' ? 'accept' : 'reject')"
          >
            {{ busyOn ? '…' : doing === 'accept' ? 'Yes — the criterion is met' : 'Yes — refuse it' }}
          </button>
        </div>
        <div v-else-if="doing === 'clear' && step.halt" class="flex items-center gap-2">
          <button class="chip border-halt/60 text-halt hover:bg-halt/10" :disabled="clearing === step.halt" @click="clear(step.halt)">
            {{ clearing === step.halt ? '…' : 'Yes — clear it' }}
          </button>
        </div>
        <AskWhatToDo
          v-else-if="doing === 'ask'"
          :objective-id="objective.id"
          :current="objective.proof_spec"
          @applied="load"
        />
        <div v-else-if="doing === 'abandon'" class="flex items-center gap-2">
          <button class="chip border-fail/60 text-fail hover:bg-fail/10" @click="setAside">
            Yes — stop counting it
          </button>
        </div>
        <RouterLink
          v-else-if="doing === 'criterion' && objective.project"
          :to="`/p/${objective.project}/plan`"
          class="chip border-ink-600 text-ink-300 hover:border-run hover:text-run"
        >
          Open the plan and rewrite it ▸
        </RouterLink>
        <RouterLink v-else-if="doing === 'unblock' && objective.project" :to="`/p/${objective.project}`" class="chip border-fail/60 text-fail">
          See what is in the way ▸
        </RouterLink>

        <!-- No button here on purpose: an image becomes proof by being produced,
             not by being declared. Saying where it comes from beats a control
             that would only record that one exists. -->
        <div v-else-if="doing === 'image'" class="text-[12px] text-ink-400 leading-relaxed">
          A rendering counts once a pass has produced it and attached it — the pass
          calls
          <code class="text-ink-200">orchestrator evidence &lt;passage&gt; render pass &lt;what it shows&gt;</code>.
          Ask for it in what you tell the next pass to do.
        </div>

        <div v-else-if="doing === 'waive_visual'">
          <p class="text-[12px] text-ink-400 leading-relaxed">
            Say why this criterion settles without anyone looking. It is kept as a dated
            decision on this objective, and the rule goes on applying everywhere else.
          </p>
          <textarea
            v-model="waiveWhy"
            rows="3"
            class="w-full mt-2 bg-ink-900 border border-ink-700 rounded p-2 text-[12px] text-ink-100"
            placeholder="e.g. it asks for a CSV and counts; it names captures as its subject, and asks nobody to look at one"
          />
          <div class="flex items-center gap-3 mt-2">
            <button
              class="chip border-halt/60 text-halt hover:bg-halt/10"
              :disabled="busyOn || !waiveWhy.trim()"
              @click="waiveVisual"
            >
              {{ busyOn ? '…' : 'Record it' }}
            </button>
            <span v-if="waiveError" class="text-[12px] text-fail">{{ waiveError }}</span>
          </div>
        </div>
      </div>

      <!-- The branches, as things to press rather than a paragraph to distil. -->
      <div
        v-if="step.options?.length"
        class="mt-4 grid gap-2.5"
        :class="step.options.length > 1 ? 'md:grid-cols-2' : ''"
      >
        <button
          v-for="(opt, i) in step.options"
          :key="i"
          class="text-left border rounded p-3.5 transition-colors"
          :class="chosen === i ? 'border-halt bg-halt/10' : 'border-ink-700 hover:border-ink-600'"
          @click="choose(i, opt)"
        >
          <div class="flex items-baseline gap-2">
            <span
              class="w-3 h-3 rounded-full border shrink-0 self-center"
              :class="chosen === i ? 'border-halt bg-halt' : 'border-ink-600'"
            />
            <span class="text-ink-100 text-[13px]">{{ opt.label }}</span>
          </div>
          <p class="text-halt text-[12px] mt-1.5 leading-relaxed">
            <span class="label text-ink-600">you give up</span> {{ opt.gives_up }}
          </p>
          <p class="text-ink-400 text-[12px] mt-1 leading-relaxed">
            <span class="label text-ink-600">then</span> {{ opt.then }}
          </p>
        </button>
      </div>

      <!-- And when the instruction is "start a pass", the way to start it is here.
           Telling somebody to do a thing and leaving the control for it further
           down the page is the same defect as having no control at all: they read
           an instruction and look for what to press. -->
      <div
        v-if="step.from === 'running' && objective.project"
        class="mt-4 pt-4 border-t border-run/20"
      >
        <RunControl
          :slug="objective.project"
          :objective-id="objective.id"
          :proof-spec="objective.proof_spec"
          :instruction="step.why ?? ''"
          label="Start a pass with this decision"
        />
        <!-- Behind the band that says a pass is working, not beside it. -->
        <LiveFeed :objective-id="objective.id" />
      </div>

      <!-- The instruction named a decision; this is where it is taken. Without
           it the page asked for a judgement and offered only the button that
           repeats the attempt. -->
      <DecisionBox
        v-if="step.from === 'analysis' && step.action && objective.project"
        :slug="objective.project"
        :objective-id="objective.id"
        :question="step.action"
        :prefill="prefill"
        @recorded="load"
      />
    </section>

    <!-- WHY IT IS NOT MOVING — the conditions of the machine, when there are any.
         The instruction above already leads with them; this is the detail. -->
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
          <!-- It used to be the page's headline, which made a rule that refuses
               read as the answer to "what do I do". It is a caption now: the
               instruction is at the top. -->
          <div v-else class="text-ink-200 text-[15px]">
            The gate refuses to conclude it — you can still refuse it yourself
          </div>
          <!-- The band at the top already carries this sentence; printing it twice
               makes the instruction and its justification indistinguishable. It
               stays only when there is no band to have said it. -->
          <p v-if="!step" class="text-ink-300 mt-1.5 leading-relaxed">{{ objective.gate?.detail }}</p>

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
        <div v-if="!step?.choices?.length" class="flex gap-2 shrink-0">
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

        <!-- The way out, on the thing that blocks.
             This section listed halts and offered nothing: an objective could be
             stopped by one, say so plainly, and leave you with no control on the
             page — every start refused afterwards for a reason displayed three
             inches above and unreachable. -->
        <div class="mt-2.5 flex items-baseline gap-3 flex-wrap">
          <button
            class="chip border-halt/60 text-halt hover:bg-halt/10"
            :disabled="clearing === h.id"
            @click="clear(h.id)"
          >
            {{ clearing === h.id ? '…' : 'clear it' }}
          </button>
          <span class="text-ink-600 text-[11px]">
            Clearing says you have dealt with it. Nothing runs until you start a pass.
          </span>
        </div>
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
