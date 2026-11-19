/** Browser-side client of the plugin's own JSON API. */
import type { ChatView, RuntimeView, WorkspaceView } from '../types.ts'

/** Prefix the host half serves. */
const BASE = '/superagent-remote/api'

/** One discovery row, as GET /api/discovery answers. */
export interface DiscoveryRow {
  profile: string
  port?: number
  stateDir?: string
  /** True when a workspace already names this profile. */
  adopted: boolean
  repository?: string
}

/**
 * Call one route of the plugin API.
 * @param path - route below /superagent-remote/api.
 * @param init - method, body, and other fetch options.
 * @returns the parsed JSON answer.
 * @throws when the host refused; the message is the host's own, in the operator's language.
 */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(BASE + path, { headers: { 'content-type': 'application/json' }, ...init })
  } catch {
    throw new Error('无法连接到 DeepSeek Harness 的 superagent-remote 路由')
  }
  const text = await response.text()
  let value: unknown = undefined
  try {
    value = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new Error('superagent-remote answered with text that is not JSON')
  }
  if (!response.ok) {
    const record = (value ?? {}) as { error?: unknown }
    throw new Error(typeof record.error === 'string' && record.error.length > 0
      ? record.error
      : '请求失败（' + String(response.status) + '）')
  }
  return value as T
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

/** Every route the shell calls. */
export const panelApi = {
  /** The whole runtime snapshot. */
  runtime: (): Promise<RuntimeView> => call<RuntimeView>('/runtime'),
  /** Start WSL and every enabled workspace, then answer the snapshot. */
  start: (): Promise<RuntimeView> => call<RuntimeView>('/runtime/start', { method: 'POST', body: '{}' }),
  /** Deployments already running inside WSL. */
  discovery: (): Promise<{ items: DiscoveryRow[] }> => call<{ items: DiscoveryRow[] }>('/discovery'),
  /** Create a workspace and provision its deployment. */
  create: (body: { name: string; repository: string; agentLogin: string; agentCli?: string }): Promise<WorkspaceView> =>
    call<WorkspaceView>('/workspaces', json(body)),
  /** Change the fields a person may change. */
  update: (id: string, body: { name?: string; enabled?: boolean; pinned?: boolean; archived?: boolean }): Promise<WorkspaceView> =>
    call<WorkspaceView>('/workspaces/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(body) }),
  /** Forget a workspace. */
  remove: (id: string): Promise<{ removed: boolean }> =>
    call<{ removed: boolean }>('/workspaces/' + encodeURIComponent(id), { method: 'DELETE' }),
  /** Start one deployment. */
  startWorkspace: (id: string): Promise<WorkspaceView> =>
    call<WorkspaceView>('/workspaces/' + encodeURIComponent(id) + '/start', { method: 'POST', body: '{}' }),
  /** Stop one deployment. */
  stopWorkspace: (id: string): Promise<WorkspaceView> =>
    call<WorkspaceView>('/workspaces/' + encodeURIComponent(id) + '/stop', { method: 'POST', body: '{}' }),
  /** Restart one deployment in the background. */
  restartWorkspace: (id: string): Promise<{ restarting: true }> =>
    call<{ restarting: true }>('/workspaces/' + encodeURIComponent(id) + '/restart', { method: 'POST', body: '{}' }),
  /** Register a deployment the machine already runs. */
  adopt: (profile: string, port?: number): Promise<WorkspaceView> =>
    call<WorkspaceView>('/adopt', json({ profile, ...port !== undefined ? { port } : {} })),
  /** Remember the workspace the panel is showing, for the next open. */
  activate: (id: string): Promise<{ lastWorkspace: string }> =>
    call<{ lastWorkspace: string }>('/active', json({ id })),
  /**
   * The deployment's current Executor load.
   *
   * The conversation needs the running count to show the official running mark
   * even while the ticket it belongs to waits for a person. This reads the
   * deployment's own state through the same proxy the panel uses, so an older
   * host half still answers accurately.
   * @param id - workspace id.
   * @returns the number of Executor sessions running.
   */
  load: async (id: string): Promise<number> => {
    const response = await fetch('/superagent-remote/' + encodeURIComponent(id) + '/orchestrator/api/state',
      { headers: { 'x-orchestrator-request': '1' }, cache: 'no-store' })
    if (!response.ok) throw new Error('状态读取失败（' + String(response.status) + '）')
    const value = await response.json() as { load?: { running?: unknown } }
    const running = value.load?.running
    return typeof running === 'number' && Number.isFinite(running) ? running : 0
  },
  /** The workspace's one conversation. */
  chat: (id: string): Promise<ChatView> =>
    call<ChatView>('/workspaces/' + encodeURIComponent(id) + '/chat'),
  /** Send one message into the conversation, opening it when this is the first. */
  send: (id: string, text: string): Promise<{ thread: number }> =>
    call<{ thread: number }>('/workspaces/' + encodeURIComponent(id) + '/chat', json({ text })),
  /** The authenticated address of the workspace's own DSH web UI. */
  ui: (id: string): Promise<{ url: string }> =>
    call<{ url: string }>('/workspaces/' + encodeURIComponent(id) + '/ui'),
}
