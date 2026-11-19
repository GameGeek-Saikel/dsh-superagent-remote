/**
 * Browser half of @gamegeek-saikel/dsh-superagent-remote.
 *
 * Three registrations: the Superagent entry in the global panel list, the panel it
 * opens, and the chat groups tab in the official right sidebar.
 *
 * @module @gamegeek-saikel/dsh-superagent-remote/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { en, NS, zh } from './locales.ts'
import { en as panelEn, zh as panelZh } from './panel/vendor/client/locales.ts'
import { GROUPS_ID, GroupsBody, groupsDefinition } from './groups.tsx'
import { installStyles } from './styles.ts'
import { WorkspaceApp, type T } from './shell.tsx'

/** Panel key shared by the sidebar entry and the main slot. */
export const PANEL_ID = 'dsh-superagent-remote' as MainPanelId
/** Localization namespace of the vendored panel, kept so its own dictionary applies. */
export const PANEL_NS = 'dshSuperagent'

/** The Superagent mark: the hammer the upstream panel uses in the sidebar. */
function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" />
    <path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" />
    <path d="M10 15.5h3.5" />
  </svg>
}

/** Required services: the slot registry, the dictionaries, the right sidebar, and panel navigation. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'layout']

/**
 * Client plugin body: register both dictionaries, the main panel, the sidebar
 * entry, and the chat groups tab in the right sidebar.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => { installStyles(); return () => {} }, 'superagent-remote: stylesheets')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'superagent-remote: dictionaries')
  // The vendored panel translates with its own namespace and its own dictionary.
  ctx.effect(() => ctx.locale.register(PANEL_NS, { zh: panelZh, en: panelEn }), 'superagent-remote: panel dictionaries')
  const t = ctx.locale.bind(NS)
  const panelT = ctx.locale.bind(PANEL_NS)

  // The official right sidebar: a tab type, its guide card, and its body.
  ctx.effect(() => ctx.sidebarRightTabs.register(groupsDefinition(t)), 'superagent-remote: chat groups type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: GROUPS_ID,
    locale: NS,
    inject: () => ({}),
  }, (props: { t: T }) => <GroupsBody ctx={ctx} t={props.t} panelId={PANEL_ID} />)), 'superagent-remote: chat groups body')

  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <WorkspaceApp t={props.t} upstreamT={panelT} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 11,
    label: () => t('panel'),
    locale: NS,
  }, HammerIcon))
}
