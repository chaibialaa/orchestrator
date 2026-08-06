import { base, json } from './index.js'

const TABLES = ['projects','chapters','objectives','events','evidence_manifests','decisions','blockers','verdicts','costs','cleanups']
export function exportObject(projectId = null) {
  const out = { format: 'orchestrator-memory', version: 1, exported_at: new Date().toISOString(), scope: projectId ? 'project' : 'complete', tables: {} }
  for (const table of TABLES) {
    const columns = base().prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
    const scoped = projectId && columns.includes('project_id')
    out.tables[table] = base().prepare(`SELECT * FROM ${table}${scoped ? ' WHERE project_id=?' : ''} ORDER BY id`).all(...(scoped ? [projectId] : [])).map((row) => table === 'events' ? { ...row, payload: json.read(row.payload, {}) } : row)
  }
  return out
}
export function exportJson(projectId = null) { return JSON.stringify(exportObject(projectId), null, 2) }
export function exportJournal(machine, afterId = 0) {
  const out = exportObject()
  const events = out.tables.events.filter((row) => row.machine_id === machine && row.id > afterId)
  const eventIds = new Set(events.map((row) => row.id))
  out.scope = 'machine-journal'
  out.machine_id = machine
  out.tables.events = events
  for (const table of ['evidence_manifests','decisions','blockers','verdicts','costs','cleanups']) out.tables[table] = out.tables[table].filter((row) => eventIds.has(row.event_id))
  out.cursor = events.at(-1)?.id || afterId
  return out
}
export function exportMarkdown(projectId = null) {
  const data = exportObject(projectId); const lines = ['# Orchestrator memory export','',`Exported: ${data.exported_at}`,'']
  for (const project of data.tables.projects) {
    lines.push(`## ${project.name}`,'',project.description || '', '', '### Objectives','')
    for (const objective of data.tables.objectives.filter((row) => row.project_id === project.id)) lines.push(`- [${objective.status}] ${objective.title}`)
    lines.push('', '### Timeline','')
    for (const event of data.tables.events.filter((row) => row.project_id === project.id).sort((a,b) => b.occurred_at.localeCompare(a.occurred_at))) lines.push(`- ${event.occurred_at} — **${event.assertion}** — ${event.summary}`)
    lines.push('')
  }
  lines.push('## Evidence manifest','')
  for (const proof of data.tables.evidence_manifests) lines.push(`- ${proof.label}: ${proof.status}; sha256=${proof.sha256 || 'unknown'}; ${proof.locator || 'no locator'}`)
  return lines.join('\n')
}
