import { describe, expect, it } from 'vitest'
import { chatStateOf, issueOf, replyRoom, MAIN_THREAD_INTRO, MAIN_THREAD_MARKER, markedThread, messagesOf, roleOf, spoken, withoutIntro } from '../src/chat.ts'

const row = { id: 't1', title: 'README', stage: 'person' as const, threads: [{ key: 'github:1' }, { key: 'github:2' }] }

describe('issueOf', () => {
  it('reads the issue number from the first GitHub thread key', () => {
    expect(issueOf(row)).toBe(1)
  })

  it('ignores other sources and malformed keys', () => {
    expect(issueOf({ ...row, threads: [{ key: 'feishu:oc_x' }, { key: 'github:' }] })).toBeUndefined()
    expect(issueOf({ ...row, threads: undefined })).toBeUndefined()
  })
})

describe('replyRoom', () => {
  it('names the thread a ticket started on, when that is not the person\'s thread', () => {
    const ticket = { threads: [{ key: 'github:1' }, { key: 'github:7' }] }
    expect(replyRoom(ticket, 7)).toBe(1)
    expect(replyRoom(ticket, 1)).toBeUndefined()
  })

  it('answers nothing without a GitHub thread', () => {
    expect(replyRoom({}, 7)).toBeUndefined()
    expect(replyRoom({ threads: [{ key: 'feishu:oc_1' }] }, 7)).toBeUndefined()
  })
})

describe('markedThread', () => {
  it('prefers the recorded number without reading the list', () => {
    expect(markedThread([], 7)).toBe(7)
    expect(markedThread([{ number: 3, body: MAIN_THREAD_MARKER }], 7)).toBe(7)
  })

  it('finds the issue that carries the conversation marker', () => {
    const issues = [{ number: 1, body: 'hello' }, { number: 2, body: MAIN_THREAD_MARKER + '\n\nintro' }]
    expect(markedThread(issues)).toBe(2)
  })

  it('answers undefined while no conversation exists', () => {
    expect(markedThread([{ number: 1, body: 'hello' }])).toBeUndefined()
    expect(markedThread([])).toBeUndefined()
  })
})

describe('messagesOf', () => {
  const issue = {
    number: 6, title: 'README', state: 'OPEN',
    body: MAIN_THREAD_MARKER + '\n\n' + MAIN_THREAD_INTRO + '\n\n@superagent-demo count the lines',
    author: { login: 'demo-operator' }, createdAt: '2026-11-17T16:00:00Z',
    url: 'https://github.com/o/r/issues/6',
    comments: [
      { id: 'c1', author: { login: 'superagent-demo' }, createdAt: '2026-11-17T16:01:00Z',
        body: 'Two lines.\n\nThis is by an automated agent, not a human.\n<!-- dsh-superagent:def -->' },
      { id: 'c2', author: null, createdAt: '2026-11-17T16:02:00Z', body: '<!-- dsh-superagent:only -->' },
      { id: 'c3', author: { login: 'demo-operator' }, createdAt: '2026-11-17T16:03:00Z',
        body: '@superagent-demo and what about the last one?' },
    ],
  }

  it('shows the thread as the person wrote it: no marker, no intro, no address', () => {
    const messages = messagesOf(issue, 'demo-operator', 'superagent-demo')
    expect(messages.map(message => message.role)).toEqual(['operator', 'agent', 'operator'])
    expect(messages[0]?.body).toBe('count the lines')
    expect(messages[1]?.body).toBe('Two lines.')
    expect(messages[1]?.at).toBe('2026-11-17T16:01:00Z')
    expect(messages[2]?.body).toBe('and what about the last one?')
  })

  it('drops a comment that carried nothing but metadata', () => {
    expect(messagesOf(issue, '', 'superagent-demo').map(message => message.id)).toEqual(['issue-6', 'c1', 'c3'])
  })

  it('skips an empty issue body', () => {
    expect(messagesOf({ ...issue, body: '   ' }, 'op', 'agent').map(message => message.id)).toEqual(['c1', 'c3'])
  })

  it('skips a body that was only the marker, the intro, and the address', () => {
    const bare = MAIN_THREAD_MARKER + '\n\n' + MAIN_THREAD_INTRO + '\n\n@superagent-demo'
    expect(messagesOf({ ...issue, body: bare }, 'demo-operator', 'superagent-demo').map(m => m.id))
      .toEqual(['c1', 'c3'])
  })
})

describe('spoken', () => {
  it('drops the address the plugin prepends', () => {
    expect(spoken('@agent hello', 'operator', 'agent')).toBe('hello')
    expect(spoken('@Agent, hello', 'operator', 'agent')).toBe('hello')
  })

  it('keeps a mention the person wrote further in', () => {
    expect(spoken('ask @agent about it', 'operator', 'agent')).toBe('ask @agent about it')
  })

  it('keeps what the agent and other people wrote', () => {
    expect(spoken('@operator done', 'agent', 'agent')).toBe('@operator done')
    expect(spoken('@agent hi', 'other', 'agent')).toBe('@agent hi')
  })

  it('does nothing without an agent account', () => {
    expect(spoken('@agent hi', 'operator', '')).toBe('@agent hi')
  })
})

describe('withoutIntro', () => {
  it('drops the introduction the plugin writes, and only at the start', () => {
    expect(withoutIntro(MAIN_THREAD_INTRO + '\n\nhello')).toBe('hello')
    expect(withoutIntro('quoted: ' + MAIN_THREAD_INTRO)).toBe('quoted: ' + MAIN_THREAD_INTRO)
  })
})

describe('roleOf', () => {
  it('separates the agent, the operator, and everyone else', () => {
    expect(roleOf('superagent-demo', 'superagent-demo', 'demo-operator')).toBe('agent')
    expect(roleOf('demo-operator', 'superagent-demo', 'demo-operator')).toBe('operator')
    expect(roleOf('dependabot[bot]', 'superagent-demo', 'demo-operator')).toBe('other')
  })

  it('does not match an empty account', () => {
    expect(roleOf('anyone', '', '')).toBe('other')
  })
})

describe('chatStateOf', () => {
  it('reports working while an Executor runs, even when the ticket waits for a person', () => {
    expect(chatStateOf('person', 1)).toBe('working')
    expect(chatStateOf(undefined, 2)).toBe('working')
    expect(chatStateOf('person', 0)).toBe('person')
    expect(chatStateOf('working', 0)).toBe('working')
    expect(chatStateOf('idle', 0)).toBe('idle')
  })
})
