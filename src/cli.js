#!/usr/bin/env node
import { startServer } from './server.js'
import { commands as agent, Refusal } from './agent/commands.js'
import { importData } from './db/import.js'
import { dbPath } from './db/index.js'
import { saveOauthApp } from './oauth.js'
import { fileURLToPath } from 'node:url'

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

  /**
   * Write the launchd files that bring the server and a worker back by themselves.
   *
   * `nohup … & disown` survives a closed terminal and nothing else: a reboot, a
   * crash or a laptop lid ends the loop, and the only sign is that nothing ran
   * overnight. launchd restarts a process that exits and starts it again at
   * login — which is the whole difference between "it runs" and "it keeps
   * running".
   *
   * It WRITES the files and does not load them. Installing a background service
   * on somebody's machine is a decision, and the command to take it is printed.
   *
   * usage: orchestrator service [--repo /path/to/a/repository]
   */
  async service() {
    const f = flags(args)
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const { join, resolve } = await import('node:path')

    const dir = join(homedir(), 'Library', 'LaunchAgents')
    mkdirSync(dir, { recursive: true })

    const node = process.execPath
    const cli = resolve(fileURLToPath(import.meta.url))
    const logs = join(homedir(), '.orchestrator')
    mkdirSync(logs, { recursive: true })

    const plist = (label, argv, cwd) =>
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>RunAtLoad</key><true/>
  <!-- Brought back when it exits, whatever the reason. -->
  <key>KeepAlive</key><true/>
  <!-- Not less: a process that fails instantly would otherwise be restarted in
       a tight loop, and the machine would carry that loop all night. -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${logs}/${label}.log</string>
  <key>StandardErrorPath</key><string>${logs}/${label}.log</string>
</dict>
</plist>
`

    const written = []
    const serverLabel = 'io.orchestrator.server'
    writeFileSync(join(dir, `${serverLabel}.plist`), plist(serverLabel, [node, cli, 'serve'], homedir()))
    written.push(serverLabel)

    const repo = f.repo ? resolve(String(f.repo)) : null
    if (repo) {
      const name = repo.split('/').filter(Boolean).pop()
      const workerLabel = `io.orchestrator.worker.${name.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`
      writeFileSync(
        join(dir, `${workerLabel}.plist`),
        plist(workerLabel, [node, cli, 'work', '--every', '5'], repo),
      )
      written.push(workerLabel)
    }

    console.log(`\n  written to ${dir}:`)
    for (const l of written) console.log(`    ${l}.plist`)
    console.log('\n  Nothing is running yet — loading a background service is your decision.')
    console.log('  To start them now and at every login:')
    for (const l of written) console.log(`    launchctl bootstrap gui/$(id -u) ${join(dir, l + '.plist')}`)
    console.log('\n  To stop one for good:')
    for (const l of written) console.log(`    launchctl bootout gui/$(id -u)/${l}`)
    if (!repo) console.log('\n  For a worker too: orchestrator service --repo /path/to/the/repository')
    console.log('')
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
try {
  await fn(...args)
} catch (e) {
  // A refusal is a usage message, not a crash: it prints alone, without a stack.
  if (e instanceof Refusal) {
    console.error(e.message)
    process.exit(1)
  }
  throw e
}
