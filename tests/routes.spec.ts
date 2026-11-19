import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { routes, trusted } from '../src/routes.ts'
import type { Runtime } from '../src/runtime.ts'

const seen: { method: string; path: string; body: string | undefined }[] = []
const sent: { operator: string; agentLogin: string; text: string }[] = []
const remembered: { id: string; thread: number }[] = []
const started: string[] = []
const active: string[] = []

const fake = {
  snapshot: async () => ({ wsl: { distro: 'Ubuntu-22.04', running: true, owned: false, available: true },
    workspaces: [], operator: 'demo-operator', checkout: '/root/dsh-superagent' }),
  ensureStarted: async () => {},
  beginStart: () => { started.push('start') },
  setActive: async (id: string) => { active.push(id) },
  discovery: async () => [{ profile: 'superagent', port: 3082, adopted: false }],
  adopt: async (profile: string, port?: number) => ({ id: 'adopted', profile, port }),
  create: async (request: unknown) => (request),
  update: async (id: string, patch: unknown) => ({ id, ...patch as object }),
  remove: async () => {},
  startWorkspace: async (id: string) => ({ id, started: true }),
  stopWorkspace: async (id: string) => ({ id, stopped: true }),
  restartWorkspace: () => {},
  workspaceFor: (id: string) => ({ id, repository: 'owner/repo', port: 3083, agentLogin: 'agent' }),
  rememberThread: async (id: string, thread: number) => { remembered.push({ id, thread }) },
  uiUrl: async (id: string) => 'http://127.0.0.1:3083/?token=' + id,
  operator: async () => 'demo-operator',
  forward: async (id: string, method: string, path: string, body: string | undefined) => {
    seen.push({ method, path, body })
    return { status: 200, type: 'application/json', text: JSON.stringify({ id }) }
  },
} as unknown as Runtime

/** The conversation stands in for GitHub, which the tests must not touch. */
const conversation = {
  read: async () => ({ thread: 7, messages: [], agentLogin: 'agent', operator: 'demo-operator', state: 'idle' as const }),
  send: async (_workspace: unknown, operator: string, agentLogin: string, text: string) => {
    sent.push({ operator, agentLogin, text })
    return { thread: 7, created: true }
  },
}

let server: Server
let port = 0

beforeAll(async () => {
  const [route] = routes(fake, () => port, [], conversation)
  if (route === undefined) throw new Error('no route')
  server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const url = (path: string): string => 'http://127.0.0.1:' + String(port) + path

describe('trusted', () => {
  it('accepts the harness origin and rejects everything else', () => {
    expect(trusted({ headers: { host: '127.0.0.1:3080' } }, 3080)).toBe(true)
    expect(trusted({ headers: { host: 'localhost:3080' } }, 3080)).toBe(true)
    expect(trusted({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }, 3080)).toBe(true)
    expect(trusted({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }, 3080)).toBe(false)
    expect(trusted({ headers: { host: '10.0.0.5:3080' } }, 3080)).toBe(false)
    expect(trusted({ headers: {} }, 3080)).toBe(false)
  })

  it('accepts a configured authority and nothing else', () => {
    expect(trusted({ headers: { host: '192.168.1.5:3080' } }, 3080, ['192.168.1.5:3080'])).toBe(true)
    expect(trusted({ headers: { host: '192.168.1.6:3080' } }, 3080, ['192.168.1.5:3080'])).toBe(false)
    expect(trusted({ headers: { host: 'box.local:3080' } }, 3080, ['box.local'])).toBe(true)
  })

  it('falls back to any loopback authority before the port is known', () => {
    expect(trusted({ headers: { host: '127.0.0.1:38999' } }, undefined)).toBe(true)
    expect(trusted({ headers: { host: 'example.com:80' } }, undefined)).toBe(false)
  })
})

describe('the plugin API', () => {
  it('answers the runtime snapshot', async () => {
    const answer = await fetch(url('/superagent-remote/api/runtime'))
    expect(answer.status).toBe(200)
    expect((await answer.json() as { operator: string }).operator).toBe('demo-operator')
  })

  it('creates a workspace from the posted fields', async () => {
    const answer = await fetch(url('/superagent-remote/api/workspaces'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Demo', repository: 'owner/repo', agentLogin: 'agent' }),
    })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ name: 'Demo', repository: 'owner/repo', agentLogin: 'agent' })
  })

  it('refuses a create request without its fields', async () => {
    const answer = await fetch(url('/superagent-remote/api/workspaces'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Demo' }),
    })
    expect(answer.status).toBe(400)
    expect((await answer.json() as { error: string }).error).toMatch(/repository/)
  })

  it('routes workspace actions', async () => {
    const started = await fetch(url('/superagent-remote/api/workspaces/w1/start'), { method: 'POST', body: '{}' })
    expect(await started.json()).toEqual({ id: 'w1', started: true })
    const stopped = await fetch(url('/superagent-remote/api/workspaces/w1/stop'), { method: 'POST', body: '{}' })
    expect(await stopped.json()).toEqual({ id: 'w1', stopped: true })
  })

  it('kicks off the first start without waiting for it', async () => {
    started.length = 0
    const answer = await fetch(url('/superagent-remote/api/runtime/start'), { method: 'POST', body: '{}' })
    expect(answer.status).toBe(200)
    expect(started).toEqual(['start'])
    expect((await answer.json() as { operator: string }).operator).toBe('demo-operator')
  })

  it('records the workspace the panel is showing', async () => {
    active.length = 0
    const answer = await fetch(url('/superagent-remote/api/active'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'w1' }),
    })
    expect(answer.status).toBe(200)
    expect(active).toEqual(['w1'])
    expect(await answer.json()).toEqual({ lastWorkspace: 'w1' })
  })

  it('reads the conversation', async () => {
    const answer = await fetch(url('/superagent-remote/api/workspaces/w1/chat'))
    expect(answer.status).toBe(200)
    expect((await answer.json() as { thread: number }).thread).toBe(7)
  })

  it('sends a message into the conversation and records the thread', async () => {
    sent.length = 0
    remembered.length = 0
    const answer = await fetch(url('/superagent-remote/api/workspaces/w1/chat'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }),
    })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ thread: 7 })
    expect(sent).toEqual([{ operator: 'demo-operator', agentLogin: 'agent', text: 'hello' }])
    expect(remembered).toEqual([{ id: 'w1', thread: 7 }])
  })

  it('carries the pin and archive flags through the patch', async () => {
    const answer = await fetch(url('/superagent-remote/api/workspaces/w1'), {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true, archived: false }),
    })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({ id: 'w1', pinned: true, archived: false })
  })

  it('answers the deployment UI address', async () => {
    const answer = await fetch(url('/superagent-remote/api/workspaces/w1/ui'))
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ url: 'http://127.0.0.1:3083/?token=w1' })
  })

  it('refuses a workspace action it does not know', async () => {
    const answer = await fetch(url('/superagent-remote/api/workspaces/w1/frobnicate'), { method: 'POST', body: '{}' })
    expect(answer.status).toBe(400)
    expect((await answer.json() as { error: string }).error).toMatch(/unknown workspace action frobnicate/)
  })

  it('forwards the panel management calls with the block name intact', async () => {
    seen.length = 0
    const answer = await fetch(url('/superagent-remote/w1/orchestrator/api/settings/source:github?x=1'), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: {}, revision: 1 }),
    })
    expect(answer.status).toBe(200)
    expect(seen).toEqual([{ method: 'PUT', path: 'settings/source:github?x=1', body: '{"value":{},"revision":1}' }])
  })

  it('answers an unknown operation with a refusal', async () => {
    const answer = await fetch(url('/superagent-remote/api/nothing'))
    expect(answer.status).toBe(400)
    expect((await answer.json() as { error: string }).error).toMatch(/unknown operation/)
  })
})
