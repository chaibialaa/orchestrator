import { watch, existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { base } from './db/index.js'
import { readTracking, setTracking } from './tracking.js'

const ignored=new Set(['.git/objects','.git/logs','node_modules','Library','Temp','Logs','obj','dist','build','coverage','.cache'])
const followers=new Map()
const state={active:false,started_at:null,last_change_at:null,errors:[],timer:null,reconcile:null}
const repository=project=>String(project.description||'').match(/Repository:\s*(.+)/i)?.[1]?.trim()||null
const ignoredPath=value=>!value||value==='.orchestrator.json'||[...ignored].some(prefix=>value===prefix||value.startsWith(`${prefix}/`))
function refValue(git,ref){const path=join(git,ref);if(existsSync(path))return readFileSync(path,'utf8').trim();try{return readFileSync(join(git,'packed-refs'),'utf8').split('\n').find(line=>line.endsWith(` ${ref}`))?.split(' ')[0]||null}catch{return null}}
function gitHead(root){try{const dot=join(root,'.git'),git=statSync(dot).isDirectory()?dot:join(root,readFileSync(dot,'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]||'.git'),head=readFileSync(join(git,'HEAD'),'utf8').trim();if(!head.startsWith('ref: '))return{branch:'detached',head_commit:head,dirty:true,upstream:null,upstream_commit:null,remote_verified:false};const ref=head.slice(5),branch=ref.replace('refs/heads/',''),head_commit=refValue(git,ref)||'unknown',config=readFileSync(join(git,'config'),'utf8'),section=config.match(new RegExp(`\\[branch "${branch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"\\]([\\s\\S]*?)(?=\\n\\[|$)`))?.[1]||'',remote=section.match(/^\s*remote\s*=\s*(.+)$/m)?.[1]?.trim(),merge=section.match(/^\s*merge\s*=\s*refs\/heads\/(.+)$/m)?.[1]?.trim(),upstream=remote&&merge?`${remote}/${merge}`:null,upstream_commit=upstream?refValue(git,`refs/remotes/${upstream}`):null;return{branch,head_commit,dirty:true,upstream,upstream_commit,ahead:null,behind:null,remote_verified:Boolean(upstream_commit&&upstream_commit===head_commit)}}catch{return null}}
function projects(){return base().prepare("SELECT * FROM projects WHERE status!='archived' AND description LIKE '%Repository:%'").all()}
export function passiveFollowerState(){const {timer:_timer,reconcile:_reconcile,...visible}=state;return{...visible,projects:[...followers.values()].map(row=>({slug:row.project.slug,root:row.root,pending:row.paths.size,last_change_at:row.last_change_at||null}))}}
export function startPassiveFollowers({onBatch,onPlan,debounceMs=1500,rescanMs=30000}={}){
  if(state.active)return passiveFollowerState()
  state.active=true;state.started_at=new Date().toISOString()
  const attach=project=>{if(followers.has(project.slug))return;const root=repository(project);if(!root||!existsSync(root))return;let config=readTracking(root);if(config&&config.version!==2){setTracking(config.enabled!==false,{root,project:project.slug,name:project.name});config=readTracking(root)}if(!config||config.enabled===false)return;const row={project,root,paths:new Set(),timer:null,last_change_at:null,watcher:null};try{row.watcher=watch(root,{recursive:true},(_event,filename)=>{const path=String(filename||'').replaceAll('\\','/');if(ignoredPath(path)||path===basename(root))return;row.paths.add(path);row.last_change_at=new Date().toISOString();state.last_change_at=row.last_change_at;clearTimeout(row.timer);row.timer=setTimeout(()=>{const paths=[...row.paths].sort().slice(0,200);row.paths.clear();onBatch?.({project:row.project,root:row.root,paths,git:gitHead(row.root),observed_at:new Date().toISOString()})},debounceMs)});followers.set(project.slug,row);onPlan?.(project)}catch(error){state.errors.push({project:project.slug,message:error.message,at:new Date().toISOString()});state.errors=state.errors.slice(-20)}}
  const reconcile=()=>{for(const project of projects())attach(project);for(const [slug,row] of followers){const current=base().prepare('SELECT status FROM projects WHERE slug=?').get(slug);if(!current||current.status==='archived'){row.watcher.close();clearTimeout(row.timer);followers.delete(slug)}}}
  state.reconcile=reconcile;reconcile();state.timer=setInterval(reconcile,rescanMs);state.timer.unref();return passiveFollowerState()
}
export function refreshPassiveFollowers(){state.reconcile?.();return passiveFollowerState()}
export function stopPassiveFollowers(){if(state.timer)clearInterval(state.timer);for(const row of followers.values()){row.watcher.close();clearTimeout(row.timer)}followers.clear();state.active=false;state.timer=null;state.reconcile=null}
