#!/usr/bin/env node
import { createServer, importTeamOnboarding, insertEvent, startManagementReportScheduler, teamOnboardingBundle } from './server.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from './db/migrate.js'
import { exportJson, exportMarkdown } from './db/export.js'
import { addDeclaredEvidence, gitHookStatus, installGitHooks, recordGitHook, recordObservation, setTracking, trackingStatus, uninstallGitHooks } from './tracking.js'
import { base } from './db/index.js'
import { deriveAiWorkspace, handoffMarkdown } from './intelligence.js'
import { startClickupScheduler } from './planning.js'
import { generateProposals } from './planning.js'
import { startPassiveFollowers } from './follower.js'
import { refreshKnowledgeBase } from './knowledge.js'
import { createServer as createHttpServer } from 'node:http'
import { attachTerminalWebSockets, markInterruptedSessions } from './terminal.js'

function recordFollowerBatch({project,paths,git,observed_at}){
  const normalized=[...new Set(paths)].sort(),bucket=String(observed_at).slice(0,16),key=`follower:${project.slug}:${bucket}`
  insertEvent({project:project.slug,kind:'event.recorded',actor_kind:'system',actor:'Passive repository follower',assertion:'system_record',summary:`${normalized.length} repository path${normalized.length===1?'':'s'} changed`,payload:{paths:normalized,change_count:normalized.length,observer:'filesystem',compacted:true,execution:false},occurred_at:observed_at,source:'passive repository follower'},key)
  if(git){const latest=base().prepare("SELECT payload FROM events WHERE project_id=? AND kind='git.state' ORDER BY occurred_at DESC,id DESC LIMIT 1").get(project.id),previous=latest?JSON.parse(latest.payload):null,changed=!previous||['branch','head_commit','dirty','upstream_commit'].some(field=>previous[field]!==git[field]);if(changed)insertEvent({project:project.slug,kind:'git.state',actor_kind:'system',actor:'Passive repository follower',assertion:'measured_fact',summary:git.remote_verified?'Local HEAD matches the recorded upstream ref':'Local repository state changed',payload:{machine:hostname(),...git,trigger:'filesystem-change',transition:git.remote_verified?'git.push.verified':undefined},occurred_at:observed_at,source:'passive repository follower'},`${key}:git`)}
  generateProposals(project)
}

const localWorkspace=()=>{const status=trackingStatus();if(!status.configured||!status.project)throw new Error('Orchestrator is not configured for this project. Run: orchestrator enable');const project=base().prepare('SELECT * FROM projects WHERE slug=?').get(status.config.project);return deriveAiWorkspace(project)}
const cliPath=fileURLToPath(import.meta.url)
function installClaudeCommand(root=process.cwd(),globalMode=false){
  const status=globalMode?null:trackingStatus(root);if(!globalMode&&(!status.configured||!status.enabled))throw new Error('Enable Orchestrator in this project before installing the Claude command.')
  const path=globalMode?join(homedir(),'.claude','commands','orchestrator.md'):join(root,'.claude','commands','orchestrator.md'),invoke=`node ${JSON.stringify(cliPath)}`;mkdirSync(dirname(path),{recursive:true})
  const body=`---\ndescription: Validate and perform the next approved Orchestrator task\nargument-hint: [next|handoff|status]\n---\n\nAct as the external executor for this repository. Orchestrator is observation-only.\n\n1. Run \`${invoke} status\`. Stop if passive tracking is disabled.\n2. Run \`${invoke} next\` and \`${invoke} handoff\`. A proposal awaiting review is context, not authority.\n3. Independently inspect the current Git branch, HEAD, dirty files, dependencies, repository state, success criteria and required evidence. Never trust stale recorded state.\n4. If the task is infeasible, blocked, completed, overlapping another active scope or based on stale Git, do not implement it. Record and explain the precise blocker.\n5. If feasible, perform the work yourself within the approved scope. Orchestrator must never start commands, agents, browsers, Git operations or project processes.\n6. Run proportionate tests and report transitions, proof manifests, verdict and cleanup through the Orchestrator CLI/API.\n7. Synchronize ClickUp only after recorded state supports the target status. Push only when the user or current task explicitly authorizes publication.\n8. Finish with the next recommended objective and any human decision still required.\n\nOptional request: $ARGUMENTS\n`
  writeFileSync(path,body,{mode:0o644});return{installed:true,scope:globalMode?'global':'project',project:status?.config.project||null,path,restart_required:true,execution:false}
}

const [command = 'serve', ...args] = process.argv.slice(2)
if (command === 'serve') {
  const port = Number(args[0] || process.env.PORT || 4173)
  markInterruptedSessions()
  const server=createHttpServer(createServer())
  attachTerminalWebSockets(server)
  server.listen(port, '127.0.0.1', () => {startClickupScheduler();startManagementReportScheduler();startPassiveFollowers({onPlan:project=>generateProposals(project),onBatch:recordFollowerBatch});const knowledgeTimer=setTimeout(()=>{try{refreshKnowledgeBase()}catch{}},2000);knowledgeTimer.unref();const cloudSync=async()=>{try{const connections=await fetch(`http://127.0.0.1:${port}/api/sync`).then(response=>response.json());for(const item of connections.filter(row=>row.enabled&&!row.progress?.active)){const last=Date.parse(item.last_push_at||item.last_pull_at||0);if(!last||Date.now()-last>=15*60*1000)await fetch(`http://127.0.0.1:${port}/api/sync/${encodeURIComponent(item.provider)}`,{method:'POST'})}}catch{}};const cloudTimer=setInterval(cloudSync,60*1000);cloudTimer.unref();const cloudStart=setTimeout(cloudSync,60*1000);cloudStart.unref();console.log(`Orchestrator local AI control plane: http://127.0.0.1:${port}`)})
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
} else if(command==='hooks'){
  const action=args[0]||'status',commandIndex=args.indexOf('--command'),options={command:commandIndex>=0?args[commandIndex+1]:undefined}
  if(action==='install')console.log(JSON.stringify(installGitHooks(options),null,2))
  else if(action==='uninstall')console.log(JSON.stringify(uninstallGitHooks(),null,2))
  else if(action==='status')console.log(JSON.stringify(gitHookStatus(),null,2))
  else throw new Error('Usage: orchestrator hooks install|status|uninstall [--command orchestrator]')
} else if(command==='hook'&&args[0]==='git'){
  console.log(JSON.stringify(await recordGitHook(),null,2))
} else if(command==='next'){
  console.log(JSON.stringify(localWorkspace().next,null,2))
} else if(command==='handoff'){
  const workspace=localWorkspace();process.stdout.write(args.includes('--json')?`${JSON.stringify(workspace.handoff,null,2)}\n`:handoffMarkdown(workspace))
} else if(command==='integrate'&&args[0]==='claude'){
  console.log(JSON.stringify(installClaudeCommand(process.cwd(),args.includes('--global')),null,2))
} else if(command==='team'&&args[0]==='export'){
  const project=args[1]||trackingStatus().config?.project;if(!project)throw new Error('Usage: orchestrator team export <project-slug>');process.stdout.write(`${JSON.stringify(teamOnboardingBundle(project),null,2)}\n`)
} else if(command==='team'&&args[0]==='join'){
  if(!args[1])throw new Error('Usage: orchestrator team join <bundle.json>');console.log(JSON.stringify(importTeamOnboarding(JSON.parse(readFileSync(args[1],'utf8'))),null,2))
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log('orchestrator serve [port]\norchestrator migrate\norchestrator export [--markdown]\norchestrator enable [project-slug] [--name name]\norchestrator disable [project-slug]\norchestrator status\norchestrator hooks install|status|uninstall [--command orchestrator]\norchestrator integrate claude [--global]\norchestrator team export <project-slug>\norchestrator team join <bundle.json>\norchestrator next\norchestrator handoff [--json]\norchestrator record <observation.json>\norchestrator evidence add <file> [--objective uid] [--pass ref] [--label text] [--type type] [--origin source] [--actor-kind codex|claude] [--actor name]')
} else {
  console.error(`Unknown command: ${command}`)
  process.exitCode = 1
}
