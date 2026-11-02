/** The evidence side of an RSI run: a typed client of the running instance's management API, and the context tree it writes. */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ApiResponse } from '../app/api.ts'
import type { PromptConfig } from '../app/prompts.ts'

/** One call of the management API, answered the way the panel calls it: same-origin loopback with the marker header. */
export async function call(url: string, route: string,
  options: { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<unknown> {
  const [method, pattern] = route.split(' ') as [string, string]
  const path = pattern.split('/').map(segment => segment.startsWith(':') ? options.params?.[segment.slice(1)] ?? '' : segment).join('/')
  const query = options.query ? '?' + new URLSearchParams(Object.entries(options.query).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])).toString() : ''
  const response = await fetch(url.replace(/\/$/, '') + '/orchestrator/api/' + path + query, {
    method,
    headers: { 'x-orchestrator-request': '1', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  if (!response.ok) throw new Error(`${route} failed: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return response.json()
}
/** The one prompt configuration a run edits, with the revision every save names as its base. */
export interface HarnessHead { revision: number; config: PromptConfig; defaults: PromptConfig; maxChars: number }
/** A finished ticket as evidence: what was asked, what the worker reported, and how the ticket ended. */
export interface Rollout {
  id: string; title: string; stage: string; outcome?: string; rules: string[]; sender?: string
  reports: { state: string; summary: string; at?: string }[]
  /** A rollout read from a local evidence file keeps its markdown; rendering uses it verbatim. */
  raw?: string
}
/** Reads rollouts from a local evidence directory of `*.md` files — the offline path when no instance holds tickets. */
export async function readRolloutDir(directory: string): Promise<Rollout[]> {
  const names = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.md') && name !== 'INDEX.md').sort()
  const rollouts: Rollout[] = []
  for (const name of names) {
    const id = name.replace(/\.md$/, '')
    rollouts.push({ id, title: id, stage: 'ended', rules: [], sender: undefined, reports: [], raw: await readFile(join(directory, name), 'utf8') })
  }
  return rollouts
}
/** The parts of a ticket detail page an evidence rollout renders. */
interface TicketDetail {
  title?: string; stage?: string; outcome?: string; decision?: { outcome?: string }
  mandate?: { basis?: { rules?: { id: string; name: string }[]; sender?: string } }
  assignments?: { report?: { state?: string; summary?: string; at?: string } }[]
}
/** Reads the harness head and the most recent ended tickets' rollouts from a running dsh-superagent instance. */
export async function collectEvidence(url: string, maxTickets: number): Promise<{ head: HarnessHead; rollouts: Rollout[] }> {
  const prompts = await call(url, 'GET prompts') as ApiResponse<'GET prompts'>
  const state = await call(url, 'GET state') as ApiResponse<'GET state'>
  const head: HarnessHead = { revision: prompts.current.revision, config: prompts.current.config,
    defaults: prompts.defaults, maxChars: Number(state.setup?.machine?.promptMaxChars ?? 100_000) }
  const rollouts: Rollout[] = []
  let offset = 0
  while (rollouts.length < maxTickets) {
    const page = await call(url, 'GET tickets', { query: { state: 'ended', limit: '20', offset: String(offset) } }) as ApiResponse<'GET tickets'>
    for (const row of page.items.slice(0, maxTickets - rollouts.length)) {
      const detail = await call(url, 'GET tickets/:id', { params: { id: String(row.id) } }) as unknown as TicketDetail
      rollouts.push(toRollout(String(row.id), detail))
    }
    if (!page.next_offset || !page.items.length) break
    offset = page.next_offset
  }
  return { head, rollouts }
}
/** Renders one ticket's stored work as a rollout: the ask (via rules and sender), the reports in order, and the end. */
export function toRollout(id: string, detail: TicketDetail): Rollout {
  const reports = (detail.assignments ?? []).flatMap(assignment => assignment.report && assignment.report.state
    ? [{ state: assignment.report.state, summary: assignment.report.summary ?? '', at: assignment.report.at }] : [])
  return {
    id, title: detail.title ?? id, stage: detail.stage ?? 'ended', outcome: detail.outcome ?? detail.decision?.outcome,
    rules: detail.mandate?.basis?.rules?.map(rule => rule.id) ?? [], sender: detail.mandate?.basis?.sender, reports,
  }
}
/** The text of one rollout, in the shared [REPORT]/[END] shape the sessions read. */
export function renderRollout(rollout: Rollout): string {
  if (rollout.raw !== undefined) return rollout.raw
  return [
    `# rollout ${rollout.id} — ${rollout.title}`,
    `stage: ${rollout.stage}`,
    rollout.outcome ? `outcome: ${rollout.outcome}` : '',
    rollout.rules.length ? `mandate rules: ${rollout.rules.join(', ')}` : '',
    rollout.sender ? `sender: ${rollout.sender}` : '',
    ...rollout.reports.map(report => `[REPORT ${report.state}${report.at ? ` at ${report.at}` : ''}] ${report.summary}`),
  ].filter(line => line !== '').join('\n')
}
/** Writes the evidence context tree a session reads: mission, the harness to edit, rollouts, and the experience library index. */
export async function writeContext(directory: string,
  options: { mission: string; head: HarnessHead; rollouts: Rollout[]; tree: { path: string; text: string }[]; library?: string }): Promise<void> {
  await mkdir(join(directory, 'rollouts'), { recursive: true })
  await writeFile(join(directory, 'task.md'), options.mission)
  for (const file of options.tree) {
    await mkdir(dirname(join(directory, 'harness', file.path)), { recursive: true })
    await writeFile(join(directory, 'harness', file.path), file.text)
  }
  for (const rollout of options.rollouts) {
    await writeFile(join(directory, 'rollouts', `${rollout.id.replace(/[^\w.-]/g, '_')}.md`), rollout.raw ?? renderRollout(rollout))
  }
  if (options.library) {
    await mkdir(join(directory, 'library'), { recursive: true })
    await copyFile(join(options.library, 'INDEX.md'), join(directory, 'library', 'INDEX.md')).catch(() => writeFile(join(directory, 'library', 'INDEX.md'), '(empty library)\n'))
  } else {
    await mkdir(join(directory, 'library'), { recursive: true })
  }
}
/** Reads back the harness tree a session edited in its workspace, walking each group's nested override keys. */
export async function readTree(directory: string): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = []
  const walk = async (absolute: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(absolute, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(join(absolute, entry.name), `${prefix}${entry.name}/`)
      else if (entry.name.endsWith('.md')) files.push({ path: `${prefix}${entry.name}`, text: await readFile(join(absolute, entry.name), 'utf8') })
    }
  }
  for (const group of ['team', 'skills', 'overrides'] as const) await walk(join(directory, group), `${group}/`)
  return files
}
