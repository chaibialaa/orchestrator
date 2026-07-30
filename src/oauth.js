import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Delegated authorisation: everyone connects THEIR own account.
 *
 * The argument that ruled OAuth out at first — "an authorisation flow needs a
 * browser and a human at every expiry" — was wrong. You authorise once, we keep
 * a refresh token, and everything after that runs with nobody there. And above
 * all: a service account has no Drive quota, so it can deposit NOTHING.
 * Delegation is not a convenience, it is the only path that works — and the only
 * one that does not force a whole team through one person's account.
 */

const PROVIDERS = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    // `drive.file` grants access ONLY to files the tool creates itself: it cannot
    // read the person's Drive. That is also what avoids Google's review of
    // sensitive scopes.
    scope: 'https://www.googleapis.com/auth/drive.file',
    // Without `prompt=consent`, a re-authorisation returns a code with NO
    // refresh_token — Google only gives it on the first consent. The connection
    // would look successful and die within the hour.
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  dropbox: {
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    token: 'https://api.dropboxapi.com/oauth2/token',
    scope: null,
    // Dropbox's equivalent of `access_type=offline`: without it we get a
    // four-hour token and nothing to renew it with.
    extra: { token_access_type: 'offline' },
  },
}

export const PROVIDER_OF = { gdrive: 'google', dropbox: 'dropbox' }

function oauthFilePath() {
  return process.env.ORCHESTRATOR_OAUTH_FILE ?? join(homedir(), '.orchestrator', 'oauth.json')
}

/**
 * The identity of the APPLICATION (client_id/client_secret), not of any person.
 * It lives outside the database and outside the repository: the code goes to
 * GitHub, this file does not.
 */
export function oauthApp(provider) {
  const path = oauthFilePath()
  if (!existsSync(path)) {
    throw new Error(
      `No OAuth app registered. Create a client in the provider's console, ` +
        `puis : node src/cli.js oauth:set ${provider} <client_id> <client_secret>`,
    )
  }
  const tout = JSON.parse(readFileSync(path, 'utf8'))
  const a = tout[provider]
  if (!a?.client_id || !a?.client_secret) {
    throw new Error(`The OAuth app “${provider}” is not filled in inside ${path}.`)
  }
  return a
}

export function saveOauthApp(provider, client_id, client_secret) {
  if (!PROVIDERS[provider]) throw new Error(`Unknown provider: ${provider}.`)
  const path = oauthFilePath()
  mkdirSync(dirname(path), { recursive: true })
  const tout = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  tout[provider] = { client_id, client_secret }
  writeFileSync(path, JSON.stringify(tout, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export const oauthAppPresent = (provider) => {
  try {
    oauthApp(provider)
    return true
  } catch {
    return false
  }
}

/**
 * The requests in flight. A single-use, dated `state`: without it, any page at
 * all could replay an authorisation callback against this server.
 */
const pendingAuths = new Map()
const PENDING_TTL = 15 * 60 * 1000

export function openPendingAuth(payload) {
  const state = randomBytes(24).toString('base64url')
  pendingAuths.set(state, { ...payload, ne: Date.now() })
  for (const [k, v] of pendingAuths) if (Date.now() - v.ne > PENDING_TTL) pendingAuths.delete(k)
  return state
}

export function closePendingAuth(state) {
  const a = pendingAuths.get(state)
  pendingAuths.delete(state)
  if (!a) return null
  return Date.now() - a.ne > PENDING_TTL ? null : a
}

export function consentUrl(provider, { redirect, state }) {
  const f = PROVIDERS[provider]
  if (!f) throw new Error(`Unknown provider: ${provider}.`)
  const { client_id } = oauthApp(provider)

  const p = new URLSearchParams({
    client_id,
    redirect_uri: redirect,
    response_type: 'code',
    state,
    ...f.extra,
  })
  if (f.scope) p.set('scope', f.scope)
  return `${f.authorizeUrl}?${p}`
}

export async function exchangeCode(provider, { code, redirect }) {
  const f = PROVIDERS[provider]
  const { client_id, client_secret } = oauthApp(provider)

  const res = await fetch(f.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id,
      client_secret,
      redirect_uri: redirect,
    }),
  })

  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.access_token) {
    throw new Error(`Code exchange refused: ${d.error_description ?? d.error ?? res.status}`)
  }
  if (!d.refresh_token) {
    // Telling this apart from success is critical: an access token with no
    // refresh works for an hour, then the overnight loop stops for no readable
    // reason.
    throw new Error(
      "The authorisation returned no refresh token. Revoke the app's access in your account " +
        'settings, then reconnect: without it, the connection would expire within the hour.',
    )
  }
  return { refresh_token: d.refresh_token, access_token: d.access_token }
}

/** A fresh access token from the refresh token. Nobody in the loop. */
export async function refreshAccess(provider, refresh_token) {
  const f = PROVIDERS[provider]
  if (!f) throw new Error(`Unknown provider: ${provider}.`)
  const { client_id, client_secret } = oauthApp(provider)

  const res = await fetch(f.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id, client_secret }),
  })

  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.access_token) {
    const m = d.error_description ?? d.error ?? res.status
    // The case worth naming: in "testing" mode, Google revokes tokens after
    // seven days. A raw message would send someone hunting a bug that is not there.
    throw new Error(
      /invalid_grant/i.test(String(m))
        ? 'The authorisation was revoked or expired — you have to reconnect. ' +
          '(A Google app still in "testing" mode revokes tokens after 7 days: ' +
          'publishing it settles the problem for good.)'
        : `Renewal refused: ${m}`,
    )
  }
  return d.access_token
}

/** Who this account belongs to — derived from the token, never typed by hand. */
export async function accountOf(provider, access_token) {
  if (provider === 'google') {
    // `about` is enough and fits inside the `drive.file` scope: asking for
    // `openid email` on top would grow the consent screen for nothing.
    const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { Authorization: `Bearer ${access_token}` },
    })
    const d = await r.json().catch(() => ({}))
    return d.user?.emailAddress ?? null
  }

  const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}` },
  })
  const d = await r.json().catch(() => ({}))
  return d.email ?? d.name?.display_name ?? null
}
