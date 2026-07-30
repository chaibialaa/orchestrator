import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { attach } from './relay.js'

/**
 * Génération d'images par des interfaces web. C'est la pièce la plus fragile
 * de l'outil et il faut le dire : ces sites n'ont pas d'API, on pilote leur
 * page. Une refonte de leur interface casse l'adaptateur — pas silencieusement,
 * on s'en apercevra ici, mais elle le cassera.
 *
 * La stratégie est donc volontairement GÉNÉRIQUE plutôt que taillée sur mesure :
 * trouver le champ de saisie, envoyer, attendre une image qui n'était pas là,
 * la récupérer. Moins on dépend de sélecteurs précis, plus ça survit.
 */

export const ADAPTATEURS = {
  'nano-banana': {
    label: 'Nano Banana',
    url: 'https://gemini.google.com/app',
    match: 'gemini.google.com',
    // Ce qui compte comme un résultat : une image assez grande pour être
    // un rendu, pas un avatar ni une icône d'interface.
    tailleMin: 256,
  },
  'gpt-web': {
    label: 'GPT (web)',
    url: 'https://chatgpt.com/',
    match: 'chatgpt.com',
    tailleMin: 256,
  },
}

/** Le champ de saisie, cherché par ce que les interfaces de chat ont en commun. */
const JS_SAISIR = (texte) => `
(() => {
  const cible =
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('textarea:not([readonly]):not([disabled])') ||
    document.querySelector('[role="textbox"]');
  if (!cible) return 'aucun champ de saisie';

  cible.focus();
  const t = ${JSON.stringify(texte)};

  if (cible.tagName === 'TEXTAREA') {
    const poser = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    poser.call(cible, t);
    cible.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    cible.textContent = '';
    document.execCommand('insertText', false, t);
    if (!cible.textContent) {
      cible.textContent = t;
      cible.dispatchEvent(new InputEvent('input', { bubbles: true, data: t }));
    }
  }
  return 'ok';
})()`

const JS_ENVOYER = `
(() => {
  const cible =
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('textarea:not([readonly]):not([disabled])') ||
    document.querySelector('[role="textbox"]');
  if (!cible) return 'aucun champ';
  cible.focus();
  for (const type of ['keydown', 'keypress', 'keyup']) {
    cible.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
  }
  return 'envoyé';
})()`

/** Les images présentes, au-dessus d'une taille — pour comparer avant/après. */
const JS_IMAGES = (min) => `
(() => {
  const vues = [...document.images]
    .filter((i) => i.naturalWidth >= ${min} && i.naturalHeight >= 128)
    .map((i) => i.currentSrc || i.src)
    .filter((s) => s && !s.startsWith('data:image/svg'));
  return JSON.stringify([...new Set(vues)]);
})()`

/**
 * Rapatrie l'image DÉJÀ AFFICHÉE plutôt que de la retélécharger. Un `fetch`
 * sur une URL `blob:` créée par la page échoue — vérifié, « Failed to fetch » —
 * et de toute façon retélécharger, c'est risquer d'obtenir autre chose que ce
 * qu'on a vu. On peint l'élément sur un canevas et on lit les pixels.
 */
const JS_TELECHARGER = (src) => `
(async () => {
  try {
    const img = [...document.images].find((i) => (i.currentSrc || i.src) === ${JSON.stringify(src)});
    if (!img) return JSON.stringify({ erreur: "l'image a disparu de la page" });
    if (!img.complete) await img.decode();

    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);

    const url = c.toDataURL('image/png');
    return JSON.stringify({
      type: 'image/png',
      b64: url.slice(url.indexOf(',') + 1),
      largeur: c.width,
      hauteur: c.height,
    });
  } catch (e) {
    return JSON.stringify({ erreur: String(e).slice(0, 200) });
  }
})()`

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Demande une image et attend qu'elle apparaisse. Rend le chemin écrit.
 * Ne prétend jamais avoir réussi : sans image neuve, il le dit.
 */
export async function genererImage({
  outil = 'nano-banana',
  prompt,
  sortie,
  attenteMax = 240000,
  port,
} = {}) {
  const adaptateur = ADAPTATEURS[outil]
  if (!adaptateur) {
    throw new Error(`Outil d'image inconnu : ${outil}. Connus : ${Object.keys(ADAPTATEURS).join(', ')}`)
  }
  if (!prompt?.trim()) throw new Error('Prompt vide.')

  const page = await attach(adaptateur.match, port)

  const avant = new Set(JSON.parse(await page.evaluate(JS_IMAGES(adaptateur.tailleMin))))

  const saisie = await page.evaluate(JS_SAISIR(prompt))
  if (saisie !== 'ok') throw new Error(`${adaptateur.label} : ${saisie}`)
  await dormir(400)
  await page.evaluate(JS_ENVOYER)

  // On attend une image NEUVE et STABLE : les interfaces affichent souvent une
  // version basse définition avant la bonne. Conclure sur la première donnerait
  // une preuve dégradée sans que personne ne s'en aperçoive.
  const debut = Date.now()
  let candidate = null
  let stableDepuis = 0

  while (Date.now() - debut < attenteMax) {
    await dormir(2500)
    const maintenant = JSON.parse(await page.evaluate(JS_IMAGES(adaptateur.tailleMin)))
    const neuves = maintenant.filter((s) => !avant.has(s))

    if (!neuves.length) {
      candidate = null
      continue
    }

    const derniere = neuves.at(-1)
    if (derniere === candidate) {
      stableDepuis += 2500
      if (stableDepuis >= 5000) break
    } else {
      candidate = derniere
      stableDepuis = 0
    }
  }

  if (!candidate) {
    // Distinguer « rien n'est parti » de « il a répondu sans image » : le
    // second est un refus du service — quota, plan gratuit, modèle qui
    // commente au lieu de produire — et ça ne se corrige pas dans le code.
    const aRepondu = await page.evaluate(
      `(() => document.body.innerText.slice(-1200).includes(${JSON.stringify(prompt.slice(0, 40))}))()`,
    )
    throw new Error(
      aRepondu
        ? `${adaptateur.label} a bien reçu la demande mais n'a produit aucune image en ` +
          `${Math.round(attenteMax / 1000)} s. C'est un refus du service, pas une panne du pilote : ` +
          `quota atteint, plan gratuit, ou modèle qui a répondu en texte. Regarde l'onglet.`
        : `${adaptateur.label} : la demande n'est même pas partie. Vérifie que l'onglet est ouvert et connecté.`,
    )
  }

  // Une image lourde met du temps à traverser : on lui laisse le temps.
  const brut = JSON.parse(await page.evaluate(JS_TELECHARGER(candidate), { delai: 180000 }))
  if (brut.erreur) throw new Error(`Téléchargement impossible : ${brut.erreur}`)

  const octets = Buffer.from(brut.b64, 'base64')
  const chemin =
    sortie ?? `image-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`
  mkdirSync(dirname(chemin), { recursive: true })
  writeFileSync(chemin, octets)

  return { chemin, octets: octets.length, type: brut.type, largeur: brut.largeur, hauteur: brut.hauteur, source: candidate, outil }
}
