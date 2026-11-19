/**
 * Loopback port allocation for the deployments.
 *
 * Every Superagent deployment listens on the next free port above the DeepSeek
 * Harness web port, so the first one is 3081. A removed workspace stops its
 * deployment, which frees its port for the next workspace: allocation therefore
 * always starts at the base and picks the lowest port that is neither recorded
 * in the registry nor in use on this machine.
 */
import { createServer } from 'node:net'

/** Highest port number a TCP listener may use. */
const MAX_PORT = 65_535

/**
 * Whether this machine can bind one loopback port right now.
 * @param port - the candidate port.
 * @returns true when a listener can take it.
 */
export function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * The first free port at or above the base.
 *
 * Ports recorded by a workspace are skipped even when their deployment is
 * stopped, so a restart keeps the address a person already knows. Ports that
 * another process holds are skipped too, which is what makes a removed
 * workspace's port available again.
 * @param base - first candidate.
 * @param taken - ports already assigned to a workspace.
 * @param free - availability probe; tests pass their own.
 * @returns the lowest usable port.
 * @throws when no port in the search window is free.
 */
export async function firstFreePort(
  base: number,
  taken: readonly number[],
  free: (port: number) => Promise<boolean> = portFree,
): Promise<number> {
  const last = Math.min(MAX_PORT, base + 1_000)
  for (let port = base; port <= last; port += 1) {
    if (!taken.includes(port) && await free(port)) return port
  }
  throw new Error('在 ' + String(base) + ' 到 ' + String(last) + ' 之间没有空闲端口')
}
