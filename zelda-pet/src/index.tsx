/** Browser plugin entry: a sidebar acorn opens the companion stage, where the sprite floats over the whole app. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PetStage } from './pet.tsx'

type ClientContext = Context
const NS = 'dshZeldaPet'
const PANEL_ID = 'zelda-pet' as MainPanelId

const DICT = {
  zh: { panel: '森林伙伴' },
  en: { panel: 'Forest Buddy' },
} as const

function AcornIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 21c-3.6-2-5.5-5-5.5-9a5.5 5.5 0 0 1 11 0c0 4-1.9 7-5.5 9z" />
    <path d="M9 7c0-2 1.4-3.5 3-4 1.6.5 3 2 3 4" />
    <path d="M12 3V1.6" />
  </svg>
}

export const inject: string[] = ['slots', 'locale']
/** Registers the sidebar entry and the companion stage panel. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, DICT), 'zelda-pet: dictionary')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    () => <PetStage />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 99, label: () => t('panel'), locale: NS }, AcornIcon))
}
