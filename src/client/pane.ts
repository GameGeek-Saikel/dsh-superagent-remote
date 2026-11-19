/**
 * The project pane's width.
 *
 * The pane is the harness workspace sidebar: one row per workspace, opened beside
 * the conversation and dragged to the width the reader wants.
 */

/** Narrowest the pane may get, in pixels. */
export const PANE_MIN = 240
/** Widest the pane may get, in pixels. */
export const PANE_MAX = 560
/** Width the pane starts at, in pixels. */
export const PANE_START = 280

/** Which archived rows the pane lists. */
export type ArchivedFilter = 'hide' | 'show' | 'only'

/**
 * The rows the pane shows, in the order it shows them.
 *
 * Pinned rows come first and keep their relative order. Archived rows follow the
 * rest when they are shown at all; asking for them alone leaves the others out.
 * @param workspaces - the registry, in creation order.
 * @param filter - which archived rows belong in the list.
 */
export function sortWorkspaces<T extends { pinned: boolean; archived: boolean }>(
  workspaces: readonly T[], filter: ArchivedFilter,
): T[] {
  if (filter === 'only') return workspaces.filter(workspace => workspace.archived)
  const visible = filter === 'show' ? workspaces.slice() : workspaces.filter(workspace => !workspace.archived)
  const pinned = visible.filter(workspace => workspace.pinned && !workspace.archived)
  const archived = visible.filter(workspace => workspace.archived)
  const rest = visible.filter(workspace => !workspace.pinned && !workspace.archived)
  return [...pinned, ...rest, ...archived]
}

/** Keep a pane width inside the bounds the pane supports. */
export function clampPane(value: number, min = PANE_MIN, max = PANE_MAX): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
