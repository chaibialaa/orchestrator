<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { api, type Blocker } from '../api'

/**
 * What needs a person, above everything else on the page.
 *
 * Every entry here was, until today, only visible inside a log file: a closed
 * Unity editor, a project with four allowed tools out of sixty, a loop that
 * stopped an hour ago. Each of those cost money before anyone noticed. The
 * panel earns its place only if it names the action, so it always does.
 */
withDefaults(defineProps<{ columns?: number }>(), { columns: 1 })

const list = ref<Blocker[]>([])
const failed = ref(false)
let timer: number | undefined

async function load() {
  try {
    list.value = await api.blockers()
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

const blocking = computed(() => list.value.filter((b) => b.severity === 'blocking'))
const warnings = computed(() => list.value.filter((b) => b.severity === 'warning'))

/**
 * One card per KIND, with the projects it affects listed inside.
 *
 * Six entries filled the screen with the same paragraph written out four times,
 * once per project — the reader had to compare four blocks to notice they were
 * identical. The condition is the thing; which projects have it is a detail of it.
 */
const groups = computed(() => {
  const out = new Map<string, { key: string; severity: string; title: string; detail: string; action: string; items: Blocker[] }>()
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
      })
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
  <section v-if="list.length" class="card p-5">
    <header class="flex items-baseline gap-3">
      <h2 class="text-ink-100 text-[14px]">What's in the way</h2>
      <span v-if="blocking.length" class="label text-fail">
        {{ blocking.length }} blocking
      </span>
      <span v-if="warnings.length" class="label text-ink-500">{{ warnings.length }} to watch</span>
    </header>

    <p class="text-ink-500 mt-1.5 text-[12px] max-w-3xl">
      Conditions that make a pass fail before it starts — a closed editor, an empty allow list, a
      storage nobody connected. Derived from the same traces the loop reads; halts have their own
      section below.
    </p>

    <ul class="mt-4 space-y-2.5" :class="columns > 1 ? 'lg:columns-2 lg:space-y-0 gap-2.5' : ''">
      <li
        v-for="g in groups"
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
      </li>
    </ul>

    <p v-if="failed" class="text-ink-600 text-[11px] mt-3">
      The list could not be refreshed — what you see may be stale.
    </p>
  </section>
</template>
