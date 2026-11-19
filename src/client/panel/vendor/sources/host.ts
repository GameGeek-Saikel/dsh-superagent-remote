/**
 * Trimmed copy of the upstream sources/host.ts.
 *
 * The panel reads health entries and renders their state; the host and context
 * interfaces in the upstream file reach the store, the source registry, and the
 * command runner, none of which the browser half may import. This copy keeps the
 * health vocabulary and drops the rest.
 */

/** Fixed English health templates (with {name} placeholders); the panel localizes each code in the interface language. */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuCliUnset: 'The Source is on, and its bot lark-cli is not set',
  feishuBotMissing: 'Waiting for the Feishu bot',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const

export type HealthCode = keyof typeof HEALTH_TEXT

export type Health = {
  state: 'starting' | 'ready' | 'paused' | 'error'
  detail: string
  at?: string
  code?: HealthCode
  values?: Record<string, string>
}

/** Fill the placeholders of a health template. */
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '')

export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length > 0 ? { values } : {} }
}
