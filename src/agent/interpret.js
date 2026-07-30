import { execFileSync } from 'node:child_process'

/**
 * The last resort when the conversation left no marker.
 *
 * Absolute rule: **the interpreter decides and delimits, it never rewrites.**
 * It returns positions in the text; we do the cutting ourselves. The mission
 * that reaches the harness is therefore always, to the character, the one the
 * judge wrote — otherwise we would lose the only thing that lets us tell "the
 * order was bad" from "the execution was bad".
 *
 * An interpreter that composed could invent an order nobody gave. In a tool that
 * works unattended, that is the worst possible defect — worse than doing nothing.
 *
 * NOTE: nothing imports this module yet. It is a fallback that was written and
 * never wired in; the loop still stops when a marker is missing, by design.
 */

const SCHEMA = `{"type":"none"|"mission"|"done"|"question","harness":"claude"|"codex"|null,"start":<integer>,"end":<integer>,"why":"<one sentence>"}`

export function interpret(message, { model = 'claude' } = {}) {
  if (!message || message.length < 15) return { type: 'none', why: 'message too short' }

  // We number the lines: asking a model for character offsets yields wrong
  // bounds; line numbers, it counts correctly.
  const lines = message.split('\n')
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n')

  const instruction = [
    'You are reading the latest reply in a conversation that drives development agents.',
    'Your only job is to say what this reply IS, and where the instruction sits if there is one.',
    '',
    'You rewrite nothing. You summarise nothing. You return line numbers.',
    '',
    'The possible types:',
    '- "mission": the reply contains an order of work for an agent to execute;',
    '- "done": it says the work or the chapter is finished, without giving a new order;',
    '- "question": it asks the human for something instead of giving an order;',
    '- "none": it contains neither order, nor ending, nor question — a comment, a bare verdict, hesitation.',
    '',
    'If the type is "mission":',
    '- `harness` = the one that must execute it, if named (claude or codex), otherwise null;',
    '- `start` and `end` = the first and last line of the instruction, bounds included;',
    '- take the WHOLE instruction: required reading, prohibitions, scoring, deliverables. Not just its title.',
    '',
    'Otherwise, `start` and `end` are 0.',
    '',
    `Reply ONLY with this JSON object, with no text around it: ${SCHEMA}`,
    '',
    '--- REPLY TO CLASSIFY ---',
    numbered,
    '--- END ---',
  ].join('\n')

  let raw
  try {
    raw = execFileSync(model, ['-p', instruction, '--disallowed-tools', 'Bash', 'Write', 'Edit'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ORCHESTRATOR_MANAGED: '1' },
    })
  } catch (e) {
    return { type: 'none', why: `interpreter unavailable: ${String(e.message).slice(0, 120)}` }
  }

  const read = extract(raw)
  if (!read?.type) return { type: 'none', why: 'interpreter output unusable' }

  if (read.type !== 'mission') {
    return { type: read.type, why: read.why ?? null }
  }

  // We clamp BEFORE cutting: a model that returns "line 900" for a 40-line text
  // must not produce an empty mission we would take for a valid one.
  const start = Math.max(1, Math.min(Number(read.start) || 1, lines.length))
  const end = Math.max(start, Math.min(Number(read.end) || lines.length, lines.length))
  const task = lines.slice(start - 1, end).join('\n').trim()

  if (task.length < 40) {
    return { type: 'none', why: `bounds unusable (lines ${start}-${end})` }
  }

  return {
    type: 'mission',
    harness: ['claude', 'codex'].includes(read.harness) ? read.harness : null,
    task,
    lines: [start, end],
    why: read.why ?? null,
  }
}

/** The first JSON object in the reply, whatever decoration surrounds it. */
function extract(text) {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '')
  const start = t.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\') {
      escaped = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(t.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}
