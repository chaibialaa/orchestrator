import express from 'express'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { base, json, machineId, nowStamp, uid } from './db/index.js'
import { exportJson, exportJournal, exportMarkdown } from './db/export.js'
import { importBundle } from './db/import.js'
import { downloadJournal, journalDigest, journalName, listJournals, uploadJournal } from './sync.js'
import { scanLocalMemories } from './local-memory.js'
import { scanCodexUsageToday } from './local-usage.js'
import { deriveProjectState } from './state.js'

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')
const fileSha=(path)=>new Promise((resolve,reject)=>{const hash=createHash('sha256'),stream=createReadStream(path);stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')))})
const publicRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const allowedActors = ['human','codex','claude','system','import']
const allowedAssertions = ['measured_fact','agent_statement','human_judgment','system_record']
const allowedKinds = new Set(['event.recorded','project.updated','objective.updated','evidence.recorded','verdict.recorded','decision.recorded','blocker.opened','blocker.resolved','transition.recorded','cost.recorded','cleanup.observed','context.summary','work.started','work.heartbeat','work.finished','git.state','human_judgment.requested','human_judgment.cancelled'])
const textField=(data,name)=>typeof data[name]==='string'&&data[name].trim()
function validateCoordination(kind,data){
  if(kind==='work.started'){
    for(const field of ['session_id','machine','base_commit','branch'])if(!textField(data,field))throw new Error(`work.started requires ${field}.`)
    if(!Array.isArray(data.paths)||!data.paths.length||data.paths.some(path=>typeof path!=='string'||!path.trim()))throw new Error('work.started requires non-empty paths.')
  }
  if(kind==='work.heartbeat'&&(!textField(data,'session_id')||!textField(data,'machine')))throw new Error('work.heartbeat requires session_id and machine.')
  if(kind==='work.finished'){
    if(!textField(data,'session_id'))throw new Error('work.finished requires session_id.')
    if(!['completed','failed','cancelled'].includes(data.outcome))throw new Error('work.finished outcome must be completed, failed or cancelled.')
  }
  if(kind==='git.state'){
    for(const field of ['machine','head_commit','branch'])if(!textField(data,field))throw new Error(`git.state requires ${field}.`)
    if(typeof data.dirty!=='boolean')throw new Error('git.state requires boolean dirty.')
  }
}

function projectBy(value) {
  return base().prepare('SELECT * FROM projects WHERE slug=? OR uid=?').get(value, value)
}
function objectiveBy(value, projectId) {
  return value == null ? null : base().prepare('SELECT * FROM objectives WHERE (uid=? OR id=?) AND project_id=?').get(value, Number(value) || -1, projectId)
}
function insertEvent(input, idempotencyKey) {
  const project = projectBy(input.project)
  if (!project) throw Object.assign(new Error('Unknown project.'), { status: 404 })
  if (!allowedKinds.has(input.kind)) throw new Error('Unsupported event kind.')
  if (!allowedActors.includes(input.actor_kind)) throw new Error('Unsupported actor kind.')
  if (!allowedAssertions.includes(input.assertion)) throw new Error('Unsupported assertion class.')
  if (!input.actor?.trim() || !input.summary?.trim()) throw new Error('actor and summary are required.')
  validateCoordination(input.kind,input.payload||{})
  const objective = objectiveBy(input.objective, project.id)
  if (input.objective != null && !objective) throw new Error('Unknown objective for this project.')
  if(input.kind==='objective.updated'&&!objective)throw new Error('objective.updated requires an objective.')
  if(input.kind==='objective.updated'&&input.payload?.status!==undefined&&!['draft','ready','in_progress','blocked','proven','abandoned'].includes(input.payload.status))throw new Error('Unsupported objective status.')
  if(input.kind==='cost.recorded'){
    const data=input.payload||{};for(const field of ['input_tokens','output_tokens','cached_tokens','total_tokens','duration_ms','requests'])if(data[field]!==undefined&&(!Number.isFinite(Number(data[field]))||Number(data[field])<0))throw new Error(`${field} must be a non-negative number.`)
    if(data.cost_basis!==undefined&&!['measured','estimated','unknown'].includes(data.cost_basis))throw new Error('cost_basis must be measured, estimated or unknown.')
  }
  const eventUid = input.uid || uid()
  const result = base().prepare(`INSERT INTO events(uid,project_id,objective_id,kind,actor_kind,actor,assertion,summary,payload,occurred_at,idempotency_key,source,machine_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(eventUid, project.id, objective?.id ?? null, input.kind, input.actor_kind, input.actor.trim(), input.assertion, input.summary.trim(), json.write(input.payload), input.occurred_at || nowStamp(), idempotencyKey, input.source || null, machineId())
  const event = result.changes ? base().prepare('SELECT * FROM events WHERE id=?').get(result.lastInsertRowid) : base().prepare('SELECT * FROM events WHERE idempotency_key=?').get(idempotencyKey)
  if (!result.changes) return { event, duplicate: true }
  const data = input.payload || {}
  if (input.kind === 'evidence.recorded') {
    const status = data.status || (data.sha256 ? 'available' : 'unverified')
    base().prepare(`INSERT INTO evidence_manifests(uid,event_id,project_id,objective_id,label,type,origin,locator_kind,locator,sha256,bytes,mime,retention,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(data.uid || uid(), event.id, project.id, objective?.id ?? null, data.label || input.summary, data.type || 'other', data.origin || input.actor, data.locator_kind || (data.url ? 'url' : data.path ? 'path' : 'missing'), data.url || data.path || data.locator || null, data.sha256 || null, data.bytes ?? null, data.mime || null, data.retention || 'referenced', status)
  }
  const projections = {
    'decision.recorded': ['decisions', ['title','body','status'], [data.title || input.summary, data.body || '', data.status || 'accepted']],
    'blocker.opened': ['blockers', ['title','detail','status'], [data.title || input.summary, data.detail || '', 'open']],
    'verdict.recorded': ['verdicts', ['verdict','rationale'], [data.verdict || 'inconclusive', data.rationale || '']],
    'cost.recorded': ['costs', ['amount','currency','known','category'], [data.amount ?? null, data.currency || 'USD', data.known === false ? 0 : 1, data.category || null]],
    'cleanup.observed': ['cleanups', ['resource','observed_state','detail'], [data.resource || input.summary, data.observed_state || 'unknown', data.detail || null]],
  }
  const projection = projections[input.kind]
  if (projection) {
    const [table, fields, values] = projection
    base().prepare(`INSERT INTO ${table}(uid,event_id,project_id,objective_id,${fields.join(',')}) VALUES(?,?,?,?,${fields.map(() => '?').join(',')})`).run(uid(), event.id, project.id, objective?.id ?? null, ...values)
  }
  if(input.kind==='blocker.resolved'){
    const title=data.title||input.summary,found=base().prepare("SELECT id FROM blockers WHERE project_id=? AND objective_id IS ? AND status='open' AND title=? ORDER BY id DESC LIMIT 1").get(project.id,objective?.id??null,title)
    if(found)base().prepare("UPDATE blockers SET status='resolved',resolved_at=? WHERE id=?").run(input.occurred_at||nowStamp(),found.id)
  }
  if (input.kind === 'objective.updated' && objective) {
    const fields = ['title','intent','success_criteria','status','priority'].filter((name) => data[name] !== undefined)
    if (fields.length) base().prepare(`UPDATE objectives SET ${fields.map((name) => `${name}=?`).join(',')},updated_at=? WHERE id=?`).run(...fields.map((name) => data[name]), nowStamp(), objective.id)
  }
  if(input.kind==='project.updated'){
    const fields=['name','description','status'].filter((name)=>data[name]!==undefined)
    if(fields.length)base().prepare(`UPDATE projects SET ${fields.map((name)=>`${name}=?`).join(',')},updated_at=? WHERE id=?`).run(...fields.map((name)=>data[name]),nowStamp(),project.id)
  }
  return { event, duplicate: false }
}

export function createServer() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))
  app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', req.get('origin') || 'null'); res.set('Vary', 'Origin'); next() })
  const api = express.Router()
  api.get('/health', (_req, res) => res.json({ ok: true, role: 'observation-and-memory', execution: false }))
  api.get('/projects', (_req, res) => res.json(base().prepare(`SELECT p.*,(SELECT count(*) FROM objectives o WHERE o.project_id=p.id) objectives,(SELECT count(*) FROM evidence_manifests e WHERE e.project_id=p.id AND e.status='available') proofs FROM projects p ORDER BY p.updated_at DESC`).all().map(p=>({...p,open_blockers:deriveProjectState(p.id).blockers.length}))))
  api.get('/portfolio',(_req,res)=>{const tracked=base().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all(),histories=scanLocalMemories(),sync=base().prepare(`SELECT provider,label,last_status,last_detail,last_pull_at,last_push_at,(SELECT count(*) FROM sync_shards s WHERE s.provider=c.provider) shard_count FROM sync_connections c ORDER BY id`).all(),projects=tracked.map(project=>{const state=deriveProjectState(project.id),last=base().prepare('SELECT occurred_at,summary FROM events WHERE project_id=? ORDER BY occurred_at DESC,id DESC LIMIT 1').get(project.id),coordination=base().prepare("SELECT kind,payload,occurred_at,machine_id FROM events WHERE project_id=? AND kind IN ('git.state','work.started','work.heartbeat') ORDER BY occurred_at,id").all(project.id).map(row=>({...row,payload:json.read(row.payload,{})})),git=[...coordination].reverse().find(row=>row.kind==='git.state'),machines=[...new Set(coordination.map(row=>row.payload.machine||row.machine_id).filter(Boolean))],local=histories.projects.find(item=>project.description?.includes(item.path)||item.name.toLowerCase()===project.name.toLowerCase());return{...project,objectives:state.objectives.length,proven:state.objectives.filter(row=>row.status==='proven').length,open_blockers:state.blockers.length,last_activity:last?.occurred_at||null,last_summary:last?.summary||null,machines,git:git?{branch:git.payload.branch,head_commit:git.payload.head_commit,dirty:git.payload.dirty,observed_at:git.occurred_at}:null,local_memory:local?{path:local.path,sessions:local.sessions,sources:local.sources,last_activity:local.last_activity}:null}}),knownPaths=new Set(projects.map(project=>project.local_memory?.path).filter(Boolean)),detected=histories.projects.filter(item=>!knownPaths.has(item.path)&&!projects.some(project=>project.name.toLowerCase()===item.name.toLowerCase())).map(item=>({...item,tracked:false}));res.json({generated_at:nowStamp(),projects,detected,sync,inventory:histories.inventories})})
  api.get('/analytics',(req,res)=>{const project=req.query.project?projectBy(String(req.query.project)):null;if(req.query.project&&!project)return res.status(404).json({message:'Unknown project.'});const days=Math.min(3650,Math.max(1,Number(req.query.days)||30)),since=new Date(Date.now()-days*86400000).toISOString(),rows=base().prepare(`SELECT e.uid,e.project_id,p.name project_name,e.objective_id,e.assertion,e.payload,e.occurred_at,c.amount,c.currency,c.known,c.category FROM events e JOIN projects p ON p.id=e.project_id LEFT JOIN costs c ON c.event_id=e.id WHERE e.kind='cost.recorded' AND e.occurred_at>=?${project?' AND e.project_id=?':''} ORDER BY e.occurred_at`).all(since,...(project?[project.id]:[])).map(row=>{const data=json.read(row.payload,{}),input=Number(data.input_tokens??data.tokens_in??0)||0,output=Number(data.output_tokens??data.tokens_out??0)||0,cached=Number(data.cached_tokens??data.tokens_cached??0)||0,total=Number(data.total_tokens??data.tokens??input+output)||input+output,known=Boolean(row.known),basis=data.cost_basis||(!known?'unknown':row.assertion==='measured_fact'?'measured':'estimated');return{...row,input_tokens:input,output_tokens:output,cached_tokens:cached,total_tokens:total,model:data.model||data.harness||row.category||'unknown',duration_ms:Number(data.duration_ms||0)||null,requests:Number(data.requests||0)||null,cost_basis:basis}}),group=(key)=>{const map=new Map();for(const row of rows){const value=key(row),item=map.get(value)||{key:value,cost:0,tokens:0,input_tokens:0,output_tokens:0,cached_tokens:0,records:0,unknown_costs:0};item.records++;item.tokens+=row.total_tokens;item.input_tokens+=row.input_tokens;item.output_tokens+=row.output_tokens;item.cached_tokens+=row.cached_tokens;if(row.known&&row.amount!=null)item.cost+=row.amount;else item.unknown_costs++;map.set(value,item)}return[...map.values()]},daily=group(row=>String(row.occurred_at).slice(0,10)),models=group(row=>row.model).sort((a,b)=>b.cost-a.cost),projects=group(row=>row.project_name).sort((a,b)=>b.cost-a.cost),totals=rows.reduce((sum,row)=>({records:sum.records+1,cost:sum.cost+(row.known&&row.amount!=null?row.amount:0),measured_cost:sum.measured_cost+(row.cost_basis==='measured'&&row.amount!=null?row.amount:0),estimated_cost:sum.estimated_cost+(row.cost_basis==='estimated'&&row.amount!=null?row.amount:0),unknown_costs:sum.unknown_costs+(!row.known?1:0),input_tokens:sum.input_tokens+row.input_tokens,output_tokens:sum.output_tokens+row.output_tokens,cached_tokens:sum.cached_tokens+row.cached_tokens,total_tokens:sum.total_tokens+row.total_tokens,token_records:sum.token_records+(row.total_tokens>0?1:0)}), {records:0,cost:0,measured_cost:0,estimated_cost:0,unknown_costs:0,input_tokens:0,output_tokens:0,cached_tokens:0,total_tokens:0,token_records:0});const state=project?deriveProjectState(project.id):null;res.json({scope:project?{type:'project',slug:project.slug,name:project.name}:{type:'global'},days,since,totals,daily,models,projects,efficiency:project?{proven_objectives:state.objectives.filter(row=>row.status==='proven').length,cost_per_proven:state.objectives.some(row=>row.status==='proven')?totals.cost/state.objectives.filter(row=>row.status==='proven').length:null,tokens_per_proven:state.objectives.some(row=>row.status==='proven')?totals.total_tokens/state.objectives.filter(row=>row.status==='proven').length:null}:null,local_today:project?scanCodexUsageToday(project):null,provenance:{cost_basis:['measured','estimated','unknown'],tokens:'reported by external clients; Orchestrator does not query or control models'}})})
  api.get('/projects/:project', (req, res) => {
    const p = projectBy(req.params.project); if (!p) return res.status(404).json({ message: 'Unknown project.' })
    const state=deriveProjectState(p.id),objectives=state.objectives
    const chapters = objectives.filter((row) => row.parent_id == null).map((chapter) => {
      const children = objectives.filter((row) => row.parent_id === chapter.id)
      const scope = children.length ? children : [chapter]
      return { ...chapter, objective_count: scope.length, proven_count: scope.filter((row) => row.status === 'proven').length,
        progress: Math.round(scope.filter((row) => row.status === 'proven').length / scope.length * 100), children }
    })
    const blockers = state.blockers.map(blocker=>{const event=base().prepare('SELECT payload FROM events WHERE id=?').get(blocker.event_id),payload=json.read(event?.payload,{}),objective=objectives.find(row=>row.id===blocker.objective_id);return{...blocker,objective_uid:objective?.uid||null,objective_title:objective?.title||null,pass_ref:payload.pass_ref||payload.pass||payload.passage_id||(payload.id?`evidence-${payload.id}`:null)}})
    const decisions = base().prepare('SELECT * FROM decisions WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(p.id)
    res.json({ ...p, chapters, objectives, blockers, decisions, judgment_requests:state.judgmentRequests })
  })
  api.get('/projects/:project/timeline', (req, res) => {
    const p = projectBy(req.params.project); if (!p) return res.status(404).json({ message: 'Unknown project.' })
    const where = ['e.project_id=@project']; const params = { project: p.id, limit: Math.min(Number(req.query.limit) || 100, 500) }
    if (req.query.kind) { where.push('e.kind=@kind'); params.kind = req.query.kind }
    if (req.query.assertion) { where.push('e.assertion=@assertion'); params.assertion = req.query.assertion }
    if (req.query.objective) { const objective=objectiveBy(String(req.query.objective),p.id); if(!objective) return res.status(404).json({message:'Unknown objective.'}); where.push('e.objective_id=@objective'); params.objective=objective.id }
    if (req.query.q) { where.push('(e.summary LIKE @q OR e.payload LIKE @q)'); params.q = `%${req.query.q}%` }
    const rows = base().prepare(`SELECT e.*,o.title objective_title FROM events e LEFT JOIN objectives o ON o.id=e.objective_id WHERE ${where.join(' AND ')} ORDER BY e.occurred_at DESC,e.id DESC LIMIT @limit`).all(params).map((row) => ({ ...row, payload: json.read(row.payload, {}) }))
    res.json(rows)
  })
  api.get('/projects/:project/resume', (req, res) => {
    const p = projectBy(req.params.project); if (!p) return res.status(404).json({ message: 'Unknown project.' })
    const recent = base().prepare('SELECT kind,summary,occurred_at,assertion FROM events WHERE project_id=? ORDER BY occurred_at DESC,id DESC LIMIT 12').all(p.id)
    const state=deriveProjectState(p.id),counts={total:state.objectives.length,proven:state.objectives.filter(row=>row.status==='proven').length,blocked:state.objectives.filter(row=>row.status==='blocked').length},open=state.blockers.map(({title,detail})=>({title,detail}))
    res.json({ project: p, objectives: counts, open_blockers: open, recent })
  })
  api.get('/projects/:project/coordination', (req,res)=>{
    const p=projectBy(req.params.project);if(!p)return res.status(404).json({message:'Unknown project.'})
    const rows=base().prepare("SELECT * FROM events WHERE project_id=? AND kind IN ('work.started','work.heartbeat','work.finished','git.state') ORDER BY occurred_at,id").all(p.id).map(row=>({...row,payload:json.read(row.payload,{})}))
    const gitRows=rows.filter(row=>row.kind==='git.state'),latestGit=gitRows.at(-1)||null,sessions=new Map()
    for(const row of rows.filter(row=>row.kind.startsWith('work.'))){const id=row.payload.session_id;if(!id)continue;const state=sessions.get(id)||{session_id:id,start:null,heartbeat:null,finish:null};if(row.kind==='work.started')state.start=row;if(row.kind==='work.heartbeat')state.heartbeat=row;if(row.kind==='work.finished')state.finish=row;sessions.set(id,state)}
    const now=Date.now(),timeoutMs=Math.max(60_000,Number(req.query.timeout_minutes||15)*60_000),pathOverlap=(a,b)=>{const x=String(a).replace(/\/$/,'')+'/',y=String(b).replace(/\/$/,'')+'/';return x.startsWith(y)||y.startsWith(x)}
    const passes=[...sessions.values()].filter(state=>state.start).map(state=>{const last=state.finish||state.heartbeat||state.start,data=state.start.payload,branchGit=[...gitRows].reverse().find(row=>row.payload.branch===data.branch),finished=Boolean(state.finish),abandoned=!finished&&now-new Date(last.occurred_at).getTime()>timeoutMs,stale=!finished&&Boolean(branchGit?.payload.head_commit&&data.base_commit&&branchGit.payload.head_commit!==data.base_commit);return{session_id:state.session_id,machine:data.machine,branch:data.branch,base_commit:data.base_commit,paths:data.paths||[],summary:state.start.summary,started_at:state.start.occurred_at,last_seen_at:last.occurred_at,finished_at:state.finish?.occurred_at||null,outcome:state.finish?.payload.outcome||null,status:finished?'finished':abandoned?'abandoned':stale?'stale':'active',stale,abandoned,dirty:Boolean(branchGit?.payload.dirty),head_commit:branchGit?.payload.head_commit||null,overlaps:[]}})
    const live=passes.filter(pass=>!['finished','abandoned'].includes(pass.status));for(const pass of live)pass.overlaps=live.filter(other=>other.session_id!==pass.session_id&&pass.paths.some(path=>other.paths.some(otherPath=>pathOverlap(path,otherPath)))).map(other=>other.session_id)
    res.json({protocol:{version:1,heartbeat_timeout_minutes:timeoutMs/60_000},latest_git:latestGit?{...latestGit.payload,observed_at:latestGit.occurred_at}:null,active:live,recent:passes.sort((a,b)=>b.started_at.localeCompare(a.started_at)).slice(0,30),counts:{active:live.filter(x=>x.status==='active').length,stale:live.filter(x=>x.stale).length,conflicts:live.filter(x=>x.overlaps.length).length,abandoned:passes.filter(x=>x.abandoned).length}})
  })
  api.get('/projects/:project/diagram',(req,res)=>{const p=projectBy(req.params.project);if(!p)return res.status(404).json({message:'Unknown project.'});const objectives=deriveProjectState(p.id).objectives.map(row=>({...row,fail_count:base().prepare("SELECT count(*) n FROM verdicts WHERE objective_id=? AND verdict='fail'").get(row.id).n,blocker_count:row.open_blocker_count})),byId=new Map(objectives.map(row=>[row.id,row.uid])),roots=objectives.filter(row=>!row.parent_id),edges=objectives.filter(row=>row.parent_id).map(row=>({from:byId.get(row.parent_id),to:row.uid,type:'contains'}));for(let i=1;i<roots.length;i++)edges.push({from:roots[i-1].uid,to:roots[i].uid,type:'precedes'});for(const row of objectives.filter(row=>row.fail_count||row.blocker_count))edges.push({from:row.uid,to:row.uid,type:'retry'});for(let i=1;i<roots.length;i++)if(roots[i].status==='blocked')edges.push({from:roots[i].uid,to:roots[i-1].uid,type:'returns'});res.json({project:{uid:p.uid,name:p.name},nodes:objectives.map(row=>({id:row.uid,label:row.title,status:row.status,phase:row.status==='proven'?'completed':row.status==='in_progress'?'active':row.status==='blocked'?'blocked':'planned',priority:row.priority,evidence_count:row.evidence_count,fail_count:row.fail_count,blocker_count:row.blocker_count,reopened:row.reopened,judgment_requested:row.judgment_requested})),edges})})
  api.get('/projects/:project/evidence', (req, res) => {
    const p=projectBy(req.params.project); if(!p) return res.status(404).json({message:'Unknown project.'})
    const objective=req.query.objective?objectiveBy(String(req.query.objective),p.id):null
    if(req.query.objective&&!objective)return res.status(404).json({message:'Unknown objective.'})
    let rows=base().prepare(`SELECT e.*,o.title objective_title,ev.payload event_payload FROM evidence_manifests e
      LEFT JOIN objectives o ON o.id=e.objective_id JOIN events ev ON ev.id=e.event_id
      WHERE e.project_id=?${objective?' AND e.objective_id=?':''} ORDER BY e.created_at DESC`).all(p.id,...(objective?[objective.id]:[]))
      .map((row)=>{const payload=json.read(row.event_payload,{});delete row.event_payload;return{...row,pass_ref:payload.pass_ref||payload.pass||payload.passage_id||(payload.id?`evidence-${payload.id}`:null)}})
    if(req.query.pass)rows=rows.filter((row)=>String(row.pass_ref)===String(req.query.pass))
    res.json(rows)
  })
  api.get('/evidence/:uid/content', (req, res) => {
    const proof=base().prepare('SELECT * FROM evidence_manifests WHERE uid=?').get(req.params.uid)
    if(!proof)return res.status(404).json({message:'Unknown evidence.'})
    if(proof.status!=='available'||proof.locator_kind!=='path'||!proof.locator)return res.status(404).json({message:'This evidence has no available local content.'})
    let path,stat,buffer
    try{path=realpathSync(proof.locator);stat=statSync(path);if(!stat.isFile())throw new Error('not a file');if(stat.size>25*1024*1024)return res.status(413).json({message:'Preview is limited to 25 MB.'});buffer=readFileSync(path)}catch{return res.status(404).json({message:'The referenced file is no longer available.'})}
    if(proof.sha256&&sha(buffer)!==proof.sha256)return res.status(409).json({message:'The file no longer matches its evidence hash.'})
    const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8','.csv':'text/csv; charset=utf-8','.log':'text/plain; charset=utf-8'}
    const type=types[extname(path).toLowerCase()]
    if(!type)return res.status(415).json({message:'This file type is not previewable.'})
    res.set('X-Content-Type-Options','nosniff').set('Content-Security-Policy',"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'").type(type).send(buffer)
  })
  api.get('/evidence/:uid/verify',async(req,res,next)=>{try{const proof=base().prepare('SELECT uid,locator_kind,locator,sha256,bytes,status,retention FROM evidence_manifests WHERE uid=?').get(req.params.uid);if(!proof)return res.status(404).json({message:'Unknown evidence.'});if(proof.locator_kind!=='path'||!proof.locator)return res.json({uid:proof.uid,verification:'not_local',manifest_status:proof.status,retention:proof.retention});let path,stat;try{path=realpathSync(proof.locator);stat=statSync(path);if(!stat.isFile())throw new Error()}catch{return res.json({uid:proof.uid,verification:'missing',manifest_status:proof.status,retention:proof.retention})}const actualSha=await fileSha(path),verification=!proof.sha256?'unverified':actualSha===proof.sha256?'verified':'modified';res.json({uid:proof.uid,verification,manifest_status:proof.status,retention:proof.retention,expected_sha256:proof.sha256,actual_sha256:actualSha,expected_bytes:proof.bytes,actual_bytes:stat.size,size_matches:proof.bytes==null||proof.bytes===stat.size})}catch(error){next(error)}})
  api.post('/ingest', (req, res, next) => {
    try {
      const header = req.get('Idempotency-Key'); const items = Array.isArray(req.body?.events) ? req.body.events : [req.body]
      if (!header) throw new Error('Idempotency-Key header is required.'); if (!items.length || items.length > 100) throw new Error('Send between 1 and 100 events.')
      const output = base().transaction(() => items.map((item, index) => insertEvent(item, `${header}:${index}`)))()
      res.status(output.every((row) => row.duplicate) ? 200 : 201).json({ events: output })
    } catch (error) { next(error) }
  })
  api.get('/export/:kind', (req, res, next) => { try { const p=req.query.project ? projectBy(String(req.query.project)) : null; if(req.params.kind==='json') return res.type('json').send(exportJson(p?.id)); if(req.params.kind==='markdown') return res.type('text/markdown').send(exportMarkdown(p?.id)); res.status(404).json({message:'Use json or markdown.'}) } catch(error){ next(error) } })
  api.post('/import', (req, res, next) => { try { res.status(201).json(importBundle(req.body)) } catch(error){ next(error) } })
  api.post('/memory/analyze',(req,res)=>{const content=String(req.body?.content||'').slice(0,2_000_000),source=String(req.body?.source||'unknown');if(!content.trim())return res.status(400).json({message:'Memory content is empty.'});let bundle=null;try{const parsed=JSON.parse(content);if(parsed?.format==='orchestrator-memory')bundle=parsed}catch{}const paths=[...content.matchAll(/(?:\/Applications\/[^\s"'`]+|[A-Za-z]:\\[^\r\n"']+)/g)].map(match=>match[0]),names=[...content.matchAll(/(?:project|repository|workspace|cwd)\s*[:=]\s*["']?([^\n"']+)/gi)].map(match=>match[1].trim().split(/[\\/]/).filter(Boolean).at(-1)).filter(Boolean);const candidates=[...new Set([...names,...paths.map(path=>path.split(/[\\/]/).filter(Boolean).at(-1))].filter(Boolean))].slice(0,30);res.json({source,bundle,summary:{characters:content.length,candidate_projects:candidates.length,bundle_projects:bundle?.tables?.projects?.length||0},candidates})})
  api.get('/memory/local',(_req,res)=>{const scan=scanLocalMemories(),tracked=base().prepare('SELECT slug,name,description FROM projects').all();res.json({...scan,projects:scan.projects.map(project=>({...project,tracked:tracked.some(row=>row.name.toLowerCase()===project.name.toLowerCase()||row.description?.includes(project.path))}))})})
  api.post('/memory/local/apply',(req,res,next)=>{try{const candidates=Array.isArray(req.body?.projects)?req.body.projects:[],made=[];base().transaction(()=>{for(const candidate of candidates){const name=String(candidate.name||'').trim(),path=String(candidate.path||'').trim();if(!name||!path)continue;let slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');if(projectBy(slug))continue;const id=base().prepare('INSERT INTO projects(uid,slug,name,description) VALUES(?,?,?,?)').run(uid(),slug,name,`Local project discovered from Codex/Claude memory · ${path}`).lastInsertRowid;const p=base().prepare('SELECT * FROM projects WHERE id=?').get(id);insertEvent({project:p.slug,kind:'context.summary',actor_kind:'system',actor:'local memory scan',assertion:'system_record',summary:'Project discovered from local Codex/Claude memory',payload:{path,sources:candidate.sources,sessions:candidate.sessions,last_activity:candidate.last_activity}},`local-scan:${p.uid}`);made.push(p)}})();res.status(201).json({projects:made})}catch(error){next(error)}})
  api.post('/memory/apply',(req,res,next)=>{try{if(req.body?.bundle)return res.status(201).json(importBundle(req.body.bundle));const names=Array.isArray(req.body?.projects)?req.body.projects:[],source=String(req.body?.source||'memory import'),content=String(req.body?.content||'').slice(0,200_000);const made=[];base().transaction(()=>{for(const raw of names){const name=String(raw).trim();if(!name)continue;const slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||`project-${Date.now()}`;let p=projectBy(slug);if(!p){const id=base().prepare('INSERT INTO projects(uid,slug,name,description) VALUES(?,?,?,?)').run(uid(),slug,name,`Discovered from ${source}`).lastInsertRowid;p=base().prepare('SELECT * FROM projects WHERE id=?').get(id)}insertEvent({project:p.slug,kind:'context.summary',actor_kind:'import',actor:source,assertion:'agent_statement',summary:`Memory imported from ${source}`,payload:{excerpt:content.slice(0,20_000),characters:content.length},source},`memory:${source}:${p.uid}:${sha(Buffer.from(content))}`);made.push(p)}})();res.status(201).json({projects:made})}catch(error){next(error)}})
  api.get('/sync', (_req,res)=>res.json(base().prepare(`SELECT c.id,c.provider,c.label,c.enabled,c.target,c.last_status,c.last_detail,c.last_pull_at,c.last_push_at,c.last_local_event_id,
    (SELECT count(*) FROM sync_shards s WHERE s.provider=c.provider) shard_count,
    (SELECT count(*) FROM events e WHERE e.machine_id=? AND e.id>c.last_local_event_id) pending_events
    FROM sync_connections c ORDER BY c.id`).all(machineId())))
  api.post('/sync/:provider', async(req,res,next)=>{try{const connection=base().prepare('SELECT * FROM sync_connections WHERE provider=? AND enabled=1').get(req.params.provider);if(!connection)return res.status(404).json({message:'Sync connection is not configured or enabled.'});const remote=await listJournals(connection),known=new Set(base().prepare('SELECT shard_name FROM sync_shards WHERE provider=?').all(connection.provider).map(row=>row.shard_name));let pulled=0,pulledEvents=0;for(const file of remote.files){if(known.has(file.name))continue;const item=await downloadJournal(connection,remote.access,file),result=importBundle(item.bundle);base().prepare("INSERT OR IGNORE INTO sync_shards(provider,shard_name,remote_id,sha256,machine_id,event_count,direction) VALUES(?,?,?,?,?,?,'pulled')").run(connection.provider,file.name,file.id,item.sha256,item.bundle.machine_id||null,item.bundle.tables?.events?.length||0);pulled++;pulledEvents+=result.imported.events||0}const journal=exportJournal(machineId(),connection.last_local_event_id);let pushed=0,remoteId=null;if(journal.tables.events.length){const body=JSON.stringify(journal),name=journalName(machineId(),journal.cursor,body);remoteId=await uploadJournal(connection,remote.access,name,body);base().prepare("INSERT INTO sync_shards(provider,shard_name,remote_id,sha256,machine_id,event_count,direction) VALUES(?,?,?,?,?,?,'pushed')").run(connection.provider,name,remoteId,journalDigest(body),machineId(),journal.tables.events.length);pushed=journal.tables.events.length}const at=nowStamp(),detail=`${pulled} journal${pulled===1?'':'s'} pulled · ${pulledEvents} events imported · ${pushed} local events published`;base().prepare("UPDATE sync_connections SET last_local_event_id=?,last_status='ok',last_detail=?,last_pull_at=?,last_push_at=? WHERE id=?").run(journal.cursor,detail,at,pushed?at:connection.last_push_at,connection.id);res.json({provider:connection.provider,pulled:{journals:pulled,events:pulledEvents},pushed:{events:pushed,remote_id:remoteId},at})}catch(error){base().prepare("UPDATE sync_connections SET last_status='error',last_detail=? WHERE provider=?").run(String(error.message).slice(0,240),req.params.provider);next(error)}})
  app.use('/api', api)
  app.use(express.static(publicRoot))
  app.get('*', (_req, res) => res.sendFile(join(publicRoot, 'index.html')))
  app.use((error, _req, res, _next) => res.status(error.status || 400).json({ message: error.message }))
  return app
}
