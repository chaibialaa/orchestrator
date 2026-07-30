<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { api, type Objective, type Passage, type Evidence } from '../api'
import Chips from '../components/Chips.vue'
import {


  evidenceVerdictLabel,
  formatTokens,
  haltHelp,
  harnessLabel,
} from '../labels'

const props = defineProps<{ id: string }>()

const objective = ref<Objective | null>(null)
const loading = ref(true)
const enCours = ref(false)
const detailsOuverts = ref(false)
const deplie = ref<Set<number>>(new Set())
const apercu = ref<{ url: string; nom: string; texte?: string; id: number } | null>(null)

async function load() {
  loading.value = true
  objective.value = await api.objective(props.id)
  loading.value = false
}

onMounted(load)
watch(() => props.id, load)

async function prononcer(decision: 'accept' | 'reject') {
  enCours.value = true
  try {
    await api.verdict(Number(props.id), decision)
    await load()
  } finally {
    enCours.value = false
  }
}

async function ouvrir(evidenceId: number, chemin: string, n: number) {
  const url = api.evidenceFileUrl(evidenceId, n)
  const nom = chemin.split('/').pop() ?? chemin
  if (/\.(md|json|txt)$/i.test(chemin)) {
    const texte = await fetch(url).then((r) => r.text()).catch(() => 'lecture impossible')
    apercu.value = { url, nom, texte, id: evidenceId }
  } else {
    apercu.value = { url, nom, id: evidenceId }
  }
}

function voisine(pas: number) {
  const l = preuves.value
  const i = l.findIndex((e) => e.id === apercu.value?.id)
  const s = l[(i + pas + l.length) % l.length]
  if (s?.files?.length) ouvrir(s.id, s.files[0], 0)
}

function bascule(id: number) {
  const s = new Set(deplie.value)
  s.has(id) ? s.delete(id) : s.add(id)
  deplie.value = s
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '—')

function duree(p: Passage) {
  if (!p.ended_at) return 'en cours'
  const min = Math.round(
    (new Date(p.ended_at).getTime() - new Date(p.started_at).getTime()) / 60000,
  )
  return min < 60 ? `${min} min` : `${(min / 60).toFixed(1)} h`
}

function nomOutil(t: string) {
  return t.startsWith('mcp__') ? t.split('__').slice(2).join('__') || t : t
}

/** Le jargon des harnais n'a pas à traverser jusqu'à l'écran. */
function raisonLisible(texte: string | null) {
  if (!texte) return ''
  if (/multiple operations|require approval/i.test(texte)) return 'commande shell non autorisée'
  if (/redirection.*blocked|may only/i.test(texte)) return 'écriture hors du dépôt refusée'
  if (/permissions to use/i.test(texte)) return 'outil non autorisé'
  if (/délai|timeout/i.test(texte)) return texte
  if (/[Ss]onde/.test(texte)) return 'sonde de diagnostic'
  return texte.length > 90 ? texte.slice(0, 90) + '…' : texte
}

const passages = computed(() =>
  [...(objective.value?.passages ?? [])].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  ),
)

/** Ce qui a produit du travail — le reste est du bruit d'exploitation. */
const ordreDeplie = ref<Set<number>>(new Set())
function basculeOrdre(id: number) {
  const s = new Set(ordreDeplie.value)
  s.has(id) ? s.delete(id) : s.add(id)
  ordreDeplie.value = s
}
function tailleOrdre(m: string) {
  const lignes = m.split('\n').length
  return `${lignes} ligne${lignes > 1 ? 's' : ''}`
}

const utiles = computed(() => passages.value.filter((p) => p.verdict === 'advanced' || !p.ended_at))
const bruit = computed(() => passages.value.filter((p) => p.verdict !== 'advanced' && p.ended_at))

const preuves = computed(() => {
  const o = objective.value
  if (!o) return []
  const tout = [...(o.evidences ?? []), ...(o.passages ?? []).flatMap((p) => p.evidences ?? [])]
  const vues = new Set<number>()
  return tout.filter((e) => {
    if (!e.files?.length || vues.has(e.id)) return false
    vues.add(e.id)
    return true
  })
})

/** Les constats sans fichier : scores, mesures, réserves. */
const constats = computed(() => {
  const o = objective.value
  if (!o) return [] as Evidence[]
  const tout = [...(o.evidences ?? []), ...(o.passages ?? []).flatMap((p) => p.evidences ?? [])]
  const vues = new Set<number>()
  return tout.filter((e) => {
    if (e.files?.length || vues.has(e.id)) return false
    vues.add(e.id)
    return true
  })
})

const openHalts = computed(() => objective.value?.halts?.filter((h) => !h.resolved_at) ?? [])

const totaux = computed(() => {
  const p = objective.value?.passages ?? []
  return {
    tokens: p.reduce((s, x) => s + (x.tokens ?? 0), 0),
    cost: p.reduce((s, x) => s + Number(x.cost_usd ?? 0), 0),
    // « advanced » compte comme produit même si la tentative a été
    // interrompue : le travail est là. Le reste est du coût sans résultat.
    perdu: p
      .filter((x) => x.verdict !== 'advanced')
      .reduce((s, x) => s + Number(x.cost_usd ?? 0), 0),
  }
})

const estImage = (f: string) => /\.(png|jpg|jpeg|webp)$/i.test(f)
</script>

<template>
  <div v-if="loading" class="text-ink-400">chargement…</div>

  <div v-else-if="objective" class="space-y-8 pb-16">
    <!-- CE QU'ON DEMANDAIT -->
    <header>
      <div class="flex items-start gap-4 flex-wrap">
        <h1 class="text-[20px] text-ink-100 flex-1 min-w-0">{{ objective.title }}</h1>
        <div class="flex gap-1.5 shrink-0">
          <Chips kind="status" :value="objective.status" />
          <Chips kind="blast" :value="objective.blast_radius" />
        </div>
      </div>

      <p v-if="objective.intent" class="text-ink-400 mt-2 leading-relaxed max-w-3xl">
        {{ objective.intent }}
      </p>

      <div
        class="mt-5 pl-4 border-l-2"
        :class="objective.proof_spec ? 'border-ink-600' : 'border-fail'"
      >
        <div class="label">Ce qui doit être vrai pour conclure</div>
        <p
          class="mt-1.5 leading-relaxed"
          :class="objective.proof_spec ? 'text-ink-100 text-[15px]' : 'text-fail'"
        >
          {{
            objective.proof_spec ??
            "Personne n'a répondu à cette question. Aucun agent ne peut prendre cet objectif tant qu'elle n'a pas de réponse."
          }}
        </p>
      </div>
    </header>

    <!-- LA DÉCISION -->
    <section
      v-if="objective.gate?.ready && objective.status !== 'proven'"
      class="border border-proof/40 bg-proof/[0.05] rounded p-5"
    >
      <div class="flex items-start gap-5 flex-wrap">
        <div class="flex-1 min-w-[16rem]">
          <div class="text-proof text-[15px]">Il ne manque que ton verdict</div>
          <p class="text-ink-300 mt-1.5 leading-relaxed">{{ objective.gate.detail }}</p>
        </div>
        <div class="flex gap-2 shrink-0">
          <button
            class="px-4 py-2 rounded border border-proof text-proof bg-proof/10 hover:bg-proof/20 text-[13px] transition-colors disabled:opacity-40"
            :disabled="enCours"
            @click="prononcer('accept')"
          >
            {{ enCours ? '…' : 'Le critère est rempli' }}
          </button>
          <button
            class="px-4 py-2 rounded border border-ink-600 text-ink-400 hover:border-fail hover:text-fail text-[13px] transition-colors disabled:opacity-40"
            :disabled="enCours"
            @click="prononcer('reject')"
          >
            Non, à refaire
          </button>
        </div>
      </div>
    </section>

    <section v-if="objective.status === 'proven'" class="flex items-center gap-3 text-proof">
      <span class="w-2 h-2 rounded-full bg-proof" />
      <span>Validé{{ objective.proven_at ? ` le ${objective.proven_at.slice(0, 10)}` : '' }}</span>
    </section>

    <!-- CE QUI T'ATTEND -->
    <section v-if="openHalts.length" class="space-y-2.5">
      <div v-for="h in openHalts" :key="h.id" class="border-l-2 border-halt pl-4 py-1">
        <div class="flex items-center gap-2 flex-wrap">
          <Chips kind="halt" :value="h.reason" />
          <span class="text-ink-600 text-[11px]">{{ h.created_at?.slice(0, 16) }}</span>
        </div>
        <p class="text-ink-300 mt-1.5 leading-relaxed">{{ haltHelp[h.reason] }}</p>
        <p v-if="h.detail" class="text-ink-500 text-[12px] mt-1.5 whitespace-pre-wrap">
          {{ h.detail }}
        </p>
      </div>
    </section>

    <!-- CE QUI EST SORTI -->
    <section v-if="preuves.length" id="preuves" class="scroll-mt-20">
      <h2 class="label mb-3">Ce qui est sorti — {{ preuves.length }}</h2>
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <button
          v-for="e in preuves"
          :key="e.id"
          class="text-left group"
          @click="ouvrir(e.id, e.files![0], 0)"
        >
          <div
            class="aspect-[4/3] bg-ink-950 rounded border overflow-hidden flex items-center justify-center transition-colors"
            :class="
              e.verdict === 'fail'
                ? 'border-fail/40 group-hover:border-fail'
                : e.verdict === 'pass'
                  ? 'border-proof/30 group-hover:border-proof'
                  : 'border-ink-700 group-hover:border-ink-500'
            "
          >
            <img
              v-if="estImage(e.files![0])"
              :src="api.evidenceFileUrl(e.id, 0, 480)"
              :alt="e.label"
              class="w-full h-full object-cover"
              loading="lazy"
              decoding="async"
            />
            <span v-else class="text-ink-600 text-[24px] uppercase tracking-widest">
              {{ e.files![0].split('.').pop() }}
            </span>
          </div>
          <div class="mt-2 flex items-start gap-1.5">
            <span
              class="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
              :class="{
                'bg-proof': e.verdict === 'pass',
                'bg-fail': e.verdict === 'fail',
                'bg-ink-600': e.verdict === 'inconclusive',
              }"
            />
            <span class="text-[12px] text-ink-300 leading-snug">{{ e.label }}</span>
          </div>
        </button>
      </div>
    </section>

    <!-- CE QU'ON A MESURÉ -->
    <section v-if="constats.length">
      <h2 class="label mb-3">Ce qu'on a mesuré</h2>
      <div class="space-y-2">
        <div v-for="e in constats" :key="e.id" class="flex items-start gap-2.5">
          <span
            class="w-1.5 h-1.5 rounded-full shrink-0 mt-2"
            :class="{
              'bg-proof': e.verdict === 'pass',
              'bg-fail': e.verdict === 'fail',
              'bg-ink-600': e.verdict === 'inconclusive',
            }"
          />
          <div class="flex-1">
            <div class="text-ink-200">{{ e.label }}</div>
            <div v-if="e.ref" class="text-ink-500 text-[12px] mt-0.5">{{ e.ref }}</div>
          </div>
          <span
            class="text-[11px] shrink-0"
            :class="
              e.verdict === 'pass' ? 'text-proof' : e.verdict === 'fail' ? 'text-fail' : 'text-ink-600'
            "
            >{{ evidenceVerdictLabel[e.verdict] }}</span
          >
        </div>
      </div>
    </section>

    <!-- CE QUE ÇA A COÛTÉ -->
    <section v-if="totaux.tokens" class="flex items-baseline gap-6 text-[13px] border-t border-ink-800 pt-4">
      <span class="text-ink-400">
        <span class="text-ink-100 text-[15px]">${{ totaux.cost.toFixed(2) }}</span> dépensés
      </span>
      <span v-if="totaux.perdu > 0.5" class="text-ink-500">
        dont ${{ totaux.perdu.toFixed(2) }} sans résultat
      </span>
      <span class="text-ink-500">{{ formatTokens(totaux.tokens) }} tokens</span>
      <span class="text-ink-500">{{ passages.length }} tentatives</span>
    </section>

    <!-- COMMENT ON Y EST ARRIVÉ -->
    <section v-if="passages.length">
      <button
        class="label hover:text-ink-300 transition-colors"
        @click="detailsOuverts = !detailsOuverts"
      >
        {{ detailsOuverts ? '▾' : '▸' }} Comment on y est arrivé — {{ utiles.length }} tentative(s)
        utile(s)<template v-if="bruit.length">, {{ bruit.length }} sans effet</template>
      </button>

      <div v-if="detailsOuverts" class="mt-4 space-y-4">
        <article
          v-for="p in utiles"
          :key="p.id"
          class="border-l-2 pl-4"
          :class="p.verdict === 'advanced' ? 'border-proof/50' : 'border-ink-700'"
        >
          <div class="flex items-center gap-2.5 flex-wrap">
            <Chips kind="harness" :value="p.harness" />
            <Chips v-if="p.verdict" kind="verdict" :value="p.verdict" />
            <span class="text-ink-500 text-[12px]">{{ duree(p) }}</span>
            <span v-if="p.tokens" class="text-ink-500 text-[12px]"
              >{{ formatTokens(p.tokens) }} tokens</span
            >
            <span v-if="Number(p.cost_usd)" class="text-ink-500 text-[12px]"
              >${{ Number(p.cost_usd).toFixed(2) }}</span
            >
            <span
              v-if="p.resumed_from"
              class="text-halt text-[11px]"
              title="cette tentative a repris une session précédente : une partie du contexte ne vient pas de sa mission"
              >reprise de {{ p.resumed_from.slice(0, 8) }}</span
            >
            <span
              v-if="p.git_before !== p.git_after"
              class="text-ink-600 text-[11px] ml-auto"
              title="état du dépôt avant et après"
              >{{ short(p.git_before) }} → {{ short(p.git_after) }}</span
            >
          </div>

          <div v-if="p.tools_used && Object.keys(p.tools_used).length" class="mt-2.5 flex flex-wrap gap-1.5">
            <span
              v-for="(n, t) in p.tools_used"
              :key="t"
              class="text-[11px] text-ink-500"
              :title="String(t)"
            >
              {{ nomOutil(String(t)) }}<span class="text-ink-700">×{{ n }}</span>
            </span>
          </div>

          <div v-if="p.mission" class="mt-3">
            <button class="label hover:text-ink-300 transition-colors" @click="basculeOrdre(p.id)">
              {{ ordreDeplie.has(p.id) ? '▾' : '▸' }} L’ordre reçu —
              <span class="text-ink-600">{{ tailleOrdre(p.mission) }}</span>
            </button>
            <pre
              v-if="ordreDeplie.has(p.id)"
              class="mt-2 p-3 bg-ink-950 border border-ink-800 rounded text-[12px] text-ink-300 whitespace-pre-wrap overflow-x-auto max-h-[28rem]"
            >{{ p.mission }}</pre>
          </div>

          <div v-if="p.said" class="mt-3">
            <button class="label hover:text-ink-300 transition-colors" @click="bascule(p.id)">
              {{ deplie.has(p.id) ? '▾' : '▸' }} Son compte rendu
            </button>
            <pre
              v-if="deplie.has(p.id)"
              class="mt-2 p-3 bg-ink-950 border border-ink-800 rounded text-[12px] text-ink-300 whitespace-pre-wrap overflow-x-auto max-h-[28rem]"
            >{{ p.said }}</pre>
          </div>
        </article>

        <div v-if="bruit.length" class="border-l-2 border-ink-800 pl-4 pt-1">
          <div class="label mb-2">Tentatives sans effet</div>
          <div v-for="p in bruit" :key="p.id" class="flex items-baseline gap-2.5 text-[12px] py-0.5">
            <span class="text-ink-600">{{ harnessLabel[p.harness] ?? p.harness }}</span>
            <span class="text-ink-500 flex-1">{{ raisonLisible(p.prevented_by) || 'sans résultat' }}</span>
            <span class="text-ink-700">{{ duree(p) }}</span>
            <span v-if="Number(p.cost_usd)" class="text-ink-700"
              >${{ Number(p.cost_usd).toFixed(2) }}</span
            >
          </div>
        </div>
      </div>
    </section>

    <!-- Panneau des preuves -->
    <Teleport to="body">
      <div v-if="apercu" class="fixed inset-0 z-50 flex">
        <div class="flex-1 bg-ink-950/85 backdrop-blur-sm" @click="apercu = null" />
        <aside class="w-[min(820px,92vw)] h-full bg-ink-900 border-l border-ink-700 flex flex-col">
          <header class="px-4 py-3 border-b border-ink-800 flex items-center gap-2.5">
            <span class="text-ink-100 flex-1 truncate text-[13px]">{{ apercu.nom }}</span>
            <template v-if="preuves.length > 1">
              <button class="btn px-2" @click="voisine(-1)">‹</button>
              <button class="btn px-2" @click="voisine(1)">›</button>
            </template>
            <a :href="apercu.url" target="_blank" class="btn">taille réelle</a>
            <button class="btn" @click="apercu = null">fermer</button>
          </header>
          <div class="flex-1 overflow-auto p-4 bg-ink-950">
            <pre
              v-if="apercu.texte !== undefined"
              class="text-[12px] text-ink-300 whitespace-pre-wrap"
            >{{ apercu.texte }}</pre>
            <img v-else :src="apercu.url" :alt="apercu.nom" class="w-full rounded" />
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>
