#!/usr/bin/env node
import { createServer } from './server.js'
import { readFileSync } from 'node:fs'
import { migrate } from './db/migrate.js'
import { exportJson, exportMarkdown } from './db/export.js'
import { addDeclaredEvidence, recordObservation, setTracking, trackingStatus } from './tracking.js'
import { base } from './db/index.js'
import { deriveAiWorkspace, handoffMarkdown } from './intelligence.js'

const localWorkspace=()=>{const status=trackingStatus();if(!status.configured||!status.project)throw new Error('Orchestrator is not configured for this project. Run: orchestrator enable');const project=base().prepare('SELECT * FROM projects WHERE slug=?').get(status.config.project);return deriveAiWorkspace(project)}

const [command = 'serve', ...args] = process.argv.slice(2)
if (command === 'serve') {
  const port = Number(args[0] || process.env.PORT || 4173)
  createServer().listen(port, '127.0.0.1', () => console.log(`Orchestrator observation dashboard: http://127.0.0.1:${port}`))
} else if (command === 'migrate') {
  console.log(JSON.stringify(migrate(), null, 2))
} else if (command === 'export') {
  process.stdout.write(args.includes('--markdown') ? exportMarkdown() : exportJson())
} else if (command === 'enable' || command === 'disable') {
  const project=args[0]&&!args[0].startsWith('--')?args[0]:undefined,nameIndex=args.indexOf('--name'),result=setTracking(command==='enable',{project,name:nameIndex>=0?args[nameIndex+1]:undefined})
  console.log(JSON.stringify(result,null,2))
} else if (command === 'status') {
  console.log(JSON.stringify(trackingStatus(),null,2))
} else if (command === 'evidence' && args[0] === 'add') {
  const value=(flag,fallback=null)=>{const index=args.indexOf(flag);return index>=0?args[index+1]:fallback},file=args[1]
  if(!file)throw new Error('Usage: orchestrator evidence add <file> [--objective uid] [--pass ref] [--label text] [--type type] [--origin source] [--actor-kind codex|claude] [--actor name]')
  console.log(JSON.stringify(await addDeclaredEvidence(file,{objective:value('--objective'),passRef:value('--pass'),label:value('--label'),type:value('--type','other'),origin:value('--origin','declared evidence'),actorKind:value('--actor-kind','codex'),actor:value('--actor','Codex')}),null,2))
} else if (command === 'record') {
  if(!args[0])throw new Error('Usage: orchestrator record <observation.json>')
  console.log(JSON.stringify(await recordObservation(JSON.parse(readFileSync(args[0],'utf8'))),null,2))
} else if(command==='next'){
  console.log(JSON.stringify(localWorkspace().next,null,2))
} else if(command==='handoff'){
  const workspace=localWorkspace();process.stdout.write(args.includes('--json')?`${JSON.stringify(workspace.handoff,null,2)}\n`:handoffMarkdown(workspace))
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log('orchestrator serve [port]\norchestrator migrate\norchestrator export [--markdown]\norchestrator enable [project-slug] [--name name]\norchestrator disable [project-slug]\norchestrator status\norchestrator next\norchestrator handoff [--json]\norchestrator record <observation.json>\norchestrator evidence add <file> [--objective uid] [--pass ref] [--label text] [--type type] [--origin source] [--actor-kind codex|claude] [--actor name]')
} else {
  console.error(`Unknown command: ${command}`)
  process.exitCode = 1
}
