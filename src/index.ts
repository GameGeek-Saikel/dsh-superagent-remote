/**
 * Host half of @gamegeek-saikel/dsh-superagent-remote.
 *
 * It owns three things: the WSL2 distribution that hosts the deployments, one
 * DSH profile per workspace, and the reverse proxy that puts a deployment's
 * management API in front of the browser half. The distribution is started lazily
 * (when the panel asks) and, by default, terminated when the process that started
 * it exits.
 *
 * @module @gamegeek-saikel/dsh-superagent-remote
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, type RemoteConfig } from './config.ts'
import { PREFIX, routes } from './routes.ts'
import { Runtime } from './runtime.ts'
import { WorkspaceStore } from './store.ts'
import { Wsl } from './wsl.ts'

export type * from './types.ts'
export type { RemoteConfig } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'superagent-remote'
/** The plugin serves its own HTTP prefix, so it mounts once the web server exists. */
export const inject = ['webServer']

/**
 * Resolve the DeepSeek Harness home the same way the harness does.
 * @returns the absolute home path.
 */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/**
 * Mount the host half: load the workspace registry, register the HTTP prefix, and
 * stop the deployments when this plugin unloads.
 * @param ctx - host context.
 * @param config - plugin row configuration; every field is optional.
 */
export async function apply(ctx: Context, config?: RemoteConfig): Promise<void> {
  const resolved = resolveConfig(config)
  const store = await WorkspaceStore.open(WorkspaceStore.location(dshHome()))
  const log = ctx.logger('superagent-remote')
  const runtime = new Runtime({ config: resolved, store, wsl: new Wsl(resolved), log })
  const [route] = routes(runtime, () => ctx.webServer.port, resolved.trustedHosts)
  if (route === undefined) throw new Error('superagent-remote: no route was built')
  ctx.effect(() => ctx.webServer.register(route), 'superagent-remote: ' + PREFIX + ' routes')
  // Cleanup belongs to the whole process, not to this plugin row: a client reload or
  // a plugin reload must not stop the deployments or end the distribution.
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    runtime.shutdown()
  }
  process.once('exit', stop)
  ctx.effect(() => () => {
    process.removeListener('exit', stop)
  }, 'superagent-remote: exit hook')
}
