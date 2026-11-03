/** The experience library: adopted harnesses, per-run outcome records, and evidence-supported lessons, isolated per tag. */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One adoption reflection distilled into at most one transferable lesson. */
export interface LibraryEntry { date: string; run: string; cue: string; lesson: string; evidence: string; confidence: string }
/** One run's measured outcome, kept even when the candidate was rejected: this is the memory that stops re-proposals. */
export interface OutcomeRecord {
  date: string; run: string; selected: string; adopted: boolean; adoptedRevision?: number; rejectedByBehaviour?: boolean
  probe?: { base: string; candidate: string }
  lesson?: string
}
/** Reads the library index; a fresh library reads as an empty note. */
export async function readIndex(libraryDir: string): Promise<string> {
  return await readFile(join(libraryDir, 'INDEX.md'), 'utf8').catch(() => '(empty library)\n')
}
/** Appends one lesson to the index; the index is rebuilt from the file each run, so it stays plain markdown on disk. */
export async function appendEntry(libraryDir: string, entry: LibraryEntry): Promise<void> {
  await mkdir(libraryDir, { recursive: true })
  const previous = await readIndex(libraryDir)
  const block = [`## ${entry.date} ${entry.run}`, `- cue: ${entry.cue}`, `- lesson: ${entry.lesson}`,
    `- evidence: ${entry.evidence}`, `- confidence: ${entry.confidence}`, ''].join('\n')
  const head = previous.startsWith('(empty library)') ? `# Experience library — ${entry.run.split('-')[0]}\n\n` : previous.endsWith('\n\n') ? previous : previous.replace(/\n*$/, '\n\n')
  await writeFile(join(libraryDir, 'INDEX.md'), head + block)
  await appendLine(join(libraryDir, 'lessons.jsonl'), { date: entry.date, run: entry.run, cue: entry.cue, lesson: entry.lesson, evidence: entry.evidence, confidence: entry.confidence, status: 'active' })
}
/** Appends one run outcome to the long-term memory; `readOutcomes` reads it back for future proposer contexts. */
export async function appendOutcome(libraryDir: string, record: OutcomeRecord): Promise<void> {
  await appendLine(join(libraryDir, 'outcomes.jsonl'), record)
}
/** Reads the most recent `limit` outcome records, oldest first. */
export async function readOutcomes(libraryDir: string, limit = 10): Promise<OutcomeRecord[]> {
  return await readJsonl<OutcomeRecord>(join(libraryDir, 'outcomes.jsonl'), limit)
}
/** Reads the most recent `limit` lesson records, oldest first. */
export async function readLessons(libraryDir: string, limit = 30): Promise<LibraryEntry[]> {
  return await readJsonl<LibraryEntry>(join(libraryDir, 'lessons.jsonl'), limit)
}
/** Reads a JSON-lines log and answers its last `limit` records, oldest first; malformed lines are skipped. */
async function readJsonl<T>(file: string, limit: number): Promise<T[]> {
  const raw = await readFile(file, 'utf8').catch(() => '')
  const records: T[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line) as T) } catch { /* a torn line is skipped, not guessed */ }
  }
  return records.slice(-limit)
}
/** The markdown tail of the outcome log that a proposer context carries: what was tried and what it measured. */
export function outcomesMarkdown(records: OutcomeRecord[]): string {
  if (!records.length) return '(no earlier runs)\n'
  return ['# Earlier run outcomes (what was tried and measured)', '',
    ...records.map(record => {
      const probe = record.probe ? ` probe ${record.probe.base} vs ${record.probe.candidate};` : ''
      const lesson = record.lesson ? ` lesson kept: ${record.lesson.slice(0, 120)}` : ''
      return `- ${record.date} ${record.run}: ${record.adopted ? `ADOPTED as revision ${record.adoptedRevision}` : record.rejectedByBehaviour ? 'rejected by the behavioural probe' : 'not adopted'};${probe}${lesson}`
    }), ''].join('\n')
}
/** Appends one JSON line, creating the file's directory on the way. */
async function appendLine(file: string, record: unknown): Promise<void> {
  await mkdir(file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))), { recursive: true })
  await appendFile(file, JSON.stringify(record) + '\n')
}
/** Stores the adopted harness of a run beside its lesson, so a later proposer can copy components back after re-verifying them. */
export async function keepAdopted(libraryDir: string, run: string, tree: { path: string; text: string }[]): Promise<void> {
  for (const file of tree) {
    const target = join(libraryDir, 'harnesses', run, file.path)
    await mkdir(target.slice(0, Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))), { recursive: true })
    await writeFile(target, file.text)
  }
}

