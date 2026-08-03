<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { api, type Blocker } from '../api'
import { statusLabel } from '../labels'

/**
 * What needs a person, above everything else on the page.
 *
 * Every entry here was, until today, only visible inside a log file: a closed
 * Unity editor, a project with four allowed tools out of sixty, a loop that
 * stopped an hour ago. Each of those cost money before anyone noticed. The
 * panel earns its place only if it names the action, so it always does.
 */
/**
 * `project` / `objective` narrow it to the screen it is on. Unscoped, it is the
 * overview panel it has always been.
 */
const props = withDefaults(
  defineProps<{ columns?: number; project?: string; objective?: number; compact?: boolean }>(),
  { columns: 1 },
)

const list = ref<Blocker[]>([])
const failed = ref(false)
let timer: number | undefined

async function load() {
  try {
    list.value = await api.blockers({ project: props.project, objective: props.objective })
    failed.value = false
  } catch {
    failed.value = true
  }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 20000)
})
onUnmounted(() => window.clearInterval(timer))
watch(() => [props.project, props.objective], load)

const blocking = computed(() => list.value.filter((b) => b.severity === 'blocking'))
const warnings = computed(() => list.value.filter((b) => b.severity === 'warning'))

/**
 * One card per KIND, with the projects it affects listed inside.
 *
 * Six entries filled the screen with the same paragraph written out four times,
 * once per project — the reader had to compare four blocks to notice they were
 * identical. The condition is the thing; which projects have it is a detail of it.
 */
/**
 * The watch list, folded away until asked for.
 *
 * Six of the eight conditions here describe something that will never change —
 * a harness that is never handed its rules, two MCP versions side by side — and
 * they were the tallest thing on the page, pushing the four projects the tool
 * manages below the fold. What blocks a pass stays open; what is merely worth
 * knowing waits to be asked.
 */
const showWatch = ref(false)

/** Copying a list is an action taken here, so its outcome is reported here. */
const copying = ref<string | null>(null)
const copyFailed = ref<string | null>(null)

/**
 * Errands asked from this panel, and what became of them.
 *
 * The card named a condition it could not lift: "open Blockrise in Unity" on a
 * screen with no way to open anything. The worker in the repository can, so the
 * button asks it — and then says what happened, because an editor takes a minute
 * or two to import before the condition clears on its own.
 */
const asking = ref<string | null>(null)
const asked = ref<Record<string, string>>({})

async function ask(project: string, kind: string) {
  asking.value = `${project}:${kind}`
  try {
    const c = await api.askChore(project, kind)
    asked.value = {
      ...asked.value,
      [`${project}:${kind}`]:
        c.status === 'failed'
          ? (c.detail ?? 'it did not work')
          : 'asked — the worker picks it up within seconds, then Unity takes a minute to import',
    }
  } catch (e: any) {
    asked.value = {
      ...asked.value,
      [`${project}:${kind}`]: e?.response?.data?.message ?? e?.message ?? 'the request was refused',
    }
  } finally {
    asking.value = null
  }
}

async function copyList(project: string, from: string) {
  copying.value = `${project}:${from}`
  copyFailed.value = null
  try {
    await api.copyPermissions(project, from)
    await load()
  } catch (e: any) {
    copyFailed.value = e?.response?.data?.message ?? e?.message ?? 'the copy was refused'
  } finally {
    copying.value = null
  }
}

type Group = {
  key: string
  severity: string
  title: string
  detail: string
  action: string
  items: Blocker[]
  /** Every objective the grouped conditions are holding up, once each. */
  stops: { id: number; title: string; status: string }[]
}

const groups = computed(() => {
  const out = new Map<string, Group>()
  for (const b of [...blocking.value, ...warnings.value]) {
    const key = `${b.kind}:${b.group ?? b.title}`
    const g = out.get(key)
    if (g) g.items.push(b)
    else
      out.set(key, {
        key,
        severity: b.severity,
        title: b.group ?? b.title,
        detail: b.detail,
        action: b.action,
        items: [b],
        stops: [],
      })
    const into = out.get(key)!
    for (const s of b.stops ?? []) if (!into.stops.some((x) => x.id === s.id)) into.stops.push(s)
  }
  return [...out.values()]
})

function ago(iso: string | null) {
  if (!iso) return null
  const s = Math.round((Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
</script>

<template>
  <!-- Nothing to show is itself the message: no empty state, no reassurance box. -->
  <section
    v-if="list.length"
    class="card"
    :class="groups.some((x) => x.severity === 'blocking' || showWatch) ? 'p-5' : 'px-5 py-3'"
  >
    <header class="flex items-baseline gap-3">
      <h2 class="text-ink-100 text-[14px]">
        {{ objective ? 'Why this is not moving' : "What's in the way" }}
      </h2>
      <span v-if="blocking.length" class="label text-fail">
        {{ blocking.length }} blocking
      </span>
      <button
        v-if="warnings.length"
        class="label text-ink-500 hover:text-ink-300 transition-colors"
        @click="showWatch = !showWatch"
      >
        {{ warnings.length }} to watch {{ showWatch ? '\u2303' : '\u2304' }}
      </button>
    </header>

    <p v-if="!compact" class="text-ink-500 mt-1.5 text-[12px] max-w-3xl">
      Conditions that make a pass fail before it starts — a closed editor, an empty allow list, a
      storage nobody connected. Derived from the same traces the loop reads<span v-if="!project && !objective"
        >; halts have their own section below</span
      >.
    </p>

    <!-- Nothing to draw when every condition is folded away: the header already
         says how many there are, and an empty box under it reads as broken. -->
    <ul
      v-if="groups.some((x) => x.severity === 'blocking' || showWatch)"
      class="mt-4 space-y-2.5"
      :class="columns > 1 ? 'lg:columns-2 lg:space-y-0 gap-2.5' : ''"
    >
      <li
        v-for="g in groups.filter((x) => x.severity === 'blocking' || showWatch)"
        :key="g.key"
        class="border rounded p-3 break-inside-avoid mb-2.5"
        :class="g.severity === 'blocking' ? 'border-fail/40 bg-fail/5' : 'border-ink-800'"
      >
        <div class="flex items-baseline gap-2.5 flex-wrap">
          <span
            class="w-1.5 h-1.5 rounded-full self-center shrink-0"
            :class="g.severity === 'blocking' ? 'bg-fail' : 'bg-ink-600'"
          />
          <span class="text-ink-100 text-[13px]">{{ g.title }}</span>

          <!-- Who it applies to, as a list rather than as N repetitions. -->
          <span
            v-for="b in g.items"
            :key="`${b.project}-${b.objective ?? ''}`"
            class="chip border-ink-700 text-ink-400"
          >
            {{ b.project ?? 'everywhere' }}
            <RouterLink v-if="b.objective" :to="`/o/${b.objective}`" class="text-run hover:underline">
              #{{ b.objective }}
            </RouterLink>
            <span v-if="ago(b.since)" class="text-ink-600">{{ ago(b.since) }}</span>
          </span>
        </div>

        <!-- Said once, at a length a person reads rather than scans past. -->
        <p class="text-ink-400 text-[12px] mt-1.5 leading-relaxed max-w-[68ch]">{{ g.detail }}</p>
        <p class="text-ink-200 text-[12px] mt-1.5 max-w-[68ch]">→ {{ g.action }}</p>

        <!-- The way to do it, on the card that asks for it.
             Every action here was a sentence and nothing else: "open Permissions"
             on a screen that does not link to Permissions, for a project it does
             not name. The reader had to know the app to obey the instruction. -->
        <div
          v-if="g.items.some((b) => b.link || b.chore || b.copy_from?.length)"
          class="mt-2.5 flex flex-wrap items-center gap-1.5"
        >
          <!-- The condition, lifted from the card that states it. -->
          <template v-for="b in g.items.filter((x) => x.chore)" :key="`ch${b.project}`">
            <button
              class="chip border-run/60 text-run hover:bg-run/10 transition-colors"
              :disabled="asking === `${b.project}:${b.chore!.kind}`"
              @click="ask(b.project!, b.chore!.kind)"
            >
              {{ asking === `${b.project}:${b.chore!.kind}` ? '…' : b.chore!.label }}
              <span v-if="g.items.length > 1" class="text-ink-500 ml-1">{{ b.project }}</span>
            </button>
            <span
              v-if="asked[`${b.project}:${b.chore!.kind}`]"
              class="text-ink-400 text-[11px]"
            >
              {{ asked[`${b.project}:${b.chore!.kind}`] }}
            </span>
          </template>

          <RouterLink
            v-for="b in g.items.filter((x) => x.link)"
            :key="`l${b.project}${b.kind}`"
            :to="b.link!.to"
            class="chip border-ink-600 text-ink-200 hover:border-run hover:text-run transition-colors"
          >
            {{ b.link!.label }}<span v-if="g.items.length > 1" class="text-ink-500 ml-1">{{ b.project }}</span> ▸
          </RouterLink>

          <!-- One click, because the whole condition is "this list is empty and
               another project has a good one". -->
          <template v-for="b in g.items.filter((x) => x.copy_from?.length)" :key="`c${b.project}`">
            <span class="label text-ink-600">or copy from</span>
            <button
              v-for="src in b.copy_from"
              :key="src.slug"
              class="chip border-ink-700 text-ink-300 hover:border-proof hover:text-proof transition-colors"
              :disabled="copying === `${b.project}:${src.slug}`"
              @click="copyList(b.project!, src.slug)"
            >
              {{ copying === `${b.project}:${src.slug}` ? '…' : src.name }}
              <span class="num text-ink-600">{{ src.n }}</span>
            </button>
          </template>
        </div>
        <p v-if="copyFailed" class="text-fail text-[11px] mt-1.5">{{ copyFailed }}</p>

        <!-- What it is holding up, by name.
             "The Unity editor is closed" is a fact about a machine. "Chapter 3
             has not moved because of it" is the reason to go and open it, and it
             was nowhere on any screen: the condition lived on the overview, the
             stalled chapter three clicks away, and nothing joined the two. -->
        <p v-if="!objective && g.stops.length" class="mt-2 flex items-baseline gap-1.5 flex-wrap">
          <!-- Legible on the red card it sits in. Ink-600 on ink-950 is a grey
               made for a dark background; over bg-fail/5 it reads as disabled —
               the most important line of the card, styled like a footnote. -->
          <span class="label text-fail/80 mr-0.5">at a standstill</span>
          <RouterLink
            v-for="s in g.stops"
            :key="s.id"
            :to="`/o/${s.id}`"
            class="chip border-fail/40 text-ink-200 hover:border-run hover:text-run transition-colors"
          >
            <span class="num text-ink-500">#{{ s.id }}</span>
            {{ s.title }}
            <span class="text-ink-500">{{ statusLabel[s.status] ?? s.status }}</span>
          </RouterLink>
        </p>
      </li>
    </ul>

    <p v-if="failed" class="text-ink-600 text-[11px] mt-3">
      The list could not be refreshed — what you see may be stale.
    </p>
  </section>
</template>
