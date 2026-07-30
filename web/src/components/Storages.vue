<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type Storage } from '../api'

const list = ref<Storage[]>([])
const error = ref<string | null>(null)
const busy = ref<Record<number, string>>({})
const outcome = ref<Record<number, string>>({})
const secretDraft = ref<Record<number, string>>({})

const draft = ref({ provider: 'gdrive' as Storage['provider'], label: '', target: '' })

async function load() {
  try {
    list.value = await api.storages()
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'error'
  }
}
onMounted(load)

async function create() {
  if (!draft.value.label.trim()) return
  try {
    list.value = [...list.value, await api.createStorage({ ...draft.value })]
    draft.value = { provider: 'gdrive', label: '', target: '' }
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not create it'
  }
}

async function patch(s: Storage, field: string, valeur: unknown) {
  try {
    Object.assign(s, await api.updateStorage(s.id, { [field]: valeur }))
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not save'
  }
}

/** Pasted verbatim: a service-account JSON, or a bare token. */
async function setSecret(s: Storage) {
  const raw = (secretDraft.value[s.id] ?? '').trim()
  if (!raw) return
  let charge: unknown
  try {
    charge = JSON.parse(raw)
  } catch {
    // A Dropbox token is not JSON: wrap it so the caller does not have to.
    charge = { token: raw }
  }
  try {
    Object.assign(s, await api.updateStorage(s.id, { credentials: charge }))
    secretDraft.value = { ...secretDraft.value, [s.id]: '' }
    error.value = null
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'credentials refused'
  }
}

/**
 * The normal path: everyone authorises THEIR own account. The consent screen
 * opens in a tab — whoever clicks is the one who has to consent, and they are
 * not necessarily sitting at the machine running the server.
 */
async function connect(s: Storage) {
  busy.value = { ...busy.value, [s.id]: 'connecting…' }
  try {
    const { url } = await api.connectStorage(s.id)
    window.open(url, '_blank', 'noopener')
    outcome.value = {
      ...outcome.value,
      [s.id]: 'authorise the account in the tab that opened, then come back and check',
    }
    error.value = null
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not start the connection'
  } finally {
    busy.value = { ...busy.value, [s.id]: '' }
  }
}

const email = ref<Record<number, string>>({})

/** Creates the folder and shares it — nobody should have to do that by hand. */
async function prepare(s: Storage) {
  busy.value = { ...busy.value, [s.id]: 'preparing…' }
  try {
    const r = await api.prepareStorage(s.id, { partager_avec: email.value[s.id]?.trim() || undefined })
    outcome.value = {
      ...outcome.value,
      [s.id]: `folder “${r.folder.name}” created` + (r.folder.sharedWith ? ` · ${r.folder.sharedWith}` : ''),
    }
    await load()
    error.value = null
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not prepare the folder'
  } finally {
    busy.value = { ...busy.value, [s.id]: '' }
  }
}

async function runCheck(s: Storage) {
  busy.value = { ...busy.value, [s.id]: 'checking…' }
  try {
    Object.assign(s, await api.runCheck(s.id))
    error.value = null
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not check it'
    await load()
  } finally {
    busy.value = { ...busy.value, [s.id]: '' }
  }
}

async function pushEvidence(s: Storage) {
  busy.value = { ...busy.value, [s.id]: 'uploading…' }
  try {
    const r = await api.syncStorage(s.id)
    outcome.value = {
      ...outcome.value,
      [s.id]:
        `${r.uploaded.length} proof(s) uploaded` +
        (r.failures.length ? ` · ${r.failures.length} failed: ${r.failures[0].error}` : '') +
        (r.remaining ? ` · ${r.remaining} left` : ' · everything is over there'),
    }
    await load()
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'the upload failed'
  } finally {
    busy.value = { ...busy.value, [s.id]: '' }
  }
}

async function remove(s: Storage) {
  await api.deleteStorage(s.id).catch(() => undefined)
  list.value = list.value.filter((x) => x.id !== s.id)
}

const PROVIDERS = {
  gdrive: {
    name: 'Google Drive',
    help: 'Connect your account: the folder is created in your Drive and proofs go there. Nothing to share, nothing to paste.',
    field: 'Drive folder ID — the tail of its URL',
  },
  dropbox: {
    name: 'Dropbox',
    help: 'Connect your account: the path is created on the first upload.',
    field: 'folder path, e.g. /Orchestrator',
  },
} as const

const AUTH_KIND = {
  oauth: { label: 'connected account', color: 'text-proof' },
  service_account: { label: 'service account', color: 'text-ink-400' },
  token: { label: 'app token', color: 'text-ink-400' },
} as const

const STATE = {
  ok: { label: 'reachable', color: 'text-proof', dot: 'bg-proof' },
  refused: { label: 'refused', color: 'text-fail', dot: 'bg-fail' },
  absent: { label: 'not found', color: 'text-fail', dot: 'bg-fail' },
  unknown: { label: 'never checked', color: 'text-ink-500', dot: 'bg-ink-700' },
} as const
</script>

<template>
  <section class="card p-5">
    <h2 class="text-ink-100 text-[14px]">Where proofs get shared</h2>
    <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
      Proofs live in the repository. So a teammate can read them without cloning it, they are also
      pushed to a remote storage. <strong class="text-ink-300">Everyone connects their own
      account</strong>: you authorise once, and the loop works overnight without anyone coming
      back — nobody lends their account to anybody else.
    </p>
    <p class="text-ink-500 mt-2 text-[12px] max-w-3xl">
      Credentials are encrypted at rest and never come back to this screen. Only the proofs that are
      not over there yet get uploaded.
    </p>

    <p v-if="error" class="mt-3 text-fail text-[12px]">{{ error }}</p>

    <div v-if="list.length" class="mt-5 space-y-3">
      <article v-for="s in list" :key="s.id" class="border border-ink-800 rounded p-3.5" :class="s.enabled ? '' : 'opacity-50'">
        <header class="flex items-baseline gap-3 flex-wrap">
          <span class="w-1.5 h-1.5 rounded-full self-center shrink-0" :class="STATE[s.last_status].dot" />
          <input
            class="bg-transparent text-ink-100 border-b border-transparent hover:border-ink-700 focus:border-run focus:outline-none min-w-[10rem]"
            :value="s.label"
            @change="patch(s, 'label', ($event.target as HTMLInputElement).value)"
          />
          <span class="label text-ink-600">{{ PROVIDERS[s.provider].name }}</span>
          <span class="label" :class="STATE[s.last_status].color">{{ STATE[s.last_status].label }}</span>
          <span v-if="s.auth_kind" class="label" :class="AUTH_KIND[s.auth_kind].color">
            {{ AUTH_KIND[s.auth_kind].label }}{{ s.account ? ` · ${s.account}` : '' }}
          </span>
          <span v-if="s.uploads" class="label text-ink-500">{{ s.uploads }} proof(s) stored</span>
          <label class="flex items-center gap-1.5 text-[11px] text-ink-400 ml-auto">
            <input type="checkbox" :checked="s.enabled" @change="patch(s, 'enabled', ($event.target as HTMLInputElement).checked)" />
            active
          </label>
          <button class="label hover:text-fail" @click="remove(s)">remove</button>
        </header>

        <p v-if="s.last_detail" class="text-ink-500 text-[11px] mt-2">{{ s.last_detail }}</p>
        <p class="text-ink-500 text-[11px] mt-1">{{ PROVIDERS[s.provider].help }}</p>

        <div v-if="s.provider === 'gdrive' && !s.target" class="flex items-center gap-2 mt-3 flex-wrap">
          <span class="label">Folder</span>
          <input
            v-model="email[s.id]"
            placeholder="your Google address, so it shows under “Shared with me”"
            class="flex-1 min-w-[18rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
          />
          <button class="btn" :disabled="!s.has_credentials || Boolean(busy[s.id])" @click="prepare(s)">
            {{ busy[s.id] === 'preparing…' ? 'preparing…' : 'create the folder' }}
          </button>
        </div>

        <div class="flex items-center gap-2 mt-3 flex-wrap">
          <span class="label">Folder</span>
          <input
            class="flex-1 min-w-[14rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
            :value="s.target ?? ''"
            :placeholder="PROVIDERS[s.provider].field"
            @change="patch(s, 'target', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="flex items-center gap-2 mt-3 flex-wrap">
          <button class="btn" :disabled="!s.oauth_ready || Boolean(busy[s.id])" @click="connect(s)">
            {{ s.auth_kind === 'oauth' ? 'reconnect the account' : 'connect my account' }}
          </button>
          <span v-if="!s.oauth_ready" class="text-ink-500 text-[11px]">
            no OAuth app on this machine —
            <code class="text-ink-400">orchestrator oauth:set {{ s.provider === 'gdrive' ? 'google' : 'dropbox' }} &lt;client_id&gt; &lt;client_secret&gt;</code>
          </span>
        </div>

        <!-- The fallback: a service-account key can deposit NOTHING in a personal
             Drive — it has no quota of its own. Kept for Workspace shared drives,
             not as the default path. -->
        <details class="mt-2">
          <summary class="label text-ink-600 cursor-pointer">or paste a key by hand</summary>
        <div class="flex items-center gap-2 mt-2 flex-wrap">
          <span class="label">Credentials</span>
          <span v-if="s.has_credentials" class="label text-proof">saved</span>
          <textarea
            v-model="secretDraft[s.id]"
            rows="1"
            :placeholder="s.has_credentials ? 'replace…' : (s.provider === 'gdrive' ? 'paste the service-account JSON' : 'paste the access token')"
            class="flex-1 min-w-[16rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
          />
          <button class="btn" :disabled="!secretDraft[s.id]?.trim()" @click="setSecret(s)">save</button>
          <button v-if="s.has_credentials" class="label hover:text-fail" @click="patch(s, 'credentials', null)">clear</button>
        </div>
        </details>

        <div class="flex items-center gap-3 mt-3 flex-wrap">
          <button class="btn" :disabled="!s.has_credentials || Boolean(busy[s.id])" @click="runCheck(s)">
            {{ busy[s.id] === 'checking…' ? 'checking…' : 'check' }}
          </button>
          <button
            class="btn"
            :disabled="!s.has_credentials || !s.enabled || Boolean(busy[s.id])"
            @click="pushEvidence(s)"
          >
            {{ busy[s.id] === 'uploading…' ? 'uploading…' : 'upload the missing proofs' }}
          </button>
          <span v-if="outcome[s.id]" class="text-ink-400 text-[12px]">{{ outcome[s.id] }}</span>
          <span v-else-if="s.last_sync_at" class="text-ink-600 text-[11px]">last upload {{ s.last_sync_at }}</span>
        </div>
      </article>
    </div>

    <form class="mt-5 flex gap-2 flex-wrap items-center" @submit.prevent="create">
      <select
        v-model="draft.provider"
        class="bg-ink-950 border border-ink-800 rounded px-2 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
      >
        <option value="gdrive">Google Drive</option>
        <option value="dropbox">Dropbox</option>
      </select>
      <input
        v-model="draft.label"
        placeholder="a readable name — e.g. “Atlas proofs”"
        class="flex-1 min-w-[14rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
      />
      <button class="btn" :disabled="!draft.label.trim()">add a storage</button>
    </form>
  </section>
</template>
