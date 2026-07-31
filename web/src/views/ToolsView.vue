<script setup lang="ts">
import MemoryScan from '../components/MemoryScan.vue'
import Wiring from '../components/Wiring.vue'
import Storages from '../components/Storages.vue'
</script>

<template>
  <!-- Not width-capped as a whole: prose needs 65 characters, a list of servers
       and a grid of storages do not. Capping the page capped everything, so half
       a wide screen sat empty while the page ran on for three screens down. -->
  <div class="space-y-7">
    <section class="card p-4 border-ink-800">
      <h1 class="text-ink-100 text-[15px]">Tools</h1>
      <p class="text-ink-400 mt-1.5 leading-relaxed max-w-3xl">
        Things that act on projects without being a project. Nothing here fires on its own, and
        nothing enters a plan before you have read it.
      </p>
    </section>

    <Wiring />

    <Storages />

    <MemoryScan />
  </div>
</template>
