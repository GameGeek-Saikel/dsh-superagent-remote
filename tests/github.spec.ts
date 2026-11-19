import { describe, expect, it } from 'vitest'
import { cleanBody, issueTitle } from '../src/github.ts'

describe('cleanBody', () => {
  it('removes the machine metadata the source writes', () => {
    const body = 'Look at this.\n\n<!-- dsh-superagent:ticket=abc -->\n<!-- dsh-superagent:x -->'
    expect(cleanBody(body)).toBe('Look at this.')
  })

  it('removes every HTML comment, including the conversation thread marker', () => {
    expect(cleanBody('<!-- dsh-superagent-remote:chat -->\n\nhello there')).toBe('hello there')
    expect(cleanBody('before\n\n<!-- a note that GitHub hides -->\n\nafter')).toBe('before\n\nafter')
  })

  it('removes the automation disclosure line but keeps the rest', () => {
    const body = 'Fixed in #2.' + '\n\nThis is by an automated agent, not a human.\n\nNothing else.'
    expect(cleanBody(body)).toBe('Fixed in #2.\n\nNothing else.')
  })

  it('collapses runs of blank lines and trims', () => {
    expect(cleanBody('\n\n a \n\n\n\n b \n\n')).toBe('a \n\n b')
  })
})

describe('issueTitle', () => {
  it('flattens whitespace and caps the length', () => {
    expect(issueTitle('  add   a\nline ')).toBe('add a line')
    expect(issueTitle('x'.repeat(120)).length).toBe(70)
  })

  it('falls back to a neutral title for an empty message', () => {
    expect(issueTitle('   ')).toBe('request')
  })
})
