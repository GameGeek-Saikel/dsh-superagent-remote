/**
 * Composer drafts, one per conversation.
 *
 * The harness keeps what a reader typed per Session, so switching to another
 * conversation and back does not lose it. The panel keeps the same promise: the
 * text lives in memory for the page and in sessionStorage for a reload, and it is
 * cleared only once the message went out.
 */

/** Where one draft is remembered, per conversation. */
const KEY = 'superagent-remote/draft/'

/** Drafts in this page, so no storage round trip is needed for a switch. */
const memory = new Map<string, string>()

/**
 * The draft one conversation was left with.
 * @param id - workspace id.
 * @returns the text, or an empty string when the reader left none.
 */
export function readDraft(id: string): string {
  const kept = memory.get(id)
  if (kept !== undefined) return kept
  try {
    const stored = window.sessionStorage.getItem(KEY + id)
    if (stored !== null) memory.set(id, stored)
    return stored ?? ''
  } catch { return '' }
}

/**
 * Remember one conversation's draft.
 * @param id - workspace id.
 * @param text - what the composer holds now.
 */
export function writeDraft(id: string, text: string): void {
  if (text.length === 0) { clearDraft(id); return }
  memory.set(id, text)
  try { window.sessionStorage.setItem(KEY + id, text) } catch { /* draft memory is a convenience */ }
}

/**
 * Forget one conversation's draft, once the message went out.
 * @param id - workspace id.
 */
export function clearDraft(id: string): void {
  memory.delete(id)
  try { window.sessionStorage.removeItem(KEY + id) } catch { /* draft memory is a convenience */ }
}
