import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * API keys encrypted at rest. The database must never hold a secret in the
 * clear: it gets copied, backed up, and shared by accident.
 *
 * The encryption secret lives beside it, in a file only its owner can read.
 * Copying the database without that file yields nothing usable.
 */
function secretPath() {
  return process.env.ORCHESTRATOR_KEY_FILE ?? join(homedir(), '.orchestrator', 'secret.key')
}

let key = null

function masterKey() {
  if (key) return key

  const path = secretPath()
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600 })
    chmodSync(path, 0o600)
  }

  key = scryptSync(readFileSync(path, 'utf8').trim(), 'orchestrator', 32)
  return key
}

export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', masterKey(), iv)
  const chiffre = Buffer.concat([c.update(String(plain), 'utf8'), c.final()])
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${chiffre.toString('base64url')}`
}

export function decrypt(stored) {
  if (!stored) return null
  const [v, iv, tag, body] = String(stored).split('.')
  if (v !== 'v1' || !iv || !tag || !body) return null
  try {
    const d = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64url'))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8')
  } catch {
    // Secret perdu ou base d'une autre machine : on ne devine pas, on le dit.
    return null
  }
}

/** What the screen is allowed to see of a key: that it exists, and how it ends. */
export function keyHint(stored) {
  const plain = decrypt(stored)
  return plain ? '••••••' + plain.slice(-4) : null
}
