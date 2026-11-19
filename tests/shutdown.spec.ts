import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig, type ResolvedConfig } from '../src/config.ts'
import { adoptable, Runtime, type Log } from '../src/runtime.ts'
import { WorkspaceStore, type Workspace } from '../src/store.ts'
import type { Wsl } from '../src/wsl.ts'

const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} }

const workspace = (id: string, enabled = true): Workspace => ({
  id,
  name: id,
  repository: 'owner/repo',
  agentLogin: 'agent',
  profile: 'superagent-' + id,
  port: 3083,
  stateDir: '/root/.dsh/state/' + id,
  agentCli: '/root/.local/bin/gh-agent',
  enabled,
  adopted: false,
  provisioned: true,
  createdAt: '2026-01-01T00:00:00.000Z',
})

/** One runtime over a fake bridge that records what shutdown asked the machine to do. */
async function harness(policy: ResolvedConfig['terminateWslOnExit'], running: boolean, owned: boolean) {
  const calls: string[] = []
  const wsl = {
    available: async () => true,
    isRunning: async () => running,
    runningDistrosSync: () => running ? ['Ubuntu-22.04'] : [],
    bashSync: (_script: string) => { calls.push('stop'); return { code: 0, stdout: '', stderr: '', timedOut: false } },
    terminate: () => { calls.push('terminate'); return { code: 0, stdout: '', stderr: '', timedOut: false } },
  } as unknown as Wsl
  const store = await WorkspaceStore.open(join(await mkdtemp(join(tmpdir(), 'sar-shutdown-')), 'workspaces.json'))
  await store.add(workspace('a'))
  await store.add(workspace('b', false))
  await store.setWslOwned(owned)
  const config = { ...resolveConfig(undefined), terminateWslOnExit: policy }
  return { calls, runtime: new Runtime({ config, store, wsl, log: quiet }) }
}

describe('shutdown', () => {
  it('stops enabled deployments but keeps a distribution it did not start', async () => {
    const { calls, runtime } = await harness('owned', true, false)
    runtime.shutdown()
    expect(calls).toEqual(['stop'])
  })

  it('terminates the distribution it started', async () => {
    const { calls, runtime } = await harness('owned', true, true)
    runtime.shutdown()
    expect(calls).toEqual(['stop', 'terminate'])
  })

  it('honours always and never', async () => {
    const always = await harness('always', true, false)
    always.runtime.shutdown()
    expect(always.calls).toEqual(['stop', 'terminate'])

    const never = await harness('never', true, true)
    never.runtime.shutdown()
    expect(never.calls).toEqual(['stop'])
  })

  it('touches nothing when the distribution is already stopped', async () => {
    const { calls, runtime } = await harness('always', false, true)
    runtime.shutdown()
    expect(calls).toEqual([])
  })
})
describe('adoptable', () => {
  it('keeps only running, unregistered deployments with a known repository', () => {
    const items = [
      { profile: 'a', port: 3082, repository: 'owner/a', adopted: false },
      { profile: 'b', port: undefined, repository: 'owner/b', adopted: false },
      { profile: 'c', port: 3084, repository: undefined, adopted: false },
      { profile: 'd', port: 3085, repository: 'owner/d', adopted: true },
    ]
    expect(adoptable(items).map(item => item.profile)).toEqual(['a'])
  })

  it('accepts nothing when the machine reports nothing', () => {
    expect(adoptable([])).toEqual([])
  })
})

