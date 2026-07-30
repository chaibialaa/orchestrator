<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api, type Objective, type Stats } from '../api'
import { haltLabel, haltHelp, harnessLabel, formatTokens } from '../labels'

const props = defineProps<{ slug: string }>()

const stats = ref<Stats | null>(null)
const objectifs = ref<Objective[]>([])
const chargement = ref(true)

async function charger() {
  chargement.value = true
  try {
    ;[stats.value, objectifs.value] = await Promise.all([api.stats(props.slug), api.objectives(props.slug)])
  } finally {
    chargement.value = false
  }
}
onMounted(charger)
watch(() => props.slug, charger)

const arrets = computed(() =>
  Object.entries(stats.value?.halts_by_reason ?? {}).sort((a, b) => b[1] - a[1]),
)
const maxArret = computed(() => Math.max(1, ...arrets.value.map(([, n]) => n)))

const harnais = computed(() =>
  Object.entries(stats.value?.harness_split ?? {}).sort((a, b) => b[1] - a[1]),
)
const totalPassages = computed(() => harnais.value.reduce((n, [, v]) => n + v, 0) || 1)

/** Ce que coûte un objectif : c'est là qu'on voit où part l'argent. */
const parObjectif = computed(() =>
  [...objectifs.value]
    .filter((o) => (o.passages_count ?? 0) > 0)
    .sort((a, b) => (b.passages_count ?? 0) - (a.passages_count ?? 0))
    .slice(0, 10),
)
</script>

<template>
  <div v-if="chargement" class="text-ink-400">chargement…</div>
  <div v-else class="space-y-7">
    <section class="card p-4 border-ink-800">
      <h1 class="text-ink-100 text-[15px]">Analyse</h1>
      <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
        Là où le travail se coince, et ce qu'il coûte. Cette page ne sert pas à décider — elle sert à
        comprendre pourquoi il faut décider si souvent.
      </p>
    </section>

    <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="card p-3.5">
        <div class="label">Consommation</div>
        <div class="text-2xl mt-1">{{ formatTokens(stats?.tokens) }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          {{ stats?.requests }} demandes · ${{ (stats?.cost_usd ?? 0).toFixed(2) }}
        </div>
      </div>
      <div class="card p-3.5">
        <div class="label">Tentatives</div>
        <div class="text-2xl mt-1">{{ stats?.passages }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          {{ stats?.passages ? `$${((stats.cost_usd ?? 0) / stats.passages).toFixed(2)} en moyenne` : '—' }}
        </div>
      </div>
      <div class="card p-3.5">
        <div class="label">Objectifs vérifiés</div>
        <div class="text-2xl mt-1">
          {{ stats?.objectives?.proven ?? 0
          }}<span class="text-ink-600 text-base">/{{ objectifs.length }}</span>
        </div>
      </div>
      <div class="card p-3.5">
        <div class="label">Arrêts</div>
        <div class="text-2xl mt-1">{{ arrets.reduce((n, [, v]) => n + v, 0) }}</div>
        <div class="text-ink-600 text-[11px] mt-2">
          dont {{ stats?.awaiting_human ?? 0 }} qui t'attendent
        </div>
      </div>
    </section>

    <section v-if="arrets.length">
      <h2 class="text-ink-300 text-[14px] mb-1">Pourquoi le travail s'arrête</h2>
      <p class="text-ink-500 mb-3.5 text-[12px] max-w-3xl">
        Le chiffre le plus utile de la page : il dit où ça coince réellement, donc quoi améliorer en
        premier.
      </p>
      <div class="card divide-y divide-ink-850">
        <div v-for="[motif, n] in arrets" :key="motif" class="px-4 py-3">
          <div class="flex items-baseline gap-3">
            <span class="text-ink-100 flex-1">{{ haltLabel[motif] ?? motif }}</span>
            <span class="h-1 bg-ink-800 rounded w-40 overflow-hidden">
              <span class="block h-full bg-halt" :style="{ width: `${(n / maxArret) * 100}%` }" />
            </span>
            <span class="text-ink-400 text-[12px] w-14 text-right tabular-nums">{{ n }} fois</span>
          </div>
          <p class="text-ink-500 text-[11px] mt-1 max-w-3xl">{{ haltHelp[motif] }}</p>
        </div>
      </div>
    </section>

    <section v-if="harnais.length">
      <h2 class="text-ink-300 text-[14px] mb-3">Qui fait le travail</h2>
      <div class="card p-4 space-y-2.5">
        <div v-for="[h, n] in harnais" :key="h" class="flex items-baseline gap-3">
          <span class="text-ink-100 w-20">{{ harnessLabel[h] ?? h }}</span>
          <span class="h-1 bg-ink-800 rounded flex-1 overflow-hidden">
            <span class="block h-full bg-run" :style="{ width: `${(n / totalPassages) * 100}%` }" />
          </span>
          <span class="text-ink-500 text-[12px] w-24 text-right tabular-nums">
            {{ n }} tentative{{ n > 1 ? 's' : '' }}
          </span>
        </div>
      </div>
    </section>

    <section v-if="parObjectif.length">
      <h2 class="text-ink-300 text-[14px] mb-1">Où part l'effort</h2>
      <p class="text-ink-500 mb-3.5 text-[12px]">
        Un objectif qui accumule les tentatives sans conclure est un objectif mal posé, pas un agent
        paresseux.
      </p>
      <div class="card divide-y divide-ink-850">
        <RouterLink
          v-for="o in parObjectif"
          :key="o.id"
          :to="`/o/${o.id}`"
          class="flex items-baseline gap-3 px-4 py-2.5 hover:bg-ink-850/40 transition-colors"
        >
          <span class="text-ink-600 text-[11px] w-8">#{{ o.id }}</span>
          <span class="text-ink-300 flex-1 truncate">{{ o.title }}</span>
          <span
            class="label"
            :class="o.status === 'proven' ? 'text-proof' : o.status === 'blocked' ? 'text-halt' : 'text-ink-500'"
            >{{ o.status === 'proven' ? 'prouvé' : o.status === 'blocked' ? 'arrêté' : 'en cours' }}</span
          >
          <span class="text-ink-500 text-[12px] w-24 text-right tabular-nums">
            {{ o.passages_count }} tentative{{ (o.passages_count ?? 0) > 1 ? 's' : '' }}
          </span>
          <span class="text-ink-600 text-[11px] w-16 text-right">{{ o.evidences_count }} preuves</span>
        </RouterLink>
      </div>
    </section>
  </div>
</template>
