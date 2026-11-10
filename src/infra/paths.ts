/** Resolves packaged asset paths from either the source tree, the compiled lib/ output, or a sibling install of this package. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    // A companion bundle (say, the improver plugin) sits beside this package in the same node_modules.
    const sibling = join(directory, 'dsh-superagent', 'package.json')
    if (existsSync(sibling) && packageName(sibling) === 'dsh-superagent') return cached = join(directory, 'dsh-superagent')
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && packageName(manifest) === 'dsh-superagent') return cached = directory
    directory = dirname(directory)
  }
  throw new Error('dsh-superagent package root not found')
}
const packageName = (manifest: string): string | undefined => {
  try { return (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name } catch { /* A foreign package.json on the way up is not this package. */ }
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
