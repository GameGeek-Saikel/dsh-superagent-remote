import { describe, expect, it } from 'vitest'
import { decodeWslList, explain } from '../src/wsl.ts'

describe('decodeWslList', () => {
  it('decodes the UTF-16LE text wsl.exe writes for itself', () => {
    const text = 'Ubuntu-22.04\r\ndocker-desktop\r\n'
    const bytes = Buffer.from(text, 'utf16le')
    expect(decodeWslList(bytes)).toEqual(['Ubuntu-22.04', 'docker-desktop'])
  })

  it('decodes a Linux program UTF-8 output', () => {
    expect(decodeWslList(Buffer.from('a\n\nb\n', 'utf8'))).toEqual(['a', 'b'])
  })

  it('strips a byte order mark and stray NULs', () => {
    const bytes = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('x\r\n', 'utf16le')])
    expect(decodeWslList(bytes)).toEqual(['x'])
  })
})

describe('explain', () => {
  it('answers undefined for a clean exit', () => {
    expect(explain({ code: 0, stdout: '', stderr: '', timedOut: false })).toBeUndefined()
  })

  it('names the last line of the failure', () => {
    expect(explain({ code: 1, stdout: '', stderr: 'warning\nDistribution not found', timedOut: false }))
      .toBe('Distribution not found')
  })

  it('reports a timeout and a spawn failure', () => {
    expect(explain({ code: -1, stdout: '', stderr: '', timedOut: true })).toBe('the command timed out')
    expect(explain({ code: -1, stdout: '', stderr: '', timedOut: false, failure: 'ENOENT' })).toBe('ENOENT')
  })

  it('truncates a long failure and falls back to the exit code', () => {
    const long = explain({ code: 2, stdout: '', stderr: 'x'.repeat(400), timedOut: false })
    expect(long?.endsWith('...')).toBe(true)
    expect(long?.length).toBe(303)
    expect(explain({ code: 7, stdout: '', stderr: '', timedOut: false })).toBe('exit code 7')
  })
})
