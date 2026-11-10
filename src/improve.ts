/** Thin entry around the improver CLI, so the same commands run from any bundle that ships the improvement library. */
import { runCli } from './improvement/cli.ts'

process.on('unhandledRejection', error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
try {
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
