/**
 * The deployment's own DeepSeek Harness, opened from the workspace actions.
 *
 * The trajectory of an Executor session is a view of the Session that owns it,
 * and that Session lives in the WSL deployment, not in this process. The panel
 * used to carry a tab that framed that page; the embedded frame is gone in
 * favour of a button beside Start and Restart, and the page opens in a top-level
 * tab where the deployment's launch token and its SameSite cookie are first
 * party.
 */
import { useState } from 'react'
import type { WorkspaceView } from '../../types.ts'
import { panelApi } from '../api.ts'
import type { T } from '../locales.ts'
import { Button } from '../panel/vendor/client/controls.tsx'
import { Glyph } from '../conversation/icons.tsx'

const errorText = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)

/**
 * Open the deployment's own DSH from the workspace action row.
 * @param workspace - the workspace whose deployment should open.
 * @param onError - receives a failure to show in the panel's banner.
 */
export function OfficialButton({ t, workspace, onError }: {
  t: T; workspace: WorkspaceView; onError: (text: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const open = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const { url } = await panelApi.ui(workspace.id)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (failure) {
      onError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return <Button size="sm" className="sar-official-button" disabled={busy} title={t('ws.officialHint')}
    icon={<Glyph name="link-outline" size={14} />} onClick={() => { void open() }}>
    {busy ? t('official.opening') : t('ws.official')}</Button>
}
