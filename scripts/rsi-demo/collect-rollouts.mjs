/** Demo driver: run the task set once under the current harness to collect evidence rollouts. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'

const repo = 'E:/coding/deepseek-super-agent/dsh-superagent-prototype-rsi'
const outDir = join(repo, 'runs', 'demo', 'evidence')
try {
  const raw = await readFile(join(repo, 'runs/demo/.env'), 'utf8')
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim()
  }
} catch { /* no .env */ }
if (!process.env.DEEEPSEEK_API_KEY && process.env.DEEEPSEEK_AUTH_TOKEN) process.env.DEEEPSEEK_API_KEY = process.env.DEEEPSEEK_AUTH_TOKEN

const run = async (cmd, args, cwd, timeoutMs) => new Promise(resolve => {
  let command = cmd, extra = []
  if (cmd === 'dsh' && process.platform === 'win32') {
    command = process.execPath
    extra = ['C:/Users/13423/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js']
  }
  const child = spawn(command, [...extra, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const timer = setTimeout(() => child.kill(), timeoutMs)
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { out += chunk })
  child.on('close', () => { clearTimeout(timer); resolve(out) })
  child.on('error', error => { clearTimeout(timer); resolve(String(error)) })
})
const shell = (command, cwd, timeoutMs) => new Promise(resolve => {
  const child = spawn(command, { cwd, shell: true, env: process.env, stdio: 'ignore' })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  child.on('close', code => { clearTimeout(timer); resolve(code ?? 1) })
  child.on('error', () => { clearTimeout(timer); resolve(127) })
})

const { tasks } = JSON.parse(await readFile(join(repo, 'runs', 'demo', 'tasks.json'), 'utf8'))
await mkdir(outDir, { recursive: true })
for (const task of tasks) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14)
  const workspace = join(repo, 'runs', 'demo', `rollout-${task.id}-${stamp}`)
  await mkdir(dirname(workspace), { recursive: true })
  const { cp } = await import('node:fs/promises')
  await cp(task.cwd, workspace, { recursive: true, filter: item => !/[\\/](node_modules|lib|\.git|\.artifacts|runs)$/.test(item) })
  const reply = await run('dsh', ['headless',
    `You are a coding agent working unattended in the current directory (a DSH client plugin). Standing instructions:\n\n## Communication\n${'Return to the source conversation to deliver; keep progress internal while you can continue.'}\n\n## Ticket scope\n${'For an authorized small change local to a function or module, carry the change through implementation and relevant checks to completion; stop with a named blocker when a design decision remains open.'}\n\n## Delivery requirements\n${'Report ready only when the change is complete in the named files; state what you changed and the class names you introduced.'}\n\nTask: ${task.instruction}\nFinish the change in the project files; do not create reports.`],
  workspace, 300000)
  const code = await shell(task.check, workspace, 60000)
  const said = reply.split('\n').filter(line => line.trim()).slice(-6).join('\n').slice(0, 800)
  const rollout = [`# rollout ${task.id}-${stamp}`,
    `stage: ended`,
    `outcome: ${code === 0 ? 'completed' : 'failed'}`,
    'mandate rules: none (local demo task)',
    `[REPORT ${code === 0 ? 'ready' : 'failed'}] checker ${task.check} exited ${code}`,
    ...said ? [`[REPORT progress] session tail:\n${said}`] : []].join('\n')
  await writeFile(join(outDir, `${task.id}-${stamp}.md`), rollout)
  console.log(`${task.id}: checker exit ${code}`)
}
console.log('evidence written to', outDir)
