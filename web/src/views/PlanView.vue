<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api, type BlastRadius, type Objective } from '../api'
import { blastLabel, blastHelp, statusLabel } from '../labels'
import BriefComposer from '../components/BriefComposer.vue'
import RunControl from '../components/RunControl.vue'
import Attachments from '../components/Attachments.vue'
import RunSeries from '../components/RunSeries.vue'

const props = defineProps<{ slug: string }>()

const objectives = ref<Objective[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

/** What was just saved, by id — so nothing goes off silently. */
const state = ref<Record<string, 'saved' | 'error' | 'sending'>>({})

function flag(key: string, v: 'saved' | 'error' | 'sending') {
  state.value = { ...state.value, [key]: v }
  if (v === 'saved') setTimeout(() => (state.value = { ...state.value, [key]: undefined as never }), 1800)
}

async function load() {
  loading.value = true
  error.value = null
  try {
    objectives.value = await api.objectives(props.slug)
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? e?.message ?? 'error'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.slug, load)

const byRank = (l: Objective[]) => [...l].sort((a, b) => a.priority - b.priority || a.id - b.id)

/**
 * Every top-level objective is a chapter, even an empty one. Becoming one only
 * once it carried a step created a dead end: the chapter was born "outside any
 * chapter", and therefore without the form that would have let you add one.
 */
const chapters = computed(() => {
  const all = objectives.value.filter((o) => o.status !== 'abandoned')
  return byRank(all.filter((o) => !o.parent_id)).map((c) => ({
    chapter: c,
    steps: byRank(all.filter((o) => o.parent_id === c.id)),
  }))
})

// ---- writing --------------------------------------------------------------

async function patch(o: Objective, field: keyof Objective, value: unknown) {
  if (o[field] === value) return
  const key = `${o.id}:${String(field)}`
  flag(key, 'sending')
  try {
    const updated = await api.updateObjective(o.id, { [field]: value } as Partial<Objective>)
    Object.assign(o, updated)
    flag(key, 'saved')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not save'
    flag(key, 'error')
  }
}

const newChapter = ref('')

async function createChapter() {
  const title = newChapter.value.trim()
  if (!title) return
  try {
    const o = await api.createObjective(props.slug, {
      title: title,
      blast_radius: 'feature',
      priority: (chapters.value.length + 1) * 10,
    })
    objectives.value = [...objectives.value, o]
    newChapter.value = ''
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not create it'
  }
}

const newStep = ref<Record<number, string>>({})

async function createStep(chapter: Objective, steps: Objective[]) {
  const title = (newStep.value[chapter.id] ?? '').trim()
  if (!title) return
  try {
    const o = await api.createObjective(props.slug, {
      title: title,
      blast_radius: chapter.blast_radius,
      parent_id: chapter.id,
      priority: (steps.at(-1)?.priority ?? 0) + 10,
    })
    objectives.value = [...objectives.value, o]
    newStep.value = { ...newStep.value, [chapter.id]: '' }
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not create it'
  }
}

/** Reordering renumbers the whole column, never a single rank. */
async function move(steps: Objective[], from: number, to: number) {
  if (to < 0 || to >= steps.length) return
  const l = [...steps]
  const [taken] = l.splice(from, 1)
  l.splice(to, 0, taken)
  const order = l.map((o, i) => ({ id: o.id, priority: (i + 1) * 10 }))
  order.forEach((x) => {
    const target = objectives.value.find((o) => o.id === x.id)
    if (target) target.priority = x.priority
  })
  try {
    await api.reorderObjectives(props.slug, order)
    flag(`order:${taken.parent_id}`, 'saved')
  } catch {
    error.value = 'the order could not be saved'
    await load()
  }
}

async function drop(o: Objective) {
  await patch(o, 'status', 'abandoned')
}

const RISKS: BlastRadius[] = ['cosmetic', 'feature', 'api', 'critical']
</script>

<template>
  <div v-if="loading" class="text-ink-400">loading…</div>
  <!-- Capped: a proof criterion read across 1400px is a criterion nobody reads. -->
  <div v-else class="space-y-7 max-w-5xl">
    <section class="card p-4 border-ink-800">
      <h1 class="text-ink-100 text-[15px]">The plan</h1>
      <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
        A <strong class="text-ink-300">chapter</strong> carries
        <strong class="text-ink-300">steps</strong>, in the order they will run. An agent can only take
        a step once someone has written
        <strong class="text-ink-300">what will prove it is finished</strong> — without that criterion
        it stays undefined and nobody can pick it up.
      </p>
    </section>

    <BriefComposer :slug="slug" @applied="load" />

    <section class="card p-4">
      <Attachments :slug="slug" kind="project" />
    </section>

    <!-- The breakdown works on the brief above, not on the repository. Running it
         with nothing written simply reports that nothing is waiting. Without this
         button it was a terminal command, which defeats the point of the screen. -->
    <section class="card p-4">
      <div class="flex items-baseline gap-3 flex-wrap">
        <h2 class="text-ink-100 text-[14px]">Break the brief down</h2>
        <div class="ml-auto">
          <RunControl :slug="slug" mode="plan" label="Break it down" />
        </div>
      </div>
      <p class="text-ink-400 mt-1.5 max-w-3xl">
        An agent turns the brief above into chapters and steps, each with what would prove it
        finished. It proposes; nothing runs until you have read it. With no brief waiting, this
        does nothing and says so.
      </p>
    </section>

    <p v-if="error" class="card p-3 border-fail/40 text-fail">{{ error }}</p>

    <section v-for="{ chapter, steps } in chapters" :key="chapter.id" class="card p-5">
      <header class="flex items-baseline gap-3 flex-wrap mb-5">
        <input
          class="bg-transparent text-ink-100 border-b border-transparent hover:border-ink-700 focus:border-run focus:outline-none min-w-[18rem] flex-1"
          :value="chapter.title"
          @change="patch(chapter, 'title', ($event.target as HTMLInputElement).value)"
        />
        <span class="label text-ink-600">chapter #{{ chapter.id }}</span>
        <span v-if="state[`${chapter.id}:title`]" class="label text-proof">saved</span>
        <button
          v-if="!steps.length && chapter.status !== 'proven'"
          class="label hover:text-fail"
          title="drop this empty chapter"
          @click="drop(chapter)"
        >
          drop
        </button>
      </header>

      <!-- Launch the whole chapter, rather than returning here between each step. -->
      <div class="-mt-3 mb-4">
        <RunSeries :slug="slug" :chapter="chapter" :steps="steps" @queued="load" />
      </div>

      <p v-if="!steps.length" class="text-ink-500 text-[12px] mb-3.5">
        Empty chapter. Add its steps in the order they will run.
      </p>

      <ol class="space-y-2.5">
        <li
          v-for="(o, i) in steps"
          :key="o.id"
          class="border border-ink-800 rounded p-3.5"
          :class="o.status === 'abandoned' ? 'opacity-40' : ''"
        >
          <div class="flex items-start gap-3">
            <div class="flex flex-col gap-0.5 pt-0.5">
              <button
                class="text-ink-600 hover:text-ink-100 leading-none text-[11px] disabled:opacity-25"
                :disabled="i === 0"
                title="move up"
                @click="move(steps, i, i - 1)"
              >
                ▲
              </button>
              <button
                class="text-ink-600 hover:text-ink-100 leading-none text-[11px] disabled:opacity-25"
                :disabled="i === steps.length - 1"
                title="move down"
                @click="move(steps, i, i + 1)"
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
                <span class="label">What will prove this is finished</span>
                <textarea
                  rows="3"
                  class="mt-1 w-full bg-ink-950 border rounded px-2.5 py-2 text-[12px] text-ink-300 leading-relaxed resize-y focus:outline-none focus:border-run"
                  :class="o.proof_spec ? 'border-ink-800' : 'border-halt/40'"
                  :placeholder="'A checkable condition — e.g. “npm test -- ImportTest comes back green”'"
                  :value="o.proof_spec ?? ''"
                  @change="patch(o, 'proof_spec', ($event.target as HTMLTextAreaElement).value)"
                />
              </label>
              <p v-if="!o.proof_spec" class="text-halt text-[11px] mt-1">
                Without a criterion, no agent can take this step.
              </p>

              <div class="flex items-center gap-3 mt-2.5 flex-wrap">
                <label class="flex items-center gap-2">
                  <span class="label">Risk</span>
                  <select
                    class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                    :value="o.blast_radius"
                    :title="blastHelp[o.blast_radius]"
                    @change="patch(o, 'blast_radius', ($event.target as HTMLSelectElement).value)"
                  >
                    <option v-for="r in RISKS" :key="r" :value="r">{{ blastLabel[r] }}</option>
                  </select>
                </label>
                <span v-if="state[`${o.id}:proof_spec`] === 'saved'" class="label text-proof"
                  >criterion saved</span
                >
                <label class="flex items-center gap-2">
                  <span class="label">Session</span>
                  <select
                    class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                    :value="o.resume_mode ?? 'new'"
                    :title="
                      (o.resume_mode ?? 'new') === 'new'
                        ? 'Every attempt starts from scratch: the mission is the whole order.'
                        : 'The attempt resumes an earlier session — cheaper, but it carries state nobody can see.'
                    "
                    @change="patch(o, 'resume_mode', ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="new">fresh every time</option>
                    <option value="last">resume the previous one</option>
                  </select>
                </label>
                <span
                  v-if="(o.resume_mode ?? 'new') !== 'new'"
                  class="text-[11px] text-halt"
                  >the order will no longer be wholly in the mission</span
                >
                <label class="flex items-center gap-2">
                  <span class="label">Chapter</span>
                  <select
                    class="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[12px] text-ink-300 focus:outline-none focus:border-run"
                    :value="o.parent_id ?? ''"
                    @change="patch(o, 'parent_id', Number(($event.target as HTMLSelectElement).value) || null)"
                  >
                    <option value="">none — promote to chapter</option>
                    <option v-for="c in chapters" :key="c.chapter.id" :value="c.chapter.id">
                      {{ c.chapter.title }}
                    </option>
                  </select>
                </label>
                <RouterLink :to="`/o/${o.id}`" class="label hover:text-run ml-auto">open ▸</RouterLink>
                <button
                  v-if="o.status !== 'abandoned' && o.status !== 'proven'"
                  class="label hover:text-fail"
                  title="drop this step without deleting it"
                  @click="drop(o)"
                >
                  drop
                </button>
              </div>
            </div>
          </div>
        </li>
      </ol>

      <form class="mt-3.5 flex gap-2" @submit.prevent="createStep(chapter, steps)">
        <input
          v-model="newStep[chapter.id]"
          class="flex-1 bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[12px] text-ink-300 focus:outline-none focus:border-run"
          placeholder="Add a step to this chapter…"
        />
        <button class="btn" :disabled="!newStep[chapter.id]?.trim()">add</button>
      </form>
    </section>

    <form class="card p-4 flex gap-2" @submit.prevent="createChapter">
      <input
        v-model="newChapter"
        class="flex-1 bg-ink-950 border border-ink-800 rounded px-2.5 py-2 text-[13px] text-ink-300 focus:outline-none focus:border-run"
        placeholder="New chapter — e.g. “Excel employee import, step 2”"
      />
      <button class="btn" :disabled="!newChapter.trim()">create the chapter</button>
    </form>
  </div>
</template>
