<script setup lang="ts">
import { computed, ref } from 'vue'
import { api } from '../api'
import { useRouter } from 'vue-router'

/**
 * Declare a project from here.
 *
 * Until now this could only be done by hand in the database, or as a side effect
 * of distilling memories — so the one thing you need before anything else works
 * was the one thing the screen could not do.
 */
const emit = defineEmits<{ created: [] }>()
const router = useRouter()

const open = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

const draft = ref({ name: '', slug: '', repo_path: '', judge_url: '', gate_judge: 'gpt' })
const slugTouched = ref(false)

/** The id follows the name until someone decides otherwise. */
const suggestedSlug = computed(() =>
  draft.value.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40),
)

const slug = computed(() => (slugTouched.value ? draft.value.slug : suggestedSlug.value))

/** Typing in the id field pins it: it stops following the name from then on. */
function editSlug(value: string) {
  slugTouched.value = true
  draft.value.slug = value
}

async function create() {
  busy.value = true
  error.value = null
  try {
    const p = await api.createProject({ ...draft.value, slug: slug.value })
    open.value = false
    draft.value = { name: '', slug: '', repo_path: '', judge_url: '', gate_judge: 'gpt' }
    slugTouched.value = false
    emit('created')
    router.push(`/p/${p.slug}`)
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not create it'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <button v-if="!open" class="chip border-ink-600 text-ink-400 hover:text-ink-100" @click="open = true">
    + New project
  </button>

  <section v-else class="card p-5">
    <h2 class="text-ink-100 text-[14px]">New project</h2>
    <p class="text-ink-400 mt-1.5 max-w-3xl">
      A project is a repository plus the conversation that judges its work. Both can be filled in
      later, but nothing runs until the repository path is right.
    </p>

    <div class="mt-4 space-y-3">
      <label class="block">
        <span class="label">Name</span>
        <input
          v-model="draft.name"
          placeholder="Atlas"
          class="mt-1 w-full max-w-md bg-ink-950 border border-ink-800 rounded px-2.5 py-1.5 text-[13px] text-ink-300 focus:outline-none focus:border-run"
        />
      </label>

      <label class="block">
        <span class="label">Id</span>
        <input
          :value="slug"
          placeholder="atlas"
          class="num mt-1 w-full max-w-xs bg-ink-950 border border-ink-800 rounded px-2.5 py-1.5 text-[13px] text-ink-300 focus:outline-none focus:border-run"
          @input="editSlug(($event.target as HTMLInputElement).value)"
        />
        <span class="text-ink-600 text-[11px] block mt-1">
          Lowercase, digits and hyphens. It is what the CLI and `.orchestrator.json` refer to.
        </span>
      </label>

      <label class="block">
        <span class="label">Repository</span>
        <input
          v-model="draft.repo_path"
          placeholder="/Applications/XAMPP/xamppfiles/htdocs/Atlas"
          class="num mt-1 w-full bg-ink-950 border border-ink-800 rounded px-2.5 py-1.5 text-[12px] text-ink-300 focus:outline-none focus:border-run"
        />
        <span class="text-ink-600 text-[11px] block mt-1">
          Checked against the disk. A wrong path breaks everything downstream in silence — proofs
          resolve to nothing and deliverables are never found.
        </span>
      </label>

      <label class="block">
        <span class="label">Judging conversation</span>
        <input
          v-model="draft.judge_url"
          placeholder="https://chatgpt.com/c/…"
          class="num mt-1 w-full bg-ink-950 border border-ink-800 rounded px-2.5 py-1.5 text-[12px] text-ink-300 focus:outline-none focus:border-run"
        />
        <span class="text-ink-600 text-[11px] block mt-1">
          Optional for now. Without it, the loop has nobody to ask for a verdict.
        </span>
      </label>
    </div>

    <p v-if="error" class="mt-3 text-fail text-[12px]">{{ error }}</p>

    <div class="flex items-center gap-2 mt-4">
      <button class="btn" :disabled="busy || !draft.name.trim() || !slug" @click="create">
        {{ busy ? '…' : 'Create' }}
      </button>
      <button class="label hover:text-ink-300" @click="open = false">cancel</button>
    </div>
  </section>
</template>
