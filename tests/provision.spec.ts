import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../src/config.ts'
import { deleteDeployment, ensureCheckout, startService } from '../src/provision.ts'
import type { Workspace } from '../src/store.ts'
import type { Wsl } from '../src/wsl.ts'

/** Capture the script the service start would run. */
async function commandOf(): Promise<string> {
  let script = ''
  const wsl = { bash: async (value: string) => { script = value; return { code: 0, stdout: '', stderr: '' } } } as unknown as Wsl
  const config = { checkout: '/root/dsh-superagent' } as unknown as ResolvedConfig
  const workspace = { profile: 'superagent', port: 3082 } as unknown as Workspace
  await startService(wsl, config, workspace)
  return script
}

describe('installing the upstream checkout', () => {
  const config = { checkout: '/root/dsh-superagent' } as unknown as ResolvedConfig

  it('clones when the checkout is missing, then applies the Node-name edit', async () => {
    const calls: string[] = []
    const steps: string[] = []
    const wsl = {
      bash: async (script: string) => {
        calls.push(script)
        if (script.startsWith('test -d')) return { code: 1, stdout: '', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    } as unknown as Wsl
    await ensureCheckout(wsl, config, message => { steps.push(message) })
    expect(steps.some(message => message.includes('克隆'))).toBe(true)
    expect(calls.some(script => script.includes('git clone'))).toBe(true)
    expect(calls.some(script => script.includes("startswith('node')"))).toBe(true)
    expect(calls.some(script => script.includes('pnpm'))).toBe(false)
  })

  it('reuses an existing checkout and still applies the Node-name edit', async () => {
    const calls: string[] = []
    const wsl = {
      bash: async (script: string) => { calls.push(script); return { code: 0, stdout: '', stderr: '' } },
    } as unknown as Wsl
    await ensureCheckout(wsl, config, () => {})
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain('test -d')
    expect(calls[1]).toContain('.dsh-superagent-remote-setup')
    expect(calls[2]).toContain("startswith('node')")
  })

  it('runs pnpm install and pnpm build once', async () => {
    let setup = false
    const calls: string[] = []
    const wsl = {
      bash: async (script: string) => {
        calls.push(script)
        if (script.includes(': >')) { setup = true; return { code: 0, stdout: '', stderr: '' } }
        if (script.startsWith('test -d')) return { code: 0, stdout: '', stderr: '' }
        if (script.includes('.dsh-superagent-remote-setup')) return { code: setup ? 0 : 1, stdout: '', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    } as unknown as Wsl
    await ensureCheckout(wsl, config, () => {})
    expect(calls.some(script => script.endsWith('pnpm install'))).toBe(true)
    expect(calls.some(script => script.endsWith('pnpm build'))).toBe(true)
    expect(setup).toBe(true)
  })
})

describe('deleting a deployment', () => {
  const workspace = {
    profile: 'superagent', stateDir: '/root/.dsh/state/superagent',
  } as unknown as Workspace

  it('removes the profile, state, lock, and session directories', async () => {
    let script = ''
    const wsl = {
      bash: async (value: string) => {
        if (value.includes('printf %s "$HOME"')) return { code: 0, stdout: '/root', stderr: '' }
        script = value
        return { code: 0, stdout: '', stderr: '' }
      },
    } as unknown as Wsl
    await deleteDeployment(wsl, workspace)
    expect(script).toContain("profile='/root/.dsh/profiles/superagent'")
    expect(script).toContain("state='/root/.dsh/state/superagent'")
    expect(script).toContain('rm -rf -- "$profile"')
    expect(script).toContain('rm -rf -- "$state"')
    expect(script).toContain('sessions/--$slug--')
    expect(script).toContain('$state.lock')
  })

  it('refuses a state directory outside the plugin state root', async () => {
    const wsl = {
      bash: async () => ({ code: 0, stdout: '/root', stderr: '' }),
    } as unknown as Wsl
    await expect(deleteDeployment(wsl, { ...workspace, stateDir: '/root/elsewhere' } as Workspace))
      .rejects.toThrow(/拒绝删除/)
  })
})

describe('starting a deployment', () => {
  it('accepts a first start that is only waiting for setup', async () => {
    const wsl = { bash: async () => ({ code: 1, stdout: 'dsh-superagent is waiting for setup: repositoryUnset', stderr: '' }) } as unknown as Wsl
    const config = { checkout: '/root/dsh-superagent' } as unknown as ResolvedConfig
    const workspace = { profile: 'superagent', port: 3082 } as unknown as Workspace
    await expect(startService(wsl, config, workspace)).resolves.toBeUndefined()
  })

  it('reports a start that failed for another reason', async () => {
    const wsl = { bash: async () => ({ code: 1, stdout: '', stderr: 'tmux: command not found' }) } as unknown as Wsl
    const config = { checkout: '/root/dsh-superagent' } as unknown as ResolvedConfig
    const workspace = { profile: 'superagent', port: 3082 } as unknown as Workspace
    await expect(startService(wsl, config, workspace)).resolves.toContain('tmux')
  })

  it('lets the GitHub API bypass the operator proxy while git keeps the proxy', async () => {
    const script = await commandOf()
    expect(script).toContain('no_proxy="api.github.com,codeload.github.com')
    expect(script).toContain('NO_PROXY="api.github.com,codeload.github.com')
    // github.com carries git: a direct request dies mid-TLS where the network interferes with it.
    expect(script).not.toContain('no_proxy="github.com,')
    expect(script).not.toContain('NO_PROXY="github.com,')
    // The bypass has to exist in tmux's own environment too: a long-lived server
    // hands its environment to every session it starts.
    expect(script).toContain('tmux set-environment -g no_proxy')
    expect(script).toContain('tmux set-environment -g NO_PROXY')
    expect(script).toContain('python3 scripts/dsh-superagent --profile')
  })
})
