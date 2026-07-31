<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api, type Attachment } from '../api'

/**
 * Put a file into the process.
 *
 * The loop already sends what a pass produced up to the judging conversation —
 * renders, JSON, markdown, automatically. Nothing came the other way, so the
 * most natural way to steer a visual project, "make it look like this", had
 * nowhere to go but a sentence describing the picture.
 *
 * The file lands in the tool's own directory, never in the repository: a
 * person's screenshot in a working tree becomes a change to review, and gets
 * attributed to whichever pass happened to run next.
 */
const props = withDefaults(
  defineProps<{ slug: string; kind?: 'project' | 'brief' | 'run'; ownerId?: number }>(),
  { kind: 'project' },
)

const list = ref<Attachment[]>([])
const busy = ref(false)
const error = ref<string | null>(null)
const field = ref<HTMLInputElement | null>(null)

async function load() {
  try {
    list.value = await api.attachments(props.slug, props.kind, props.ownerId)
  } catch {
    /* a panel that cannot list must not break the page it sits on */
  }
}

onMounted(load)
watch(() => [props.slug, props.ownerId], load)

/** Read as base64: one dependency fewer than multipart, and a screenshot fits. */
const asBase64 = (file: File) =>
  new Promise<string>((ok, ko) => {
    const reader = new FileReader()
    reader.onerror = () => ko(new Error('could not read that file'))
    reader.onload = () => ok(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })

async function add(files: FileList | null) {
  if (!files?.length) return
  busy.value = true
  error.value = null
  try {
    for (const file of Array.from(files)) {
      await api.addAttachment(props.slug, {
        kind: props.kind,
        owner_id: props.ownerId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        data: await asBase64(file),
      })
    }
    await load()
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? 'could not attach it'
  } finally {
    busy.value = false
    if (field.value) field.value.value = ''
  }
}

async function drop(id: number) {
  await api.removeAttachment(id)
  await load()
}

const isImage = (a: Attachment) => (a.mime ?? '').startsWith('image/')

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div>
    <div class="flex items-baseline gap-3 flex-wrap">
      <span class="label">Files you provide</span>
      <span v-if="list.length" class="num text-ink-600 text-[11px]">{{ list.length }}</span>

      <label class="chip border-ink-600 text-ink-400 hover:text-ink-100 cursor-pointer ml-auto">
        {{ busy ? '…' : '+ attach' }}
        <input
          ref="field"
          type="file"
          multiple
          class="hidden"
          :disabled="busy"
          @change="add(($event.target as HTMLInputElement).files)"
        />
      </label>
    </div>

    <p v-if="!list.length" class="text-ink-600 text-[11px] mt-1.5 max-w-[68ch]">
      A mock-up to match, a screenshot of what broke, a spec. Every pass is told they exist and
      where to open them — otherwise a file nobody opens is a file nobody matched.
    </p>

    <p v-if="error" class="text-fail text-[12px] mt-2">{{ error }}</p>

    <div v-if="list.length" class="grid gap-2 grid-cols-2 md:grid-cols-4 mt-2.5">
      <div v-for="a in list" :key="a.id" class="group">
        <a :href="api.attachmentUrl(a.id)" target="_blank" class="block">
          <div
            class="aspect-[4/3] bg-ink-950 rounded border border-ink-800 group-hover:border-ink-600 overflow-hidden flex items-center justify-center transition-colors"
          >
            <img
              v-if="isImage(a)"
              :src="api.attachmentUrl(a.id, 480)"
              :alt="a.name"
              class="w-full h-full object-cover"
              decoding="async"
            />
            <span v-else class="text-ink-600 text-[20px] uppercase tracking-widest">
              {{ a.name.split('.').pop() }}
            </span>
          </div>
        </a>
        <div class="flex items-baseline gap-2 mt-1">
          <span class="text-ink-400 text-[11px] truncate" :title="a.name">{{ a.name }}</span>
          <span class="num text-ink-700 text-[10px] ml-auto shrink-0">{{ size(a.bytes) }}</span>
          <button class="label text-ink-700 hover:text-fail shrink-0" @click="drop(a.id)">×</button>
        </div>
      </div>
    </div>
  </div>
</template>
