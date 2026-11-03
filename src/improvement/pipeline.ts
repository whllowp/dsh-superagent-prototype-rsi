/** The RSI pipeline: propose, probe, compose, select, apply and reflect over dsh-superagent's own prompt harness. */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PromptConfig } from '../app/prompts.ts'
import { call, collectEvidence, readRolloutDir, readTree, writeContext, type HarnessHead, type Rollout } from './evidence.ts'
import { appendEntry, appendOutcome, keepAdopted, outcomesMarkdown, readIndex, readOutcomes, type LibraryEntry } from './library.ts'
import { composePrompt, parseChoice, parseReflection, proposePrompt, reflectPrompt, selectPrompt, type HeadlessRunner } from './sessions.ts'
import { scoreGroup, type BehaviourScore } from './behave.ts'
import { configToTree, configWithBases, diffTrees, readFence, treeToConfig, validateTree, type Tree } from './tree.ts'

/** The stages of a run, in execution order; `run` resumes at any one of them. */
export const STAGES = ['collect', 'propose', 'compose', 'select', 'behave', 'apply', 'reflect'] as const
export type Stage = typeof STAGES[number]
/** The knobs of one run; every field has a default the CLI passes through. */
export interface ImproverOptions {
  url: string; runsDir: string; tag: string; k: number; mode: 'parallel' | 'sequential'; seed: number
  maxTickets: number; runner: HeadlessRunner; dryRun: boolean; mission?: string
  /** A local evidence directory of rollout `*.md` files; set when no instance holds the tickets. */
  evidenceDir?: string
  /** The behavioural probe: held-out micro-tasks run under base and candidate, scoring each group. */
  behavioural?: { tasksFile: string; rounds: number; timeoutMs: number }
}
/** A proposed candidate: its workspace on disk and the notes it replied with; its tree is read back when needed. */
interface Candidate { label: string; lens: 'invariant' | 'domain'; workspace: string; notes?: string; inherited?: boolean }
/** The durable state of a run, kept in `run.json` so a later stage resumes without redoing earlier ones. */
export interface RunState {
  url: string; tag: string; k: number; mode: 'parallel' | 'sequential'; seed: number; maxTickets: number; dryRun: boolean
  done: Stage[]; head?: HarnessHead; rollouts?: Rollout[]
  candidates?: { label: string; lens: string; notes?: string; inherited?: boolean }[]
  finals?: string[]; choice?: string; adoptedRevision?: number; lesson?: LibraryEntry
  evidenceDir?: string
  behaviour?: { base: BehaviourScore; candidate: BehaviourScore; candidateBetter: boolean }
  rejectedByBehaviour?: boolean
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
      maxTickets: options.maxTickets, dryRun: options.dryRun, done: [], evidenceDir: options.evidenceDir }
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
  /**
   * Executes stages up to `to`. Without `from` the run resumes at its first unfinished stage; an explicit
   * `from` re-runs that stage and everything after it, discarding their earlier results.
   */
  async run(from?: Stage, to: Stage = 'reflect'): Promise<RunState> {
    const endIndex = STAGES.indexOf(to)
    const startIndex = from === undefined
      ? STAGES.findIndex(stage => !this.state.done.includes(stage)) < 0 ? endIndex : STAGES.findIndex(stage => !this.state.done.includes(stage))
      : STAGES.indexOf(from)
    if (startIndex > endIndex) throw new Error(`stage ${from ?? '(resume)'} does not come before ${to}`)
    this.state.done = this.state.done.filter(stage => STAGES.indexOf(stage) < startIndex)
    for (const stage of STAGES.slice(startIndex, endIndex + 1)) {
      await this[stage]()
      this.state.done = [...new Set([...this.state.done, stage])]
      await this.keep()
    }
    return this.state
  }
  /** collect: the harness head, the ended tickets' rollouts (live or from a local evidence dir), and the context tree. */
  private async collect(): Promise<void> {
    const live = await collectEvidence(this.options.url, this.options.evidenceDir ? 0 : this.options.maxTickets)
    const rollouts = this.options.evidenceDir ? await readRolloutDir(this.options.evidenceDir) : live.rollouts
    this.state.head = live.head
    this.state.rollouts = rollouts
    // The long-term memory rides into the context: the lessons and what earlier runs measured.
    const outcomesTail = outcomesMarkdown(await readOutcomes(this.libraryDir, 10))
    await writeContext(this.dir('context'), { mission: this.mission, head: live.head, rollouts, tree: configToTree(live.head.config), library: this.libraryDir, outcomesTail })
  }
  /** propose: two lenses per round (invariant, domain); parallel mode widens with k of each, sequential rounds refine the checkpoint. */
  private async propose(): Promise<void> {
    const rounds = this.options.mode === 'sequential' ? this.options.k : 1
    const candidates: Candidate[] = []
    for (let round = 1; round <= rounds; round++) {
      const lenses: ('invariant' | 'domain')[] = this.options.mode === 'parallel'
        ? [...Array.from({ length: this.options.k }, () => 'invariant' as const), ...Array.from({ length: this.options.k }, () => 'domain' as const)]
        : ['invariant' as const, 'domain' as const]
      const seen = { invariant: 0, domain: 0 }
      for (const lens of lenses) {
        seen[lens] += 1
        const label = this.options.mode === 'parallel' ? `${lens === 'invariant' ? 'inv' : 'dom'}${seen[lens]}` : `${lens === 'invariant' ? 'inv' : 'dom'}-${round}`
        candidates.push(await this.proposeOne(label, lens, round))
      }
      if (this.options.mode === 'sequential') await this.composeRound(round, candidates)
    }
    this.state.candidates = candidates.map(({ label, lens, notes, inherited }) => ({ label, lens, notes, inherited }))
  }
  /** One session with a single retry — a crashed or timed-out session is treated like a refused proposal. */
  private async session(prompt: string, workspace: string): Promise<string> {
    try { return await this.options.runner.run(prompt, workspace) }
    catch (error) { return await this.options.runner.run(`${prompt}\n\n(Your previous session ended abnormally: ${error instanceof Error ? error.message : String(error)}. Continue and finish.)`, workspace) }
  }
  /** One proposer in its own workspace; a refused proposal goes back once with the error, then inherits the base. */
  private async proposeOne(label: string, lens: 'invariant' | 'domain', round: number): Promise<Candidate> {
    const workspace = this.dir('proposals', label)
    await this.seedContext(workspace)
    if (this.options.mode === 'sequential' && round > 1) {
      await cp(this.dir('checkpoint', 'context', 'harness'), join(workspace, 'context', 'harness'), { recursive: true })
    }
    let reply = await this.session(proposePrompt({ lens }), workspace)
    let notes = readFence(reply, 'notes')
    let probed = await this.probe(workspace)
    if (typeof probed === 'string' && probed !== 'unchanged') {
      reply = await this.session(`${proposePrompt({ lens })}\nYour previous proposal was refused:\n${probed}\nFix context/harness/ accordingly.`, workspace)
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
      await call(this.options.url, 'POST prompts/preview', { body: this.candidateConfig(tree) })
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
      await this.session(composePrompt(), workspace)
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
    await this.session(composePrompt(), workspace)
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
    const reply = await this.session(selectPrompt({ ids }), workspace)
    const choice = parseChoice(reply, ids)
    this.state.choice = mapping[choice] ?? ''
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'decision.md'), `selected: ${choice} -> ${this.state.choice}\n${readFence(reply, 'why') ?? ''}`)
  }
  /** behave: the strategy upgrade — measure base and candidate on held-out micro-tasks before anything is saved. */
  private async behave(): Promise<void> {
    const probe = this.options.behavioural
    if (!probe) return
    const { readTasks } = await import('./behave.ts')
    const tasks = await readTasks(probe.tasksFile)
    const head = this.head()
    const chosen = await this.chosenConfig()
    const root = this.dir('behaviour')
    await mkdir(root, { recursive: true })
    const base = await scoreGroup({ group: 'base', sections: head.config, tasks, rounds: probe.rounds, runner: this.options.runner, root, timeoutMs: probe.timeoutMs })
    const candidate = await scoreGroup({ group: 'candidate', sections: chosen, tasks, rounds: probe.rounds, runner: this.options.runner, root, timeoutMs: probe.timeoutMs })
    // Timing noise on a tie is not an improvement: the candidate must win pass-rate, or finish ≥10% faster.
    const candidateBetter = candidate.passed > base.passed
      || (candidate.passed === base.passed && candidate.seconds < base.seconds * 0.9)
    this.state.behaviour = { base, candidate, candidateBetter }
    await writeFile(join(root, 'metrics.json'), JSON.stringify(this.state.behaviour, null, 2))
  }
  /** apply: save the chosen harness as a new prompt version, unless the behavioural probe voted it down. */
  private async apply(): Promise<void> {
    if (!this.state.choice) throw new Error('nothing was selected; run the earlier stages first')
    const config = await this.draftConfig()
    const head = this.head()
    await mkdir(this.dir('adopted'), { recursive: true })
    if (this.state.behaviour && !this.state.behaviour.candidateBetter) {
      this.state.rejectedByBehaviour = true
      await writeFile(this.dir('adopted', 'rejected.json'),
        JSON.stringify({ reason: 'the behavioural probe scored the candidate no better than the base', behaviour: this.state.behaviour }, null, 2))
      return
    }
    if (this.options.dryRun) {
      await writeFile(this.dir('adopted', 'dry-run.json'), JSON.stringify({ wouldSave: config, baseRevision: head.revision }, null, 2))
      return
    }
    const result = await call(this.options.url, 'PUT prompts', { body: { config, baseRevision: head.revision } }) as { revision: number }
    this.state.adoptedRevision = result.revision
    await writeFile(this.dir('adopted', 'config.json'), JSON.stringify({ revision: result.revision, config }, null, 2))
  }
  /** reflect: attribute the adoption and keep at most one evidence-supported lesson in the library. */
  private async reflect(): Promise<void> {
    const candidates = await this.candidates()
    for (const label of this.state.finals ?? []) candidates.push({ label, lens: 'domain', workspace: this.dir('finals', label) })
    const workspace = await this.poolWorkspace(this.dir('reflection'), candidates)
    await writeFile(join(workspace, 'context', 'decision.md'),
      `selected: ${this.state.choice ?? '(none)'}\nadopted revision: ${this.state.rejectedByBehaviour ? 'rejected by the behavioural probe' : String(this.state.adoptedRevision ?? '(dry run)')}\n` +
      (this.state.behaviour ? `behavioural probe: base ${this.state.behaviour.base.passed}/${this.state.behaviour.base.total} in ${this.state.behaviour.base.seconds.toFixed(1)}s avg; candidate ${this.state.behaviour.candidate.passed}/${this.state.behaviour.candidate.total} in ${this.state.behaviour.candidate.seconds.toFixed(1)}s avg\n` : ''))
    const reply = await this.session(reflectPrompt(), workspace)
    const reflection = parseReflection(reply)
    await writeFile(join(workspace, 'reflection.md'), reply)
    // The outcome record is the long-term memory: what this run tried and what it measured, kept even on rejection.
    if (!this.options.dryRun) {
      const runLabel = `${this.options.mode}${this.options.k}-s${this.options.seed}`
      const probeText = this.state.behaviour
        ? { base: `${this.state.behaviour.base.passed}/${this.state.behaviour.base.total} in ${this.state.behaviour.base.seconds.toFixed(1)}s avg`,
            candidate: `${this.state.behaviour.candidate.passed}/${this.state.behaviour.candidate.total} in ${this.state.behaviour.candidate.seconds.toFixed(1)}s avg` }
        : undefined
      await appendOutcome(this.libraryDir, { date: new Date().toISOString().slice(0, 10), run: runLabel,
        selected: this.state.choice ?? '(none)', adopted: this.state.adoptedRevision !== undefined,
        ...(this.state.adoptedRevision !== undefined ? { adoptedRevision: this.state.adoptedRevision } : {}),
        ...(this.state.rejectedByBehaviour ? { rejectedByBehaviour: true } : {}), ...(probeText ? { probe: probeText } : {}),
        ...(this.state.lesson ? { lesson: this.state.lesson.lesson } : {}) })
    }
    const lesson = reflection.experience
    if (lesson && !this.options.dryRun) {
      const entry: LibraryEntry = { date: new Date().toISOString().slice(0, 10),
        run: `${this.options.mode}${this.options.k}-s${this.options.seed}`, ...lesson }
      await appendEntry(this.libraryDir, entry)
      this.state.lesson = entry
    }
    if (this.state.choice && !this.options.dryRun && !this.state.rejectedByBehaviour) {
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
  /** The composed configuration the run would save right now: the selected final, or the base when behaviour rejected it. */
  async draftConfig(): Promise<PromptConfig> {
    if (this.state.rejectedByBehaviour) return this.head().config
    if (!this.state.choice) throw new Error('nothing selected yet')
    const source = this.state.choice === 'checkpoint' ? this.dir('checkpoint') : this.dir('finals', this.state.choice)
    return this.candidateConfig(await readTree(join(source, 'context', 'harness')))
  }
  /** The configuration the selection chose, whether or not behaviour later rejected it. */
  private async chosenConfig(): Promise<PromptConfig> {
    if (!this.state.choice) throw new Error('nothing selected yet')
    const source = this.state.choice === 'checkpoint' ? this.dir('checkpoint') : this.dir('finals', this.state.choice)
    return this.candidateConfig(await readTree(join(source, 'context', 'harness')))
  }
  /** Builds the run report: what changed in the harness, and what the behavioural probe measured. */
  async report(): Promise<string> {
    const head = this.head()
    const lines: string[] = [`# RSI run report — ${this.options.mode}${this.options.k} seed ${this.options.seed}`, '',
      `stages done: ${this.state.done.join(', ')}`, `evidence rollouts: ${this.state.rollouts?.length ?? 0}`, '']
    if (this.state.behaviour) {
      const { base, candidate, candidateBetter } = this.state.behaviour
      lines.push('## Behavioural probe (held-out micro-tasks)', '',
        '| group | passed | avg seconds |', '|---|---|---|',
        `| base | ${base.passed}/${base.total} | ${base.seconds.toFixed(1)} |`,
        `| candidate | ${candidate.passed}/${candidate.total} | ${candidate.seconds.toFixed(1)} |`, '',
        `verdict: ${candidateBetter ? 'candidate measured better' : 'no measured improvement'}`, '')
    }
    if (this.state.rejectedByBehaviour) lines.push('adoption: **rejected** — the probe found no improvement, the base harness stays.', '')
    else if (this.state.adoptedRevision !== undefined) lines.push(`adoption: saved as prompt revision **${this.state.adoptedRevision}** (base revision ${head.revision}).`, '')
    else if (this.options.dryRun) lines.push('adoption: dry run — nothing was saved; see `adopted/dry-run.json`.', '')
    try {
      const config = await this.chosenConfig()
      const diff = diffTrees(configToTree(head.config), configToTree(config))
      lines.push('## Harness diff (base → selected)', '', '```diff', diff || '(no changes)', '```', '')
    } catch { /* the selection stage has not produced a final yet */ }
    if (this.state.lesson) lines.push('## Experience lesson', '', `- cue: ${this.state.lesson.cue}`, `- lesson: ${this.state.lesson.lesson}`,
      `- evidence: ${this.state.lesson.evidence}`, `- confidence: ${this.state.lesson.confidence}`, '')
    return lines.join('\n')
  }
  /** A one-line summary for the CLI: what the run did and what it changed. */
  summary(): string {
    const parts = [`run ${this.runDir}`, `stages: ${this.state.done.join(',') || 'none'}`]
    if (this.state.choice) parts.push(`selected: ${this.state.choice}`)
    if (this.state.behaviour) parts.push(`probe: base ${this.state.behaviour.base.passed}/${this.state.behaviour.base.total} vs candidate ${this.state.behaviour.candidate.passed}/${this.state.behaviour.candidate.total}`)
    if (this.state.rejectedByBehaviour) parts.push('adoption REJECTED by the behavioural probe')
    else if (this.state.adoptedRevision !== undefined) parts.push(`adopted prompt revision ${this.state.adoptedRevision}`)
    if (this.options.dryRun) parts.push('dry run: nothing was saved')
    if (this.state.lesson) parts.push(`lesson: ${this.state.lesson.lesson.slice(0, 80)}`)
    return parts.join(' · ')
  }
  /** The library index this run reads and writes. */
  library(): Promise<string> { return readIndex(this.libraryDir) }
}
