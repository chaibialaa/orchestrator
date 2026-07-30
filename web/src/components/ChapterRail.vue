<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Objective } from '../api'
import { haltLabel, harnessLabel } from '../labels'

const props = defineProps<{
  chapter: Objective | null
  steps: Objective[]
  chaine?: 'active' | 'dormante' | 'close'
  activite?: string
}>()

const actif = computed(() => (props.chaine ?? 'active') === 'active')
const deplie = ref(false)
const visible = computed(() => actif.value || deplie.value)

/** Depuis quand plus rien ne bouge sur cette chaîne. */
const inactifDepuis = computed(() => {
  if (!props.activite) return 'jamais démarrée'
  const j = Math.floor((Date.now() - new Date(props.activite + 'Z').getTime()) / 86400000)
  if (j >= 1) return `rien depuis ${j} jour${j > 1 ? 's' : ''}`
  const h = Math.floor((Date.now() - new Date(props.activite + 'Z').getTime()) / 3600000)
  return h >= 1 ? `rien depuis ${h} h` : 'inactive'
})

const etiquette = computed(() =>
  props.chaine === 'close'
    ? { mot: 'chaîne terminée', couleur: 'text-proof' }
    : props.chaine === 'dormante'
      ? { mot: `en sommeil — ${inactifDepuis.value}`, couleur: 'text-ink-500' }
      : { mot: 'chaîne suivie par la boucle', couleur: 'text-run' },
)

type Etat = {
  cle: string
  mot: string
  couleur: string
  bord: string
  fond: string
  bat: boolean
}

function depuis(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 60000))
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
}

/** L'état d'une étape, dit en un mot et une couleur. */
function etat(o: Objective): Etat {
  if (o.status === 'proven')
    return {
      cle: 'proven', mot: 'prouvé',
      couleur: 'text-proof', bord: 'border-proof', fond: 'bg-proof', bat: false,
    }

  if (o.status === 'blocked') {
    const humain = ['blast_radius', 'no_provable_criterion', 'invariant_regression', 'human_request']
    const aToi = humain.includes(o.halt_reason ?? '')
    return {
      cle: 'blocked',
      mot: aToi ? 'à trancher' : 'refusé, à reprendre',
      couleur: 'text-halt',
      bord: 'border-halt',
      fond: aToi ? 'bg-halt' : 'bg-transparent',
      bat: false,
    }
  }

  if (o.status === 'in_progress')
    return o.live_since
      ? {
          cle: 'live', mot: `agent · ${depuis(o.live_since)}`,
          couleur: 'text-run', bord: 'border-run', fond: 'bg-run', bat: true,
        }
      : {
          cle: 'paused', mot: 'commencé, en pause',
          couleur: 'text-run', bord: 'border-run', fond: 'bg-transparent', bat: false,
        }

  if (o.status === 'draft')
    return {
      cle: 'draft', mot: 'à préciser',
      couleur: 'text-ink-500', bord: 'border-ink-600', fond: 'bg-transparent', bat: false,
    }

  return {
    cle: 'ready', mot: 'prêt à prendre',
    couleur: 'text-ink-400', bord: 'border-ink-400', fond: 'bg-transparent', bat: false,
  }
}

/** Qui a réellement travaillé sur cette étape. */
function harnais(o: Objective): string[] {
  return (o.harnesses ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => harnessLabel[h] ?? h)
}

const prouves = computed(() => props.steps.filter((s) => s.status === 'proven').length)

/** La seule étape sur laquelle un humain ou un agent doit se poser maintenant. */
const reprise = computed(() => {
  const s = props.steps
  return (
    s.find((o) => o.live_since) ??
    s.find((o) => o.status === 'blocked') ??
    s.find((o) => o.status === 'in_progress') ??
    s.find((o) => o.status === 'ready') ??
    s.find((o) => o.status === 'draft') ??
    null
  )
})

const repriseTexte = computed(() => {
  const o = reprise.value
  if (!o) return null
  const e = etat(o)
  if (e.cle === 'live') return `#${o.id} ${o.title} — un agent y travaille depuis ${depuis(o.live_since!)}`
  if (e.cle === 'blocked')
    return `#${o.id} ${o.title} — ${haltLabel[o.halt_reason ?? ''] ?? 'arrêté'}`
  if (e.cle === 'paused') return `#${o.id} ${o.title} — commencé puis laissé, personne dessus`
  if (e.cle === 'draft') return `#${o.id} ${o.title} — il manque son critère de preuve`
  return `#${o.id} ${o.title} — prêt, aucun agent ne l'a pris`
})

/** Ce qui manque au chapitre pour conclure, dit franchement. */
const terminus = computed(() => {
  if (!props.chapter) return null
  if (props.chapter.status === 'proven') return { mot: 'franchi', couleur: 'text-proof' }
  const reste = props.steps.length - prouves.value
  return {
    mot: reste > 0 ? `${reste} étape${reste > 1 ? 's' : ''} avant le gate` : 'toutes les étapes sont prouvées',
    couleur: reste > 0 ? 'text-ink-500' : 'text-halt',
  }
})
</script>

<template>
  <section class="card p-5" :class="actif ? '' : 'opacity-70 hover:opacity-100 transition-opacity'">
    <header class="flex items-baseline gap-3 flex-wrap" :class="visible ? 'mb-6' : ''">
      <RouterLink
        v-if="chapter"
        :to="`/o/${chapter.id}`"
        class="text-ink-100 hover:text-run transition-colors"
      >
        {{ chapter.title }}
      </RouterLink>
      <span v-else class="text-ink-300">Hors chapitre</span>
      <span class="label" :class="etiquette.couleur">{{ etiquette.mot }}</span>
      <span class="label ml-auto">
        <span class="text-proof">{{ prouves }}</span
        ><span class="text-ink-600">/{{ steps.length }} prouvé{{ prouves > 1 ? 's' : '' }}</span>
      </span>
      <button v-if="!actif" class="label hover:text-ink-300 transition-colors" @click="deplie = !deplie">
        {{ deplie ? '▾ replier' : '▸ voir la voie' }}
      </button>
    </header>

    <!-- La voie : on la lit de gauche à droite, dans l'ordre d'exécution. -->
    <ol v-if="visible" class="flex items-start overflow-x-auto pb-1 -mx-1">
      <li
        v-for="(o, i) in steps"
        :key="o.id"
        class="flex items-start shrink-0 w-[11.5rem]"
      >
        <div class="w-full pr-3">
        <RouterLink :to="`/o/${o.id}`" class="group block">
          <span class="flex items-center h-3">
            <span
              class="w-2.5 h-2.5 rounded-full shrink-0 border"
              :class="[etat(o).bord, etat(o).fond, etat(o).bat ? 'animate-pulse' : '']"
            />
            <span
              v-if="i < steps.length - 1 || chapter"
              class="flex-1 h-px"
              :class="o.status === 'proven' ? 'bg-proof/50' : 'bg-ink-700'"
              :style="o.status === 'proven' ? '' : 'background-image:repeating-linear-gradient(90deg,#272c38 0 3px,transparent 3px 6px);background-color:transparent'"
            />
          </span>
          <div class="mt-2.5">
            <div class="text-ink-600 text-[11px]">#{{ o.id }}</div>
            <div
              class="text-[12px] leading-snug mt-0.5 group-hover:text-run transition-colors line-clamp-2"
              :class="o.status === 'proven' ? 'text-ink-400' : 'text-ink-100'"
              :title="o.title"
            >
              {{ o.title }}
            </div>
            <div class="text-[11px] mt-1" :class="etat(o).couleur">{{ etat(o).mot }}</div>
          </div>
        </RouterLink>

        <div v-if="harnais(o).length || o.artifacts_count" class="mt-1.5 flex items-baseline gap-2 flex-wrap">
          <span
            v-for="h in harnais(o)"
            :key="h"
            class="text-[10px] text-ink-500 border border-ink-700 rounded px-1 py-px"
            :title="`travail effectué par ${h}`"
            >{{ h }}</span
          >
          <RouterLink
            v-if="o.artifacts_count"
            :to="`/o/${o.id}#preuves`"
            class="text-[10px] text-ink-500 hover:text-run underline decoration-ink-700 underline-offset-2 transition-colors"
            :title="'voir les fichiers produits et les preuves'"
            >{{ o.artifacts_count }} fichier{{ o.artifacts_count > 1 ? 's' : '' }}</RouterLink
          >
        </div>
        </div>
      </li>

      <!-- Terminus : le gate du chapitre. -->
      <li v-if="chapter" class="flex items-start shrink-0 w-[11.5rem]">
        <div class="w-full pr-3">
          <span class="flex items-center h-3">
            <span
              class="text-[13px] leading-none -mt-0.5"
              :class="chapter.status === 'proven' ? 'text-proof' : 'text-ink-600'"
              >{{ chapter.status === 'proven' ? '◆' : '◇' }}</span
            >
          </span>
          <div class="mt-2.5">
            <div class="text-ink-600 text-[11px]">gate</div>
            <div class="text-[12px] leading-snug mt-0.5 text-ink-300">Conclure le chapitre</div>
            <div class="text-[11px] mt-1" :class="terminus?.couleur">{{ terminus?.mot }}</div>
          </div>
        </div>
      </li>
    </ol>

    <RouterLink
      v-if="reprise && actif"
      :to="`/o/${reprise.id}`"
      class="mt-5 pt-3.5 border-t border-ink-800 flex items-baseline gap-2 group"
    >
      <span class="label shrink-0">reprendre ici</span>
      <span class="text-[13px] text-ink-300 group-hover:text-run transition-colors">{{
        repriseTexte
      }}</span>
    </RouterLink>
  </section>
</template>
