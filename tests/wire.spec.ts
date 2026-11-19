/**
 * Pins the management API fields the plugin reads.
 *
 * The fixtures are recorded from a running deployment (dsh-superagent 0.1.0 on
 * DSH 0.2.1-rc.5). The chat page reads `items[].threads[].key` and the ticket
 * badge fields; the settings writer reads block revisions and the GitHub
 * Source's config; the runtime reads the health and setup blocks.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { issueOf } from '../src/chat.ts'
import { healthOf } from '../src/runtime.ts'

const read = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)), 'utf8')) as T

interface TicketPage {
  items: { id: string; title: string; stage: 'person' | 'working' | 'idle' | 'ended'; action?: string; updatedAt: string
    summary?: string; threads: { key: string; url?: string }[] }[]
  total: number
}
interface SettingsPage {
  blocks: Record<string, { value: Record<string, unknown>; revision: number }>
  sources: { id: string; kind: string; installed: boolean; value: Record<string, unknown>; revision: number }[]
}
interface StatePage {
  setup: { machine: { stateDir: string }; problem: unknown; accounts?: { repository?: string; agent?: string } | null }
  load: { running: number; queued: number; maxWorkers: number }
  masterId: string
  paused: boolean
  health: Record<string, { state: string; detail: string }>
}

describe('GET state', () => {
  it('carries what the runtime and the workspace header read', async () => {
    const state = await read<StatePage>('state.json')
    expect(typeof state.setup.machine.stateDir).toBe('string')
    expect(state.setup.accounts?.repository).toMatch(/^[^/]+\/[^/]+$/)
    expect(state.setup.accounts?.agent).toBeTruthy()
    expect(state.health.runtime?.state).toBe('ready')
    expect(typeof state.load.maxWorkers).toBe('number')
    expect(typeof state.masterId).toBe('string')
  })

  it('maps onto a ready workspace health without a setup problem', async () => {
    const health = healthOf(await read('state.json'))
    expect(health.phase).toBe('ready')
    expect(health.setup).toBeUndefined()
  })
})

describe('GET tickets', () => {
  it('keys every ticket to the issue its thread names', async () => {
    const page = await read<TicketPage>('tickets.json')
    for (const ticket of page.items) {
      expect(['person', 'working', 'idle', 'ended']).toContain(ticket.stage)
      expect(issueOf(ticket)).toBeTypeOf('number')
    }
  })
})

describe('GET settings', () => {
  it('gives every block the revision a save must carry', async () => {
    const page = await read<SettingsPage>('settings.json')
    for (const block of ['policy', 'eval', 'executor']) {
      expect(page.blocks[block]?.revision).toBeTypeOf('number')
      expect(page.blocks[block]?.value).toBeTypeOf('object')
    }
  })

  it('installs a GitHub Source with a repository, a CLI, and a revision', async () => {
    const page = await read<SettingsPage>('settings.json')
    const github = page.sources.find(source => source.id === 'github')
    expect(github?.installed).toBe(true)
    expect(github?.revision).toBeTypeOf('number')
    const config = github?.value.config as { repository?: string; cli?: string } | undefined
    expect(config?.repository).toMatch(/^[^/]+\/[^/]+$/)
    expect(typeof config?.cli).toBe('string')
  })
})