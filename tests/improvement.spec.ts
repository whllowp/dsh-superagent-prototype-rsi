/** The RSI improver: harness tree mechanics, session reply parsing, the library, and the whole pipeline on fakes. */
import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { configToTree, configWithBases, diffTrees, readFence, treeToConfig, validateTree } from '../src/improvement/tree.ts'
import { parseChoice, parseReflection, proposePrompt, reflectPrompt } from '../src/improvement/sessions.ts'
import { appendEntry, keepAdopted, readIndex } from '../src/improvement/library.ts'
import { renderRollout, toRollout } from '../src/improvement/evidence.ts'
import { Improver } from '../src/improvement/pipeline.ts'
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
function fakeApi(options: { base: PromptConfig }) {
  const saves: { config: PromptConfig; baseRevision: number }[] = []
  const fetchFake = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const route = `${init?.method ?? 'GET'} ${url.pathname.replace(/^.*\/orchestrator\/api\//, '')}`
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (route === 'GET prompts') return json({ current: { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config: options.base }, defaults: options.base })
    if (route === 'GET state') return json({ setup: { machine: { promptMaxChars: 1_000_000 } }, health: {}, load: {} })
    if (route === 'GET tickets') return json({ items: [], next_offset: undefined })
    if (route === 'POST prompts/preview') return json({ orchestrator: 'x', worker: 'x', parts: {}, skills: {}, scope: '' })
    if (route === 'PUT prompts') { saves.push({ config: body!.config as PromptConfig, baseRevision: body!.baseRevision as number }); return json({ revision: saves.length, context_delivery: 'pending' }) }
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
        expect(state.done).toEqual(['collect', 'propose', 'compose', 'select', 'apply', 'reflect'])
        expect(state.candidates).toHaveLength(4)
        expect(state.finals).toEqual(['final1', 'final2'])
        expect(state.choice).toBeTruthy()
        expect(state.adoptedRevision).toBeUndefined()
        expect(api.saves).toHaveLength(0)
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
  it('refuses a proposal once with its error, then accepts the fixed one', async () => {
    await withTemp(async directory => {
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
})
