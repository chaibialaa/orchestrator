import { execFileSync } from 'node:child_process'

/**
 * Le dernier recours quand la conversation n'a pas mis de marqueur.
 *
 * Règle absolue : **l'interprète décide et délimite, il ne réécrit jamais.**
 * Il rend des positions dans le texte ; on découpe soi-même. La mission qui
 * part au harnais est donc toujours, au caractère près, celle que le juge a
 * écrite — sinon on perdrait la seule chose qui permet de trancher entre
 * « l'ordre était mauvais » et « l'exécution était mauvaise ».
 *
 * Un interprète qui rédigerait pourrait inventer un ordre que personne n'a
 * donné. Dans un outil qui travaille sans surveillance, c'est le pire défaut
 * possible — pire que de ne rien faire.
 */

const SCHEMA = `{"type":"aucun"|"mission"|"fini"|"question","harnais":"claude"|"codex"|null,"debut":<entier>,"fin":<entier>,"pourquoi":"<une phrase>"}`

export function interpreter(message, { modele = 'claude' } = {}) {
  if (!message || message.length < 15) return { type: 'aucun', pourquoi: 'message trop court' }

  // On numérote les lignes : demander des positions de caractères à un modèle
  // donne des bornes fausses ; des numéros de ligne, il les compte juste.
  const lignes = message.split('\n')
  const numerote = lignes.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n')

  const consigne = [
    "Tu lis la dernière réponse d'une conversation qui pilote des agents de développement.",
    'Ton seul travail est de dire ce que cette réponse EST, et où se trouve la consigne le cas échéant.',
    '',
    'Tu ne réécris rien. Tu ne résumes rien. Tu rends des numéros de ligne.',
    '',
    'Les types possibles :',
    '- "mission" : la réponse contient un ordre de travail à exécuter par un agent ;',
    '- "fini" : elle dit que le travail ou le chapitre est terminé, sans donner de nouvel ordre ;',
    '- "question" : elle demande quelque chose à l’humain au lieu de donner un ordre ;',
    '- "aucun" : elle ne contient ni ordre, ni fin, ni question — commentaire, verdict seul, hésitation.',
    '',
    'Si le type est "mission" :',
    "- `harnais` = celui qui doit l'exécuter, s'il est nommé (claude ou codex), sinon null ;",
    '- `debut` et `fin` = première et dernière ligne de la consigne, bornes incluses ;',
    "- prends la consigne ENTIÈRE : lectures obligatoires, interdictions, barème, livrables. Pas seulement son titre.",
    '',
    'Sinon, `debut` et `fin` valent 0.',
    '',
    `Réponds UNIQUEMENT par cet objet JSON, sans texte autour : ${SCHEMA}`,
    '',
    '--- RÉPONSE À CLASSER ---',
    numerote,
    '--- FIN ---',
  ].join('\n')

  let brut
  try {
    brut = execFileSync(modele, ['-p', consigne, '--disallowed-tools', 'Bash', 'Write', 'Edit'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ORCHESTRATOR_MANAGED: '1' },
    })
  } catch (e) {
    return { type: 'aucun', pourquoi: `interprète indisponible : ${String(e.message).slice(0, 120)}` }
  }

  const lu = extraire(brut)
  if (!lu?.type) return { type: 'aucun', pourquoi: 'interprète inexploitable' }

  if (lu.type !== 'mission') {
    return { type: lu.type, pourquoi: lu.pourquoi ?? null }
  }

  // On borne AVANT de découper : un modèle qui rend « ligne 900 » sur un texte
  // de 40 lignes ne doit pas produire une mission vide qu'on croirait valide.
  const debut = Math.max(1, Math.min(Number(lu.debut) || 1, lignes.length))
  const fin = Math.max(debut, Math.min(Number(lu.fin) || lignes.length, lignes.length))
  const task = lignes.slice(debut - 1, fin).join('\n').trim()

  if (task.length < 40) {
    return { type: 'aucun', pourquoi: `bornes inexploitables (lignes ${debut}-${fin})` }
  }

  return {
    type: 'mission',
    harness: ['claude', 'codex'].includes(lu.harnais) ? lu.harnais : null,
    task,
    lignes: [debut, fin],
    pourquoi: lu.pourquoi ?? null,
  }
}

/** Le premier objet JSON de la réponse, quelles que soient les fioritures autour. */
function extraire(texte) {
  const t = String(texte ?? '').replace(/```(?:json)?/gi, '')
  const debut = t.indexOf('{')
  if (debut < 0) return null

  let profondeur = 0
  let chaine = false
  let echap = false

  for (let i = debut; i < t.length; i++) {
    const c = t[i]
    if (echap) {
      echap = false
      continue
    }
    if (c === '\\') {
      echap = true
      continue
    }
    if (c === '"') {
      chaine = !chaine
      continue
    }
    if (chaine) continue
    if (c === '{') profondeur++
    else if (c === '}' && --profondeur === 0) {
      try {
        return JSON.parse(t.slice(debut, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}
