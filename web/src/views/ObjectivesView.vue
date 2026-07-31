<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { api, type Objective, type Stats, type TreeNode, type Project } from '../api'
import Chips from '../components/Chips.vue'
import ProjectTree from '../components/ProjectTree.vue'
import RunQueue from '../components/RunQueue.vue'
import ActivityFeed from '../components/ActivityFeed.vue'
import { formatTokens } from '../labels'

const props = defineProps<{ slug: string }>()

const objectives = ref<Objective[]>([])
const stats = ref<Stats | null>(null)
const tree = ref<TreeNode[]>([])
const project = ref<Project | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const showHelp = ref(false)

async function load() {
  loading.value = true
  error.value = null
  try {
    const [o, s, t, ps] = await Promise.all([
      api.objectives(props.slug),
      api.stats(props.slug),
      api.tree(props.slug),
      api.projects(),
    ])
    objectives.value = o
    stats.value = s
    tree.value = t.objectives
    project.value = ps.find((x) => x.slug === props.slug) ?? null
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

// A halted objective is not necessarily waiting for someone. The loop clears a
// verdict rejection or a stall on its own: counting those as decisions to make
// manufactures a queue that does not exist.
const waiting = computed(() =>
  objectives.value.filter((o) => o.status === 'blocked' && NEEDS_HUMAN.includes(o.halt_reason ?? '')),
)
const autoResumed = computed(() =>
  objectives.value.filter((o) => o.status === 'blocked' && !NEEDS_HUMAN.includes(o.halt_reason ?? '')),
)
const done = computed(() => objectives.value.filter((o) => o.status === 'proven'))

/** How long the open attempt has been running. */
function since(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 60000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h ${String(min % 60).padStart(2, '0')}`
}

/** One sentence saying where this objective stands. */
function story(o: Objective): string {
  const n = o.passages_count ?? 0
  const tries = n === 0 ? 'no attempts' : n === 1 ? '1 attempt' : `${n} attempts`

  if (o.status === 'draft') {
    return 'One question is unanswered: how will we know this is done? Until it has an answer, no agent can pick it up.'
  }
  if (o.status === 'blocked') {
    return `${tries}, then the tool stopped by itself. It is waiting for you to decide.`
  }
  if (o.status === 'in_progress') {
    return o.live_since
      ? `An agent has been on it for ${since(o.live_since)}. ${tries} in total.`
      : `Started, but no agent is on it right now. ${tries}.`
  }
  if (o.status === 'ready') {
    return 'The goal and the way to verify it are clear. The next available agent can take it.'
  }
  if (o.status === 'proven') {
    const e = o.evidences_count ?? 0
    return `Done and verified — ${e} proof${e > 1 ? 's' : ''} produced and accepted.`
  }
  return ''
}

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
      <span v-else class="text-halt">no judging conversation — the loop has nobody to ask</span>

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

    <!-- What genuinely needs a person. -->
    <section v-if="waiting.length">
      <h2 class="label text-halt mb-3">Waiting for you — {{ waiting.length }}</h2>
      <div class="space-y-2.5">
        <RouterLink
          v-for="o in waiting"
          :key="o.id"
          :to="`/o/${o.id}`"
          class="card p-4 block border-halt/35 bg-halt/[0.04] hover:border-halt/60 transition-colors"
        >
          <div class="flex items-start gap-3">
            <div class="flex-1">
              <div class="text-ink-100">{{ o.title }}</div>
              <p class="text-ink-400 mt-1.5 leading-relaxed">{{ story(o) }}</p>
            </div>
            <Chips kind="blast" :value="o.blast_radius" />
          </div>
        </RouterLink>
      </div>
    </section>

    <!-- THE SUBJECT OF THE PAGE: the work branched — what was asked for, what it
         split into, and every attempt each part took. -->
    <section v-if="tree.length" class="space-y-4">
      <RunQueue class="max-w-5xl" :slug="slug" :objectives="objectives" />

    <ProjectTree :nodes="tree" :slug="slug" />
    </section>

    <p v-if="autoResumed.length" class="text-ink-600 text-[12px]">
      {{ autoResumed.length }} objective{{ autoResumed.length > 1 ? 's' : '' }} halted on a reason the
      loop clears by itself — nothing for you to do:
      <span class="num text-ink-500">{{ autoResumed.map((o) => `#${o.id}`).join(', ') }}</span>
    </p>

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
