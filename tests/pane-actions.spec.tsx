// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { T } from '../src/client/locales.ts'
import type { WorkspaceView } from '../src/types.ts'
import { ProjectPane } from '../src/client/shell.tsx'

/** Keys with their values, so the assertions follow neither copy nor locale. */
const t = ((key: string) => key) as unknown as T

const workspace = (id: string, pinned = false, archived = false): WorkspaceView => ({
  id, name: id, repository: 'owner/' + id, agentLogin: 'agent', profile: 'superagent', port: 3082,
  stateDir: '/root/.dsh', agentCli: '/root/gh-agent', enabled: true, pinned, archived, adopted: false,
  provisioned: true, basePath: '/superagent-remote/' + id + '/orchestrator',
  health: { phase: 'ready', detail: '', at: '2026-11-18T00:00:00Z' },
})

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

async function mount(rows: WorkspaceView[]): Promise<{
  container: HTMLDivElement; flags: { id: string; patch: unknown }[]
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const flags: { id: string; patch: unknown }[] = []
  const root = createRoot(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await act(async () => {
    root.render(<ProjectPane t={t} workspaces={rows} selected={rows[0]?.id} width={280}
      onSelect={() => {}} onNew={() => {}} onFlags={(id, patch) => { flags.push({ id, patch }) }}
      onRemove={() => {}} onNotice={() => {}} />)
  })
  cleanup = () => { act(() => root.unmount()); container.remove() }
  return { container, flags }
}

describe('the project pane row actions', () => {
  it('pins an unpinned row from its quick action', async () => {
    const { container, flags } = await mount([workspace('one')])
    const pin = container.querySelector('[aria-label="proj.pin"]') as HTMLButtonElement
    expect(pin).not.toBeNull()
    await act(async () => { pin.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(flags).toEqual([{ id: 'one', patch: { pinned: true } }])
  })

  it('unpins a pinned row and archives an open one', async () => {
    const { container, flags } = await mount([workspace('one', true)])
    const unpin = container.querySelector('[aria-label="proj.unpin"]') as HTMLButtonElement | null
    const archive = container.querySelector('[aria-label="proj.archive"]') as HTMLButtonElement | null
    expect(unpin).not.toBeNull()
    expect(archive).not.toBeNull()
    if (unpin === null || archive === null) return
    await act(async () => {
      unpin.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      archive.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(flags).toEqual([{ id: 'one', patch: { pinned: false } }, { id: 'one', patch: { archived: true } }])
  })

  it('offers only restore on an archived row', async () => {
    const { container, flags } = await mount([workspace('one', false, true)])
    expect(container.querySelector('[aria-label="proj.archive"]')).toBeNull()
    expect(container.querySelector('[aria-label="proj.pin"]')).toBeNull()
    await act(async () => {
      (container.querySelector('[aria-label="proj.unarchive"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(flags).toEqual([{ id: 'one', patch: { archived: false } }])
  })

  it('marks a pinned row in the resting slot, with the filled pin', async () => {
    const { container } = await mount([workspace('one', true)])
    const marker = container.querySelector('.sar-proj-resting .sar-proj-pin')
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('role')).toBe('img')
    expect(marker?.getAttribute('aria-label')).toBe('proj.pinnedTag')
    expect(marker?.querySelector('use')?.getAttribute('href')).toBe('#dsw-icon-pin-fill-regular')
    const action = container.querySelector('[aria-label="proj.unpin"]')
    expect(action?.className).toContain('sar-proj-act-pinned')
    expect(action?.querySelector('use')?.getAttribute('href')).toBe('#dsw-icon-pin-fill-regular')
    const plain = await mount([workspace('two')])
    expect(plain.container.querySelector('.sar-proj-pin')).toBeNull()
    expect(plain.container.querySelector('[aria-label="proj.pin"]')?.className).not.toContain('sar-proj-act-pinned')
  })

  it('shows the archived row with its description and tag', async () => {
    const { container } = await mount([workspace('one', false, true)])
    expect(container.querySelector('[data-archived="true"]')?.getAttribute('aria-description')).toBe('proj.archivedNotice')
    expect(container.textContent).toContain('proj.archivedTag')
  })
})
