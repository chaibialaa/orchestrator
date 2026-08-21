import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { base, json, uid } from './db/index.js'

const sha=value=>createHash('sha256').update(String(value)).digest()
const state={phase:'idle',public_url:null,started_at:null,error:null,logs:[],process:null,installProcess:null,pairingHash:null,pairingCode:null,pairingExpiresAt:null}
const idleState={process:null,started_at:null,error:null,method:null}
const addLog=value=>{const line=String(value||'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim();if(!line)return;state.logs.push(line.slice(0,500));state.logs=state.logs.slice(-12)}
const commandResult=(command,args=[])=>{try{return execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{return''}}

const preventIdleDescriptor=()=>{
  const system=platform()
  if(system==='darwin'){const command=commandResult('which',['caffeinate'])||'/usr/bin/caffeinate';return existsSync(command)?{available:true,method:'caffeinate',command,args:['-i'],label:'Maintien actif macOS'}:{available:false,method:null,label:'La commande caffeinate est indisponible.'}}
  if(system==='win32'){const command=commandResult('where.exe',['powershell.exe']).split(/\r?\n/)[0];return command?{available:true,method:'powershell',command,args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Awake { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'; [Awake]::SetThreadExecutionState(0x80000001) | Out-Null; try { while ($true) { Start-Sleep -Seconds 60 } } finally { [Awake]::SetThreadExecutionState(0x80000000) | Out-Null }`],label:'Maintien actif Windows'}:{available:false,method:null,label:'PowerShell est requis pour empêcher la mise en veille.'}}
  const command=commandResult('which',['systemd-inhibit']);return command?{available:true,method:'systemd-inhibit',command,args:['--what=sleep:idle','--who=Orchestrator','--why=Supervision distante active','--mode=block','sleep','infinity'],label:'Maintien actif Linux'}:{available:false,method:null,label:'systemd-inhibit est requis pour empêcher la mise en veille.'}
}

export function preventIdleStatus(){
  const descriptor=preventIdleDescriptor()
  return{available:descriptor.available,active:Boolean(idleState.process),method:idleState.method||descriptor.method,started_at:idleState.started_at,error:idleState.error,label:descriptor.label,screen_may_sleep:true}
}

export function stopPreventIdle(){
  const child=idleState.process;idleState.process=null
  if(child&&!child.killed)child.kill()
  idleState.started_at=null;idleState.error=null;idleState.method=null
  return preventIdleStatus()
}

export function setPreventIdle(enabled){
  if(!enabled){stopPreventIdle();return remoteAccessStatus({local:true})}
  if(idleState.process)return remoteAccessStatus({local:true})
  const descriptor=preventIdleDescriptor()
  if(!descriptor.available)throw Object.assign(new Error(descriptor.label),{status:409})
  idleState.error=null;idleState.method=descriptor.method;idleState.started_at=new Date().toISOString()
  const child=spawn(descriptor.command,descriptor.args,{shell:false,windowsHide:true,stdio:'ignore'});idleState.process=child
  child.on('error',error=>{if(idleState.process!==child)return;idleState.process=null;idleState.started_at=null;idleState.method=null;idleState.error=error.message})
  child.on('exit',code=>{if(idleState.process!==child)return;idleState.process=null;idleState.started_at=null;idleState.method=null;if(code!==0)idleState.error=`Le maintien actif s’est arrêté (code ${code??'inconnu'}).`})
  return remoteAccessStatus({local:true})
}

process.once('exit',()=>{const child=idleState.process;if(child&&!child.killed)child.kill()})

export function cloudflaredBinary(){
  if(process.env.ORCHESTRATOR_CLOUDFLARED_COMMAND)return process.env.ORCHESTRATOR_CLOUDFLARED_COMMAND
  const system=platform(),candidates=system==='win32'?[commandResult('where.exe',['cloudflared']).split(/\r?\n/)[0]]:[commandResult('which',['cloudflared']),'/opt/homebrew/bin/cloudflared','/usr/local/bin/cloudflared']
  return candidates.find(candidate=>candidate&&existsSync(candidate))||null
}

const installDescriptor=()=>{
  if(platform()==='darwin'){const brew=commandResult('which',['brew'])||(['/opt/homebrew/bin/brew','/usr/local/bin/brew'].find(existsSync));return brew?{available:true,label:'Installer automatiquement avec Homebrew',command:brew,args:['install','cloudflared']}:{available:false,label:'Homebrew est requis pour l’installation automatique.'}}
  if(platform()==='win32'){const winget=commandResult('where.exe',['winget.exe']).split(/\r?\n/)[0];return winget?{available:true,label:'Installer automatiquement avec winget',command:winget,args:['install','--id','Cloudflare.cloudflared','--exact','--accept-package-agreements','--accept-source-agreements']}:{available:false,label:'winget est requis pour l’installation automatique.'}}
  return{available:false,label:'Installez cloudflared avec le gestionnaire de paquets de ce système.'}
}

export function remoteAccessStatus({local=false}={}){
  const binary=cloudflaredBinary(),installer=installDescriptor(),expires=state.pairingExpiresAt
  if(expires&&Date.now()>=expires){state.pairingCode=null;state.pairingHash=null;state.pairingExpiresAt=null}
  return{platform:platform(),installed:Boolean(binary),binary:local?binary:null,installer:{available:installer.available,label:installer.label},phase:state.phase,public_url:state.public_url,started_at:state.started_at,error:state.error,logs:local?state.logs:[],pairing_code:local?state.pairingCode:null,pairing_expires_at:state.pairingExpiresAt?new Date(state.pairingExpiresAt).toISOString():null,prevent_idle:preventIdleStatus(),temporary:true,account_required:false}
}

export function rotateRemotePairingCode(){
  if(state.phase!=='online')throw Object.assign(new Error('Démarrez d’abord l’accès Internet temporaire.'),{status:409})
  const code=String(randomInt(100000,1000000));state.pairingCode=code;state.pairingHash=sha(code);state.pairingExpiresAt=Date.now()+10*60*1000
  return remoteAccessStatus({local:true})
}

export function pairRemoteDevice({code,label,machine_id}={}){
  const supplied=String(code||'').replace(/\D/g,''),expected=state.pairingHash
  if(!expected||!state.pairingExpiresAt||Date.now()>=state.pairingExpiresAt||supplied.length!==6||!timingSafeEqual(sha(supplied),expected))throw Object.assign(new Error('Code invalide ou expiré. Générez un nouveau code depuis le PC.'),{status:401})
  const token=`orch_${randomBytes(32).toString('hex')}`,scopes=['read','write'],deviceLabel=String(label||'Téléphone').trim().slice(0,100)||'Téléphone'
  base().prepare('INSERT INTO access_tokens(uid,label,token_hash,scopes,machine_id) VALUES(?,?,?,?,?)').run(uid(),deviceLabel,createHash('sha256').update(Buffer.from(token)).digest('hex'),json.write(scopes),String(machine_id||'').trim().slice(0,120)||null)
  state.pairingCode=null;state.pairingHash=null;state.pairingExpiresAt=null
  return{token,label:deviceLabel,scopes,shown_once:true}
}

export function installCloudflared(){
  if(cloudflaredBinary())return remoteAccessStatus({local:true})
  if(state.installProcess)return remoteAccessStatus({local:true})
  const installer=installDescriptor();if(!installer.available)throw Object.assign(new Error(installer.label),{status:409})
  state.phase='installing';state.error=null;state.logs=[]
  const child=spawn(installer.command,installer.args,{shell:false,windowsHide:true});state.installProcess=child
  child.stdout?.on('data',addLog);child.stderr?.on('data',addLog)
  child.on('error',error=>{state.installProcess=null;state.phase='error';state.error=error.message})
  child.on('exit',code=>{state.installProcess=null;if(code===0&&cloudflaredBinary()){state.phase='idle';state.error=null;addLog('cloudflared est installé.')}else{state.phase='error';state.error=`Installation interrompue (code ${code??'inconnu'}).`}})
  return remoteAccessStatus({local:true})
}

export function startRemoteAccess(port){
  if(state.process||state.phase==='online')return remoteAccessStatus({local:true})
  state.phase='starting';state.public_url=null;state.started_at=null;state.error=null;state.logs=[]
  if(process.env.ORCHESTRATOR_REMOTE_TEST_URL){state.phase='online';state.public_url=process.env.ORCHESTRATOR_REMOTE_TEST_URL;state.started_at=new Date().toISOString();return rotateRemotePairingCode()}
  const binary=cloudflaredBinary();if(!binary){state.phase='idle';throw Object.assign(new Error('cloudflared n’est pas encore installé.'),{status:409})}
  const child=spawn(binary,['tunnel','--no-autoupdate','--url',`http://127.0.0.1:${Number(port)||4173}`],{shell:false,windowsHide:true});state.process=child
  const consume=chunk=>{const text=String(chunk);addLog(text);const url=text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];if(url){state.public_url=url;state.phase='online';state.started_at=new Date().toISOString();rotateRemotePairingCode()}}
  child.stdout?.on('data',consume);child.stderr?.on('data',consume)
  child.on('error',error=>{state.process=null;state.phase='error';state.error=error.message})
  child.on('exit',code=>{state.process=null;stopPreventIdle();if(state.phase!=='idle'){state.phase=code===0?'idle':'error';state.error=code===0?null:`Le relais s’est arrêté (code ${code??'inconnu'}).`;state.public_url=null;state.pairingCode=null;state.pairingHash=null;state.pairingExpiresAt=null}})
  return remoteAccessStatus({local:true})
}

export function stopRemoteAccess(){
  const child=state.process;state.process=null;if(child&&!child.killed)child.kill()
  stopPreventIdle()
  state.phase='idle';state.public_url=null;state.started_at=null;state.error=null;state.pairingCode=null;state.pairingHash=null;state.pairingExpiresAt=null
  return remoteAccessStatus({local:true})
}
