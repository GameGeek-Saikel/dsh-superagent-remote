/**
 * Child-process helpers for the two programs the host drives: wsl.exe and
 * gh. Both helpers resolve with the exit code instead of rejecting, because a
 * non-zero code is an answer this plugin reports, not an exception it throws.
 */
import { spawn, spawnSync } from 'node:child_process'

/** How one child process is run. */
export interface RunOptions {
  /** Wall-clock limit; the child is killed when it passes. Defaults to 60 s. */
  timeoutMs?: number
  cwd?: string
  /** Text written to the child's standard input before it is closed. */
  input?: string
  env?: NodeJS.ProcessEnv
  /** Cap on collected output. Defaults to 4 MiB. */
  maxBytes?: number
}

/** What a child process answered. */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** True when the timeout killed the child. */
  timedOut: boolean
  /** Spawn failure such as a missing program; code is -1 then. */
  failure?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BYTES = 4 << 20
/** Output beyond the cap keeps only its tail, which is the part a person reads. */
const KEEP_BYTES = 64 << 10

interface Count { bytes: number }

/** Append one chunk, dropping the oldest output once the cap is passed. */
function append(chunks: Buffer[], chunk: Buffer, count: Count, maxBytes: number): void {
  chunks.push(chunk)
  count.bytes += chunk.length
  while (count.bytes > maxBytes && chunks.length > 1) {
    const dropped = chunks.shift()
    count.bytes -= dropped?.length ?? 0
  }
  const first = chunks[0]
  if (chunks.length === 1 && first !== undefined && first.length > KEEP_BYTES) {
    chunks[0] = first.subarray(first.length - KEEP_BYTES)
    count.bytes = KEEP_BYTES
  }
}

const collect = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8')

/**
 * Run one program and resolve with its answer.
 * @param file - executable to run, resolved through PATH.
 * @param args - arguments, passed without a shell.
 * @param options - timeout, input, and output cap.
 * @returns the exit code and captured streams; never rejects for a non-zero exit.
 */
export function run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  return new Promise(resolve => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const outCount: Count = { bytes: 0 }
    const errCount: Count = { bytes: 0 }
    let timedOut = false
    let failure: string | undefined
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk: Buffer) => append(out, chunk, outCount, maxBytes))
    child.stderr.on('data', (chunk: Buffer) => append(err, chunk, errCount, maxBytes))
    child.on('error', error => {
      failure = error.message
      clearTimeout(timer)
      resolve({ code: -1, stdout: collect(out), stderr: collect(err), timedOut, failure })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: collect(out), stderr: collect(err), timedOut, ...failure !== undefined ? { failure } : {} })
    })
    child.stdin.end(options.input ?? '')
  })
}

/**
 * Run one program to completion on the calling thread. Shutdown uses this so the
 * cleanup finishes even when the process is on its way out.
 * @param file - executable to run.
 * @param args - arguments, passed without a shell.
 * @param options - timeout and output cap.
 * @returns the exit code and captured streams.
 */
export function runSync(file: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(file, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBytes ?? DEFAULT_MAX_BYTES,
  })
  const timedOut = result.signal === 'SIGTERM' || result.error?.message.includes('ETIMEDOUT') === true
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
    ...result.error !== undefined && result.status === null ? { failure: result.error.message } : {},
  }
}

/**
 * Run one program and capture raw bytes, for output that is not UTF-8.
 * @param file - executable to run.
 * @param args - arguments, passed without a shell.
 * @param options - timeout.
 * @returns the exit code and the raw streams.
 */
export function runRaw(file: string, args: readonly string[], options: RunOptions = {}): Promise<{ code: number; stdout: Buffer; stderr: Buffer; failure?: string }> {
  return new Promise(resolve => {
    const child = spawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    timer.unref?.()
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err), failure: error.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
    })
  })
}
