<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { http } from '../api'

const props = defineProps<{ slug: string }>()

type Decision = 'allow' | 'deny' | 'ask'

interface Perm {
  id: number
  pattern: string
  decision: Decision
  harness: string
  label: string | null
  note: string | null
  requested: number
  last_requested_at: string | null
}

const perms = ref<Perm[]>([])
const loading = ref(true)
const filter = ref('')

async function load() {
  loading.value = true
  perms.value = (await http.get<Perm[]>(`/projects/${props.slug}/permissions`)).data
  loading.value = false
}

onMounted(load)
watch(() => props.slug, load)

async function setDecision(p: Perm, decision: Decision) {
  if (p.decision === decision) return
  const updated = (await http.patch<Perm>(`/permissions/${p.id}`, { decision })).data
  Object.assign(p, updated)
}

async function setFamily(harness: string, family: string, decision: Decision) {
  const targets = grouped.value[harness][family].filter((p) => p.decision !== decision)
  for (const p of targets) await setDecision(p, decision)
}

const q = computed(() => filter.value.trim().toLowerCase())

const visible = computed(() =>
  q.value
    ? perms.value.filter(
        (p) => p.pattern.toLowerCase().includes(q.value) || (p.label ?? '').toLowerCase().includes(q.value),
      )
    : perms.value,
)

/**
 * By harness first, then by family of tool.
 *
 * Two things were wrong here. It grouped on `p.family` — a field declared on the
 * interface and sent by nobody, so all 66 rules fell into one group headed, in
 * full, “undefined 66”. And it interleaved harnesses with nothing to tell them
 * apart, so `Bash(git push*)` appeared as allowed under “Never” and refused
 * under another heading, reading as a contradiction. It is not one: Claude may
 * push here, Codex may not. Whose rule it is was the missing word.
 */
const grouped = computed(() => {
  const out: Record<string, Record<string, Perm[]>> = {}
  for (const p of visible.value) {
    const byFamily = (out[p.harness] ??= {})
    ;(byFamily[p.label ?? 'Ungrouped'] ??= []).push(p)
  }
  return out
})

const pending = computed(() => perms.value.filter((p) => p.decision === 'ask'))
const counts = computed(() => ({
  allow: perms.value.filter((p) => p.decision === 'allow').length,
  deny: perms.value.filter((p) => p.decision === 'deny').length,
  ask: pending.value.length,
}))

const decisionStyle: Record<Decision, string> = {
  allow: 'border-proof text-proof bg-proof/10',
  deny: 'border-fail text-fail bg-fail/10',
  ask: 'border-halt text-halt bg-halt/10',
}

const decisionLabel: Record<Decision, string> = {
  allow: 'allowed',
  deny: 'refused',
  ask: 'undecided',
}
</script>

<template>
  <div class="space-y-7">
    <section class="card p-4 border-ink-800">
      <div class="flex items-start gap-4">
        <div class="flex-1">
          <h1 class="text-ink-100 text-[15px]">Permissions</h1>
          <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
            What agents are allowed to do on this project. You decide
            <strong class="text-ink-300">here, once</strong>, and it is written into the harness
            configuration — instead of being re-approved at every step.
            A session running with nobody at the screen cannot ask for anything: whatever is not
            allowed here is simply refused.
          </p>
          <!-- Rules that hold nothing back must not look like rules that do. -->
          <p class="text-halt mt-2 max-w-3xl text-[12px]">
            True of Claude. <strong>Not of Codex</strong>: it is launched with approvals and sandbox
            bypassed — the only way it reaches Unity unattended — so it is never handed this list.
            Its rules below are documentation, not a barrier — except pushing, which some
            repositories now refuse on their own. Check the blockers on the overview: they read the
            hook from disk rather than take anyone's word for it.
          </p>
        </div>
        <input
          v-model="filter"
          placeholder="filter…"
          class="shrink-0 bg-ink-900 border border-ink-700 rounded px-2.5 py-1 text-[12px] w-52 focus:outline-none focus:border-ink-600"
        />
      </div>

      <div class="flex items-center gap-5 mt-4 text-[12px]">
        <span class="text-proof">{{ counts.allow }} allowed</span>
        <span class="text-fail">{{ counts.deny }} refused</span>
        <span :class="counts.ask ? 'text-halt' : 'text-ink-600'">{{ counts.ask }} undecided</span>
        <span class="ml-auto text-ink-600">
          Write into the harness:
          <code class="text-ink-400">orchestrator permissions:sync</code>
        </span>
      </div>
    </section>

    <section v-if="pending.length">
      <h2 class="text-halt text-[14px] mb-1">Undecided — {{ pending.length }}</h2>
      <p class="text-ink-400 mb-3">
        Sessions asked for these tools and did not get them. Until they are decided, every turn
        runs into the same wall.
      </p>
      <div class="card divide-y divide-ink-800 border-halt/35">
        <div v-for="p in pending" :key="p.id" class="p-3 flex items-center gap-3 flex-wrap">
          <code class="text-ink-100 flex-1">{{ p.pattern }}</code>
          <span v-if="p.requested" class="text-ink-600 text-[11px]"
            >asked {{ p.requested }} times</span
          >
          <div class="flex gap-1">
            <button
              v-for="d in (['allow', 'deny'] as Decision[])"
              :key="d"
              class="chip"
              :class="p.decision === d ? decisionStyle[d] : 'border-ink-600 text-ink-400 hover:text-ink-100'"
              @click="setDecision(p, d)"
            >
              {{ decisionLabel[d] }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <div v-if="loading" class="text-ink-400">loading…</div>

    <section v-for="(families, harness) in grouped" :key="harness" class="space-y-5">
      <div class="flex items-baseline gap-3 border-b border-ink-800 pb-1.5">
        <h2 class="text-ink-100 text-[15px]">{{ harness }}</h2>
        <span class="num text-ink-600 text-[11px]">
          {{ Object.values(families).flat().length }} rules
        </span>
        <!-- Said where it changes what you are looking at, not only at the top. -->
        <span v-if="harness === 'codex'" class="text-halt text-[11px]">
          never handed to it — these are documentation
        </span>
      </div>

      <section v-for="(list, family) in families" :key="`${harness}-${family}`">
        <div class="flex items-baseline gap-3 mb-2">
          <h3 class="text-ink-300 text-[13px]">{{ family }}</h3>
          <span class="num text-ink-600 text-[11px]">{{ list.length }}</span>
          <div class="ml-auto flex gap-1.5">
            <button
              class="chip border-ink-700 text-ink-500 hover:text-proof"
              @click="setFamily(harness, family, 'allow')"
            >
              allow all
            </button>
            <button
              class="chip border-ink-700 text-ink-500 hover:text-fail"
              @click="setFamily(harness, family, 'deny')"
            >
              refuse all
            </button>
          </div>
        </div>

        <!-- Rules on a grid. One per line meant a 20-character pattern stretched
             across 900px to reach its three buttons, and a family of 45 rules
             that scrolled for three screens. -->
        <div class="grid gap-x-3 md:grid-cols-2 2xl:grid-cols-3 card p-1.5">
          <div
            v-for="p in list"
            :key="p.id"
            class="px-2 py-1.5 flex items-center gap-3 rounded hover:bg-ink-850/40 transition-colors"
          >
            <span
              class="w-1.5 h-1.5 rounded-full shrink-0"
              :class="{
                'bg-proof': p.decision === 'allow',
                'bg-fail': p.decision === 'deny',
                'bg-halt': p.decision === 'ask',
              }"
            />
            <code class="text-ink-300 flex-1 truncate" :title="p.pattern">{{ p.pattern }}</code>
            <div class="flex gap-1 shrink-0">
              <button
                v-for="d in (['allow', 'ask', 'deny'] as Decision[])"
                :key="d"
                class="chip"
                :class="p.decision === d ? decisionStyle[d] : 'border-ink-700 text-ink-600 hover:text-ink-300'"
                @click="setDecision(p, d)"
              >
                {{ decisionLabel[d] }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </section>

    <p v-if="!loading && !perms.length" class="text-ink-600">
      No permissions recorded yet. They show up here as soon as a session asks for one.
    </p>
  </div>
</template>
