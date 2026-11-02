/** The RSI pipeline: propose, probe, compose, select, apply and reflect over dsh-superagent's own prompt harness. */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PromptConfig } from '../app/prompts.ts'
import { call, collectEvidence, readTree, writeContext, type HarnessHead, type Rollout } from './evidence.ts'
import { appendEntry, keepAdopted, readIndex, type LibraryEntry } from './library.ts'
import { composePrompt, parseChoice, parseReflection, proposePrompt, reflectPrompt, selectPrompt, type HeadlessRunner } from './sessions.ts'
import { configToTree, configWithBases, diffTrees, readFence, treeToConfig, validateTree, type Tree } from './tree.ts'

/** The stages of a run, in execution order; `run` resumes at any one of them. */
export const STAGES = ['collect', 'propose', 'compose', 'select', 'apply', 'reflect'] as const
export type Stage = typeof STAGES[number]
/** The knobs of one run; every field has a default the CLI passes through. */
export interface ImproverOptions {
  url: string; runsDir: string; tag: string; k: number; mode: 'parallel' | 'sequential'; seed: number
  maxTickets: number; runner: HeadlessRunner; dryRun: boolean; mission?: string
}
/** A proposed candidate: its workspace on disk and the notes it replied with; its tree is read back when needed. */
interface Candidate { label: string; lens: 'invariant' | 'domain'; workspace: string; notes?: string; inherited?: boolean }
/** The durable state of a run, kept in `run.json` so a later stage resumes without redoing earlier ones. */
export interface RunState {
  url: string; tag: string; k: number; mode: 'parallel' | 'sequential'; seed: number; maxTickets: number; dryRun: boolean
  done: Stage[]; head?: HarnessHead; rollouts?: Rollout[]
  candidates?: { label: string; lens: string; notes?: string; inherited?: boolean }[]
  finals?: string[]; choice?: string; adoptedRevision?: number; lesson?: LibraryEntry
}
/** The default mission: improve how the agents work on this deployment, on evidence from ended tickets. */
const MISSION = `This deployment runs a proactive coding agent whose standing text — the harness — decides how its
sessions ask, work and deliver. Improve that harness for future work, using the ended tickets in
context/rollouts/ as the only evidence of what the current harness does. The harness under
context/harness/ is the current one; the library under context/library/ holds lessons from earlier
adoptions, whose components you may copy only after re-reading them against this deployment's facts.`
/** A small seeded shuffle, stable across runs of the same seed, for the blind selection's anonymous ids. */
function shuffled(items: readonly string[], seed: number): string[] {
  const next = () => { let state = seed >>> 0 || 1; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  return items.slice().sort((a, b) => next() - 0.5)
}
/**
 * Runs one RSI recursion over the running instance's prompt harness: it collects ended tickets as evidence,
 * proposes and probes candidate harnesses in isolated workspaces, composes and blind-selects one, applies it
 * through the versioned prompts API, and reflects the adoption into the experience library.
 */
export class Improver {
  private readonly runDir: string
  private readonly libraryDir: string
  private readonly mission: string
  private state: RunState
  private probeError?: string
  /** @param options The run's knobs; the run directory is derived from them and created on demand. */
  constructor(private readonly options: ImproverOptions) {
    this.runDir = join(options.runsDir, `rsi-${options.tag}-${options.mode}${options.k}-s${options.seed}`)
    this.libraryDir = join(options.runsDir, 'library', options.tag)
    this.mission = options.mission ?? MISSION
    this.state = { url: options.url, tag: options.tag, k: options.k, mode: options.mode, seed: options.seed,
      maxTickets: options.maxTickets, dryRun: options.dryRun, done: [] }
  }
  /** Where this run keeps its context, workspaces and state. */
  get directory(): string { return this.runDir }
  /** Reads prior state, if this run was started before. */
  async load(): Promise<void> {
    try { this.state = { ...this.state, ...JSON.parse(await readFile(join(this.runDir, 'run.json'), 'utf8')) as RunState } } catch { /* a fresh run */ }
  }
  /** Persists the durable state after each stage. */
  private async keep(): Promise<void> {
    await mkdir(this.runDir, { recursive: true })
    await writeFile(join(this.runDir, 'run.json'), JSON.stringify(this.state, null, 2))
  }
  /** Executes the stages from `from` to `to` in order, skipping the ones the run already finished. */
  async run(from: Stage = 'collect', to: Stage = 'reflect'): Promise<RunState> {
    for (const stage of STAGES.slice(STAGES.indexOf(from), STAGES.indexOf(to) + 1)) {
      if (!this.state.done.includes(stage)) await this[stage]()
      this.state.done = [...new Set([...this.state.done, stage])]
      await this.keep()
    }
    return this.state
  }
  /** collect: the harness head, the ended tickets' rollouts, and the context tree they form. */
  private async collect(): Promise<void> {
    const { head, rollouts } = await collectEvidence(this.options.url, this.options.maxTickets)
    this.state.head = head
    this.state.rollouts = rollouts
    await writeContext(this.dir('context'), { mission: this.mission, head, rollouts, tree: configToTree(head.config), library: this.libraryDir })
  }
  /** propose: two lenses per round (invariant, domain); parallel mode widens with k of each, sequential rounds refine the checkpoint. */
  private async propose(): Promise<void> {
    const rounds = this.options.mode === 'sequential' ? this.options.k : 1
    const candidates: Candidate[] = []
    for (let round = 1; round <= rounds; round++) {
      const lenses: ('invariant' | 'domain')[] = this.options.mode === 'parallel'
        ? [...Array.from({ length: this.options.k }, () => 'invariant' as const), ...Array.from({ length: this.options.k }, () => 'domain' as const)]
        : ['invariant' as const, 'domain' as const]
      for (const [index, lens] of lenses.entries()) {
        const label = this.options.mode === 'parallel' ? `${lens === 'invariant' ? 'inv' : 'dom'}${index + 1}` : `${lens === 'invariant' ? 'inv' : 'dom'}-${round}`
        candidates.push(await this.proposeOne(label, lens, round))
      }
      if (this.options.mode === 'sequential') await this.composeRound(round, candidates)
    }
    this.state.candidates = candidates.map(({ label, lens, notes, inherited }) => ({ label, lens, notes, inherited }))
  }
  /** One proposer in its own workspace; a refused proposal goes back once with the error, then inherits the base. */
  private async proposeOne(label: string, lens: 'invariant' | 'domain', round: number): Promise<Candidate> {
    const workspace = this.dir('proposals', label)
    await this.seedContext(workspace)
    if (this.options.mode === 'sequential' && round > 1) {
      await cp(this.dir('checkpoint', 'context', 'harness'), join(workspace, 'context', 'harness'), { recursive: true })
    }
    let reply = await this.options.runner.run(proposePrompt({ lens }), workspace)
    let notes = readFence(reply, 'notes')
    let probed = await this.probe(workspace)
    if (typeof probed === 'string' && probed !== 'unchanged') {
      reply = await this.options.runner.run(`${proposePrompt({ lens })}\nYour previous proposal was refused:\n${probed}\nFix context/harness/ accordingly.`, workspace)
      notes = readFence(reply, 'notes') ?? notes
      probed = await this.probe(workspace)
    }
    // An unchanged or twice-refused proposal inherits the current harness: it keeps the pool's size, not its value.
    if (typeof probed === 'string') return { label, lens, workspace, notes, inherited: true }
    return { label, lens, workspace, notes }
  }
  /**
   * probe: mechanical validation only — the surface, placeholders, reserved names, size, and one composed
   * preview on the host. Returns the tree, the string `'unchanged'`, or the refusal message.
   */
  private async probe(workspace: string): Promise<Tree | 'unchanged' | string> {
    const head = this.head()
    const tree = await readTree(join(workspace, 'context', 'harness'))
    if (!tree.length) return (this.probeError = 'no harness files were written')
    if (diffTrees(configToTree(head.config), tree).trim() === '') return 'unchanged'
    try {
      validateTree(tree, { defaults: head.defaults, maxChars: head.maxChars })
      await call(this.options.url, 'POST prompts/preview', { body: { config: this.candidateConfig(tree) } })
    } catch (error) { return (this.probeError = error instanceof Error ? error.message : String(error)) }
    await writeFile(join(workspace, 'diff.patch'), diffTrees(configToTree(head.config), tree))
    return tree
  }
  /** compose: parallel mode composes k finals from the whole pool; sequential rounds already composed in `propose`. */
  private async compose(): Promise<void> {
    if (this.options.mode !== 'parallel') { this.state.finals = ['checkpoint']; return }
    const candidates = await this.candidates()
    const finals: string[] = []
    for (let index = 1; index <= this.options.k; index++) {
      const label = `final${index}`
      const workspace = await this.poolWorkspace(this.dir('finals', label), candidates)
      await this.options.runner.run(composePrompt(), workspace)
      const probed = await this.probe(workspace)
      if (typeof probed === 'string') throw new Error(`composer ${label} produced no valid harness: ${probed}`)
      finals.push(label)
    }
    this.state.finals = finals
  }
  /** One sequential round: the composer merges this round's candidates with every earlier one, over the checkpoint. */
  private async composeRound(round: number, candidates: Candidate[]): Promise<void> {
    const workspace = this.dir('checkpoint')
    // Later rounds compose over the previous checkpoint, so their workspace must keep its harness.
    await this.poolWorkspace(workspace, candidates, { seed: round === 1 })
    await this.options.runner.run(composePrompt(), workspace)
    const probed = await this.probe(workspace)
    if (typeof probed === 'string' && probed !== 'unchanged') throw new Error(`round ${round} composed an invalid harness: ${probed}`)
  }
  /** Copies the collected evidence context into a fresh workspace, as the `context/` the session prompts name. */
  private async seedContext(workspace: string): Promise<void> {
    await cp(this.dir('context'), join(workspace, 'context'), { recursive: true })
  }
  /** Lays out a composer or selector workspace: the evidence context plus every candidate's harness and notes. */
  private async poolWorkspace(workspace: string, candidates: Candidate[], options: { seed?: boolean } = {}): Promise<string> {
    if (options.seed !== false) await this.seedContext(workspace)
    await rm(join(workspace, 'context', 'pool'), { recursive: true, force: true })
    await mkdir(join(workspace, 'context', 'pool'), { recursive: true })
    for (const candidate of candidates) {
      const pool = join(workspace, 'context', 'pool', candidate.label)
      await cp(join(candidate.workspace, 'context', 'harness'), join(pool, 'harness'), { recursive: true })
      if (candidate.notes) await writeFile(join(pool, 'notes.md'), candidate.notes)
    }
    return workspace
  }
  /** select: exactly the composed finals, anonymized by the seed; the base is not in the pool, so nobody can abstain. */
  private async select(): Promise<void> {
    const finals = this.state.finals ?? []
    if (finals.length <= 1) { this.state.choice = finals[0] ?? ''; return }
    const order = shuffled(finals, this.options.seed)
    const ids = order.map((_, index) => String.fromCharCode(65 + index))
    const mapping = Object.fromEntries(order.map((label, index) => [String.fromCharCode(65 + index), label]))
    const workspace = await this.poolWorkspace(this.dir('selection'),
      order.map(label => ({ label, lens: 'domain' as const, workspace: this.dir('finals', label) })))
    const reply = await this.options.runner.run(selectPrompt({ ids }), workspace)
    const choice = parseChoice(reply, ids)
    this.state.choice = mapping[choice] ?? ''
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'decision.md'), `selected: ${choice} -> ${this.state.choice}\n${readFence(reply, 'why') ?? ''}`)
  }
  /** apply: save the chosen harness as a new prompt version through the same API the panel uses. */
  private async apply(): Promise<void> {
    if (!this.state.choice) throw new Error('nothing was selected; run the earlier stages first')
    const config = await this.draftConfig()
    const head = this.head()
    if (this.options.dryRun) {
      await mkdir(this.dir('adopted'), { recursive: true })
      await writeFile(this.dir('adopted', 'dry-run.json'), JSON.stringify({ wouldSave: config, baseRevision: head.revision }, null, 2))
      return
    }
    const result = await call(this.options.url, 'PUT prompts', { body: { config, baseRevision: head.revision } }) as { revision: number }
    this.state.adoptedRevision = result.revision
    await mkdir(this.dir('adopted'), { recursive: true })
    await writeFile(this.dir('adopted', 'config.json'), JSON.stringify({ revision: result.revision, config }, null, 2))
  }
  /** reflect: attribute the adoption and keep at most one evidence-supported lesson in the library. */
  private async reflect(): Promise<void> {
    const candidates = await this.candidates()
    for (const label of this.state.finals ?? []) candidates.push({ label, lens: 'domain', workspace: this.dir('finals', label) })
    const workspace = await this.poolWorkspace(this.dir('reflection'), candidates)
    await writeFile(join(workspace, 'context', 'decision.md'),
      `selected: ${this.state.choice ?? '(none)'}\nadopted revision: ${this.state.adoptedRevision ?? '(dry run)'}\n`)
    const reply = await this.options.runner.run(reflectPrompt(), workspace)
    const reflection = parseReflection(reply)
    await writeFile(join(workspace, 'reflection.md'), reply)
    const lesson = reflection.experience
    if (lesson && !this.options.dryRun) {
      const entry: LibraryEntry = { date: new Date().toISOString().slice(0, 10),
        run: `${this.options.mode}${this.options.k}-s${this.options.seed}`, ...lesson }
      await appendEntry(this.libraryDir, entry)
      this.state.lesson = entry
    }
    if (this.state.choice && !this.options.dryRun) {
      const source = this.state.choice === 'checkpoint' ? this.dir('checkpoint') : this.dir('finals', this.state.choice)
      await keepAdopted(this.libraryDir, `${this.state.mode}${this.state.k}-s${this.state.seed}`, await readTree(join(source, 'context', 'harness')))
    }
  }
  /** The candidates of a finished propose stage: labels and workspaces; trees are read back on demand. */
  private async candidates(): Promise<Candidate[]> {
    return (this.state.candidates ?? []).map(row => ({ label: row.label, lens: row.lens === 'domain' ? 'domain' : 'invariant',
      workspace: this.dir('proposals', row.label), notes: row.notes, inherited: row.inherited }))
  }
  private dir(...parts: string[]): string { return join(this.runDir, ...parts) }
  private head(): HarnessHead {
    if (!this.state.head) throw new Error('the run has no harness head; run the collect stage first')
    return this.state.head
  }
  private candidateConfig(tree: Tree): PromptConfig { return configWithBases(treeToConfig(tree), this.head().defaults) }
  /** The composed configuration the run would save right now. */
  async draftConfig(): Promise<PromptConfig> {
    if (!this.state.choice) throw new Error('nothing selected yet')
    const source = this.state.choice === 'checkpoint' ? this.dir('checkpoint') : this.dir('finals', this.state.choice)
    return this.candidateConfig(await readTree(join(source, 'context', 'harness')))
  }
  /** A one-line summary for the CLI: what the run did and what it changed. */
  summary(): string {
    const parts = [`run ${this.runDir}`, `stages: ${this.state.done.join(',') || 'none'}`]
    if (this.state.choice) parts.push(`selected: ${this.state.choice}`)
    if (this.state.adoptedRevision !== undefined) parts.push(`adopted prompt revision ${this.state.adoptedRevision}`)
    if (this.options.dryRun) parts.push('dry run: nothing was saved')
    if (this.state.lesson) parts.push(`lesson: ${this.state.lesson.lesson.slice(0, 80)}`)
    return parts.join(' · ')
  }
  /** The library index this run reads and writes. */
  library(): Promise<string> { return readIndex(this.libraryDir) }
}
