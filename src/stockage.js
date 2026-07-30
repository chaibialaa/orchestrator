import { createSign, createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

/**
 * Envoi des preuves vers un stockage distant, pour qu'un coéquipier puisse les
 * lire sans avoir le dépôt.
 *
 * Volontairement SANS OAuth : un flux d'autorisation exige un navigateur et un
 * humain à chaque expiration, ce qui est l'inverse d'un outil qui travaille la
 * nuit. On utilise donc un compte de service Google — dont on signe soi-même
 * le jeton — et un jeton d'application Dropbox. Rien à réautoriser.
 */

const MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
}

const mimeDe = (chemin) => MIMES[extname(chemin).toLowerCase()] ?? 'application/octet-stream'

export const empreinteFichier = (chemin) =>
  createHash('sha256').update(readFileSync(chemin)).digest('hex')

// ---- Google Drive ---------------------------------------------------------

const base64url = (b) => Buffer.from(b).toString('base64url')

/**
 * Un jeton d'accès signé localement à partir de la clé du compte de service.
 * Pas de bibliothèque, pas de redirection : on signe un JWT et on l'échange.
 */
async function jetonGoogle(cle) {
  const maintenant = Math.floor(Date.now() / 1000)
  const entete = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const corps = base64url(
    JSON.stringify({
      iss: cle.client_email,
      scope: 'https://www.googleapis.com/auth/drive.file',
      aud: 'https://oauth2.googleapis.com/token',
      iat: maintenant,
      exp: maintenant + 3600,
    }),
  )

  const signature = createSign('RSA-SHA256').update(`${entete}.${corps}`).sign(cle.private_key, 'base64url')

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${entete}.${corps}.${signature}`,
    }),
  })

  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.access_token) {
    throw new Error(
      `Google refuse la clé du compte de service : ${d.error_description ?? d.error ?? res.status}`,
    )
  }
  return d.access_token
}

/**
 * Crée le dossier de dépôt et le partage avec l'humain, pour qu'il le voie
 * dans « Partagés avec moi ». Lui demander de le créer à la main était
 * paresseux : l'intégration en est parfaitement capable.
 */
export async function creerDossierDrive(cle, { nom = 'Orchestrator — Preuves', partagerAvec = null } = {}) {
  const jeton = await jetonGoogle(cle)

  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nom, mimeType: 'application/vnd.google-apps.folder' }),
  })

  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.id) {
    throw new Error(`Drive refuse de créer le dossier : ${d.error?.message ?? res.status}`)
  }

  // Sans ce partage, le dossier existe mais reste invisible : il appartient au
  // compte de service, qui n'a pas d'interface. Un échec ici n'annule rien.
  let partage = null
  if (partagerAvec) {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${d.id}/permissions?sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: partagerAvec }),
      },
    )
    const rd = await r.json().catch(() => ({}))
    partage = r.ok ? partagerAvec : `échec du partage : ${rd.error?.message ?? r.status}`
  }

  // Un dossier ne consomme pas de quota, un fichier si. Sans cette sonde, on
  // rendait un dossier « prêt » dans lequel rien ne pourra jamais entrer —
  // vérifié : `storageQuotaExceeded` au premier envoi. On teste donc tout de
  // suite, et on nettoie derrière nous plutôt que de laisser un piège.
  const sonde = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'multipart/related; boundary=probe' },
      body:
        `--probe\r\nContent-Type: application/json\r\n\r\n` +
        JSON.stringify({ name: '.orchestrator-probe', parents: [d.id] }) +
        `\r\n--probe\r\nContent-Type: text/plain\r\n\r\nok\r\n--probe--\r\n`,
    },
  )
  const sd = await sonde.json().catch(() => ({}))

  if (!sonde.ok) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${d.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jeton}` },
    }).catch(() => {})

    const m = sd.error?.message ?? String(sonde.status)
    throw new Error(
      /quota/i.test(m)
        ? "Un compte de service n'a pas de quota Drive : il peut créer un dossier, jamais y déposer " +
          `un fichier. Crée le dossier dans TON Drive, partage-le avec ${cle.client_email} en droit ` +
          "d'éditeur, et colle son identifiant — la fin de son URL après /folders/."
        : `Drive refuse d'écrire dans le dossier créé : ${m}`,
    )
  }

  if (sd.id) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${sd.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jeton}` },
    }).catch(() => {})
  }

  return { id: d.id, nom: d.name, url: d.webViewLink, partage }
}

async function envoyerDrive({ credentials, target }, chemin) {
  const cle = typeof credentials === 'string' ? JSON.parse(credentials) : credentials
  if (!cle?.client_email || !cle?.private_key) {
    throw new Error("La clé de compte de service Google est incomplète : il manque client_email ou private_key.")
  }
  if (!target) {
    throw new Error("Aucun dossier Drive visé — lance « préparer le dossier » avant d'envoyer.")
  }

  const jeton = await jetonGoogle(cle)
  const octets = readFileSync(chemin)
  const limite = `----orchestrator${Date.now()}`

  const corps = Buffer.concat([
    Buffer.from(
      `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: basename(chemin), parents: [target] }) +
        `\r\n--${limite}\r\nContent-Type: ${mimeDe(chemin)}\r\n\r\n`,
    ),
    octets,
    Buffer.from(`\r\n--${limite}--\r\n`),
  ])

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jeton}`,
        'Content-Type': `multipart/related; boundary=${limite}`,
      },
      body: corps,
    },
  )

  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.id) {
    const m = d.error?.message ?? String(res.status)
    // La panne attendue avec un compte de service : il n'a pas de quota propre.
    // Le dire, plutôt que de renvoyer un code brut que personne ne sait lire.
    if (/quota/i.test(m)) {
      throw new Error(
        "Le compte de service n'a pas de quota de stockage Drive. Deux issues : partager un dossier " +
          `de TON Drive avec ${cle.client_email} en droit d'éditeur et coller son identifiant, ` +
          'ou utiliser un Drive partagé Workspace.',
      )
    }
    throw new Error(`Drive refuse l'envoi : ${m}`)
  }

  return { remote_id: d.id, remote_url: d.webViewLink ?? `https://drive.google.com/file/d/${d.id}/view` }
}

// ---- Dropbox --------------------------------------------------------------

async function envoyerDropbox({ credentials, target }, chemin) {
  const jeton = typeof credentials === 'string' ? JSON.parse(credentials)?.token : credentials?.token
  if (!jeton) throw new Error("Aucun jeton d'application Dropbox n'est enregistré.")

  const dossier = (target ?? '/Orchestrator').replace(/\/+$/, '')
  const distant = `${dossier}/${basename(chemin)}`

  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jeton}`,
      'Content-Type': 'application/octet-stream',
      // `overwrite` et non `add` : renvoyer deux fois la même preuve ne doit
      // pas créer « fichier (1) », « fichier (2) » et rendre le dossier illisible.
      'Dropbox-API-Arg': JSON.stringify({ path: distant, mode: 'overwrite', mute: true }),
    },
    body: readFileSync(chemin),
  })

  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.id) {
    throw new Error(`Dropbox refuse l'envoi : ${d.error_summary ?? res.status}`)
  }

  // Un lien partageable, s'il est autorisé. On n'échoue pas s'il ne l'est
  // pas : le fichier est déposé, c'est l'essentiel.
  let url = null
  try {
    const l = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: d.path_lower }),
    })
    const dl = await l.json().catch(() => ({}))
    url = dl.url ?? dl.error?.shared_link_already_exists?.metadata?.url ?? null
  } catch {
    /* le lien est un confort, pas la preuve */
  }

  return { remote_id: d.id, remote_url: url }
}

// ---- surface commune ------------------------------------------------------

const PILOTES = { gdrive: envoyerDrive, dropbox: envoyerDropbox }

export async function envoyer(stockage, chemin) {
  const pilote = PILOTES[stockage.provider]
  if (!pilote) throw new Error(`Stockage inconnu : ${stockage.provider}`)

  const st = statSync(chemin)
  if (!st.isFile()) throw new Error(`Pas un fichier : ${chemin}`)
  if (st.size > 100 * 1024 * 1024) {
    throw new Error(`${basename(chemin)} pèse ${Math.round(st.size / 1048576)} Mo — au-delà de 100 Mo, on ne l'envoie pas.`)
  }

  const r = await pilote(stockage, chemin)
  return { ...r, octets: st.size, sha256: empreinteFichier(chemin) }
}

/** Une vérification qui ne dépose rien : le stockage répond-il, et où ? */
export async function verifier(stockage) {
  if (stockage.provider === 'gdrive') {
    const cle = typeof stockage.credentials === 'string' ? JSON.parse(stockage.credentials) : stockage.credentials
    const jeton = await jetonGoogle(cle)
    if (!stockage.target) {
      return { status: 'refused', detail: `Clé valide, mais aucun dossier visé. Partage un dossier avec ${cle.client_email}.` }
    }
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${stockage.target}?fields=id,name&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${jeton}` } },
    )
    const d = await res.json().catch(() => ({}))
    return res.ok
      ? { status: 'ok', detail: `dossier « ${d.name} » accessible` }
      : {
          status: 'refused',
          detail:
            d.error?.message?.includes('not found')
              ? `Dossier introuvable — as-tu partagé le dossier avec ${cle.client_email} ?`
              : (d.error?.message ?? `erreur ${res.status}`),
        }
  }

  const jeton = typeof stockage.credentials === 'string' ? JSON.parse(stockage.credentials)?.token : stockage.credentials?.token
  const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jeton}` },
  })
  const d = await res.json().catch(() => ({}))
  return res.ok
    ? { status: 'ok', detail: `compte ${d.email ?? d.name?.display_name ?? 'connecté'}` }
    : { status: 'refused', detail: d.error_summary ?? `erreur ${res.status}` }
}
