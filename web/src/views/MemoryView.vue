<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { api, type Decision, type ResourceItem } from '../api'
import { formatSize } from '../labels'

const props = defineProps<{ slug: string }>()

const decisions = ref<Decision[]>([])
const resources = ref<ResourceItem[]>([])
const filter = ref('')
const loading = ref(true)
const uploading = ref(false)
const uploadError = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function load() {
  loading.value = true
  const [d, r] = await Promise.all([api.decisions(props.slug), api.resources(props.slug)])
  decisions.value = d
  resources.value = r
  loading.value = false
}

onMounted(load)
watch(() => props.slug, load)

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files?.length) return

  uploading.value = true
  uploadError.value = null

  for (const file of Array.from(input.files)) {
    if (file.size > 5 * 1024 * 1024) {
      uploadError.value = `${file.name} fait ${formatSize(file.size)} — la limite est 5 Mo.`
      continue
    }
    try {
      await api.uploadResource(props.slug, file, '')
    } catch (e: any) {
      uploadError.value = e?.response?.data?.message ?? `Échec sur ${file.name}`
    }
  }

  input.value = ''
  uploading.value = false
  await load()
}

async function toggle(resource: ResourceItem) {
  const updated = await api.updateResource(resource.id, { included: !resource.included })
  Object.assign(resource, updated)
}

async function saveSummary(resource: ResourceItem, value: string) {
  if (value === (resource.summary ?? '')) return
  const updated = await api.updateResource(resource.id, { summary: value })
  Object.assign(resource, updated)
}

async function remove(resource: ResourceItem) {
  await api.deleteResource(resource.id)
  resources.value = resources.value.filter((r) => r.id !== resource.id)
}

const q = computed(() => filter.value.trim().toLowerCase())

const filteredDecisions = computed(() =>
  !q.value
    ? decisions.value
    : decisions.value.filter(
        (d) =>
          d.title.toLowerCase().includes(q.value) ||
          d.body.toLowerCase().includes(q.value) ||
          d.paths.some((p) => p.toLowerCase().includes(q.value)),
      ),
)

const filteredResources = computed(() =>
  !q.value
    ? resources.value
    : resources.value.filter(
        (r) =>
          r.name.toLowerCase().includes(q.value) ||
          (r.summary ?? '').toLowerCase().includes(q.value),
      ),
)

const includedCount = computed(() => resources.value.filter((r) => r.included).length)
</script>

<template>
  <div class="space-y-7">
    <section class="card p-4 border-ink-800">
      <div class="flex items-start gap-4">
        <div class="flex-1">
          <h1 class="text-ink-100 text-[15px]">Mémoire du projet</h1>
          <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
            Ce que l'outil ressort tout seul au démarrage d'une nouvelle session de travail, pour
            ne pas avoir à réexpliquer le projet à chaque fois. Deux choses :
            les <strong class="text-ink-300">décisions</strong> — rattachées aux fichiers concernés,
            elles remontent dès qu'un agent ouvre l'un d'eux — et les
            <strong class="text-ink-300">documents</strong> que tu déposes ici.
          </p>
        </div>
        <input
          v-model="filter"
          placeholder="filtrer…"
          class="shrink-0 bg-ink-900 border border-ink-700 rounded px-2.5 py-1 text-[12px] w-56 focus:outline-none focus:border-ink-600"
        />
      </div>
    </section>

    <!-- Documents -->
    <section>
      <div class="flex items-baseline gap-3 mb-1">
        <h2 class="text-ink-100 text-[14px]">Documents — {{ resources.length }}</h2>
        <span class="text-ink-400 text-[12px]">{{ includedCount }} inclus dans le contexte</span>
        <button class="btn ml-auto" :disabled="uploading" @click="fileInput?.click()">
          {{ uploading ? 'envoi…' : 'déposer un fichier' }}
        </button>
        <input ref="fileInput" type="file" multiple class="hidden" @change="onFiles" />
      </div>
      <p class="text-ink-400 mb-3 max-w-3xl">
        Images, notes, exports — jusqu'à 5 Mo par fichier. Décoche un document pour le garder en
        archive sans l'envoyer aux agents.
      </p>

      <div v-if="uploadError" class="card p-3 border-fail/40 text-fail mb-3">{{ uploadError }}</div>

      <div v-if="!filteredResources.length" class="text-ink-600">aucun document</div>

      <div v-else class="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        <article
          v-for="r in filteredResources"
          :key="r.id"
          class="card overflow-hidden transition-opacity"
          :class="r.included ? '' : 'opacity-45'"
        >
          <a
            v-if="r.kind === 'image'"
            :href="api.resourceUrl(r.id)"
            target="_blank"
            class="block bg-ink-950 border-b border-ink-800"
          >
            <img :src="api.resourceUrl(r.id)" :alt="r.name" class="w-full h-36 object-contain" />
          </a>
          <div v-else class="h-36 flex items-center justify-center bg-ink-950 border-b border-ink-800">
            <span class="text-ink-600 text-[28px] uppercase tracking-widest">{{
              r.name.split('.').pop()
            }}</span>
          </div>

          <div class="p-3">
            <div class="flex items-start gap-2">
              <a
                :href="api.resourceUrl(r.id)"
                target="_blank"
                class="text-ink-100 flex-1 hover:underline break-all"
                >{{ r.name }}</a
              >
              <button
                class="chip shrink-0"
                :class="r.included ? 'border-proof/50 text-proof' : 'border-ink-600 text-ink-400'"
                :title="r.included ? 'Envoyé aux agents' : 'Gardé en archive'"
                @click="toggle(r)"
              >
                {{ r.included ? 'inclus' : 'exclu' }}
              </button>
            </div>

            <div class="text-ink-600 text-[11px] mt-1">
              {{ formatSize(r.size) }} · {{ r.created_at?.slice(0, 10) }}
            </div>

            <input
              :value="r.summary ?? ''"
              placeholder="à quoi ça sert ?"
              class="w-full mt-2 bg-ink-850 border border-ink-700 rounded px-2 py-1 text-[12px] focus:outline-none focus:border-ink-600"
              @change="saveSummary(r, ($event.target as HTMLInputElement).value)"
            />

            <button class="text-ink-600 hover:text-fail text-[11px] mt-2" @click="remove(r)">
              retirer de la mémoire
            </button>
          </div>
        </article>
      </div>
    </section>

    <!-- Décisions -->
    <section>
      <h2 class="text-ink-100 text-[14px] mb-1">Décisions — {{ decisions.length }}</h2>
      <p class="text-ink-400 mb-3 max-w-3xl">
        Chaque décision est rattachée à des fichiers. Quand un agent s'apprête à toucher l'un
        d'eux, elle lui est rappelée automatiquement — c'est ce qui évite de refaire deux fois la
        même erreur.
      </p>

      <div v-if="loading" class="text-ink-400">chargement…</div>
      <div v-else-if="!filteredDecisions.length" class="text-ink-600">aucune décision</div>

      <div v-else class="space-y-3">
        <article v-for="d in filteredDecisions" :key="d.id" class="card p-4">
          <div class="flex items-baseline gap-3">
            <h3 class="text-ink-100 flex-1">{{ d.title }}</h3>
            <span class="text-ink-600 text-[11px]">{{ d.decided_at?.slice(0, 10) }}</span>
          </div>
          <p class="text-ink-300 mt-2 whitespace-pre-wrap leading-relaxed">{{ d.body }}</p>
          <div v-if="d.paths?.length" class="mt-3 flex flex-wrap items-center gap-1.5">
            <span class="text-ink-600 text-[11px]">rappelée sur :</span>
            <code v-for="p in d.paths" :key="p" class="chip border-ink-700 text-ink-400 bg-ink-850">{{
              p
            }}</code>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
