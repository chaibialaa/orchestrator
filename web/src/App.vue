<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, type Project } from './api'

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

        <nav class="flex items-center gap-1 overflow-x-auto">
          <RouterLink
            to="/"
            class="px-2.5 py-1 rounded text-[12px] whitespace-nowrap"
            :class="route.name === 'dashboard' ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-100'"
          >
            Overview
          </RouterLink>
          <span class="text-ink-700 px-1">·</span>
          <RouterLink
            v-for="p in projects"
            :key="p.id"
            :to="`/p/${p.slug}`"
            class="px-2.5 py-1 rounded text-[12px] whitespace-nowrap"
            :class="
              route.params.slug === p.slug
                ? 'bg-ink-700 text-ink-100'
                : 'text-ink-400 hover:text-ink-100'
            "
          >
            {{ p.name }}
          </RouterLink>
        </nav>

        <div class="ml-auto flex items-center gap-3 text-[11px] text-ink-400">
          <RouterLink
            to="/tools"
            class="hover:text-ink-100"
            :class="route.name === 'tools' ? 'text-ink-100' : ''"
            >tools</RouterLink
          >
          <RouterLink
            to="/setup"
            class="hover:text-ink-100"
            :class="route.name === 'setup' ? 'text-ink-100' : ''"
            >setup</RouterLink
          >
          <RouterLink
            to="/config"
            class="hover:text-ink-100"
            :class="route.name === 'config' ? 'text-ink-100' : ''"
            >connected AI</RouterLink
          >
          <RouterLink
            v-if="route.params.slug"
            :to="`/p/${route.params.slug}`"
            class="hover:text-ink-100"
            :class="route.name === 'objectives' ? 'text-ink-100' : ''"
            >objectives</RouterLink
          >
          <RouterLink
            v-if="route.params.slug"
            :to="`/p/${route.params.slug}/analysis`"
            class="hover:text-ink-100"
            :class="route.name === 'analysis' ? 'text-ink-100' : ''"
            >analysis</RouterLink
          >
          <RouterLink
            v-if="route.params.slug"
            :to="`/p/${route.params.slug}/plan`"
            class="hover:text-ink-100"
            :class="route.name === 'plan' ? 'text-ink-100' : ''"
            >plan</RouterLink
          >
          <RouterLink
            v-if="route.params.slug"
            :to="`/p/${route.params.slug}/memory`"
            class="hover:text-ink-100"
            :class="route.name === 'memory' ? 'text-ink-100' : ''"
            >memory</RouterLink
          >
          <RouterLink
            v-if="route.params.slug"
            :to="`/p/${route.params.slug}/permissions`"
            class="hover:text-ink-100"
            :class="route.name === 'permissions' ? 'text-ink-100' : ''"
            >permissions</RouterLink
          >
        </div>
      </div>
    </header>

    <main class="flex-1 max-w-[1400px] w-full mx-auto px-5 py-6">
      <RouterView />
    </main>
  </div>
</template>
