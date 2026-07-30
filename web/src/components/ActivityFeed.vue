<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, type Activite } from '../api'
import { haltLabel, harnessLabel, formatTokens } from '../labels'

const props = defineProps<{ slug?: string; compact?: boolean }>()

const fil = ref<Activite[]>([])
const enCours = ref<Activite[]>([])
const maintenant = ref(Date.now())
let tic: ReturnType<typeof setInterval> | null = null
let horloge: ReturnType<typeof setInterval> | null = null

async function charger() {
  try {
    const d = await api.activity(props.slug)
    fil.value = d.fil
    enCours.value = d.en_cours
  } catch {
    /* un fil qui ne charge pas ne doit pas casser la page */
  }
}

onMounted(() => {
  charger()
  // Ce qui tourne bouge vite ; le passé, non. On ne recharge que si quelque
  // chose est en cours, sinon on laisse le serveur tranquille.
  tic = setInterval(() => charger(), enCours.value.length ? 4000 : 12000)
  horloge = setInterval(() => (maintenant.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  tic && clearInterval(tic)
  horloge && clearInterval(horloge)
})

/** Les dates viennent en UTC sans fuseau : l'ajouter, sinon on lit faux d'une heure. */
function ms(iso: string) {
  return new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z').getTime()
}

function depuis(iso: string) {
  const s = Math.max(0, Math.round((maintenant.value - ms(iso)) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  const h = Math.floor(s / 3600)
  return h < 24 ? `${h} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(h / 24)} j`
}

const LIGNE: Record<Activite['type'], { puce: string; couleur: string }> = {
  en_cours: { puce: 'bg-run animate-pulse', couleur: 'text-run' },
  tentative: { puce: 'bg-ink-600', couleur: 'text-ink-400' },
  verdict: { puce: 'bg-proof', couleur: 'text-proof' },
  arret: { puce: 'bg-halt', couleur: 'text-halt' },
}

/** Ce qu'il s'est passé, dit en une phrase — pas en jargon de table. */
function phrase(e: Activite): string {
  if (e.type === 'en_cours') {
    return `${harnessLabel[e.harness ?? ''] ?? e.harness} travaille${e.resumed_from ? ` (reprise de ${e.resumed_from.slice(0, 8)})` : ''}`
  }
  if (e.type === 'verdict') {
    const par = e.payload?.judged_by
    const refus = /retiré/.test(e.label ?? '')
    return refus
      ? `verdict retiré — ${par === 'gpt' ? 'la conversation' : par} s’est dédite`
      : `${par === 'gpt' ? 'la conversation' : par === 'human' ? 'toi' : par} a validé`
  }
  if (e.type === 'arret') {
    return `${haltLabel[e.reason ?? ''] ?? e.reason}${e.resolved_at ? ' — levé' : ''}`
  }
  if (e.prevented) return `${harnessLabel[e.harness ?? ''] ?? e.harness} — empêchée, rien tenté`
  const v = { advanced: 'a fait avancer', no_progress: 'n’a rien démontré', halted: 's’est arrêtée', failed: 'a échoué' }
  return `${harnessLabel[e.harness ?? ''] ?? e.harness} ${v[e.verdict as keyof typeof v] ?? 'a fini'}`
}

const cout = (e: Activite) => {
  const c = Number(e.cost_usd ?? 0)
  return c ? `$${c.toFixed(2)}` : null
}

const lignes = computed(() => (props.compact ? fil.value.slice(0, 6) : fil.value))
</script>

<template>
  <section>
    <h2 class="text-ink-300 text-[14px] mb-1">
      Ce qui se passe
      <span v-if="enCours.length" class="text-run">— {{ enCours.length }} en cours</span>
      <span v-else class="text-ink-600">— rien ne tourne</span>
    </h2>
    <p v-if="!compact" class="text-ink-500 mb-3.5 text-[12px]">
      Dans l'ordre du temps. Un tableau dit où on en est ; celui-ci dit ce qui bouge.
    </p>

    <div class="card divide-y divide-ink-850">
      <RouterLink
        v-for="(e, i) in lignes"
        :key="`${e.type}-${e.objective_id}-${e.quand}-${i}`"
        :to="`/o/${e.objective_id}`"
        class="flex items-baseline gap-3 px-4 py-2.5 hover:bg-ink-850/40 transition-colors"
      >
        <span class="w-1.5 h-1.5 rounded-full shrink-0 self-center" :class="LIGNE[e.type].puce" />
        <span class="text-ink-600 text-[11px] w-14 shrink-0 tabular-nums">
          {{ e.type === 'en_cours' ? depuis(e.started_at ?? e.quand) : depuis(e.quand) }}
        </span>
        <span class="text-[12px] shrink-0" :class="LIGNE[e.type].couleur">{{ phrase(e) }}</span>
        <span class="text-ink-300 text-[12px] flex-1 truncate">
          <span class="text-ink-600">#{{ e.objective_id }}</span> {{ e.objective_title }}
        </span>
        <span v-if="!slug && e.project" class="label text-ink-600 shrink-0">{{ e.project }}</span>
        <span v-if="e.tokens" class="text-ink-600 text-[11px] shrink-0">{{ formatTokens(e.tokens) }}</span>
        <span v-if="cout(e)" class="text-ink-500 text-[11px] shrink-0 tabular-nums">{{ cout(e) }}</span>
      </RouterLink>

      <p v-if="!lignes.length" class="px-4 py-4 text-ink-500 text-[12px]">
        Rien encore. Le fil se remplit dès qu'un agent démarre.
      </p>
    </div>
  </section>
</template>
