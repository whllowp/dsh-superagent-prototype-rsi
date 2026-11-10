/** The improver CLI entry of the companion bundle: the same commands as dsh-superagent's lib/improve.js. */
import { runCli } from '../../src/improvement/cli.ts'

process.on('unhandledRejection', error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
try {
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
