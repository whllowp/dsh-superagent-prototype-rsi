/** The publisher protocol: pluggable ways to sediment the knowledge base. A new publisher registers itself by name. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { publishKnowledge } from './publish.ts'
import { readIndex, readLessons, readOutcomes } from './library.ts'

/** What one publisher receives, and the record it answers with. */
export interface PublishInput { url: string; libraryDir: string; skillName?: string; maxChars?: number }
export interface PublishResult { target: string; revision?: number; chars?: number; lessons?: number; outcomes?: number }
/** A pluggable sedimentation target: where the knowledge base goes when `publish` runs. */
export interface Publisher {
  name: string
  description: string
  publish(input: PublishInput): Promise<PublishResult>
}

const registry = new Map<string, Publisher>()
/** Registers a publisher; a name claimed twice is refused, so the CLI's --publisher stays unambiguous. */
export function registerPublisher(candidate: Publisher): void {
  if (registry.has(candidate.name)) throw new Error(`publisher name already registered: ${candidate.name}`)
  registry.set(candidate.name, candidate)
}
/** The registered publishers in registration order. */
export const publishers = (): Publisher[] => [...registry.values()]
/** The one publisher a name names, if any. */
export const publisher = (name: string): Publisher | undefined => registry.get(name)

/** Writes the knowledge base as plain markdown beside the library: the audit trail that needs no live deployment. */
registerPublisher({
  name: 'file',
  description: 'writes the knowledge base to <libraryDir>/published/knowledge.md',
  async publish({ libraryDir, skillName }) {
    const name = skillName ?? 'deployment-knowledge'
    const [index, lessons, outcomes] = await Promise.all([readIndex(libraryDir), readLessons(libraryDir, 30), readOutcomes(libraryDir, 15)])
    const lines = [`# ${name}`, '', '## Index', index.trim(), '', '## Lessons (jsonl)', ...lessons.map(l => `- [${l.date} ${l.run}] ${l.lesson} (confidence: ${l.confidence})`), '',
      '## Outcomes (jsonl)', ...outcomes.map(o => `- [${o.date} ${o.run}] ${o.adopted ? `adopted as revision ${o.adoptedRevision}` : o.rejectedByBehaviour ? 'rejected by the behavioural probe' : 'not adopted'}${o.probe ? ` — probe ${o.probe.base} vs ${o.probe.candidate}` : ''}`), '']
    const text = lines.join('\n')
    const target = join(libraryDir, 'published', `${name}.md`)
    await mkdir(target.slice(0, Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))), { recursive: true })
    await writeFile(target, text)
    return { target, chars: text.length, lessons: lessons.length, outcomes: outcomes.length }
  },
})

/** Saves the knowledge base as a team skill through the versioned prompts API (the live-deployment path). */
registerPublisher({
  name: 'prompt-skill',
  description: 'saves the knowledge base as the deployment-knowledge team skill via PUT prompts',
  async publish({ url, libraryDir, skillName, maxChars }) {
    const result = await publishKnowledge({ url, libraryDir, skillName, maxChars })
    return { target: `team skill ${skillName ?? 'deployment-knowledge'}`, revision: result.revision, chars: result.skillChars, lessons: result.lessons, outcomes: result.outcomes }
  },
})
