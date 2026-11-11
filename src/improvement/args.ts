/** A small argv parser used instead of util.parseArgs, which ignores its options on some Node builds (observed on 22.22.1).
 *  Covers the subset the CLIs use: string and boolean options, defaults, `--name value`, `--name=value`, and positionals. */
export interface ArgEntry { type: 'string' | 'boolean'; default?: string | boolean }
export type ArgSpec = Record<string, ArgEntry>
type Values<S extends ArgSpec> = { [K in keyof S]: S[K]['type'] extends 'boolean' ? boolean : S[K] extends { default: string } ? string : string | undefined }
/** Parses `argv` against `spec`; unknown options and unexpected positionals are refused, like a strict parseArgs. */
export function miniParse<S extends ArgSpec>(argv: string[], spec: S, opts?: { allowPositionals?: boolean }): { values: Values<S>; positionals: string[] } {
  const values: Record<string, string | boolean | undefined> = {}
  for (const [name, entry] of Object.entries(spec)) {
    values[name] = entry.default !== undefined ? entry.default : entry.type === 'boolean' ? false : undefined
  }
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break }
    if (!token.startsWith('--') || token.length <= 2) {
      if (!opts?.allowPositionals) throw new Error(`Unexpected argument '${token}'. This command does not take positional arguments`)
      positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    const negated = name.startsWith('no-') && Object.hasOwn(spec, name.slice(3)) && spec[name.slice(3)]!.type === 'boolean'
    const entry = negated ? { type: 'boolean' as const } : Object.hasOwn(spec, name) ? spec[name]! : undefined
    if (!entry) throw new Error(`Unknown option '--${name}'`)
    const target = negated ? name.slice(3) : name
    if (eq >= 0) {
      const value = token.slice(eq + 1)
      values[target] = entry.type === 'boolean' ? value === 'true' : value
      continue
    }
    if (entry.type === 'boolean') { values[target] = !negated; continue }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Option '--${name}' expects a value`)
    values[target] = value
    index += 1
  }
  return { values: values as Values<S>, positionals }
}
