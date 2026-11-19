// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceView } from '../src/types.ts'
import type { T } from '../src/client/locales.ts'
import { clearDraft, readDraft, writeDraft } from '../src/client/drafts.ts'
import { Conversation } from '../src/client/conversation/Conversation.tsx'

/** Keys with their values, so the assertions follow neither copy nor locale. */
const t = ((key: string, values?: Record<string, string>) => values === undefined ? key
  : key + '(' + Object.values(values).join(',') + ')') as unknown as T

const workspace: WorkspaceView = {
  id: 'w1', name: 'w1', repository: 'owner/repo', agentLogin: 'agent', profile: 'superagent', port: 3082,
  stateDir: '/root/.dsh', agentCli: '/root/gh-agent', enabled: true, pinned: false, archived: false,
  adopted: false, provisioned: true, basePath: '/superagent-remote/w1/orchestrator',
  health: { phase: 'ready', detail: '', at: '2026-11-18T00:00:00Z' },
}

let chat: Record<string, unknown> = { thread: null, messages: [], agentLogin: 'agent', operator: 'me', state: 'idle' }
/** Holds the POST open so the sending state can be observed. */
let postGate: (() => void) | undefined

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })
beforeEach(() => {
  chat = { thread: null, messages: [], agentLogin: 'agent', operator: 'me', state: 'idle' }
  postGate = undefined
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      await new Promise<void>(resolve => { postGate = resolve })
      return new Response(JSON.stringify({ thread: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(chat), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

/** Mount the conversation and return its container. */
async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await act(async () => { root.render(<Conversation t={t} workspace={workspace} onOpenProjects={() => {}} />) })
  cleanup = () => { act(() => root.unmount()); container.remove() }
  return container
}

/** Type into the composer the way a person does. */
async function type(container: HTMLDivElement, text: string): Promise<void> {
  const input = container.querySelector('.sar-composer-input') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('composer drafts', () => {
  it('remembers, restores, and forgets one conversation draft', () => {
    writeDraft('w1', 'half a thought')
    expect(readDraft('w1')).toBe('half a thought')
    writeDraft('w1', '')
    expect(readDraft('w1')).toBe('')
    writeDraft('w1', 'again')
    clearDraft('w1')
    expect(readDraft('w1')).toBe('')
    expect(window.sessionStorage.getItem('superagent-remote/draft/w1')).toBeNull()
  })

  it('forgets the draft once the message went out', async () => {
    const container = await mount()
    await type(container, 'send me')
    const send = container.querySelector('.sar-composer-send') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    await act(async () => { send.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect((container.querySelector('.sar-composer-input') as HTMLTextAreaElement).value).toBe('')
    expect(readDraft('w1')).toBe('')
  })

  it('says where the answer will appear when another thread owns the ticket', async () => {
    chat = { ...chat, repliesIn: 1 }
    const container = await mount()
    const note = container.querySelector('.sar-note')
    expect(note?.textContent).toContain('chat.repliesIn(#1)')
    expect(note?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/owner/repo/issues/1')
  })

  it('picks up a reply that arrives while the page stays open', async () => {
    const container = await mount()
    expect(container.textContent).toContain('chat.hero')
    chat = {
      ...chat,
      messages: [
        { id: 'c1', author: 'demo-operator', role: 'operator', body: 'question', at: '2026-11-18T15:42:26Z' },
        { id: 'c2', author: 'agent', role: 'agent', body: 'a late answer', at: '2026-11-18T15:43:19Z' },
      ],
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3_400)) })
    expect(container.textContent).toContain('a late answer')
  })

  it('shows the message as sending, then sent, then the reply arrives', async () => {
    const container = await mount()
    await type(container, 'hello there')
    const send = container.querySelector('.sar-composer-send') as HTMLButtonElement
    await act(async () => { send.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const sending = container.querySelector('.sar-pending')
    expect(sending?.getAttribute('data-status')).toBe('sending')
    expect(sending?.textContent).toContain('chat.sending')
    await act(async () => { postGate?.(); await new Promise(resolve => setTimeout(resolve, 100)) })
    const sent = container.querySelector('.sar-pending')
    expect(sent?.getAttribute('data-status')).toBe('sent')
    expect(sent?.textContent).toContain('chat.sent')
    expect(container.querySelector('.sar-running')).not.toBeNull()
    chat = {
      ...chat,
      thread: 1,
      messages: [
        { id: 'c1', author: 'demo-operator', role: 'operator', body: 'hello there', at: '2026-11-18T16:00:00Z' },
        { id: 'c2', author: 'agent', role: 'agent', body: 'answered at last', at: '2026-11-18T16:00:20Z' },
      ],
    }
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await new Promise(resolve => setTimeout(resolve, 200))
    })
    expect(container.querySelector('.sar-pending')).toBeNull()
    expect(container.querySelector('.sar-running')).toBeNull()
    expect(container.textContent).toContain('answered at last')
  })

  it('says the connection dropped instead of looking empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const container = await mount()
    expect(container.textContent).toContain('chat.offline')
  })

  it('refreshes at once when the window regains focus', async () => {
    const container = await mount()
    chat = {
      ...chat,
      messages: [
        { id: 'c1', author: 'demo-operator', role: 'operator', body: 'question', at: '2026-11-18T15:42:26Z' },
        { id: 'c2', author: 'agent', role: 'agent', body: 'a focused answer', at: '2026-11-18T15:43:19Z' },
      ],
    }
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await new Promise(resolve => setTimeout(resolve, 200))
    })
    expect(container.textContent).toContain('a focused answer')
  })

  it('keeps the draft across a remount of the conversation', async () => {
    const first = await mount()
    await type(first, 'keep me')
    cleanup?.(); cleanup = undefined
    const second = await mount()
    expect((second.querySelector('.sar-composer-input') as HTMLTextAreaElement).value).toBe('keep me')
  })
})
