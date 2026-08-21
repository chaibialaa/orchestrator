import { base, json, nowStamp } from './db/index.js'

export const permissionProfiles=[
  {id:'read_only',label:'Lecture seule',description:'Analyse sans modification du projet.',filesystem:'read-only',approvals:'never',web:false,dangerous:false},
  {id:'workspace_guarded',label:'Projet protégé',description:'Écriture dans le projet avec confirmations.',filesystem:'workspace-write',approvals:'on-request',web:false,dangerous:false},
  {id:'workspace_autonomous',label:'Projet autonome',description:'Écriture dans le projet sans confirmation courante.',filesystem:'workspace-write',approvals:'never',web:false,dangerous:false},
  {id:'full_access',label:'Machine complète',description:'Accès non sandboxé. Disponible uniquement sur l’hôte.',filesystem:'danger-full-access',approvals:'never',web:true,dangerous:true},
]

const ids=new Set(permissionProfiles.map(profile=>profile.id))
const key=project=>`permission-policy:${project.uid}`
export const permissionProfile=value=>permissionProfiles.find(profile=>profile.id===(ids.has(value)?value:'workspace_guarded'))

export function projectPermissionPolicy(project){
  const stored=json.read(base().prepare('SELECT value FROM management_settings WHERE key=?').get(key(project))?.value,{})
  return{default_profile:ids.has(stored.default_profile)?stored.default_profile:'workspace_guarded',profiles:permissionProfiles}
}

export function saveProjectPermissionPolicy(project,input={}){
  const value={default_profile:ids.has(input.default_profile)?input.default_profile:'workspace_guarded'}
  base().prepare("INSERT INTO management_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key(project),json.write(value),nowStamp())
  return{...value,profiles:permissionProfiles}
}

export function resolvePermissionOptions(provider,input={},project=null,fallback=null){
  const requested=ids.has(input.permission_profile)?input.permission_profile:ids.has(fallback)?fallback:project?projectPermissionPolicy(project).default_profile:'workspace_guarded',profile=permissionProfile(requested),dangerous=Boolean(input.dangerously_bypass||profile.dangerous),options={...input,permission_profile:profile.id}
  if(provider==='codex')Object.assign(options,{sandbox:profile.filesystem,approval_policy:profile.approvals==='never'?'never':'on-request',search:Boolean(input.search||profile.web),dangerously_bypass:dangerous})
  if(provider==='claude')Object.assign(options,{permission_mode:profile.filesystem==='read-only'?'plan':dangerous?'dontAsk':profile.approvals==='never'?'acceptEdits':'auto',dangerously_bypass:dangerous})
  if(provider==='gemini')Object.assign(options,{approval_mode:dangerous?'yolo':profile.filesystem==='workspace-write'&&profile.approvals==='never'?'auto_edit':'default',sandbox:!dangerous&&profile.filesystem!=='danger-full-access',dangerously_bypass:dangerous})
  if(provider==='copilot')Object.assign(options,{allow_all:dangerous,dangerously_bypass:dangerous})
  if(provider==='opencode')Object.assign(options,{opencode_permissions:{edit:profile.filesystem==='read-only'?'deny':profile.approvals==='never'?'allow':'ask',bash:profile.filesystem==='read-only'?'deny':profile.approvals==='never'?'allow':'ask',webfetch:profile.web?'allow':'ask'}})
  return options
}
