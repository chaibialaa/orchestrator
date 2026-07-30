<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import mermaid from 'mermaid'

const props = defineProps<{ definition: string }>()
const el = ref<HTMLDivElement | null>(null)
let seq = 0

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'strict',
  themeVariables: {
    background: '#111318',
    primaryColor: '#1c2029',
    lineColor: '#3a4152',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '12px',
  },
})

async function render() {
  if (!el.value || !props.definition) return
  try {
    const { svg } = await mermaid.render(`m${Date.now()}${seq++}`, props.definition)
    el.value.innerHTML = svg
  } catch (e) {
    el.value.innerHTML = `<pre class="text-fail text-[11px]">diagramme invalide</pre>`
  }
}

onMounted(render)
watch(() => props.definition, render)
</script>

<template>
  <div ref="el" class="min-h-[80px]" />
</template>
