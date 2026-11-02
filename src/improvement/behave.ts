/** The behavioural probe: measure a candidate harness by really running the deployment's own micro-tasks under it. */
import { cp, mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { HeadlessRunner } from './sessions.ts'

/** One micro-task the probe runs under each harness: an instruction, a working copy source, and a mechanical checker. */
export interface ProbeTask { id: string; instruction: string; cwd: string; check: string }
/** The measured outcome of running one harness group over the task set. */
export interface BehaviourScore {
  group: string; passed: number; total: number; seconds: number
  runs: { task: string; round: number; ok: boolean; seconds: number; sessionSeconds: number; checker: string }[]
}
/** A task set file: held-out micro-tasks the probe may use, kept away from the proposer's evidence. */
export async function readTasks(file: string): Promise<ProbeTask[]> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { tasks?: ProbeTask[] }
  if (!parsed.tasks?.length) throw new Error(`${file} holds no tasks`)
  for (const task of parsed.tasks) {
    if (!task.id || !task.instruction || !task.cwd || !task.check) throw new Error(`task ${task.id ?? '?'} needs id, instruction, cwd and check`)
  }
  return parsed.tasks
}
/** Runs one shell command in a directory; resolves with its exit code and wall-clock seconds. */
export function shell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; seconds: number }> {
  const started = Date.now()
  return new Promise(resolve => {
    const child = spawn(command, { cwd, shell: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); resolve({ code: 124, seconds: (Date.now() - started) / 1000 }) }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve({ code: 127, seconds: (Date.now() - started) / 1000 }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, seconds: (Date.now() - started) / 1000 }) })
  })
}
/** The standing-instructions block a probe session receives: only the team sections differ between groups. */
export function standingInstructions(sections: { communication: string; scope: string; delivery: string }): string {
  return [`## Communication\n${sections.communication}`, `## Ticket scope\n${sections.scope}`, `## Delivery requirements\n${sections.delivery}`].join('\n\n')
}
/** Copies a project tree into a fresh probe workspace, skipping heavy directories. */
async function freshWorkspace(source: string, root: string, name: string): Promise<string> {
  const workspace = join(root, name)
  await rm(workspace, { recursive: true, force: true })
  await mkdir(workspace, { recursive: true })
  await cp(source, workspace, { recursive: true, filter: item => !/[\\/](node_modules|lib|\.git|\.artifacts|runs)$/.test(item) })
  return workspace
}
/**
 * Runs `rounds` rounds of every task under one harness group: each run gets a fresh copy of the project,
 * one headless session whose prompt carries the group's standing instructions, and then the mechanical
 * checker. The score is the honest number a candidate has to earn.
 */
export async function scoreGroup(options: {
  group: string; sections: { communication: string; scope: string; delivery: string }
  tasks: ProbeTask[]; rounds: number; runner: HeadlessRunner; root: string; timeoutMs: number
}): Promise<BehaviourScore> {
  const instructions = standingInstructions(options.sections)
  const runs: BehaviourScore['runs'] = []
  for (const task of options.tasks) {
    for (let round = 1; round <= options.rounds; round++) {
      const workspace = await freshWorkspace(task.cwd, options.root, `${options.group}-${task.id}-r${round}`)
      const prompt = `You are a coding agent working unattended in the current directory. Your standing instructions:\n\n${instructions}\n\nTask: ${task.instruction}\nFinish the change in the project files; do not create reports.`
      // The session's wall-clock time is part of the measurement: a harness that makes the agent flail shows up here.
      const sessionStarted = Date.now()
      try { await options.runner.run(prompt, workspace) } catch { /* a failed session counts as a failed run */ }
      const sessionSeconds = (Date.now() - sessionStarted) / 1000
      const checked = await shell(task.check, workspace, options.timeoutMs)
      runs.push({ task: task.id, round, ok: checked.code === 0, seconds: sessionSeconds + checked.seconds, sessionSeconds, checker: task.check })
    }
  }
  return { group: options.group, passed: runs.filter(run => run.ok).length, total: runs.length,
    seconds: runs.length ? runs.reduce((sum, run) => sum + run.seconds, 0) / runs.length : 0, runs }
}
