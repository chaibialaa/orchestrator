<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { api, type Attention, type Objective, type Stats, type TreeNode, type Project } from '../api'
import Chips from '../components/Chips.vue'
import ProjectTree from '../components/ProjectTree.vue'
import AddObjective from '../components/AddObjective.vue'
import RunQueue from '../components/RunQueue.vue'
import ActivityFeed from '../components/ActivityFeed.vue'
import Blockers from '../components/Blockers.vue'
import Charts from '../components/Charts.vue'
import { formatTokens } from '../labels'

const props = defineProps<{ slug: string }>()

const objectives = ref<Objective[]>([])
const stats = ref<Stats | null>(null)
const tree = ref<TreeNode[]>([])
const project = ref<Project | null>(null)

const judgeUrl = ref('')

/**
 * Hand the decision over, or take it back.
 *
 * `gate_judge` was fixed at creation. A project whose judge is the driving
 * conversation gives its owner no way to conclude anything — a human verdict is
 * recorded as a proof and the gate still waits for the conversation — and no way
 * to change that without SQL.
 */
async function setJudge(value: string) {
  if (!project.value || value === project.value.gate_judge) return
  project.value = await api.updateProject(props.slug, { gate_judge: value })
}
const savingJudge = ref(false)

/** Attach the conversation that will judge this project's work. */
async function attachJudge() {
  const url = judgeUrl.value.trim()
  if (!url) return
  savingJudge.value = true
  try {
    await api.updateProject(props.slug, { judge_url: url })
    judgeUrl.value = ''
    await load()
  } finally {
    savingJudge.value = false
  }
}
const loading = ref(true)
const error = ref<string | null>(null)
const showHelp = ref(false)

/**
 * Objective → the condition holding it up, in three words, for the track.
 *
 * Read from the same endpoint as the panel above rather than recomputed: one
 * rule decides what is in the way, and every screen quotes it.
 */
const stalled = ref<Record<number, string>>({})

async function load() {
  loading.value = true
  error.value = null
  try {
    const [o, s, t, ps, bl, at] = await Promise.all([
      api.objectives(props.slug),
      api.stats(props.slug),
      api.tree(props.slug),
      api.projects(),
      api.blockers({ project: props.slug }).catch(() => []),
      api.attention(props.slug).catch(() => []),
    ])
    waiting.value = at
    objectives.value = o
    stats.value = s
    tree.value = t.objectives
    project.value = ps.find((x) => x.slug === props.slug) ?? null

    const marks: Record<number, string> = {}
    for (const b of bl.filter((x) => x.severity === 'blocking')) {
      const label = b.group ?? b.title
      for (const id of [b.objective, ...(b.stops ?? []).map((x) => x.id)]) {
        if (id != null && !marks[id]) marks[id] = label
      }
    }
    stalled.value = marks
  } catch (e: any) {
    error.value = e?.message ?? 'error'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.slug, load)

// The chain/track computation lived here. The tree endpoint now returns the
// branching directly, so the screen no longer rebuilds it from a flat list.

const NEEDS_HUMAN = ['blast_radius', 'no_provable_criterion', 'invariant_regression', 'human_request']

/**
 * What is waiting on you here — asked of the tool, not recomputed.
 *
 * This page looked at halted objectives and nothing else, so a chapter whose
 * criterion was fully met, or a run that ended saying `needs_you`, showed
 * nothing: the project read as quietly progressing. A halted objective is still
 * not automatically yours — the loop clears a rejected verdict on its own — and
 * that judgement now lives in one place for every screen.
 */
const waiting = ref<Attention[]>([])
const decisions = computed(() => waiting.value.filter((a) => a.severity === 'decide'))

const autoResumed = computed(() =>
  objectives.value.filter((o) => o.status === 'blocked' && !NEEDS_HUMAN.includes(o.halt_reason ?? '')),
)
const done = computed(() => objectives.value.filter((o) => o.status === 'proven'))

// `story()` lived here — one plain sentence per status, written for the card
// this page used to draw itself. The card now carries the tool's own account of
// why something is waiting, which is the same sentence written from evidence
// rather than from a status word.

</script>

<template>
  <div v-if="loading" class="text-ink-400">loading…</div>
  <div v-else-if="error" class="card p-4 border-fail/40 text-fail">
    The API is not responding — {{ error }}
    <div class="text-ink-400 mt-1 text-[11px]">
      It should be running on port 4747 (orchestrator serve)
    </div>
  </div>

  <div v-else class="space-y-8">
    <!-- The page had a paragraph explaining itself, four large number cards, and a
         "how to read this" panel — before showing a single line of the project. The
         explanation is now one sentence, the numbers are a margin, and the subject
         starts immediately. -->
    <header class="flex items-end gap-6 flex-wrap border-b border-ink-800 pb-4">
      <div class="flex-1 min-w-[16rem]">
        <h1 class="text-ink-100 text-[17px]">Where the project stands</h1>
        <p class="text-ink-400 mt-1">
          Read the track bottom to top: order is execution order.
          <button class="text-ink-500 hover:text-ink-300 underline underline-offset-2" @click="showHelp = !showHelp">
            {{ showHelp ? 'hide the legend' : 'what do the colours mean?' }}
          </button>
        </p>
      </div>

      <dl class="flex items-end gap-7 text-[12px]">
        <div>
          <dt class="label">Verified</dt>
          <dd class="num text-[18px] text-ink-100 mt-0.5">
            {{ done.length }}<span class="text-ink-600 text-[13px]">/{{ objectives.length }}</span>
          </dd>
        </div>
        <div>
          <dt class="label">Attempts</dt>
          <dd class="num text-[18px] text-ink-100 mt-0.5">{{ stats?.passages ?? 0 }}</dd>
        </div>
        <div>
          <dt class="label">Spent</dt>
          <dd class="num text-[18px] text-ink-100 mt-0.5">${{ (stats?.cost_usd ?? 0).toFixed(0) }}</dd>
        </div>
        <div>
          <dt class="label">Tokens</dt>
          <dd class="num text-[18px] text-ink-100 mt-0.5">{{ formatTokens(stats?.tokens) }}</dd>
        </div>
      </dl>
    </header>

    <!-- Where the work happens and who judges it. The conversation has a ceiling
         now — every turn re-reads the whole thread — so how full it is belongs
         next to the project, not buried in a halt when it is already too late. -->
    <section v-if="project" class="flex items-baseline gap-x-6 gap-y-1 flex-wrap text-[11px]">
      <span v-if="project.repo_path" class="num text-ink-500">{{ project.repo_path }}</span>

      <a
        v-if="project.judge_url"
        :href="project.judge_url"
        target="_blank"
        class="text-ink-500 hover:text-run transition-colors"
      >
        judging conversation ▸
      </a>
      <template v-else>
        <!-- Stating a problem without a way out leaves the reader where they
             were. The address is one paste away and was nowhere on this page. -->
        <span class="text-halt">no judging conversation — the loop has nobody to ask</span>
        <input
          v-model="judgeUrl"
          placeholder="https://chatgpt.com/c/… — paste one and it is attached"
          class="num bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[11px] text-ink-300 w-[22rem] max-w-full focus:outline-none focus:border-run"
          @keyup.enter="attachJudge"
        />
        <button
          class="chip border-halt/60 text-halt hover:bg-halt/10"
          :disabled="savingJudge || !judgeUrl.trim()"
          @click="attachJudge"
        >
          {{ savingJudge ? '…' : 'attach it' }}
        </button>
      </template>

      <span
        v-if="project.judge_messages_seen != null"
        :class="
          project.judge_messages_seen >= (project.judge_message_cap ?? 40)
            ? 'text-halt'
            : project.judge_messages_seen > (project.judge_message_cap ?? 40) * 0.75
              ? 'text-ink-300'
              : 'text-ink-500'
        "
        title="Every turn re-reads the whole thread. Past the cap, open a fresh conversation."
      >
        <span class="num">{{ project.judge_messages_seen }}/{{ project.judge_message_cap ?? 40 }}</span>
        exchanges
      </span>

      <!-- Who closes an objective here. It could only be chosen when the project
           was created, so taking the decision back — or handing it over — meant
           editing the database by hand. -->
      <label class="ml-auto flex items-center gap-2 text-[11px] text-ink-500">
        who rules
        <select
          :value="project.gate_judge ?? 'gpt'"
          class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[11px] text-ink-300 focus:outline-none focus:border-ink-600"
          @change="setJudge(($event.target as HTMLSelectElement).value)"
        >
          <option value="gpt">the driving conversation</option>
          <option value="human">you</option>
          <option value="agent">a third-party agent</option>
          <option value="self">the session itself</option>
        </select>
      </label>
    </section>

    <!-- The legend, on request. It teaches what a colour means; it does not repeat
         what the track already shows. -->
    <section v-if="showHelp" class="card p-4 grid md:grid-cols-2 gap-6">
      <div>
        <div class="label mb-2">A step can be</div>
        <ul class="space-y-1.5">
          <li v-for="s in ['draft', 'ready', 'in_progress', 'blocked', 'proven']" :key="s">
            <Chips kind="status" :value="s" />
          </li>
        </ul>
      </div>
      <div>
        <div class="label mb-2">Risk level decides autonomy</div>
        <ul class="space-y-1.5">
          <li v-for="b in ['cosmetic', 'feature', 'api', 'critical']" :key="b">
            <Chips kind="blast" :value="b" />
          </li>
        </ul>
        <p class="text-ink-600 text-[11px] mt-2">Hover a badge for its explanation.</p>
      </div>
    </section>

    <!-- What is stopping THIS project, before anything it could do about it.
         This panel existed only on the overview: a person opening the project
         because nothing had moved found four chapters, no attempt running, and
         no reason anywhere. The reason was two clicks away, on another page. -->
    <Blockers :project="slug" :columns="2" compact />

    <!-- What genuinely needs a person. -->
    <section v-if="decisions.length">
      <h2 class="label text-halt mb-3">Waiting for you — {{ decisions.length }}</h2>
      <div class="space-y-2.5">
        <RouterLink
          v-for="a in decisions"
          :key="`${a.kind}${a.objective}`"
          :to="a.href"
          class="card p-4 block border-halt/35 bg-halt/[0.04] hover:border-halt/60 transition-colors"
        >
          <div class="flex items-start gap-3 flex-wrap">
            <div class="flex-1 min-w-[14rem]">
              <div class="text-ink-100">{{ a.title }}</div>
              <p class="text-ink-400 mt-1.5 leading-relaxed">{{ a.why }}</p>
              <p class="text-ink-300 mt-1 text-[12px]">→ {{ a.action }}</p>
            </div>
            <span v-if="a.objective" class="num text-ink-600 text-[11px]">#{{ a.objective }}</span>
          </div>
        </RouterLink>
      </div>
    </section>

    <!-- THE SUBJECT OF THE PAGE: the work branched — what was asked for, what it
         split into, and every attempt each part took. -->
    <section v-if="tree.length" class="space-y-4">
      <RunQueue class="max-w-5xl" :slug="slug" :objectives="objectives" />

    <!-- The one action this page could not do: start something new. -->
    <div class="flex items-baseline gap-3">
      <span class="label">Chapters — {{ tree.length }}</span>
      <AddObjective
        class="ml-auto"
        :slug="slug"
        :next-priority="(tree.length + 1) * 10"
        @created="load"
      />
    </div>

    <ProjectTree :nodes="tree" :slug="slug" :stalled="stalled" @changed="load" />
    </section>

    <p v-if="autoResumed.length" class="text-ink-600 text-[12px]">
      {{ autoResumed.length }} objective{{ autoResumed.length > 1 ? 's' : '' }} halted on a reason the
      loop clears by itself — nothing for you to do:
      <span class="num text-ink-500">{{ autoResumed.map((o) => `#${o.id}`).join(', ') }}</span>
    </p>

    <!-- Per project, the same four questions the overview answers for all of them. -->
    <Charts :project="slug" />

    <ActivityFeed :slug="slug" />

    <RouterLink
      :to="`/p/${slug}/analysis`"
      class="card p-3.5 flex items-baseline gap-3 hover:border-ink-600 transition-colors"
    >
      <span class="text-ink-300">Analysis</span>
      <span class="text-ink-500 text-[12px] flex-1"
        >Why work jams, what it costs, what is measured in production.</span
      >
      <span class="label text-ink-600">open ▸</span>
    </RouterLink>
  </div>
</template>
