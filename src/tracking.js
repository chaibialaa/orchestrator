import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { base, json, nowStamp, uid } from './db/index.js'
import { estimateTokenCost } from './pricing.js'

const filename = '.orchestrator.json'
const hookNames=['pre-commit','post-commit','pre-push','post-checkout','post-merge','post-rewrite']
const hookStart='# orchestrator-observer:start',hookEnd='# orchestrator-observer:end'
const slugify = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')
const digestFile = path => new Promise((resolve,reject)=>{const hash=createHash('sha256'),stream=createReadStream(path);stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')))})
export const trackingPath = (root=process.cwd()) => join(root,filename)
export function readTracking(root=process.cwd()) { const path=trackingPath(root);if(!existsSync(path))return null;try{return json.read(readFileSync(path,'utf8'),null)}catch{return null} }
export function setTracking(enabled,{root=process.cwd(),project,name}={}) {
  const projectRoot=realpathSync(root),path=trackingPath(projectRoot),current=readTracking(projectRoot)
  if(existsSync(path)&&!current)throw new Error(`${filename} is not valid JSON.`)
  if(current&&current.format!=='orchestrator-project')throw new Error(`${filename} belongs to another format.`)
  const slug=slugify(project||current?.project||basename(projectRoot)),label=String(name||current?.name||basename(projectRoot)).trim()
  if(!slug)throw new Error('A project slug is required.')
  const config={format:'orchestrator-project',version:1,enabled:Boolean(enabled),project:slug,name:label,evidence_mode:'declared-only',updated_at:nowStamp()}
  writeFileSync(trackingPath(projectRoot),`${JSON.stringify(config,null,2)}\n`,{mode:0o644})
  const db=base(),found=db.prepare('SELECT * FROM projects WHERE slug=?').get(slug)
  if(found)db.prepare('UPDATE projects SET name=?,status=?,updated_at=? WHERE id=?').run(label,enabled?'active':'archived',nowStamp(),found.id)
  else if(enabled)db.prepare('INSERT INTO projects(uid,slug,name,description,status) VALUES(?,?,?,?,?)').run(uid(),slug,label,`Repository: ${projectRoot}`,'active')
  const registered=db.prepare('SELECT id FROM projects WHERE slug=?').get(slug),workspace=db.prepare('SELECT id FROM workspaces WHERE status=\'active\' ORDER BY id LIMIT 1').get();if(registered&&workspace)db.prepare('INSERT OR IGNORE INTO workspace_projects(workspace_id,project_id) VALUES(?,?)').run(workspace.id,registered.id)
  return{...config,path:trackingPath(projectRoot),registered:Boolean(found||enabled)}
}
export function trackingStatus(root=process.cwd()) {
  const config=readTracking(root)
  if(!config)return{configured:false,enabled:false,path:trackingPath(root),project:null,registered:false}
  const project=base().prepare('SELECT slug,name,status,updated_at FROM projects WHERE slug=?').get(config.project)
  return{configured:true,enabled:Boolean(config.enabled&&project?.status!=='archived'),path:trackingPath(root),config,project:project||null,registered:Boolean(project)}
}
export async function addDeclaredEvidence(file,{root=process.cwd(),objective=null,passRef=null,label=null,type='other',origin='declared evidence',actorKind='codex',actor='Codex',endpoint=process.env.ORCHESTRATOR_URL||'http://127.0.0.1:4173'}={}) {
  const status=trackingStatus(root)
  if(!status.configured)throw new Error('Orchestrator is not configured in this project. Run: orchestrator enable')
  if(!status.enabled)throw new Error('Orchestrator tracking is disabled for this project.')
  const path=realpathSync(file),stat=statSync(path)
  if(!stat.isFile())throw new Error('Evidence path must be a file.')
  const sha256=await digestFile(path),summary=label||basename(path),payload={label:summary,type,origin,locator_kind:'path',path,sha256,bytes:stat.size,status:'available',retention:'referenced',pass_ref:passRef}
  const response=await fetch(`${endpoint.replace(/\/$/,'')}/api/ingest`,{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':`evidence:${status.config.project}:${objective||'project'}:${sha256}`},body:JSON.stringify({project:status.config.project,objective,kind:'evidence.recorded',actor_kind:actorKind,actor,assertion:'measured_fact',summary,payload,source:'orchestrator cli'})})
  const body=await response.json()
  if(!response.ok)throw new Error(body.message||`Orchestrator returned ${response.status}.`)
  return{project:status.config.project,path,sha256,bytes:stat.size,duplicate:Boolean(body.events?.[0]?.duplicate),response:body}
}
export async function recordObservation(input,{root=process.cwd(),endpoint=process.env.ORCHESTRATOR_URL||'http://127.0.0.1:4173'}={}) {
  const status=trackingStatus(root)
  if(!status.configured)throw new Error('Orchestrator is not configured in this project. Run: orchestrator enable')
  if(!status.enabled)throw new Error('Orchestrator tracking is disabled for this project.')
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Observation must be a JSON object.')
  const body={...input,payload:{...(input.payload||{})},project:status.config.project}
  if(body.kind==='cost.recorded'&&body.payload.amount==null){const estimate=estimateTokenCost(body.payload.model,body.payload);if(estimate)Object.assign(body.payload,{amount:estimate.amount,currency:estimate.currency,known:true,cost_basis:'estimated',pricing_version:estimate.pricing_version,api_equivalent:true});else Object.assign(body.payload,{known:false,cost_basis:'unknown'})}
  const key=input.idempotency_key||`record:${status.config.project}:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`
  delete body.idempotency_key
  const response=await fetch(`${endpoint.replace(/\/$/,'')}/api/ingest`,{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)})
  const result=await response.json()
  if(!response.ok)throw new Error(result.message||`Orchestrator returned ${response.status}.`)
  return{project:status.config.project,duplicate:Boolean(result.events?.[0]?.duplicate),response:result}
}

function gitDirectory(root=process.cwd()){
  const dot=join(realpathSync(root),'.git')
  if(!existsSync(dot))throw new Error('Git metadata was not found in this project.')
  if(statSync(dot).isDirectory())return dot
  const match=readFileSync(dot,'utf8').match(/^gitdir:\s*(.+)\s*$/m)
  if(!match)throw new Error('Unsupported .git metadata file.')
  return realpathSync(isAbsolute(match[1])?match[1]:resolve(dirname(dot),match[1]))
}
const withoutHookBlock=text=>text.replace(new RegExp(`\\n?${hookStart.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[\\s\\S]*?${hookEnd.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\n?`,'g'),'\n').replace(/^\n+|\n+$/g,'')
export function gitHookStatus(root=process.cwd()){
  let directory
  try{directory=gitDirectory(root)}catch(error){return{available:false,installed:false,error:error.message,hooks:[]}}
  const hooks=hookNames.map(name=>{const path=join(directory,'hooks',name),text=existsSync(path)?readFileSync(path,'utf8'):'';return{name,path,installed:text.includes(hookStart)&&text.includes(hookEnd)}})
  return{available:true,installed:hooks.every(row=>row.installed),directory,hooks}
}
export function installGitHooks({root=process.cwd(),command='orchestrator'}={}){
  const status=trackingStatus(root)
  if(!status.configured||!status.enabled)throw new Error('Enable Orchestrator tracking before installing hooks.')
  const directory=gitDirectory(root),hooksDir=join(directory,'hooks'),helper=join(hooksDir,'orchestrator-observe'),quotedCommand=`'${String(command).replace(/'/g,"'\\''")}'`
  mkdirSync(hooksDir,{recursive:true})
  const helperBody=`#!/bin/sh\ntrigger=\"\${1:-git-hook}\"\nbranch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || printf detached)\nhead_commit=$(git rev-parse HEAD 2>/dev/null || printf unborn)\ndirty=false\nif [ -n \"$(git status --porcelain --untracked-files=normal 2>/dev/null)\" ]; then dirty=true; fi\nORCHESTRATOR_HOOK_TRIGGER=\"$trigger\" ORCHESTRATOR_HOOK_BRANCH=\"$branch\" ORCHESTRATOR_HOOK_HEAD=\"$head_commit\" ORCHESTRATOR_HOOK_DIRTY=\"$dirty\" ${quotedCommand} hook git >/dev/null 2>&1 || true\n`
  writeFileSync(helper,helperBody,{mode:0o755});chmodSync(helper,0o755)
  for(const name of hookNames){const path=join(hooksDir,name),current=existsSync(path)?readFileSync(path,'utf8'):'#!/bin/sh\n',clean=withoutHookBlock(current),block=`${hookStart}\nhook_dir=$(git rev-parse --git-path hooks 2>/dev/null)\nif [ -x \"$hook_dir/orchestrator-observe\" ]; then \"$hook_dir/orchestrator-observe\" ${name}; fi\n${hookEnd}`;writeFileSync(path,`${clean.trimEnd()}\n${block}\n`,{mode:0o755});chmodSync(path,0o755)}
  return{...gitHookStatus(root),helper,command,passive:true}
}
export function uninstallGitHooks({root=process.cwd()}={}){
  const directory=gitDirectory(root),helper=join(directory,'hooks','orchestrator-observe')
  for(const name of hookNames){const path=join(directory,'hooks',name);if(!existsSync(path))continue;const clean=withoutHookBlock(readFileSync(path,'utf8'));writeFileSync(path,clean?`${clean.trimEnd()}\n`:'#!/bin/sh\n',{mode:0o755});chmodSync(path,0o755)}
  if(existsSync(helper))unlinkSync(helper)
  return{...gitHookStatus(root),helper_removed:!existsSync(helper),passive:true}
}
export async function recordGitHook({root=process.cwd(),endpoint=process.env.ORCHESTRATOR_URL||'http://127.0.0.1:4173',environment=process.env}={}){
  const branch=String(environment.ORCHESTRATOR_HOOK_BRANCH||'').trim(),head=String(environment.ORCHESTRATOR_HOOK_HEAD||'').trim(),dirty=String(environment.ORCHESTRATOR_HOOK_DIRTY||'').trim().toLowerCase(),trigger=String(environment.ORCHESTRATOR_HOOK_TRIGGER||'git-hook').trim()
  if(!branch||!head||!['true','false'].includes(dirty))throw new Error('Git hook state is incomplete.')
  return recordObservation({kind:'git.state',actor_kind:'system',actor:'Git hook',assertion:'measured_fact',summary:`Git state observed after ${trigger}`,payload:{machine:hostname(),branch,head_commit:head,dirty:dirty==='true',trigger},source:'external git hook',idempotency_key:`git-hook:${trigger}:${branch}:${head}:${dirty}`},{root,endpoint})
}
