/** Publishing: turn the sedimented knowledge base into a team skill the running sessions can load on demand. */
import { call } from './evidence.ts'
import { readIndex, readLessons, readOutcomes, type LibraryEntry, type OutcomeRecord } from './library.ts'
import type { PromptConfig } from '../app/prompts.ts'

/** Builds the deployment-knowledge skill text from the library: the lessons, then the recent measured outcomes. */
export function knowledgeSkillText(lessons: LibraryEntry[], outcomes: OutcomeRecord[]): string {
  const parts = ['# Deployment knowledge', '',
    'Sedimented by RSI runs. A lesson here has survived a measured run; still re-verify it against this deployment before relying on it.', '']
  if (lessons.length) {
    parts.push('## Lessons')
    for (const lesson of lessons) parts.push(`- [${lesson.date} ${lesson.run}] ${lesson.lesson} (cue: ${lesson.cue}; confidence: ${lesson.confidence})`)
    parts.push('')
  }
  if (outcomes.length) {
    parts.push('## Measured outcomes')
    for (const record of outcomes) {
      const probe = record.probe ? ` probe ${record.probe.base} vs ${record.probe.candidate};` : ''
      parts.push(`- [${record.date} ${record.run}] ${record.adopted ? `adopted as prompt revision ${record.adoptedRevision}` : record.rejectedByBehaviour ? 'rejected by the behavioural probe' : 'not adopted'};${probe}`)
    }
  }
  return parts.join('\n')
}
/** Reads the library, merges the knowledge skill into the live prompt configuration, and saves it as a new version. */
export async function publishKnowledge(options: {
  url: string; libraryDir: string; skillName?: string; maxChars?: number
}): Promise<{ revision: number; skillChars: number; lessons: number; outcomes: number }> {
  const skillName = options.skillName ?? 'deployment-knowledge'
  const maxChars = options.maxChars ?? 8_000
  const current = await call(options.url, 'GET prompts') as { current: { revision: number; config: PromptConfig } }
  const lessons = await readLessons(options.libraryDir, 30)
  const outcomes = await readOutcomes(options.libraryDir, 15)
  let text = knowledgeSkillText(lessons, outcomes)
  // The knowledge skill loads on demand, but it still has a size budget: drop the oldest entries until it fits.
  let keptLessons = lessons.length, keptOutcomes = outcomes.length
  while (text.length > maxChars && (keptLessons > 3 || keptOutcomes > 3)) {
    if (keptLessons > 3) keptLessons -= 1
    else keptOutcomes -= 1
    text = knowledgeSkillText(lessons.slice(-keptLessons), outcomes.slice(-keptOutcomes))
  }
  if (text.length > maxChars) text = text.slice(0, maxChars)
  const config: PromptConfig = { ...current.current.config, skills: { ...(current.current.config.skills ?? {}), [skillName]: text } }
  const saved = await call(options.url, 'PUT prompts', { body: { config, baseRevision: current.current.revision } }) as { revision: number }
  return { revision: saved.revision, skillChars: text.length, lessons: keptLessons, outcomes: keptOutcomes }
}
