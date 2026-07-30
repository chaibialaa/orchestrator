<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { api, type Objective, type Stats } from '../api'
import Chips from '../components/Chips.vue'
import ChapterRail from '../components/ChapterRail.vue'
import ActivityFeed from '../components/ActivityFeed.vue'
import { formatTokens } from '../labels'

const props = defineProps<{ slug: string }>()

const objectives = ref<Objective[]>([])
const stats = ref<Stats | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const showHelp = ref(false)

async function load() {
  loading.value = true
  error.value = null
  try {
    const [o, s] = await Promise.all([api.objectives(props.slug), api.stats(props.slug)])
    objectives.value = o
    stats.value = s
  } catch (e: any) {
    error.value = e?.message ?? 'erreur'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.slug, load)

/**
 * Les voies du projet. Un chapitre est un objectif qui en porte d'autres ;
 * ses étapes se lisent dans l'ordre de priorité, qui EST l'ordre d'exécution.
 * Ce qui ne dépend de personne et ne porte personne forme une voie à part.
 */
const voies = computed(() => {
  const tous = objectives.value
  const parents = tous.filter((o) => tous.some((x) => x.parent_id === o.id))
  const rangs = (l: Objective[]) => [...l].sort((a, b) => a.priority - b.priority || a.id - b.id)

  const chapitres = rangs(parents).map((c) => ({
    chapter: c,
    steps: rangs(tous.filter((o) => o.parent_id === c.id)),
  }))

  const seuls = rangs(tous.filter((o) => !o.parent_id && !parents.includes(o)))
  const voies = seuls.length ? [...chapitres, { chapter: null, steps: seuls }] : chapitres

  // La boucle ne suit qu'une chaîne à la fois. Présenter les autres au même
  // niveau ferait croire à trois fronts ouverts : on date chaque chaîne, on
  // met la plus récente en avant, et on dit franchement des autres qu'elles
  // sont closes ou endormies.
  const date = (v: { chapter: Objective | null; steps: Objective[] }) =>
    [v.chapter, ...v.steps]
      .map((o) => o?.last_activity ?? '')
      .sort()
      .pop() ?? ''

  const datees = voies
    .map((v) => ({ ...v, activite: date(v) }))
    .sort((a, b) => b.activite.localeCompare(a.activite))

  let actifPris = false

  return datees.map((v) => {
    const close = v.steps.every((o) => ['proven', 'abandoned'].includes(o.status))
    const actif = !close && !actifPris
    if (actif) actifPris = true

    const chaine: 'active' | 'dormante' | 'close' = close ? 'close' : actif ? 'active' : 'dormante'
    return { ...v, chaine }
  })
})

const HUMAIN = ['blast_radius', 'no_provable_criterion', 'invariant_regression', 'human_request']

// Un objectif arrêté n'attend pas forcément quelqu'un. La boucle lève seule un
// refus au verdict ou un piétinement : les compter comme des décisions à
// prendre fabrique une file d'attente qui n'existe pas.
const waiting = computed(() =>
  objectives.value.filter((o) => o.status === 'blocked' && HUMAIN.includes(o.halt_reason ?? '')),
)
const reprisAuto = computed(() =>
  objectives.value.filter((o) => o.status === 'blocked' && !HUMAIN.includes(o.halt_reason ?? '')),
)
const done = computed(() => objectives.value.filter((o) => o.status === 'proven'))

/** Depuis combien de temps la tentative ouverte tourne. */
function depuis(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 60000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h ${String(min % 60).padStart(2, '0')}`
}

/** Une phrase en français qui dit où en est cet objectif. */
function story(o: Objective): string {
  const n = o.passages_count ?? 0
  const tries = n === 0 ? 'aucune tentative' : n === 1 ? '1 tentative' : `${n} tentatives`

  if (o.status === 'draft') {
    return "Il manque la réponse à une seule question : comment saura-t-on que c'est fait ? Tant qu'elle n'a pas de réponse, aucun agent ne peut s'en saisir."
  }
  if (o.status === 'blocked') {
    return `${tries}, puis l'outil s'est arrêté de lui-même. Il attend une décision de ta part.`
  }
  if (o.status === 'in_progress') {
    return o.live_since
      ? `Un agent y travaille depuis ${depuis(o.live_since)}. ${tries} au total.`
      : `Commencé, mais aucun agent n'y travaille en ce moment. ${tries}.`
  }
  if (o.status === 'ready') {
    return "Le but et la façon de le vérifier sont clairs. Prochain agent disponible peut le prendre."
  }
  if (o.status === 'proven') {
    const e = o.evidences_count ?? 0
    return `Terminé et vérifié — ${e} preuve${e > 1 ? 's' : ''} fournie${e > 1 ? 's' : ''} et acceptée${e > 1 ? 's' : ''}.`
  }
  return ''
}

</script>

<template>
  <div v-if="loading" class="text-ink-400">chargement…</div>
  <div v-else-if="error" class="card p-4 border-fail/40 text-fail">
    L'API ne répond pas — {{ error }}
    <div class="text-ink-400 mt-1 text-[11px]">
      Elle doit tourner sur le port 8010 (php artisan serve --port=8010)
    </div>
  </div>

  <div v-else class="space-y-7">
    <!-- Explication de la page -->
    <section class="card p-4 border-ink-800">
      <div class="flex items-start gap-4">
        <div class="flex-1">
          <h1 class="text-ink-100 text-[15px]">Où en est le projet</h1>
          <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
            Chaque ligne est un <strong class="text-ink-300">objectif</strong> : une chose qu'on veut
            rendre vraie. Un objectif n'est jamais « terminé » parce qu'un agent l'a dit — il l'est
            quand une <strong class="text-ink-300">preuve</strong> a été fournie et acceptée. Quand
            l'outil ne peut pas conclure seul, il s'arrête et remonte dans
            <strong class="text-halt">En attente de toi</strong>.
          </p>
        </div>
        <button class="btn shrink-0" @click="showHelp = !showHelp">
          {{ showHelp ? 'masquer' : 'comment lire' }}
        </button>
      </div>

      <div v-if="showHelp" class="mt-4 pt-4 border-t border-ink-800 grid md:grid-cols-2 gap-5">
        <div>
          <div class="label mb-2">Les états</div>
          <ul class="space-y-1.5">
            <li v-for="s in ['draft', 'ready', 'in_progress', 'blocked', 'proven']" :key="s" class="flex gap-2">
              <Chips kind="status" :value="s" />
            </li>
          </ul>
        </div>
        <div>
          <div class="label mb-2">Le niveau de risque décide de l'autonomie</div>
          <ul class="space-y-2">
            <li v-for="b in ['cosmetic', 'feature', 'api', 'critical']" :key="b">
              <Chips kind="blast" :value="b" />
            </li>
          </ul>
          <p class="text-ink-600 text-[11px] mt-2">
            Survole une étiquette pour son explication.
          </p>
        </div>
      </div>
    </section>

    <!-- Chiffres -->
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="card p-3.5">
        <div class="label">Objectifs vérifiés</div>
        <div class="text-2xl mt-1">
          {{ done.length }}<span class="text-ink-600 text-base">/{{ objectives.length }}</span>
        </div>
        <div class="h-1 bg-ink-800 rounded mt-2 overflow-hidden">
          <div class="h-full bg-proof transition-all" :style="{ width: `${(stats?.proven_ratio ?? 0) * 100}%` }" />
        </div>
      </div>

      <div class="card p-3.5" :class="waiting.length ? 'border-halt/40' : ''">
        <div class="label">En attente de toi</div>
        <div class="text-2xl mt-1" :class="waiting.length ? 'text-halt' : ''">
          {{ waiting.length }}
        </div>
        <div class="text-ink-600 text-[11px] mt-2">
          {{ waiting.length ? "l'outil ne peut pas décider seul" : 'rien ne te bloque' }}
        </div>
      </div>

      <div class="card p-3.5">
        <div class="label">Consommation</div>
        <div class="text-2xl mt-1">{{ formatTokens(stats?.tokens) }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          tokens · {{ stats?.requests ?? 0 }} demandes ·
          <span class="text-ink-400">${{ (stats?.cost_usd ?? 0).toFixed(2) }}</span>
        </div>
      </div>

      <div class="card p-3.5">
        <div class="label">Travail effectué</div>
        <div class="text-2xl mt-1">{{ stats?.passages ?? 0 }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          tentatives, par
          <Chips
            v-for="h in Object.keys(stats?.harness_split ?? {})"
            :key="h"
            kind="harness"
            :value="h"
            class="ml-0.5"
          />
        </div>
      </div>
    </section>

    <!-- Ce qui t'attend -->
    <section v-if="waiting.length">
      <h2 class="text-halt text-[14px] mb-1">Ce qui t'attend — {{ waiting.length }}</h2>
      <p class="text-ink-400 mb-3">
        Dans chacun de ces cas, l'outil a préféré s'arrêter plutôt que de continuer sans certitude.
      </p>
      <div class="space-y-2.5">
        <RouterLink
          v-for="o in waiting"
          :key="o.id"
          :to="`/o/${o.id}`"
          class="card p-4 block border-halt/35 bg-halt/[0.04] hover:border-halt/60 transition-colors"
        >
          <div class="flex items-start gap-3">
            <div class="flex-1">
              <div class="text-ink-100">{{ o.title }}</div>
              <p class="text-ink-400 mt-1.5">{{ story(o) }}</p>
            </div>
            <Chips kind="blast" :value="o.blast_radius" />
          </div>
        </RouterLink>
      </div>
    </section>

    <p v-if="reprisAuto.length" class="text-ink-500 text-[13px]">
      {{ reprisAuto.length }} objectif{{ reprisAuto.length > 1 ? 's' : '' }} arrêté{{
        reprisAuto.length > 1 ? 's' : ''
      }}
      sur un motif que la boucle lève elle-même — aucune action de ta part :
      <span class="text-ink-400">{{ reprisAuto.map((o) => `#${o.id}`).join(', ') }}</span>
    </p>

    <!-- Les voies : ce qui vient après quoi, et où on en est réellement. -->
    <section v-if="voies.length" class="space-y-4">
      <ChapterRail
        v-for="(v, i) in voies"
        :key="v.chapter?.id ?? `seuls-${i}`"
        :chapter="v.chapter"
        :steps="v.steps"
        :chaine="v.chaine"
        :activite="v.activite"
      />
    </section>

    <ActivityFeed :slug="slug" />

    <RouterLink
      :to="`/p/${slug}/analyse`"
      class="card p-3.5 flex items-baseline gap-3 hover:border-ink-600 transition-colors"
    >
      <span class="text-ink-300">Analyse</span>
      <span class="text-ink-500 text-[12px] flex-1"
        >Pourquoi le travail se coince, ce qu'il coûte, ce qui est mesuré en production.</span
      >
      <span class="label text-ink-600">ouvrir ▸</span>
    </RouterLink>

  </div>
</template>
