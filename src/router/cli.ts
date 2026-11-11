/** The Router CLI: parallel multi-agent dispatch, cross-revision verification, and one-command version switching. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DshHeadlessRunner } from '../improvement/sessions.ts'
import { dispatchParallel } from './parallel.ts'
import { verifyRevisions, verifyTable } from './verify.ts'
import { switchToRevision } from './switch.ts'
import { miniParse } from '../improvement/args.ts'

const usage = `dsh-router — the super-agent router, separated from the deployment: dispatch one request to
several agents in parallel, verify a new RSI version against the live one, or switch versions.

Usage:
  dsh-router run --task "..." [--plan PLAN.json] [--cwd DIR] [--agents N] [--out DIR]
                 [--dsh BIN] [--timeout MS] [--no-merge]
  dsh-router verify --tasks TASKS.json --revisions 0,3 [--rounds N] [--runs-dir D] [--tag T] [--probe-timeout MS]
  dsh-router switch --revision N [--url U]

run       plans the request into subtasks (or takes --plan), dispatches each to its own agent session in
          parallel, and merges the replies into one report under --out.
verify    measures the held-out task set under each stored prompt revision and prints the comparison;
          the "best" row is the revision worth switching to.
switch    saves a stored revision's configuration as the live prompt version (one new revision, the old
          ones stay in the panel history — switching back is the same command).

Credentials follow the improver: DEEPSEEK_API_KEY in the environment or a local .env, DEEPSEEK_AUTH_TOKEN bridged automatically.`

/** The router's own CLI; the improver CLI delegates `router ...` here. */
export async function runRouterCli(argv: string[]): Promise<number> {
  if (process.env.ROUTER_DEBUG === '1') console.error('router argv:', JSON.stringify(argv))
  const [sub, ...rest] = argv ?? []
  if (!sub || sub === 'help' || sub === '--help') { console.log(usage); return sub ? 0 : 1 }
  const common = {
    url: { type: 'string', default: process.env.DSH_SUPERAGENT_URL ?? 'http://127.0.0.1:3082' },
    dsh: { type: 'string', default: process.env.DSH_SUPERAGENT_DSH ?? 'dsh' },
    timeout: { type: 'string', default: '480000' },
  } as const
  try {
    for (const envFile of [join(process.cwd(), '.env'), join(process.cwd(), 'runs/demo/.env')]) {
      try {
        const raw = await import('node:fs/promises').then(fs => fs.readFile(envFile, 'utf8'))
        for (const line of raw.split('\n')) {
          const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/)
          if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
        }
      } catch { /* optional file */ }
    }
    if (!process.env.DEEEPSEEK_API_KEY && process.env.DEEEPSEEK_AUTH_TOKEN) process.env.DEEEPSEEK_API_KEY = process.env.DEEEPSEEK_AUTH_TOKEN
    const runner = (timeout: number) => new DshHeadlessRunner(process.env.DSH_SUPERAGENT_DSH ?? 'dsh', timeout)

    if (sub === 'run') {
      const { values } = miniParse(rest, {
        task: { type: 'string' }, plan: { type: 'string' }, cwd: { type: 'string', default: '.' },
        agents: { type: 'string', default: '2' }, out: { type: 'string' }, merge: { type: 'boolean', default: true },
        timeout: common.timeout, dsh: common.dsh, url: common.url })
      if (!values.task && !values.plan) { console.error('router run needs --task or --plan'); return 1 }
      const out = values.out ?? join('runs', 'router', new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14))
      const result = await dispatchParallel({ request: values.task ?? '', planFile: values.plan, cwd: values.cwd!,
        outDir: out, concurrency: Math.max(1, Number(values.agents) || 2), runner: runner(Number(values.timeout) || 480_000),
        timeoutMs: Number(values.timeout) || 480_000, merge: values.merge, skipPatterns: /[\\/](node_modules|lib|\.git|\.artifacts|runs|probe)$/,
      })
      if (result.merged) console.log(result.merged)
      console.log(`\n${result.runs.length} agent(s) dispatched; workspaces under ${out}`)
      return result.runs.some(r => r.failed) ? 1 : 0
    }
    if (sub === 'verify') {
      const { values } = miniParse(rest, {
        tasks: { type: 'string' }, revisions: { type: 'string' }, rounds: { type: 'string', default: '1' },
        'runs-dir': { type: 'string', default: 'runs' }, tag: { type: 'string', default: 'default' },
        'probe-timeout': { type: 'string', default: '90000' }, timeout: common.timeout, dsh: common.dsh, url: common.url })
      if (!values.tasks || !values.revisions) { console.error('router verify needs --tasks and --revisions (e.g. 0,3)'); return 1 }
      const revisions = values.revisions.split(',').map(n => Number(n.trim())).filter(n => Number.isFinite(n) && n >= 0)
      if (!revisions.length) { console.error('no usable revisions in ' + values.revisions); return 1 }
      const root = join(values['runs-dir']!, 'router-verify', values.tag!)
      const { scores, best } = await verifyRevisions({ url: values.url!, revisions, tasksFile: values.tasks,
        rounds: Math.max(1, Number(values.rounds) || 1), timeoutMs: Number(values['probe-timeout']) || 90_000,
        runner: runner(Number(values.timeout) || 480_000), root })
      const table = verifyTable(scores, best)
      console.log(table)
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'verify.md'), `# Router verify\n\n${table}\n`)
      return 0
    }
    if (sub === 'switch') {
      const { values } = miniParse(rest, { revision: { type: 'string' }, url: common.url })
      const revision = Number(String(values.revision))
      if (!Number.isFinite(revision) || revision < 0) { console.error('router switch needs --revision N'); return 1 }
      const result = await switchToRevision({ url: values.url!, revision })
      console.log(`${result.switched ? 'switched' : 'no-op'}: ${result.note}`)
      return 0
    }
    console.log(usage)
    return 1
  } catch (error) {
    console.error(process.env.ROUTER_DEBUG === '1' && error instanceof Error ? error.stack : error instanceof Error ? error.message : error)
    return 1
  }
}
