/**
 * GitHub side of the chat page, through the GitHub CLI.
 *
 * dsh-superagent has no message endpoint: a person asks for work on a Source,
 * and with GitHub that Source is an issue thread. The chat page therefore reads
 * and writes issue threads with the operator's own CLI, exactly as the GitHub
 * Source reads them, and the deployment replies in the same thread.
 */
import { run, type RunResult } from './exec.ts'

/** How long one CLI call may take. */
const GH_TIMEOUT_MS = 60_000

/** A refusal or failure from the GitHub CLI, with the message a person can act on. */
export class GhError extends Error {
  constructor(message: string, readonly code: number) {
    super(message)
    this.name = 'GhError'
  }
}

function failure(result: RunResult, args: readonly string[]): GhError {
  const text = (result.stderr || result.stdout).trim().split(/\r?\n/).filter(Boolean)
  const last = text.at(-1) ?? (result.timedOut ? 'the command timed out' : 'gh exited with code ' + String(result.code))
  return new GhError(last.length > 300 ? last.slice(0, 300) + '...' : last, result.code)
}

/**
 * Run one GitHub CLI call with a JSON answer.
 * @param args - gh arguments.
 * @param input - text for standard input, when the call reads a body file from it.
 * @returns the parsed answer.
 * @throws GhError when gh refused or failed.
 */
async function ghJson<T>(args: readonly string[], input?: string): Promise<T> {
  const result = await run('gh', args, { timeoutMs: GH_TIMEOUT_MS, ...input !== undefined ? { input } : {} })
  if (result.code !== 0) throw failure(result, args)
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    throw new GhError('gh answered with text that is not JSON', 0)
  }
}

/**
 * Run one GitHub CLI call whose answer is plain text.
 * @param args - gh arguments.
 * @param input - text for standard input.
 * @returns trimmed standard output.
 * @throws GhError when gh refused or failed.
 */
async function ghText(args: readonly string[], input?: string): Promise<string> {
  const result = await run('gh', args, { timeoutMs: GH_TIMEOUT_MS, ...input !== undefined ? { input } : {} })
  if (result.code !== 0) throw failure(result, args)
  return result.stdout.trim()
}

/** One issue in the chat list. */
export interface IssueSummary {
  number: number
  title: string
  state: string
  updatedAt: string
  url: string
  /** First part of the body, enough to recognize the conversation marker. */
  body?: string
}

/** One comment on an issue, as gh reports it. */
export interface IssueComment {
  id: string
  author: { login: string } | null
  body: string
  createdAt: string
  url?: string
}

/** One issue with its comments. */
export interface IssueDetail {
  number: number
  title: string
  state: string
  body: string
  author: { login: string } | null
  createdAt: string
  url: string
  comments: IssueComment[]
}

/**
 * Strip the markers dsh-superagent writes for machines and people.
 *
 * GitHub renders an HTML comment invisibly and the agent hides its machine
 * metadata in one, so a conversation view drops every comment: the agent's
 * metadata, this plugin's own thread marker, and the introduction the plugin
 * writes beside it. The upstream GitHub Source removes the same parts before it
 * reads a message, which is why the content matches what people see on GitHub.
 * @param text - raw issue or comment body.
 * @returns the body a person wrote or read.
 */
export function cleanBody(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*This is by an automated agent, not a human\.\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Build an issue title from a message, as the local chat entry does.
 * @param text - the operator's message.
 * @returns one line, at most 70 characters.
 */
export function issueTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return 'request'
  return flat.length > 70 ? flat.slice(0, 70) : flat
}

/** The GitHub CLI as the operator's own account, which is the person side of a chat. */
export const github = {
  /**
   * The signed-in account.
   * @returns the login, or undefined when gh is not signed in.
   */
  async login(): Promise<string | undefined> {
    try {
      const text = await ghText(['api', 'user', '--jq', '.login'])
      return text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  },

  /**
   * Recent issue threads of one repository.
   * @param repository - owner/name.
   * @param limit - how many to read.
   * @returns the issues, newest first.
   */
  async issues(repository: string, limit = 40): Promise<IssueSummary[]> {
    const items = await ghJson<IssueSummary[]>(['issue', 'list', '--repo', repository, '--state', 'all',
      '--limit', String(limit), '--json', 'number,title,state,updatedAt,url,body'])
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  },

  /**
   * One issue thread with its comments.
   * @param repository - owner/name.
   * @param number - issue number.
   * @returns the issue as gh reports it.
   */
  async issue(repository: string, number: number): Promise<IssueDetail> {
    return ghJson<IssueDetail>(['issue', 'view', String(number), '--repo', repository,
      '--json', 'number,title,state,body,author,createdAt,url,comments'])
  },

  /**
   * Comment on an existing thread.
   * @param repository - owner/name.
   * @param number - issue number.
   * @param body - comment text.
   * @returns the issue number the comment landed on.
   */
  async comment(repository: string, number: number, body: string): Promise<number> {
    await ghText(['issue', 'comment', String(number), '--repo', repository, '--body-file', '-'], body)
    return number
  },

  /**
   * Open a new thread.
   * @param repository - owner/name.
   * @param title - issue title.
   * @param body - issue body.
   * @returns the new issue number, or undefined when gh did not print a URL.
   */
  async create(repository: string, title: string, body: string): Promise<number | undefined> {
    const out = await ghText(['issue', 'create', '--repo', repository, '--title', title, '--body-file', '-'], body)
    const match = /\/issues\/(\d+)/.exec(out)
    return match?.[1] !== undefined ? Number(match[1]) : undefined
  },
}
