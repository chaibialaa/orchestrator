<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type Agent } from '../api'

const agents = ref<Agent[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const keyDraft = ref<Record<number, string>>({})

async function load() {
  loading.value = true
  try {
    agents.value = await api.agents()
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? e?.message ?? 'error'
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function patch(a: Agent, field: string, value: unknown) {
  try {
    Object.assign(a, await api.updateAgent(a.id, { [field]: value } as any))
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not save'
  }
}

async function setKey(a: Agent) {
  const k = (keyDraft.value[a.id] ?? '').trim()
  try {
    Object.assign(a, await api.updateAgent(a.id, { api_key: k }))
    keyDraft.value = { ...keyDraft.value, [a.id]: '' }
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'key refused'
  }
}

async function move(i: number, to: number) {
  if (to < 0 || to >= agents.value.length) return
  const l = [...agents.value]
  const [taken] = l.splice(i, 1)
  l.splice(to, 0, taken)
  agents.value = l.map((a, n) => ({ ...a, priority: (n + 1) * 10 }))
  await api
    .reorderAgents(agents.value.map((a) => ({ id: a.id, priority: a.priority })))
    .catch(() => {
      error.value = 'the order could not be saved'
      load()
    })
}

const draft = ref({ name: '', label: '', reach: 'cli' as Agent['reach'] })

async function create() {
  if (!draft.value.name.trim() || !draft.value.label.trim()) return
  try {
    const a = await api.createAgent({
      ...draft.value,
      role: 'executant',
      priority: (agents.value.length + 1) * 10,
    })
    agents.value = [...agents.value, a]
    draft.value = { name: '', label: '', reach: 'cli' }
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not create it'
  }
}

async function remove(a: Agent) {
  await api.deleteAgent(a.id).catch(() => undefined)
  agents.value = agents.value.filter((x) => x.id !== a.id)
}

const REACH: Record<Agent['reach'], { label: string; help: string }> = {
  cli: {
    label: 'locally',
    help: 'Started on your machine by the agent. Nothing to configure here: the binary and its options stay in the repository .orchestrator.json.',
  },
  browser: {
    label: 'through the browser',
    help: 'Reached over the Chrome debugging protocol, on a dedicated profile. That Chrome has to be running and a tab has to match.',
  },
  api: {
    label: 'by key',
    help: 'Called directly by the server with a key. Works even when the server is hosted somewhere other than your machine.',
  },
}

/**
 * What a connected AI IS, beyond what it can do. They do not fail the same way: a
 * rented machine keeps billing until it is shut down, a web interface refuses on
 * quota and says nothing useful about it. A mission that treats them as
 * interchangeable wastes one of them.
 */
const KINDS: Record<string, string> = {
  model: 'A model',
  machine: 'A machine billed by the hour',
  service: 'A service',
  browser: 'A web interface, driven through a tab',
}

const ROLES: Record<Agent['role'], string> = {
  executant: 'Does the work',
  judge: 'Judges the work',
  both: 'Does and judges',
}

const STATE: Record<Agent['last_status'], { label: string; color: string; dot: string }> = {
  ok: { label: 'reachable', color: 'text-proof', dot: 'bg-proof' },
  absent: { label: 'not found', color: 'text-fail', dot: 'bg-fail' },
  refused: { label: 'present but unusable', color: 'text-halt', dot: 'bg-halt' },
  unknown: { label: 'never checked', color: 'text-ink-500', dot: 'bg-ink-700' },
}

function when(iso: string | null): string {
  if (!iso) return 'never'
  // Two formats reach this point: some dates already carry their zone, the ones
  // read straight from SQL do not. Appending a Z blindly produced NaN.
  const raw = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z'
  const min = Math.round((Date.now() - new Date(raw).getTime()) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

const judges = computed(() => agents.value.filter((a) => a.enabled && a.role !== 'executant'))
const doers = computed(() => agents.value.filter((a) => a.enabled && a.role !== 'judge'))
</script>

<template>
  <div v-if="loading" class="text-ink-400">loading…</div>
  <div v-else class="space-y-7">
    <section class="card p-4 border-ink-800">
      <h1 class="text-ink-100 text-[15px]">Connected AI</h1>
      <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
        Who can work, who can judge, and which one we prefer when the driving conversation names
        nobody. <strong class="text-ink-300">Reachable</strong> is not a box you tick here: it is
        <strong class="text-ink-300">observed on the machine</strong> by
        <code class="text-ink-300">orchestrator agents:check</code> — a missing binary or a closed
        Chrome are not declared, they are seen.
      </p>
      <p class="text-ink-500 mt-2.5 text-[12px] max-w-3xl">
        The server never stores a command to run. It says who exists and how to reach them; the
        binary, its path and its options stay in each repository's
        <code>.orchestrator.json</code>.
      </p>
    </section>

    <p v-if="error" class="card p-3 border-fail/40 text-fail">{{ error }}</p>

    <section class="grid sm:grid-cols-2 gap-3">
      <div class="card p-3.5">
        <div class="label">Can execute</div>
        <div class="text-ink-300 mt-1.5">
          {{ doers.map((a) => a.label).join(' · ') || 'none' }}
        </div>
      </div>
      <div class="card p-3.5">
        <div class="label">Can judge</div>
        <div class="text-ink-300 mt-1.5">
          {{ judges.map((a) => a.label).join(' · ') || 'none — nobody can conclude' }}
        </div>
      </div>
    </section>

    <section class="space-y-3">
      <article
        v-for="(a, i) in agents"
        :key="a.id"
        class="card p-4"
        :class="a.enabled ? '' : 'opacity-50'"
      >
        <div class="flex items-start gap-3">
          <div class="flex flex-col gap-0.5 pt-1">
            <button
              class="text-ink-600 hover:text-ink-100 leading-none text-[11px] disabled:opacity-25"
              :disabled="i === 0"
              title="prefer more"
              @click="move(i, i - 1)"
            >
              ▲
            </button>
            <button
              class="text-ink-600 hover:text-ink-100 leading-none text-[11px] disabled:opacity-25"
              :disabled="i === agents.length - 1"
              title="prefer less"
              @click="move(i, i + 1)"
            >
              ▼
            </button>
          </div>

          <div class="flex-1 min-w-0 space-y-3">
            <div class="flex items-baseline gap-3 flex-wrap">
              <span
                class="w-1.5 h-1.5 rounded-full shrink-0 self-center"
                :class="STATE[a.last_status].dot"
              />
              <input
                class="bg-transparent text-ink-100 border-b border-transparent hover:border-ink-700 focus:border-run focus:outline-none flex-1 min-w-[14rem] max-w-[22rem]"
                :value="a.label"
                @change="patch(a, 'label', ($event.target as HTMLInputElement).value)"
              />
              <code class="text-ink-600 text-[11px] shrink-0">{{ a.name }}</code>
              <span class="label ml-auto" :class="STATE[a.last_status].color">
                {{ STATE[a.last_status].label }}
              </span>
              <label class="flex items-center gap-1.5 text-[11px] text-ink-400">
                <input
                  type="checkbox"
                  :checked="a.enabled"
                  @change="patch(a, 'enabled', ($event.target as HTMLInputElement).checked)"
                />
                active
              </label>
            </div>

            <p class="text-ink-500 text-[11px]">
              {{ a.last_detail ?? 'never checked' }}
              <template v-if="a.last_machine">
                · checked {{ when(a.last_checked_at) }} on {{ a.last_machine }}
              </template>
            </p>

            <div class="flex items-center gap-4 flex-wrap">
              <label class="flex items-center gap-2">
                <span class="label">Reach</span>
                <select
                  class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                  :value="a.reach"
                  @change="patch(a, 'reach', ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="(v, k) in REACH" :key="k" :value="k">{{ v.label }}</option>
                </select>
              </label>
              <label class="flex items-center gap-2">
                <span class="label">Nature</span>
                <select
                  class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                  :value="a.kind ?? ''"
                  @change="patch(a, 'kind', ($event.target as HTMLSelectElement).value || null)"
                >
                  <option value="">not stated</option>
                  <option v-for="(v, k) in KINDS" :key="k" :value="k">{{ v }}</option>
                </select>
              </label>
              <label class="flex items-center gap-2">
                <span class="label">Role</span>
                <select
                  class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                  :value="a.role"
                  @change="patch(a, 'role', ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="(v, k) in ROLES" :key="k" :value="k">{{ v }}</option>
                </select>
              </label>
              <span class="text-ink-600 text-[11px]">preference #{{ i + 1 }}</span>
              <button class="label hover:text-fail ml-auto" @click="remove(a)">remove</button>
            </div>

            <p class="text-ink-500 text-[11px]">{{ REACH[a.reach].help }}</p>

            <div v-if="a.reach === 'api'" class="flex items-center gap-2 flex-wrap">
              <span class="label">Key</span>
              <span v-if="a.has_key" class="text-ink-400 text-[12px]">{{ a.key_hint }}</span>
              <input
                v-model="keyDraft[a.id]"
                type="password"
                autocomplete="off"
                :placeholder="a.has_key ? 'replace the key…' : 'paste the key…'"
                class="bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run min-w-[16rem]"
              />
              <button class="btn" :disabled="!keyDraft[a.id]?.trim()" @click="setKey(a)">save</button>
              <button v-if="a.has_key" class="label hover:text-fail" @click="patch(a, 'api_key', '')">
                clear
              </button>
              <span class="text-ink-600 text-[11px] w-full"
                >Encrypted at rest. It is never sent back to this screen — only the last four
                characters are.</span
              >
            </div>

            <div v-if="a.reach === 'browser'" class="flex items-center gap-3 flex-wrap">
              <label class="flex items-center gap-2">
                <span class="label">Target tab</span>
                <input
                  class="bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                  :value="a.settings?.match ?? ''"
                  placeholder="chatgpt.com"
                  @change="
                    patch(a, 'settings', {
                      ...(a.settings ?? {}),
                      match: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
              </label>
              <label class="flex items-center gap-2">
                <span class="label">Debugging port</span>
                <input
                  type="number"
                  class="bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 w-24 focus:outline-none focus:border-run"
                  :value="a.settings?.cdp_port ?? 9222"
                  @change="
                    patch(a, 'settings', {
                      ...(a.settings ?? {}),
                      cdp_port: Number(($event.target as HTMLInputElement).value) || 9222,
                    })
                  "
                />
              </label>
            </div>
          </div>
        </div>
      </article>
    </section>

    <form class="card p-4 flex gap-2 flex-wrap items-center" @submit.prevent="create">
      <input
        v-model="draft.label"
        class="flex-1 min-w-[12rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
        placeholder="Readable name — e.g. “Gemini”"
      />
      <input
        v-model="draft.name"
        class="w-44 bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
        placeholder="technical-name"
      />
      <select
        v-model="draft.reach"
        class="bg-ink-950 border border-ink-800 rounded px-2 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
      >
        <option v-for="(v, k) in REACH" :key="k" :value="k">{{ v.label }}</option>
      </select>
      <button class="btn" :disabled="!draft.name.trim() || !draft.label.trim()">
        add an AI
      </button>
    </form>
  </div>
</template>
