<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed } from 'vue'
import { api, type Project, type Scan } from '../api'

const emit = defineEmits<{ applied: [] }>()

const scans = ref<Scan[]>([])
const projects = ref<Project[]>([])
const error = ref<string | null>(null)
const open = ref<Record<string, boolean>>({})
const target = ref<Record<string, string>>({})
let poller: ReturnType<typeof setInterval> | null = null

// The newest scan is not necessarily the most useful: a brand-new inventory
// with no distillation hides a complete analysis run just before it. So we show
// the one that has results, and mention the other.
const latest = computed(() => scans.value.find((s) => s.result) ?? scans.value[0] ?? null)
const newerInventory = computed(() => {
  const head = scans.value[0]
  return head && latest.value && head.id !== latest.value.id ? head : null
})
const busyOn = (s: Scan | null) => s && ['pending', 'running'].includes(s.status)

async function load() {
  try {
    ;[scans.value, projects.value] = await Promise.all([api.scans(), api.projects()])
  } catch {
    /* the overview must not go down over this */
  }
}

onMounted(() => {
  load()
  poller = setInterval(() => busyOn(latest.value) && load(), 4000)
})
onBeforeUnmount(() => poller && clearInterval(poller))

async function start() {
  error.value = null
  try {
    scans.value = [await api.createScan(), ...scans.value]
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'the scan could not be requested'
  }
}

async function attach(id: number, name: string, bloc: NonNullable<Scan['result']>[string]) {
  const slug = target.value[name]
  if (!slug) return
  try {
    await api.applyScan(id, slug, {
      title: bloc.title,
      body: [
        bloc.context ?? '',
        bloc.constraints?.length ? '\n**Constraints**\n' + bloc.constraints.map((c) => `- ${c}`).join('\n') : '',
        bloc.contradictions?.length ? '\n**Contradictions found**\n' + bloc.contradictions.map((c) => `- ${c}`).join('\n') : '',
      ]
        .filter(Boolean)
        .join('\n'),
      sources: bloc.sources,
    })
    target.value = { ...target.value, [name]: '' }
    error.value = null
    open.value = { ...open.value, [name]: false }
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'the context could not be attached'
  }
}

/** A readable project id, derived from the name: lowercase, hyphens. */
function toSlug(name: string) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

const exists = (name: string) => projects.value.some((p) => p.slug === toSlug(name))

const repoPath = ref<Record<string, string>>({})

/** The context body, assembled the same way as on apply. */
function body(bloc: NonNullable<Scan['result']>[string]) {
  return [
    bloc.context ?? '',
    bloc.constraints?.length ? '\n**Constraints**\n' + bloc.constraints.map((c) => `- ${c}`).join('\n') : '',
    bloc.contradictions?.length
      ? '\n**Contradictions found**\n' + bloc.contradictions.map((c) => `- ${c}`).join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Creates the project from the distilled context. That was the point of the scan
 * in the first place: discover projects inside the memories, not merely enrich
 * the ones that were declared by hand.
 */
async function createProject(id: number, name: string, bloc: NonNullable<Scan['result']>[string]) {
  try {
    await api.createProjectFromScan(id, {
      slug: toSlug(name),
      name: name,
      repo_path: repoPath.value[name]?.trim() || null,
      title: bloc.title,
      body: body(bloc),
      sources: bloc.sources,
    })
    await load()
    emit('applied')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'the project could not be created'
  }
}

const kb = (n: number) => `${Math.round(n / 1024)} kB`

function waited(min: number) {
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} day${h >= 48 ? 's' : ''}`
}
</script>

<template>
  <section class="card p-5">
    <div class="flex items-start gap-4 flex-wrap">
      <div class="flex-1 min-w-[20rem]">
        <h2 class="text-ink-100 text-[14px]">The memories left on this machine</h2>
        <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
          Project instructions, harness memory, Codex rules: what we learned is scattered and
          nobody rereads it. The scan says
          <strong class="text-ink-300">what exists and where</strong> — that part is free.
          Distilling costs one model call per project and only runs
          <strong class="text-ink-300">when you ask for it</strong>.
        </p>
      </div>
      <button class="btn shrink-0" :disabled="Boolean(busyOn(latest))" @click="start">
        {{ busyOn(latest) ? 'scanning…' : 'analyse the local memories' }}
      </button>
    </div>

    <p v-if="error" class="mt-3 text-fail text-[12px]">{{ error }}</p>

    <p
      v-if="busyOn(latest)"
      class="mt-4 text-[12px]"
      :class="(latest?.waiting_minutes ?? 0) > 5 ? 'text-halt' : 'text-ink-500'"
    >
      <template v-if="(latest?.waiting_minutes ?? 0) > 5">
        <strong>Nobody has picked it up for {{ waited(latest!.waiting_minutes!) }}.</strong>
        No agent is listening on this machine. Run
        <code class="text-ink-300">orchestrator memory:scan --watch --analyse</code> from a tracked
        repository — otherwise this scan waits forever.
      </template>
      <template v-else>
        Waiting for an agent — run
        <code class="text-ink-400">orchestrator memory:scan --watch --analyse</code> on the machine to
        inspect. The disk is only read there, never by the server.
      </template>
    </p>

    <p v-if="latest?.stale" class="mt-3 text-halt text-[12px]">
      The memories have changed since this scan — what it shows is no longer the current state.
    </p>

    <p v-if="newerInventory" class="mt-3 text-ink-500 text-[12px]">
      A newer inventory exists (scan #{{ newerInventory.id }}) but was never distilled. What follows
      comes from scan #{{ latest?.id }}.
    </p>

    <div v-if="latest?.inventory" class="mt-5">
      <div class="label mb-2">
        Found — {{ latest.inventory.total }} files, {{ kb(latest.inventory.bytes) }}
      </div>
      <div
        v-for="(p, name) in latest.inventory.projects"
        :key="name"
        class="flex items-baseline gap-3 py-1 text-[12px] border-b border-ink-850 last:border-0"
      >
        <span class="text-ink-100 flex-1 truncate" :title="String(name)">{{ name }}</span>
        <span class="text-ink-500">{{ p.count }} files</span>
        <span class="text-ink-600 w-16 text-right">{{ kb(p.bytes) }}</span>
      </div>
    </div>

    <div v-if="latest?.result" class="mt-6 space-y-3">
      <div class="flex items-baseline gap-3">
        <span class="label">What was drawn out of it — attach it, or do not</span>
        <span class="num text-ink-600 text-[11px]">{{ Object.keys(latest.result).length }}</span>
      </div>

      <!-- Two columns, and each card packed rather than aligned: ten of these
           read as one wall of identical blocks, three screens tall, on a page
           where nothing else was competing for the width. -->
      <div class="lg:columns-2 gap-3 [column-fill:balance]">
      <article
        v-for="(bloc, name) in latest.result"
        :key="name"
        class="border border-ink-800 rounded p-3.5 mb-3 break-inside-avoid"
        :class="bloc.error ? 'border-fail/40' : ''"
      >
        <header class="flex items-baseline gap-3 flex-wrap">
          <span class="text-ink-100">{{ bloc.title ?? name }}</span>
          <span v-if="bloc.written_to && bloc.written_to !== name" class="label text-ink-600"
            >recorded as {{ bloc.written_to }}</span
          >
          <span v-if="bloc.constraints?.length" class="label text-proof"
            >{{ bloc.constraints.length }} constraints</span
          >
          <span v-if="bloc.contradictions?.length" class="label text-halt"
            >{{ bloc.contradictions.length }} contradictions</span
          >
          <span v-if="bloc.stale?.length" class="label text-ink-500"
            >{{ bloc.stale.length }} stale</span
          >
          <button
            class="label hover:text-run ml-auto"
            @click="open = { ...open, [name]: !open[name] }"
          >
            {{ open[name] ? '▾ collapse' : '▸ read' }}
          </button>
        </header>

        <p v-if="bloc.error" class="text-fail text-[12px] mt-2">{{ bloc.error }}</p>

        <div v-if="open[name]" class="mt-3 space-y-3">
          <pre
            class="p-3 bg-ink-950 border border-ink-800 rounded text-[12px] text-ink-300 whitespace-pre-wrap max-h-80 overflow-y-auto"
            >{{ bloc.context }}</pre
          >
          <ul v-if="bloc.constraints?.length" class="space-y-1">
            <li v-for="c in bloc.constraints" :key="c" class="text-ink-300 text-[12px]">— {{ c }}</li>
          </ul>
          <p v-if="bloc.skipped_count" class="text-ink-600 text-[11px]">
            {{ bloc.skipped_count }} file(s) set aside, too large to read in one pass.
          </p>
          <p class="text-ink-600 text-[11px]">{{ bloc.sources_count ?? bloc.sources?.length ?? 0 }} file(s) read.</p>
        </div>

        <div v-if="!bloc.error" class="mt-3 space-y-2">
          <div v-if="exists(String(name))" class="flex items-center gap-2 flex-wrap">
            <span class="label text-proof">project already tracked</span>
            <select
              v-model="target[name]"
              class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
            >
              <option value="">attach to project…</option>
              <option v-for="p in projects" :key="p.slug" :value="p.slug">{{ p.name }}</option>
            </select>
            <button class="btn" :disabled="!target[name]" @click="attach(latest!.id, String(name), bloc)">
              make it a project decision
            </button>
            <span class="text-ink-600 text-[11px]"
              >the agent rereads it on every brief — that is the whole point</span
            >
          </div>

          <div v-else class="flex items-center gap-2 flex-wrap">
            <span class="label text-halt">project not tracked</span>
            <code class="text-[11px] text-ink-500">{{ toSlug(String(name)) }}</code>
            <input
              v-model="repoPath[name]"
              placeholder="repository path (optional)"
              class="flex-1 min-w-[16rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
            />
            <button class="btn" @click="createProject(latest!.id, String(name), bloc)">
              create this project
            </button>
          </div>
        </div>
      </article>
      </div>
    </div>
  </section>
</template>
