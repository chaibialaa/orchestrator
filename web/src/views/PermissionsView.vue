<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { http } from '../api'

const props = defineProps<{ slug: string }>()

type Decision = 'allow' | 'deny' | 'ask'

interface Perm {
  id: number
  pattern: string
  decision: Decision
  harness: string
  label: string | null
  note: string | null
  requested: number
  last_requested_at: string | null
  family: string
}

const perms = ref<Perm[]>([])
const loading = ref(true)
const filter = ref('')

async function load() {
  loading.value = true
  perms.value = (await http.get<Perm[]>(`/projects/${props.slug}/permissions`)).data
  loading.value = false
}

onMounted(load)
watch(() => props.slug, load)

async function setDecision(p: Perm, decision: Decision) {
  if (p.decision === decision) return
  const updated = (await http.patch<Perm>(`/permissions/${p.id}`, { decision })).data
  Object.assign(p, updated)
}

async function setFamily(family: string, decision: Decision) {
  const targets = grouped.value[family].filter((p) => p.decision !== decision)
  for (const p of targets) await setDecision(p, decision)
}

const q = computed(() => filter.value.trim().toLowerCase())

const visible = computed(() =>
  q.value
    ? perms.value.filter(
        (p) => p.pattern.toLowerCase().includes(q.value) || (p.label ?? '').toLowerCase().includes(q.value),
      )
    : perms.value,
)

const grouped = computed(() => {
  const out: Record<string, Perm[]> = {}
  for (const p of visible.value) (out[p.family] ??= []).push(p)
  return out
})

const pending = computed(() => perms.value.filter((p) => p.decision === 'ask'))
const counts = computed(() => ({
  allow: perms.value.filter((p) => p.decision === 'allow').length,
  deny: perms.value.filter((p) => p.decision === 'deny').length,
  ask: pending.value.length,
}))

const decisionStyle: Record<Decision, string> = {
  allow: 'border-proof text-proof bg-proof/10',
  deny: 'border-fail text-fail bg-fail/10',
  ask: 'border-halt text-halt bg-halt/10',
}

const decisionLabel: Record<Decision, string> = {
  allow: 'autorisé',
  deny: 'refusé',
  ask: 'à trancher',
}
</script>

<template>
  <div class="space-y-7">
    <section class="card p-4 border-ink-800">
      <div class="flex items-start gap-4">
        <div class="flex-1">
          <h1 class="text-ink-100 text-[15px]">Autorisations</h1>
          <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
            Ce que les agents ont le droit de faire sur ce projet. La décision se prend
            <strong class="text-ink-300">ici, une fois</strong>, et se projette dans la
            configuration des harnais — au lieu d'être revalidée à chaque geste.
            Une session lancée sans personne devant l'écran ne peut rien demander : ce qui n'est
            pas autorisé ici est simplement refusé.
          </p>
        </div>
        <input
          v-model="filter"
          placeholder="filtrer…"
          class="shrink-0 bg-ink-900 border border-ink-700 rounded px-2.5 py-1 text-[12px] w-52 focus:outline-none focus:border-ink-600"
        />
      </div>

      <div class="flex items-center gap-5 mt-4 text-[12px]">
        <span class="text-proof">{{ counts.allow }} autorisés</span>
        <span class="text-fail">{{ counts.deny }} refusés</span>
        <span :class="counts.ask ? 'text-halt' : 'text-ink-600'">{{ counts.ask }} à trancher</span>
        <span class="ml-auto text-ink-600">
          Projeter dans le harnais :
          <code class="text-ink-400">orchestrator permissions:sync</code>
        </span>
      </div>
    </section>

    <section v-if="pending.length">
      <h2 class="text-halt text-[14px] mb-1">À trancher — {{ pending.length }}</h2>
      <p class="text-ink-400 mb-3">
        Des sessions ont réclamé ces outils sans les obtenir. Tant qu'ils ne sont pas tranchés,
        elles se cognent dessus à chaque tour.
      </p>
      <div class="card divide-y divide-ink-800 border-halt/35">
        <div v-for="p in pending" :key="p.id" class="p-3 flex items-center gap-3 flex-wrap">
          <code class="text-ink-100 flex-1">{{ p.pattern }}</code>
          <span v-if="p.requested" class="text-ink-600 text-[11px]"
            >réclamé {{ p.requested }} fois</span
          >
          <div class="flex gap-1">
            <button
              v-for="d in (['allow', 'deny'] as Decision[])"
              :key="d"
              class="chip"
              :class="p.decision === d ? decisionStyle[d] : 'border-ink-600 text-ink-400 hover:text-ink-100'"
              @click="setDecision(p, d)"
            >
              {{ decisionLabel[d] }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <div v-if="loading" class="text-ink-400">chargement…</div>

    <section v-for="(list, family) in grouped" :key="family">
      <div class="flex items-baseline gap-3 mb-2">
        <h2 class="text-ink-100 text-[14px]">{{ family }}</h2>
        <span class="text-ink-600 text-[11px]">{{ list.length }}</span>
        <div class="ml-auto flex gap-1">
          <button class="chip border-ink-600 text-ink-400 hover:text-proof" @click="setFamily(family, 'allow')">
            tout autoriser
          </button>
          <button class="chip border-ink-600 text-ink-400 hover:text-fail" @click="setFamily(family, 'deny')">
            tout refuser
          </button>
        </div>
      </div>

      <div class="card divide-y divide-ink-800">
        <div v-for="p in list" :key="p.id" class="p-2.5 flex items-center gap-3 flex-wrap">
          <span
            class="w-1.5 h-1.5 rounded-full shrink-0"
            :class="{
              'bg-proof': p.decision === 'allow',
              'bg-fail': p.decision === 'deny',
              'bg-halt': p.decision === 'ask',
            }"
          />
          <code class="text-ink-300 flex-1 break-all">{{ p.pattern }}</code>
          <span v-if="p.label" class="text-ink-600 text-[11px]">{{ p.label }}</span>
          <div class="flex gap-1 shrink-0">
            <button
              v-for="d in (['allow', 'ask', 'deny'] as Decision[])"
              :key="d"
              class="chip"
              :class="p.decision === d ? decisionStyle[d] : 'border-ink-700 text-ink-600 hover:text-ink-300'"
              @click="setDecision(p, d)"
            >
              {{ decisionLabel[d] }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <p v-if="!loading && !perms.length" class="text-ink-600">
      Aucune autorisation déclarée. Elles apparaissent ici dès qu'une session en réclame une.
    </p>
  </div>
</template>
