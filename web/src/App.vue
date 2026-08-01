<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, type Project } from './api'
import ProjectSwitcher from './components/ProjectSwitcher.vue'

const route = useRoute()
const router = useRouter()
const projects = ref<Project[]>([])

onMounted(async () => {
  try {
    projects.value = await api.projects()
  } catch {
    projects.value = []
  }

  // An empty tool explains itself once. It never takes the page over again: a
  // walkthrough that reappears is a walkthrough you learn to click past.
  if (!projects.value.length && route.name === 'dashboard') {
    const setup = await api.setup().catch(() => null)
    if (setup && !setup.walkthrough_done) router.replace('/setup')
  }
})
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-ink-800 bg-ink-900/60 backdrop-blur sticky top-0 z-10">
      <div class="max-w-[1400px] mx-auto px-5 h-12 flex items-center gap-6">
        <RouterLink to="/" class="flex items-center gap-2 shrink-0">
          <span class="w-2 h-2 rounded-full bg-proof"></span>
          <span class="tracking-[0.2em] text-[12px] text-ink-100">ORCHESTRATOR</span>
        </RouterLink>

        <!-- No `overflow-x-auto` here any more. It was there to scroll a long list
             of project links; that list is gone, and an overflow container clips
             every absolutely positioned child — which is why the switcher's menu
             opened and was cut off at the height of the bar. -->
        <nav class="flex items-center gap-1">
          <RouterLink
            to="/"
            class="px-2.5 py-1 rounded text-[12px] whitespace-nowrap"
            :class="route.name === 'dashboard' ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-100'"
          >
            Overview
          </RouterLink>
          <span class="text-ink-700 px-1">·</span>
          <ProjectSwitcher :projects="projects" />
        </nav>

        <!-- Global tools only. The project's own pages were in this same row,
             appearing and disappearing with the route, so the bar changed shape
             as you moved and nothing sat where you last saw it. -->
        <div class="ml-auto flex items-center gap-4 text-[11px] text-ink-400">
          <RouterLink
            v-for="l in [
              { to: '/tools', name: 'tools', word: 'tools' },
              { to: '/setup', name: 'setup', word: 'setup' },
              { to: '/config', name: 'config', word: 'connected AI' },
            ]"
            :key="l.name"
            :to="l.to"
            class="hover:text-ink-100 transition-colors"
            :class="route.name === l.name ? 'text-ink-100' : ''"
          >
            {{ l.word }}
          </RouterLink>
        </div>
      </div>

      <!-- The project's pages, in the order the work goes through them: what you
           want, where it stands, why it jams, what it knows, what it may do. -->
      <nav
        v-if="route.params.slug"
        class="border-t border-ink-850 bg-ink-950/40"
      >
        <div class="max-w-[1400px] mx-auto px-5 flex items-center gap-1 h-9 overflow-x-auto">
          <RouterLink
            v-for="t in [
              { to: '', name: 'objectives', word: 'Where it stands' },
              { to: '/plan', name: 'plan', word: 'Plan' },
              { to: '/analysis', name: 'analysis', word: 'Why it jams' },
              { to: '/memory', name: 'memory', word: 'What it knows' },
              { to: '/permissions', name: 'permissions', word: 'What it may do' },
            ]"
            :key="t.name"
            :to="`/p/${route.params.slug}${t.to}`"
            class="px-2.5 py-1 rounded text-[12px] whitespace-nowrap transition-colors"
            :class="
              route.name === t.name
                ? 'bg-ink-800 text-ink-100'
                : 'text-ink-500 hover:text-ink-200'
            "
          >
            {{ t.word }}
          </RouterLink>
        </div>
      </nav>
    </header>

    <main class="flex-1 max-w-[1400px] w-full mx-auto px-5 py-6">
      <RouterView />
    </main>
  </div>
</template>
