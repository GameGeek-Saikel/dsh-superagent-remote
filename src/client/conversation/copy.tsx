/**
 * Copying one part of the conversation.
 *
 * A copy button is a convenience, not a promise: when the browser refuses the
 * Clipboard API this stays quiet and the text is still on screen to select.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Glyph } from './icons.tsx'

/** The transient state a copy button shows, shared by every button in one view. */
export interface CopyState {
  /** Key of the item copied last, or undefined when nothing was copied recently. */
  copied: string | undefined
  /** Copy one item and remember it under its key. */
  copy: (key: string, text: string) => void
}

/** How long a copy button keeps its confirmation, in milliseconds. */
const FEEDBACK_MS = 1_600

/**
 * Track which item was copied last, for the confirmation a button shows.
 * @returns the copied key and the copy function.
 */
export function useCopy(): CopyState {
  const [copied, setCopied] = useState<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
  const copy = useCallback((key: string, text: string) => {
    void writeText(text).then(() => {
      setCopied(key)
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(undefined), FEEDBACK_MS)
    }, () => { /* The text stays selectable on screen; a refused copy needs no error. */ })
  }, [])
  return { copied, copy }
}

/** Write to the clipboard, falling back to a selection for origins without the Clipboard API. */
async function writeText(text: string): Promise<void> {
  const clipboard = navigator.clipboard
  if (clipboard !== undefined) return clipboard.writeText(text)
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(area)
  if (!copied) throw new Error('the browser refused the copy')
}

/**
 * A button that copies one piece of text and confirms it in place.
 * @param text - what to copy.
 * @param label - accessible name, also the tooltip.
 * @param state - the view's copy state.
 * @param itemKey - key this button answers to.
 * @param copiedLabel - accessible name once the copy landed.
 * @param className - layout class; defaults to the conversation action button.
 */
export function CopyButton({ text, label, copiedLabel, state, itemKey, className = 'sar-action' }: {
  text: string; label: string; copiedLabel: string; state: CopyState; itemKey: string; className?: string
}) {
  const done = state.copied === itemKey
  return <button type="button" className={className} aria-label={done ? copiedLabel : label} title={label}
    onClick={() => state.copy(itemKey, text)}>
    <Glyph name={done ? 'check-outline' : 'copy-outline'} size={16} />
  </button>
}
