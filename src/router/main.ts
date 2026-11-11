/** Standalone router entry: dsh-router, the separated super-agent router binary. */
import { runRouterCli } from './cli.ts'

process.on('unhandledRejection', error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
try {
  process.exitCode = await runRouterCli(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
