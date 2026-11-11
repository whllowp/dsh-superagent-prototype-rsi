/** The Router's switch arm: move the live deployment to any stored prompt revision in one command. */
import { call } from '../improvement/evidence.ts'
import { revisionConfig } from './verify.ts'
import type { PromptConfig } from '../app/prompts.ts'

/** Saves `revision`'s configuration as a new prompt version on top of the live one — the fast lane to try a new RSI version. */
export async function switchToRevision(options: { url: string; revision: number }): Promise<{ switched: boolean; revision: number; note: string }> {
  const current = await call(options.url, 'GET prompts') as { current: { revision: number } }
  if (options.revision === current.current.revision) {
    return { switched: false, revision: current.current.revision, note: `the live deployment already runs revision ${options.revision}` }
  }
  const stored = await revisionConfig(options.url, options.revision)
  const config = stored.config
  const saved = await call(options.url, 'PUT prompts', { body: { config, baseRevision: current.current.revision } }) as { revision: number }
  return { switched: true, revision: saved.revision, note: `revision ${options.revision} is now live as new revision ${saved.revision}; the old one stays in the panel history` }
}
/** The deployment-knowledge-free read of what is live right now, for the switch command's confirmation line. */
export const liveRevision = async (url: string): Promise<PromptConfig & { revision: number }> => {
  const view = await call(url, 'GET prompts') as { current: { revision: number; config: PromptConfig } }
  return { ...view.current.config, revision: view.current.revision }
}
