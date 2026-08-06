import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { base, json, nowStamp, uid } from './db/index.js'
import { estimateTokenCost } from './pricing.js'

const filename = '.orchestrator.json'
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
