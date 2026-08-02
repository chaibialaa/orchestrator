import { writeFileSync } from 'node:fs'
import { base } from './index.js'

/**
 * The other half of `import`, which the README promised and nothing produced.
 *
 * Same tables, same order, same identifiers. Proofs, halts and decisions cite
 * each other by number and the logs already written say "#14": renumbering on
 * the way out would falsify everything said so far, so ids travel as they are.
 *
 * `storages` and `settings` are deliberately NOT here. They hold OAuth tokens
 * and keys, and an export is a file people put in a shared folder — the one
 * place credentials must never go. Losing them on a restore is the correct
 * trade: they are reconnected in three clicks, and a leaked token is not
 * recalled at all.
 */
const TABLES = [
  'projects',
  'objectives',
  'passages',
  'evidences',
  'halts',
  'decisions',
  'resources',
  'invariants',
  'permissions',
  'workflows',
  'briefs',
  'agents',
]

export function exportData(file, { verbose = true } = {}) {
  const db = base()
  const dump = { exported_at: new Date().toISOString(), tables: TABLES }
  const counts = {}

  for (const table of TABLES) {
    try {
      const rows = db.prepare(`SELECT * FROM ${table}`).all()
      dump[table] = rows
      counts[table] = rows.length
    } catch {
      // A table this install does not have is not an error: an export made by a
      // newer version must still be readable by an older one, and the reverse.
      dump[table] = []
      counts[table] = 0
    }
  }

  const json = JSON.stringify(dump, null, 1)
  writeFileSync(file, json)

  if (verbose) {
    for (const [table, n] of Object.entries(counts)) {
      if (n) console.log(`  ${String(n).padStart(6)}  ${table}`)
    }
    const mo = (json.length / 1024 / 1024).toFixed(1)
    console.log(`\n  ${file} — ${mo} MB`)
    console.log('  storages and settings are not in it: they hold tokens.\n')
  }

  return { file, counts, bytes: json.length }
}
