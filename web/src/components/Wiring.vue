<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { api, type Wiring, type McpServer } from '../api'

/**
 * What is connected, and what is actually used.
 *
 * Two different questions, and the screen answered neither. A tool can be
 * reachable and never called — a declaration nobody exercises is a guess. And a
 * tool can be called constantly while its entry reads `unknown`, which is how
 * Codex spent weeks looking incapable of driving Unity.
 *
 * Reachability is measured on a machine by `agents:check`; use is derived from the
 * harness traces. Neither is declared, and the screen says which is which.
 */
const data = ref<Wiring | null>(null)
const servers = ref<McpServer[]>([])
let timer: number | undefined

async function load() {
  try {
    data.value = await api.wiring()
    servers.value = await api.mcp()
  } catch {
    /* the wiring failing to load must not take the page down */
  }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 30000)
})
onUnmounted(() => window.clearInterval(timer))

const REACH = {
  ok: { word: 'reachable', color: 'text-proof', dot: 'bg-proof' },
  refused: { word: 'present but refusing', color: 'text-halt', dot: 'bg-halt' },
  absent: { word: 'not found', color: 'text-fail', dot: 'bg-fail' },
  unknown: { word: 'never checked', color: 'text-ink-500', dot: 'bg-ink-700' },
} as const

const KIND = {
  model: 'model',
  machine: 'machine, billed by the hour',
  service: 'service',
  browser: 'web interface',
  source: 'material to draw on',
} as const

const opened = ref<Set<string>>(new Set())
function toggle(name: string) {
  const s = new Set(opened.value)
  s.has(name) ? s.delete(name) : s.add(name)
  opened.value = s
}

/** `mcp__UnityMCP__manage_scene` reads as `manage_scene` once you know the server. */
const shortName = (t: string) => t.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
</script>

<template>
  <section v-if="data" class="card p-5 max-w-5xl">
    <h2 class="text-ink-100 text-[14px]">What is wired up</h2>
    <p class="text-ink-400 mt-1.5 max-w-3xl">
      Reachability is measured on the machine, not ticked in a form. Use is counted from what the
      harnesses actually called.
    </p>

    <!-- WHO CAN WORK -->
    <div class="mt-5">
      <div class="label mb-2">Connected AI</div>
      <div class="divide-y divide-ink-850">
        <div v-for="a in data.agents" :key="a.name" class="py-2.5 flex items-baseline gap-3 flex-wrap">
          <span class="w-1.5 h-1.5 rounded-full self-center shrink-0" :class="REACH[a.reachable].dot" />
          <span class="text-ink-100 min-w-[11rem]" :class="a.enabled ? '' : 'opacity-50'">
            {{ a.label }}
          </span>
          <span class="text-ink-500 text-[11px] w-[13rem]">{{ a.kind ? KIND[a.kind] : '—' }}</span>
          <span class="text-[11px]" :class="REACH[a.reachable].color">{{ REACH[a.reachable].word }}</span>

          <span v-if="a.capabilities.length" class="text-ink-600 text-[11px]">
            {{ a.capabilities.join(' · ') }}
          </span>

          <!-- Declared vs exercised. A capability nobody has run is a guess. -->
          <span
            class="num text-[11px] ml-auto"
            :class="a.passes ? 'text-ink-400' : 'text-ink-700'"
            :title="a.passes ? 'attempts actually run by this harness' : 'never used yet'"
          >
            {{ a.passes ? `${a.passes} passes` : 'never used' }}
          </span>
        </div>
      </div>
      <p class="text-ink-600 text-[11px] mt-2">
        Not checked in a while? Run
        <code class="text-ink-500">orchestrator agents:check</code> on the machine concerned.
      </p>
    </div>

    <!-- WHAT IS WIRED, as opposed to what was called. A server nobody reached
         looked exactly like a server that does not exist, and the difference is
         the whole diagnosis. -->
    <div v-if="servers.length" class="mt-6">
      <div class="label mb-2">MCP servers each harness is configured with</div>
      <div class="divide-y divide-ink-850">
        <div v-for="s in servers" :key="s.name" class="py-2.5">
          <div class="flex items-baseline gap-3 flex-wrap">
            <span
              class="w-1.5 h-1.5 rounded-full self-center shrink-0"
              :class="s.disagrees ? 'bg-halt' : 'bg-ink-600'"
            />
            <span class="text-ink-100">{{ s.name }}</span>
            <span v-if="s.aliases.length > 1" class="text-ink-700 text-[11px]">
              also {{ s.aliases.filter((a) => a !== s.name).join(', ') }}
            </span>
            <span v-if="s.disagrees" class="text-halt text-[11px]">versions differ</span>
            <span v-else-if="s.versions.length" class="num text-ink-500 text-[11px]">
              {{ s.versions[0] }}
            </span>
            <span v-else class="text-ink-700 text-[11px]">no version pinned</span>
          </div>

          <!-- Only spelled out when it matters: who is on what. -->
          <div v-if="s.disagrees" class="mt-1.5 pl-4.5 space-y-0.5">
            <div v-for="(e, i) in s.entries" :key="i" class="flex items-baseline gap-3 text-[11px]">
              <span class="text-ink-400 w-14">{{ e.harness }}</span>
              <span class="num text-ink-600 flex-1 truncate">
                {{ e.scope ? e.scope.split('/').pop() : 'globally' }}
              </span>
              <span class="num" :class="e.pin ? 'text-ink-300' : 'text-ink-700'">
                {{ e.pin ? e.pin.version : '—' }}
              </span>
            </div>
          </div>
        </div>
      </div>
      <p class="text-ink-600 text-[11px] mt-2 max-w-[68ch]">
        Read from the harnesses' own files — ~/.claude.json and ~/.codex/config.toml. Orchestrator
        keeps no copy: one would drift the first time somebody edited the real thing.
      </p>
    </div>

    <!-- WHAT THEY REACHED THROUGH -->
    <div class="mt-6">
      <div class="label mb-2">Tool surfaces, by how much they were used</div>

      <p v-if="!data.servers.length" class="text-ink-500 text-[12px]">
        Nothing counted yet. Tool counts are only recorded from passes run after they started being
        collected — the earlier ones went unmeasured.
      </p>

      <div v-else class="divide-y divide-ink-850">
        <div v-for="s in data.servers" :key="s.name">
          <button class="w-full py-2.5 flex items-baseline gap-3 text-left" @click="toggle(s.name)">
            <span class="text-ink-500 text-[11px]">{{ opened.has(s.name) ? '▾' : '▸' }}</span>
            <span class="text-ink-100">{{ s.name }}</span>
            <span class="text-ink-600 text-[11px]">{{ s.tools.length }} tools</span>
            <span class="num text-ink-400 text-[12px] ml-auto">{{ s.calls }} calls</span>
          </button>

          <div v-if="opened.has(s.name)" class="pb-3 pl-6 space-y-1">
            <div v-for="t in s.tools" :key="t.tool" class="flex items-baseline gap-3 text-[11px]">
              <span class="num text-ink-500 w-12 text-right">{{ t.calls }}</span>
              <span class="text-ink-300">{{ shortName(t.tool) }}</span>
              <span class="text-ink-600">
                {{ Object.entries(t.by).map(([h, n]) => `${h} ${n}`).join(' · ') }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
