<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api, type Brief, type BlastRadius, type ProposedStep } from '../api'
import { blastLabel } from '../labels'

const props = defineProps<{ slug: string }>()
const emit = defineEmits<{ applique: [] }>()

const texte = ref('')
const briefs = ref<Brief[]>([])
const envoi = ref(false)
const erreur = ref<string | null>(null)
let minuteur: ReturnType<typeof setInterval> | null = null

/** Copie locale du découpage, pour que l'humain puisse le corriger avant. */
const brouillon = ref<Record<number, { chapter: string; intent: string; steps: ProposedStep[] }>>({})

async function charger() {
  try {
    briefs.value = await api.briefs(props.slug)
    for (const b of briefs.value) {
      if (b.status === 'proposed' && b.proposal && !brouillon.value[b.id]) {
        brouillon.value = {
          ...brouillon.value,
          [b.id]: {
            chapter: b.proposal.chapter,
            intent: b.proposal.intent ?? '',
            steps: b.proposal.steps.map((e) => ({ ...e })),
          },
        }
      }
    }
  } catch {
    /* le composeur n'est pas essentiel : il ne casse pas la page */
  }
}

onMounted(() => {
  charger()
  // On attend un agent qui tourne ailleurs : sans sondage, l'écran resterait
  // bloqué sur « en attente » alors que la proposition est déjà arrivée.
  minuteur = setInterval(() => {
    if (briefs.value.some((b) => b.status === 'pending' || b.status === 'running')) charger()
  }, 4000)
})
onBeforeUnmount(() => minuteur && clearInterval(minuteur))

async function soumettre() {
  const body = texte.value.trim()
  if (body.length < 20) {
    erreur.value = 'Trop court pour être découpé — décris ce que tu veux obtenir.'
    return
  }
  envoi.value = true
  erreur.value = null
  try {
    const b = await api.createBrief(props.slug, body)
    briefs.value = [b, ...briefs.value]
    texte.value = ''
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? "l'envoi a échoué"
  } finally {
    envoi.value = false
  }
}

async function appliquer(b: Brief) {
  const d = brouillon.value[b.id]
  if (!d) return
  try {
    await api.applyBrief(b.id, { chapter: d.chapter, intent: d.intent || null, steps: d.steps })
    await charger()
    emit('applique')
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? "le plan n'a pas pu être créé"
  }
}

async function jeter(b: Brief) {
  await api.deleteBrief(b.id).catch(() => undefined)
  briefs.value = briefs.value.filter((x) => x.id !== b.id)
}

function retirerEtape(id: number, i: number) {
  const d = brouillon.value[id]
  if (d) d.steps = d.steps.filter((_, n) => n !== i)
}

const RISQUES: BlastRadius[] = ['cosmetic', 'feature', 'api', 'critical']
const enCours = (b: Brief) => b.status === 'pending' || b.status === 'running'
</script>

<template>
  <section class="card p-5">
    <h2 class="text-ink-100 text-[14px]">Décrire d'un bloc</h2>
    <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
      Colle ta demande telle que tu l'as écrite — un prompt, un cahier des charges, des notes. Un
      agent la découpe en chapitre et étapes, avec un critère de preuve pour chacune. Il
      <strong class="text-ink-300">propose</strong> : rien n'entre dans le plan avant que tu l'aies
      relu et accepté.
    </p>

    <form class="mt-4" @submit.prevent="soumettre">
      <textarea
        v-model="texte"
        rows="7"
        class="w-full bg-ink-950 border border-ink-800 rounded px-3 py-2.5 text-[13px] text-ink-300 leading-relaxed focus:outline-none focus:border-run"
        placeholder="Ex. — Reprendre l'import d'employés Excel : accepter les .xlsx et .csv, refuser les doublons de matricule avec un message clair, produire un rapport téléchargeable des lignes rejetées, et couvrir le tout par des tests…"
      />
      <div class="flex items-center gap-3 mt-2.5">
        <button class="btn" :disabled="envoi || texte.trim().length < 20">
          {{ envoi ? 'envoi…' : 'découper' }}
        </button>
        <span class="text-ink-600 text-[11px]">
          Le découpage tourne sur ta machine, via l'agent — lance
          <code class="text-ink-400">orchestrator plan --watch</code> s'il n'est pas déjà en veille.
        </span>
      </div>
    </form>

    <p v-if="erreur" class="mt-3 text-fail text-[12px]">{{ erreur }}</p>

    <div v-if="briefs.length" class="mt-5 space-y-3">
      <article
        v-for="b in briefs"
        :key="b.id"
        class="border border-ink-800 rounded p-3.5"
        :class="b.status === 'failed' ? 'border-fail/40' : ''"
      >
        <header class="flex items-baseline gap-3 flex-wrap">
          <span class="label text-ink-600">brief #{{ b.id }}</span>
          <span
            class="label"
            :class="{
              'text-run': enCours(b),
              'text-halt': b.status === 'proposed',
              'text-proof': b.status === 'applied',
              'text-fail': b.status === 'failed',
            }"
          >
            {{
              b.status === 'pending'
                ? "en attente d'un agent"
                : b.status === 'running'
                  ? 'découpage en cours'
                  : b.status === 'proposed'
                    ? 'à relire'
                    : b.status === 'applied'
                      ? 'appliqué au plan'
                      : 'échec'
            }}
          </span>
          <button class="label hover:text-fail ml-auto" @click="jeter(b)">jeter</button>
        </header>

        <p v-if="enCours(b)" class="text-ink-500 text-[12px] mt-2">
          {{ b.body.slice(0, 160) }}{{ b.body.length > 160 ? '…' : '' }}
        </p>

        <pre
          v-if="b.status === 'failed'"
          class="mt-2 text-[11px] text-ink-400 whitespace-pre-wrap max-h-40 overflow-y-auto"
          >{{ b.error }}</pre
        >

        <div v-if="b.status === 'proposed' && brouillon[b.id]" class="mt-3 space-y-2.5">
          <input
            v-model="brouillon[b.id].chapter"
            class="w-full bg-transparent text-ink-100 border-b border-ink-800 focus:border-run focus:outline-none pb-1"
          />

          <div
            v-for="(e, i) in brouillon[b.id].steps"
            :key="i"
            class="border border-ink-800 rounded p-2.5"
          >
            <div class="flex items-baseline gap-2">
              <span class="text-ink-600 text-[11px]">{{ i + 1 }}</span>
              <input
                v-model="e.title"
                class="flex-1 bg-transparent text-ink-100 border-b border-transparent hover:border-ink-700 focus:border-run focus:outline-none"
              />
              <button class="label hover:text-fail" title="retirer" @click="retirerEtape(b.id, i)">
                ×
              </button>
            </div>
            <textarea
              v-model="e.proof_spec"
              rows="4"
              placeholder="Ce qui prouvera que c'est fini"
              class="mt-2 w-full bg-ink-950 border rounded px-2.5 py-1.5 text-[12px] text-ink-300 leading-relaxed resize-y focus:outline-none focus:border-run"
              :class="e.proof_spec ? 'border-ink-800' : 'border-halt/40'"
            />
            <div class="flex items-center gap-2 mt-2">
              <span class="label">Risque</span>
              <select
                v-model="e.blast_radius"
                class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
              >
                <option v-for="r in RISQUES" :key="r" :value="r">{{ blastLabel[r] }}</option>
              </select>
              <span v-if="!e.proof_spec" class="text-halt text-[11px]"
                >sans critère, cette étape restera à préciser</span
              >
            </div>
          </div>

          <div class="flex items-center gap-3 pt-1">
            <button class="btn" @click="appliquer(b)">créer ce plan</button>
            <span class="text-ink-600 text-[11px]"
              >{{ brouillon[b.id].steps.length }} étape(s) · découpé par
              {{ b.harness ?? 'un agent' }}</span
            >
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
