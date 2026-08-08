import { base, json, nowStamp } from './index.js'

const comparable=row=>JSON.stringify({title:row.title,intent:row.intent??null,success_criteria:row.success_criteria??null,status:row.status,priority:row.priority})
function recordConflict(db,bundle,row,local,provider){
  const incoming=comparable(row),existing=comparable(local);if(incoming===existing)return
  const key=`objective:${row.uid}:${Buffer.from(existing+incoming).toString('base64url').slice(0,80)}`
  db.prepare(`INSERT OR IGNORE INTO sync_conflicts(uid,provider,entity_type,entity_uid,local_value,incoming_value,incoming_machine_id,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(key,provider||null,'objective',row.uid,existing,incoming,bundle.machine_id||null,nowStamp())
}

export function importBundle(bundle,{provider=null}={}) {
  if (bundle?.format !== 'orchestrator-memory' || bundle?.version !== 1 || !bundle.tables) throw new Error('Unsupported import format.')
  const inserted = {}
  base().transaction(() => {
    const projectMap = new Map(); const objectiveMap = new Map(); const eventMap = new Map()
    for (const row of bundle.tables.projects || []) { base().prepare('INSERT INTO projects(uid,slug,name,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(uid) DO NOTHING').run(row.uid,row.slug,row.name,row.description,row.status,row.created_at,row.updated_at); projectMap.set(row.id,base().prepare('SELECT id FROM projects WHERE uid=?').get(row.uid).id) }
    for (const row of bundle.tables.objectives || []) { const p=projectMap.get(row.project_id); if(!p) continue;const local=base().prepare('SELECT * FROM objectives WHERE uid=?').get(row.uid);if(local)recordConflict(base(),bundle,row,local,provider);base().prepare('INSERT INTO objectives(uid,project_id,parent_id,title,intent,success_criteria,status,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO NOTHING').run(row.uid,p,null,row.title,row.intent,row.success_criteria,row.status,row.priority,row.created_at,row.updated_at); objectiveMap.set(row.id,base().prepare('SELECT id FROM objectives WHERE uid=?').get(row.uid).id) }
    for(const row of bundle.tables.objectives||[]){if(!row.parent_id)continue;const id=objectiveMap.get(row.id),parent=objectiveMap.get(row.parent_id);if(id&&parent)base().prepare('UPDATE objectives SET parent_id=? WHERE id=? AND parent_id IS NULL').run(parent,id)}
    inserted.objective_dependencies=0
    for(const row of bundle.tables.objective_dependencies||[]){const p=projectMap.get(row.project_id),objective=objectiveMap.get(row.objective_id),dependsOn=objectiveMap.get(row.depends_on_id);if(!p||!objective||!dependsOn)continue;inserted.objective_dependencies+=base().prepare('INSERT OR IGNORE INTO objective_dependencies(project_id,objective_id,depends_on_id,created_at) VALUES(?,?,?,?)').run(p,objective,dependsOn,row.created_at||nowStamp()).changes}
    for (const row of bundle.tables.events || []) { const p=projectMap.get(row.project_id); if(!p) continue; base().prepare('INSERT INTO events(uid,project_id,objective_id,kind,actor_kind,actor,assertion,summary,payload,occurred_at,recorded_at,idempotency_key,source,machine_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO NOTHING').run(row.uid,p,objectiveMap.get(row.objective_id)||null,row.kind,row.actor_kind,row.actor,row.assertion,row.summary,json.write(row.payload),row.occurred_at,row.recorded_at,`import:${row.uid}`,row.source,row.machine_id||bundle.machine_id||null); eventMap.set(row.id,base().prepare('SELECT id FROM events WHERE uid=?').get(row.uid).id) }
    const simple = ['evidence_manifests','decisions','blockers','verdicts','costs','cleanups']
    for (const table of simple) { inserted[table]=0; for(const row of bundle.tables[table]||[]){ const p=projectMap.get(row.project_id),e=eventMap.get(row.event_id); if(!p||!e) continue; const copy={...row,project_id:p,event_id:e,objective_id:objectiveMap.get(row.objective_id)||null}; delete copy.id; const fields=Object.keys(copy); const result=base().prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')}) ON CONFLICT(uid) DO NOTHING`).run(...fields.map((field)=>copy[field])); inserted[table]+=result.changes } }
    inserted.work_proposals=0
    const proposalMap=new Map()
    for(const row of bundle.tables.work_proposals||[]){const p=projectMap.get(row.project_id);if(!p)continue;const copy={...row,project_id:p,objective_id:objectiveMap.get(row.objective_id)||null};delete copy.id;const fields=Object.keys(copy),result=base().prepare(`INSERT INTO work_proposals(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')}) ON CONFLICT(fingerprint) DO NOTHING`).run(...fields.map(field=>copy[field]));inserted.work_proposals+=result.changes;proposalMap.set(row.id,base().prepare('SELECT id FROM work_proposals WHERE fingerprint=?').get(row.fingerprint).id)}
    inserted.clickup_ticket_links=0
    for(const row of bundle.tables.clickup_ticket_links||[]){const p=projectMap.get(row.project_id);if(!p)continue;const copy={...row,project_id:p,proposal_id:proposalMap.get(row.proposal_id)||null,objective_id:objectiveMap.get(row.objective_id)||null};delete copy.id;const fields=Object.keys(copy),result=base().prepare(`INSERT INTO clickup_ticket_links(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')}) ON CONFLICT(fingerprint) DO NOTHING`).run(...fields.map(field=>copy[field]));inserted.clickup_ticket_links+=result.changes}
    inserted.projects=projectMap.size; inserted.objectives=objectiveMap.size; inserted.events=eventMap.size
  })()
  return { imported: inserted }
}
