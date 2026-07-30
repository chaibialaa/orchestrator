<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed } from 'vue'
import { api, type Project, type Scan } from '../api'

const emit = defineEmits<{ applique: [] }>()

const scans = ref<Scan[]>([])
const projets = ref<Project[]>([])
const erreur = ref<string | null>(null)
const ouvert = ref<Record<string, boolean>>({})
const cible = ref<Record<string, string>>({})
let minuteur: ReturnType<typeof setInterval> | null = null

// Le dernier relevé n'est pas forcément le plus utile : un inventaire tout
// neuf sans distillation cache une analyse complète faite juste avant. On
// montre donc celui qui a des résultats, et on signale l'autre.
const dernier = computed(() => scans.value.find((s) => s.result) ?? scans.value[0] ?? null)
const inventairePlusRecent = computed(() => {
  const tete = scans.value[0]
  return tete && dernier.value && tete.id !== dernier.value.id ? tete : null
})
const enCours = (s: Scan | null) => s && ['pending', 'running'].includes(s.status)

async function charger() {
  try {
    ;[scans.value, projets.value] = await Promise.all([api.scans(), api.projects()])
  } catch {
    /* la vue d'ensemble ne doit pas tomber pour ça */
  }
}

onMounted(() => {
  charger()
  minuteur = setInterval(() => enCours(dernier.value) && charger(), 4000)
})
onBeforeUnmount(() => minuteur && clearInterval(minuteur))

async function lancer() {
  erreur.value = null
  try {
    scans.value = [await api.createScan(), ...scans.value]
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? "le relevé n'a pas pu être demandé"
  }
}

async function appliquer(id: number, nom: string, bloc: NonNullable<Scan['result']>[string]) {
  const slug = cible.value[nom]
  if (!slug) return
  try {
    await api.applyScan(id, slug, {
      title: bloc.titre,
      body: [
        bloc.contexte ?? '',
        bloc.contraintes?.length ? '\n**Contraintes**\n' + bloc.contraintes.map((c) => `- ${c}`).join('\n') : '',
        bloc.contradictions?.length ? '\n**Contradictions relevées**\n' + bloc.contradictions.map((c) => `- ${c}`).join('\n') : '',
      ]
        .filter(Boolean)
        .join('\n'),
      sources: bloc.sources,
    })
    cible.value = { ...cible.value, [nom]: '' }
    erreur.value = null
    ouvert.value = { ...ouvert.value, [nom]: false }
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? "le contexte n'a pas pu être rattaché"
  }
}

/** Un identifiant de projet lisible, déduit du nom : minuscules, tirets. */
function versSlug(nom: string) {
  return nom
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

const existe = (nom: string) => projets.value.some((p) => p.slug === versSlug(nom))

const depot = ref<Record<string, string>>({})

/** Le corps du contexte, assemblé comme à l'application. */
function corps(bloc: NonNullable<Scan['result']>[string]) {
  return [
    bloc.contexte ?? '',
    bloc.contraintes?.length ? '\n**Contraintes**\n' + bloc.contraintes.map((c) => `- ${c}`).join('\n') : '',
    bloc.contradictions?.length
      ? '\n**Contradictions relevées**\n' + bloc.contradictions.map((c) => `- ${c}`).join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Crée le projet à partir du contexte distillé. C'était l'intention d'origine
 * du relevé : découvrir les projets dans les mémoires, pas seulement enrichir
 * ceux qu'on avait déclarés à la main.
 */
async function creerProjet(id: number, nom: string, bloc: NonNullable<Scan['result']>[string]) {
  try {
    await api.createProjectFromScan(id, {
      slug: versSlug(nom),
      name: nom,
      repo_path: depot.value[nom]?.trim() || null,
      title: bloc.titre,
      body: corps(bloc),
      sources: bloc.sources,
    })
    await charger()
    emit('applique')
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? "le projet n'a pas pu être créé"
  }
}

const ko = (o: number) => `${Math.round(o / 1024)} ko`

function attente(min: number) {
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} jour${h >= 48 ? 's' : ''}`
}
</script>

<template>
  <section class="card p-5">
    <div class="flex items-start gap-4 flex-wrap">
      <div class="flex-1 min-w-[20rem]">
        <h2 class="text-ink-100 text-[14px]">Les mémoires laissées sur cette machine</h2>
        <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
          Instructions de projet, mémoire du harnais, règles Codex : ce qu'on a appris est
          éparpillé et plus personne ne le relit. Le relevé dit
          <strong class="text-ink-300">ce qui existe et où</strong> — c'est gratuit. La
          distillation, elle, coûte un appel de modèle par projet et ne part
          <strong class="text-ink-300">que sur ta demande</strong>.
        </p>
      </div>
      <button class="btn shrink-0" :disabled="Boolean(enCours(dernier))" @click="lancer">
        {{ enCours(dernier) ? 'relevé en cours…' : 'analyser les mémoires locales' }}
      </button>
    </div>

    <p v-if="erreur" class="mt-3 text-fail text-[12px]">{{ erreur }}</p>

    <p
      v-if="enCours(dernier)"
      class="mt-4 text-[12px]"
      :class="(dernier?.attente_minutes ?? 0) > 5 ? 'text-halt' : 'text-ink-500'"
    >
      <template v-if="(dernier?.attente_minutes ?? 0) > 5">
        <strong>Personne ne l'a pris depuis {{ attente(dernier!.attente_minutes!) }}.</strong>
        Aucun agent n'écoute sur cette machine. Lance
        <code class="text-ink-300">orchestrator memory:scan --watch --analyser</code> depuis un dépôt
        suivi — sinon ce relevé attendra indéfiniment.
      </template>
      <template v-else>
        En attente d'un agent — lance
        <code class="text-ink-400">orchestrator memory:scan --watch --analyser</code> sur la machine
        à inspecter. Le disque n'est lu que là-bas, jamais par le serveur.
      </template>
    </p>

    <p v-if="dernier?.perime" class="mt-3 text-halt text-[12px]">
      Les mémoires ont changé depuis ce relevé — ce qu'il montre n'est plus l'état du moment.
    </p>

    <p v-if="inventairePlusRecent" class="mt-3 text-ink-500 text-[12px]">
      Un inventaire plus récent existe (relevé #{{ inventairePlusRecent.id }}) mais n'a pas été
      distillé. Ce qui suit vient du relevé #{{ dernier?.id }}.
    </p>

    <div v-if="dernier?.inventory" class="mt-5">
      <div class="label mb-2">
        Trouvé — {{ dernier.inventory.total }} fichiers, {{ ko(dernier.inventory.octets) }}
      </div>
      <div
        v-for="(p, nom) in dernier.inventory.projets"
        :key="nom"
        class="flex items-baseline gap-3 py-1 text-[12px] border-b border-ink-850 last:border-0"
      >
        <span class="text-ink-100 flex-1 truncate" :title="String(nom)">{{ nom }}</span>
        <span class="text-ink-500">{{ p.nombre }} fichiers</span>
        <span class="text-ink-600 w-16 text-right">{{ ko(p.octets) }}</span>
      </div>
    </div>

    <div v-if="dernier?.result" class="mt-6 space-y-3">
      <div class="label">Ce qui en a été tiré — à rattacher, ou pas</div>
      <article
        v-for="(bloc, nom) in dernier.result"
        :key="nom"
        class="border border-ink-800 rounded p-3.5"
        :class="bloc.erreur ? 'border-fail/40' : ''"
      >
        <header class="flex items-baseline gap-3 flex-wrap">
          <span class="text-ink-100">{{ bloc.titre ?? nom }}</span>
          <span v-if="bloc.releve_sous && bloc.releve_sous !== nom" class="label text-ink-600"
            >relevé sous {{ bloc.releve_sous }}</span
          >
          <span v-if="bloc.contraintes?.length" class="label text-proof"
            >{{ bloc.contraintes.length }} contraintes</span
          >
          <span v-if="bloc.contradictions?.length" class="label text-halt"
            >{{ bloc.contradictions.length }} contradictions</span
          >
          <span v-if="bloc.perime?.length" class="label text-ink-500"
            >{{ bloc.perime.length }} périmées</span
          >
          <button
            class="label hover:text-run ml-auto"
            @click="ouvert = { ...ouvert, [nom]: !ouvert[nom] }"
          >
            {{ ouvert[nom] ? '▾ replier' : '▸ lire' }}
          </button>
        </header>

        <p v-if="bloc.erreur" class="text-fail text-[12px] mt-2">{{ bloc.erreur }}</p>

        <div v-if="ouvert[nom]" class="mt-3 space-y-3">
          <pre
            class="p-3 bg-ink-950 border border-ink-800 rounded text-[12px] text-ink-300 whitespace-pre-wrap max-h-80 overflow-y-auto"
            >{{ bloc.contexte }}</pre
          >
          <ul v-if="bloc.contraintes?.length" class="space-y-1">
            <li v-for="c in bloc.contraintes" :key="c" class="text-ink-300 text-[12px]">— {{ c }}</li>
          </ul>
          <p v-if="bloc.laisses_nombre" class="text-ink-600 text-[11px]">
            {{ bloc.laisses_nombre }} fichier(s) laissés de côté, trop volumineux pour une seule lecture.
          </p>
          <p class="text-ink-600 text-[11px]">{{ bloc.sources_nombre ?? bloc.sources?.length ?? 0 }} fichier(s) lus.</p>
        </div>

        <div v-if="!bloc.erreur" class="mt-3 space-y-2">
          <div v-if="existe(String(nom))" class="flex items-center gap-2 flex-wrap">
            <span class="label text-proof">projet déjà suivi</span>
            <select
              v-model="cible[nom]"
              class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
            >
              <option value="">rattacher au projet…</option>
              <option v-for="p in projets" :key="p.slug" :value="p.slug">{{ p.name }}</option>
            </select>
            <button class="btn" :disabled="!cible[nom]" @click="appliquer(dernier!.id, String(nom), bloc)">
              en faire une décision du projet
            </button>
            <span class="text-ink-600 text-[11px]"
              >elle sera relue par l'agent à chaque brief — c'est tout l'intérêt</span
            >
          </div>

          <div v-else class="flex items-center gap-2 flex-wrap">
            <span class="label text-halt">projet non suivi</span>
            <code class="text-[11px] text-ink-500">{{ versSlug(String(nom)) }}</code>
            <input
              v-model="depot[nom]"
              placeholder="chemin du dépôt (facultatif)"
              class="flex-1 min-w-[16rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
            />
            <button class="btn" @click="creerProjet(dernier!.id, String(nom), bloc)">
              créer ce projet
            </button>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
