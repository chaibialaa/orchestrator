<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type Agent } from '../api'

const agents = ref<Agent[]>([])
const chargement = ref(true)
const erreur = ref<string | null>(null)
const cles = ref<Record<number, string>>({})

async function charger() {
  chargement.value = true
  try {
    agents.value = await api.agents()
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? e?.message ?? 'erreur'
  } finally {
    chargement.value = false
  }
}
onMounted(charger)

async function patch(a: Agent, champ: string, valeur: unknown) {
  try {
    Object.assign(a, await api.updateAgent(a.id, { [champ]: valeur } as any))
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? "l'enregistrement a échoué"
  }
}

async function poserCle(a: Agent) {
  const k = (cles.value[a.id] ?? '').trim()
  try {
    Object.assign(a, await api.updateAgent(a.id, { api_key: k }))
    cles.value = { ...cles.value, [a.id]: '' }
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? 'clé refusée'
  }
}

async function deplacer(i: number, vers: number) {
  if (vers < 0 || vers >= agents.value.length) return
  const l = [...agents.value]
  const [pris] = l.splice(i, 1)
  l.splice(vers, 0, pris)
  agents.value = l.map((a, n) => ({ ...a, priority: (n + 1) * 10 }))
  await api
    .reorderAgents(agents.value.map((a) => ({ id: a.id, priority: a.priority })))
    .catch(() => {
      erreur.value = "l'ordre n'a pas pu être enregistré"
      charger()
    })
}

const nouveau = ref({ name: '', label: '', reach: 'cli' as Agent['reach'] })

async function creer() {
  if (!nouveau.value.name.trim() || !nouveau.value.label.trim()) return
  try {
    const a = await api.createAgent({
      ...nouveau.value,
      role: 'executant',
      priority: (agents.value.length + 1) * 10,
    })
    agents.value = [...agents.value, a]
    nouveau.value = { name: '', label: '', reach: 'cli' }
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? 'création impossible'
  }
}

async function retirer(a: Agent) {
  await api.deleteAgent(a.id).catch(() => undefined)
  agents.value = agents.value.filter((x) => x.id !== a.id)
}

const ACCES: Record<Agent['reach'], { mot: string; aide: string }> = {
  cli: {
    mot: 'en local',
    aide: "Lancé sur ta machine par l'agent. Rien à configurer ici : le binaire et ses options restent dans le .orchestrator.json du dépôt.",
  },
  browser: {
    mot: 'via le navigateur',
    aide: "Atteint par le protocole de débogage de Chrome, sur un profil dédié. Il faut que ce Chrome tourne et qu'un onglet corresponde.",
  },
  api: {
    mot: 'par clé',
    aide: 'Appelé directement par le serveur avec une clé. Fonctionne même si le serveur est hébergé ailleurs que ta machine.',
  },
}

const ROLES: Record<Agent['role'], string> = {
  executant: 'Exécute le travail',
  juge: 'Juge le travail',
  both: 'Exécute et juge',
}

const ETAT: Record<Agent['last_status'], { mot: string; couleur: string; puce: string }> = {
  ok: { mot: 'joignable', couleur: 'text-proof', puce: 'bg-proof' },
  absent: { mot: 'introuvable', couleur: 'text-fail', puce: 'bg-fail' },
  refused: { mot: 'présent mais inutilisable', couleur: 'text-halt', puce: 'bg-halt' },
  unknown: { mot: 'jamais vérifié', couleur: 'text-ink-500', puce: 'bg-ink-700' },
}

function quand(iso: string | null): string {
  if (!iso) return 'jamais'
  // Deux formats arrivent d'ici : les dates Eloquent portent déjà leur fuseau,
  // celles lues en SQL brut n'en ont pas. Ajouter un Z à l'aveugle donnait NaN.
  const brut = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z'
  const min = Math.round((Date.now() - new Date(brut).getTime()) / 60000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `il y a ${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `il y a ${h} h` : `il y a ${Math.floor(h / 24)} j`
}

const juges = computed(() => agents.value.filter((a) => a.enabled && a.role !== 'executant'))
const executants = computed(() => agents.value.filter((a) => a.enabled && a.role !== 'juge'))
</script>

<template>
  <div v-if="chargement" class="text-ink-400">chargement…</div>
  <div v-else class="space-y-7">
    <section class="card p-4 border-ink-800">
      <h1 class="text-ink-100 text-[15px]">Les IA connectées</h1>
      <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
        Qui peut travailler, qui peut juger, et dans quel ordre on les préfère quand la conversation
        qui pilote ne désigne personne. L'état
        <strong class="text-ink-300">joignable</strong> n'est pas coché ici : il est
        <strong class="text-ink-300">constaté sur la machine</strong> par
        <code class="text-ink-300">orchestrator agents:check</code> — un binaire absent ou un Chrome
        fermé ne se déclarent pas, ils se voient.
      </p>
      <p class="text-ink-500 mt-2.5 text-[12px] max-w-3xl">
        Le serveur ne stocke jamais de commande à exécuter. Il dit qui existe et comment on
        l'atteint ; le binaire, son chemin et ses options restent dans le
        <code>.orchestrator.json</code> de chaque dépôt.
      </p>
    </section>

    <p v-if="erreur" class="card p-3 border-fail/40 text-fail">{{ erreur }}</p>

    <section class="grid sm:grid-cols-2 gap-3">
      <div class="card p-3.5">
        <div class="label">Peuvent exécuter</div>
        <div class="text-ink-300 mt-1.5">
          {{ executants.map((a) => a.label).join(' · ') || 'aucun' }}
        </div>
      </div>
      <div class="card p-3.5">
        <div class="label">Peuvent juger</div>
        <div class="text-ink-300 mt-1.5">
          {{ juges.map((a) => a.label).join(' · ') || 'aucun — personne ne peut conclure' }}
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
              title="préférer davantage"
              @click="deplacer(i, i - 1)"
            >
              ▲
            </button>
            <button
              class="text-ink-600 hover:text-ink-100 leading-none text-[11px] disabled:opacity-25"
              :disabled="i === agents.length - 1"
              title="préférer moins"
              @click="deplacer(i, i + 1)"
            >
              ▼
            </button>
          </div>

          <div class="flex-1 min-w-0 space-y-3">
            <div class="flex items-baseline gap-3 flex-wrap">
              <span
                class="w-1.5 h-1.5 rounded-full shrink-0 self-center"
                :class="ETAT[a.last_status].puce"
              />
              <input
                class="bg-transparent text-ink-100 border-b border-transparent hover:border-ink-700 focus:border-run focus:outline-none flex-1 min-w-[14rem] max-w-[22rem]"
                :value="a.label"
                @change="patch(a, 'label', ($event.target as HTMLInputElement).value)"
              />
              <code class="text-ink-600 text-[11px] shrink-0">{{ a.name }}</code>
              <span class="label ml-auto" :class="ETAT[a.last_status].couleur">
                {{ ETAT[a.last_status].mot }}
              </span>
              <label class="flex items-center gap-1.5 text-[11px] text-ink-400">
                <input
                  type="checkbox"
                  :checked="a.enabled"
                  @change="patch(a, 'enabled', ($event.target as HTMLInputElement).checked)"
                />
                actif
              </label>
            </div>

            <p class="text-ink-500 text-[11px]">
              {{ a.last_detail ?? 'aucun relevé' }}
              <template v-if="a.last_machine">
                · relevé {{ quand(a.last_checked_at) }} sur {{ a.last_machine }}
              </template>
            </p>

            <div class="flex items-center gap-4 flex-wrap">
              <label class="flex items-center gap-2">
                <span class="label">Accès</span>
                <select
                  class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                  :value="a.reach"
                  @change="patch(a, 'reach', ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="(v, k) in ACCES" :key="k" :value="k">{{ v.mot }}</option>
                </select>
              </label>
              <label class="flex items-center gap-2">
                <span class="label">Rôle</span>
                <select
                  class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                  :value="a.role"
                  @change="patch(a, 'role', ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="(v, k) in ROLES" :key="k" :value="k">{{ v }}</option>
                </select>
              </label>
              <span class="text-ink-600 text-[11px]">préférence {{ i + 1 }}<sup>e</sup></span>
              <button class="label hover:text-fail ml-auto" @click="retirer(a)">retirer</button>
            </div>

            <p class="text-ink-500 text-[11px]">{{ ACCES[a.reach].aide }}</p>

            <div v-if="a.reach === 'api'" class="flex items-center gap-2 flex-wrap">
              <span class="label">Clé</span>
              <span v-if="a.has_key" class="text-ink-400 text-[12px]">{{ a.key_hint }}</span>
              <input
                v-model="cles[a.id]"
                type="password"
                autocomplete="off"
                :placeholder="a.has_key ? 'remplacer la clé…' : 'coller la clé…'"
                class="bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run min-w-[16rem]"
              />
              <button class="btn" :disabled="!cles[a.id]?.trim()" @click="poserCle(a)">poser</button>
              <button v-if="a.has_key" class="label hover:text-fail" @click="patch(a, 'api_key', '')">
                effacer
              </button>
              <span class="text-ink-600 text-[11px] w-full"
                >Chiffrée au repos. Elle n'est jamais renvoyée à cet écran — seuls les quatre
                derniers caractères le sont.</span
              >
            </div>

            <div v-if="a.reach === 'browser'" class="flex items-center gap-3 flex-wrap">
              <label class="flex items-center gap-2">
                <span class="label">Onglet visé</span>
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
                <span class="label">Port de débogage</span>
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

    <form class="card p-4 flex gap-2 flex-wrap items-center" @submit.prevent="creer">
      <input
        v-model="nouveau.label"
        class="flex-1 min-w-[12rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
        placeholder="Nom lisible — ex. « Gemini »"
      />
      <input
        v-model="nouveau.name"
        class="w-44 bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
        placeholder="nom-technique"
      />
      <select
        v-model="nouveau.reach"
        class="bg-ink-950 border border-ink-800 rounded px-2 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
      >
        <option v-for="(v, k) in ACCES" :key="k" :value="k">{{ v.mot }}</option>
      </select>
      <button class="btn" :disabled="!nouveau.name.trim() || !nouveau.label.trim()">
        ajouter une IA
      </button>
    </form>
  </div>
</template>
