// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/types.ts'
import type { T } from '../src/client/locales.ts'
import { Transcript } from '../src/client/conversation/Conversation.tsx'

/** Keys with their values, so the assertions follow neither copy nor locale. */
const t = ((key: string, values?: Record<string, string>) => values === undefined ? key
  : key + '(' + Object.values(values).join(',') + ')') as unknown as T

const at = '2026-11-18T03:40:00+08:00'
const messages: ChatMessage[] = [
  { id: 'm1', author: 'me', role: 'operator', body: 'who are you?', at },
  { id: 'm2', author: 'agent-login', role: 'agent', body: 'the agent', at },
  { id: 'm3', author: 'agent-login', role: 'agent', body: 'and here is why', at },
]

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await act(async () => { root.render(<Transcript t={t} messages={messages} state="idle" />) })
  cleanup = () => { act(() => root.unmount()); container.remove() }
  return container
}

describe('several answers next to one question', () => {
  it('draws each answer in place, with its own writer and time and no reply bar', async () => {
    const container = await mount()
    expect(container.querySelectorAll('.sar-agent-meta')).toHaveLength(2)
    expect(container.querySelectorAll('.sar-turn-agent .sar-actions time')).toHaveLength(2)
    expect(container.querySelector('.sar-quote')).toBeNull()
    expect(container.textContent).not.toContain('chat.quoteTo')
  })
})
