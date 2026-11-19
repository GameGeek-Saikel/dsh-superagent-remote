/**
 * The workspace the Superagent panel shows, shared by the panel and the chat
 * groups tab in the right sidebar.
 *
 * Both seats live in this plugin but render in different React trees, so the
 * selection is a module-level store rather than context. It also carries the one
 * request the tab can make of the panel: open a creation dialog.
 */

/** Where this tab's selection is remembered across reloads. */
const SELECTED = 'superagent-remote/workspace'
/** Where the last selection is remembered for the next tab or browser session. */
const LAST = 'superagent-remote/last-workspace'

const read = (): string | undefined => {
  try { return window.sessionStorage.getItem(SELECTED) ?? undefined } catch { return undefined }
}

const readLast = (): string | undefined => {
  try { return window.localStorage.getItem(LAST) ?? undefined } catch { return undefined }
}

type Listener = () => void

let current: string | undefined
let dialog: 'new' | 'import' | undefined
const listeners = new Set<Listener>()
const dialogListeners = new Set<Listener>()

const emit = (set: Set<Listener>): void => { for (const listener of set) listener() }

/** The selected workspace, shared by both seats. */
export const selection = {
  /**
   * The selected workspace id.
   * @returns the id, or undefined when nothing is selected yet.
   */
  get(): string | undefined {
    if (current === undefined) current = read()
    return current
  },
  /**
   * The last workspace this browser selected, even from another tab.
   * @returns the id, or undefined when this browser has not chosen one.
   */
  last(): string | undefined {
    return readLast()
  },
  /**
   * Select a workspace.
   * @param id - the workspace id, or undefined to forget it.
   */
  set(id: string | undefined): void {
    current = id
    try {
      if (id === undefined) {
        window.sessionStorage.removeItem(SELECTED)
        window.localStorage.removeItem(LAST)
      } else {
        window.sessionStorage.setItem(SELECTED, id)
        window.localStorage.setItem(LAST, id)
      }
    } catch { /* selection memory is a convenience */ }
    emit(listeners)
  },
  /**
   * Subscribe to selection changes.
   * @param listener - called after every change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

/** A creation dialog the right-sidebar tab asks the panel to open. */
export const dialogRequest = {
  /**
   * The requested dialog, or undefined when none is pending.
   * @returns the dialog name.
   */
  get(): 'new' | 'import' | undefined {
    return dialog
  },
  /**
   * Ask the panel for a dialog.
   * @param next - which dialog, or undefined to clear the request.
   */
  set(next: 'new' | 'import' | undefined): void {
    dialog = next
    emit(dialogListeners)
  },
  /**
   * Subscribe to requests.
   * @param listener - called after every request.
   * @returns the unsubscribe function.
   */
  subscribe(listener: Listener): () => void {
    dialogListeners.add(listener)
    return () => { dialogListeners.delete(listener) }
  },
}
