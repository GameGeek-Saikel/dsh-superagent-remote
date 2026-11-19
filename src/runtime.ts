/**
 * The runtime: workspace registry plus the WSL2 and service lifecycles.
 *
 * Every slow operation runs as a task, so the panel polls one snapshot and sees
 * which step is running instead of waiting on a request that may take minutes.
 * Health is read from each deployment's management API, which is also the
 * authority on whether a workspace can take work.
 */
import type { ResolvedConfig } from './config.ts'
import { github } from './github.ts'
import {
  checkoutPresent, deleteDeployment, discover, ensureCheckout, homeOf, provision, startService, stopService,
  stateDirFor, type Step,
} from './provision.ts'
import { apiGet, UNREACHABLE, type DeploymentState } from './remote.ts'
import { workspaceId, type Workspace, type WorkspaceStore } from './store.ts'
import { firstFreePort, portFree } from './ports.ts'
import type {
  CreateWorkspaceRequest, RuntimeView, TaskView, UpdateWorkspaceRequest, WorkspaceHealth, WorkspaceView, WslView,
} from './types.ts'
import { explain, type Wsl } from './wsl.ts'

/** What the plugin logs through. */
export interface Log {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** How long one health reading stays fresh. */
const HEALTH_TTL_MS = 1_500
/** How long the operator login is cached. */
const OPERATOR_TTL_MS = 60_000
/** How long a workspace stop may wait for running Executor Sessions, in seconds. */
const STOP_TIMEOUT_SECONDS = 20
/** Upper bound for the shutdown cleanup inside the distribution. */
const SHUTDOWN_TIMEOUT_MS = 60_000
/** Largest session log the panel moves across the boundary, in bytes. */
const MAX_LOG_BYTES = 2_500_000

/** Quote one value for a shell script. */
const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const PROFILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/**
 * The deployments a first open may register on its own.
 * @param items - what the machine reports.
 * @returns the running, unregistered deployments whose repository is known.
 */
export function adoptable<T extends { adopted: boolean; port?: number; repository?: string }>(items: readonly T[]): T[] {
  return items.filter(item => !item.adopted && item.port !== undefined && item.repository !== undefined)
}

/** Reduce a deployment's state to the health a workspace view carries. */
export function healthOf(state: DeploymentState): WorkspaceHealth {
  const runtime = state.health?.runtime
  const problem = state.setup?.problem
  const phase: WorkspaceHealth['phase'] = runtime?.state === 'ready' || runtime?.state === 'paused'
    ? 'ready'
    : runtime?.state === 'starting' || runtime === undefined ? 'starting' : 'error'
  return {
    phase,
    ...runtime?.detail !== undefined ? { detail: runtime.detail } : {},
    ...state.paused !== undefined ? { paused: state.paused } : {},
    ...problem !== null && problem !== undefined
      ? { setup: { code: problem.code ?? 'problem', detail: problem.detail ?? '', ...problem.place !== undefined ? { place: problem.place } : {} } }
      : {},
    at: new Date().toISOString(),
  }
}

/** One deployment as its management API answered. */
export interface RuntimeDeps {
  config: ResolvedConfig
  store: WorkspaceStore
  wsl: Wsl
  log: Log
}

/** A collection of workspaces and the processes that serve them. */
export class Runtime {
  private readonly health = new Map<string, { at: number; value: WorkspaceHealth }>()
  private readonly tasks = new Map<string, TaskView>()
  private operatorCache: { at: number; value: string } = { at: 0, value: '' }
  private available: boolean | undefined
  private wslCache: { at: number; value: WslView } | undefined
  private starting: Promise<void> | undefined

  constructor(private readonly deps: RuntimeDeps) {}

  private get config(): ResolvedConfig {
    return this.deps.config
  }

  private get store(): WorkspaceStore {
    return this.deps.store
  }

  /**
   * Whether wsl.exe answers on this machine, probed once.
   * @returns the answer.
   */
  async wslAvailable(): Promise<boolean> {
    if (this.available === undefined) this.available = await this.deps.wsl.available()
    return this.available
  }

  /**
   * The distribution's state, cached for a moment because every panel poll asks.
   * @returns the cached view.
   */
  async wslView(): Promise<WslView> {
    const hit = this.wslCache
    if (hit !== undefined && Date.now() - hit.at < 1_000) return hit.value
    const available = await this.wslAvailable()
    let running = false
    let error: string | undefined
    if (available) {
      running = await this.deps.wsl.isRunning()
    } else {
      error = '在这台机器上找不到 wsl.exe'
    }
    const value: WslView = {
      distro: this.config.distro,
      running,
      owned: this.store.wslOwned,
      available,
      ...error !== undefined ? { error } : {},
    }
    this.wslCache = { at: Date.now(), value }
    return value
  }

  /**
   * The operator's GitHub account, which is the person side of a chat.
   * @returns the login, or an empty string when gh is not signed in.
   */
  async operator(): Promise<string> {
    if (Date.now() - this.operatorCache.at < OPERATOR_TTL_MS) return this.operatorCache.value
    const value = (await github.login()) ?? ''
    this.operatorCache = { at: Date.now(), value }
    return value
  }

  /**
   * Read one deployment's health, cached for a moment.
   * @param workspace - the workspace to probe.
   * @returns its health.
   */
  private async probe(workspace: Workspace): Promise<WorkspaceHealth> {
    const hit = this.health.get(workspace.id)
    if (hit !== undefined && Date.now() - hit.at < HEALTH_TTL_MS) return hit.value
    let value: WorkspaceHealth
    try {
      value = healthOf(await apiGet<DeploymentState>(workspace.port, 'state', 3_000))
    } catch (error) {
      const unreachable = error instanceof Error && 'status' in error && (error as { status?: number }).status === UNREACHABLE
      value = {
        phase: unreachable ? 'stopped' : 'error',
        detail: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      }
    }
    this.health.set(workspace.id, { at: Date.now(), value })
    return value
  }

  /** Public health reading for the chat routes. */
  healthOfWorkspace(workspace: Workspace): Promise<WorkspaceHealth> {
    return this.probe(workspace)
  }

  /**
   * Render one workspace.
   * @param workspace - the stored workspace.
   * @param wsl - the distribution view of this snapshot.
   * @returns the workspace as the panel reads it.
   */
  private async view(workspace: Workspace, wsl: WslView): Promise<WorkspaceView> {
    const health = wsl.running
      ? await this.probe(workspace)
      : { phase: 'stopped' as const, detail: 'WSL 发行版未运行', at: new Date().toISOString() }
    const task = this.tasks.get(workspace.id)
    return {
      id: workspace.id,
      name: workspace.name,
      repository: workspace.repository,
      agentLogin: workspace.agentLogin,
      profile: workspace.profile,
      port: workspace.port,
      stateDir: workspace.stateDir,
      agentCli: workspace.agentCli,
      enabled: workspace.enabled,
      pinned: workspace.pinned === true,
      archived: workspace.archived === true,
      adopted: workspace.adopted,
      provisioned: workspace.provisioned,
      basePath: '/superagent-remote/' + workspace.id + '/orchestrator',
      health,
      ...task !== undefined ? { task } : {},
    }
  }

  /**
   * The snapshot the panel polls.
   * @returns every workspace, the distribution, and the operator account.
   */
  async snapshot(): Promise<RuntimeView> {
    const wsl = await this.wslView()
    const workspaces = await Promise.all(this.store.list().map(workspace => this.view(workspace, wsl)))
    const lastWorkspace = this.store.lastWorkspaceId
    return { wsl, workspaces, ...lastWorkspace !== undefined ? { lastWorkspace } : {},
      operator: await this.operator(), checkout: this.config.checkout }
  }

  /**
   * Remember the workspace the panel is showing, so the next open starts there.
   * @param id - workspace id.
   */
  async setActive(id: string): Promise<void> {
    this.workspaceFor(id)
    await this.store.setLastWorkspace(id)
  }

  /**
   * Run one slow operation as a task the panel can watch.
   * @param id - workspace the task belongs to.
   * @param kind - task kind.
   * @param run - the work, which reports each step.
   * @returns what the work returned.
   */
  private async task<T>(id: string, kind: TaskView['kind'], run: (step: Step) => Promise<T>): Promise<T> {
    const view: TaskView = { kind, step: '准备中', startedAt: new Date().toISOString(), log: [] }
    this.tasks.set(id, view)
    const step: Step = message => {
      view.step = message
      view.log = [...view.log, message].slice(-12)
      this.deps.log.info('[superagent-remote] ' + id + ': ' + message)
    }
    try {
      const value = await run(step)
      view.step = '完成'
      view.finishedAt = new Date().toISOString()
      this.health.delete(id)
      return value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      view.error = message
      view.finishedAt = new Date().toISOString()
      this.deps.log.error('[superagent-remote] ' + id + ': ' + message)
      throw error
    }
  }

  /**
   * Start the distribution when it is down, and remember that this plugin started it.
   * @throws when wsl.exe is missing or the distribution refuses to start.
   */
  async ensureWsl(): Promise<void> {
    if (!await this.wslAvailable()) throw new Error('在这台机器上找不到 wsl.exe')
    if (await this.deps.wsl.isRunning()) return
    const booted = await this.deps.wsl.boot()
    if (booted.code !== 0) {
      const reason = (booted.stderr || booted.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? 'exit code ' + String(booted.code)
      throw new Error('WSL 发行版 ' + this.config.distro + ' 启动失败：' + reason)
    }
    await this.store.setWslOwned(true)
    this.wslCache = undefined
    this.health.clear()
  }

  /**
   * Start every enabled workspace. Called when the panel opens, once per process.
   * @returns nothing; a failed workspace is reported in its own view.
   */
  async ensureStarted(): Promise<void> {
    if (this.starting !== undefined) return this.starting
    this.starting = (async () => {
      try {
        await this.ensureWsl()
      } catch (error) {
        this.deps.log.error('[superagent-remote] ' + (error instanceof Error ? error.message : String(error)))
        throw error
      }
      await this.autoImport()
      for (const workspace of this.store.list().filter(entry => entry.enabled)) {
        const health = await this.probe(workspace)
        if (health.phase === 'ready') continue
        try {
          await this.startWorkspace(workspace.id)
        } catch (error) {
          // One workspace that cannot start must not keep the others from starting.
          this.deps.log.warn('[superagent-remote] ' + workspace.id + ' did not start: ' +
            (error instanceof Error ? error.message : String(error)))
        }
      }
    })().finally(() => { this.starting = undefined })
    return this.starting
  }

  /**
   * Kick off the first-open startup without making the panel wait for it.
   *
   * Provisioning and starting a deployment may take minutes; the panel renders
   * the snapshot at once and follows each task through its polling instead.
   */
  beginStart(): void {
    void this.ensureStarted().catch(error => {
      this.deps.log.error('[superagent-remote] startup failed: ' +
        (error instanceof Error ? error.message : String(error)))
    })
  }

  /**
   * Register the deployments this machine already runs, so the first open of the
   * panel shows them instead of an empty list. A stopped deployment is left for
   * the import dialog, because its repository and agent account cannot be read.
   */
  private async autoImport(): Promise<void> {
    // Import once: after a person removes the last workspace, the still-running
    // deployments must not come back on the next open.
    if (!this.config.autoImport || this.store.initialized || this.store.list().length > 0) return
    let found: Awaited<ReturnType<Runtime['discovery']>>
    try {
      found = await this.discovery()
    } catch (error) {
      this.deps.log.warn('[superagent-remote] cannot list the deployments in WSL: ' +
        (error instanceof Error ? error.message : String(error)))
      return
    }
    for (const entry of adoptable(found)) {
      try {
        const workspace = await this.adopt(entry.profile, entry.port)
        this.deps.log.info('[superagent-remote] imported ' + workspace.profile +
          ' as workspace ' + workspace.id)
      } catch (error) {
        this.deps.log.warn('[superagent-remote] could not import ' + entry.profile + ': ' +
          (error instanceof Error ? error.message : String(error)))
      }
    }
    await this.store.setInitialized(true)
  }

  /**
   * Start one workspace's deployment.
   * @param id - workspace id.
   * @returns the workspace view after the attempt.
   */
  async startWorkspace(id: string): Promise<WorkspaceView> {
    const workspace = this.workspaceFor(id)
    await this.ensureWsl()
    // A create whose provisioning failed stays in the registry. Starting it
    // retries provisioning instead of leaving an unusable row behind.
    if (!workspace.provisioned) {
      const operator = await this.operator()
      if (operator.length === 0) throw new Error('本机的 gh 没有登录；供给工作区需要一个 operator 账号')
      await this.task(id, 'provision', async step => {
        const result = await provision({
          wsl: this.deps.wsl, config: this.config, workspace, operator, step,
        })
        await this.store.update(id, { stateDir: result.stateDir, provisioned: true })
      })
      return this.view(this.workspaceFor(id), await this.wslView())
    }
    await this.task(id, 'start', async step => {
      step('检查 ' + this.config.checkout + ' 的 dsh-superagent 检出')
      await ensureCheckout(this.deps.wsl, this.config, step)
      step('启动 ' + workspace.profile)
      const failure = await startService(this.deps.wsl, this.config, workspace)
      if (failure !== undefined) throw new Error(failure)
      this.health.delete(id)
    })
    return this.view(workspace, await this.wslView())
  }

  /**
   * Stop one workspace's deployment.
   * @param id - workspace id.
   * @returns the workspace view after the stop.
   */
  async stopWorkspace(id: string): Promise<WorkspaceView> {
    const workspace = this.workspaceFor(id)
    // Running the service script inside a stopped distribution would boot it, so a
    // stop on a stopped distribution has nothing to do.
    if (!await this.deps.wsl.isRunning()) {
      this.health.delete(id)
      return this.view(workspace, await this.wslView())
    }
    await this.task(id, 'stop', async step => {
      step('停止 ' + workspace.profile)
      const failure = await stopService(this.deps.wsl, this.config, workspace, STOP_TIMEOUT_SECONDS)
      if (failure !== undefined) throw new Error(failure)
      this.health.delete(id)
    })
    return this.view(workspace, await this.wslView())
  }

  /**
   * Stop and start one workspace's deployment in the background.
   * @param id - workspace id.
   */
  restartWorkspace(id: string): void {
    void (async () => {
      await this.stopWorkspace(id).catch(() => undefined)
      await this.startWorkspace(id)
    })().catch(error => {
      this.deps.log.error('[superagent-remote] restart of ' + id + ' failed: ' +
        (error instanceof Error ? error.message : String(error)))
    })
  }

  /**
   * One workspace by id, or a refusal.
   * @param id - workspace id.
   * @returns the stored workspace.
   */
  workspaceFor(id: string): Workspace {
    const workspace = this.store.get(id)
    if (workspace === undefined) throw new Error('工作区 ' + id + ' 不存在')
    return workspace
  }

  /**
   * Create a workspace and provision its deployment.
   * @param request - name, repository, and agent account.
   * @returns the workspace view while provisioning runs in the background.
   */
  async create(request: CreateWorkspaceRequest): Promise<WorkspaceView> {
    const name = request.name.trim()
    const repository = request.repository.trim()
    const agentLogin = request.agentLogin.trim()
    if (name.length === 0) throw new Error('请填写工作区名称')
    if (!REPOSITORY.test(repository)) throw new Error('仓库要写成 owner/name，例如 example-org/demo-project')
    if (!LOGIN.test(agentLogin)) throw new Error('请填写智能体的 GitHub 账号名')
    const operator = await this.operator()
    if (operator.length === 0) throw new Error('本机的 gh 没有登录；工作区的允许名单需要一个 operator 账号')
    const existing = this.store.list()
    if (existing.some(entry => entry.repository.toLowerCase() === repository.toLowerCase())) {
      throw new Error('仓库 ' + repository + ' 已经是一个工作区')
    }
    const id = workspaceId(name, existing.map(entry => entry.id))
    const profile = request.profile?.trim() || 'superagent-' + id
    if (!PROFILE.test(profile)) throw new Error('配置档名不合法：' + profile)
    if (existing.some(entry => entry.profile === profile)) throw new Error('配置档 ' + profile + ' 已经属于另一个工作区')
    const requested = request.port
    const taken = existing.map(entry => entry.port)
    let port: number
    if (requested !== undefined && Number.isInteger(requested) && requested > 1024 && requested < 65_536) {
      if (taken.includes(requested)) throw new Error('端口 ' + String(requested) + ' 已经属于另一个工作区')
      if (!await portFree(requested)) throw new Error('端口 ' + String(requested) + ' 已被这台机器上的另一个程序占用')
      port = requested
    } else {
      port = await firstFreePort(this.config.portBase, taken)
    }
    await this.ensureWsl()
    const home = await homeOf(this.deps.wsl)
    const workspace: Workspace = {
      id,
      name,
      repository,
      agentLogin,
      profile,
      port,
      stateDir: stateDirFor(home, profile),
      agentCli: request.agentCli?.trim() || this.config.agentCli,
      enabled: true,
      adopted: false,
      provisioned: false,
      createdAt: new Date().toISOString(),
    }
    await this.store.add(workspace)
    // Provisioning takes minutes on a fresh profile; the panel watches the task.
    void this.task(id, 'provision', async step => {
      const result = await provision({ wsl: this.deps.wsl, config: this.config, workspace, operator, step })
      await this.store.update(id, { stateDir: result.stateDir, provisioned: true })
    }).catch(() => {})
    return this.view(workspace, await this.wslView())
  }

  /**
   * Register a deployment the machine already runs.
   * @param profile - DSH profile name found in the distribution.
   * @param port - port override; the profile's patch is read when omitted.
   * @returns the adopted workspace.
   */
  async adopt(profile: string, port?: number): Promise<WorkspaceView> {
    const found = (await discover(this.deps.wsl)).find(entry => entry.profile === profile)
    if (found === undefined) throw new Error('在 WSL 里找不到加载 dsh-superagent 的配置档 ' + profile)
    const resolvedPort = port ?? found.port
    if (resolvedPort === undefined) throw new Error('配置档 ' + profile + ' 没有写明端口，请手动填写')
    const state = await apiGet<DeploymentState>(resolvedPort, 'state', 5_000).catch(() => undefined)
    if (state === undefined) throw new Error('端口 ' + String(resolvedPort) + ' 上没有 dsh-superagent 应答；先启动它再导入')
    const repository = state.setup?.accounts?.repository ?? ''
    if (repository.length === 0) throw new Error('这个部署还没有设置仓库，无法导入')
    const agentLogin = state.setup?.accounts?.agent ?? ''
    const stateDir = state.setup?.machine?.stateDir ?? found.stateDir ?? ''
    let agentCli = this.config.agentCli
    const settings = await apiGet<{ sources?: { id: string; value?: { config?: { cli?: string } } }[] }>(resolvedPort, 'settings', 8_000)
      .catch(() => undefined)
    const cli = settings?.sources?.find(entry => entry.id === 'github')?.value?.config?.cli
    if (typeof cli === 'string' && cli.length > 0) agentCli = cli
    const existing = this.store.list()
    if (existing.some(entry => entry.profile === profile)) throw new Error('配置档 ' + profile + ' 已经是一个工作区')
    const name = repository.split('/')[1] ?? profile
    const workspace: Workspace = {
      id: workspaceId(name, existing.map(entry => entry.id)),
      name,
      repository,
      agentLogin,
      profile,
      port: resolvedPort,
      stateDir,
      agentCli,
      enabled: true,
      adopted: true,
      provisioned: true,
      createdAt: new Date().toISOString(),
    }
    await this.store.add(workspace)
    this.health.delete(workspace.id)
    return this.view(workspace, await this.wslView())
  }

  /**
   * What the machine already runs, for the import list.
   * @returns one entry per dsh-superagent profile.
   */
  async discovery(): Promise<{ profile: string; port?: number; stateDir?: string; adopted: boolean; repository?: string }[]> {
    const found = await discover(this.deps.wsl)
    const taken = new Set(this.store.list().map(entry => entry.profile))
    return Promise.all(found.map(async entry => {
      const state = entry.port === undefined ? undefined : await apiGet<DeploymentState>(entry.port, 'state', 3_000).catch(() => undefined)
      const repository = state?.setup?.accounts?.repository
      return {
        profile: entry.profile,
        ...entry.port !== undefined ? { port: entry.port } : {},
        ...entry.stateDir !== undefined ? { stateDir: entry.stateDir } : {},
        adopted: taken.has(entry.profile),
        ...repository !== undefined ? { repository } : {},
      }
    }))
  }

  /**
   * Record the issue a workspace's conversation lives in.
   * @param id - workspace id.
   * @param thread - issue number.
   */
  async rememberThread(id: string, thread: number): Promise<void> {
    this.workspaceFor(id)
    await this.store.update(id, { chatThread: thread })
  }

  /**
   * The authenticated address of one workspace's own DSH web UI.
   *
   * The deployment prints that address, launch token included, to its log when it
   * starts; the token changes with the process, so the address is read again
   * whenever the panel asks, and the port in it has to be this workspace's own.
   * @param id - workspace id.
   * @returns the address, with the token as its only authentication input.
   * @throws when the log has no address yet, or when it names another deployment.
   */
  async uiUrl(id: string): Promise<string> {
    const workspace = this.workspaceFor(id)
    const health = await this.probe(workspace)
    if (health.phase !== 'ready') throw new Error('这个部署还没有运行；先点「启动」，再看官方界面')
    const script = [
      'dir=' + shellQuote(this.config.checkout) + '/.artifacts',
      'if [ ! -d "$dir" ]; then echo "这个部署还没有 .artifacts 目录：" "$dir" >&2; exit 4; fi',
      'log=$(ls -1t "$dir"/' + shellQuote('dsh-superagent-' + workspace.profile + '-') + '*.log 2>/dev/null | head -n 1)',
      'if [ -z "$log" ]; then echo "这个部署还没有启动日志" >&2; exit 5; fi',
      'grep -a -oE "http://127\\.0\\.0\\.1:[0-9]+/\\?token=[A-Za-z0-9_-]+" "$log" | tail -n 1',
    ].join('\n')
    const result = await this.deps.wsl.bash(script, { timeoutMs: 20_000 })
    const url = result.stdout.trim().split('\n').filter(line => line.length > 0).at(-1) ?? ''
    if (result.code !== 0 || url.length === 0) {
      throw new Error(explain(result) ?? '这个部署的界面地址还没有写进日志，等它启动完再试')
    }
    const parsed = new URL(url)
    if (parsed.port !== String(workspace.port)) {
      throw new Error('日志里的界面地址属于另一个部署（端口 ' + parsed.port + '），这个工作区的端口是 ' + String(workspace.port))
    }
    return url
  }

  /**
   * Read one worker session's event log from the distribution.
   *
   * The log is the harness's own file for that session; it is moved as base64
   * because wsl.exe writes its answer through the console, which mangles a
   * binary stream. The file is also compressed block by block, so the caller
   * decodes it (see trajectory.ts).
   * @param id - workspace id.
   * @param sessionId - the Executor session the deployment reports for the ticket.
   * @returns the file bytes.
   * @throws when the session has no log yet, or when the log is too large to move.
   */
  async sessionLog(id: string, sessionId: string): Promise<Buffer> {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error('会话 id 不合法：' + sessionId)
    this.workspaceFor(id)
    const script = [
      'd=$(find "$HOME/.dsh/sessions" -maxdepth 2 -type d -name ' + "'" + sessionId + "'" + ' 2>/dev/null | head -n 1)',
      'if [ -z "$d" ]; then echo "还没有这个会话的日志目录：" ' + "'" + sessionId + "'" + ' >&2; exit 4; fi',
      'f=$(ls -1t "$d"/session.v*.jsonl* 2>/dev/null | head -n 1)',
      'if [ -z "$f" ]; then echo "这个会话还没有写日志" >&2; exit 5; fi',
      'size=$(wc -c < "$f")',
      'if [ "$size" -gt ' + String(MAX_LOG_BYTES) + ' ]; then echo "会话日志有 $size 字节，面板暂不读取" >&2; exit 6; fi',
      'base64 -w0 "$f"',
    ].join('\n')
    const result = await this.deps.wsl.bash(script, { timeoutMs: 120_000 })
    if (result.code !== 0) throw new Error(explain(result) ?? 'cannot read the session log')
    const bytes = Buffer.from(result.stdout.trim(), 'base64')
    if (bytes.length === 0) throw new Error('会话日志是空的')
    return bytes
  }

  /**
   * Change the fields a person may change without reprovisioning.
   * @param id - workspace id.
   * @param patch - new name, enabled flag, or pin/archive state.
   * @returns the updated workspace view.
   */
  async update(id: string, patch: UpdateWorkspaceRequest): Promise<WorkspaceView> {
    this.workspaceFor(id)
    const next: Partial<Workspace> = {}
    if (patch.name !== undefined && patch.name.trim().length > 0) next.name = patch.name.trim()
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.pinned !== undefined) next.pinned = patch.pinned
    if (patch.archived !== undefined) next.archived = patch.archived
    const workspace = await this.store.update(id, next)
    return this.view(workspace, await this.wslView())
  }

  /**
   * Stop a workspace's deployment, delete it inside WSL, and forget the row.
   *
   * Stopping first frees the loopback port. Deleting the profile and state
   * directory is what keeps the deployment out of `/runtime/discovery`, so a
   * removed project cannot be imported back. The row stays when either step
   * fails, because a half-deleted deployment is worse than a visible one.
   * @param id - workspace id.
   */
  async remove(id: string): Promise<void> {
    const workspace = this.workspaceFor(id)
    await this.ensureWsl()
    try {
      // A deleted checkout cannot own a running service; skip the stop instead of
      // failing the removal with "No such file or directory".
      if (await checkoutPresent(this.deps.wsl, this.config.checkout)) {
        const failure = await stopService(this.deps.wsl, this.config, workspace, STOP_TIMEOUT_SECONDS)
        if (failure !== undefined) throw new Error(failure)
      } else {
        this.deps.log.warn('[superagent-remote] ' + id + ': checkout missing, skipping stop before removal')
      }
    } catch (error) {
      throw new Error('停止部署失败，项目仍然保留：' +
        (error instanceof Error ? error.message : String(error)))
    }
    try {
      await deleteDeployment(this.deps.wsl, workspace)
    } catch (error) {
      throw new Error('部署已停止，但删除 WSL 中的文件失败，项目仍然保留：' +
        (error instanceof Error ? error.message : String(error)))
    }
    this.health.delete(id)
    this.tasks.delete(id)
    await this.store.remove(id)
    // Removing the last workspace must also close the first-open import, even when
    // that import had not run yet.
    await this.store.setInitialized(true)
  }

  /**
   * Forward one request to a deployment's management API.
   * @param id - workspace id.
   * @param method - HTTP verb.
   * @param path - path below /orchestrator/api, with its query string.
   * @param body - request body text.
   * @returns the deployment's status, content type, and body text.
   */
  async forward(id: string, method: string, path: string, body: string | undefined): Promise<{ status: number; type: string; text: string }> {
    const workspace = this.workspaceFor(id)
    const headers: Record<string, string> = { 'x-orchestrator-request': '1', accept: 'application/json' }
    if (body !== undefined && body.length > 0) headers['content-type'] = 'application/json'
    try {
      const response = await fetch('http://127.0.0.1:' + String(workspace.port) + '/orchestrator/api/' + path, {
        method,
        headers,
        ...body !== undefined && body.length > 0 ? { body } : {},
        signal: AbortSignal.timeout(120_000),
      })
      return { status: response.status, type: response.headers.get('content-type') ?? 'application/json', text: await response.text() }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        status: 502,
        type: 'application/json',
        text: JSON.stringify({ error: 'dsh-superagent on port ' + String(workspace.port) + ' did not answer: ' + reason }),
      }
    }
  }

  /**
   * Stop the deployments and, when this plugin owns it, the distribution.
   *
   * Runs on the calling thread because it happens while the process shuts down.
   */
  shutdown(): void {
    const workspaces = this.store.list().filter(entry => entry.enabled)
    const terminate = this.shouldTerminate()
    const running = this.running()
    // Booting a stopped distribution just to stop services that are not running
    // would defeat the point of the exit cleanup.
    if (workspaces.length > 0 && running) {
      const stops = workspaces.map(entry =>
        'python3 scripts/dsh-superagent --profile ' + entry.profile + ' --url http://127.0.0.1:' + String(entry.port) +
        ' --stop-timeout 8 stop >/dev/null 2>&1 &')
      const script = 'cd ' + this.config.checkout + ' || exit 0\n' + stops.join('\n') + '\nwait\n'
      this.deps.wsl.bashSync(script, SHUTDOWN_TIMEOUT_MS)
    }
    if (terminate && running) {
      this.deps.wsl.terminate()
      this.deps.log.info('[superagent-remote] ' + this.config.distro + ' terminated')
    } else {
      this.deps.log.info('[superagent-remote] keeping ' + this.config.distro + ' running')
    }
    if (terminate) this.store.setWslOwnedSync(false)
    try {
      this.store.saveSync()
    } catch (error) {
      this.deps.log.warn('[superagent-remote] cannot save the workspace file: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * Whether the configured distribution is running, read synchronously for shutdown.
   * @returns the answer; false when wsl.exe cannot be run.
   */
  private running(): boolean {
    if (this.available === false) return false
    try {
      return this.deps.wsl.runningDistrosSync()
        .some(name => name.toLowerCase() === this.config.distro.toLowerCase())
    } catch {
      return false
    }
  }

  /** Whether the configured policy ends the distribution with this process. */
  private shouldTerminate(): boolean {
    if (this.config.terminateWslOnExit === 'always') return true
    if (this.config.terminateWslOnExit === 'never') return false
    return this.store.wslOwned
  }
}