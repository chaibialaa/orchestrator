/**
 * The trap pack — our scars, compiled.
 *
 * Every rule comes from a real incident. It is only worth having if it is
 * mechanical: no heuristics, no "probably". A rule that produces false positives
 * will get switched off, and the whole pack loses its credibility.
 *
 * `test` receives (line, path) and returns true when the line breaks the rule.
 */

export const RULES = [
  {
    id: 'cache-remember-collection',
    files: /\.php$/,
    severity: 'halt',
    why: "Laravel 13 deserialises a cached Collection into __PHP_Incomplete_Class.",
    test: (line) =>
      /Cache::remember\w*\(/.test(line) && /->get\(\)|->all\(\)|collect\(/.test(line),
  },
  {
    id: 'cache-remember-ttl-court',
    files: /\.php$/,
    severity: 'warn',
    why: "A computation longer than its TTL stacks up recomputations — that was incident.tn's 504 outage.",
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
    why: "->find() returns a model: the ->where() that follows filters nothing at all.",
    // `Model::find($id)->where(...)` autant que `$repo->find($id)->where(...)`
    test: (line) => /(->|::)find\(\s*\$?\w+\s*\)\s*->where\(/.test(line),
  },
  {
    id: 'load-sur-support-collection',
    files: /\.php$/,
    severity: 'warn',
    why: "->load() does not exist on Support\\Collection — a 500 at runtime.",
    test: (line) => /collect\([^)]*\)\s*->load\(/.test(line),
  },
  {
    id: 'validation-cle-plate',
    files: /validation\.php$/,
    severity: 'halt',
    why: "Laravel looks for NESTED keys (max.string); a flat key (max_string) displays the raw key.",
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
    why: "response.success is TRUE for a 205: a refusal closes the form announcing success. Use isAccepted().",
    test: (line) => /\b(response|res|data)\.success\b/.test(line) && !/isAccepted/.test(line),
  },
  {
    id: 'import-meta-env-dans-flechee',
    files: /\.(ts|js|vue)$/,
    severity: 'halt',
    why: "() => import.meta.env.X breaks the BUILD (not dev) when the variable is absent. Assign at module level.",
    test: (line) => /=>\s*import\.meta\.env\./.test(line),
  },
  {
    id: 'migration-outside-single-file',
    files: /database\/migrations\/.*\.php$/,
    severity: 'halt',
    why: "Convention: no new migration — extend create_finances_tables plus an idempotent migrate:post-update.",
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
