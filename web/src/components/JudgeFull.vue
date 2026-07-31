<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../api'

/**
 * The driving conversation is full — and clearing it is a button, not a chore.
 *
 * Every turn re-reads the whole thread, so a thread has a ceiling. Reaching it
 * used to mean: open ChatGPT yourself, paste the state in, copy the address
 * back into the tool. That is precisely the copying this tool exists to remove,
 * so it was the one halt that made the autopilot stop being one.
 *
 * Two ways out, and the second is the point: the tool opens its own tab, posts
 * the state, reads the address the conversation takes, and clears the halt.
 */
const props = defineProps<{ project: string | null; objectiveId: number; detail?: string | null }>()
const emit = defineEmits<{ done: [] }>()

const open = ref(false)
const busy = ref<'paste' | 'auto' | null>(null)
const error = ref<string | null>(null)
const queued = ref(false)
const url = ref('')

const looksRight = (v: string) => /^https?:\/\/(chatgpt|chat\.openai)\.com\/c\/[\w-]+/i.test(v.trim())

async function usePasted() {
  if (!looksRight(url.value)) {
    error.value = 'That is not a conversation address — it should look like https://chatgpt.com/c/…'
    return
  }
  busy.value = 'paste'
  error.value = null
  try {
    await api.updateProject(props.project!, { judge_url: url.value.trim(), judge_messages_seen: 0 })
    await api.clearHalts(props.objectiveId, 'judge_conversation_full')
    open.value = false
    url.value = ''
    emit('done')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not save it'
  } finally {
    busy.value = null
  }
}

async function askTool() {
  busy.value = 'auto'
  error.value = null
  try {
    await api.startRun(props.project!, { mode: 'judge', objective: props.objectiveId })
    queued.value = true
    emit('done')
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not queue it'
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <article class="card p-4 border-halt/60 bg-halt/[0.06]">
    <div class="flex items-start gap-3 flex-wrap">
      <!-- It pulses because it is the one thing standing between the loop and
           carrying on. Everything else on this page can wait. -->
      <span class="relative flex w-2 h-2 mt-1.5 shrink-0">
        <span class="absolute inline-flex w-full h-full rounded-full bg-halt opacity-70 animate-ping" />
        <span class="relative inline-flex w-2 h-2 rounded-full bg-halt" />
      </span>
      <span class="label text-ink-600 mt-0.5">{{ project }}</span>
      <span class="text-ink-100 flex-1 min-w-[12rem]">The judging conversation is full</span>
      <button v-if="!open && !queued" class="chip border-halt text-halt bg-halt/10 hover:bg-halt/20" @click="open = true">
        Clear it
      </button>
    </div>

    <p v-if="detail" class="text-ink-400 mt-2 leading-relaxed">{{ detail }}</p>

    <p v-if="queued" class="text-run mt-3">
      Queued. A worker on this machine is opening the conversation, posting the state into it, and
      writing its address here. It will clear itself.
    </p>

    <div v-else-if="open" class="mt-3 space-y-3 border-l-2 border-halt/40 pl-3">
      <div>
        <span class="label">Let the tool do it</span>
        <p class="text-ink-400 mt-1">
          It opens its own tab — the one you are reading is left alone — posts the current state and
          the formatting rules, then keeps the address the conversation takes.
        </p>
        <button class="btn mt-2" :disabled="busy !== null" @click="askTool">
          {{ busy === 'auto' ? '…' : 'Open a new conversation' }}
        </button>
      </div>

      <div class="border-t border-ink-850 pt-3">
        <span class="label">Or paste one you opened</span>
        <input
          v-model="url"
          placeholder="https://chatgpt.com/c/…"
          class="num mt-1 w-full bg-ink-950 border border-ink-800 rounded px-2.5 py-1.5 text-[12px] text-ink-300 focus:outline-none focus:border-run"
          @keyup.enter="usePasted"
        />
        <button class="chip border-ink-600 text-ink-400 hover:text-ink-100 mt-2" :disabled="busy !== null" @click="usePasted">
          {{ busy === 'paste' ? '…' : 'Use this one' }}
        </button>
      </div>

      <p v-if="error" class="text-fail text-[12px]">{{ error }}</p>
      <button class="label hover:text-ink-300" @click="open = false">cancel</button>
    </div>
  </article>
</template>
