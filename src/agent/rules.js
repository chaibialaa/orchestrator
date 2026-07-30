/**
 * Le pack de pièges — nos cicatrices, compilées.
 *
 * Chaque règle vient d'un incident réel. Elle ne vaut que si elle est
 * mécanique : pas d'heuristique, pas de « probablement ». Une règle qui
 * produit des faux positifs sera désactivée, et le pack entier perdra
 * sa crédibilité.
 *
 * `test` reçoit (ligne, chemin) et renvoie vrai si la ligne enfreint.
 */

export const RULES = [
  {
    id: 'cache-remember-collection',
    files: /\.php$/,
    severity: 'halt',
    why: "Laravel 13 désérialise une Collection mise en cache en __PHP_Incomplete_Class.",
    test: (line) =>
      /Cache::remember\w*\(/.test(line) && /->get\(\)|->all\(\)|collect\(/.test(line),
  },
  {
    id: 'cache-remember-ttl-court',
    files: /\.php$/,
    severity: 'warn',
    why: "Un calcul plus long que son TTL empile les recalculs — c'est la panne 504 d'incident.tn.",
    test: (line) => /Cache::remember\w*\([^,]+,\s*(\d{1,2})\s*,/.test(line),
  },
  {
    id: 'validate-dans-try',
    files: /\.php$/,
    severity: 'warn',
    why: "$request->validate() dans un try/catch transforme un 422 en 500.",
    test: (line, _path, ctx) => /->validate\(/.test(line) && ctx.insideTry,
  },
  {
    id: 'find-puis-where',
    files: /\.php$/,
    severity: 'halt',
    why: "->find() renvoie un modèle : le ->where() qui suit ne filtre plus rien.",
    // `Model::find($id)->where(...)` autant que `$repo->find($id)->where(...)`
    test: (line) => /(->|::)find\(\s*\$?\w+\s*\)\s*->where\(/.test(line),
  },
  {
    id: 'load-sur-support-collection',
    files: /\.php$/,
    severity: 'warn',
    why: "->load() n'existe pas sur Support\\Collection — 500 à l'exécution.",
    test: (line) => /collect\([^)]*\)\s*->load\(/.test(line),
  },
  {
    id: 'validation-cle-plate',
    files: /validation\.php$/,
    severity: 'halt',
    why: "Laravel cherche des clés IMBRIQUÉES (max.string) ; une clé plate (max_string) affiche la clé brute.",
    test: (line) => /^\s*'(max|min|between|size|gt|lt|gte|lte)_(string|numeric|file|array)'\s*=>/.test(line),
  },
  {
    id: 'alert-ou-confirm',
    files: /\.(vue|ts|js)$/,
    severity: 'halt',
    why: "Interdits : passer par toast + swalConfirm.ts.",
    test: (line) => /(^|[^.\w])(alert|confirm)\s*\(/.test(line) && !/\/\//.test(line.split('alert')[0] ?? ''),
  },
  {
    id: 'response-success-sur-205',
    files: /\.(vue|ts)$/,
    severity: 'halt',
    why: "response.success est VRAI pour un 205 : un refus ferme le formulaire en annonçant un succès. Utiliser isAccepted().",
    test: (line) => /\b(response|res|data)\.success\b/.test(line) && !/isAccepted/.test(line),
  },
  {
    id: 'import-meta-env-dans-flechee',
    files: /\.(ts|js|vue)$/,
    severity: 'halt',
    why: "() => import.meta.env.X casse le BUILD (pas le dev) si la variable est absente. Assigner au niveau module.",
    test: (line) => /=>\s*import\.meta\.env\./.test(line),
  },
  {
    id: 'migration-hors-fichier-unique',
    files: /database\/migrations\/.*\.php$/,
    severity: 'halt',
    why: "Convention : pas de nouvelle migration — étendre create_finances_tables + migrate:post-update idempotent.",
    test: (line, path) =>
      /Schema::create\(/.test(line) && !/create_finances_tables/.test(path),
  },
]

/** Analyse un contenu de fichier et renvoie les infractions. */
export function checkFile(path, content) {
  const applicable = RULES.filter((r) => r.files.test(path))
  if (!applicable.length) return []

  const findings = []
  const lines = content.split('\n')
  const ctx = { insideTry: false }
  let tryDepth = 0

  lines.forEach((line, i) => {
    if (/\btry\s*\{/.test(line)) tryDepth += 1
    if (tryDepth > 0 && /^\s*\}\s*catch/.test(line)) tryDepth = Math.max(0, tryDepth - 1)
    ctx.insideTry = tryDepth > 0

    for (const rule of applicable) {
      if (rule.test(line, path, ctx)) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          why: rule.why,
          path,
          line: i + 1,
          code: line.trim().slice(0, 120),
        })
      }
    }
  })

  return findings
}
