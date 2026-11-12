/** The RSI improver: harness tree mechanics, session reply parsing, the library, and the whole pipeline on fakes. */
import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { configToTree, configWithBases, diffTrees, readFence, treeToConfig, validateTree } from '../src/improvement/tree.ts'
import { parseChoice, parseReflection, proposePrompt, reflectPrompt } from '../src/improvement/sessions.ts'
import { appendEntry, appendOutcome, appendPrediction, keepAdopted, outcomesMarkdown, readIndex, readOutcomes } from '../src/improvement/library.ts'
import { knowledgeSkillText, publishKnowledge } from '../src/improvement/publish.ts'
import { publisher, publishers, registerPublisher } from '../src/improvement/publishers.ts'
import { penalized, predictor as predictorByName, registerPredictor } from '../src/improvement/predictor.ts'
import { renderRollout, toRollout } from '../src/improvement/evidence.ts'
import { Improver } from '../src/improvement/pipeline.ts'
import { verifyRevisions, verifyTable } from '../src/router/verify.ts'
import { switchToRevision } from '../src/router/switch.ts'
import { dispatchParallel } from '../src/router/parallel.ts'
import type { PromptConfig } from '../src/app/prompts.ts'

const defaults = defaultPrompts()
const limit = { defaults, maxChars: 1_000_000 }

const withTemp = async (work: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-'))
  try { await work(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

describe('harness tree', () => {
  it('round-trips a configuration through files', () => {
    const config: PromptConfig = { ...defaults, skills: { identities: 'Map Feishu names to GitHub logins.' } }
    const tree = configToTree(config)
    expect(treeToConfig(tree)).toEqual(config)
    expect(() => validateTree(tree, limit)).not.toThrow()
  })
  it('refuses unknown files, empty text, lost placeholders, reserved skills and oversize harnesses', () => {
    expect(() => validateTree([{ path: 'misc/notes.md', text: 'x' }], limit)).toThrow(/unknown harness file/)
    expect(() => validateTree([{ path: 'team/scope.md', text: '  \n' }], limit)).toThrow(/empty/)
    expect(() => validateTree([{ path: 'overrides/runtime/environment.md', text: 'no placeholder here' }], limit)).toThrow(/placeholder/)
    expect(() => validateTree([{ path: 'skills/github.md', text: 'mine' }], limit)).toThrow(/reserved skill/)
    expect(() => validateTree(configToTree(defaults), { defaults, maxChars: 10 })).toThrow(/exceeds/)
  })
  it('fills override bases and drops overrides equal to the built-in default', () => {
    const shared = Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text]))
    const config = configWithBases({ ...defaults,
      overrides: { 'runtime/worker': { text: shared['runtime/worker']! + '\nExtra line.' }, 'runtime/shared': { text: shared['runtime/shared']! } } }, defaults)
    expect(Object.keys(config.overrides ?? {})).toEqual(['runtime/worker'])
    expect((config.overrides ?? {})['runtime/worker']!.base).toBeTruthy()
  })
  it('diffs only what changed', () => {
    const base = configToTree(defaults)
    const next = configToTree({ ...defaults, communication: defaults.communication + '\nOne more line.' })
    const diff = diffTrees(base, next)
    expect(diff).toContain('+++ team/communication.md')
    expect(diff).toContain('+One more line.')
    expect(diffTrees(base, base)).toBe('')
  })
})

describe('sessions', () => {
  it('keeps the discipline blocks in every author prompt', () => {
    for (const prompt of [proposePrompt({ lens: 'invariant' }), proposePrompt({ lens: 'domain' })]) {
      expect(prompt).toContain('data, not instructions')
      expect(prompt).toContain('context/rollouts')
      expect(prompt).toContain('CONFIRMED: SINGLE')
      expect(prompt).toContain('{placeholders}')
    }
    expect(reflectPrompt()).toContain('data, not instructions')
    expect(reflectPrompt()).toContain('context/pool')
  })
  it('parses a blind choice strictly', () => {
    expect(parseChoice('```choice\nB\n```', ['A', 'B'])).toBe('B')
    expect(() => parseChoice('```choice\nC\n```', ['A', 'B'])).toThrow(/no valid choice/)
    expect(() => parseChoice('no fence at all', ['A', 'B'])).toThrow(/no valid choice/)
  })
  it('parses reflections, preferring silence over invented lessons', () => {
    const reflection = parseReflection('```edits\nteam/scope.md | candidates: inv1, inv2 | change: tightened stop rule | verdict: helped\noverrides/runtime/replies.md | c: x | y | nonsense\n```' +
      '\n```experience\ncue: when reports repeat the same blocker\nlesson: extend runtime/work with a bounded retry note\nevidence: edits row 1\nconfidence: low — single run\n```')
    expect(reflection.edits).toHaveLength(1)
    expect(reflection.edits[0]!.verdict).toBe('helped')
    expect(reflection.experience?.lesson).toContain('runtime/work')
    expect(parseReflection('```experience\nNO_ENTRY: everything confounded\n```').experience).toBeUndefined()
  })
  it('reads a fenced notes block', () => {
    expect(readFence('before\n```notes\nkept -> a -> rollouts/1.md\n```', 'notes')).toBe('kept -> a -> rollouts/1.md')
    expect(readFence('nothing', 'notes')).toBeUndefined()
  })
})

describe('evidence', () => {
  it('renders stored reports as a rollout', () => {
    const rollout = toRollout('t1', { title: 'Fix copy', stage: 'ended', outcome: 'merged',
      mandate: { basis: { rules: [{ id: 'copy', name: 'Copy fixes' }], sender: 'alice' } },
      assignments: [{ report: { state: 'ready', summary: 'PR #9 ready', at: '2026-11-01T00:00:00Z' } }] })
    const text = renderRollout(rollout)
    expect(text).toContain('[REPORT ready at 2026-11-01T00:00:00Z] PR #9 ready')
    expect(text).toContain('mandate rules: copy')
    expect(text).toContain('outcome: merged')
  })
})

describe('library', () => {
  it('keeps lessons and adopted harnesses', async () => {
    await withTemp(async directory => {
      expect(await readIndex(directory)).toContain('empty library')
      await appendEntry(directory, { date: '2026-11-02', run: 'parallel2-s1', cue: 'c', lesson: 'l', evidence: 'e', confidence: 'low' })
      await appendEntry(directory, { date: '2026-11-03', run: 'parallel2-s1', cue: 'c2', lesson: 'l2', evidence: 'e2', confidence: 'medium' })
      const index = await readIndex(directory)
      expect(index).toContain('- lesson: l')
      expect(index).toContain('- lesson: l2')
      await keepAdopted(directory, 'parallel2-s1', [{ path: 'team/scope.md', text: 'scope' }])
      expect(await readFile(join(directory, 'harnesses', 'parallel2-s1', 'team', 'scope.md'), 'utf8')).toBe('scope')
    })
  })
  it('sediments run outcomes as long-term memory, kept even on rejection', async () => {
    await withTemp(async directory => {
      await appendOutcome(directory, { date: '2026-11-02', run: 'parallel1-s7', selected: 'final1', adopted: false, rejectedByBehaviour: true, probe: { base: '3/3', candidate: '3/3' } })
      await appendOutcome(directory, { date: '2026-11-03', run: 'parallel1-s8', selected: 'final1', adopted: true, adoptedRevision: 4 })
      expect(await readOutcomes(directory, 10)).toHaveLength(2)
      expect((await readOutcomes(directory, 1))[0]?.adoptedRevision).toBe(4)
      const markdown = outcomesMarkdown(await readOutcomes(directory, 10))
      expect(markdown).toContain('rejected by the behavioural probe')
      expect(markdown).toContain('ADOPTED as revision 4')
    })
  })
  it('publishes the knowledge base as a team skill alongside existing skills', async () => {
    await withTemp(async directory => {
      const api = fakeApi({ base: { ...defaults, skills: { identities: 'existing skill' } } })
      try {
        await appendEntry(directory, { date: '2026-11-02', run: 'parallel1-s7', cue: 'c', lesson: 'prefer skills over always-on text', evidence: 'e', confidence: 'high' })
        await appendOutcome(directory, { date: '2026-11-02', run: 'parallel1-s7', selected: 'final1', adopted: false, rejectedByBehaviour: true, probe: { base: '4/4 in 76.5s avg', candidate: '4/4 in 73.3s avg' } })
        const result = await publishKnowledge({ url: 'http://127.0.0.1:39999', libraryDir: directory, maxChars: 8000 })
        expect(result.lessons).toBe(1)
        expect(result.outcomes).toBe(1)
        expect(api.saves).toHaveLength(1)
        const saved = api.saves[0]!.config.skills ?? {}
        expect(saved.identities).toBe('existing skill')
        expect(saved['deployment-knowledge']).toContain('prefer skills over always-on text')
        expect(saved['deployment-knowledge']).toContain('rejected by the behavioural probe')
      } finally { api.unstub() }
    })
  })
  it('exposes publishers as a pluggable registry with two built-ins', async () => {
    const names = publishers().map(p => p.name)
    expect(names).toContain('prompt-skill')
    expect(names).toContain('file')
    expect(publisher('file')).toBeTruthy()
    expect(() => registerPublisher({ name: 'file', description: 'x', publish: async () => ({ target: 'x' }) })).toThrow(/already registered/)
    expect(publisher('does-not-exist')).toBeUndefined()
  })
  it('the file publisher sediments beside the library without touching the deployment', async () => {
    await withTemp(async directory => {
      await appendOutcome(directory, { date: '2026-11-03', run: 'parallel1-s7', selected: 'final1', adopted: false, rejectedByBehaviour: true, probe: { base: '4/4', candidate: '4/4' } })
      const result = await publisher('file')!.publish({ url: 'http://127.0.0.1:39999', libraryDir: directory })
      expect(result.target).toContain('published')
      const text = await readFile(join(directory, 'published', 'deployment-knowledge.md'), 'utf8')
      expect(text).toContain('rejected by the behavioural probe')
      expect(text).toContain('probe 4/4 vs 4/4')
    })
  })
})

describe('predictor', () => {
  const base: { path: string; text: string }[] = [
    { path: 'team/communication.md', text: defaults.communication },
    { path: 'team/scope.md', text: defaults.scope },
    { path: 'team/delivery.md', text: defaults.delivery },
  ]
  const heuristic = predictorByName('heuristic')!
  it('is registered as the default and refuses duplicate names', () => {
    expect(heuristic.name).toBe('heuristic')
    expect(() => registerPredictor(heuristic)).toThrow(/already registered/)
  })
  it('penalizes always-on growth and rewards skills and named moments', () => {
    const grown = heuristic.predict({ base, candidate: [
      ...base, { path: 'team/delivery.md', text: defaults.delivery + 'x'.repeat(400) }] })
    expect(grown.score).toBeLessThan(50)
    const skilled = heuristic.predict({ base, candidate: [
      ...base, { path: 'skills/local-ui-handoff.md', text: 'A checklist.' }], notes: 'moments: rollouts/t1.md, rollouts/t2.md' })
    expect(skilled.score).toBeGreaterThan(50)
    expect(skilled.reasons.join(' ')).toContain('rollout moments')
    expect(penalized(skilled.score, skilled.uncertainty, 0.5)).toBeLessThanOrEqual(skilled.score)
  })
  it('penalizes restatement and missing notes with uncertainty', () => {
    const restated = heuristic.predict({ base, candidate: [
      ...base, { path: 'team/delivery.md', text: defaults.delivery + '\n' + defaults.communication.split('\n')[0] }] })
    expect(restated.reasons.join(' ')).toContain('restates')
    const silent = heuristic.predict({ base, candidate: [...base, { path: 'team/scope.md', text: defaults.scope + '\nmore' }] })
    expect(silent.uncertainty).toBeGreaterThan(0.3)
  })
})

describe('router', () => {
  it('dispatches parallel agents from a plan and merges their replies', async () => {
    await withTemp(async directory => {
      const project = join(directory, 'project')
      await mkdir(project, { recursive: true })
      const plan = join(directory, 'plan.json')
      await writeFile(plan, JSON.stringify({ tasks: [
        { id: 'a', instruction: 'write marker A' },
        { id: 'b', instruction: 'write marker B' },
      ] }))
      const replies: string[] = []
      const runner = { run: async (prompt: string, cwd: string): Promise<string> => {
        if (prompt.includes('one of several agents')) {
          const marker = prompt.includes('marker A') ? 'A' : 'B'
          await writeFile(join(cwd, `marker-${marker}.txt`), marker)
          return `done ${marker}`
        }
        if (prompt.includes("router's merger")) return 'merged final report'
        throw new Error('unknown prompt')
      } }
      const result = await dispatchParallel({ request: 'do A and B', planFile: plan, cwd: project,
        outDir: join(directory, 'out'), concurrency: 2, runner, timeoutMs: 30_000, merge: true })
      expect(result.runs).toHaveLength(2)
      expect(result.runs.every(run => !run.failed)).toBe(true)
      expect(result.merged).toBe('merged final report')
      expect(await readFile(join(result.runs[0]!.workspace, 'marker-A.txt'), 'utf8')).toBe('A')
      expect(await readFile(join(directory, 'out', 'report.md'), 'utf8')).toContain('merged final report')
      expect(replies.length).toBe(0)
    })
  })
  it('verifies stored revisions and names the best one', async () => {
    await withTemp(async directory => {
      const api = fakeApi({ base: defaults, stored: { 0: defaults, 2: { ...defaults, delivery: defaults.delivery + '\nPROBE_MARKER rule' } } })
      try {
        const project = join(directory, 'project')
        await mkdir(project, { recursive: true })
        await writeFile(join(project, 'marker-check.js'), 'process.exit(require(\'fs\').existsSync(\'PROBE_MARKER\')?0:1)')
        const tasks = join(directory, 'tasks.json')
        await writeFile(tasks, JSON.stringify({ tasks: [{ id: 'marker', instruction: 'write the marker', cwd: project, check: 'node marker-check.js' }] }))
        const runner = { run: async (prompt: string, cwd: string): Promise<string> => {
          if (prompt.includes('standing instructions') && prompt.includes('PROBE_MARKER rule')) await writeFile(join(cwd, 'PROBE_MARKER'), 'x')
          return 'DONE'
        } }
        const { scores, best } = await verifyRevisions({ url: 'http://127.0.0.1:39999', revisions: [0, 2], tasksFile: tasks,
          rounds: 1, timeoutMs: 30_000, runner, root: join(directory, 'arbiter') })
        expect(scores.map(s => s.revision)).toEqual([0, 2])
        expect(scores[0]!.passed).toBe(0)
        expect(scores[1]!.passed).toBe(1)
        expect(best).toBe(2)
        expect(verifyTable(scores, best)).toContain('← best')
      } finally { api.unstub() }
    })
  })
  it('switches the live deployment to a stored revision and no-ops on the live one', async () => {
    await withTemp(async directory => {
      void directory
      const rule = '\nnew rule'
      const stored = { 0: defaults, 2: { ...defaults, delivery: defaults.delivery + rule } }
      const api = fakeApi({ base: defaults, stored })
      try {
        const first = await switchToRevision({ url: 'http://127.0.0.1:39999', revision: 2 })
        expect(first.switched).toBe(true)
        expect(api.saves).toHaveLength(1)
        expect(api.saves[0]!.baseRevision).toBe(0)
        expect(api.saves[0]!.config.delivery).toContain('new rule')
        const repeat = await switchToRevision({ url: 'http://127.0.0.1:39999', revision: 2 })
        expect(repeat.switched).toBe(true) // the fake now reports live revision 1, so 2 is still a change
        expect(api.saves).toHaveLength(2)
        const same = await switchToRevision({ url: 'http://127.0.0.1:39999', revision: 2 })
        expect(same.switched).toBe(false) // live is revision 2 now: switching to 2 is a no-op
        expect(api.saves).toHaveLength(2)
      } finally { api.unstub() }
    })
  })
})

/** A headless runner that plays the four session roles against a workspace, editing files the way a model would. */
function fakeRunner(): { run: (prompt: string, cwd: string) => Promise<string>; proposeCalls: () => number } {
  let proposes = 0
  const readFile0 = async (path: string) => readFile(path, 'utf8')
  const run = async (prompt: string, cwd: string): Promise<string> => {
    if (prompt.includes('adapting a coding agent')) {
      proposes++
      const communication = join(cwd, 'context', 'harness', 'team', 'communication.md')
      await writeFile(communication, await readFile0(communication) + `\nAcknowledge every request before substantial work. [rsi-${proposes}]`)
      return '```notes\nkept -> team/communication.md -> rollouts/t1.md [REPORT blocked]\n```'
    }
    if (prompt.includes('integration judge')) {
      const pool = join(cwd, 'context', 'pool')
      const labels = await readdir(pool).catch(() => [] as string[])
      const source = join(pool, labels.find(label => label.startsWith('inv')) ?? 'inv1', 'harness', 'team', 'communication.md')
      const text = await readFile0(source).catch(() => undefined)
      if (text !== undefined) await writeFile(join(cwd, 'context', 'harness', 'team', 'communication.md'), text)
      return '```notes\nkept -> team/communication.md -> ' + (labels[0] ?? 'pool') + ' notes\n```'
    }
    if (prompt.includes('Choose the one harness')) return '```choice\nA\n```'
    if (prompt.includes('reflecting on an adoption')) {
      return '```edits\nteam/communication.md | candidates: inv1, final1 | change: added an acknowledgement rule | verdict: confounded\n```' +
        '\n```experience\ncue: when blocked reports repeat across tickets\nlesson: extend team/communication with an earlier acknowledgement rule\nevidence: confounded row\nconfidence: low — one run\n```'
    }
    throw new Error(`fake runner met an unknown prompt: ${prompt.slice(0, 80)}`)
  }
  return { run, proposeCalls: () => proposes }
}

/** Installs a fake management API: the prompts of revision 0, an empty ended list, and a recorder for saves. */
function fakeApi(options: { base: PromptConfig; stored?: Record<number, PromptConfig> }) {
  const saves: { config: PromptConfig; baseRevision: number }[] = []
  const live = { revision: 0, config: options.base }
  const fetchFake = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const route = `${init?.method ?? 'GET'} ${url.pathname.replace(/^.*\/orchestrator\/api\//, '')}`
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (route === 'GET prompts') {
      const revision = url.searchParams.get('revision')
      if (revision !== null) {
        const n = Number(revision)
        const stored = options.stored && Object.hasOwn(options.stored, n) ? options.stored[n]! : undefined
        if (stored) return json({ current: { revision: n, previousRevision: null, savedAt: '', source: 'test', config: stored }, defaults: options.base })
        if (n === live.revision) return json({ current: { revision: n, previousRevision: null, savedAt: '', source: 'test', config: live.config }, defaults: options.base })
        return new Response(JSON.stringify({ error: `unknown revision ${n}` }), { status: 400 })
      }
      return json({ current: { revision: live.revision, previousRevision: null, savedAt: '', source: 'test', config: live.config }, defaults: options.base })
    }
    if (route === 'GET state') return json({ setup: { machine: { promptMaxChars: 1_000_000 } }, health: {}, load: {} })
    if (route === 'GET tickets') return json({ items: [], next_offset: undefined })
    if (route === 'POST prompts/preview') {
      if (typeof body?.communication !== 'string') return new Response(JSON.stringify({ error: 'invalid config' }), { status: 400 })
      return json({ orchestrator: 'x', worker: 'x', parts: {}, skills: {}, scope: '' })
    }
    if (route === 'PUT prompts') {
      const config = body!.config as PromptConfig
      saves.push({ config, baseRevision: body!.baseRevision as number })
      live.revision = saves.length
      live.config = config
      return json({ revision: live.revision, context_delivery: 'pending' })
    }
    throw new Error(`fake API met ${route}`)
  })
  vi.stubGlobal('fetch', fetchFake)
  return { saves, unstub: () => vi.unstubAllGlobals() }
}

const improverOptions = (runsDir: string, runner: { run: (prompt: string, cwd: string) => Promise<string> }, over: object = {}) => ({
  url: 'http://127.0.0.1:39999', runsDir, tag: 'test', k: 1, mode: 'parallel' as const, seed: 7, maxTickets: 10,
  runner, dryRun: true, ...over,
})

describe('pipeline', () => {
  it('runs collect..reflect on fakes and saves nothing on a dry run', async () => {
    await withTemp(async directory => {
      const api = fakeApi({ base: defaults })
      try {
        const runner = fakeRunner()
        const improver = new Improver(improverOptions(directory, runner, { k: 2 }))
        const state = await improver.run()
        expect(state.done).toEqual(['collect', 'propose', 'compose', 'select', 'behave', 'apply', 'audit', 'reflect'])
        expect(state.candidates).toHaveLength(4)
        expect(state.finals).toEqual(['final1', 'final2'])
        expect(state.choice).toBeTruthy()
        expect(state.adoptedRevision).toBeUndefined()
        expect(api.saves).toHaveLength(0)
        expect(state.predictions?.filter(p => p.kind === 'candidate')).toHaveLength(4)
        const dry = JSON.parse(await readFile(join(improver.directory, 'adopted', 'dry-run.json'), 'utf8')) as { wouldSave: PromptConfig; baseRevision: number }
        expect(dry.baseRevision).toBe(0)
        expect(dry.wouldSave.communication).toContain('[rsi-')
        expect(state.lesson).toBeUndefined()
        expect(await improver.library()).toContain('empty library')
      } finally { api.unstub() }
    })
  })
  it('saves the composed harness as a new prompt version and keeps one lesson', async () => {
    await withTemp(async directory => {
      const api = fakeApi({ base: defaults })
      try {
        const improver = new Improver(improverOptions(directory, fakeRunner(), { dryRun: false }))
        const state = await improver.run()
        expect(api.saves).toHaveLength(1)
        expect(api.saves[0]!.baseRevision).toBe(0)
        expect(state.adoptedRevision).toBe(1)
        expect(state.predictions?.filter(p => p.kind === 'candidate')).toHaveLength(2)
        expect(state.lesson?.cue).toContain('blocked')
        const index = await improver.library()
        expect(index).toContain('extend team/communication')
        expect(await readFile(join(improver.directory, 'adopted', 'config.json'), 'utf8')).toContain('"revision": 1')
      } finally { api.unstub() }
    })
  })
  it('carries a sequential checkpoint through k rounds', async () => {
    await withTemp(async directory => {
      const api = fakeApi({ base: defaults })
      try {
        const runner = fakeRunner()
        const improver = new Improver(improverOptions(directory, runner, { k: 2, mode: 'sequential' }))
        const state = await improver.run('collect', 'apply')
        expect(state.candidates).toHaveLength(4)
        expect(state.finals).toEqual(['checkpoint'])
        expect(state.choice).toBe('checkpoint')
        const config = await improver.draftConfig()
        expect(config.communication).toContain('[rsi-')
      } finally { api.unstub() }
    })
  })
  it('refuses a proposal once with its error, then accepts the fixed one', async () => {    await withTemp(async directory => {
      const api = fakeApi({ base: defaults })
      try {
        let proposes = 0
        const base = fakeRunner().run
        const runner = { run: async (prompt: string, cwd: string): Promise<string> => {
          if (prompt.includes('adapting a coding agent')) {
            proposes++
            if (proposes === 1) {
              await mkdir(join(cwd, 'context', 'harness', 'overrides', 'runtime'), { recursive: true })
              await writeFile(join(cwd, 'context', 'harness', 'overrides', 'runtime', 'environment.md'), 'placeholder lost')
            } else {
              await mkdir(join(cwd, 'context', 'harness', 'overrides', 'runtime'), { recursive: true })
              await writeFile(join(cwd, 'context', 'harness', 'overrides', 'runtime', 'environment.md'), 'variables:\n{variables}')
            }
          }
          return await base(prompt, cwd)
        } }
        const improver = new Improver(improverOptions(directory, runner))
        const state = await improver.run('collect', 'select')
        expect(proposes).toBeGreaterThanOrEqual(3)
        expect(state.candidates?.[0]?.inherited).toBeFalsy()
      } finally { api.unstub() }
    })
  })
  it('reads local evidence files when no instance holds tickets', async () => {
    await withTemp(async directory => {
      const api = fakeApi({ base: defaults })
      try {
        const evidence = join(directory, 'evidence')
        await mkdir(evidence, { recursive: true })
        await writeFile(join(evidence, 't9.md'), '# rollout t9\n[REPORT blocked] could not read the document')
        const runner = fakeRunner()
        const improver = new Improver({ ...improverOptions(directory, runner), evidenceDir: evidence })
        const state = await improver.run('collect', 'propose')
        expect(state.rollouts).toHaveLength(1)
        expect(state.rollouts?.[0]?.id).toBe('t9')
        expect(await readFile(join(improver.directory, 'context', 'rollouts', 't9.md'), 'utf8')).toContain('[REPORT blocked]')
      } finally { api.unstub() }
    })
  })
  it('rejects adoption when the behavioural probe scores the candidate worse', async () => {
    await withTemp(async directory => {
      const api = fakeApi({ base: defaults })
      try {
        const base = fakeRunner().run
        const project = join(directory, 'project')
        await mkdir(project, { recursive: true })
        await writeFile(join(project, 'marker-check.js'), 'process.exit(require(\'fs\').existsSync(\'PROBE_MARKER\')?0:1)')
        const tasks = join(directory, 'tasks.json')
        // The probe copies this isolated project per run; the checker looks for the marker the fake session writes.
        await writeFile(tasks, JSON.stringify({ tasks: [{ id: 'marker', instruction: 'write the marker', cwd: project, check: 'node marker-check.js' }] }))
        // The candidate harness carries the rsi marker, so a candidate-favouring session makes the candidate group pass.
        const runner = { run: async (prompt: string, cwd: string): Promise<string> => {
          if (prompt.includes('standing instructions')) {
            const favours = prompt.includes('[rsi-')
            if (process.env.PROBE_FAVOURS === 'base' ? !favours : favours) {
              await writeFile(join(cwd, 'PROBE_MARKER'), 'x')
            }
            return 'DONE'
          }
          return await base(prompt, cwd)
        } }
        const improver = new Improver({ ...improverOptions(directory, runner, { dryRun: false }),
          behavioural: { tasksFile: tasks, rounds: 1, timeoutMs: 30_000 } })
        process.env.PROBE_FAVOURS = 'base'
        try {
          const state = await improver.run('collect', 'reflect')
          expect(state.behaviour?.base.passed).toBe(1)
          expect(state.behaviour?.candidate.passed).toBe(0)
          expect(state.rejectedByBehaviour).toBe(true)
          expect(api.saves).toHaveLength(0)
          expect(state.adoptedRevision).toBeUndefined()
          expect(state.finalRanking?.map(r => r.label)).toEqual(['final1'])
          expect(state.predictedBest).toBe('final1')
          expect(state.observedBest).toBe('final1')
          const outcomes = await readOutcomes(join(directory, 'library', 'test'), 10)
          expect(outcomes).toHaveLength(1)
          expect(outcomes[0]?.rejectedByBehaviour).toBe(true)
          expect(outcomes[0]?.probe?.candidate).toContain('0/1')
          expect(outcomes[0]?.predictedBest).toBe('final1')
        } finally { delete process.env.PROBE_FAVOURS }
      } finally { api.unstub() }
    })
  })
})
