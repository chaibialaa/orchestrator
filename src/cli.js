#!/usr/bin/env node
import { servir } from './server.js'
import { commands as agent } from './agent/commandes.js'
import { importer } from './db/import.js'
import { cheminBase } from './db/index.js'

const [commande, ...args] = process.argv.slice(2)

const drapeaux = (a) => {
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
    const f = drapeaux(args)
    const { serveur, port } = await servir(Number(f.port ?? process.env.PORT ?? 4747))
    // Les agents travaillent longtemps entre deux appels : fermer la connexion
    // au bout de cinq secondes leur garantissait un EPIPE au retour.
    serveur.keepAliveTimeout = 10 * 60 * 1000
    serveur.headersTimeout = 11 * 60 * 1000
    console.log(`\n  orchestrator — http://localhost:${port}`)
    console.log(`  base : ${cheminBase()}\n`)
  },

  async import() {
    const fichier = args.find((a) => !a.startsWith('--'))
    if (!fichier) {
      console.error('usage: orchestrator import <donnees.json>')
      process.exit(1)
    }
    const bilan = importer(fichier)
    console.log('\n  reprise terminée :')
    for (const [t, n] of Object.entries(bilan)) console.log(`    ${t.padEnd(14)} ${n}`)
    console.log(`\n  base : ${cheminBase()}\n`)
  },

  async where() {
    console.log(cheminBase())
  },
}

// Les commandes de l'agent — la boucle, le découpage, les relevés — vivent
// dans le même paquet : une seule installation, une seule commande.
const fn = commandes[commande] ?? agent[commande]
if (!fn) {
  console.log('orchestrator — serveur   :', Object.keys(commandes).join(', '))
  console.log('               agent     :', Object.keys(agent).join(', '))
  process.exit(commande ? 1 : 0)
}
await fn(...args)
