/**
 * WSL2 bridge: distribution state, command execution, and lifecycle.
 *
 * Windows reaches a listener on 127.0.0.1 inside the distribution directly
 * because the machine runs WSL in mirrored networking mode; docs/002-runbook.md
 * records that requirement. Commands run as the configured user, which owns the
 * DSH profiles and their state.
 */
import type { ResolvedConfig } from './config.ts'
import { run, runRaw, runSync, type RunResult } from './exec.ts'

/** How long a distribution may take to answer its first command. */
const BOOT_TIMEOUT_MS = 180_000
/** How long one arbitrary command inside the distribution may take. */
const COMMAND_TIMEOUT_MS = 60_000

/**
 * Decode wsl.exe's own console output.
 *
 * wsl.exe writes its messages as UTF-16LE while a Linux program's output passes
 * through as UTF-8 bytes, so the list commands need both decoders. A NUL in the
 * second byte is the UTF-16LE signature for ASCII text.
 * @param bytes - raw standard output.
 * @returns one entry per non-empty line.
 */
export function decodeWslList(bytes: Buffer): string[] {
  const bom = bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE
  const utf16 = bom || (bytes.length >= 2 && bytes[1] === 0)
  const text = utf16 ? bytes.toString('utf16le') : bytes.toString('utf8')
  return text
    .replace(/\uFEFF/g, '')
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Name one line of a failed command, so a person has something to act on.
 * @param result - the command result.
 * @returns the failure in one line, or undefined when the command succeeded.
 */
export function explain(result: RunResult): string | undefined {
  if (result.code === 0) return undefined
  if (result.failure !== undefined) return result.failure
  if (result.timedOut) return 'the command timed out'
  const lines = (result.stderr || result.stdout).trim().split(/\r?\n/).filter(Boolean)
  const last = lines.at(-1) ?? 'exit code ' + String(result.code)
  return last.length > 300 ? last.slice(0, 300) + '...' : last
}

/** Commands this plugin runs inside the configured distribution. */
export class Wsl {
  constructor(private readonly config: ResolvedConfig) {}

  private base(): string[] {
    return ['-d', this.config.distro, '-u', this.config.wslUser, '--']
  }

  /** Whether wsl.exe exists and answers on this machine. */
  async available(): Promise<boolean> {
    const result = await run('wsl.exe', ['--version'], { timeoutMs: 15_000 })
    return result.code === 0
  }

  /** Distributions that are running right now. */
  async runningDistros(): Promise<string[]> {
    const result = await runRaw('wsl.exe', ['--list', '--running', '--quiet'], { timeoutMs: 20_000 })
    return result.code === 0 ? decodeWslList(result.stdout) : []
  }

  /**
   * Distributions that are running right now, read on the calling thread, for shutdown.
   * @returns the names.
   */
  runningDistrosSync(): string[] {
    const result = runSync('wsl.exe', ['--list', '--running', '--quiet'], { timeoutMs: 20_000 })
    return result.code === 0 ? decodeWslList(Buffer.from(result.stdout, 'utf8')) : []
  }

  /** Whether the configured distribution is running. */
  async isRunning(): Promise<boolean> {
    const names = await this.runningDistros()
    return names.some(name => name.toLowerCase() === this.config.distro.toLowerCase())
  }

  /**
   * Start the distribution without running anything in it.
   * @returns the command result; a failure explains why the distribution did not start.
   */
  async boot(): Promise<RunResult> {
    return run('wsl.exe', [...this.base(), 'true'], { timeoutMs: BOOT_TIMEOUT_MS })
  }

  /**
   * Run one program inside the distribution.
   * @param argv - program and arguments, passed without a shell.
   * @param options - timeout override, and text for the program's standard input.
   * @returns the exit code and captured streams.
   */
  async exec(argv: readonly string[], options: { timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
    return run('wsl.exe', [...this.base(), ...argv], {
      timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      ...options.input !== undefined ? { input: options.input } : {},
    })
  }

  /**
   * Run a shell script inside the distribution, for the steps that need pipes.
   *
   * The script arrives on standard input, not as an argument: wsl.exe re-parses
   * its command line and drops the quoting of an argument that contains spaces or
   * quotes, which silently turns a quoted script into a different one.
   * @param script - the script text, read by bash -s.
   * @param options - timeout override.
   * @returns the exit code and captured streams.
   */
  async bash(script: string, options: { timeoutMs?: number } = {}): Promise<RunResult> {
    return this.exec(['bash', '-s'], { ...options, input: script })
  }

  /**
   * Run a shell script inside the distribution on the calling thread, for shutdown.
   * @param script - the script text, read by bash -s.
   * @param timeoutMs - wall-clock limit.
   * @returns the exit code and captured streams.
   */
  bashSync(script: string, timeoutMs: number): RunResult {
    return runSync('wsl.exe', [...this.base(), 'bash', '-s'], { timeoutMs, input: script })
  }

  /** Shut the distribution down, ending every process in it including the deployments. */
  terminate(): RunResult {
    return runSync('wsl.exe', ['--terminate', this.config.distro], { timeoutMs: 60_000 })
  }
}
