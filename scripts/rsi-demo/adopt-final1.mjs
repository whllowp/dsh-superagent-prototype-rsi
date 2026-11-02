/** Demo driver: adopt the selected candidate as a new prompt version after human review (panel-equivalent save). */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const repo = 'E:/coding/deepseek-super-agent/dsh-superagent-prototype-rsi'
const url = 'http://127.0.0.1:3082'
const treeDir = join(repo, 'runs', 'demo', 'rsi-demo-parallel1-s7', 'finals', 'final1', 'context', 'harness')
const call = async (route, body) => {
  const response = await fetch(url + '/orchestrator/api/' + route, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: { 'x-orchestrator-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}
const prompts = await call('prompts')
const base = prompts.current
const skillName = 'local-ui-handoff'
const [communication, scope, delivery] = await Promise.all(
  ['team/communication.md', 'team/scope.md', 'team/delivery.md'].map(file => readFile(join(treeDir, file), 'utf8')))
const skills = { ...(base.config.skills ?? {}), [skillName]: await readFile(join(treeDir, 'skills', skillName + '.md'), 'utf8') }
const config = { ...base.config, communication, scope, delivery, skills }
const saved = await call('prompts', { config, baseRevision: base.revision })
console.log('saved prompt revision:', saved.revision, '(base was', base.revision + ')')
const after = await call('prompts')
console.log('current revision now:', after.current.revision, '| skills:', Object.keys(after.current.config.skills ?? {}).join(', '))
