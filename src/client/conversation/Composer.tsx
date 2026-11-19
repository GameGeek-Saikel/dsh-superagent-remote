/**
 * The composer: the card the harness puts at the bottom of its conversation.
 *
 * The left side reports what the deployment is doing and links the thread; the
 * right side names the account the message is written as and holds the send
 * button. Enter sends, Shift + Enter adds a line, which is what the harness does.
 */
import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import type { ChatState } from '../../types.ts'
import type { T } from '../locales.ts'
import { Glyph, SendArrow } from './icons.tsx'

/** The tallest the input grows before it scrolls, in pixels. */
const MAX_INPUT_HEIGHT = 336

/** Glyph and label of one deployment state. */
function statusOf(t: T, state: ChatState): { glyph: 'check-circle-outline' | 'loading-outline' | 'warning-outline'; label: string } {
  switch (state) {
    case 'working': return { glyph: 'loading-outline', label: t('chat.state.working') }
    case 'person': return { glyph: 'warning-outline', label: t('chat.state.person') }
    default: return { glyph: 'check-circle-outline', label: t('chat.state.idle') }
  }
}

/**
 * Render the composer card.
 * @param draft - the text being written.
 * @param onDraft - receives each edit.
 * @param onSend - sends the draft; the caller owns clearing it.
 * @param sending - true while the message is in flight.
 * @param state - what the deployment is doing.
 * @param agentLogin - the account the message will mention; empty when unknown.
 * @param repository - owner/name of the workspace repository.
 * @param thread - issue number of the conversation, or null before the first message.
 * @param hero - true when the conversation has no messages yet.
 */
export function Composer({ t, draft, onDraft, onSend, sending, state, agentLogin, repository, thread, hero }: {
  t: T; draft: string; onDraft: (next: string) => void; onSend: () => void; sending: boolean; state: ChatState
  agentLogin: string; repository: string; thread: number | null | undefined; hero: boolean
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const status = statusOf(t, state)
  const canSend = draft.trim().length > 0 && !sending

  // Grow with the text, up to the height where the harness lets the input scroll.
  useEffect(() => {
    const element = input.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = String(Math.min(element.scrollHeight, MAX_INPUT_HEIGHT)) + 'px'
  }, [draft, hero])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    if (canSend) onSend()
  }

  // The card takes the focus wherever it is clicked, as the harness composer does.
  const onClick = (event: MouseEvent<HTMLFormElement>): void => {
    if ((event.target as HTMLElement).closest('a, button') === null) input.current?.focus()
  }

  return <form className="sar-composer" data-hero={hero ? true : undefined} onClick={onClick}
    onSubmit={event => { event.preventDefault(); if (canSend) onSend() }}>
    <textarea ref={input} className="sar-composer-input" rows={1} value={draft} title={t('chat.keyHint')}
      placeholder={t('chat.placeholder')} aria-label={t('chat.placeholder')}
      onChange={event => onDraft(event.target.value)} onKeyDown={onKeyDown} />
    <div className="sar-composer-row">
      <div className="sar-composer-tools">
        <span className="sar-composer-status" data-state={state} title={status.label}>
          <Glyph name={status.glyph} size={14} />
          <span className="sar-composer-status-label">{status.label}</span>
        </span>
        {thread !== null && thread !== undefined && <a className="sar-composer-tool"
          href={'https://github.com/' + repository + '/issues/' + String(thread)} target="_blank"
          rel="noopener noreferrer" title={t('chat.open')} aria-label={t('chat.open')}>
          <Glyph name="link-outline" size={16} />
        </a>}
      </div>
      <div className="sar-composer-trailing">
        {agentLogin.length > 0 && <span className="sar-composer-agent" title={t('chat.hint', { agent: agentLogin })}>
          <Glyph name="agent-preset-outline" size={16} />
          <span className="sar-composer-agent-name">{t('chat.agent', { agent: agentLogin })}</span>
        </span>}
        <button type="submit" className="sar-composer-send" aria-busy={sending} disabled={!canSend}
          aria-label={sending ? t('chat.sending') : t('chat.send')}>
          {sending ? <span className="sar-composer-spinner" aria-hidden="true" /> : <SendArrow />}
        </button>
      </div>
    </div>
  </form>
}
