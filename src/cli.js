#!/usr/bin/env node
import { createServer } from './server.js'
import { migrate } from './db/migrate.js'
import { exportJson, exportMarkdown } from './db/export.js'

const [command = 'serve', ...args] = process.argv.slice(2)
if (command === 'serve') {
  const port = Number(args[0] || process.env.PORT || 4173)
  createServer().listen(port, '127.0.0.1', () => console.log(`Orchestrator observation dashboard: http://127.0.0.1:${port}`))
} else if (command === 'migrate') {
  console.log(JSON.stringify(migrate(), null, 2))
} else if (command === 'export') {
  process.stdout.write(args.includes('--markdown') ? exportMarkdown() : exportJson())
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log('orchestrator serve [port]\norchestrator migrate\norchestrator export [--markdown]')
} else {
  console.error(`Unknown command: ${command}`)
  process.exitCode = 1
}
