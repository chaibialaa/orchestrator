/**
 * Le relais — pont entre une conversation ChatGPT et les harnais locaux.
 *
 * Passe par le protocole DevTools de Chrome, sur l'onglet déjà ouvert et
 * déjà authentifié de l'utilisateur. Rien n'est stocké, rien n'est envoyé
 * ailleurs que dans la conversation désignée.
 *
 * IMPORTANT — frontière de confiance : ce que dit GPT est une DEMANDE de
 * travail, jamais une commande à exécuter. Le texte part vers un harnais
 * de code, qui reste soumis au rayon de souffle, au pack de règles et à
 * la porte de preuve. Le relais ne court-circuite aucune garde.
 */

const CDP_PORT = 9222

async function cdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

/** Ouvre une session DevTools sur l'onglet dont l'URL contient `match`. */
export async function attach(match, port = CDP_PORT) {
  let targets
  try {
    targets = await cdpTargets(port)
  } catch {
    throw new Error(
      `Chrome n'écoute pas sur le port ${port}.\n` +
        `  Relancer Chrome avec :  open -a "Google Chrome" --args --remote-debugging-port=${port}`,
    )
  }

  const tab = targets.find((t) => t.type === 'page' && t.url.includes(match))
  if (!tab) {
    const pages = targets.filter((t) => t.type === 'page').map((t) => t.url.slice(0, 70))
    throw new Error(`aucun onglet ne correspond à « ${match} ».\n  Onglets ouverts :\n    ${pages.join('\n    ')}`)
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((ok, ko) => {
    ws.addEventListener('open', ok, { once: true })
    ws.addEventListener('error', () => ko(new Error('connexion DevTools refusée')), { once: true })
  })

  let seq = 0
  const pending = new Map()

  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    const resolve = pending.get(msg.id)
    if (resolve) {
      pending.delete(msg.id)
      resolve(msg)
    }
  })

  // Le délai est réglable par appel : rapatrier une image de plusieurs
  // mégaoctets en base64 depuis la page prend bien plus que trente secondes,
  // et échouer là-dessus perdrait un rendu déjà produit et déjà payé.
  const send = (method, params = {}, delai = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} sans réponse après ${delai / 1000} s`))
      }, delai)
    })

  const evaluate = async (expression, { delai = 30000 } = {}) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      delai,
    )
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.text ?? 'erreur JS dans la page')
    }
    return r.result?.result?.value
  }

  return { evaluate, url: tab.url, close: () => ws.close() }
}

/** Le dernier message de l'assistant, tel qu'affiché. */
export const JS_LAST_ASSISTANT = `
(() => {
  const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!nodes.length) return null;
  const last = nodes[nodes.length - 1];
  return last.innerText.trim();
})()
`

/**
 * Vrai tant que la réponse est en cours de génération.
 *
 * On ne se fie PAS au libellé du bouton d'arrêt : il est traduit selon la
 * langue de l'interface, et un sélecteur qui ne matche jamais fait croire
 * que la génération est finie dès le premier caractère.
 */
export const JS_IS_STREAMING = `
(() => {
  if (document.querySelector('[data-testid="stop-button"]')) return true;
  const composerButtons = document.querySelectorAll('form button, main button');
  for (const b of composerButtons) {
    const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
    if (/stop|arrêt|arret|detener|anhalten/i.test(label)) return true;
  }
  return false;
})()
`

/**
 * Attente robuste : le texte a cessé de bouger.
 * Indépendante de l'interface — c'est le seul signal qui ne se traduit pas.
 */
export async function waitForStable(page, { quietMs = 4000, maxMs = 300000, minLength = 40 } = {}) {
  const started = Date.now()
  let last = null
  let stableSince = null
  let reloaded = false

  while (Date.now() - started < maxMs) {
    const now = await page.evaluate(JS_LAST_ASSISTANT)

    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (stableSince && Date.now() - stableSince >= quietMs) {
      const streaming = await page.evaluate(JS_IS_STREAMING)

      if (!streaming) {
        // Le rendu de ChatGPT cale parfois sur quelques caractères alors
        // que la réponse est complète côté serveur. Un rechargement tranche.
        if (!reloaded && (last ?? '').length < minLength) {
          reloaded = true
          await page.evaluate('location.reload()')
          await new Promise((r) => setTimeout(r, 9000))
          last = null
          stableSince = null
          continue
        }

        // On ne rend JAMAIS un fragment. Une réponse de 18 caractères a été
        // prise pour complète, la boucle y a lu un « #24 » et s'est arrêtée
        // sur un objectif inventé — alors que GPT écrivait encore. Mieux vaut
        // attendre en vain que d'agir sur une phrase coupée.
        if ((last ?? '').length < minLength) {
          stableSince = null
          await new Promise((r) => setTimeout(r, 3000))
          continue
        }

        return last
      }

      stableSince = Date.now()
    }

    await new Promise((r) => setTimeout(r, 1000))
  }

  return last
}

/**
 * Vérifie qu'un texte est bien arrivé comme dernier message utilisateur.
 * Le retour de l'évaluation se perd quand la page bouge après le clic :
 * on ne se fie donc pas à lui, on constate le résultat.
 */
/**
 * Confirme qu'un message est bien parti. On ne compare PAS le texte brut :
 * l'interface rend le markdown, donc « ## Tour 1 » s'affiche « Tour 1 » et une
 * comparaison de préfixe échoue toujours. On cherche une signature de mots,
 * débarrassée de tout ce que le rendu peut changer.
 */
const signature = (t) =>
  String(t)
    .replace(/[#*`_>\-\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

export async function confirmPosted(page, text) {
  // Un fragment du DÉBUT, et seulement du début. L'interface replie les longs
  // messages derrière « Afficher plus » : sur un compte rendu de 9 000
  // caractères, seuls ~700 sont dans le DOM. Chercher au milieu, comme je le
  // faisais, ne trouvait jamais rien et la boucle s'arrêtait sur une fausse
  // alerte alors que le message était bien parti.
  const brut = signature(text)
  const debut = Math.min(20, Math.max(0, brut.length - 40))
  const marque = JSON.stringify(brut.slice(debut, debut + 60))
  if (marque.length < 12) return true

  for (let i = 0; i < 10; i++) {
    const ok = await page
      .evaluate(`
        (() => {
          const n = document.querySelectorAll('[data-message-author-role="user"]');
          if (!n.length) return false;
          const vu = n[n.length - 1].innerText
            .replace(/[#*\`_>\\-\\[\\]()]/g, ' ')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase();
          return vu.includes(${marque});
        })()
      `)
      .catch(() => false)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

/**
 * Joint des fichiers au message en cours de rédaction.
 *
 * Sans ça, la conversation juge sur une phrase de compte rendu — c'est-à-dire
 * sur la parole de l'exécutant. Un verdict visuel exige de voir le rendu.
 */
export async function attachFiles(page, fichiers) {
  if (!fichiers.length) return 0

  const charge = fichiers.map((f) => ({
    nom: f.nom,
    type: f.type,
    b64: f.b64,
  }))

  const r = await page.evaluate(`
(async () => {
  const fichiers = ${JSON.stringify(charge)};
  const input = document.querySelector('input[type=file]');
  if (!input) return 'aucun champ fichier';

  const dt = new DataTransfer();
  for (const f of fichiers) {
    const bin = atob(f.b64);
    const oct = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) oct[i] = bin.charCodeAt(i);
    dt.items.add(new File([oct], f.nom, { type: f.type }));
  }

  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 2500));
  return String(dt.files.length);
})()
  `)

  return Number(r) || 0
}

/** Dépose un texte dans le composeur et l'envoie. */
export function jsPost(text) {
  const payload = JSON.stringify(text)
  return `
(async () => {
  const box = document.querySelector('#prompt-textarea')
    ?? document.querySelector('div[contenteditable="true"]')
    ?? document.querySelector('textarea');
  if (!box) return 'composeur introuvable';

  box.focus();
  const value = ${payload};

  if (box.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    box.innerHTML = '';
    for (const line of value.split('\\n')) {
      const p = document.createElement('p');
      p.textContent = line.length ? line : '';
      box.appendChild(p);
    }
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  await new Promise(r => setTimeout(r, 400));

  // Le bouton reste désactivé tant qu'un fichier est en cours de téléversement.
  for (let i = 0; i < 40; i++) {
    const b = document.querySelector('[data-testid="send-button"]');
    if (b && !b.disabled) break;
    await new Promise(r => setTimeout(r, 500));
  }

  const send = document.querySelector('[data-testid="send-button"]')
    ?? document.querySelector('button[aria-label*="Send"]')
    ?? document.querySelector('button[aria-label*="Envoyer"]');
  if (!send) return 'bouton envoyer introuvable';
  if (send.disabled) return 'bouton envoyer désactivé';
  send.click();
  return 'ok';
})()
`
}

/**
 * Extrait une consigne adressée à un harnais.
 * Format attendu dans la réponse de GPT :  @codex: … ou @claude: …
 */
/**
 * Le verdict que la conversation prononce sur un objectif.
 * Formats acceptés :  #14 validé   ·   #14 refusé   ·   valide #14
 */
/**
 * Lit un verdict dans une réponse.
 *
 * On prend le PREMIER verdict du texte, pas le premier motif trouvé : chercher
 * l'acceptation sur tout le message avant de chercher le refus faisait gagner
 * un « satisfait » de la ligne 200 contre un « #11 refusé » de la ligne 1. Le
 * juge prononce son verdict en tête, puis explique — c'est la tête qui compte.
 *
 * `attendu` permet de viser un objectif précis : quand on demande le verdict du
 * chapitre #11, un verdict sur #12 dans le même message ne répond pas.
 */
export function parseVerdict(text, { attendu = null } = {}) {
  if (!text) return null

  // Le marqueur explicite prime sur toute lecture en prose. Déduire un verdict
  // d'une phrase, c'est deviner ; `@verdict: #11 refusé` ne se devine pas.
  // Tant que le juge le pose, il n'y a plus rien à interpréter.
  // `\w` ne couvre pas les accents : « valid\w* » s'arrête avant le é de
  // « validé ». Le code le documentait déjà pour `\b` ; le piège est le même.
  const mot = '(valid|accept|refus|rejet)[a-zà-ÿ]*'
  const marque =
    new RegExp(`@verdict\\s*:?\\s*#?(\\d+)\\s+${mot}`, 'i').exec(text) ??
    new RegExp(`@verdict\\s*:?\\s*${mot}\\s+#?(\\d+)`, 'i').exec(text)

  if (marque) {
    const [id, mot] = /^\d+$/.test(marque[1]) ? [marque[1], marque[2]] : [marque[2], marque[1]]
    const decision = /^(valid|accept)/i.test(mot) ? 'accept' : 'reject'
    if (attendu != null && Number(id) !== Number(attendu)) return null
    return { id: Number(id), decision, explicite: true }
  }

  // \b ne fonctionne pas après un accent : on borne explicitement.
  const fin = '(?![a-zà-ÿ])'
  const oui = `(?:validé|valide|accepté|accepte|conforme|atteint|satisfait)${fin}`
  const non = `(?:refusé|refuse|rejeté|rejete|insuffisant|non conforme)${fin}`

  const trouves = []
  for (const [decision, verbes] of [
    ['accept', oui],
    ['reject', non],
  ]) {
    for (const motif of [`#(\\d+)[^.\\n]{0,40}?${verbes}`, `${verbes}[^.\\n]{0,30}?#(\\d+)`]) {
      for (const m of text.matchAll(new RegExp(motif, 'gi'))) {
        trouves.push({ id: Number(m[1]), decision, ou: m.index ?? 0 })
      }
    }
  }

  if (!trouves.length) return null
  trouves.sort((a, b) => a.ou - b.ou)

  if (attendu != null) {
    const vise = trouves.find((v) => v.id === Number(attendu))
    return vise ? { id: vise.id, decision: vise.decision } : null
  }

  return { id: trouves[0].id, decision: trouves[0].decision }
}

export function parseDirective(text) {
  if (!text) return null

  const re = /@(codex|claude)\s*:\s*([\s\S]+?)(?=\n@(?:codex|claude)\s*:|$)/i
  const m = text.match(re)
  if (!m) return null

  return { harness: m[1].toLowerCase(), task: m[2].trim() }
}

/**
 * Le juge déclare-t-il le travail terminé ? Sans marqueur, « Le chapitre est
 * terminé. » ne se distingue pas d'un commentaire, et la boucle réclamait une
 * consigne en boucle alors qu'on venait de lui dire qu'il n'y en aurait plus.
 */
export function parseFini(text) {
  if (!text) return null
  const m = /@fini\s*:?\s*(?:#?(\d+))?([^\n]*)/i.exec(text)
  if (!m) return null
  return { id: m[1] ? Number(m[1]) : null, raison: (m[2] ?? '').trim() || null }
}
