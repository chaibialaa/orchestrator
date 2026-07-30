#!/usr/bin/env node
import { startServer } from './server.js'
import { commands as agent } from './agent/commands.js'
import { importData } from './db/import.js'
import { dbPath } from './db/index.js'
import { saveOauthApp } from './oauth.js'

const [commande, ...args] = process.argv.slice(2)

const flags = (a) => {
  const o = {}
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue
    const k = a[i].slice(2)
    o[k] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true
  }
  return o
}

const commandes = {
  async serve() {
    const f = flags(args)
    const { serveur, port } = await startServer(Number(f.port ?? process.env.PORT ?? 4747))
    // Les agents travaillent longtemps entre deux appels : fermer la connexion
    // au bout de cinq secondes leur garantissait un EPIPE au retour.
    serveur.keepAliveTimeout = 10 * 60 * 1000
    serveur.headersTimeout = 11 * 60 * 1000
    console.log(`\n  orchestrator — http://localhost:${port}`)
    console.log(`  base : ${dbPath()}\n`)
  },

  async import() {
    const file = args.find((a) => !a.startsWith('--'))
    if (!file) {
      console.error('usage: orchestrator import <donnees.json>')
      process.exit(1)
    }
    const outcome = importData(file)
    console.log('\n  import finished:')
    for (const [t, n] of Object.entries(outcome)) console.log(`    ${t.padEnd(14)} ${n}`)
    console.log(`\n  base : ${dbPath()}\n`)
  },

  /**
   * The identity of the OAuth app. It goes through the command line rather than
   * the screen: the `client_secret` must cross neither the database, nor the
   * repository, nor a conversation. It lands in ~/.orchestrator/oauth.json,
   * mode 0600, next to the encryption secret.
   */
  async 'oauth:set'() {
    const [provider, id, secret] = args.filter((a) => !a.startsWith('--'))
    if (!provider || !id || !secret) {
      console.error('usage: orchestrator oauth:set <google|dropbox> <client_id> <client_secret>')
      process.exit(1)
    }
    const path = saveOauthApp(provider, id, secret)
    console.log(`\n  app “${provider}” saved in ${path}`)
    console.log('  redirect URI to declare with the provider:')
    console.log(`    http://localhost:${process.env.PORT ?? 4747}/api/storages/oauth/callback\n`)
  },

  async where() {
    console.log(dbPath())
  },
}

// The agent commands — the loop, the breakdown, the scans — live in the same
// package: one install, one command.
const fn = commandes[commande] ?? agent[commande]
if (!fn) {
  console.log('orchestrator — server :', Object.keys(commandes).join(', '))
  console.log('               agent  :', Object.keys(agent).join(', '))
  process.exit(commande ? 1 : 0)
}
await fn(...args)
