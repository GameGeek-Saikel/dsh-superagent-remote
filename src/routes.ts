/**
 * HTTP surface of the plugin.
 *
 * One prefix route serves everything below /superagent-remote: the JSON API the
 * panel shell reads, and the reverse proxy that puts the vendored dsh-superagent
 * panel in front of one deployment's /orchestrator/api.
 *
 * Requests must come from this machine. The browser half runs on the DeepSeek
 * Harness origin, so a same-origin check is enough, and it keeps a page loaded
 * from somewhere else on the machine from driving the deployments.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { mainChat, sendMain } from './chat.ts'
import type { Runtime } from './runtime.ts'
import type { ChatView, CreateWorkspaceRequest, UpdateWorkspaceRequest } from './types.ts'

/** Prefix every route of this plugin shares. */
export const PREFIX = '/superagent-remote'
/** Largest request body accepted, matching the upstream management API. */
const MAX_BODY_BYTES = 256 * 1024

/** A refusal a person can act on, answered as 400. */
class Refused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refused'
  }
}

/** Any loopback authority, for the moment before the web server reports its port. */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/

/**
 * Read a JSON request body.
 * @param req - the request.
 * @returns the parsed body, or an empty object when there is none.
 */
async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Refused('the request body is larger than ' + String(MAX_BODY_BYTES) + ' bytes')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new Refused('the request body is not a JSON object')
  }
}

function answer(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/**
 * Whether a request comes from the DeepSeek Harness page on this machine.
 * @param req - the request.
 * @param port - the DeepSeek Harness web port, once the server reports it.
 * @returns true when the Host names this machine and any Origin matches it.
 */
export function trusted(req: Pick<IncomingMessage, 'headers'>, port: number | undefined,
  trustedHosts: readonly string[] = []): boolean {
  const host = req.headers.host ?? ''
  const expected = port === undefined ? [] : ['127.0.0.1:' + String(port), 'localhost:' + String(port)]
  const configured = trustedHosts.some(authority => authority === host || (!authority.includes(':') && host.startsWith(authority + ':')))
  if (!configured && (expected.length > 0 ? !expected.includes(host) : !LOOPBACK.test(host))) return false
  const origin = req.headers.origin
  return origin === undefined || origin === 'http://' + host
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Refused('the request needs a non-empty ' + field)
  return value.trim()
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Refused('a port must be a whole number')
  return parsed
}

interface Match { id?: string; rest?: string }

/** A workspace as the conversation needs it: the repository, its port, and the recorded thread. */
export interface ConversationWorkspace {
  repository: string
  port: number
  chatThread?: number
}

/**
 * The GitHub-backed conversation.
 *
 * It is a parameter rather than two direct calls so the routes can be tested
 * without a repository: tests/*.spec.ts runs without a signed-in gh.
 */
export interface ChatApi {
  /** Read one workspace's conversation. */
  read: (workspace: ConversationWorkspace, operator: string, agentLogin: string) => Promise<ChatView>
  /** Send one message, mentioning the agent when the text does not. */
  send: (workspace: ConversationWorkspace, operator: string, agentLogin: string, text: string)
    => Promise<{ thread: number; created: boolean }>
}

/**
 * Match one path against a pattern of literal segments and :parameters.
 * @param pattern - segments, some starting with a colon.
 * @param segments - request path segments.
 * @returns the captured parameters, or undefined when the path does not fit.
 */
function match(pattern: string[], segments: string[]): Match | undefined {
  if (pattern.length !== segments.length) return undefined
  const captured: Match = {}
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index] ?? ''
    if (part.startsWith(':')) {
      const name = part.slice(1) as 'id' | 'rest'
      capture(captured, name, decodeURIComponent(segment))
    } else if (part !== segment) {
      return undefined
    }
  }
  return captured
}

function capture(target: Match, name: 'id' | 'rest', value: string): void {
  target[name] = value
}

/**
 * The plugin's routes.
 * @param runtime - the workspace runtime.
 * @param port - the DeepSeek Harness web port, for the same-origin check.
 * @param trustedHosts - extra authorities the same-origin check accepts.
 * @param conversation - the GitHub-backed conversation; tests pass their own.
 * @returns the one prefix route to register.
 */
export function routes(runtime: Runtime, port: () => number | undefined, trustedHosts: readonly string[] = [],
  conversation: ChatApi = { read: mainChat, send: sendMain }): WebRoute[] {
  return [{
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      if (!trusted(req, port(), trustedHosts)) {
        answer(res, 403, { error: 'this API answers the DeepSeek Harness page on this machine only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const segments = url.pathname.slice(PREFIX.length).split('/').filter(part => part.length > 0)
      const method = req.method ?? 'GET'
      try {
        // Proxy: /<workspace>/orchestrator/api/<route>
        if (segments.length >= 4 && segments[1] === 'orchestrator' && segments[2] === 'api') {
          const id = decodeURIComponent(segments[0] ?? '')
          const rest = segments.slice(3).join('/') + (url.search.length > 0 ? url.search : '')
          const body = method === 'GET' || method === 'HEAD' ? undefined : await rawBody(req)
          const forwarded = await runtime.forward(id, method, rest, body)
          res.writeHead(forwarded.status, { 'content-type': forwarded.type, 'cache-control': 'no-store' })
          res.end(forwarded.text)
          return
        }

        if (method === 'GET' && match(['api', 'runtime'], segments) !== undefined) {
          answer(res, 200, await runtime.snapshot())
          return
        }
        if (method === 'POST' && match(['api', 'runtime', 'start'], segments) !== undefined) {
          await bodyOf(req)
          // The first start may provision or boot for minutes; the panel reads the
          // snapshot at once and follows the work through its polling instead.
          runtime.beginStart()
          answer(res, 200, await runtime.snapshot())
          return
        }
        if (method === 'POST' && match(['api', 'active'], segments) !== undefined) {
          const body = await bodyOf(req)
          const id = text(body.id, 'id')
          await runtime.setActive(id)
          answer(res, 200, { lastWorkspace: id })
          return
        }
        if (method === 'GET' && match(['api', 'discovery'], segments) !== undefined) {
          answer(res, 200, { items: await runtime.discovery() })
          return
        }
        if (method === 'POST' && match(['api', 'adopt'], segments) !== undefined) {
          const body = await bodyOf(req)
          const workspace = await runtime.adopt(text(body.profile, 'profile'), optionalNumber(body.port))
          answer(res, 200, workspace)
          return
        }
        if (method === 'POST' && match(['api', 'workspaces'], segments) !== undefined) {
          const body = await bodyOf(req)
          const request: CreateWorkspaceRequest = {
            name: text(body.name, 'name'),
            repository: text(body.repository, 'repository'),
            agentLogin: text(body.agentLogin, 'agentLogin'),
            ...typeof body.profile === 'string' && body.profile.trim().length > 0 ? { profile: body.profile.trim() } : {},
            ...optionalNumber(body.port) !== undefined ? { port: optionalNumber(body.port) as number } : {},
            ...typeof body.agentCli === 'string' && body.agentCli.trim().length > 0 ? { agentCli: body.agentCli.trim() } : {},
          }
          answer(res, 200, await runtime.create(request))
          return
        }
        const workspaceRoute = match(['api', 'workspaces', ':id'], segments)
        if (workspaceRoute?.id !== undefined) {
          const id = workspaceRoute.id
          if (method === 'PATCH') {
            const body = await bodyOf(req)
            const patch: UpdateWorkspaceRequest = {
              ...typeof body.name === 'string' ? { name: body.name } : {},
              ...typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {},
              ...typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {},
              ...typeof body.archived === 'boolean' ? { archived: body.archived } : {},
            }
            answer(res, 200, await runtime.update(id, patch))
            return
          }
          if (method === 'DELETE') {
            await runtime.remove(id)
            answer(res, 200, { removed: true })
            return
          }
        }
        // The conversation is matched before the generic workspace action: both
        // patterns are four segments long, so the more specific one has to win.
        const chatRoute = match(['api', 'workspaces', ':id', 'chat'], segments)
        if (chatRoute?.id !== undefined) {
          const workspace = runtime.workspaceFor(chatRoute.id)
          const operator = await runtime.operator()
          if (method === 'GET') {
            answer(res, 200, await conversation.read(workspace, operator, workspace.agentLogin))
            return
          }
          if (method === 'POST') {
            const body = await bodyOf(req)
            const sent = await conversation.send(workspace, operator, workspace.agentLogin, text(body.text, 'text'))
            if (sent.created) await runtime.rememberThread(chatRoute.id, sent.thread)
            answer(res, 200, { thread: sent.thread })
            return
          }
        }
        const uiRoute = match(['api', 'workspaces', ':id', 'ui'], segments)
        if (uiRoute?.id !== undefined && method === 'GET') {
          answer(res, 200, { url: await runtime.uiUrl(uiRoute.id) })
          return
        }
        const action = match(['api', 'workspaces', ':id', ':rest'], segments)
        if (action?.id !== undefined && method === 'POST') {
          switch (action.rest) {
            case 'start': {
              answer(res, 200, await runtime.startWorkspace(action.id))
              return
            }
            case 'stop': {
              answer(res, 200, await runtime.stopWorkspace(action.id))
              return
            }
            case 'restart': {
              runtime.restartWorkspace(action.id)
              answer(res, 200, { restarting: true })
              return
            }
            default:
              throw new Refused('unknown workspace action ' + String(action.rest))
          }
        }
        throw new Refused('unknown operation ' + method + ' ' + url.pathname)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        answer(res, error instanceof Refused ? 400 : 502, { error: message })
      }
    },
  }]
}

/**
 * Read a proxied request body as text, keeping the deployment's bytes unchanged.
 * @param req - the request.
 * @returns the body text.
 */
async function rawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Refused('the request body is larger than ' + String(MAX_BODY_BYTES) + ' bytes')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}
