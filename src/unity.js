import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * What this machine knows about Unity — in ONE place.
 *
 * The same two questions were answered in two files with two copies of the same
 * macOS assumption: is an editor running, and where is the one this project
 * wants. Copies drift, and a platform fix applied to one of them is a platform
 * fix that half works. Both callers now ask here.
 */

/**
 * Is an editor running?
 *
 * We look at the process, not at the MCP server: the server keeps answering
 * after the editor has died, and that is exactly what made two passes believe
 * they could work.
 *
 * The pattern is per-platform because the process is named differently on each,
 * and the macOS one matches nothing on Linux — where the answer would silently
 * be "no editor" for ever, telling a Linux user their editor is closed while
 * they are working in it.
 */
export function editorRunning() {
  const look = {
    // Unity Hub carries the same word: target the binary inside the bundle,
    // otherwise the Hub alone would be enough to say "all good".
    darwin: ['pgrep', ['-f', 'Unity.app/Contents/MacOS/Unity']],
    linux: ['pgrep', ['-f', 'Editor/Unity']],
    win32: ['tasklist', ['/FI', 'IMAGENAME eq Unity.exe', '/NH']],
  }[process.platform]

  // An unknown platform gets the benefit of the doubt: refusing to run because
  // we cannot check is worse than running and finding out.
  if (!look) return true

  try {
    const out = execFileSync(look[0], look[1], { stdio: 'pipe', encoding: 'utf8' })
    // `pgrep` says it by exiting 0; `tasklist` exits 0 either way and prints
    // "INFO: No tasks are running", which is a success that means no.
    return process.platform === 'win32' ? /Unity\.exe/i.test(out) : true
  } catch {
    return false
  }
}

/** Where the Hub puts an editor, per platform. */
function hubPaths(version) {
  return (
    {
      darwin: [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`],
      linux: [
        join(homedir(), `Unity/Hub/Editor/${version}/Editor/Unity`),
        `/opt/unity/editors/${version}/Editor/Unity`,
      ],
      win32: [
        `C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`,
        `C:\\Program Files (x86)\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`,
      ],
    }[process.platform] ?? []
  )
}

/**
 * Which editor this project wants, and whether it is here.
 *
 * The version is not a preference. Opening a project with a different editor
 * upgrades it — silently, across every asset — so we look for the exact one
 * `ProjectVersion.txt` names and refuse rather than substitute.
 *
 * `override` comes from `.orchestrator.json`'s `unity.editor`, for an install
 * that is not where the Hub put it.
 */
export function editorFor(root, override = null) {
  if (override) {
    return existsSync(override)
      ? { path: override, version: 'declared' }
      : { error: `the declared editor is not there: ${override}` }
  }

  const file = join(root, 'ProjectSettings', 'ProjectVersion.txt')
  if (!existsSync(file)) return { error: 'no ProjectSettings/ProjectVersion.txt — is this a Unity project?' }

  const version = /m_EditorVersion:\s*(\S+)/.exec(readFileSync(file, 'utf8'))?.[1]
  if (!version) return { error: 'ProjectVersion.txt does not say which editor version' }

  const path = hubPaths(version).find((p) => existsSync(p))
  return path
    ? { path, version }
    : { error: `this project wants Unity ${version} and it is not installed`, version }
}
