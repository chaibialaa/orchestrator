<script setup lang="ts">
import MemoryScan from '../components/MemoryScan.vue'
import Storages from '../components/Storages.vue'
</script>

<template>
  <div class="space-y-7">
    <section class="card p-4 border-ink-800">
      <h1 class="text-ink-100 text-[15px]">Outils</h1>
      <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
        Ce qui agit sur les projets sans être un projet. Rien ici ne se déclenche tout seul et rien
        n'entre dans un plan sans que tu l'aies relu.
      </p>
    </section>

    <Storages />

    <MemoryScan />
  </div>
</template>
