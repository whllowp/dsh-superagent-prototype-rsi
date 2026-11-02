/** The harness tree an RSI run edits: the editable surface of dsh-superagent's prompts, as files a proposer edits on disk. */
import { z } from 'zod'
import { builtInBase, builtInParts, PromptConfigSchema, type PromptConfig } from '../app/prompts.ts'

/** A team skill name: lowercase words separated by dashes, as the host's own schema spells it. */
export const SkillName = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
/** The keys a harness tree holds: the three team sections, the Source-free skills, and the override parts. */
export type TreeFile = { path: string; text: string }
export type Tree = TreeFile[]

/** The whole harness as a tree of files; skills and overrides become files under their directory. */
export function configToTree(config: PromptConfig): Tree {
  const files: Tree = [
    { path: 'team/communication.md', text: config.communication },
    { path: 'team/scope.md', text: config.scope },
    { path: 'team/delivery.md', text: config.delivery },
  ]
  for (const [name, text] of Object.entries(config.skills)) files.push({ path: `skills/${name}.md`, text })
  for (const [key, override] of Object.entries(config.overrides ?? {})) files.push({ path: `overrides/${key}.md`, text: override.text })
  return files
}
/** Reads a tree back into a configuration; files outside the known surface are refused by `validateTree`. */
export function treeToConfig(files: Tree): PromptConfig {
  const config: PromptConfig = { communication: '', scope: '', delivery: '', skills: {} }
  const overrides: Record<string, { text: string; base?: string }> = {}
  const skills: Record<string, string> = {}
  for (const file of files) {
    if (file.path === 'team/communication.md') config.communication = file.text
    else if (file.path === 'team/scope.md') config.scope = file.text
    else if (file.path === 'team/delivery.md') config.delivery = file.text
    else if (file.path.startsWith('skills/') && file.path.endsWith('.md')) skills[SkillName.safeParse(file.path.slice(7, -3)).success ? file.path.slice(7, -3) : file.path] = file.text
    else if (file.path.startsWith('overrides/') && file.path.endsWith('.md')) overrides[file.path.slice(10, -3)] = { text: file.text }
    else throw new Error(`unknown harness file: ${file.path}`)
  }
  if (Object.keys(skills).length) config.skills = skills
  if (Object.keys(overrides).length) config.overrides = overrides
  return config
}
/**
 * Mechanical validation, mirroring what the host's own `Prompts.validate` enforces, so an invalid candidate never reaches
 * the API: known surface only, non-empty text, template placeholders retained, reserved skill names free, size within the limit.
 */
export function validateTree(files: Tree, options: { defaults: PromptConfig; maxChars: number }): void {
  const parts = builtInParts()
  for (const file of files) {
    if (!file.path.endsWith('.md') || !/^(team\/(communication|scope|delivery)|skills\/[a-z0-9-]+|overrides\/.+)\.md$/.test(file.path)) throw new Error(`unknown harness file: ${file.path}`)
    if (!file.text.trim()) throw new Error(`empty harness file: ${file.path}`)
    if (file.path.startsWith('overrides/')) {
      const key = file.path.slice(10, -3)
      const part = Object.hasOwn(parts, key) ? parts[key as keyof typeof parts] : undefined
      if (!part) throw new Error(`unknown override part: ${key}`)
      const missing = (part.placeholders ?? []).filter(placeholder => !file.text.includes(placeholder))
      if (missing.length) throw new Error(`override ${key} lost placeholders: ${missing.join(', ')}`)
    }
    if (file.path.startsWith('skills/') && /^(feishu|github|dsh-superagent-.*)$/.test(file.path.slice(7, -3))) throw new Error(`reserved skill name: ${file.path}`)
  }
  const config = treeToConfig(files)
  PromptConfigSchema.parse(configWithBases(config, options.defaults))
  if (JSON.stringify(configWithBases(config, options.defaults)).length > options.maxChars) throw new Error(`harness exceeds ${options.maxChars} chars`)
}
/**
 * Fills each override's `base` the way the host would (the saved base, else the built-in text it edits), and drops
 * overrides whose text equals the built-in default, so a candidate round-trips through `PUT prompts` unchanged.
 */
export function configWithBases(config: PromptConfig, defaults: PromptConfig): PromptConfig {
  const parts = builtInParts()
  const overrides = Object.entries(config.overrides ?? {}).flatMap(([key, override]) => {
    const part = Object.hasOwn(parts, key) ? parts[key as keyof typeof parts] : undefined
    if (!part) throw new Error(`unknown override part: ${key}`)
    if (override.text === part.text) return []
    const base = override.base ?? builtInBase(part.text)
    const fallback = Object.entries(defaults.overrides ?? {}).find(([name]) => name === key)
    return [[key, { text: override.text, base: base ?? fallback?.[1]?.base }] as const]
  })
  return { ...config, ...(overrides.length ? { overrides: Object.fromEntries(overrides) } : {}) }
}
/** A line-based diff of two trees, for the audit trail a run keeps beside each candidate. */
export function diffTrees(base: Tree, next: Tree): string {
  const lines: string[] = []
  const byPath = new Map(base.map(file => [file.path, file.text]))
  for (const file of next) {
    const before = byPath.get(file.path)
    byPath.delete(file.path)
    if (before === file.text) continue
    lines.push(`--- ${before === undefined ? '/dev/null' : file.path}`, `+++ ${file.path}`)
    const oldLines = (before ?? '').split('\n'), newLines = file.text.split('\n')
    let i = 0
    while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) i++
    let end = 0
    while (end < oldLines.length - i && end < newLines.length - i && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end++
    for (const removed of oldLines.slice(i, oldLines.length - end)) lines.push(`-${removed}`)
    for (const added of newLines.slice(i, newLines.length - end)) lines.push(`+${added}`)
  }
  for (const [path] of byPath) lines.push(`--- ${path}`, '+++ /dev/null', '(file removed)')
  return lines.join('\n')
}
/** The fence the sessions wrap their structured replies in. */
export const fence = (name: string, body: string): string => `\`\`\`${name}\n${body.trim()}\n\`\`\``
/** Reads the body of the one fenced block of that name in a session reply, or returns nothing. */
export function readFence(reply: string, name: string): string | undefined {
  const match = reply.match(new RegExp('```' + name + '\\s*\\n([\\s\\S]*?)```'))
  return match?.[1]?.trim()
}
