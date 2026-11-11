/** The Router's parallel arm: one user request, many agent sessions working at once, one merged report. */
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { HeadlessRunner } from '../improvement/sessions.ts'

/** One piece of a larger request, worked by its own agent session. */
export interface SubTask { id: string; instruction: string }
/** The result of one dispatched agent. */
export interface AgentRun { task: SubTask; reply: string; workspace: string; seconds: number; failed: boolean }
export interface ParallelResult { tasks: SubTask[]; runs: AgentRun[]; merged?: string }

const PLANNER = `You are a router planner. Split the user's request into at most 4 independent subtasks that
different agents can work on in parallel without talking to each other. Each subtask must be
self-contained: name the files, the class names and the done-condition it owns. Never split a change
that must land atomically.
Reply with one fenced block json holding {"tasks":[{"id":"a","instruction":"..."}]} — ids a,b,c..., no
other text.`
const MERGER = `You are the router's merger. Several agents worked the request in parallel; each one reports
below. Produce the final answer for the user: what was done overall, per-part outcomes with file paths,
any conflicts or gaps between agents, and the single next action if one is needed. Reply in the user's
language, at most 300 words, no preamble.`

/** Reads the router's plan: a user-supplied plan file, or one planner session that splits the request. */
export async function planTasks(options: {
  request: string; planFile?: string; runner: HeadlessRunner; cwd: string
}): Promise<SubTask[]> {
  if (options.planFile) {
    const parsed = JSON.parse(await readFile(options.planFile, 'utf8')) as { tasks?: SubTask[] }
    if (!parsed.tasks?.length) throw new Error(`${options.planFile} holds no tasks`)
    return parsed.tasks.slice(0, 6)
  }
  const reply = await options.runner.run(`${PLANNER}\n\nUser request: ${options.request}`, options.cwd)
  const body = reply.match(/```json\s*\n([\s\S]*?)```/)?.[1]
  const parsed = body ? JSON.parse(body) as { tasks?: SubTask[] } : { tasks: [] }
  const tasks = (parsed.tasks ?? []).filter(task => task.id && task.instruction).slice(0, 6)
  if (!tasks.length) return [{ id: 'a', instruction: options.request }]
  return tasks
}
/** A simple concurrency pool: at most `limit` agent sessions run at once, results keep task order. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
/**
 * Dispatches every subtask to its own agent session in a fresh workspace copy, up to `concurrency`
 * sessions at once, then merges the replies into one report with a final session.
 */
export async function dispatchParallel(options: {
  request: string; planFile?: string; cwd: string; outDir: string; concurrency: number
  runner: HeadlessRunner; timeoutMs: number; merge: boolean; skipPatterns?: RegExp
}): Promise<ParallelResult> {
  // The agents copy the project into their own workspaces, so the output directory must live outside it.
  const { resolve, sep } = await import('node:path')
  const cwdAbs = resolve(options.cwd)
  const outAbs = resolve(options.outDir)
  if (outAbs === cwdAbs || outAbs.startsWith(cwdAbs + sep)) {
    throw new Error(`--out (${options.outDir}) must live outside --cwd (${options.cwd}): every agent copies the project into its own workspace`)
  }
  const tasks = await planTasks(options)
  const filter = (item: string): boolean => !options.skipPatterns?.test(item)
  const runs = await pool(tasks, options.concurrency, async task => {
    const workspace = join(options.outDir, `agent-${task.id}`)
    await rm(workspace, { recursive: true, force: true })
    await mkdir(workspace, { recursive: true })
    if (options.cwd) await cp(options.cwd, workspace, { recursive: true, filter })
    const started = Date.now()
    let reply = ''
    let failed = false
    try {
      reply = await options.runner.run(`You are one of several agents working in parallel on parts of a user's request. Own ONLY your part; other agents own the rest.\n\nYour subtask: ${task.instruction}\nWork in the current directory and finish the change in the project files.`, workspace)
    } catch (error) { failed = true; reply = `session failed: ${error instanceof Error ? error.message : String(error)}` }
    return { task, reply: reply.slice(-2000), workspace, seconds: (Date.now() - started) / 1000, failed }
  })
  const result: ParallelResult = { tasks, runs }
  if (options.merge) {
    const digest = result.runs.map(run => `## agent ${run.task.id}${run.failed ? ' (FAILED)' : ''} — ${Math.round(run.seconds)}s\n${run.task.instruction}\n--- reply tail ---\n${run.reply}`).join('\n\n')
    const mergeWorkspace = join(options.outDir, 'merge')
    await mkdir(mergeWorkspace, { recursive: true })
    result.merged = await options.runner.run(`${MERGER}\n\nUser request: ${options.request}\n\n${digest}`, mergeWorkspace)
    await writeFile(join(options.outDir, 'report.md'), `# Router parallel run\n\n${result.merged}\n\n## Per-agent replies\n\n${digest}`)
  }
  return result
}
