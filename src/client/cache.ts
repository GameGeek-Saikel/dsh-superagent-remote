/**
 * Last successful snapshots, for the panel's first paint.
 *
 * The conversation and the project pane are read from GitHub and from the
 * deployments; the first read after a page reload therefore takes a network
 * round trip. Keeping the last answer for this browser tab lets the panel paint
 * at once and replace it silently when the poll returns, so only the very first
 * Superagent start has a visible wait.
 *
 * The cache lives in `sessionStorage`: it follows a reload but not a new
 * browser session, and a stale answer can never outlive the tab.
 */
import type { ChatView, RuntimeView } from '../types.ts'

const RUNTIME = 'superagent-remote/cache/runtime'
const CHAT = 'superagent-remote/cache/chat/'

/** The tab's storage, when the browser allows it. */
function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

function read<T>(key: string, usable: (value: unknown) => value is T): T | undefined {
  try {
    const text = storage()?.getItem(key)
    if (text === null || text === undefined) return undefined
    const value: unknown = JSON.parse(text)
    return usable(value) ? value : undefined
  } catch {
    return undefined
  }
}

function write(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value))
  } catch {
    // A full or disabled storage only costs the next reload its head start.
  }
}

function isRuntime(value: unknown): value is RuntimeView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<RuntimeView>
  return Array.isArray(record.workspaces)
    && record.workspaces.every(entry => typeof entry?.id === 'string')
}

function isChat(value: unknown): value is ChatView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<ChatView>
  return Array.isArray(record.messages) && typeof record.state === 'string'
}

/** The last runtime snapshot this tab saw. */
export const cache = {
  /**
   * Read the last runtime snapshot.
   * @returns the snapshot, or undefined when this tab has none.
   */
  runtime(): RuntimeView | undefined {
    return read(RUNTIME, isRuntime)
  },
  /** Remember the latest runtime snapshot. */
  saveRuntime(value: RuntimeView): void {
    write(RUNTIME, value)
  },
  /**
   * Read one workspace's last conversation.
   * @param id - workspace id.
   * @returns the conversation, or undefined when this tab has none.
   */
  chat(id: string): ChatView | undefined {
    return read(CHAT + id, isChat)
  },
  /** Remember the latest conversation of one workspace. */
  saveChat(id: string, value: ChatView): void {
    write(CHAT + id, value)
  },
}
