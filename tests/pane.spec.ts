import { describe, expect, it } from 'vitest'
import { PANE_MAX, PANE_MIN, PANE_START, clampPane, sortWorkspaces, type ArchivedFilter } from '../src/client/pane.ts'

describe('the project pane width', () => {
  it('starts at the harness sidebar width', () => {
    expect(PANE_START).toBeGreaterThanOrEqual(PANE_MIN)
    expect(PANE_START).toBeLessThanOrEqual(PANE_MAX)
  })

  it('keeps pinned rows first and archived rows last when shown', () => {
    const row = (name: string, pinned = false, archived = false) => ({ name, pinned, archived })
    const rows = [row('a'), row('b', true), row('c', false, true), row('d')]
    expect(sortWorkspaces(rows, 'hide').map(item => item.name)).toEqual(['b', 'a', 'd'])
    expect(sortWorkspaces(rows, 'show').map(item => item.name)).toEqual(['b', 'a', 'd', 'c'])
    expect(sortWorkspaces(rows, 'only').map(item => item.name)).toEqual(['c'])
  })

  it('never pins an archived row to the top', () => {
    const rows = [{ name: 'x', pinned: true, archived: true }, { name: 'y', pinned: false, archived: false }]
    expect(sortWorkspaces(rows, 'show').map(item => item.name)).toEqual(['y', 'x'])
  })

  it('takes the three filters the sidebar offers', () => {
    const rows: { name: string; pinned: boolean; archived: boolean }[] = []
    const filters: ArchivedFilter[] = ['hide', 'show', 'only']
    expect(filters.map(filter => sortWorkspaces(rows, filter).length)).toEqual([0, 0, 0])
  })

  it('clamps a dragged width inside the pane bounds', () => {
    expect(clampPane(100)).toBe(240)
    expect(clampPane(900)).toBe(560)
    expect(clampPane(320.4)).toBe(320)
    expect(clampPane(PANE_START)).toBe(PANE_START)
  })
})
