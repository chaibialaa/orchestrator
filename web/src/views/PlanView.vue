<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api, type BlastRadius, type Objective } from '../api'
import { blastLabel, blastHelp, statusLabel } from '../labels'
import BriefComposer from '../components/BriefComposer.vue'

const props = defineProps<{ slug: string }>()

const objectives = ref<Objective[]>([])
const chargement = ref(true)
const erreur = ref<string | null>(null)

/** Ce qui vient d'être enregistré, par id — pour que rien ne parte en silence. */
const etat = ref<Record<string, 'enregistre' | 'erreur' | 'envoi'>>({})

function marquer(cle: string, v: 'enregistre' | 'erreur' | 'envoi') {
  etat.value = { ...etat.value, [cle]: v }
  if (v === 'enregistre') setTimeout(() => (etat.value = { ...etat.value, [cle]: undefined as never }), 1800)
}

async function charger() {
  chargement.value = true
  erreur.value = null
  try {
    objectives.value = await api.objectives(props.slug)
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? e?.message ?? 'erreur'
  } finally {
    chargement.value = false
  }
}

onMounted(charger)
watch(() => props.slug, charger)

const rangs = (l: Objective[]) => [...l].sort((a, b) => a.priority - b.priority || a.id - b.id)

/**
 * Tout objectif de premier niveau est un chapitre, même vide. Ne le devenir
 * qu'une fois qu'il porte une étape créait une impasse : le chapitre naissait
 * « hors chapitre », donc sans le formulaire qui aurait permis de lui en
 * ajouter une.
 */
const chapitres = computed(() => {
  const tous = objectives.value.filter((o) => o.status !== 'abandoned')
  return rangs(tous.filter((o) => !o.parent_id)).map((c) => ({
    chapitre: c,
    etapes: rangs(tous.filter((o) => o.parent_id === c.id)),
  }))
})

// ---- écriture -------------------------------------------------------------

async function patch(o: Objective, champ: keyof Objective, valeur: unknown) {
  if (o[champ] === valeur) return
  const cle = `${o.id}:${String(champ)}`
  marquer(cle, 'envoi')
  try {
    const maj = await api.updateObjective(o.id, { [champ]: valeur } as Partial<Objective>)
    Object.assign(o, maj)
    marquer(cle, 'enregistre')
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? "l'enregistrement a échoué"
    marquer(cle, 'erreur')
  }
}

const nouveauChapitre = ref('')

async function creerChapitre() {
  const titre = nouveauChapitre.value.trim()
  if (!titre) return
  try {
    const o = await api.createObjective(props.slug, {
      title: titre,
      blast_radius: 'feature',
      priority: (chapitres.value.length + 1) * 10,
    })
    objectives.value = [...objectives.value, o]
    nouveauChapitre.value = ''
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? 'création impossible'
  }
}

const nouvelleEtape = ref<Record<number, string>>({})

async function creerEtape(chapitre: Objective, etapes: Objective[]) {
  const titre = (nouvelleEtape.value[chapitre.id] ?? '').trim()
  if (!titre) return
  try {
    const o = await api.createObjective(props.slug, {
      title: titre,
      blast_radius: chapitre.blast_radius,
      parent_id: chapitre.id,
      priority: (etapes.at(-1)?.priority ?? 0) + 10,
    })
    objectives.value = [...objectives.value, o]
    nouvelleEtape.value = { ...nouvelleEtape.value, [chapitre.id]: '' }
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? 'création impossible'
  }
}

/** Réordonner : on renumérote la colonne entière, jamais un seul rang. */
async function deplacer(etapes: Objective[], depuis: number, vers: number) {
  if (vers < 0 || vers >= etapes.length) return
  const l = [...etapes]
  const [pris] = l.splice(depuis, 1)
  l.splice(vers, 0, pris)
  const ordre = l.map((o, i) => ({ id: o.id, priority: (i + 1) * 10 }))
  ordre.forEach((x) => {
    const cible = objectives.value.find((o) => o.id === x.id)
    if (cible) cible.priority = x.priority
  })
  try {
    await api.reorderObjectives(props.slug, ordre)
    marquer(`ordre:${pris.parent_id}`, 'enregistre')
  } catch {
    erreur.value = "l'ordre n'a pas pu être enregistré"
    await charger()
  }
}

async function abandonner(o: Objective) {
  await patch(o, 'status', 'abandoned')
}

const RISQUES: BlastRadius[] = ['cosmetic', 'feature', 'api', 'critical']
</script>

<template>
  <div v-if="chargement" class="text-ink-400">chargement…</div>
  <div v-else class="space-y-7">
    <section class="card p-4 border-ink-800">
      <h1 class="text-ink-100 text-[15px]">Le plan</h1>
      <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
        Un <strong class="text-ink-300">chapitre</strong> porte des
        <strong class="text-ink-300">étapes</strong>, dans l'ordre où elles seront exécutées. Une
        étape n'est prenable par un agent que si on a écrit
        <strong class="text-ink-300">ce qui prouvera qu'elle est finie</strong> — sans ce critère,
        elle reste à préciser et personne ne peut s'en saisir.
      </p>
    </section>

    <BriefComposer :slug="slug" @applique="charger" />

    <p v-if="erreur" class="card p-3 border-fail/40 text-fail">{{ erreur }}</p>

    <section v-for="{ chapitre, etapes } in chapitres" :key="chapitre.id" class="card p-5">
      <header class="flex items-baseline gap-3 flex-wrap mb-5">
        <input
          class="bg-transparent text-ink-100 border-b border-transparent hover:border-ink-700 focus:border-run focus:outline-none min-w-[18rem] flex-1"
          :value="chapitre.title"
          @change="patch(chapitre, 'title', ($event.target as HTMLInputElement).value)"
        />
        <span class="label text-ink-600">chapitre #{{ chapitre.id }}</span>
        <span v-if="etat[`${chapitre.id}:title`]" class="label text-proof">enregistré</span>
        <button
          v-if="!etapes.length && chapitre.status !== 'proven'"
          class="label hover:text-fail"
          title="écarter ce chapitre vide"
          @click="abandonner(chapitre)"
        >
          écarter
        </button>
      </header>

      <p v-if="!etapes.length" class="text-ink-500 text-[12px] mb-3.5">
        Chapitre vide. Ajoute ses étapes dans l'ordre où elles seront exécutées.
      </p>

      <ol class="space-y-2.5">
        <li
          v-for="(o, i) in etapes"
          :key="o.id"
          class="border border-ink-800 rounded p-3.5"
          :class="o.status === 'abandoned' ? 'opacity-40' : ''"
        >
          <div class="flex items-start gap-3">
            <div class="flex flex-col gap-0.5 pt-0.5">
              <button
                class="text-ink-600 hover:text-ink-100 leading-none text-[11px] disabled:opacity-25"
                :disabled="i === 0"
                title="monter"
                @click="deplacer(etapes, i, i - 1)"
              >
                ▲
              </button>
              <button
                class="text-ink-600 hover:text-ink-100 leading-none text-[11px] disabled:opacity-25"
                :disabled="i === etapes.length - 1"
                title="descendre"
                @click="deplacer(etapes, i, i + 1)"
              >
                ▼
              </button>
            </div>

            <div class="flex-1 min-w-0">
              <div class="flex items-baseline gap-2.5 flex-wrap">
                <span class="text-ink-600 text-[11px]">#{{ o.id }}</span>
                <input
                  class="bg-transparent text-ink-100 border-b border-transparent hover:border-ink-700 focus:border-run focus:outline-none flex-1 min-w-[14rem]"
                  :value="o.title"
                  @change="patch(o, 'title', ($event.target as HTMLInputElement).value)"
                />
                <span class="label text-ink-500">{{ statusLabel[o.status] }}</span>
              </div>

              <label class="block mt-2.5">
                <span class="label">Ce qui prouvera que c'est fini</span>
                <textarea
                  rows="3"
                  class="mt-1 w-full bg-ink-950 border rounded px-2.5 py-2 text-[12px] text-ink-300 leading-relaxed resize-y focus:outline-none focus:border-run"
                  :class="o.proof_spec ? 'border-ink-800' : 'border-halt/40'"
                  :placeholder="'Une condition vérifiable — ex. « php artisan iberis:test --filter=ImportTest passe au vert »'"
                  :value="o.proof_spec ?? ''"
                  @change="patch(o, 'proof_spec', ($event.target as HTMLTextAreaElement).value)"
                />
              </label>
              <p v-if="!o.proof_spec" class="text-halt text-[11px] mt-1">
                Sans critère, aucun agent ne peut prendre cette étape.
              </p>

              <div class="flex items-center gap-3 mt-2.5 flex-wrap">
                <label class="flex items-center gap-2">
                  <span class="label">Risque</span>
                  <select
                    class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                    :value="o.blast_radius"
                    :title="blastHelp[o.blast_radius]"
                    @change="patch(o, 'blast_radius', ($event.target as HTMLSelectElement).value)"
                  >
                    <option v-for="r in RISQUES" :key="r" :value="r">{{ blastLabel[r] }}</option>
                  </select>
                </label>
                <span v-if="etat[`${o.id}:proof_spec`] === 'enregistre'" class="label text-proof"
                  >critère enregistré</span
                >
                <label class="flex items-center gap-2">
                  <span class="label">Session</span>
                  <select
                    class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                    :value="o.resume_mode ?? 'new'"
                    :title="
                      (o.resume_mode ?? 'new') === 'new'
                        ? 'Chaque tentative repart de zéro : la mission est l’ordre complet.'
                        : 'La tentative reprend une session précédente — moins cher, mais elle transporte de l’état que personne ne voit.'
                    "
                    @change="patch(o, 'resume_mode', ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="new">neuve à chaque fois</option>
                    <option value="last">reprendre la précédente</option>
                  </select>
                </label>
                <span
                  v-if="(o.resume_mode ?? 'new') !== 'new'"
                  class="text-[11px] text-halt"
                  >l’ordre ne sera plus tout entier dans la mission</span
                >
                <label class="flex items-center gap-2">
                  <span class="label">Chapitre</span>
                  <select
                    class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                    :value="o.parent_id ?? ''"
                    @change="patch(o, 'parent_id', Number(($event.target as HTMLSelectElement).value) || null)"
                  >
                    <option value="">aucun — remonter en chapitre</option>
                    <option v-for="c in chapitres" :key="c.chapitre.id" :value="c.chapitre.id">
                      {{ c.chapitre.title }}
                    </option>
                  </select>
                </label>
                <RouterLink :to="`/o/${o.id}`" class="label hover:text-run ml-auto">ouvrir ▸</RouterLink>
                <button
                  v-if="o.status !== 'abandoned' && o.status !== 'proven'"
                  class="label hover:text-fail"
                  title="écarter cette étape sans la supprimer"
                  @click="abandonner(o)"
                >
                  écarter
                </button>
              </div>
            </div>
          </div>
        </li>
      </ol>

      <form class="mt-3.5 flex gap-2" @submit.prevent="creerEtape(chapitre, etapes)">
        <input
          v-model="nouvelleEtape[chapitre.id]"
          class="flex-1 bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[12px] text-ink-300 focus:outline-none focus:border-run"
          placeholder="Ajouter une étape à ce chapitre…"
        />
        <button class="btn" :disabled="!nouvelleEtape[chapitre.id]?.trim()">ajouter</button>
      </form>
    </section>

    <form class="card p-4 flex gap-2" @submit.prevent="creerChapitre">
      <input
        v-model="nouveauChapitre"
        class="flex-1 bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
        placeholder="Nouveau chapitre — ex. « Import employés Excel, étape 2 »"
      />
      <button class="btn" :disabled="!nouveauChapitre.trim()">créer le chapitre</button>
    </form>
  </div>
</template>
