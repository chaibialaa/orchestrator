import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Chiffrement des clés d'API au repos. La base ne doit jamais contenir un
 * secret en clair : elle se copie, se sauvegarde, se partage par mégarde.
 *
 * Le secret de chiffrement vit à côté, dans un fichier lisible par le seul
 * propriétaire. Copier la base sans lui ne donne rien d'exploitable.
 */
function cheminSecret() {
  return process.env.ORCHESTRATOR_KEY_FILE ?? join(homedir(), '.orchestrator', 'secret.key')
}

let cle = null

function cleMaitresse() {
  if (cle) return cle

  const chemin = cheminSecret()
  if (!existsSync(chemin)) {
    mkdirSync(dirname(chemin), { recursive: true })
    writeFileSync(chemin, randomBytes(32).toString('base64'), { mode: 0o600 })
    chmodSync(chemin, 0o600)
  }

  cle = scryptSync(readFileSync(chemin, 'utf8').trim(), 'orchestrator', 32)
  return cle
}

export function chiffrer(clair) {
  if (clair === null || clair === undefined || clair === '') return null
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', cleMaitresse(), iv)
  const chiffre = Buffer.concat([c.update(String(clair), 'utf8'), c.final()])
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${chiffre.toString('base64url')}`
}

export function dechiffrer(stocke) {
  if (!stocke) return null
  const [v, iv, tag, corps] = String(stocke).split('.')
  if (v !== 'v1' || !iv || !tag || !corps) return null
  try {
    const d = createDecipheriv('aes-256-gcm', cleMaitresse(), Buffer.from(iv, 'base64url'))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(corps, 'base64url')), d.final()]).toString('utf8')
  } catch {
    // Secret perdu ou base d'une autre machine : on ne devine pas, on le dit.
    return null
  }
}

/** Ce que l'écran a le droit de voir d'une clé : qu'elle existe, et sa fin. */
export function indice(stocke) {
  const clair = dechiffrer(stocke)
  return clair ? '••••••' + clair.slice(-4) : null
}
