/**
 * The one conversation of a workspace.
 *
 * Upstream, a Feishu deployment gives each chat one thread that keeps receiving
 * messages; a GitHub deployment gives each issue its own thread. This plugin
 * keeps the Feishu shape: one issue per workspace is the conversation, every
 * message is a comment on it, and the agent answers in the same place. The
 * issue's number lives in the workspace record and is also written into the
 * issue body as a hidden marker, so a lost record finds the conversation again
 * instead of opening a second one.
 */
import { cleanBody, github, type IssueDetail } from './github.ts'
import { apiGet, type DeploymentState } from './remote.ts'
import type { ChatMessage, ChatState, ChatView, MessageRole } from './types.ts'

/** Hidden marker that names the conversation issue. */
export const MAIN_THREAD_MARKER = '<!-- dsh-superagent-remote:chat -->'

/** Line the plugin writes under the marker, so a person reading GitHub knows what the issue holds. */
export const MAIN_THREAD_INTRO = '这个线程是这个工作区与 Superagent 的唯一对话，每条消息都是这里的一条评论。'

interface TicketRow {
  id: string
  title: string
  stage: 'person' | 'working' | 'idle' | 'ended'
  threads?: { key: string }[]
}

interface TicketPage { items: TicketRow[] }

/** Anything that names the threads a ticket follows. */
export interface Threaded { threads?: { key: string }[] }

/** Issue number a ticket belongs to, from its first GitHub thread key. */
export function issueOf(ticket: Threaded): number | undefined {
  for (const thread of ticket.threads ?? []) {
    const match = /^github:(\d+)$/.exec(thread.key)
    if (match?.[1] !== undefined) return Number(match[1])
  }
  return undefined
}

/**
 * Turn one issue thread into the messages the conversation shows.
 *
 * The agent writes machine metadata as HTML comments and discloses itself with a
 * fixed line; the GitHub Source removes both before it reads a message, so this
 * view does too.
 * @param issue - the thread as the GitHub CLI reported it.
 * @param operator - the signed-in operator account, used when GitHub reports no author.
 * @param agentLogin - the deployment's agent account.
 * @returns the messages, oldest first.
 */
export function messagesOf(issue: IssueDetail, operator: string, agentLogin: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  const author = issue.author?.login ?? operator
  const role = roleOf(author, agentLogin, operator)
  const body = spoken(withoutIntro(cleanBody(issue.body ?? '')), role, agentLogin)
  if (body.length > 0) {
    messages.push({ id: 'issue-' + String(issue.number), author, role, body,
      at: issue.createdAt, ...issue.url.length > 0 ? { url: issue.url } : {} })
  }
  for (const comment of issue.comments ?? []) {
    const commentAuthor = comment.author?.login ?? 'unknown'
    const commentRole = roleOf(commentAuthor, agentLogin, operator)
    const text = spoken(cleanBody(comment.body), commentRole, agentLogin)
    if (text.length === 0) continue
    messages.push({ id: comment.id, author: commentAuthor, role: commentRole, body: text,
      at: comment.createdAt, ...comment.url !== undefined ? { url: comment.url } : {} })
  }
  return messages
}

/** Drop the introduction the plugin writes beside the thread marker. */
export function withoutIntro(text: string): string {
  return text.startsWith(MAIN_THREAD_INTRO) ? text.slice(MAIN_THREAD_INTRO.length).trim() : text
}

/**
 * What one message says to a person, without the address the transport needed.
 *
 * The plugin prepends the agent mention so the GitHub Source takes a message;
 * the mention is an address, not something the author wrote. Other writers keep
 * their text as written, including any mention they choose to type.
 * @param text - the body after machine markers are gone.
 * @param role - who wrote it.
 * @param agentLogin - the agent account the plugin addresses.
 * @returns the words the message shows.
 */
export function spoken(text: string, role: MessageRole, agentLogin: string): string {
  if (role !== 'operator' || agentLogin.length === 0) return text
  const escaped = agentLogin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp('^@' + escaped + '[\\s,，:：]*', 'i'), '').trim()
}

/**
 * Classify a message author.
 * @param author - GitHub login that wrote it.
 * @param agentLogin - the deployment's agent account.
 * @param operator - the signed-in operator account.
 * @returns the role the view renders.
 */
export function roleOf(author: string, agentLogin: string, operator: string): MessageRole {
  const name = author.toLowerCase()
  if (agentLogin.length > 0 && name === agentLogin.toLowerCase()) return 'agent'
  if (operator.length > 0 && name === operator.toLowerCase()) return 'operator'
  return 'other'
}

/**
 * Pick the conversation issue out of a repository's issues.
 * @param issues - issues as the CLI listed them.
 * @param recorded - the number the workspace record holds, when it has one.
 * @returns the recorded number, the one carrying the marker, or undefined.
 */
export function markedThread(
  issues: readonly { number: number; body?: string }[],
  recorded?: number,
): number | undefined {
  if (recorded !== undefined) return recorded
  const marked = issues.find(issue => (issue.body ?? '').includes(MAIN_THREAD_MARKER))
  return marked?.number
}

/**
 * The conversation's issue number.
 * @param workspace - repository, port, and the recorded thread if any.
 * @param operator - the signed-in operator account.
 * @returns the thread number, or undefined when the workspace has none yet.
 */
export async function findMainThread(
  workspace: { repository: string; chatThread?: number },
  operator: string,
): Promise<number | undefined> {
  if (workspace.chatThread !== undefined) return workspace.chatThread
  try {
    return markedThread(await github.issues(workspace.repository, 50))
  } catch {
    // Without a readable repository the conversation simply has not started yet.
    void operator
    return undefined
  }
}

/**
 * The conversation, read from GitHub.
 * @param workspace - repository, port, and the recorded thread if any.
 * @param operator - the signed-in operator account.
 * @param agentLogin - the deployment's agent account.
 * @returns the thread, its messages, and what the deployment is doing.
 */
export async function mainChat(
  workspace: { repository: string; port: number; chatThread?: number },
  operator: string,
  agentLogin: string,
): Promise<ChatView> {
  const thread = await findMainThread(workspace, operator)
  if (thread === undefined) return { thread: null, messages: [], agentLogin, operator, state: 'idle' }
  const [issue, info] = await Promise.all([
    github.issue(workspace.repository, thread),
    threadInfo(workspace.port, thread),
  ])
  return { thread, messages: messagesOf(issue, operator, agentLogin), agentLogin, operator, state: info.state,
    ...info.repliesIn === undefined ? {} : { repliesIn: info.repliesIn } }
}

/**
 * What the deployment is doing on one thread.
 * @param port - the deployment's loopback port.
 * @param thread - the issue number.
 * @returns working while a ticket runs, person when a ticket waits for a person, else idle.
 */
/**
 * Where the deployment will write its answer, when that is not this thread.
 *
 * A message on a thread an open ticket already owns is delivered to that ticket,
 * and a result is written to the conversation the ticket started on.
 * @param ticket - the open ticket that owns the thread.
 * @param thread - the issue number the person wrote on.
 * @returns the issue number the answer will appear under, or undefined when it is the same thread.
 */
export function replyRoom(ticket: Threaded, thread: number): number | undefined {
  const origin = issueOf(ticket)
  return origin !== undefined && origin !== thread ? origin : undefined
}

/**
 * What the conversation should show for one ticket and the deployment's load.
 *
 * A ticket waiting for a person can still have a worker running: the stage
 * describes what the Orchestrator waits for, not whether an Executor is busy.
 * The load count is therefore the authority on "working": it is what makes the
 * running whale appear while the deployment is executing.
 * @param stage - the open ticket's stage, when it has one.
 * @param running - Executor sessions currently running.
 * @returns the state the conversation renders.
 */
export function chatStateOf(stage: TicketRow['stage'] | undefined, running: number): ChatState {
  if (running > 0) return 'working'
  if (stage === 'person') return 'person'
  if (stage === 'working') return 'working'
  return 'idle'
}

async function threadInfo(port: number, thread: number): Promise<{ state: ChatState; repliesIn?: number }> {
  try {
    const [page, deployment] = await Promise.all([
      apiGet<TicketPage>(port, 'tickets?state=open&limit=100', 5_000),
      apiGet<DeploymentState>(port, 'state', 5_000).catch(() => undefined),
    ])
    const ticket = (page.items ?? []).find(row => (row.threads ?? []).some(item => item.key === 'github:' + String(thread)))
    const running = deployment?.load?.running ?? 0
    const state = chatStateOf(ticket?.stage, running)
    const repliesIn = ticket === undefined ? undefined : replyRoom(ticket, thread)
    return repliesIn === undefined ? { state } : { state, repliesIn }
  } catch {
    return { state: 'idle' }
  }
}

/**
 * Send one message as a person, addressing the agent so the deployment takes it.
 *
 * The mention is added when the message does not already name the agent, because
 * the GitHub Source accepts a message only when it addresses the agent.
 * @param workspace - repository and the recorded thread if any.
 * @param operator - the signed-in operator account.
 * @param agentLogin - the deployment's agent account; empty skips the mention.
 * @param text - what the operator wrote.
 * @returns the thread the message landed on, and whether this created it.
 */
export async function sendMain(
  workspace: { repository: string; chatThread?: number },
  operator: string,
  agentLogin: string,
  text: string,
): Promise<{ thread: number; created: boolean }> {
  const mention = agentLogin.length > 0 && !text.includes('@' + agentLogin) ? '@' + agentLogin + ' ' : ''
  const body = mention + text
  const existing = await findMainThread(workspace, operator)
  if (existing !== undefined) {
    await github.comment(workspace.repository, existing, body)
    return { thread: existing, created: false }
  }
  // The thread's body carries only the marker and the introduction; the message
  // goes into the first comment. A body is read once, when the issue is created,
  // so a message written there is lost whenever that one event is missed; a
  // comment is the same event every later message arrives as, which the Source
  // reads by cursor rather than by notification timing.
  const intro = MAIN_THREAD_MARKER + '\n\n' + MAIN_THREAD_INTRO
  const number = await github.create(workspace.repository, 'Superagent 对话', intro)
  if (number === undefined) throw new Error('GitHub 没有返回新 issue 的编号')
  await github.comment(workspace.repository, number, body)
  return { thread: number, created: true }
}
