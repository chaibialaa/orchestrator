import { readFileSync } from 'node:fs'
import { base } from './index.js'

/**
 * Reprend l'export de l'ancien socle. On garde les identifiants d'origine :
 * les preuves, les arrêts et les décisions se citent entre eux par numéro, et
 * les journaux déjà écrits mentionnent « #14 ». Les renuméroter rendrait faux
 * tout ce qui a été dit jusqu'ici.
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

/** Ce que l'ancien socle stockait autrement, et qu'il faut traduire. */
const BOOLEENS = {
  passages: ['prevented'],
  resources: ['included'],
  invariants: ['armed'],
  workflows: ['active'],
  agents: ['enabled'],
}

export function importer(fichier, { verbose = true } = {}) {
  const db = base()
  const dump = JSON.parse(readFileSync(fichier, 'utf8'))
  const bilan = {}

  const colonnesDe = (table) =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))

  db.transaction(() => {
    for (const table of TABLES) {
      const lignes = dump[table] ?? []
      if (!lignes.length) {
        bilan[table] = 0
        continue
      }

      const connues = colonnesDe(table)
      const bools = BOOLEENS[table] ?? []
      let posees = 0
      let ignorees = new Set()

      for (const ligne of lignes) {
        const champs = {}
        for (const [k, v] of Object.entries(ligne)) {
          if (!connues.has(k)) {
            ignorees.add(k)
            continue
          }
          champs[k] = bools.includes(k) ? (v ? 1 : 0) : v instanceof Object ? JSON.stringify(v) : v
        }

        const noms = Object.keys(champs)
        if (!noms.length) continue

        db.prepare(
          `INSERT OR REPLACE INTO ${table} (${noms.join(',')}) VALUES (${noms.map((n) => '@' + n).join(',')})`,
        ).run(champs)
        posees++
      }

      bilan[table] = posees
      if (verbose && ignorees.size) {
        console.log(`  ${table} : ${[...ignorees].join(', ')} — colonne(s) abandonnée(s), sans usage`)
      }
    }
  })()

  return bilan
}
