import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CLI, resolveConfig } from '../src/config.ts'
import { dshHome } from '../src/index.ts'

describe('resolveConfig', () => {
  it('defaults to the layout the runbook documents', () => {
    expect(resolveConfig(undefined)).toEqual({
      distro: 'Ubuntu-22.04',
      wslUser: 'root',
      checkout: '/root/dsh-superagent',
      agentCli: DEFAULT_AGENT_CLI,
      portBase: 3081,
      terminateWslOnExit: 'owned',
      trustedHosts: [],
      autoImport: true,
    })
  })

  it('trims a trailing slash from the checkout', () => {
    expect(resolveConfig({ checkout: '/root/sa//' }).checkout).toBe('/root/sa')
  })

  it('rejects values the bridge cannot use', () => {
    expect(() => resolveConfig({ distro: 'Ubuntu 22' })).toThrow(/distribution name/)
    expect(() => resolveConfig({ wslUser: 'Root User' })).toThrow(/Linux user name/)
    expect(() => resolveConfig({ checkout: 'relative/path' })).toThrow(/absolute Linux path/)
    expect(() => resolveConfig({ portBase: 80 })).toThrow(/between 1024 and 65000/)
    expect(() => resolveConfig({ terminateWslOnExit: 'sometimes' as never })).toThrow(/owned, always, or never/)
    expect(() => resolveConfig({ trustedHosts: ['http://bad'] })).toThrow(/host or host:port/)
  })
})

describe('dshHome', () => {
  it('prefers DSH_HOME and ignores a blank value', () => {
    const previous = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = 'C:/custom/home'
      expect(dshHome()).toBe('C:/custom/home')
      process.env.DSH_HOME = '   '
      expect(dshHome()).not.toBe('   ')
      expect(dshHome().endsWith('.dsh')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
