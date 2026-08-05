<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Project } from '../api'

/**
 * Move between projects without listing them all in the masthead.
 *
 * They used to sit next to the logo, one link each. That reads well at four and
 * is unusable at forty — the nav scrolls sideways, the current one is wherever
 * it happens to fall, and the tools on the right get pushed off the screen. A
 * switcher costs one click and does not care how many there are.
 */
const props = defineProps<{ projects: Project[] }>()

const route = useRoute()
const router = useRouter()

const open = ref(false)
const filter = ref('')
const field = ref<HTMLInputElement | null>(null)

const current = computed(() => props.projects.find((p) => p.slug === route.params.slug) ?? null)

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return props.projects
  return props.projects.filter((p) => `${p.name} ${p.slug}`.toLowerCase().includes(q))
})

/**
 * Being worked on, then set aside.
 *
 * The menu listed all five in one run, so a project deliberately put away sat
 * between two that are running — and picking the wrong one is how you spend a
 * pass on something nobody meant to touch this month. Set-aside projects stay
 * reachable, under their own heading, dimmed.
 */
const actifs = computed(() => shown.value.filter((p) => p.active !== false))
const ranges = computed(() => shown.value.filter((p) => p.active === false))

/**
 * Close on a click anywhere else — via the document, not a full-screen overlay.
 *
 * The overlay was `fixed inset-0`, which is the viewport only when no ancestor
 * establishes a containing block. The header carries `backdrop-blur`, and a
 * backdrop filter does establish one: the overlay was confined to the bar, so
 * clicking the page below did nothing at all.
 */
const root = ref<HTMLElement | null>(null)

function onDocumentPointerDown(e: PointerEvent) {
  if (!root.value?.contains(e.target as Node)) open.value = false
}

watch(open, async (isOpen) => {
  filter.value = ''
  if (!isOpen) {
    document.removeEventListener('pointerdown', onDocumentPointerDown)
    return
  }
  document.addEventListener('pointerdown', onDocumentPointerDown)
  // Typing straight away is the whole point once there are more than a screenful.
  await new Promise((r) => setTimeout(r, 0))
  field.value?.focus()
})

onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

function go(slug: string) {
  open.value = false
  router.push(`/p/${slug}`)
}
</script>

<template>
  <div ref="root" class="relative">
    <button
      class="flex items-center gap-2 px-2.5 py-1 rounded text-[12px] whitespace-nowrap"
      :class="current ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-100'"
      @click="open = !open"
    >
      <span>{{ current?.name ?? 'Projects' }}</span>
      <span class="num text-ink-500 text-[10px]">{{ projects.length }}</span>
      <span class="text-ink-500 text-[9px]">▾</span>
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-9 z-20 w-72 card shadow-2xl shadow-black/60 overflow-hidden"
    >
      <input
        ref="field"
        v-model="filter"
        placeholder="filter…"
        class="w-full bg-ink-950 border-b border-ink-800 px-3 py-2 text-[12px] text-ink-200 focus:outline-none"
        @keyup.enter="shown[0] && go(shown[0].slug)"
        @keyup.escape="open = false"
      />

      <div class="max-h-80 overflow-y-auto">
        <template v-for="(groupe, i) in [
          { titre: 'being worked on', items: actifs },
          { titre: 'set aside', items: ranges },
        ]" :key="groupe.titre">
          <p
            v-if="groupe.items.length && (i === 0 ? ranges.length : actifs.length)"
            class="label px-3 pt-2 pb-1 text-ink-700"
          >
            {{ groupe.titre }}
          </p>
          <button
            v-for="p in groupe.items"
            :key="p.slug"
            class="w-full text-left px-3 py-2 flex items-baseline gap-2 hover:bg-ink-850/60 transition-colors"
            :class="[
              p.slug === route.params.slug ? 'text-ink-100' : 'text-ink-300',
              p.active === false ? 'opacity-55' : '',
            ]"
            @click="go(p.slug)"
          >
            <span class="text-[12px] truncate">{{ p.name }}</span>
            <span class="num text-ink-600 text-[10px] ml-auto truncate max-w-[9rem]">{{ p.slug }}</span>
          </button>
        </template>

        <p v-if="!shown.length" class="px-3 py-3 text-ink-600 text-[11px]">
          Nothing matches “{{ filter }}”.
        </p>
      </div>
    </div>
  </div>
</template>
