import { base, json } from './db/index.js'

/**
 * La porte de preuve. « Terminé » n'est pas un champ qu'un agent écrit, c'est
 * une condition qu'on évalue — toute transition vers `proven` passe par ici.
 *
 * Chaque règle ci-dessous existe parce qu'elle a manqué au moins une fois, et
 * que son absence a laissé passer quelque chose de faux. Les commentaires
 * disent laquelle : les retirer, c'est rouvrir la porte.
 */

/** Types de preuve qui exigent un contact avec le réel, pas juste un build vert. */
export const REEL = ['e2e', 'manual', 'invariant', 'screenshot', 'render']

/** Motifs d'arrêt qui exigent VRAIMENT un humain. Les autres, la boucle les lève. */
export const ARRETS_HUMAINS = [
  'blast_radius',
  'no_provable_criterion',
  'invariant_regression',
  'human_request',
]

const echec = (reason, detail) => ({ ok: false, reason, detail, ready: false })

/** Qui a prononcé cette preuve, si c'en est une de jugement. Sinon, personne. */
const jugePar = (e) => json.lire(e.payload, {})?.judged_by ?? null

/** Le critère demande-t-il de regarder une image pour être tranché ? */
export function exigeDuVisuel(spec) {
  return /(capture|rendu|render|screenshot|image|visuel|lisible|à l['’]écran|plan [ABC])/iu.test(
    spec ?? '',
  )
}

export function evaluer(objectifId) {
  const db = base()
  const o = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectifId)
  if (!o) return echec('error', "Cet objectif n'existe pas.")

  if (!o.proof_spec || !o.proof_spec.trim()) {
    return echec('no_provable_criterion', "Aucun critère de preuve n'est défini pour cet objectif.")
  }

  // Un chapitre ne se conclut pas avant ses parties. Sans cette règle, un
  // parent portant quelques preuves passe « prêt » alors que ses sous-objectifs
  // sont encore ouverts.
  const enfantsOuverts = db
    .prepare("SELECT id, title FROM objectives WHERE parent_id = ? AND status NOT IN ('proven','abandoned')")
    .all(o.id)

  if (enfantsOuverts.length) {
    return echec(
      'children_open',
      `${enfantsOuverts.length} sous-objectif(s) encore ouvert(s) : ` +
        enfantsOuverts.map((e) => `#${e.id} ${e.title}`).join(' · ') +
        '.',
    )
  }

  const passing = db
    .prepare("SELECT * FROM evidences WHERE objective_id = ? AND verdict = 'pass'")
    .all(o.id)

  if (!passing.length) {
    return echec('no_new_proof', 'Aucune preuve au verdict `pass` rattachée à cet objectif.')
  }

  // Un critère qui exige de VOIR ne se conclut pas sur un texte. Le juge ne
  // dispose que de ce qu'on lui transmet : sans image attachée, son « validé »
  // porte sur le récit de l'exécutant, pas sur son travail. C'est arrivé deux
  // fois de suite avant que cette règle existe.
  if (exigeDuVisuel(o.proof_spec)) {
    const images = db
      .prepare("SELECT COUNT(*) n FROM evidences WHERE objective_id = ? AND type IN ('render','screenshot')")
      .get(o.id).n

    if (!images) {
      return echec(
        'no_new_proof',
        "Le critère demande de voir quelque chose, et aucune image n'est rattachée. " +
          "Un verdict prononcé sans rendu juge le récit de la session, pas son travail.",
      )
    }
  }

  // Rayon de souffle élevé : un build vert ne suffit pas, il faut une preuve
  // qui a touché le réel — et qui vienne du TRAVAIL, pas du jugement. Un
  // verdict est une preuve `manual`, donc « du réel » au sens de la liste :
  // sans cette exclusion, le juge se satisfaisait lui-même sur un objectif
  // critique. Découvert par un test, jamais par l'usage.
  if (['api', 'critical'].includes(o.blast_radius)) {
    const reelles = passing.filter((e) => REEL.includes(e.type) && jugePar(e) === null)
    if (!reelles.length) {
      const fournis = [...new Set(passing.map((e) => e.type))].join(', ')
      return echec(
        'blast_radius',
        `Rayon de souffle \`${o.blast_radius}\` : une preuve de type ${REEL.join('/')} est exigée, ` +
          `seuls des ${fournis} ont été fournis.`,
      )
    }
  }

  // Un juge a le droit de se dédire — mais sur quelque chose de NEUF. Sans
  // cette règle, il suffisait de redemander pour transformer un refus en
  // acceptation : refus à 12:40, acceptation à 12:49, zéro tentative et zéro
  // preuve entre les deux. C'est l'inverse exact de ce que l'outil promet.
  const dernierRefus = db
    .prepare(
      `SELECT evidence_mark FROM halts
       WHERE objective_id = ? AND reason IN ('verdict_rejected','human_request')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(o.id)

  if (dernierRefus?.evidence_mark != null) {
    const depuis = db
      .prepare(
        `SELECT COUNT(*) n FROM evidences
         WHERE objective_id = ? AND id > ? AND type != 'manual'`,
      )
      .get(o.id, dernierRefus.evidence_mark).n

    if (!depuis) {
      return echec(
        'no_new_proof',
        "Le juge a refusé, puis accepté, sans qu'aucune preuve n'ait été produite entre les deux. " +
          'Un avis peut changer ; il doit changer sur du neuf.',
      )
    }
  }

  const projet = db.prepare('SELECT gate_judge FROM projects WHERE id = ?').get(o.project_id)
  const juge = projet?.gate_judge ?? 'human'

  if (juge === 'gpt') {
    if (!passing.some((e) => jugePar(e) === 'gpt')) {
      // Distinction essentielle : il ne manque PAS une preuve, il manque un
      // verdict. L'objectif est prêt, il attend son juge.
      return {
        ok: false,
        reason: 'awaiting_verdict',
        detail: "Tout est là. Il ne manque que le verdict de la conversation qui pilote.",
        ready: true,
      }
    }
  } else if (juge !== 'self') {
    const independante = passing.some(
      (e) =>
        e.passage_id === null ||
        jugePar(e) !== null ||
        db.prepare('SELECT harness FROM passages WHERE id = ?').get(e.passage_id)?.harness === 'human',
    )

    if (!independante) {
      return {
        ok: false,
        reason: 'awaiting_verdict',
        detail:
          juge === 'human'
            ? "Tout est là. Il ne manque que ton verdict : les preuves viennent de l'exécutant, et ce projet exige que tu valides."
            : "Tout est là. Il ne manque qu'un jugement indépendant.",
        ready: true,
      }
    }
  }

  const arretOuvert = db
    .prepare('SELECT reason FROM halts WHERE objective_id = ? AND resolved_at IS NULL LIMIT 1')
    .get(o.id)

  if (arretOuvert) {
    return echec(
      'human_request',
      'Un arrêt reste ouvert sur cet objectif ; il doit être levé avant de conclure.',
    )
  }

  return { ok: true, reason: null, detail: null, ready: true }
}

/**
 * Un passage ne démarre que si l'on sait déjà comment on prouvera le résultat.
 * C'est la forme détectable de « je suis bloqué ».
 */
export function peutDemarrer(objectifId) {
  const db = base()
  const o = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectifId)
  if (!o) return echec('error', "Cet objectif n'existe pas.")

  if (!o.proof_spec || !o.proof_spec.trim()) {
    return echec(
      'no_provable_criterion',
      "Impossible de démarrer : l'objectif n'énonce pas comment il sera prouvé.",
    )
  }

  const bloquant = db
    .prepare(
      `SELECT reason FROM halts WHERE objective_id = ? AND resolved_at IS NULL
       AND reason IN (${ARRETS_HUMAINS.map(() => '?').join(',')}) LIMIT 1`,
    )
    .get(o.id, ...ARRETS_HUMAINS)

  if (bloquant) {
    return echec('human_request', 'Un arrêt non levé bloque cet objectif.')
  }

  return { ok: true, reason: null, detail: null }
}

/**
 * Piétinement : N tentatives consécutives sans preuve neuve. Une tentative
 * EMPÊCHÉE n'a pas essayé — permissions refusées, plafond d'usage, sonde de
 * diagnostic — et ne compte pas. Les compter faisait accuser la méthode alors
 * que rien n'avait été tenté.
 */
export function pietine(objectifId, seuil = 2) {
  const db = base()
  const recentes = db
    .prepare(
      `SELECT id FROM passages
       WHERE objective_id = ? AND ended_at IS NOT NULL AND prevented = 0
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(objectifId, seuil)

  if (recentes.length < seuil) return false

  return recentes.every(
    (p) =>
      db
        .prepare("SELECT COUNT(*) n FROM evidences WHERE passage_id = ? AND verdict = 'pass'")
        .get(p.id).n === 0,
  )
}
