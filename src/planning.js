import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { base, nowStamp, uid } from './db/index.js'
import { scanLocalMemories } from './local-memory.js'
import { optimizeImageTransport } from './media.js'

const digest=value=>createHash('sha256').update(value).digest('hex')
const fingerprint=(project,kind,title,sourceRef='')=>digest([project.id,kind,title.trim().toLowerCase(),sourceRef].join(':'))
const clean=value=>String(value||'').trim().slice(0,4000)
const activeSyncs=new Set()

export function clickupStatusFor(proposalStatus,statuses=[]){
  const rows=statuses.map(row=>({name:String(row.status||'').trim(),type:String(row.type||'').toLowerCase()})).filter(row=>row.name),find=(names,types=[])=>names.map(name=>rows.find(row=>row.name.toLowerCase()===name)).find(Boolean)?.name||rows.find(row=>types.includes(row.type))?.name
  if(proposalStatus==='approved')return find(['ready for development','ready','to do','open'],['open'])||rows[0]?.name
  if(proposalStatus==='published')return find(['shipped','complete','completed','done','closed'],['done','closed'])||rows.at(-1)?.name
  if(['rejected','superseded'].includes(proposalStatus))return find(['cancelled','canceled','rejected','closed'],['closed'])||rows.at(-1)?.name
  return find(['scoping','backlog','proposed','open'],['open'])||rows[0]?.name
}
const statusMapping=value=>{try{const parsed=JSON.parse(value||'{}');return Object.fromEntries(['proposed','approved','published','rejected','superseded'].filter(key=>typeof parsed[key]==='string'&&parsed[key].trim()).map(key=>[key,parsed[key].trim()]))}catch{return{}}}

export function proposals(project){
  return base().prepare(`SELECT w.*,o.uid objective_uid,o.title objective_title,l.ticket_id,l.ticket_url,l.ticket_status
    FROM work_proposals w LEFT JOIN objectives o ON o.id=w.objective_id LEFT JOIN clickup_ticket_links l ON l.proposal_id=w.id
    WHERE w.project_id=? ORDER BY CASE w.status WHEN 'proposed' THEN 0 ELSE 1 END,w.created_at DESC`).all(project.id)
}

export function generateProposals(project,input={}){
  const db=base(),created=[],insert=db.prepare(`INSERT OR IGNORE INTO work_proposals
    (uid,project_id,objective_id,kind,title,body,success_criteria,rationale,source_kind,source_ref,fingerprint)
    VALUES(@uid,@project_id,@objective_id,@kind,@title,@body,@success_criteria,@rationale,@source_kind,@source_ref,@fingerprint)`)
  const add=input=>{const row={uid:uid(),project_id:project.id,objective_id:null,body:null,success_criteria:null,source_ref:null,...input};row.title=clean(row.title);row.fingerprint=fingerprint(project,row.kind,row.title,row.source_ref||'');const result=insert.run(row);if(result.changes)created.push(row)}
  const need=clean(input.need)
  if(need){const title=clean(need.split(/[.!?\n]/)[0]).slice(0,140)||'User-requested project chapter';add({kind:'chapter',title,body:need,success_criteria:clean(input.success_criteria)||'The requested outcome is demonstrated by reviewable evidence.',rationale:'The user explicitly requested a new planning scope. Human approval is still required before it becomes a chapter.',source_kind:'human',source_ref:`need:${digest(need)}`})}
  const unfinished=db.prepare("SELECT * FROM objectives WHERE project_id=? AND status IN ('draft','ready','in_progress','blocked') ORDER BY priority,id").all(project.id)
  for(const objective of unfinished.filter(row=>row.status==='blocked'))add({objective_id:objective.id,kind:'corrective',title:`Unblock: ${objective.title}`,body:objective.intent,success_criteria:objective.success_criteria,rationale:'The current project state records this objective as blocked.',source_kind:'project_state',source_ref:`objective:${objective.uid}`})
  const blockers=db.prepare("SELECT b.uid,b.title,b.detail,b.objective_id,o.uid objective_uid,o.success_criteria FROM blockers b LEFT JOIN objectives o ON o.id=b.objective_id WHERE b.project_id=? AND b.status='open' ORDER BY b.created_at DESC").all(project.id)
  for(const blocker of blockers)add({objective_id:blocker.objective_id,kind:'corrective',title:`Resolve blocker: ${blocker.title}`,body:blocker.detail,success_criteria:blocker.success_criteria||'Record evidence that the blocker is resolved.',rationale:'An open blocker is recorded for this project.',source_kind:'project_state',source_ref:`blocker:${blocker.uid}`})
  const failed=db.prepare("SELECT v.uid,v.rationale,o.id objective_id,o.uid objective_uid,o.title FROM verdicts v LEFT JOIN objectives o ON o.id=v.objective_id WHERE v.project_id=? AND v.verdict='fail' ORDER BY v.created_at DESC LIMIT 50").all(project.id)
  for(const verdict of failed)add({objective_id:verdict.objective_id,kind:'corrective',title:`Correct rejected result: ${verdict.title||'project finding'}`,body:verdict.rationale,success_criteria:'Supply new evidence that directly resolves the rejected finding.',rationale:'A failed verdict requires a new bounded correction, linked to the original finding.',source_kind:'project_state',source_ref:`verdict:${verdict.uid}`})
  const memory=scanLocalMemories().projects.find(row=>project.description?.includes(row.path)||row.name.toLowerCase()===project.name.toLowerCase())
  if(memory&&unfinished.length===0)add({kind:'chapter',title:'Review recent local AI work',body:`Review ${memory.sessions} local Codex/Claude sessions associated with ${memory.path}.`,success_criteria:'Relevant changes, decisions and proofs are recorded or explicitly dismissed.',rationale:`Local ${memory.sources.join(' and ')} memory changed on ${memory.last_activity}, but no unfinished objective is recorded.`,source_kind:memory.sources.includes('codex')?'codex_memory':'claude_memory',source_ref:`memory:${memory.path}:${memory.last_activity}`})
  return {created:created.length,proposals:proposals(project)}
}

export function reviewProposal(project,proposalUid,status,reviewer='human'){
  if(!['approved','rejected'].includes(status))throw new Error('Review status must be approved or rejected.')
  const db=base(),proposal=db.prepare('SELECT * FROM work_proposals WHERE uid=? AND project_id=?').get(proposalUid,project.id)
  if(!proposal)throw new Error('Unknown proposal.')
  if(proposal.status!=='proposed')throw new Error('Only proposed work can be reviewed.')
  const tx=db.transaction(()=>{
    db.prepare('UPDATE work_proposals SET status=?,reviewed_at=?,reviewed_by=? WHERE id=?').run(status,nowStamp(),clean(reviewer)||'human',proposal.id)
    if(status==='approved'){
      const parent=proposal.objective_id||null,objectiveUid=uid(),objectiveStatus='ready'
      db.prepare(`INSERT INTO objectives(uid,project_id,parent_id,title,intent,success_criteria,status,priority,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(objectiveUid,project.id,parent,proposal.title,proposal.body,proposal.success_criteria,objectiveStatus,50,nowStamp(),nowStamp())
      db.prepare('UPDATE work_proposals SET objective_id=? WHERE id=?').run(Number(db.prepare('SELECT id FROM objectives WHERE uid=?').get(objectiveUid).id),proposal.id)
    }
  });tx();return proposals(project).find(row=>row.uid===proposalUid)
}

function storedClickupAccount(){return base().prepare('SELECT * FROM clickup_accounts WHERE id=1').get()}
function clickupToken(){return process.env.CLICKUP_API_TOKEN||storedClickupAccount()?.token}
function saveClickupAccount(token,workspaceId=null,authKind='personal'){if(!clean(token))return;const db=base();db.prepare(`INSERT INTO clickup_accounts(id,token,auth_kind,workspace_id,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,auth_kind=excluded.auth_kind,workspace_id=COALESCE(excluded.workspace_id,clickup_accounts.workspace_id),updated_at=excluded.updated_at`).run(clean(token),authKind,workspaceId,nowStamp());db.prepare('UPDATE clickup_connections SET token=NULL').run()}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function clickup(path,token,options={}){for(let attempt=0;attempt<4;attempt++){try{const response=await fetch(`https://api.clickup.com/api/v2${path}`,{...options,headers:{Authorization:token,'Content-Type':'application/json',...(options.headers||{})}}),text=await response.text();if(response.ok)return text?JSON.parse(text):{};if(response.status===429&&attempt<3){const retry=Number(response.headers.get('retry-after')||0)*1000,reset=Number(response.headers.get('x-ratelimit-reset')||0)*1000-Date.now(),delay=Math.min(60000,Math.max(1000,retry,reset,2**attempt*2000));await wait(delay);continue}throw new Error(`ClickUp ${response.status}: ${text.slice(0,300)}`)}catch(error){if(attempt===3||String(error.message||error).startsWith('ClickUp '))throw error;await wait(1000*2**attempt)}}}
async function clickupAttachment(taskId,token,path,mime){const original=readFileSync(path),transport=await optimizeImageTransport(original,{path,mime}),extension=transport.optimized?transport.extension:'',name=transport.optimized?`${basename(path,extname(path))}${extension}`:basename(path);for(let attempt=0;attempt<3;attempt++){const form=new FormData();form.append('attachment',new Blob([transport.buffer],{type:transport.mime}),name);const response=await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}/attachment`,{method:'POST',headers:{Authorization:token},body:form});if(response.ok)return transport;if(response.status===429&&attempt<2){await wait(Math.min(60000,Math.max(2000,Number(response.headers.get('retry-after')||0)*1000)));continue}throw new Error(`ClickUp attachment ${response.status}`)}}
async function clickupIgnore(path,token,options={}){try{return await clickup(path,token,options)}catch{return null}}

export function clickupOauthConfig(origin='http://127.0.0.1:4173'){return{available:Boolean(process.env.CLICKUP_CLIENT_ID&&process.env.CLICKUP_CLIENT_SECRET),client_id:process.env.CLICKUP_CLIENT_ID||null,redirect_uri:process.env.CLICKUP_REDIRECT_URI||`${origin}/api/clickup/oauth/callback`,setup_url:'https://app.clickup.com/settings/apps'}}
export async function exchangeClickupCode(code,redirectUri){const response=await fetch('https://api.clickup.com/api/v2/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.CLICKUP_CLIENT_ID,client_secret:process.env.CLICKUP_CLIENT_SECRET,code,redirect_uri:redirectUri})}),text=await response.text();if(!response.ok)throw new Error(`ClickUp OAuth ${response.status}: ${text.slice(0,300)}`);return JSON.parse(text).access_token}
export async function connectClickupOauth(project,token,authKind='personal'){const teams=await clickup('/team',token),workspace=teams.teams?.[0];saveClickupAccount(token,workspace?.id||null,authKind);base().prepare(`INSERT INTO clickup_connections(project_id,workspace_id,list_id,enabled,last_status,last_detail,updated_at) VALUES(?,?,?,1,'ok',?,?) ON CONFLICT(project_id) DO UPDATE SET workspace_id=excluded.workspace_id,enabled=1,last_status='ok',last_detail=excluded.last_detail,updated_at=excluded.updated_at`).run(project.id,workspace?.id||null,'','ClickUp account connected globally. Choose this project destination list.',nowStamp());return clickupConnection(project)}
export function clickupConnection(project,origin){const row=base().prepare('SELECT * FROM clickup_connections WHERE project_id=?').get(project.id),account=storedClickupAccount(),oauth=clickupOauthConfig(origin),statuses=base().prepare("SELECT COALESCE(ticket_status,'unknown') status,count(*) count FROM clickup_ticket_links WHERE project_id=? GROUP BY COALESCE(ticket_status,'unknown') ORDER BY count DESC").all(project.id),proposalCounts=base().prepare('SELECT status,count(*) count FROM work_proposals WHERE project_id=? GROUP BY status').all(project.id),credential=process.env.CLICKUP_API_TOKEN?'environment':account?'configured':null;return row?{...row,token:credential,account_scope:'global',status_mapping:statusMapping(row.status_mapping),tag_name:row.tag_name||project.slug,connected:Boolean(credential),oauth,progress:{tickets:statuses.reduce((sum,item)=>sum+item.count,0),statuses,proposals:proposalCounts}}:{connected:Boolean(credential),account_scope:'global',status_mapping:{},tag_name:project.slug,token:credential,oauth,progress:{tickets:0,statuses:[],proposals:proposalCounts}}}

export async function clickupResources(){const token=clickupToken();if(!token)throw new Error('Connect ClickUp first.');const teams=(await clickup('/team',token)).teams||[],workspaces=teams.map(team=>({id:String(team.id),name:team.name})),lists=[];for(const team of teams){const spaces=(await clickup(`/team/${encodeURIComponent(team.id)}/space?archived=false`,token)).spaces||[];for(const space of spaces){const direct=(await clickup(`/space/${encodeURIComponent(space.id)}/list?archived=false`,token)).lists||[];for(const list of direct)lists.push({id:String(list.id),name:list.name,statuses:list.statuses||[],workspace_id:String(team.id),workspace_name:team.name,space_name:space.name,folder_name:null});const folders=(await clickup(`/space/${encodeURIComponent(space.id)}/folder?archived=false`,token)).folders||[];for(const folder of folders)for(const list of folder.lists||[])lists.push({id:String(list.id),name:list.name,statuses:list.statuses||[],workspace_id:String(team.id),workspace_name:team.name,space_name:space.name,folder_name:folder.name})}}return{workspaces,lists}}
export async function clickupListStatuses(_project,listId){const token=clickupToken();if(!token)throw new Error('Connect ClickUp first.');const list=await clickup(`/list/${encodeURIComponent(clean(listId))}`,token);return{list_id:String(list.id),statuses:(list.statuses||[]).map(row=>({status:row.status,type:row.type,orderindex:row.orderindex}))}}

export function saveClickupConnection(project,input){const listId=clean(input.list_id),tagName=clean(input.tag_name)||project.slug,mapping=JSON.stringify(statusMapping(JSON.stringify(input.status_mapping||{})));if(!listId)throw new Error('ClickUp list_id is required.');if(clean(input.token))saveClickupAccount(input.token,clean(input.workspace_id)||null);base().prepare(`INSERT INTO clickup_connections(project_id,workspace_id,list_id,tag_name,status_mapping,token,enabled,updated_at)
  VALUES(?,?,?,?,?,NULL,?,?) ON CONFLICT(project_id) DO UPDATE SET workspace_id=excluded.workspace_id,list_id=excluded.list_id,tag_name=excluded.tag_name,status_mapping=excluded.status_mapping,token=NULL,enabled=excluded.enabled,updated_at=excluded.updated_at`).run(project.id,clean(input.workspace_id)||null,listId,tagName,mapping,input.enabled===false?0:1,nowStamp());return clickupConnection(project)}

export async function syncClickup(project,onProgress=()=>{},{trigger='manual'}={}){
  const db=base(),connection=db.prepare('SELECT * FROM clickup_connections WHERE project_id=? AND enabled=1').get(project.id);if(!connection)throw new Error('ClickUp is not enabled for this project.');if(!connection.list_id)throw new Error('Choose a ClickUp destination list first.');const token=clickupToken();if(!token)throw new Error('Connect the global ClickUp account first.')
  if(activeSyncs.has(project.id))throw new Error('ClickUp synchronization is already active for this project.')
  activeSyncs.add(project.id)
  const run=base().prepare("INSERT INTO clickup_sync_runs(project_id,trigger,status,percent,message,started_at) VALUES(?,?,'running',0,'Starting synchronization',?)").run(project.id,trigger==='scheduled'?'scheduled':'manual',nowStamp()),runId=Number(run.lastInsertRowid),report=onProgress
  onProgress=(percent,message)=>{report(percent,message);base().prepare('UPDATE clickup_sync_runs SET percent=?,message=? WHERE id=?').run(percent,message,runId)}
  let created=0,updated=0,attachments=0,importedRejected=0
  try{
    onProgress(5,'Connecting to ClickUp')
    const list=await clickup(`/list/${encodeURIComponent(connection.list_id)}`,token),spaceId=list.space?.id,tagName=connection.tag_name||project.slug,listStatuses=list.statuses||[],customStatuses=statusMapping(connection.status_mapping)
    onProgress(15,'Checking project tag')
    if(spaceId){const tags=await clickup(`/space/${encodeURIComponent(spaceId)}/tag`,token),exists=(tags.tags||[]).some(tag=>String(tag.name).toLowerCase()===tagName.toLowerCase());if(!exists)await clickup(`/space/${encodeURIComponent(spaceId)}/tag`,token,{method:'POST',body:JSON.stringify({tag:{name:tagName,tag_fg:'#ffffff',tag_bg:'#247a5a'}})})}
    const lifecycle={proposed:'orchestrator-backlog',approved:'orchestrator-ready',rejected:'orchestrator-rejected',published:'orchestrator-published',superseded:'orchestrator-superseded'},proposalRows=db.prepare("SELECT * FROM work_proposals WHERE project_id=? ORDER BY id").all(project.id),allTags=[...new Set(Object.values(lifecycle))]
    if(spaceId){const existingTags=(await clickup(`/space/${encodeURIComponent(spaceId)}/tag`,token)).tags||[];for(const name of allTags){if(!existingTags.some(tag=>String(tag.name).toLowerCase()===name))await clickup(`/space/${encodeURIComponent(spaceId)}/tag`,token,{method:'POST',body:JSON.stringify({tag:{name,tag_fg:'#ffffff',tag_bg:name.includes('rejected')?'#a55332':'#557565'}})})}}
    let proposalIndex=0
    for(const proposal of proposalRows){proposalIndex++;onProgress(20+Math.round(45*proposalIndex/Math.max(1,proposalRows.length)),`Synchronizing registry ${proposalIndex}/${proposalRows.length}`);const fp=`proposal:${proposal.fingerprint}`,existing=db.prepare('SELECT * FROM clickup_ticket_links WHERE fingerprint=?').get(fp),objective=proposal.objective_id?db.prepare('SELECT id,parent_id FROM objectives WHERE id=?').get(proposal.objective_id):null,proofScope=[objective?.id,objective?.parent_id].filter(Boolean),proofs=proofScope.length?db.prepare(`SELECT e.label,e.sha256,e.locator,e.locator_kind,e.bytes FROM evidence_manifests e WHERE e.project_id=? AND e.objective_id IN (${proofScope.map(()=>'?').join(',')}) ORDER BY e.created_at DESC LIMIT 20`).all(project.id,...proofScope):db.prepare('SELECT label,sha256,locator,locator_kind,bytes FROM evidence_manifests WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(project.id),stateTag=lifecycle[proposal.status]||'orchestrator-backlog',desiredStatus=customStatuses[proposal.status]||clickupStatusFor(proposal.status,listStatuses)
      const description=[`Orchestrator status: ${proposal.status}`,`Source: ${proposal.source_kind}${proposal.source_ref?` · ${proposal.source_ref}`:''}`,proposal.body,proposal.rationale&&`Rationale: ${proposal.rationale}`,proposal.success_criteria&&`Success criteria: ${proposal.success_criteria}`,`Project: ${project.name}`,proofs.length?`Evidence manifests:\n${proofs.map(p=>`- ${p.label} · sha256:${p.sha256||'unhashed'}${p.locator_kind==='url'&&/^https?:\/\//.test(p.locator||'')?` · ${p.locator}`:''}`).join('\n')}`:'Evidence manifests: none recorded'].filter(Boolean).join('\n\n')
      const syncHash=digest(JSON.stringify({title:proposal.title,description,stateTag,tagName,desiredStatus}));let task
      if(existing&&!existing.sync_hash){db.prepare('UPDATE clickup_ticket_links SET sync_hash=?,last_seen_at=? WHERE id=?').run(syncHash,nowStamp(),existing.id);continue}
      if(existing&&existing.sync_hash===syncHash)continue
      if(existing){task=await clickup(`/task/${encodeURIComponent(existing.ticket_id)}`,token,{method:'PUT',body:JSON.stringify({name:proposal.title,description,status:desiredStatus})});updated++;for(const oldTag of allTags.filter(name=>name!==stateTag))await clickupIgnore(`/task/${encodeURIComponent(existing.ticket_id)}/tag/${encodeURIComponent(oldTag)}`,token,{method:'DELETE'});await clickupIgnore(`/task/${encodeURIComponent(existing.ticket_id)}/tag/${encodeURIComponent(stateTag)}`,token,{method:'POST'});db.prepare('UPDATE clickup_ticket_links SET ticket_status=?,ticket_url=?,sync_hash=?,last_seen_at=? WHERE id=?').run(task.status?.status||desiredStatus||existing.ticket_status,task.url||existing.ticket_url,syncHash,nowStamp(),existing.id)
      }else{task=await clickup(`/list/${encodeURIComponent(connection.list_id)}/task`,token,{method:'POST',body:JSON.stringify({name:proposal.title,description,status:desiredStatus,tags:[tagName,stateTag]})});db.prepare(`INSERT INTO clickup_ticket_links(project_id,proposal_id,objective_id,ticket_id,ticket_url,ticket_status,sync_hash,fingerprint,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(project.id,proposal.id,proposal.objective_id,task.id,task.url,task.status?.status||desiredStatus||null,syncHash,fp,nowStamp());created++;for(const proof of proofs.filter(p=>p.locator_kind==='path'&&p.locator&&existsSync(p.locator)&&statSync(p.locator).isFile()&&statSync(p.locator).size<=10*1024*1024).slice(0,10)){try{await clickupAttachment(task.id,token,proof.locator,proof.mime);attachments++}catch{}}
      }
    }
    onProgress(70,'Reading ClickUp ticket states')
    const remoteTasks=[];for(let page=0;page<100;page++){const remote=await clickup(`/list/${encodeURIComponent(connection.list_id)}/task?include_closed=true&subtasks=true&page=${page}`,token),rows=remote.tasks||[];remoteTasks.push(...rows);onProgress(Math.min(88,75+page*3),`Reading ticket page ${page+1}`);if(rows.length<100)break}
    const rejected=/^(rejected|refused|declined|failed)$/i
    onProgress(90,'Analysing rejected tickets')
    for(const task of remoteTasks){const status=task.status?.status||'';db.prepare('UPDATE clickup_ticket_links SET ticket_status=?,ticket_url=?,last_seen_at=? WHERE project_id=? AND ticket_id=?').run(status,task.url||null,nowStamp(),project.id,task.id);if(!rejected.test(status))continue;const fp=`clickup-rejected:${task.id}:${status}`,title=`Rework rejected ticket: ${task.name}`,proposalFp=fingerprint(project,'corrective',title,fp),result=db.prepare(`INSERT OR IGNORE INTO work_proposals(uid,project_id,kind,title,body,rationale,source_kind,source_ref,fingerprint) VALUES(?,?,?,?,?,?,?,?,?)`).run(uid(),project.id,'corrective',title,task.description||null,`ClickUp ticket ${task.id} is ${status}. Review the rejection before approving a bounded correction.`,'rejected_ticket',fp,proposalFp);if(result.changes)importedRejected++
      db.prepare(`INSERT INTO clickup_ticket_links(project_id,ticket_id,ticket_url,ticket_status,fingerprint,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET ticket_status=excluded.ticket_status,ticket_url=excluded.ticket_url,last_seen_at=excluded.last_seen_at`).run(project.id,task.id,task.url,status,fp,nowStamp())
    }
    db.prepare("UPDATE clickup_connections SET last_status='ok',last_detail=?,last_sync_at=?,updated_at=? WHERE id=?").run(`${created} created · ${updated} updated · ${attachments} evidence files attached · ${importedRejected} rejected tickets proposed`,nowStamp(),nowStamp(),connection.id)
    db.prepare("UPDATE clickup_sync_runs SET status='ok',percent=100,message='Synchronization complete',created=?,updated=?,attachments=?,rejected_imported=?,finished_at=? WHERE id=?").run(created,updated,attachments,importedRejected,nowStamp(),runId)
    onProgress(100,'Synchronization complete')
    return {created,updated,attachments,imported_rejected:importedRejected,proposals:proposals(project)}
  }catch(error){db.prepare("UPDATE clickup_connections SET last_status='error',last_detail=?,updated_at=? WHERE id=?").run(String(error.message||error).slice(0,500),nowStamp(),connection.id);db.prepare("UPDATE clickup_sync_runs SET status='error',message=?,finished_at=? WHERE id=?").run(String(error.message||error).slice(0,500),nowStamp(),runId);throw error}finally{activeSyncs.delete(project.id)}
}

export const clickupSchedulerState={enabled:false,minutes:0,next_run_at:null,last_started_at:null}
export function startClickupScheduler(minutes=Number(process.env.ORCHESTRATOR_CLICKUP_SYNC_MINUTES||5)){
  if(!Number.isFinite(minutes)||minutes<=0)return null
  const interval=Math.max(1,minutes)*60000;clickupSchedulerState.enabled=true;clickupSchedulerState.minutes=Math.max(1,minutes);clickupSchedulerState.next_run_at=new Date(Date.now()+interval).toISOString()
  const tick=async()=>{clickupSchedulerState.last_started_at=nowStamp();clickupSchedulerState.next_run_at=new Date(Date.now()+interval).toISOString();const rows=base().prepare("SELECT p.* FROM projects p JOIN clickup_connections c ON c.project_id=p.id WHERE p.status!='archived' AND c.enabled=1 AND c.list_id!='' ORDER BY p.id").all();for(const project of rows){try{await syncClickup(project,()=>{},{trigger:'scheduled'})}catch{}}}
  const timer=setInterval(tick,interval);timer.unref();return timer
}
