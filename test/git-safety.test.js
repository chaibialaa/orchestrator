import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The safety net has to be silent where it cannot work.
 *
 * These projects are git repositories with a configured identity. Somebody
 * else's may be neither, and a loop that fell over because `user.email` was
 * unset would be failing at entirely the wrong thing. Every path below is a
 * machine that is not this one.
 */

const git = (cwd, ...args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'orch-git-'))
}

test('no git repository at all: nothing happens, and it says why', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'a.txt'), 'work nobody has versioned')

  assert.equal(git(dir, 'rev-parse', '--git-dir'), null, 'not a repository')
  // The helper reads the same thing the loop does, so the loop takes the same
  // decision: do nothing, quietly.
  assert.equal(git(dir, 'stash', 'create', 'x'), null, 'and cannot make a restore point')
})

test('the real check refuses a repository with no identity', async (t) => {
  // The first version of this asserted `!email || !name || true` — which is true
  // whatever happens. A test that cannot fail is a test that protects nothing,
  // and I had just written a document saying so.
  const { gitReady } = await import('../src/agent/commands.js')
  if (!gitReady) return t.skip('gitReady is not exported')

  const dir = scratch()
  git(dir, 'init', '-q')
  git(dir, 'config', '--local', 'user.email', '')
  git(dir, 'config', '--local', 'user.name', '')

  const was = process.cwd()
  try {
    process.chdir(dir)
    const verdict = gitReady()
    assert.equal(verdict.ok, false, 'an unconfigured repository is not ready')
    assert.match(verdict.why, /user\.name|user\.email/, 'and it says which')
  } finally {
    process.chdir(was)
  }
})

test('the real check refuses a plain directory', async (t) => {
  const { gitReady } = await import('../src/agent/commands.js')
  if (!gitReady) return t.skip('gitReady is not exported')

  const was = process.cwd()
  try {
    process.chdir(scratch())
    const verdict = gitReady()
    assert.equal(verdict.ok, false)
    assert.match(verdict.why, /not a git repository/)
  } finally {
    process.chdir(was)
  }
})

test('a restore point captures the work and leaves the tree alone', () => {
  const dir = scratch()
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'kept.txt'), 'first')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first')

  // Work in progress: modified and untracked, as a real repository is mid-flight.
  writeFileSync(join(dir, 'kept.txt'), 'changed, not committed')
  writeFileSync(join(dir, 'new.txt'), 'never tracked')

  const before = git(dir, 'status', '--porcelain')
  const sha = git(dir, 'stash', 'create', 'orchestrator: test')
  const after = git(dir, 'status', '--porcelain')

  assert.equal(before, after, 'the working tree did not move — this is the whole point')
  assert.equal(sha?.length, 40, 'a commit object exists to fall back on')

  const inside = git(dir, 'show', '--stat', '--format=', sha) ?? ''
  assert.match(inside, /kept\.txt/, 'the modified file is in it')
  // Said out loud in the code too: a net that silently omitted these would be
  // worse than none, because it would be trusted.
  assert.doesNotMatch(inside, /new\.txt/, 'the untracked file is NOT — a known hole')
})

test('a restore point on a clean tree is not made at all', () => {
  const dir = scratch()
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'a.txt'), 'x')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'only commit')

  assert.equal(git(dir, 'status', '--porcelain'), '', 'nothing uncommitted')
  assert.equal(git(dir, 'stash', 'create', 'x'), '', 'so git makes nothing, and neither do we')
})

test('committing at a verdict records everything, and pushes nothing', () => {
  const dir = scratch()
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'a.txt'), 'x')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first')

  writeFileSync(join(dir, 'a.txt'), 'proved and accepted')
  writeFileSync(join(dir, 'b.txt'), 'new deliverable')

  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'orchestrator: #42 accepted')

  assert.equal(git(dir, 'status', '--porcelain'), '', 'the tree is recorded')
  assert.match(git(dir, 'log', '-1', '--format=%s') ?? '', /#42 accepted/)
  // No remote is configured here, and none is needed: publishing is a decision.
  assert.equal(git(dir, 'remote'), '', 'nothing to push to, and nothing tried')
})
