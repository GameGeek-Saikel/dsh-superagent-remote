/**
 * Plugin configuration with the defaults this machine needs.
 *
 * Every field is optional in `cordis.patch.yml`; the values below match the
 * layout that docs/002-runbook.md describes, so an operator who follows that
 * document configures nothing here.
 */

/** What the plugin row may set in `cordis.patch.yml`. */
export interface RemoteConfig {
  /** WSL2 distribution that hosts the deployments. */
  distro?: string
  /** User inside the distribution that owns the DSH profiles and their state. */
  wslUser?: string
  /** Checkout of dsh-superagent inside the distribution. */
  checkout?: string
  /** Agent GitHub CLI wrapper inside the distribution, used for a new workspace. */
  agentCli?: string
  /** First port offered to a new workspace. */
  portBase?: number
  /** Whether closing DeepSeek Harness terminates the distribution. */
  terminateWslOnExit?: 'owned' | 'always' | 'never'
  /** Authorities other than loopback that may call the plugin API, such as `192.168.1.5:3080`. */
  trustedHosts?: string[]
  /** Whether a running deployment found in WSL becomes a workspace without being imported by hand. */
  autoImport?: boolean
}

/** Configuration with every field present. */
export interface ResolvedConfig {
  distro: string
  wslUser: string
  checkout: string
  agentCli: string
  portBase: number
  terminateWslOnExit: 'owned' | 'always' | 'never'
  /** Authorities this deployment serves in addition to loopback. */
  trustedHosts: string[]
  autoImport: boolean
}

/** Default agent CLI wrapper; docs/006-deployment.md of the upstream repository creates it. */
export const DEFAULT_AGENT_CLI = '/root/.local/bin/gh-agent'

const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ABSOLUTE = /^\/[A-Za-z0-9._\/-]+$/

/**
 * Validate and default the plugin configuration.
 * @param config - values from the plugin row, possibly empty.
 * @returns every field resolved, with defaults applied.
 * @throws when a value cannot be used, naming the field so the log identifies it.
 */
export function resolveConfig(config: RemoteConfig | undefined): ResolvedConfig {
  const distro = config?.distro ?? 'Ubuntu-22.04'
  if (!DISTRO.test(distro)) throw new Error(`superagent-remote: distro "${distro}" is not a WSL distribution name`)
  const wslUser = config?.wslUser ?? 'root'
  if (!/^[a-z_][a-z0-9_-]*$/.test(wslUser)) throw new Error(`superagent-remote: wslUser "${wslUser}" is not a Linux user name`)
  const checkout = (config?.checkout ?? '/root/dsh-superagent').replace(/\/+$/, '')
  if (!ABSOLUTE.test(checkout)) throw new Error(`superagent-remote: checkout "${checkout}" must be an absolute Linux path`)
  const agentCli = config?.agentCli ?? DEFAULT_AGENT_CLI
  if (!ABSOLUTE.test(agentCli)) throw new Error(`superagent-remote: agentCli "${agentCli}" must be an absolute Linux path`)
  const portBase = config?.portBase ?? 3081
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65_000) {
    throw new Error(`superagent-remote: portBase "${String(portBase)}" must be an integer between 1024 and 65000`)
  }
  const terminateWslOnExit = config?.terminateWslOnExit ?? 'owned'
  if (!['owned', 'always', 'never'].includes(terminateWslOnExit)) {
    throw new Error(`superagent-remote: terminateWslOnExit "${String(terminateWslOnExit)}" must be owned, always, or never`)
  }
  const trustedHosts = config?.trustedHosts ?? []
  for (const authority of trustedHosts) {
    if (!/^[A-Za-z0-9.[\]:-]+$/.test(authority)) throw new Error(`superagent-remote: trustedHosts entry "${authority}" is not a host or host:port`)
  }
  const autoImport = config?.autoImport ?? true
  if (typeof autoImport !== 'boolean') throw new Error('superagent-remote: autoImport must be true or false')
  return { distro, wslUser, checkout, agentCli, portBase, terminateWslOnExit, trustedHosts, autoImport }
}
