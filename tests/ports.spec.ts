import { describe, expect, it } from 'vitest'
import { firstFreePort } from '../src/ports.ts'

describe('firstFreePort', () => {
  it('starts at the base and reuses a freed port', async () => {
    expect(await firstFreePort(3081, [], async () => true)).toBe(3081)
    expect(await firstFreePort(3081, [3081, 3083], async () => true)).toBe(3082)
    expect(await firstFreePort(3081, [3082], async () => true)).toBe(3081)
  })

  it('skips a port another process holds', async () => {
    const busy = new Set([3081, 3082])
    expect(await firstFreePort(3081, [], async port => !busy.has(port))).toBe(3083)
  })

  it('refuses when the search window is exhausted', async () => {
    await expect(firstFreePort(65_000, [], async () => false)).rejects.toThrow(/没有空闲端口/)
  })
})
