<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type Storage } from '../api'

const liste = ref<Storage[]>([])
const erreur = ref<string | null>(null)
const occupe = ref<Record<number, string>>({})
const bilan = ref<Record<number, string>>({})
const secret = ref<Record<number, string>>({})

const nouveau = ref({ provider: 'gdrive' as Storage['provider'], label: '', target: '' })

async function charger() {
  try {
    liste.value = await api.storages()
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? 'erreur'
  }
}
onMounted(charger)

async function creer() {
  if (!nouveau.value.label.trim()) return
  try {
    liste.value = [...liste.value, await api.createStorage({ ...nouveau.value })]
    nouveau.value = { provider: 'gdrive', label: '', target: '' }
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? 'création impossible'
  }
}

async function patch(s: Storage, champ: string, valeur: unknown) {
  try {
    Object.assign(s, await api.updateStorage(s.id, { [champ]: valeur }))
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? "l'enregistrement a échoué"
  }
}

/** L'identifiant est collé tel quel : JSON de compte de service, ou jeton brut. */
async function poserSecret(s: Storage) {
  const brut = (secret.value[s.id] ?? '').trim()
  if (!brut) return
  let charge: unknown
  try {
    charge = JSON.parse(brut)
  } catch {
    // Un jeton Dropbox n'est pas du JSON : on l'enveloppe pour lui.
    charge = { token: brut }
  }
  try {
    Object.assign(s, await api.updateStorage(s.id, { credentials: charge }))
    secret.value = { ...secret.value, [s.id]: '' }
    erreur.value = null
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? 'identifiant refusé'
  }
}

const courriel = ref<Record<number, string>>({})

/** Crée le dossier et le partage : l'humain n'a pas à le faire à la main. */
async function preparer(s: Storage) {
  occupe.value = { ...occupe.value, [s.id]: 'préparation…' }
  try {
    const r = await api.prepareStorage(s.id, { partager_avec: courriel.value[s.id]?.trim() || undefined })
    bilan.value = {
      ...bilan.value,
      [s.id]: `dossier « ${r.dossier.nom} » créé` + (r.dossier.partage ? ` · ${r.dossier.partage}` : ''),
    }
    await charger()
    erreur.value = null
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? 'préparation impossible'
  } finally {
    occupe.value = { ...occupe.value, [s.id]: '' }
  }
}

async function verifier(s: Storage) {
  occupe.value = { ...occupe.value, [s.id]: 'vérification…' }
  try {
    Object.assign(s, await api.checkStorage(s.id))
    erreur.value = null
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? 'vérification impossible'
    await charger()
  } finally {
    occupe.value = { ...occupe.value, [s.id]: '' }
  }
}

async function envoyer(s: Storage) {
  occupe.value = { ...occupe.value, [s.id]: 'envoi…' }
  try {
    const r = await api.syncStorage(s.id)
    bilan.value = {
      ...bilan.value,
      [s.id]:
        `${r.envoyes.length} preuve(s) envoyée(s)` +
        (r.echecs.length ? ` · ${r.echecs.length} en échec : ${r.echecs[0].erreur}` : '') +
        (r.restant ? ` · ${r.restant} restante(s)` : ' · tout est là-bas'),
    }
    await charger()
  } catch (e: any) {
    erreur.value = e?.response?.data?.message ?? "l'envoi a échoué"
  } finally {
    occupe.value = { ...occupe.value, [s.id]: '' }
  }
}

async function retirer(s: Storage) {
  await api.deleteStorage(s.id).catch(() => undefined)
  liste.value = liste.value.filter((x) => x.id !== s.id)
}

const FOURNISSEURS = {
  gdrive: {
    nom: 'Google Drive',
    aide: "Colle le fichier JSON d'un compte de service, puis partage un dossier Drive avec son adresse en droit d'écriture et mets l'identifiant du dossier ci-dessous.",
    champ: "identifiant du dossier Drive (la fin de son URL)",
  },
  dropbox: {
    nom: 'Dropbox',
    aide: "Crée une application dans la console Dropbox, génère un jeton d'accès, et colle-le. Le chemin est créé au besoin.",
    champ: 'chemin du dossier, ex. /Orchestrator',
  },
} as const

const ETAT = {
  ok: { mot: 'joignable', couleur: 'text-proof', puce: 'bg-proof' },
  refused: { mot: 'refusé', couleur: 'text-fail', puce: 'bg-fail' },
  absent: { mot: 'introuvable', couleur: 'text-fail', puce: 'bg-fail' },
  unknown: { mot: 'jamais vérifié', couleur: 'text-ink-500', puce: 'bg-ink-700' },
} as const
</script>

<template>
  <section class="card p-5">
    <h2 class="text-ink-100 text-[14px]">Où partager les preuves</h2>
    <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
      Les preuves vivent dans le dépôt. Pour qu'un coéquipier les lise sans l'avoir, on les dépose
      aussi sur un stockage distant. <strong class="text-ink-300">Pas d'OAuth</strong> : un compte de
      service Google ou un jeton d'application Dropbox, rien à réautoriser — c'est ce qui permet à
      l'outil de travailler la nuit.
    </p>
    <p class="text-ink-500 mt-2 text-[12px] max-w-3xl">
      Les identifiants sont chiffrés au repos et ne reviennent jamais à cet écran. Seules les preuves
      qui ne sont pas encore là-bas sont envoyées.
    </p>

    <p v-if="erreur" class="mt-3 text-fail text-[12px]">{{ erreur }}</p>

    <div v-if="liste.length" class="mt-5 space-y-3">
      <article v-for="s in liste" :key="s.id" class="border border-ink-800 rounded p-3.5" :class="s.enabled ? '' : 'opacity-50'">
        <header class="flex items-baseline gap-3 flex-wrap">
          <span class="w-1.5 h-1.5 rounded-full self-center shrink-0" :class="ETAT[s.last_status].puce" />
          <input
            class="bg-transparent text-ink-100 border-b border-transparent hover:border-ink-700 focus:border-run focus:outline-none min-w-[10rem]"
            :value="s.label"
            @change="patch(s, 'label', ($event.target as HTMLInputElement).value)"
          />
          <span class="label text-ink-600">{{ FOURNISSEURS[s.provider].nom }}</span>
          <span class="label" :class="ETAT[s.last_status].couleur">{{ ETAT[s.last_status].mot }}</span>
          <span v-if="s.envois" class="label text-ink-500">{{ s.envois }} preuve(s) déposée(s)</span>
          <label class="flex items-center gap-1.5 text-[11px] text-ink-400 ml-auto">
            <input type="checkbox" :checked="s.enabled" @change="patch(s, 'enabled', ($event.target as HTMLInputElement).checked)" />
            actif
          </label>
          <button class="label hover:text-fail" @click="retirer(s)">retirer</button>
        </header>

        <p v-if="s.last_detail" class="text-ink-500 text-[11px] mt-2">{{ s.last_detail }}</p>
        <p class="text-ink-500 text-[11px] mt-1">{{ FOURNISSEURS[s.provider].aide }}</p>

        <div v-if="s.provider === 'gdrive' && !s.target" class="flex items-center gap-2 mt-3 flex-wrap">
          <span class="label">Dossier</span>
          <input
            v-model="courriel[s.id]"
            placeholder="ton adresse Google, pour le voir dans « Partagés avec moi »"
            class="flex-1 min-w-[18rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
          />
          <button class="btn" :disabled="!s.has_credentials || Boolean(occupe[s.id])" @click="preparer(s)">
            {{ occupe[s.id] === 'préparation…' ? 'préparation…' : 'créer le dossier' }}
          </button>
        </div>

        <div class="flex items-center gap-2 mt-3 flex-wrap">
          <span class="label">Dossier</span>
          <input
            class="flex-1 min-w-[14rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
            :value="s.target ?? ''"
            :placeholder="FOURNISSEURS[s.provider].champ"
            @change="patch(s, 'target', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="flex items-center gap-2 mt-2 flex-wrap">
          <span class="label">Identifiant</span>
          <span v-if="s.has_credentials" class="label text-proof">enregistré</span>
          <textarea
            v-model="secret[s.id]"
            rows="1"
            :placeholder="s.has_credentials ? 'remplacer…' : (s.provider === 'gdrive' ? 'colle le JSON du compte de service' : 'colle le jeton d’accès')"
            class="flex-1 min-w-[16rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
          />
          <button class="btn" :disabled="!secret[s.id]?.trim()" @click="poserSecret(s)">poser</button>
          <button v-if="s.has_credentials" class="label hover:text-fail" @click="patch(s, 'credentials', null)">effacer</button>
        </div>

        <div class="flex items-center gap-3 mt-3 flex-wrap">
          <button class="btn" :disabled="!s.has_credentials || Boolean(occupe[s.id])" @click="verifier(s)">
            {{ occupe[s.id] === 'vérification…' ? 'vérification…' : 'vérifier' }}
          </button>
          <button
            class="btn"
            :disabled="!s.has_credentials || !s.enabled || Boolean(occupe[s.id])"
            @click="envoyer(s)"
          >
            {{ occupe[s.id] === 'envoi…' ? 'envoi…' : 'envoyer les preuves manquantes' }}
          </button>
          <span v-if="bilan[s.id]" class="text-ink-400 text-[12px]">{{ bilan[s.id] }}</span>
          <span v-else-if="s.last_sync_at" class="text-ink-600 text-[11px]">dernier envoi {{ s.last_sync_at }}</span>
        </div>
      </article>
    </div>

    <form class="mt-5 flex gap-2 flex-wrap items-center" @submit.prevent="creer">
      <select
        v-model="nouveau.provider"
        class="bg-ink-950 border border-ink-800 rounded px-2 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
      >
        <option value="gdrive">Google Drive</option>
        <option value="dropbox">Dropbox</option>
      </select>
      <input
        v-model="nouveau.label"
        placeholder="nom lisible — ex. « Preuves Atlas »"
        class="flex-1 min-w-[14rem] bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
      />
      <button class="btn" :disabled="!nouveau.label.trim()">ajouter un stockage</button>
    </form>
  </section>
</template>
