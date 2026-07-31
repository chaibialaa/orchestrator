import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Which MCP servers each harness actually has, read from its own configuration.
 *
 * The screen could say which tools were CALLED, counted from the traces. It could
 * not say which are wired up, so a server that was never reached looked exactly
 * like one that does not exist — and the difference is the whole diagnosis.
 *
 * Nothing here is declared in Orchestrator. The harnesses own these files; we
 * read them and report what they say. A copy would drift the first time somebody
 * edited the real one.
 */

const CLAUDE_CONFIG = join(homedir(), '.claude.json')
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')

/** The pinned version, when the command carries one: `pkg==1.2.3`. */
function pinnedVersion(args = []) {
  for (const a of args) {
    const m = /^(.+)==(.+)$/.exec(String(a))
    if (m) return { package: m[1], version: m[2] }
  }
  return null
}

function fromClaude() {
  if (!existsSync(CLAUDE_CONFIG)) return []
  let config
  try {
    config = JSON.parse(readFileSync(CLAUDE_CONFIG, 'utf8'))
  } catch {
    return []
  }

  const out = []
  const add = (scope, name, server) =>
    out.push({
      harness: 'claude',
      scope,
      name,
      command: server.command ?? null,
      pin: pinnedVersion(server.args),
    })

  for (const [name, server] of Object.entries(config.mcpServers ?? {})) add(null, name, server)
  for (const [path, project] of Object.entries(config.projects ?? {})) {
    for (const [name, server] of Object.entries(project.mcpServers ?? {})) add(path, name, server)
  }
  return out
}

/**
 * Codex keeps its servers in TOML. Rather than take a dependency to read four
 * fields, we read the two lines that matter — and only from tables named
 * `[mcp_servers.x]`, so nothing else in the file can be mistaken for one.
 */
function fromCodex() {
  if (!existsSync(CODEX_CONFIG)) return []
  let text
  try {
    text = readFileSync(CODEX_CONFIG, 'utf8')
  } catch {
    return []
  }

  const out = []
  let current = null
  for (const line of text.split('\n')) {
    const table = /^\s*\[mcp_servers\.([^.\]]+)\]\s*$/.exec(line)
    if (table) {
      current = { harness: 'codex', scope: null, name: table[1], command: null, pin: null }
      out.push(current)
      continue
    }
    // Any other table ends the one we were in — including `[mcp_servers.x.env]`,
    // whose keys are not the server's own.
    if (/^\s*\[/.test(line)) {
      current = null
      continue
    }
    if (!current) continue

    const command = /^\s*command\s*=\s*"(.*)"\s*$/.exec(line)
    if (command) current.command = command[1]

    const args = /^\s*args\s*=\s*\[(.*)\]\s*$/.exec(line)
    if (args) {
      current.pin = pinnedVersion(args[1].split(',').map((a) => a.trim().replace(/^"|"$/g, '')))
    }
  }
  return out
}

/**
 * Every MCP server both harnesses know about, and where they disagree.
 *
 * The disagreements are the point. Claude pins mcpforunityserver 10.1.0 on one
 * Unity project and 10.0.0 on another, while Codex pins 10.0.0 everywhere — and
 * 10.0.0 cannot target a named Unity instance, so with two editors open it
 * refuses to act rather than write into the wrong one. That is correct behaviour
 * producing an incomprehensible symptom, and nothing on any screen said the
 * versions differed.
 */
export function mcpServers() {
  const all = [...fromClaude(), ...fromCodex()]

  // Grouped case-insensitively: Claude calls it `UnityMCP` and Codex calls it
  // `unityMCP`, and treating those as two servers hid the disagreement that
  // matters most — the two harnesses pinning different versions of it.
  const byName = new Map()
  for (const s of all) {
    const key = s.name.toLowerCase()
    const entry = byName.get(key) ?? { name: s.name, aliases: new Set(), entries: [], versions: new Set() }
    entry.aliases.add(s.name)
    entry.entries.push(s)
    if (s.pin) entry.versions.add(`${s.pin.package}==${s.pin.version}`)
    byName.set(key, entry)
  }

  return [...byName.values()]
    .map((e) => ({
      name: e.name,
      // Kept because the harnesses use them verbatim: a rule written against one
      // spelling does not apply to the other.
      aliases: [...e.aliases],
      entries: e.entries,
      versions: [...e.versions],
      // `.size`, not `.length`: this is a Set, and `undefined > 1` is false, so
      // the check reported agreement on every server including the one that
      // disagreed. Third time this exact shape has bitten — a property that does
      // not exist reads as falsy and the rule quietly never fires.
      disagrees: e.versions.size > 1,
    }))
    .sort((a, b) => Number(b.disagrees) - Number(a.disagrees) || a.name.localeCompare(b.name))
}
