/**
 * The chat groups tab.
 *
 * It is a real tab type in the DeepSeek Harness right sidebar, registered the
 * two-stage way every shipped type is: a definition through
 * `ctx.sidebarRightTabs` (id, kind, chip title, guide entry) and a body through
 * the keyed `sidebar.right.pane.tab` seat. The dockkit draws the pane, its tab
 * strip, and the split, fullscreen and collapse controls.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { usePoll } from './panel/vendor/client/api.ts'
import { Button, Icon, StateDot } from './panel/vendor/client/controls.tsx'
import { panelApi } from './api.ts'
import { NS } from './locales.ts'
import { dialogRequest, selection } from './selection.ts'
import { healthDot, healthLabel, type T } from './shell.tsx'
import type { WorkspaceView } from '../types.ts'

/** Registration identity of this tab type; also the key its body registers under. */
export const GROUPS_ID = '@gamegeek-saikel/dsh-superagent-remote'
/** The page kind `openTab` names. */
export const GROUPS_KIND = 'superagent-groups'

/** The hammer the deployment's own panel uses, drawn as a guide card icon. */
function GuideMark({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" />
    <path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" />
    <path d="M10 15.5h3.5" />
  </svg>
}

/**
 * The tab type's static face.
 * @param t - namespace-bound translator, read on every label call.
 * @returns the definition `ctx.sidebarRightTabs.register` takes.
 */
export function groupsDefinition(t: T) {
  return {
    id: GROUPS_ID,
    kind: GROUPS_KIND,
    priority: 'extension' as const,
    title: () => t('rail.label'),
    guide: [{
      id: 'groups',
      order: 20,
      title: () => t('rail.label'),
      description: () => t('rail.guide'),
      icon: GuideMark,
    }],
  }
}

/** One row of the tab, shaped like a session row in the left sidebar. */
function GroupRow({ t, workspace, active, onPick }: {
  t: T; workspace: WorkspaceView; active: boolean; onPick: () => void
}) {
  return <li>
    <button type="button" className="sar-tabrow" aria-current={active ? 'true' : undefined}
      title={workspace.repository} onClick={onPick}>
      <StateDot state={healthDot(workspace.health)} />
      <span className="sar-tabrow-title">{workspace.name}</span>
      <span className="sar-tabrow-meta">{healthLabel(t, workspace.health)}</span>
    </button>
  </li>
}

/**
 * The tab body.
 * @param props - the slot's namespace-bound translator, plus the client context.
 * @returns the chat group list.
 */
export function GroupsBody({ ctx, t, panelId }: { ctx: Context; t: T; panelId: string }) {
  const runtime = usePoll(() => panelApi.runtime(), [], 5_000)
  const workspaces = runtime.data?.workspaces ?? []
  const selected = selection.get() ?? workspaces[0]?.id
  const open = (id: string): void => {
    selection.set(id)
    // The panel is the seat that shows a workspace, so picking one here moves to it.
    ctx.layout.selectPanel(panelId as never)
  }
  return <div className="sar-tabpane">
    {runtime.error !== undefined && <p className="sar-tabrow-error" role="alert">
      {runtime.error instanceof Error ? runtime.error.message : String(runtime.error)}</p>}
    {workspaces.length === 0 && runtime.data !== undefined
      ? <p className="sar-tabhint">{t('rail.empty')}</p>
      : <ul className="sar-tabrows">
        {workspaces.map(workspace => <GroupRow key={workspace.id} t={t} workspace={workspace}
          active={workspace.id === selected} onPick={() => open(workspace.id)} />)}
      </ul>}
    <div className="sar-tabfoot">
      <Button size="sm" variant="outline" icon={<Icon name="plus" size={14} />}
        onClick={() => { dialogRequest.set('new'); open(selected ?? '') }}>{t('rail.new')}</Button>
      <Button size="sm" icon={<Icon name="inbox" size={14} />}
        onClick={() => { dialogRequest.set('import'); open(selected ?? '') }}>{t('rail.import')}</Button>
    </div>
  </div>
}
