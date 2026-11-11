/** The RSI improver CLI: run one Propose–Probe–Compose recursion over dsh-superagent's own prompt harness. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DshHeadlessRunner } from './sessions.ts'
import { Improver, STAGES, type Stage } from './pipeline.ts'
import { publisher, publishers } from './publishers.ts'
import { runRouterCli } from '../router/cli.ts'
import { miniParse } from './args.ts'

const usage = `dsh-superagent RSI improver — improve the harness from its own ended tickets.

Usage:
  node lib/improve.js run [--url U] [--runs-dir D] [--tag T] [--k N] [--mode parallel|sequential]
                          [--seed N] [--max-tickets N] [--dsh BIN] [--timeout MS]
                          [--stage ${STAGES.join('|')}] [--mission FILE] [--evidence DIR]
                          [--behavioural TASKS.json] [--rounds N] [--probe-timeout MS] [--dry-run]
  node lib/improve.js report [--runs-dir D] [--tag T] [--k N] [--mode M] [--seed N]
  node lib/improve.js library [--runs-dir D] [--tag T]
  node lib/improve.js publish [--url U] [--runs-dir D] [--tag T] [--publisher NAME] [--skill-name NAME] [--max-skill N]
  node lib/improve.js router run|verify|switch [...]    # the separated super-agent router (dsh-router)

run       collects the ended tickets as evidence (or a local --evidence dir of rollout *.md files),
          then proposes, probes, composes and blind-selects candidate harnesses; with --behavioural,
          base and candidate are measured on held-out micro-tasks before anything is saved, and a
          candidate that scores no better is rejected. --dry-run writes what would have been saved.
report    prints (and writes report.md for) a finished run: the harness diff and probe measurements.
library   prints the experience library's index for the tag.
publish   sediments the knowledge base through one of the registered publishers
          (${publishers().map(p => p.name).join(', ')}); prompt-skill saves it as a team skill every
          session can load on demand, saved as a new prompt version, reversible from the panel.

The headless sessions need model credentials: set DEEPSEEK_API_KEY in the environment, in a local
.env file (DEEPSEEK_API_KEY=...), or DEEPSEEK_AUTH_TOKEN is picked up automatically.`

/** The whole CLI; `argv` is the token list after the program name (process.argv.slice(2)). */
export async function runCli(argv: string[]): Promise<number> {
  // The beginner path: model credentials often live in a local .env rather than the session environment.
  try {
    const raw = await import('node:fs/promises').then(fs => fs.readFile('.env', 'utf8'))
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/)
      if (match && !process.env[match[1]!]) process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, '')
    }
  } catch { /* no .env, fine */ }
  if (!process.env.DEEEPSEEK_API_KEY && process.env.DEEEPSEEK_AUTH_TOKEN) {
    process.env.DEEEPSEEK_API_KEY = process.env.DEEEPSEEK_AUTH_TOKEN
  }
  const { positionals, values } = miniParse(argv, {
    url: { type: 'string', default: process.env.DSH_SUPERAGENT_URL ?? 'http://127.0.0.1:3082' },
    'runs-dir': { type: 'string', default: 'runs' },
    tag: { type: 'string', default: 'default' },
    k: { type: 'string', default: '1' },
    mode: { type: 'string', default: 'parallel' },
    seed: { type: 'string', default: '1' },
    'max-tickets': { type: 'string', default: '30' },
    dsh: { type: 'string', default: process.env.DSH_SUPERAGENT_DSH ?? 'dsh' },
    timeout: { type: 'string', default: '900000' },
    stage: { type: 'string', default: 'all' },
    mission: { type: 'string' },
    evidence: { type: 'string' },
    behavioural: { type: 'string' },
    rounds: { type: 'string', default: '1' },
    'probe-timeout': { type: 'string', default: '120000' },
    publisher: { type: 'string', default: 'prompt-skill' },
    'skill-name': { type: 'string', default: 'deployment-knowledge' },
    'max-skill': { type: 'string', default: '8000' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  }, { allowPositionals: true })
  const command = positionals[0] ?? 'run'
  if (command === 'router') return runRouterCli(positionals.slice(1))
  if (values.help || !['run', 'library', 'report', 'publish'].includes(command)) {
    console.log(usage)
    return values.help ? 0 : 1
  }
  // The beginner path: the credentials service stores the key as DEEPSEEK_AUTH_TOKEN in some setups;
  // the model provider looks for DEEPSEEK_API_KEY in the session environment, so bridge the two.
  if (!process.env.DEEEPSEEK_API_KEY && process.env.DEEEPSEEK_AUTH_TOKEN) {
    process.env.DEEEPSEEK_API_KEY = process.env.DEEEPSEEK_AUTH_TOKEN
  }
  const k = Math.max(1, Number(values.k) || 1)
  const mode = values.mode === 'sequential' ? 'sequential' as const : 'parallel' as const
  const seed = Number(values.seed) || 1
  const options = {
    url: values.url!, runsDir: values['runs-dir']!, tag: values.tag!, k, mode, seed,
    maxTickets: Math.max(1, Number(values['max-tickets']) || 30),
    runner: new DshHeadlessRunner(values.dsh!, Number(values.timeout) || 900_000),
    dryRun: values['dry-run']!,
    mission: values.mission ? await import('node:fs/promises').then(fs => fs.readFile(values.mission!, 'utf8')) : undefined,
    evidenceDir: values.evidence,
    behavioural: values.behavioural
      ? { tasksFile: values.behavioural, rounds: Math.max(1, Number(values.rounds) || 1), timeoutMs: Number(values['probe-timeout']) || 120_000 }
      : undefined,
  }
  const improver = new Improver(options)
  if (command === 'library') {
    console.log(await improver.library())
    return 0
  }
  if (command === 'publish') {
    const active = publisher(values.publisher!)
    if (!active) {
      console.error(`unknown publisher ${values.publisher}; registered: ${publishers().map(p => p.name).join(', ')}`)
      return 1
    }
    const result = await active.publish({ url: options.url, libraryDir: join(options.runsDir, 'library', options.tag),
      skillName: values['skill-name'], maxChars: Number(values['max-skill']) || 8_000 })
    console.log(`published via '${active.name}': ${result.target}${result.revision !== undefined ? ` (prompt revision ${result.revision})` : ''}`)
    return 0
  }
  await improver.load()
  if (command === 'report') {
    const text = await improver.report()
    console.log(text)
    await writeFile(join(improver.directory, 'report.md'), text)
    return 0
  }
  const from = values.stage === 'all' ? undefined : STAGES.includes(values.stage as Stage) ? values.stage as Stage : undefined
  if (values.stage !== 'all' && from === undefined) {
    console.error(`unknown stage ${values.stage}; choose one of: all, ${STAGES.join(', ')}`)
    return 1
  }
  await improver.run(from)
  console.log(improver.summary())
  return 0
}
