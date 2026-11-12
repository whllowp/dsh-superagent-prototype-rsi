/** The Router's verification arm: run the same tasks under several stored prompt revisions and measure which one performs best. */
import { call } from '../improvement/evidence.ts'
import { scoreGroup, type BehaviourScore } from '../improvement/behave.ts'
import type { HeadlessRunner } from '../improvement/sessions.ts'
import type { PromptConfig } from '../app/prompts.ts'

/** The stored configuration of one prompt revision, as the management API answers it. */
export async function revisionConfig(url: string, revision: number): Promise<{ revision: number; config: PromptConfig }> {
  // Revision 0 is the built-in defaults, which every prompts answer already carries; later revisions are addressable by number.
  if (revision === 0) {
    const view = await call(url, 'GET prompts') as { defaults: PromptConfig }
    return { revision: 0, config: view.defaults }
  }
  const view = await call(url, 'GET prompts', { query: { revision: String(revision) } }) as
    { current: { revision: number; config: PromptConfig } }
  if (view.current.revision !== revision) throw new Error(`prompt revision ${revision} is not stored (got ${view.current.revision})`)
  return view.current
}
/** Scores every requested revision on the same held-out tasks; the table is the fast way to judge a new RSI version. */
export async function verifyRevisions(options: {
  url: string; revisions: number[]; tasksFile: string; rounds: number; timeoutMs: number
  runner: HeadlessRunner; root: string
}): Promise<{ scores: (BehaviourScore & { revision: number })[]; best: number | null }> {
  const { readTasks } = await import('../improvement/behave.ts')
  const { tasks } = await readTasks(options.tasksFile)
  const scores: (BehaviourScore & { revision: number })[] = []
  for (const revision of options.revisions) {
    const stored = await revisionConfig(options.url, revision)
    const score = await scoreGroup({ group: `rev${revision}`, sections: stored.config, tasks, rounds: options.rounds,
      runner: options.runner, root: options.root, timeoutMs: options.timeoutMs })
    scores.push({ ...score, revision })
  }
  const best = scores.reduce<number | null>((winner, score) => {
    if (winner === null) return score.revision
    const bestScore = scores.find(s => s.revision === winner)!
    return score.passed > bestScore.passed || (score.passed === bestScore.passed && score.seconds < bestScore.seconds) ? score.revision : winner
  }, null)
  return { scores, best }
}
/** The comparison table a verify run prints and saves. */
export function verifyTable(scores: (BehaviourScore & { revision: number })[], best: number | null): string {
  const lines = ['| revision | passed | avg seconds |', '|---|---|---|',
    ...scores.map(score => `| ${score.revision}${score.revision === best ? ' ← best' : ''} | ${score.passed}/${score.total} | ${score.seconds.toFixed(1)} |`)]
  return lines.join('\n')
}
