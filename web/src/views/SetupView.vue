<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type Setup } from '../api'
import NewProject from '../components/NewProject.vue'

/**
 * The walkthrough for someone who has never seen this.
 *
 * It measures rather than asks. A form that enquires "have you installed Claude
 * Code?" and believes the answer is a form — and the first thing to go stale.
 * Every requirement below ends in what the tool actually saw on this machine: a
 * path, an address, a count. That is also the shortest way to explain what this
 * tool is, because it is the only thing it does.
 *
 * Two things it will never do for you: type a secret, or tick a consent box.
 * Those come back as a command to run yourself, and are then verified.
 */
const router = useRouter()

const state = ref<Setup | null>(null)
const step = ref(0)
const busy = ref(false)
const checking = ref(false)

async function load() {
  state.value = await api.setup()
}

async function recheck() {
  checking.value = true
  try {
    await load()
  } finally {
    // Long enough to be seen: an instant re-render reads as "nothing happened".
    setTimeout(() => (checking.value = false), 350)
  }
}

onMounted(load)

const controller = computed(() => state.value?.controller ?? null)

/** Where the chosen driver actually is, or nothing. Never "probably". */
const controllerPath = computed(() => {
  const c = controller.value
  if (!c || c === 'none') return null
  return state.value?.harnesses[c as 'claude' | 'codex'] ?? null
})

async function chooseController(name: 'claude' | 'codex' | 'none') {
  busy.value = true
  try {
    await api.saveSetup({ controller: name })
    await load()
    step.value = 2
  } finally {
    busy.value = false
  }
}

async function finish() {
  busy.value = true
  try {
    await api.saveSetup({ walkthrough_done: true })
    router.push('/')
  } finally {
    busy.value = false
  }
}

const projects = computed(() => state.value?.projects ?? [])

/** Projects whose list already works, and can therefore be copied from. */
const equipped = computed(() => projects.value.filter((p) => p.allowed_tools >= 10))

const copying = ref<string | null>(null)
const copied = ref<Record<string, string>>({})

async function copyFrom(slug: string, from: string) {
  copying.value = slug
  try {
    const r = await api.copyPermissions(slug, from)
    copied.value = { ...copied.value, [slug]: `${r.added} taken from ${r.from}` }
    await load()
  } catch (e: any) {
    copied.value = { ...copied.value, [slug]: e?.response?.data?.message ?? 'could not copy' }
  } finally {
    copying.value = null
  }
}
const firstProject = computed(() => projects.value[0] ?? null)

/**
 * What has to be true before anything can run, each answered by a probe.
 * `met` is what was measured; `evidence` is what was seen; `fix` is the one
 * thing that changes it — a command when the tool is not allowed to act.
 */
const requirements = computed(() => {
  const s = state.value
  if (!s) return []
  const list = []

  if (controller.value && controller.value !== 'none') {
    list.push({
      key: 'controller',
      met: Boolean(controllerPath.value),
      title: `${controller.value === 'claude' ? 'Claude Code' : 'Codex'} is installed here`,
      evidence: controllerPath.value ?? 'not found on this machine',
      fix:
        controller.value === 'claude'
          ? 'Install it, then check again — this page does not install software for you.'
          : 'Install it, then check again.',
    })
  }

  list.push({
    key: 'browser',
    met: s.browser.listening,
    title: 'Chrome is reachable for the judging conversation',
    evidence: s.browser.listening
      ? `listening on ${s.browser.port}`
      : `nothing on port ${s.browser.port}`,
    // Not a chore any more: a worker starts it on its own dedicated profile the
    // moment it needs one, and reloads it if the page ever stops answering.
    fix: 'Nothing to do — a worker starts it itself, on a profile separate from the one you browse with.',
  })

  // Asked of the page, not inferred from a URL: a tab parked on the sign-in
  // screen satisfies "a chatgpt.com tab exists" perfectly, and the first pass
  // would then run head-first into a form.
  list.push({
    key: 'tab',
    met: s.browser.signedIn === true,
    title: 'The browser is signed in to ChatGPT',
    evidence:
      s.browser.signedIn === true
        ? 'session live in the tool’s profile'
        : s.browser.signedIn === false
          ? 'signed out — the page is showing a login wall'
          : s.browser.listening
            ? 'no chatgpt.com tab to ask'
            : 'browser not reachable, so not knowable',
    // Only ask for a sign-in when there is one to do. Telling someone to sign in
    // because a tab happens to be closed sends them to fix the wrong thing.
    fix:
      s.browser.signedIn === false
        ? 'Sign in once in that Chrome — the one the tool started, not the one you browse with. ' +
          'The session then lives in that profile and every run reuses it. A password is never ' +
          'the tool’s to type.'
        : s.browser.listening
          ? 'Nothing to do — the loop opens the conversation itself when it needs one.'
          : 'Nothing to do — a worker starts the browser itself.',
  })

  list.push({
    key: 'worker',
    met: s.workers_seen > 0,
    title: 'A worker has carried something out',
    evidence: s.workers_seen
      ? `${s.workers_seen} machine${s.workers_seen > 1 ? 's' : ''} seen in the last day`
      : 'nothing has run yet',
    fix: 'orchestrator work --every 5',
  })

  return list
})

const unmet = computed(() => requirements.value.filter((r) => !r.met))

const STEPS = [
  { n: 1, title: 'What this is' },
  { n: 2, title: 'Who drives it' },
  { n: 3, title: 'What it needs' },
  { n: 4, title: 'Your first project' },
  { n: 5, title: 'Who does the work' },
  { n: 6, title: 'Start it' },
]

/** Green once the step's condition is measured true — not once it was visited. */
function done(n: number) {
  const s = state.value
  if (!s) return false
  if (n === 2) return Boolean(controller.value)
  if (n === 3) return requirements.value.length > 0 && unmet.value.length === 0
  // `some` was a lie by arithmetic: one project in order turned the step green
  // while two others had no repository and no tools. Every project counts.
  if (n === 4) return projects.value.length > 0 && projects.value.every((p) => p.repo_exists)
  if (n === 5) return projects.value.length > 0 && projects.value.every((p) => p.allowed_tools >= 10)
  if (n === 6) return s.workers_seen > 0
  return false
}
</script>

<template>
  <div v-if="!state" class="text-ink-400">loading…</div>

  <div v-else class="flex gap-10 items-start">
    <!-- The rail is numbered because this genuinely is a sequence: you cannot
         choose a repository before choosing what drives the tool. -->
    <nav class="w-52 shrink-0 sticky top-16">
      <button
        v-for="s in STEPS"
        :key="s.n"
        class="w-full text-left flex items-baseline gap-3 py-1.5 group"
        @click="step = s.n - 1"
      >
        <span
          class="num text-[11px] w-4"
          :class="done(s.n) ? 'text-proof' : step === s.n - 1 ? 'text-ink-100' : 'text-ink-700'"
        >
          {{ done(s.n) ? '✓' : s.n }}
        </span>
        <span
          class="text-[12px] transition-colors"
          :class="step === s.n - 1 ? 'text-ink-100' : 'text-ink-500 group-hover:text-ink-300'"
        >
          {{ s.title }}
        </span>
      </button>

      <button v-if="state.projects.length" class="label mt-6 hover:text-ink-300" @click="finish">
        skip — I know this tool
      </button>
    </nav>

    <div class="flex-1 min-w-0 max-w-3xl">
      <!-- 1 ─ WHAT THIS IS ------------------------------------------------- -->
      <section v-if="step === 0" class="space-y-5">
        <h1 class="text-ink-100 text-[22px] leading-tight">
          It runs coding agents on your repositories,<br />
          and refuses to call anything finished without proof.
        </h1>

        <p class="text-ink-300 leading-relaxed">
          You write down what would prove a piece of work is done — a test that passes, an image
          that shows the thing, a measurement taken on the live site. An agent then works until that
          is true. Until it is, the objective is not finished, whatever the agent says about it.
        </p>

        <p class="text-ink-400 leading-relaxed">
          Nothing on these screens is typed in by hand. What was spent, what moved, which harness
          worked, what it touched, what broke — all of it is read back from what actually happened.
          That is why this walkthrough goes and looks at your machine instead of asking you
          questions about it.
        </p>

        <div class="card p-4 text-ink-400 leading-relaxed">
          Two things it will never do for you: type a password, a key or a token, and tick a consent
          box on your behalf. Those come back as a command for you to run — and are then checked.
        </div>

        <button class="btn" @click="step = 1">Start</button>
      </section>

      <!-- 2 ─ WHO DRIVES IT ------------------------------------------------ -->
      <section v-else-if="step === 1" class="space-y-5">
        <h1 class="text-ink-100 text-[19px]">Who drives Orchestrator</h1>
        <p class="text-ink-300 leading-relaxed">
          Day to day you will not be clicking through these screens. You talk to an AI in your
          terminal — "break this down", "run the next chapter", "why did that stop" — and it
          operates the tool for you. That is a different job from the AI that judges each project's
          work; this one is the one you talk to.
        </p>

        <div class="space-y-2">
          <button
            v-for="c in [
              { id: 'claude', name: 'Claude Code', note: 'A terminal agent. Reads the repository, runs commands, drives this tool.' },
              { id: 'codex', name: 'Codex CLI', note: 'Same job, OpenAI’s harness.' },
              { id: 'none', name: 'Nobody — I will use these screens', note: 'Everything here can be done by hand. Slower, and nothing is lost.' },
            ]"
            :key="c.id"
            class="card p-4 w-full text-left hover:border-ink-600 transition-colors"
            :class="controller === c.id ? 'border-run/60 bg-run/[0.05]' : ''"
            :disabled="busy"
            @click="chooseController(c.id as 'claude' | 'codex' | 'none')"
          >
            <div class="flex items-baseline gap-3 flex-wrap">
              <span class="text-ink-100">{{ c.name }}</span>
              <span
                v-if="c.id !== 'none'"
                class="num text-[11px]"
                :class="state.harnesses[c.id as 'claude' | 'codex'] ? 'text-proof' : 'text-ink-600'"
              >
                {{ state.harnesses[c.id as 'claude' | 'codex'] ?? 'not found on this machine' }}
              </span>
            </div>
            <p class="text-ink-400 mt-1">{{ c.note }}</p>
          </button>
        </div>

        <p class="text-ink-600 text-[11px]">
          Found by asking the shell, and by re-using the path a previous check recorded — Codex
          installs outside the PATH, and looking only there reported it missing.
        </p>
      </section>

      <!-- 3 ─ WHAT IT NEEDS ------------------------------------------------ -->
      <section v-else-if="step === 2" class="space-y-5">
        <div class="flex items-baseline gap-3">
          <h1 class="text-ink-100 text-[19px]">What it needs</h1>
          <button class="label ml-auto hover:text-ink-300" :disabled="checking" @click="recheck">
            {{ checking ? 'looking…' : 'check again' }}
          </button>
        </div>

        <p class="text-ink-300 leading-relaxed">
          Each line was measured just now. What is missing is followed by the one thing that
          changes it.
        </p>

        <div class="card divide-y divide-ink-850">
          <div v-for="r in requirements" :key="r.key" class="p-4">
            <div class="flex items-baseline gap-3 flex-wrap">
              <span
                class="w-1.5 h-1.5 rounded-full self-center shrink-0"
                :class="r.met ? 'bg-proof' : 'bg-halt'"
              />
              <span class="text-ink-100">{{ r.title }}</span>
              <span class="num text-[11px] ml-auto" :class="r.met ? 'text-ink-500' : 'text-halt'">
                {{ r.evidence }}
              </span>
            </div>
            <p v-if="!r.met" class="mt-2 pl-4.5">
              <code class="num text-[12px] text-ink-300 bg-ink-950 border border-ink-800 rounded px-2 py-1 inline-block">
                {{ r.fix }}
              </code>
            </p>
          </div>
        </div>

        <p v-if="!unmet.length" class="text-proof">Everything it needs is there.</p>
        <button class="btn" @click="step = 3">Next</button>
      </section>

      <!-- 4 ─ FIRST PROJECT ------------------------------------------------ -->
      <section v-else-if="step === 3" class="space-y-5">
        <h1 class="text-ink-100 text-[19px]">Your first project</h1>
        <p class="text-ink-300 leading-relaxed">
          A project is a repository plus the conversation that judges its work. The repository path
          is checked against the disk — a wrong one breaks everything downstream in silence, because
          proofs then resolve to nothing.
        </p>

        <div v-if="projects.length" class="card divide-y divide-ink-850">
          <div v-for="p in projects" :key="p.slug" class="p-4 flex items-baseline gap-3 flex-wrap">
            <span
              class="w-1.5 h-1.5 rounded-full self-center shrink-0"
              :class="p.repo_exists ? 'bg-proof' : 'bg-fail'"
            />
            <RouterLink :to="`/p/${p.slug}`" class="text-ink-100 hover:underline">{{ p.name }}</RouterLink>
            <span class="num text-ink-500 text-[11px]">{{ p.repo_path ?? 'no repository' }}</span>
            <span v-if="!p.repo_exists" class="text-fail text-[11px]">not on this machine</span>
            <span v-if="!p.has_judge" class="text-halt text-[11px] ml-auto">no judging conversation</span>
          </div>
        </div>

        <NewProject @created="load" />
        <div><button class="btn" @click="step = 4">Next</button></div>
      </section>

      <!-- 5 ─ WHO DOES THE WORK -------------------------------------------- -->
      <section v-else-if="step === 4" class="space-y-5">
        <h1 class="text-ink-100 text-[19px]">Who does the work</h1>
        <p class="text-ink-300 leading-relaxed">
          The judging conversation picks a harness for each attempt, on what the work needs — not on
          what it costs. For that choice to mean anything, each harness has to be able to act.
        </p>

        <div class="card divide-y divide-ink-850">
          <div v-for="p in projects" :key="p.slug" class="p-4 flex items-baseline gap-3 flex-wrap">
            <span
              class="w-1.5 h-1.5 rounded-full self-center shrink-0"
              :class="p.allowed_tools >= 10 ? 'bg-proof' : 'bg-halt'"
            />
            <span class="text-ink-100">{{ p.name }}</span>
            <span class="num text-[11px]" :class="p.allowed_tools >= 10 ? 'text-ink-500' : 'text-halt'">
              {{ p.allowed_tools }} tools allowed for Claude
            </span>
            <span v-if="copied[p.slug]" class="text-proof text-[11px] ml-auto">{{ copied[p.slug] }}</span>

            <!-- Taking them, not describing them. Copying a list that already
                 works beats inventing a default here, which would be a guess
                 wearing the clothes of a recommendation. -->
            <button
              v-else-if="p.allowed_tools < 10 && equipped.length"
              class="chip border-run/50 text-run hover:bg-run/10 ml-auto"
              :disabled="copying === p.slug"
              :title="`Copy the rules from ${equipped[0].name}, denials included`"
              @click="copyFrom(p.slug, equipped[0].slug)"
            >
              {{ copying === p.slug ? '…' : `take ${equipped[0].name}’s rules` }}
            </button>

            <RouterLink
              :to="`/p/${p.slug}/permissions`"
              class="label hover:text-ink-300"
              :class="p.allowed_tools < 10 && equipped.length ? '' : 'ml-auto'"
            >
              review
            </RouterLink>
          </div>
        </div>

        <p class="text-ink-400 leading-relaxed">
          A session with nobody at the screen cannot ask for anything: a tool that is not on the
          list is refused without a word, so the attempt bills and produces nothing.
        </p>
        <p class="text-halt leading-relaxed">
          Codex is the exception, and it is worth knowing before you rely on the list. It runs with
          approvals and sandbox bypassed — the only way it reaches Unity unattended — so it is never
          handed the list at all. Its rules are documentation. To hold one for real, put it in the
          repository: a pre-push hook binds every harness.
        </p>

        <button class="btn" @click="step = 5">Next</button>
      </section>

      <!-- 6 ─ START -------------------------------------------------------- -->
      <section v-else class="space-y-5">
        <h1 class="text-ink-100 text-[19px]">Start it</h1>
        <p class="text-ink-300 leading-relaxed">
          Nothing on this screen runs anything by itself. It records what you asked for; a worker on
          the machine that holds the repository picks it up and carries it out. That is deliberate —
          a server that could run commands on your machine would be a far worse thing to expose.
        </p>

        <div class="card p-4">
          <span class="label">In the repository, once</span>
          <pre class="num text-[12px] text-ink-200 mt-2 whitespace-pre-wrap">cd {{ firstProject?.repo_path ?? '<your repository>' }}
orchestrator work --every 5</pre>
          <p class="text-ink-500 text-[11px] mt-2">
            Leave it running. It claims what you queue from these screens, one at a time.
          </p>
        </div>

        <p class="text-ink-400 leading-relaxed">
          Then open a project, write down what would prove its first step is finished, and run it.
          When something needs you — a judgement to make, a conversation that has filled up — it
          will be on the overview, and nowhere else.
        </p>

        <button class="btn" :disabled="busy" @click="finish">
          {{ busy ? '…' : 'Take me to the overview' }}
        </button>
      </section>
    </div>
  </div>
</template>
