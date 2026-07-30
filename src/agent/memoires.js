import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, basename, relative, sep } from 'node:path'
import { homedir } from 'node:os'

/**
 * Les mémoires d'IA laissées sur la machine : instructions de projet, mémoire
 * du harnais, règles Codex, consignes Cursor. Elles disent ce qu'on a appris —
 * et personne ne les relit jamais parce qu'elles sont éparpillées.
 *
 * Deux temps, volontairement séparés :
 *   1. l'INVENTAIRE, gratuit, qui dit ce qui existe et où ;
 *   2. la DISTILLATION, qui coûte un appel de modèle et ne part qu'à la demande.
 *
 * On ne lit que des racines DÉCLARÉES. Ces fichiers contiennent des noms de
 * serveurs, des bases, des notes personnelles : personne ne doit découvrir
 * après coup ce qui est parti chez un modèle.
 */

const IGNORER = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'Library', 'Temp'])
const EXTENSIONS = /\.(md|mdc|txt)$/i

/** Les endroits où les IA rangent ce qu'elles savent. */
export function racines(depots = []) {
  const h = homedir()
  return [
    { source: 'harnais', chemin: join(h, '.claude', 'projects'), profondeur: 3 },
    { source: 'global', chemin: join(h, '.claude', 'CLAUDE.md') },
    { source: 'codex', chemin: join(h, '.codex', 'memories'), profondeur: 2 },
    { source: 'codex', chemin: join(h, '.codex', 'rules'), profondeur: 2 },
    ...depots.flatMap((d) => [
      { source: 'dépôt', chemin: join(d, 'CLAUDE.md'), projet: basename(d) },
      { source: 'dépôt', chemin: join(d, 'AGENTS.md'), projet: basename(d) },
      { source: 'dépôt', chemin: join(d, '.claude'), profondeur: 2, projet: basename(d) },
      { source: 'dépôt', chemin: join(d, '.cursor'), profondeur: 2, projet: basename(d) },
    ]),
  ]
}

function parcourir(chemin, profondeur, sortie, niveau = 0) {
  if (!existsSync(chemin)) return sortie
  const st = statSync(chemin)

  if (st.isFile()) {
    if (EXTENSIONS.test(chemin)) sortie.push({ chemin, taille: st.size, modifie: st.mtime.toISOString() })
    return sortie
  }
  if (niveau >= profondeur) return sortie

  for (const e of readdirSync(chemin, { withFileTypes: true })) {
    if (IGNORER.has(e.name) || (e.name.startsWith('.') && niveau > 0)) continue
    parcourir(join(chemin, e.name), profondeur, sortie, niveau + 1)
  }
  return sortie
}

/**
 * Le harnais encode le chemin du dépôt dans son nom de dossier, en remplaçant
 * `/` ET `_` par `-`. Décoder est donc ambigu : `htdocs-Tycoon-Project` peut
 * être `htdocs/Tycoon/Project` ou `htdocs/Tycoon_Project`. On ENCODE les
 * chemins qu'on connaît et on compare — même méthode que le lecteur de
 * transcripts, pour la même raison.
 */
const encoder = (chemin) => chemin.replace(/[/_.]/g, '-')

function projetDe(fichier, indice, depots) {
  if (indice) return indice

  const m = /\.claude\/projects\/([^/]+)\//.exec(fichier)
  if (!m) return 'inconnu'

  // Le dépôt le plus SPÉCIFIQUE qui correspond : sans ça, tout retomberait
  // sur la racine commune et un seul projet avalerait les autres.
  const candidats = depots
    .map((d) => ({ d, e: encoder(d) }))
    .filter(({ e }) => m[1] === e)
    .sort((a, b) => b.e.length - a.e.length)

  if (candidats.length) return basename(candidats[0].d)

  // Pas de dépôt connu : on garde le dossier brut plutôt que d'inventer un
  // nom. Un rattachement faux vaut moins que pas de rattachement.
  return m[1]
}

/** L'inventaire : ce qui existe, où, et à quel projet ça se rattache. */
export function inventorier(depots = []) {
  const fichiers = []

  for (const r of racines(depots)) {
    for (const f of parcourir(r.chemin, r.profondeur ?? 1, [])) {
      fichiers.push({
        ...f,
        source: r.source,
        projet: projetDe(f.chemin, r.projet, depots),
        nom: basename(f.chemin),
      })
    }
  }

  const parProjet = {}
  for (const f of fichiers) {
    const p = (parProjet[f.projet] ??= { fichiers: [], octets: 0 })
    p.fichiers.push(f)
    p.octets += f.taille
  }

  return {
    total: fichiers.length,
    octets: fichiers.reduce((n, f) => n + f.taille, 0),
    projets: Object.fromEntries(
      Object.entries(parProjet)
        .map(([nom, p]) => [nom, { nombre: p.fichiers.length, octets: p.octets, fichiers: p.fichiers.map((f) => f.chemin) }])
        .sort((a, b) => b[1].octets - a[1].octets),
    ),
  }
}

/**
 * Assemble la matière d'un projet pour la distillation. On borne : au-delà,
 * on prend les fichiers les plus récents et on DIT ce qu'on a laissé, plutôt
 * que de tronquer en silence et de faire croire à une lecture complète.
 */
export function assembler(fichiers, { plafondOctets = 400_000 } = {}) {
  const tries = [...fichiers]
    .map((c) => ({ chemin: c, ...statSync(c) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  const pris = []
  const laisses = []
  let total = 0

  for (const f of tries) {
    if (total + f.size > plafondOctets) {
      laisses.push(f.chemin)
      continue
    }
    total += f.size
    pris.push(f.chemin)
  }

  const corps = pris
    .map((c) => `\n===== ${c} =====\n${readFileSync(c, 'utf8')}`)
    .join('\n')

  return { corps, pris, laisses, octets: total }
}

/** La consigne de distillation. Ce qu'on veut n'est pas un résumé : c'est ce qui SERT. */
export function consigne(projet, corps) {
  return [
    `Voici tout ce que des assistants IA ont mémorisé sous « ${projet} », ramassé sur cette machine.`,
    '',
    "Attention : cette mémoire peut couvrir PLUSIEURS projets — elle a été écrite depuis un dossier",
    "qui les contient tous. Si c'est le cas, produis un contexte par projet distinct que tu y trouves,",
    'et ne mélange jamais leurs contraintes.',
    '',
    "Distille-le en un contexte utilisable par un agent qui reprendrait ce projet demain sans rien en savoir.",
    '',
    'Règles :',
    "- garde ce qui CONTRAINT encore le travail : décisions tranchées, pièges vérifiés, conventions imposées ;",
    "- jette ce qui est daté, résolu, ou propre à une session — un bug corrigé n'est pas une contrainte ;",
    '- si deux sources se contredisent, dis-le et donne la plus récente ;',
    "- une ligne par élément, en français, formulée comme une règle qu'on peut appliquer, pas comme un souvenir ;",
    "- n'invente rien : si une information manque, elle manque.",
    '',
    'Réponds UNIQUEMENT par un objet JSON, sans texte autour :',
    '{"projets":[{"nom":"…","titre":"…","contexte":"…markdown…","contraintes":["…"],"contradictions":["…"],"perime":["…"]}]}',
    '',
    '--- MATIÈRE ---',
    corps,
    '--- FIN ---',
  ].join('\n')
}

/**
 * L'empreinte de l'état des mémoires : nombre de fichiers, octets, et la date
 * de modification la plus récente. Deux empreintes identiques veulent dire que
 * rien n'a bougé — et donc qu'un relevé reste valable. C'est bien moins cher
 * que de relire trois mille fichiers pour s'en assurer.
 */
export function empreinte(inventaire) {
  const tous = Object.values(inventaire.projets ?? {}).flatMap((p) => p.fichiers ?? [])
  let recent = 0
  let octets = 0
  for (const c of tous) {
    try {
      const st = statSync(c)
      octets += st.size
      if (st.mtimeMs > recent) recent = st.mtimeMs
    } catch {
      /* un fichier disparu compte comme un changement : il ne sera pas pesé */
    }
  }
  return `${tous.length}:${octets}:${Math.round(recent / 1000)}`
}
