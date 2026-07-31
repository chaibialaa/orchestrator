<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, type Closure } from '../api'

/**
 * What a chapter looked like before, what it looks like now, and what settled it.
 *
 * Nothing here is filled in by hand. The first visual proof attached to the
 * chapter or its steps IS the before, the last one is the after, and what it
 * cost sits in the attempts — a field somebody has to remember to fill would be
 * empty on every chapter that mattered.
 *
 * The distinction that earns this screen: what CAME OUT and what SETTLED IT are
 * not the same set. Chapter 0 produced twenty-six renderings and closed on one
 * passing proof; showing the twenty-six suggests they all counted.
 */
const props = defineProps<{ objectiveId: number }>()
const emit = defineEmits<{ close: [] }>()

const data = ref<Closure | null>(null)
const error = ref<string | null>(null)

async function load() {
  data.value = null
  error.value = null
  try {
    data.value = await api.closure(props.objectiveId)
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not read it'
  }
}

watch(() => props.objectiveId, load, { immediate: true })

const isImage = (ref?: string | null) => Boolean(ref && /\.(png|jpe?g|webp)$/i.test(ref))

function day(iso?: string | null) {
  if (!iso) return '—'
  return iso.replace(' ', ' · ').slice(0, 16)
}
</script>

<template>
  <!-- Click anywhere outside to leave: a panel needing its own button to dismiss
       is a panel you end up trapped in. -->
  <div class="fixed inset-0 z-30 bg-black/70 backdrop-blur-sm overflow-y-auto" @click.self="emit('close')">
    <div class="max-w-4xl mx-auto my-10 card p-6" @click.stop>
      <div v-if="error" class="text-fail">{{ error }}</div>
      <div v-else-if="!data" class="text-ink-400">loading…</div>

      <template v-else>
        <header class="flex items-baseline gap-3 flex-wrap border-b border-ink-800 pb-3">
          <h2 class="text-ink-100 text-[16px] flex-1 min-w-[14rem]">{{ data.objective.title }}</h2>
          <span
            class="chip"
            :class="data.objective.status === 'proven' ? 'border-proof text-proof bg-proof/10' : 'border-ink-600 text-ink-400'"
          >
            {{ data.objective.status }}
          </span>
          <button class="label hover:text-ink-100" @click="emit('close')">close</button>
        </header>

        <!-- What it took. Read from the attempts, never typed. -->
        <dl class="flex items-baseline gap-7 mt-4 text-[12px] flex-wrap">
          <div>
            <dt class="label">Ran</dt>
            <dd class="num text-ink-200 mt-0.5">{{ day(data.span.started) }} → {{ day(data.span.ended) }}</dd>
          </div>
          <div>
            <dt class="label">Attempts</dt>
            <dd class="num text-ink-200 mt-0.5">{{ data.span.attempts }}</dd>
          </div>
          <div>
            <dt class="label">Spent</dt>
            <dd class="num text-ink-200 mt-0.5">${{ data.span.cost_usd.toFixed(2) }}</dd>
          </div>
        </dl>

        <p v-if="data.objective.proof_spec" class="mt-4 text-ink-300 leading-relaxed border-l-2 border-ink-700 pl-3 max-w-[68ch]">
          {{ data.objective.proof_spec }}
        </p>

        <!-- BEFORE / AFTER -->
        <section v-if="data.before" class="mt-6">
          <div class="flex items-baseline gap-3">
            <span class="label">Before and after</span>
            <span class="text-ink-600 text-[11px]">
              first and last of {{ data.visual_count }} images, in time order
            </span>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2.5">
            <figure v-for="side in [
              { key: 'before', item: data.before, word: 'at the start' },
              { key: 'after', item: data.after, word: 'at the end' },
            ]" :key="side.key">
              <div class="aspect-[4/3] bg-ink-950 rounded border border-ink-800 overflow-hidden flex items-center justify-center">
                <a v-if="side.item && isImage(side.item.ref)" :href="api.evidenceFileUrl(side.item.id, 0)" target="_blank" class="w-full h-full">
                  <img
                    :src="api.evidenceFileUrl(side.item.id, 0, 640)"
                    :alt="side.item.label"
                    class="w-full h-full object-cover"
                  />
                </a>
                <span v-else class="text-ink-700 text-[11px]">
                  {{ side.item ? 'not an image' : 'only one image — nothing to compare against' }}
                </span>
              </div>
              <figcaption class="mt-1.5 text-[11px]">
                <span class="label">{{ side.word }}</span>
                <span v-if="side.item" class="num text-ink-600 block truncate" :title="side.item.ref ?? ''">
                  {{ day(side.item.created_at) }}
                </span>
              </figcaption>
            </figure>
          </div>
        </section>

        <!-- WHAT SETTLED IT — deliberately separate from what merely came out. -->
        <section class="mt-6">
          <span class="label">What settled it</span>
          <div v-if="data.settled_by.length" class="mt-2 space-y-1.5">
            <div v-for="e in data.settled_by" :key="e.id" class="flex items-baseline gap-3 text-[12px]">
              <span class="w-1.5 h-1.5 rounded-full bg-proof self-center shrink-0" />
              <span class="text-ink-200 flex-1">{{ e.label }}</span>
              <span class="num text-ink-600 text-[11px]">{{ day(e.created_at) }}</span>
            </div>
          </div>
          <p v-else class="text-halt mt-1.5 max-w-[68ch]">
            No proof with a passing verdict is attached to the chapter itself. Whatever closed it
            rested on a judgement rather than on something measured.
          </p>
        </section>

        <!-- THE STEPS, and which of them are still open. -->
        <section v-if="data.steps.length" class="mt-6">
          <span class="label">Its steps — {{ data.steps.length }}</span>
          <div class="mt-2 space-y-1">
            <RouterLink
              v-for="s in data.steps"
              :key="s.id"
              :to="`/o/${s.id}`"
              class="flex items-baseline gap-3 text-[12px] hover:bg-ink-850/40 rounded px-1.5 py-1 -mx-1.5"
            >
              <span
                class="w-1.5 h-1.5 rounded-full self-center shrink-0"
                :class="s.status === 'proven' ? 'bg-proof' : s.status === 'blocked' ? 'bg-halt' : 'bg-ink-600'"
              />
              <span class="num text-ink-600">#{{ s.id }}</span>
              <span class="text-ink-300 flex-1 truncate">{{ s.title }}</span>
              <span v-if="!s.proof_spec" class="text-halt text-[11px]">no criterion</span>
            </RouterLink>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
