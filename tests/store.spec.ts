import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_STORE, parseStore, workspaceId, WorkspaceStore, type Workspace } from '../src/store.ts'

const temporary: string[] = []
afterEach(async () => {
  // Each test owns one directory under the OS temp area; nothing else is touched.
  temporary.length = 0
})

const workspace = (id: string, port = 3083): Workspace => ({
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
  provisioned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
})

describe('parseStore', () => {
  it('treats empty text as an empty registry', () => {
    expect(parseStore('')).toEqual({ ...EMPTY_STORE, workspaces: [] })
  })

  it('drops entries another version wrote', () => {
    const text = JSON.stringify({ version: 1, wslOwned: true, workspaces: [workspace('a'), { id: 3 }, null] })
    const parsed = parseStore(text)
    expect(parsed.wslOwned).toBe(true)
    expect(parsed.workspaces.map(entry => entry.id)).toEqual(['a'])
  })

  it('refuses text that is not an object', () => {
    expect(() => parseStore('[]')).toThrow(/not a JSON object/)
    expect(() => parseStore('{')).toThrow()
  })

  it('treats a file written before the flag existed as already initialized', () => {
    const text = JSON.stringify({ version: 1, wslOwned: false, workspaces: [workspace('a')] })
    expect(parseStore(text).initialized).toBe(true)
  })
})

describe('workspaceId', () => {
  it('slugs the name and keeps ids unique', () => {
    expect(workspaceId('SuperAgent Test', [])).toBe('superagent-test')
    expect(workspaceId('SuperAgent Test', ['superagent-test'])).toBe('superagent-test-2')
    expect(workspaceId('!!!', [])).toBe('workspace')
  })

  it('keeps the id short', () => {
    expect(workspaceId('a'.repeat(80), []).length).toBe(32)
  })
})

describe('WorkspaceStore', () => {
  it('round-trips through the file and keeps writes atomic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sar-store-'))
    temporary.push(dir)
    const path = join(dir, 'workspaces.json')
    const store = await WorkspaceStore.open(path)
    await store.add(workspace('a'))
    await store.setWslOwned(true)
    await store.update('a', { enabled: false })

    const reloaded = await WorkspaceStore.open(path)
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.get('a')?.enabled).toBe(false)
    expect(reloaded.wslOwned).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1)

    await reloaded.remove('a')
    expect((await WorkspaceStore.open(path)).list()).toEqual([])
  })

  it('persists the first-open flag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sar-store-'))
    temporary.push(dir)
    const path = join(dir, 'workspaces.json')
    const store = await WorkspaceStore.open(path)
    expect(store.initialized).toBe(false)
    await store.setInitialized(true)
    expect((await WorkspaceStore.open(path)).initialized).toBe(true)
  })

  it('remembers the open workspace and forgets it with the row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sar-store-'))
    temporary.push(dir)
    const path = join(dir, 'workspaces.json')
    const store = await WorkspaceStore.open(path)
    await store.add(workspace('a'))
    await store.add(workspace('b', 3082))
    await store.setLastWorkspace('b')
    expect((await WorkspaceStore.open(path)).lastWorkspaceId).toBe('b')
    await store.remove('b')
    expect((await WorkspaceStore.open(path)).lastWorkspaceId).toBeUndefined()
  })

  it('ignores a remembered id that no longer exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sar-store-'))
    temporary.push(dir)
    const path = join(dir, 'workspaces.json')
    const store = await WorkspaceStore.open(path)
    await store.add(workspace('a'))
    expect((await WorkspaceStore.open(path)).lastWorkspaceId).toBeUndefined()
  })

  it('reports an unknown id instead of inventing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sar-store-'))
    temporary.push(dir)
    const store = await WorkspaceStore.open(join(dir, 'workspaces.json'))
    await expect(store.update('missing', { enabled: true })).rejects.toThrow(/does not exist/)
  })
})
