import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { Runtime, type Log } from '../src/runtime.ts'
import { WorkspaceStore, type Workspace } from '../src/store.ts'
import type { Wsl } from '../src/wsl.ts'

const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} }
const calls: string[] = []
let server: Server
let port = 0
let url = ''

const workspace = (id: string): Workspace => ({
  id,
  name: id,
  repository: 'owner/' + id,
  agentLogin: 'agent',
  profile: 'superagent-' + id,
  port,
  stateDir: '/root/.dsh/state/' + id,
  agentCli: '/root/.local/bin/gh-agent',
  enabled: true,
  adopted: false,
  provisioned: true,
  createdAt: '2026-01-01T00:00:00.000Z',
})

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      health: { runtime: { state: 'ready' } },
      setup: { accounts: { repository: 'owner/x', agent: 'agent' } },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  url = 'http://127.0.0.1:' + String(port) + '/?token=abc'
})

afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

async function runtimeWith(): Promise<{ runtime: Runtime; store: WorkspaceStore }> {
  const store = await WorkspaceStore.open(join(await mkdtemp(join(tmpdir(), 'sar-runtime-')), 'workspaces.json'))
  await store.add(workspace('a'))
  const wsl = {
    available: async () => true,
    isRunning: async () => true,
    bash: async (script: string) => {
      calls.push(script)
      if (script.includes('printf %s "$HOME"')) return { code: 0, stdout: '/root', stderr: '', timedOut: false }
      if (script.includes('--stop-timeout')) return { code: 0, stdout: '', stderr: '', timedOut: false }
      return { code: 0, stdout: url + '\n', stderr: '', timedOut: false }
    },
  } as unknown as Wsl
  return { runtime: new Runtime({ config: resolveConfig(undefined), store, wsl, log: quiet }), store }
}

describe('the deployment UI address', () => {
  it('reads the log of this profile and returns its launch-token address', async () => {
    calls.length = 0
    const { runtime } = await runtimeWith()
    await expect(runtime.uiUrl('a')).resolves.toBe(url)
    expect(calls.some(script => script.includes('superagent-a-'))).toBe(true)
  })

  it('refuses a deployment that is not running', async () => {
    const store = await WorkspaceStore.open(join(await mkdtemp(join(tmpdir(), 'sar-runtime-')), 'workspaces.json'))
    const dead = { ...workspace('dead'), port: 1 }
    await store.add(dead)
    const wsl = { available: async () => true, isRunning: async () => true } as unknown as Wsl
    const runtime = new Runtime({ config: resolveConfig(undefined), store, wsl, log: quiet })
    await expect(runtime.uiUrl('dead')).rejects.toThrow(/还没有运行/)
  })
})

describe('removing a workspace', () => {
  it('stops the deployment before forgetting the row, so the port is free', async () => {
    calls.length = 0
    const { runtime, store } = await runtimeWith()
    await runtime.remove('a')
    expect(calls.some(script => script.includes('--stop-timeout 20 stop'))).toBe(true)
    expect(calls.some(script => script.includes("profile='/root/.dsh/profiles/superagent-a'"))).toBe(true)
    expect(calls.some(script => script.includes("state='/root/.dsh/state/a'"))).toBe(true)
    expect(calls.some(script => script.includes('rm -rf -- "$profile"'))).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('does not import the deployment back on the next open', async () => {
    const store = await WorkspaceStore.open(join(await mkdtemp(join(tmpdir(), 'sar-runtime-')), 'workspaces.json'))
    const wsl = {
      available: async () => true,
      isRunning: async () => true,
      bash: async (script: string) => {
        calls.push(script)
        if (script.includes('printf %s "$HOME"')) return { code: 0, stdout: '/root', stderr: '', timedOut: false }
        if (script.includes('for f in "$HOME"/.dsh/profiles')) {
          return { code: 0, stdout: 'superagent-x\t' + String(port) + '\t/root/.dsh/state/x\n', stderr: '', timedOut: false }
        }
        if (script.includes('--stop-timeout')) return { code: 0, stdout: '', stderr: '', timedOut: false }
        return { code: 0, stdout: url + '\n', stderr: '', timedOut: false }
      },
    } as unknown as Wsl
    const runtime = new Runtime({ config: resolveConfig(undefined), store, wsl, log: quiet })

    await runtime.ensureStarted()
    expect(store.list().map(entry => entry.id)).toEqual(['x'])
    expect(store.initialized).toBe(true)

    await runtime.remove('x')
    await runtime.ensureStarted()
    expect(store.list()).toEqual([])
  })

  it('keeps the row when the deployment cannot be deleted inside WSL', async () => {
    const store = await WorkspaceStore.open(join(await mkdtemp(join(tmpdir(), 'sar-runtime-')), 'workspaces.json'))
    await store.add(workspace('a'))
    const wsl = {
      available: async () => true,
      isRunning: async () => true,
      bash: async (script: string) => {
        if (script.includes('printf %s "$HOME"')) return { code: 0, stdout: '/root', stderr: '', timedOut: false }
        if (script.includes('--stop-timeout')) return { code: 0, stdout: '', stderr: '', timedOut: false }
        if (script.includes('rm -rf')) return { code: 1, stdout: '', stderr: 'read-only file system', timedOut: false }
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      },
    } as unknown as Wsl
    const runtime = new Runtime({ config: resolveConfig(undefined), store, wsl, log: quiet })
    await expect(runtime.remove('a')).rejects.toThrow(/删除 WSL 中的文件失败/)
    expect(store.list().map(entry => entry.id)).toEqual(['a'])
  })
})
