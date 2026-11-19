import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMessage } from '../src/types.ts'
import type { T } from '../src/client/locales.ts'
import { Composer } from '../src/client/conversation/Composer.tsx'
import { Transcript, resolveColumn } from '../src/client/conversation/Conversation.tsx'

/**
 * A translator that answers with its key and the values it was given, so these
 * assertions follow neither the copy nor the locale.
 */
const t = ((key: string, values?: Record<string, string>) => values === undefined ? key
  : key + '(' + Object.values(values).join(',') + ')') as unknown as T
const at = '2026-11-18T03:40:00+08:00'

const message = (id: string, role: ChatMessage['role'], body: string): ChatMessage =>
  ({ id, author: role === 'operator' ? 'me' : 'agent-login', role, body, at })

const render = (messages: ChatMessage[], state: 'idle' | 'working' | 'person' = 'idle'): string =>
  renderToStaticMarkup(<Transcript t={t} messages={messages} state={state} />)

describe('transcript', () => {
  it('draws the person on the right as a bubble', () => {
    const html = render([message('m1', 'operator', 'hello')])
    expect(html).toContain('class="sar-turn sar-turn-user"')
    expect(html).toContain('class="sar-bubble"')
    expect(html).toContain('hello')
  })

  it('reveals a message actions only while it is the tail', () => {
    const html = render([message('m1', 'operator', 'one'), message('m2', 'agent', 'two')])
    expect(html).toContain('data-reveal="hover"')
    expect(html).toContain('data-reveal="always"')
  })

  it('draws the agent answer in the column, with its writer and time', () => {
    const body = '## Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nlet a = 1\n```'
    const html = render([message('m1', 'operator', 'question'), message('m2', 'agent', body)])
    expect(html).toContain('sar-agent-bubble')
    expect(html).toContain('sar-agent-meta')
    expect(html).toContain('@agent-login')
    expect(html).toContain('<time')
    expect(html).toContain('sar-md-heading')
    expect(html).toContain('sar-md-table')
    expect(html).toContain('sar-md-pre')
  })

  it('puts an answer\'s date in the action row below the card', () => {
    const html = render([message('m1', 'operator', 'question'), message('m2', 'agent', 'answer')])
    const start = html.indexOf('sar-turn-agent')
    expect(html.indexOf('sar-actions', start)).toBeGreaterThan(start)
    expect(html.indexOf('<time', start)).toBeGreaterThan(html.indexOf('sar-actions', start))
  })

  it('does not put a reply bar above an answer next to its question', () => {
    const html = render([message('m1', 'operator', 'who are you'), message('m2', 'agent', 'the agent')])
    expect(html).not.toContain('class="sar-quote"')
    expect(html).not.toContain('chat.quoteTo')
  })

  it('keeps several answers to one question as separate turns', () => {
    const html = render([message('m1', 'operator', 'one question'),
      message('m2', 'agent', 'ack'), message('m3', 'agent', 'answer')])
    expect(html.match(/sar-turn sar-turn-agent/g)?.length).toBe(2)
    expect(html.match(/sar-agent-meta/g)?.length).toBe(2)
    expect(html).not.toContain('sar-quote')
  })

  it('names another person in the thread', () => {
    const html = render([message('m3', 'other', 'hi')])
    expect(html).toContain('sar-agent-head')
    expect(html).toContain('@agent-login')
  })

  it('opens a message link safely', () => {
    const html = render([message('m2', 'agent', 'see [docs](https://example.com/a)')])
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('reports what the deployment is doing only while it is not idle', () => {
    expect(render([message('m1', 'operator', 'hello')])).not.toContain('sar-state')
    const working = render([message('m1', 'operator', 'hello')], 'working')
    expect(working).toContain('sar-running-whale-animated')
    expect(working).toContain('chat.working')
    const person = render([message('m1', 'operator', 'hello')], 'person')
    expect(person).toContain('class="sar-state" data-state="person"')
    expect(person).toContain('chat.waiting')
  })
})

describe('the conversation column', () => {
  it('takes two thirds of the room, within the harness bounds', () => {
    expect(resolveColumn(1600, null)).toBe(920)
    expect(resolveColumn(1200, null)).toBe(768)
    expect(resolveColumn(900, null)).toBe(680)
    expect(resolveColumn(0, null)).toBe(640)
  })

  it('keeps the dragged width inside the room the handles leave', () => {
    expect(resolveColumn(900, 724)).toBe(724)
    expect(resolveColumn(900, 2000)).toBe(724)
    expect(resolveColumn(900, 200)).toBe(640)
    expect(resolveColumn(1200, 700)).toBe(700)
  })
})

describe('composer', () => {
  const composer = (draft: string, hero = false): string => renderToStaticMarkup(<Composer t={t} draft={draft}
    onDraft={() => {}} onSend={() => {}} sending={false} state="idle" agentLogin="agent-login"
    repository="owner/name" thread={hero ? null : 7} hero={hero} />)

  it('keeps the send button disabled until there is a draft', () => {
    expect(composer('')).toContain('disabled=""')
    expect(composer('text')).not.toContain('disabled=""')
  })

  it('names the account and links the thread once it exists', () => {
    expect(composer('')).toContain('agent-login')
    expect(composer('')).toContain('href="https://github.com/owner/name/issues/7"')
    expect(composer('', true)).not.toContain('/issues/')
  })
})
