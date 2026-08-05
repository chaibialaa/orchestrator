import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Four proofs were declared as `echo '... to be wired up' && true`: an intention
 * recorded as passing every time anyone asked. Nothing cited them, so nothing
 * broke — but the day a criterion had, it would have been settled by a command
 * whose only possible outcome is success.
 */
const inerte = /^\s*(true|:)\s*$|^\s*echo\b[^|;&]*(&&\s*(true|:)\s*)?$/

test('une commande qui ne peut pas échouer est reconnue', () => {
  for (const c of [
    "echo 'build Unity — a brancher sur le pipeline reel' && true",
    "echo 'rendu Blender — a brancher sur blender-mcp'",
    'true',
    '  :  ',
  ]) {
    assert.ok(inerte.test(c), `devrait être refusée : ${c}`)
  }
})

test('une vraie commande ne l’est pas', () => {
  for (const c of [
    'python3 Review/D49_BASELINE/verify.py',
    'npm test',
    "echo 'lancement' && python3 verify.py",
    'echo hi | grep hi',
  ]) {
    assert.equal(inerte.test(c), false, `ne devrait pas être refusée : ${c}`)
  }
})
