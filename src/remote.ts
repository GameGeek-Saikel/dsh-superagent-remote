/**
 * Client of one deployment's management API.
 *
 * The API listens on the deployment's loopback port inside the distribution.
 * Mirrored networking makes that address reachable from Windows unchanged,
 * and the host accepts the request when it carries the same-origin marker
 * header and a Host that names its own loopback authority; a server-side fetch
 * derives Host from the URL, so only the marker is set here.
 */

/** Status used when the deployment did not answer at all. */
export const UNREACHABLE = 0

/** A refusal or an unreachable deployment, distinguished by status. */
export class RemoteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RemoteError'
  }

  /** True when nothing answered, rather than the deployment refusing. */
  get unreachable(): boolean {
    return this.status === UNREACHABLE
  }
}

/** How long one management request may take. */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Call one management route on a deployment.
 * @param port - loopback port inside the distribution.
 * @param method - HTTP verb the route expects.
 * @param path - route below /orchestrator/api, without a leading slash.
 * @param body - JSON body for the verbs that take one.
 * @param timeoutMs - request timeout.
 * @returns the parsed JSON answer.
 * @throws RemoteError when nothing answered, or when the route refused.
 */
export async function api<T>(port: number, method: string, path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const url = 'http://127.0.0.1:' + String(port) + '/orchestrator/api/' + path
  const headers: Record<string, string> = { 'x-orchestrator-request': '1' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      ...body !== undefined ? { body: JSON.stringify(body) } : {},
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'did not answer'
    throw new RemoteError('dsh-superagent on port ' + String(port) + ' ' + reason, UNREACHABLE)
  }
  const text = await response.text()
  let value: unknown
  try {
    value = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    value = undefined
  }
  if (!response.ok) {
    const record = (value ?? {}) as { error?: unknown }
    const message = typeof record.error === 'string' && record.error.length > 0
      ? record.error
      : 'the deployment refused the request with status ' + String(response.status)
    throw new RemoteError(message, response.status)
  }
  if (value === undefined) throw new RemoteError('the deployment answered with text that is not JSON', response.status)
  return value as T
}

/**
 * Read one management route.
 * @param port - loopback port inside the distribution.
 * @param path - route below /orchestrator/api.
 * @param timeoutMs - request timeout.
 * @returns the parsed JSON answer.
 */
export function apiGet<T>(port: number, path: string, timeoutMs?: number): Promise<T> {
  return api<T>(port, 'GET', path, undefined, timeoutMs)
}

/** Health entry of one deployment part, as GET state reports it. */
export interface HealthEntry {
  state: 'starting' | 'ready' | 'paused' | 'error'
  detail: string
  at?: string
}

/** The subset of GET state this plugin reads. */
export interface DeploymentState {
  setup?: {
    machine?: { stateDir?: string }
    problem?: { place?: string; code?: string; detail?: string } | null
    feishuProblem?: { place?: string; code?: string; detail?: string } | null
    accounts?: { repository?: string; agent?: string } | null
  }
  load?: { running?: number; queued?: number; maxWorkers?: number }
  masterId?: string
  paused?: boolean
  health?: Record<string, HealthEntry>
}
