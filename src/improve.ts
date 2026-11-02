/** The RSI improver CLI: run one Propose–Probe–Compose recursion over dsh-superagent's own prompt harness. */
import { parseArgs } from 'node:util'
import { DshHeadlessRunner } from './improvement/sessions.ts'
import { Improver, STAGES, type Stage } from './improvement/pipeline.ts'

const usage = `dsh-superagent RSI improver — improve the harness from its own ended tickets.

Usage:
  node lib/improve.js run [--url U] [--runs-dir D] [--tag T] [--k N] [--mode parallel|sequential]
                          [--seed N] [--max-tickets N] [--dsh BIN] [--timeout MS]
                          [--stage ${STAGES.join('|')}] [--mission FILE] [--dry-run]
  node lib/improve.js library [--runs-dir D] [--tag T]

run       collects the ended tickets as evidence, then proposes, probes, composes and blind-selects
          candidate harnesses, and saves the winner as a new prompt version (--dry-run writes it beside the run instead).
library   prints the experience library's index for the tag.`

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
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
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  const command = positionals[0] ?? 'run'
  if (values.help || !['run', 'library'].includes(command)) {
    console.log(usage)
    return values.help ? 0 : 1
  }
  const options = {
    url: values.url!, runsDir: values['runs-dir']!, tag: values.tag!,
    k: Math.max(1, Number(values.k) || 1),
    mode: values.mode === 'sequential' ? 'sequential' as const : 'parallel' as const,
    seed: Number(values.seed) || 1,
    maxTickets: Math.max(1, Number(values['max-tickets']) || 30),
    runner: new DshHeadlessRunner(values.dsh!, Number(values.timeout) || 900_000),
    dryRun: values['dry-run']!,
    mission: values.mission ? await import('node:fs/promises').then(fs => fs.readFile(values.mission!, 'utf8')) : undefined,
  }
  const improver = new Improver(options)
  if (command === 'library') {
    console.log(await improver.library())
    return 0
  }
  await improver.load()
  const from = values.stage === 'all' ? 'collect' : STAGES.includes(values.stage as Stage) ? values.stage as Stage : undefined
  if (!from) {
    console.error(`unknown stage ${values.stage}; choose one of: all, ${STAGES.join(', ')}`)
    return 1
  }
  await improver.run(from)
  console.log(improver.summary())
  return 0
}
process.on('unhandledRejection', error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
