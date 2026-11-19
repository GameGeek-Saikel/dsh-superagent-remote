/**
 * The conversation with one deployment.
 *
 * The window is the harness conversation's: one content column, the person's
 * messages as right-aligned bubbles, the agent's as left-aligned bubbles, action
 * rows under both, and the composer card at the bottom. GitHub issue comments
 * carry the messages, so nothing here about tickets or Executor Sessions shows.
 *
 * The agent may answer several times to one question — an acknowledgement, then
 * the result — so every answer keeps its own card: the writer above, the answer
 * inside, and the date in the action row below with the copy and link buttons.
 * A reply bar is not needed for an answer that is already next to the message
 * it answers.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { ChatMessage, ChatState, ChatView, WorkspaceView } from '../../types.ts'
import { panelApi } from '../api.ts'
import type { T } from '../locales.ts'
import { Button } from '../panel/vendor/client/controls.tsx'
import { usePoll } from '../panel/vendor/client/api.ts'
import { Composer } from './Composer.tsx'
import { clearDraft, readDraft, writeDraft } from '../drafts.ts'
import { cache } from '../cache.ts'
import { WidthHandle } from './WidthHandle.tsx'
import { ChatMarkdown, PlainLine } from './Markdown.tsx'
import { AgentMark, FishLogo, Glyph } from './icons.tsx'
import { CopyButton, useCopy } from './copy.tsx'
import { linkify } from './markdown.ts'

/** How often the conversation is re-read, in milliseconds. */
const POLL_MS = 3_000
/** How close to the tail still counts as reading the tail, in pixels. */
const TAIL_PX = 96
/** Where the column width preference is remembered. */
const COLUMN = 'superagent-remote/conversation-width'
/** Floor for the content column, matching the harness layout minimum. */
const COLUMN_MIN = 640
/** Horizontal room kept for both handles and their safe edge zones. */
const COLUMN_BUDGET = 176

/**
 * The content column width for the room available.
 *
 * A stored preference is clamped to what fits; without one the column takes two
 * thirds of the room, between 680px and 920px, as the harness does.
 * @param available - width of the whole conversation area.
 * @param preference - the reader's dragged width, or null when there is none.
 */
export function resolveColumn(available: number, preference: number | null): number {
  const widest = Math.max(COLUMN_MIN, Math.round(available) - COLUMN_BUDGET)
  const wanted = preference ?? Math.max(680, Math.min(available * 0.64, 920))
  return Math.round(Math.min(widest, Math.max(COLUMN_MIN, wanted)))
}

/** Read the stored width preference, or null when absent or unusable. */
function readPreference(): number | null {
  try {
    const value = Number(window.localStorage.getItem(COLUMN))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch { return null }
}

const errorText = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)

/** Whether a stored comment carries the text that was just sent. */
const sameText = (body: string, text: string): boolean => body.trim() === text.trim()

/** One formatter per language; the transcript re-renders on every poll. */
const SHORT_TIME = new Map<string, Intl.DateTimeFormat>()

/**
 * The short timestamp the window shows, in the harness's shape.
 * @param at - ISO 8601 time of the message.
 * @param lang - interface language.
 */
function messageTime(at: string, lang: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  const locale = lang === 'en' ? 'en' : 'zh-CN'
  let formatter = SHORT_TIME.get(locale)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    SHORT_TIME.set(locale, formatter)
  }
  return formatter.format(date)
}

/** The full timestamp behind a message's tooltip. */
function fullTime(at: string, lang: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(lang === 'en' ? 'en' : 'zh-CN')
}

/**
 * Render the conversation of one workspace.
 * @param workspace - the workspace whose thread is shown.
 * @param onOpenProjects - opens the project pane, which picks the workspace.
 */
export function Conversation({ t, workspace, onOpenProjects }: { t: T; workspace: WorkspaceView; onOpenProjects: () => void }) {
  const chat = usePoll(() => panelApi.chat(workspace.id), [workspace.id], POLL_MS)
  // The deployment may be executing while this conversation's ticket waits for a
  // person; the running count is what decides the running whale.
  const load = usePoll(() => panelApi.load(workspace.id), [workspace.id], POLL_MS)
  // Paint the last conversation this tab saw, then replace it with the poll.
  const [cached] = useState<ChatView | undefined>(() => cache.chat(workspace.id))
  const view = chat.data ?? cached
  useEffect(() => {
    if (chat.data !== undefined) cache.saveChat(workspace.id, chat.data)
  }, [chat.data, workspace.id])
  // The harness keeps a draft per conversation; so does the panel, across switches and reloads.
  const [draft, setDraftState] = useState(() => readDraft(workspace.id))
  const setDraft = useCallback((text: string) => {
    setDraftState(text)
    writeDraft(workspace.id, text)
  }, [workspace.id])
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // What the person just sent, shown at once and replaced by the stored comment.
  const [pending, setPending] = useState<{ text: string; status: 'sending' | 'sent' } | null>(null)
  // The agent has the message but has not written its answer yet.
  const [awaiting, setAwaiting] = useState(false)
  // When the wait began, so the running indicator can count up as the harness does.
  const [waitFrom, setWaitFrom] = useState<number | null>(null)
  // The answers already on screen when the message went out; a new one ends the wait.
  const answeredBefore = useRef<Set<string>>(new Set())
  const scroller = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [preference, setPreference] = useState<number | null>(() => readPreference())
  const [available, setAvailable] = useState(0)
  const column = resolveColumn(available, preference)
  // The room decides the column, so a resized panel re-resolves it.
  useLayoutEffect(() => {
    const element = root.current
    if (element === null) return
    setAvailable(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const askColumn = useCallback((next: number) => {
    const widest = Math.max(COLUMN_MIN, available - COLUMN_BUDGET)
    setPreference(Math.min(widest, Math.max(COLUMN_MIN, Math.round(next))))
  }, [available])
  useEffect(() => {
    if (preference === null) return
    try { window.localStorage.setItem(COLUMN, String(preference)) } catch { /* width memory is a convenience */ }
  }, [preference])
  const messages = view?.messages ?? []
  const busy = (load.data ?? 0) > 0
  const state: ChatState = busy ? 'working' : view?.state ?? 'idle'
  const agentLogin = view?.agentLogin ?? workspace.agentLogin
  const hero = messages.length === 0

  // Follow the tail while the reader is at it, and leave a reader who scrolled up alone.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null || !following.current) return
    element.scrollTop = element.scrollHeight
  }, [chat.data, state])

  // The stored comment replaces the pending bubble as soon as a poll returns it.
  useEffect(() => {
    if (pending === null || view === undefined) return
    const landed = view.messages.some(message => message.role === 'operator' && sameText(message.body, pending.text))
    if (landed) setPending(null)
  }, [view, pending])

  // The first agent message written after the send ends the wait.
  useEffect(() => {
    if (!awaiting) return
    const answered = (view?.messages ?? []).some(message => message.role === 'agent' && !answeredBefore.current.has(message.id))
    if (!answered) return
    answeredBefore.current = new Set()
    setWaitFrom(null)
    setAwaiting(false)
  }, [view, awaiting])

  // A deployment that never answers must not leave the indicator up forever.
  useEffect(() => {
    if (!awaiting) return
    const timer = setTimeout(() => { setAwaiting(false); setWaitFrom(null) }, 180_000)
    return () => clearTimeout(timer)
  }, [awaiting])

  // While an answer is expected, read the thread more often than the idle poll.
  // The transport is a GitHub comment, so an answer appears when it is written,
  // not token by token; a shorter poll is what makes it show up promptly.
  useEffect(() => {
    if (!awaiting) return
    const timer = setInterval(() => { if (!document.hidden) void chat.reload() }, 1_500)
    return () => clearInterval(timer)
  }, [awaiting, chat.reload])

  const onScroll = (): void => {
    const element = scroller.current
    if (element === null) return
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < TAIL_PX
  }

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text.length === 0 || sending) return
    setSending(true)
    setFailure(undefined)
    setPending({ text, status: 'sending' })
    // The harness clears the composer at submit and puts the text back only when the send fails.
    clearDraft(workspace.id)
    setDraftState('')
    following.current = true
    try {
      await panelApi.send(workspace.id, text)
      setPending({ text, status: 'sent' })
      answeredBefore.current = new Set(messages.filter(message => message.role === 'agent').map(message => message.id))
      setWaitFrom(Date.now())
      setAwaiting(true)
      await chat.reload()
    } catch (thrown) {
      setPending(null)
      setDraft(text)
      setFailure(errorText(thrown))
    } finally {
      setSending(false)
    }
  }, [chat, draft, sending, workspace.id])

  return <div className="sar-conv" ref={root} data-phase={hero ? 'hero' : 'active'}
    style={{ '--sar-conv-width': column + 'px' } as CSSProperties}>
    <div className="sar-conv-scroll" ref={scroller} data-conversation-scroll onScroll={onScroll}>
      <Transcript t={t} messages={messages} state={state} pending={pending} awaiting={awaiting} waitFrom={waitFrom} />
    </div>
    <div className="sar-conv-seat">
      {view?.repliesIn !== undefined && <p className="sar-note">
        <Glyph name="warning-outline" size={14} />
        <span>{t('chat.repliesIn', { thread: '#' + String(view.repliesIn) })}</span>
        <a className="sar-md-link" href={'https://github.com/' + workspace.repository + '/issues/' + String(view.repliesIn)}
          target="_blank" rel="noopener noreferrer">{t('chat.open')}</a>
      </p>}
      {chat.error !== undefined && <p className="sar-banner" role="status">{t('chat.offline')}</p>}
      {failure !== undefined && <p className="sar-banner sar-banner-error" role="alert">{failure}</p>}
      {chat.error !== undefined && <p className="sar-banner sar-banner-error" role="alert">
        <span>{errorText(chat.error)}</span>
        <Button size="sm" onClick={() => void chat.reload()}>{t('retry')}</Button>
      </p>}
      {hero && <Hero t={t} workspace={workspace} onOpenProjects={onOpenProjects} />}
      <Composer t={t} draft={draft} onDraft={setDraft} onSend={() => { void send() }} sending={sending}
        state={state} agentLogin={agentLogin} repository={workspace.repository} thread={view?.thread} hero={hero} />
      {hero && <p className="sar-hero-hint">{t('chat.heroHint')}</p>}
      {hero && <p className="sar-hero-hint sar-hero-key">{t('chat.keyHint')}</p>}
    </div>
    {hero ? null : <>
      <WidthHandle side="left" onStart={() => column} onDrag={askColumn} onCommit={askColumn} />
      <WidthHandle side="right" onStart={() => column} onDrag={askColumn} onCommit={askColumn} />
    </>}
  </div>
}

/**
 * Render the messages of one conversation, in the harness conversation's column.
 * @param messages - the transcript, oldest first.
 * @param state - what the deployment is doing, shown under the last message.
 */
export function Transcript({ t, messages, state, pending, awaiting, waitFrom }: {
  t: T; messages: ChatMessage[]; state: ChatState
  pending?: { text: string; status: 'sending' | 'sent' } | null; awaiting?: boolean; waitFrom?: number | null
}) {
  return <div className="sar-flow">
    {messages.map((message, index) => <MessageRow key={message.id} t={t} message={message} lang={t('lang')}
      last={index === messages.length - 1} />)}
    {pending != null && <PendingRow t={t} pending={pending} lang={t('lang')} />}
    {awaiting
      ? <RunningTurn t={t} startedAt={waitFrom ?? Date.now()} />
      : state === 'idle' ? null : <RunningRow t={t} state={state} />}
  </div>
}

/**
 * What the person just sent, before GitHub returns it as a comment.
 *
 * The harness shows the submission at once and replaces it with the stored
 * message, so sending never looks like nothing happened.
 */
function PendingRow({ t, pending, lang }: { t: T; pending: { text: string; status: 'sending' | 'sent' }; lang: string }) {
  return <div className="sar-turn sar-turn-user sar-pending" data-status={pending.status} role="status" aria-live="polite">
    <div className="sar-bubble">{pending.text.split('\n').map((line, index) => <Fragment key={index}>
      {index > 0 && <br />}<PlainLine runs={linkify(line)} /></Fragment>)}</div>
    <div className="sar-actions">
      <span className="sar-pending-state">
        {pending.status === 'sending'
          ? <Glyph name="loading-outline" size={14} className="sar-spin" />
          : <Glyph name="check-outline" size={14} />}
        {pending.status === 'sending' ? t('chat.sending') : t('chat.sent')}
      </span>
    </div>
  </div>
}

/** The harness's running turn copy, with its live elapsed time. */
function durationLabel(seconds: number, t: T): string {
  if (seconds < 60) return t('chat.durationSeconds', { n: String(seconds) })
  return t('chat.durationMinutes', { m: String(Math.floor(seconds / 60)), s: String(seconds % 60) })
}

/**
 * The deployment has the message and has not answered yet.
 *
 * This mirrors the harness's running turn: the official animated whale tail, the
 * hidden status, the divider, and the shimmering copy.
 */
function RunningTurn({ t, startedAt }: { t: T; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(1, Math.round((now - startedAt) / 1_000))
  const label = t('chat.deepDivingFor', { duration: durationLabel(seconds, t) })
  return <RunningMark label={label} spoken={t('chat.deepDiving')} />
}

/**
 * The official running mark: animated whale tail, shimmering copy, divider.
 * @param label - visible copy, such as "深度求索中，用时 4 秒 ···".
 * @param spoken - status read once by a screen reader.
 */
function RunningMark({ label, spoken }: { label: string; spoken: string }) {
  return <div className="sar-running" data-chat-running="true">
    <span className="sar-visually-hidden" role="status" aria-live="polite" aria-atomic="true">{spoken}</span>
    <span className="sar-running-divider" aria-hidden="true" />
    <span className="sar-running-content">
      <span className="sar-running-icon" aria-hidden="true">
        <span className="sar-running-whale-animated" />
        <svg className="sar-running-whale-still" width="100%" height="100%" viewBox="0 0 16 16" fill="none">
          <path d="M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742" stroke="currentColor" strokeWidth={1} />
        </svg>
      </span>
      <span className="sar-running-text" data-shimmer="true">
        <span className="sar-running-text-content"><span className="sar-running-body">{label}</span></span>
        <span className="sar-running-decoration" aria-hidden="true">
          <span className="sar-running-sweep">
            <span className="sar-running-text-content sar-running-highlight">
              <span className="sar-running-body" data-shimmer-text={label} />
            </span>
          </span>
        </span>
      </span>
    </span>
  </div>
}

/** One message, in the shape its writer gets. */
function MessageRow({ t, message, last, lang }: {
  t: T; message: ChatMessage; last: boolean; lang: string
}) {
  const copy = useCopy()
  const at = <time dateTime={message.at} title={fullTime(message.at, lang)}>{messageTime(message.at, lang)}</time>
  const reveal = last ? 'always' : 'hover'
  const body = <CopyButton text={message.body} label={t('chat.copy')} copiedLabel={t('chat.copied')}
    state={copy} itemKey={message.id} />
  const id = 'sar-msg-' + message.id
  if (message.role === 'operator') {
    return <div className="sar-turn sar-turn-user" id={id} data-reveal={reveal}>
      <div className="sar-bubble">{message.body.split('\n').map((line, index) => <Fragment key={index}>
        {index > 0 && <br />}<PlainLine runs={linkify(line)} /></Fragment>)}</div>
      <div className="sar-actions" data-clock="start">{at}{body}</div>
    </div>
  }
  if (message.role === 'other') {
    return <div className="sar-turn sar-turn-agent" id={id} data-reveal={reveal}>
      <div className="sar-agent-head">
        <span className="sar-agent-name">{'@' + message.author}</span>
        <span className="sar-chip">{t('chat.role.other')}</span>
      </div>
      <ChatMarkdown text={message.body} t={t} />
      <div className="sar-actions" data-clock="end">{body}{at}</div>
    </div>
  }
  // The agent may answer more than once, so each answer keeps its own card: the
  // writer above, then the answer. The date sits in the action row below, with
  // the copy and link buttons, exactly where the harness puts an assistant
  // message's time.
  return <div className="sar-turn sar-turn-agent" id={id} data-reveal={reveal}>
    <div className="sar-agent-bubble">
      <div className="sar-agent-meta">
        <AgentMark size={16} />
        <span className="sar-agent-name">{'@' + message.author}</span>
      </div>
      <ChatMarkdown text={message.body} t={t} />
    </div>
    <div className="sar-actions" data-clock="end">
      {body}{message.url !== undefined && <a className="sar-action" href={message.url} target="_blank"
        rel="noopener noreferrer" title={t('chat.open')} aria-label={t('chat.open')}>
        <Glyph name="link-outline" size={16} />
      </a>}{at}
    </div>
  </div>
}

/** What the deployment is doing, under the last message. */
function RunningRow({ t, state }: { t: T; state: ChatState }) {
  if (state === 'working') return <RunningMark label={t('chat.working')} spoken={t('chat.working')} />
  return <div className="sar-state" data-state={state} role="status" aria-live="polite">
    <Glyph name="warning-outline" size={14} />
    <span className="sar-state-text">{t('chat.waiting')}</span>
  </div>
}

/** The empty conversation: the harness hero, over the composer that follows it. */
export function Hero({ t, workspace, onOpenProjects }: { t: T; workspace: WorkspaceView; onOpenProjects: () => void }) {
  return <div className="sar-hero">
    <div className="sar-hero-headline">
      <span className="sar-hero-mark"><FishLogo size={34} className="sar-hero-fish" /></span>
      <h2 className="sar-hero-title">{t('chat.hero')}<span className="sar-hero-badge">{t('chat.badge')}</span></h2>
    </div>
    <div className="sar-hero-row">
      <button type="button" className="sar-hero-workspace" title={t('proj.show')} onClick={onOpenProjects}>
        <Glyph name="folder-open" size={16} className="sar-hero-folder" />
        <span className="sar-hero-workspace-label">{workspace.name}</span>
        <Glyph name="chevron-down-outline" size={12} className="sar-hero-chevron" />
      </button>
    </div>
  </div>
}
