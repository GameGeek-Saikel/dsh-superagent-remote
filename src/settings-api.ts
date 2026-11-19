/**
 * Write a deployment's settings through its management API.
 *
 * The upstream setup guide saves settings in this order, because a change to the
 * repository or the agent CLI re-runs the setup check and restarts the plugin:
 * the GitHub Source first, then the Policy, then the Execution block. Each save
 * carries the revision it was read at, so a concurrent panel edit is refused
 * instead of silently overwritten.
 */
import { api, apiGet, RemoteError, type DeploymentState } from './remote.ts'

/** What a workspace needs saved before it can take work. */
export interface WorkspaceSettings {
  /** owner/name on github.com. */
  repository: string
  /** Absolute path of the agent's GitHub CLI inside the distribution. */
  agentCli: string
  /** GitHub login that may ask the agent for work. */
  allowedLogin: string
  /** Absolute clone the per-ticket worktrees are cut from, inside the distribution. */
  cloneDir: string
  /** Whether to write a prepare command when the Execution block has none. */
  writePrepare: boolean
}

/** One model the deployment reports with the reasoning efforts it accepts. */
interface ModelInfo {
  id: string
  reasoning?: { efforts?: { id: string }[] }
}

/** The part of GET models this module reads. */
interface ModelCatalog {
  default: { provider: string; model: string }
  groups: { id: string; models: ModelInfo[] }[]
}

/**
 * The reasoning effort each Superagent role starts with.
 *
 * The deployment seeds its router Session (the main Session) from the `eval`
 * block and every Executor Session from the `executor` block, so a new
 * Superagent starts cheap on routing and strong on implementation.
 */
export const ROLE_EFFORTS = { main: 'low', executor: 'max' } as const

/**
 * The deployment's default model with one reasoning effort, when that model
 * offers it.
 * @param catalog - the deployment's model catalog.
 * @param effort - wanted reasoning effort, such as `low`.
 * @returns a role model for the settings block, or undefined when the default
 *   model does not expose that effort.
 */
export function roleModel(catalog: ModelCatalog, effort: string): Record<string, string> | undefined {
  const { provider, model } = catalog.default
  const found = catalog.groups.find(group => group.id === provider)?.models.find(entry => entry.id === model)
  const efforts = found?.reasoning?.efforts?.map(entry => entry.id) ?? []
  return efforts.includes(effort) ? { provider, model, reasoningEffort: effort } : undefined
}

/**
 * Fill a role's model only when the block has none, so a person's later choice
 * is never overwritten.
 * @param value - the block value.
 * @param model - the model to seed, when the catalog supports it.
 * @returns the new value, or undefined when there is nothing to change.
 */
export function seedModel(value: Record<string, unknown>, model: Record<string, string> | undefined): Record<string, unknown> | undefined {
  if (model === undefined || value.model !== null && value.model !== undefined) return undefined
  return { ...value, model }
}

/**
 * Seed the Executor model and, when needed, its prepare command in one save.
 * @param value - the executor block value.
 * @param prepare - prepare command to write when the block has none.
 * @param model - the model to seed, when the catalog supports it.
 * @returns the new value, or undefined when there is nothing to change.
 */
export function seedExecutor(value: Record<string, unknown>, prepare: string,
  model: Record<string, string> | undefined): Record<string, unknown> | undefined {
  const withModel = seedModel(value, model)
  const next = withModel ?? value
  const current = typeof next.prepare === 'string' ? next.prepare.trim() : ''
  if (prepare.length === 0 || current.length > 0) return withModel
  return { ...next, prepare }
}

/** One settings block: the whole value plus the revision a save must carry. */
interface Block { value: Record<string, unknown>; revision: number }

/** The part of GET settings this module reads. */
interface SettingsPage {
  blocks: Record<string, Block>
  sources: { id: string; kind: string; installed: boolean; value: Record<string, unknown>; revision: number }[]
}

interface SaveAnswer { revision: number; restarting: boolean }

/** How long a restarted deployment may take to answer again. */
const RESTART_TIMEOUT_MS = 180_000

/**
 * Wait until a deployment answers its state route again.
 * @param port - the deployment's loopback port.
 * @returns the state it answered.
 * @throws when it does not answer within the timeout.
 */
export async function waitReady(port: number): Promise<DeploymentState> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS
  let last = 'the deployment did not answer'
  while (Date.now() < deadline) {
    try {
      const state = await apiGet<DeploymentState>(port, 'state', 4_000)
      const runtime = state.health?.runtime?.state
      if (runtime === 'ready' || runtime === 'paused') return state
      last = 'runtime is ' + String(runtime ?? 'unreported')
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 1_500))
  }
  throw new Error('the deployment did not become ready: ' + last)
}

/**
 * Save one block and wait out the restart it may cause.
 * @param port - the deployment's loopback port.
 * @param block - block name, such as source:github.
 * @param value - the whole new block value.
 * @param revision - the revision the value was read at.
 */
async function save(port: number, block: string, value: Record<string, unknown>, revision: number): Promise<void> {
  const answer = await api<SaveAnswer>(port, 'PUT', 'settings/' + block, { value, revision }, 60_000)
  if (answer.restarting) await waitReady(port)
}

/**
 * Save one block, rereading once when another writer changed it first.
 * @param port - the deployment's loopback port.
 * @param block - block name.
 * @param edit - receives the current value and returns the value to save, or undefined to leave it alone.
 * @returns true when a save happened.
 */
async function saveEditing(
  port: number,
  block: string,
  edit: (value: Record<string, unknown>) => Record<string, unknown> | undefined,
  read: () => Promise<{ value: Record<string, unknown>; revision: number }>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await read()
    const next = edit(current.value)
    if (next === undefined) return false
    try {
      await save(port, block, next, current.revision)
      return true
    } catch (error) {
      if (!(error instanceof RemoteError) || error.status !== 409 || attempt === 1) throw error
    }
  }
  return false
}

/**
 * The prepare command that gives each ticket a worktree of the clone.
 * @param cloneDir - absolute clone path inside the distribution.
 * @returns the two-command shell text the Execution block stores.
 */
export function prepareCommand(cloneDir: string): string {
  return [
    'git -C ' + cloneDir + ' fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" ' +
      '"${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"',
    'git -C ' + cloneDir + ' worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" ' +
      '"refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"',
  ].join(' && ')
}

/** Read the settings page once. */
const readSettings = (port: number): Promise<SettingsPage> => apiGet<SettingsPage>(port, 'settings', 10_000)

/**
 * Ensure one login may ask the agent for work.
 * @param value - the Policy block value.
 * @param login - GitHub login to allow.
 * @returns the new value, or undefined when the login is already allowed.
 */
export function allowLogin(value: Record<string, unknown>, login: string): Record<string, unknown> | undefined {
  const sources = (value.sources ?? {}) as Record<string, unknown>
  const part = (sources.github ?? {}) as Record<string, unknown>
  const allowed = Array.isArray(part.allowed) ? part.allowed as { id?: unknown }[] : []
  const present = allowed.some(entry => typeof entry.id === 'string' && entry.id.toLowerCase() === login.toLowerCase())
  if (present) return undefined
  return { ...value, sources: { ...sources, github: { ...part, allowed: [...allowed, { id: login }] } } }
}

/**
 * Point the GitHub Source at a repository and an agent CLI, and have it watch the
 * repository's Issues and comments.
 *
 * The conversation is written as issue bodies and comments, so delivery must not
 * depend on a mention notification: GitHub may deliver one after the polling
 * cursor has already passed the message's timestamp, and the Source then drops
 * the message without an error. The two observation switches make the Source
 * read the repository itself, which is what it does for a deployment that was
 * set up by hand for a chat.
 * @param value - the Source block value.
 * @param repository - owner/name.
 * @param agentCli - absolute CLI path.
 * @returns the new value, or undefined when every field already matches.
 */
export function pointSource(value: Record<string, unknown>, repository: string, agentCli: string): Record<string, unknown> | undefined {
  const config = (value.config ?? {}) as Record<string, unknown>
  const enabled = value.enabled === true
  const watching = config.observeIssues === true && config.observeComments === true
  if (enabled && watching && config.repository === repository && config.cli === agentCli) return undefined
  return { ...value, enabled: true,
    config: { ...config, repository, cli: agentCli, observeIssues: true, observeComments: true } }
}

/**
 * Save the three blocks that make a workspace usable.
 * @param port - the deployment's loopback port.
 * @param settings - repository, agent CLI, allowed login, clone, and whether to write a prepare command.
 */
export async function applySettings(port: number, settings: WorkspaceSettings): Promise<void> {
  await waitReady(port)

  const source = async () => {
    const page = await readSettings(port)
    const found = page.sources.find(entry => entry.id === 'github')
    if (found === undefined) throw new Error('the deployment does not install the GitHub Source')
    return { value: found.value, revision: found.revision }
  }
  await saveEditing(port, 'source:github', value => pointSource(value, settings.repository, settings.agentCli), source)

  const policy = async () => {
    const page = await readSettings(port)
    const block = page.blocks.policy
    if (block === undefined) throw new Error('the deployment has no policy block')
    return block
  }
  await saveEditing(port, 'policy', value => allowLogin(value, settings.allowedLogin), policy)

  const catalog = await apiGet<ModelCatalog>(port, 'models', 10_000)
  const mainModel = roleModel(catalog, ROLE_EFFORTS.main)
  const workerModel = roleModel(catalog, ROLE_EFFORTS.executor)

  const evalBlock = async () => {
    const page = await readSettings(port)
    const block = page.blocks.eval
    if (block === undefined) throw new Error('the deployment has no eval block')
    return block
  }
  await saveEditing(port, 'eval', value => seedModel(value, mainModel), evalBlock)

  const executor = async () => {
    const page = await readSettings(port)
    const block = page.blocks.executor
    if (block === undefined) throw new Error('the deployment has no executor block')
    return block
  }
  await saveEditing(port, 'executor',
    value => seedExecutor(value, settings.writePrepare ? prepareCommand(settings.cloneDir) : '', workerModel), executor)
}
