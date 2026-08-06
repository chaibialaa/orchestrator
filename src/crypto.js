import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const path=()=>process.env.ORCHESTRATOR_KEY_FILE??join(homedir(),'.orchestrator','secret.key')
let key
function master(){if(key)return key;const file=path();if(!existsSync(file)){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,randomBytes(32).toString('base64'),{mode:0o600});chmodSync(file,0o600)}return key=scryptSync(readFileSync(file,'utf8').trim(),'orchestrator',32)}
export function encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master(),iv),body=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);return`v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`}
export function decrypt(value){try{const[v,iv,tag,body]=String(value).split('.');if(v!=='v1')return null;const decipher=createDecipheriv('aes-256-gcm',master(),Buffer.from(iv,'base64url'));decipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8')}catch{return null}}
