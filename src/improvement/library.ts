/** The experience library: adopted harness snapshots and evidence-supported lessons, isolated per tag. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One adoption reflection distilled into at most one transferable lesson. */
export interface LibraryEntry { date: string; run: string; cue: string; lesson: string; evidence: string; confidence: string }
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
}
/** Stores the adopted harness of a run beside its lesson, so a later proposer can copy components back after re-verifying them. */
export async function keepAdopted(libraryDir: string, run: string, tree: { path: string; text: string }[]): Promise<void> {
  for (const file of tree) {
    const target = join(libraryDir, 'harnesses', run, file.path)
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    await writeFile(target, file.text)
  }
}
