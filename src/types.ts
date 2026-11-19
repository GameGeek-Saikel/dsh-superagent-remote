/**
 * Wire types shared by the host half and the browser half.
 *
 * The host serializes them as JSON over `/superagent-remote/api`; the browser
 * half reads them. They describe the plugin's own model — a workspace, its
 * runtime health, and a chat thread — not the dsh-superagent management API,
 * which the vendored panel speaks through the reverse proxy.
 */

/** Where one workspace's deployment stands right now. */
export type RunPhase = 'stopped' | 'booting' | 'starting' | 'ready' | 'error'

/** Health of one workspace's service, as the panel renders it. */
export interface WorkspaceHealth {
  /** Lifecycle phase; `ready` also requires a healthy management API. */
  phase: RunPhase
  /** One sentence for a person: what is happening, or what to fix. */
  detail?: string
  /** dsh-superagent's processing pause switch. */
  paused?: boolean
  /** A setup problem the deployment reports, such as a signed-out agent CLI. */
  setup?: { code: string; detail: string; place?: string }
  /** When the phase was last observed (ISO 8601). */
  at?: string
}

/** A provisioning or start/stop job, so a slow step reports progress instead of a stalled request. */
export interface TaskView {
  kind: 'provision' | 'start' | 'stop' | 'restart'
  /** The step now running, in the operator's language where the host knows it. */
  step: string
  startedAt: string
  finishedAt?: string
  /** Set when the job failed; `step` then names the step that failed. */
  error?: string
  /** Bounded tail of the command output, newest last. */
  log: string[]
}

/** One workspace: one GitHub repository and the dsh-superagent deployment that serves it. */
export interface WorkspaceView {
  id: string
  name: string
  /** `owner/name` on github.com. */
  repository: string
  /** The GitHub account the agent acts as. */
  agentLogin: string
  /** DSH profile inside the distribution that boots the deployment. */
  profile: string
  /** Loopback port the deployment serves on inside WSL, reachable from Windows through mirrored networking. */
  port: number
  /** Absolute state directory inside the distribution. */
  stateDir: string
  /** Absolute path of the agent's GitHub CLI wrapper inside the distribution. */
  agentCli: string
  enabled: boolean
  /** Whether the row is pinned to the top of the pane. */
  pinned: boolean
  /** Whether the row is archived, and so hidden by default. */
  archived: boolean
  /** Whether the profile predates this plugin and was adopted rather than provisioned. */
  adopted: boolean
  /** Whether the deployment's DSH profile loads dsh-superagent. */
  provisioned: boolean
  /** Proxy base the vendored panel appends `/api` to. */
  basePath: string
  health: WorkspaceHealth
  task?: TaskView
}

/** What the WSL bridge believes about the distribution. */
export interface WslView {
  distro: string
  running: boolean
  /** True when this plugin started the distribution and therefore terminates it on exit. */
  owned: boolean
  available: boolean
  error?: string
}

/** The runtime snapshot the panel polls while it is open. */
export interface RuntimeView {
  wsl: WslView
  workspaces: WorkspaceView[]
  /** Workspace that was open when the panel last closed; the panel starts there. */
  lastWorkspace?: string
  /** Operator account used to write to GitHub as a person; empty when `gh` is not signed in. */
  operator: string
  /** Resolved checkout of the upstream dsh-superagent repository inside the distribution. */
  checkout: string
}

/** Fields a person fills in to create a workspace. */
export interface CreateWorkspaceRequest {
  name: string
  repository: string
  agentLogin: string
  profile?: string
  port?: number
  agentCli?: string
}

/** Fields a person may change after creation. Everything else needs a new workspace. */
export interface UpdateWorkspaceRequest {
  name?: string
  enabled?: boolean
  pinned?: boolean
  archived?: boolean
}

/** Who wrote one message, from the reader's point of view. */
export type MessageRole = 'operator' | 'agent' | 'other'

/** One message of the conversation. */
export interface ChatMessage {
  id: string
  author: string
  role: MessageRole
  body: string
  at: string
  url?: string
}

/** What the deployment is doing on the conversation. */
export type ChatState = 'idle' | 'working' | 'person'

/** The conversation of one workspace: its issue thread, the messages, and the agent's state. */
export interface ChatView {
  /** Issue number of the conversation, or null before the first message. */
  thread: number | null
  messages: ChatMessage[]
  /** Account the composer mentions; empty when the deployment reports no agent account. */
  agentLogin: string
  /** Signed-in operator account; empty when gh is not signed in. */
  operator: string
  state: ChatState
  /**
   * The issue where the deployment will answer, when that is not this thread.
   *
   * A message on a thread that an open ticket already owns is delivered to that
   * ticket, and the ticket's result is written to the conversation it started on,
   * so the answer appears under a different issue number.
   */
  repliesIn?: number
}
