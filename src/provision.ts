/**
 * Provisioning and service control inside the distribution.
 *
 * A workspace is one dsh-superagent deployment: a DSH profile that loads the
 * upstream bundle, serves its panel on its own loopback port, and keeps its
 * state in its own directory. Provisioning follows the upstream install guide
 * step by step, and every step is idempotent, so a retry after a failure
 * continues where it stopped instead of starting over.
 */
import type { ResolvedConfig } from './config.ts'
import { applySettings } from './settings-api.ts'
import type { Workspace } from './store.ts'
import { explain, type Wsl } from './wsl.ts'

/** Progress report for one provisioning or control step. */
export type Step = (message: string) => void

/** How long the upstream script may take to answer, per action. */
const SERVICE_TIMEOUT_MS = 180_000
/** How long installing the bundle into a fresh profile may take. */
const INSTALL_TIMEOUT_MS = 900_000

/**
 * Quote one value for a POSIX shell.
 * @param value - text that may contain spaces or quotes.
 * @returns the value, safe to place in a script.
 */
export function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** The user's home directory inside the distribution, without a trailing newline. */
export async function homeOf(wsl: Wsl): Promise<string> {
  const result = await wsl.bash('printf %s "$HOME"', { timeoutMs: 20_000 })
  const home = result.stdout.trim()
  if (result.code !== 0 || home.length === 0 || !home.startsWith('/')) {
    throw new Error('cannot read the home directory inside the distribution: ' + (explain(result) ?? 'no answer'))
  }
  return home.replace(/\/+$/, '')
}

/** Where one profile keeps its files. */
export function profileDir(home: string, profile: string): string {
  return home + '/.dsh/profiles/' + profile
}

/** The state directory this plugin gives a new profile. */
export function stateDirFor(home: string, profile: string): string {
  return home + '/.dsh/state/' + profile
}

/** One deployment the machine already has, found in the distribution. */
export interface Discovery {
  profile: string
  port: number | undefined
  stateDir: string | undefined
}

/**
 * List the DSH profiles that load dsh-superagent.
 * @param wsl - the distribution bridge.
 * @returns one entry per profile, with the port and state directory its patch names when present.
 */
export async function discover(wsl: Wsl): Promise<Discovery[]> {
  const script = [
    'for f in "$HOME"/.dsh/profiles/*/cordis.patch.yml; do',
    '  [ -f "$f" ] || continue',
    '  grep -q "id: dsh-superagent" "$f" || continue',
    '  p=$(basename "$(dirname "$f")")',
    '  port=$(grep -A4 "id: webserver" "$f" | sed -n "s/^ *port: *\\([0-9][0-9]*\\).*/\\1/p" | head -1)',
    '  state=$(grep -A4 "id: dsh-superagent" "$f" | sed -n "s/^ *stateDir: *//p" | head -1)',
    '  printf "%s\\t%s\\t%s\\n" "$p" "${port:-}" "$state"',
    'done',
  ].join('\n')
  const result = await wsl.bash(script, { timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error('cannot read the DSH profiles: ' + (explain(result) ?? 'no answer'))
  return result.stdout.split(/\r?\n/).filter(line => line.trim().length > 0).map(line => {
    const [profile = '', port = '', stateDir = ''] = line.split('\t')
    const parsed = Number(port)
    return {
      profile: profile.trim(),
      port: Number.isInteger(parsed) && parsed > 0 ? parsed : undefined,
      stateDir: stateDir.trim().length > 0 ? stateDir.trim().replace(/^["']|["']$/g, '') : undefined,
    }
  })
}

/** Upstream repository the per-workspace deployments load. */
const UPSTREAM = 'https://github.com/deepseek-ai/dsh-superagent-prototype'

/**
 * Whether the upstream checkout directory exists.
 * @param wsl - the distribution bridge.
 * @param checkout - absolute checkout path.
 * @returns true when the path is a directory.
 */
export async function checkoutPresent(wsl: Wsl, checkout: string): Promise<boolean> {
  const result = await wsl.bash('test -d ' + quote(checkout), { timeoutMs: 20_000 })
  return result.code === 0
}

/**
 * Install and build the dsh-superagent checkout once.
 *
 * The managed checkout is always the official Node/TypeScript dsh-superagent,
 * whose build is pnpm. A marker under `.artifacts` keeps later starts from
 * rebuilding.
 * @param wsl - the distribution bridge.
 * @param checkout - absolute checkout path.
 * @param step - progress report.
 * @throws when pnpm install or pnpm build fails.
 */
async function ensureCheckoutSetup(wsl: Wsl, checkout: string, step: Step): Promise<void> {
  const marker = checkout + '/.artifacts/.dsh-superagent-remote-setup'
  if ((await wsl.bash('test -f ' + quote(marker), { timeoutMs: 20_000 })).code === 0) return

  step('安装 dsh-superagent 依赖（pnpm install）')
  const installed = await wsl.bash('cd ' + quote(checkout) + ' && pnpm install', { timeoutMs: 900_000 })
  if (installed.code !== 0) {
    throw new Error('dsh-superagent 依赖安装失败：' + (explain(installed) ?? 'exit code ' + String(installed.code)))
  }
  step('构建 dsh-superagent（pnpm build）')
  const built = await wsl.bash('cd ' + quote(checkout) + ' && pnpm build', { timeoutMs: 900_000 })
  if (built.code !== 0) {
    throw new Error('dsh-superagent 构建失败：' + (explain(built) ?? 'exit code ' + String(built.code)))
  }
  const marked = await wsl.bash('mkdir -p ' + quote(checkout + '/.artifacts') + ' && : > ' + quote(marker), { timeoutMs: 20_000 })
  if (marked.code !== 0) throw new Error('无法记录 checkout 的安装状态：' + checkout)
}
/**
 * Make the upstream service script recognize Node's thread names.
 *
 * Node 26 reports its process name as `node-MainThread`, while older releases
 * report `node`. The upstream script matches the exact names `node` and `dsh`,
 * so its health check would never see a running service. The replacement keeps
 * both exact names working and accepts any `node*` name; it is a no-op once the
 * upstream script is fixed.
 * @param wsl - the distribution bridge.
 * @param checkout - absolute checkout path.
 * @throws when the file cannot be patched.
 */
async function ensureNodeNameCompat(wsl: Wsl, checkout: string): Promise<void> {
  const patch = `sed -i "s/name in ('node', 'dsh')/(name == 'dsh' or name.startswith('node'))/g" "$f"`
  const command = [
    'f=' + quote(checkout + '/scripts/dsh-superagent'),
    '[ -f "$f" ] || exit 0',
    patch,
  ].join('\n')
  const result = await wsl.bash(command, { timeoutMs: 20_000 })
  if (result.code !== 0) {
    throw new Error('无法应用 dsh-superagent 的 Node 进程名兼容补丁：' + (explain(result) ?? 'sed failed'))
  }
}

/**
 * Clone the upstream checkout when it is missing and apply compatibility edits.
 *
 * The checkout is the official Node/TypeScript dsh-superagent, so it is cloned
 * and then installed and built with pnpm. An existing checkout is reused and
 * only receives the idempotent Node-name compatibility edit.
 * @param wsl - the distribution bridge.
 * @param config - resolved plugin configuration.
 * @param step - progress report.
 * @throws when git clone fails or the service script cannot be patched.
 */
export async function ensureCheckout(wsl: Wsl, config: ResolvedConfig, step: Step): Promise<void> {
  const checkout = config.checkout
  if (!await checkoutPresent(wsl, checkout)) {
    step('克隆 dsh-superagent 上游到 ' + checkout)
    const cloned = await wsl.bash('git clone --depth 1 ' + quote(UPSTREAM) + ' ' + quote(checkout),
      { timeoutMs: 600_000 })
    if (cloned.code !== 0) {
      throw new Error('无法克隆 dsh-superagent 上游：' + (explain(cloned) ?? 'git clone failed'))
    }
  }
  await ensureCheckoutSetup(wsl, checkout, step)
  await ensureNodeNameCompat(wsl, checkout)
}

/**
 * The plugin patch that makes one profile a dsh-superagent deployment.
 * @param port - loopback port the profile serves on.
 * @param stateDir - absolute state directory.
 * @returns YAML for the profile's cordis.patch.yml.
 */
export function profilePatch(port: number, stateDir: string): string {
  return [
    '# Written by @gamegeek-saikel/dsh-superagent-remote; one profile per workspace.',
    '# docs/006-deployment.md of dsh-superagent documents both entries.',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    '    port: ' + String(port),
    '- id: dsh-superagent',
    '  config:',
    '    stateDir: ' + stateDir,
    '',
    '# GitHub only: no lark-cli is installed, so the Feishu Source stays disabled.',
    '',
  ].join('\n')
}

/**
 * Ensure one profile exists, serves on its port, and loads the bundle.
 * @param wsl - the distribution bridge.
 * @param config - resolved plugin configuration.
 * @param workspace - the workspace being provisioned.
 * @param step - progress report.
 */
async function ensureProfile(wsl: Wsl, config: ResolvedConfig, workspace: Workspace, step: Step): Promise<void> {
  const home = await homeOf(wsl)
  const dir = profileDir(home, workspace.profile)
  const exists = await wsl.bash('test -d ' + quote(dir), { timeoutMs: 20_000 })
  if (exists.code !== 0) {
    step('创建 DSH 配置档 ' + workspace.profile)
    const created = await wsl.bash('dsh ' + quote(workspace.profile) + ' --from-default-profile web --dump-config',
      { timeoutMs: 300_000 })
    if (created.code !== 0) throw new Error('cannot create the DSH profile ' + workspace.profile + ': ' + (explain(created) ?? 'no answer'))
  }
  step('写入端口 ' + String(workspace.port) + ' 与状态目录')
  const patch = await wsl.bash(
    'cat > ' + quote(dir + '/cordis.patch.yml') + ' <<\'DSH_REMOTE_PATCH\'\n' + profilePatch(workspace.port, workspace.stateDir) + 'DSH_REMOTE_PATCH',
    { timeoutMs: 20_000 })
  if (patch.code !== 0) throw new Error('cannot write the profile patch: ' + (explain(patch) ?? 'no answer'))
  const installed = await wsl.bash('grep -q ' + quote('"dsh-superagent"') + ' ' + quote(dir + '/package.json'), { timeoutMs: 20_000 })
  if (installed.code === 0) return
  step('安装 dsh-superagent 到配置档 ' + workspace.profile + '（首次耗时几分钟）')
  const added = await wsl.bash('dsh plugin --profile ' + quote(workspace.profile) + ' add link:' + quote(config.checkout),
    { timeoutMs: INSTALL_TIMEOUT_MS })
  if (added.code !== 0) throw new Error('cannot install dsh-superagent into ' + workspace.profile + ': ' + (explain(added) ?? 'no answer'))
}

/**
 * Ensure the clone the per-ticket worktrees are cut from exists.
 * @param wsl - the distribution bridge.
 * @param workspace - the workspace, for its repository and agent CLI.
 * @param cloneDir - absolute clone path.
 * @param step - progress report.
 */
async function ensureClone(wsl: Wsl, workspace: Workspace, cloneDir: string, step: Step): Promise<void> {
  const present = await wsl.bash('test -d ' + quote(cloneDir + '/.git'), { timeoutMs: 20_000 })
  if (present.code === 0) return
  step('克隆 ' + workspace.repository + ' 到 ' + cloneDir)
  const parent = cloneDir.slice(0, cloneDir.lastIndexOf('/'))
  const cloned = await wsl.bash('mkdir -p ' + quote(parent) + ' && ' + quote(workspace.agentCli) +
    ' repo clone ' + quote(workspace.repository) + ' ' + quote(cloneDir), { timeoutMs: 600_000 })
  if (cloned.code !== 0) throw new Error('cannot clone ' + workspace.repository + ': ' + (explain(cloned) ?? 'no answer'))
}

/**
 * Hosts the distribution reaches without the operator's HTTP proxy.
 *
 * GitHub's API answers directly from the distribution; routing it through a local
 * proxy fails the Source's GraphQL polling with a TLS handshake timeout whenever
 * that proxy is slow to finish the handshake. `github.com` stays out of this list:
 * it is git's transport, and a direct request to it ends mid-TLS wherever the
 * network interferes with the connection, which fails every ticket's prepare.
 */
const GITHUB_DIRECT = 'api.github.com,codeload.github.com,objects.githubusercontent.com,raw.githubusercontent.com,avatars.githubusercontent.com'

/**
 * Start one deployment and wait for its runtime to answer.
 * @param wsl - the distribution bridge.
 * @param config - resolved plugin configuration.
 * @param workspace - the workspace to start.
 * @returns the failure in one line, or undefined when it started.
 */
export async function startService(wsl: Wsl, config: ResolvedConfig, workspace: Workspace): Promise<string | undefined> {
  // tmux keeps its own environment, so the bypass is published there as well as
  // exported for the shell that starts the service.
  const publish = 'tmux set-environment -g no_proxy "' + GITHUB_DIRECT + '\${no_proxy:+,}$no_proxy" 2>/dev/null; ' +
    'tmux set-environment -g NO_PROXY "' + GITHUB_DIRECT + '\${NO_PROXY:+,}$NO_PROXY" 2>/dev/null; '
  const command = publish +
    'export no_proxy="' + GITHUB_DIRECT + '\${no_proxy:+,}$no_proxy" NO_PROXY="' + GITHUB_DIRECT + '\${NO_PROXY:+,}$NO_PROXY"; ' +
    'cd ' + quote(config.checkout) + ' && python3 scripts/dsh-superagent --profile ' +
    quote(workspace.profile) + ' --url ' + quote('http://127.0.0.1:' + String(workspace.port)) + ' start'
  const result = await wsl.bash(command, { timeoutMs: SERVICE_TIMEOUT_MS })
  if (result.code === 0) return undefined
  // A first start exits non-zero while the deployment waits for setup: the
  // server is already answering, and the settings written next resolve it.
  const output = result.stdout + '\n' + result.stderr
  if (/waiting for setup|Open the URL DSH printed/u.test(output)) return undefined
  return explain(result) ?? 'the service did not start'
}

/**
 * Stop one deployment gracefully.
 * @param wsl - the distribution bridge.
 * @param config - resolved plugin configuration.
 * @param workspace - the workspace to stop.
 * @param stopTimeoutSeconds - how long running Executor Sessions may finish.
 * @returns the failure in one line, or undefined when it stopped.
 */
export async function stopService(wsl: Wsl, config: ResolvedConfig, workspace: Workspace,
  stopTimeoutSeconds = 25): Promise<string | undefined> {
  const command = 'cd ' + quote(config.checkout) + ' && python3 scripts/dsh-superagent --profile ' +
    quote(workspace.profile) + ' --url ' + quote('http://127.0.0.1:' + String(workspace.port)) +
    ' --stop-timeout ' + String(stopTimeoutSeconds) + ' stop'
  const result = await wsl.bash(command, { timeoutMs: (stopTimeoutSeconds + 30) * 1_000 })
  return result.code === 0 ? undefined : explain(result) ?? 'the service did not stop'
}

/**
 * Delete one deployment's files inside the distribution.
 *
 * Removing a workspace must also remove the deployment it named; otherwise the
 * still-registered profile shows up again in the `/runtime/discovery` list and
 * can be imported back. The profile directory, the state directory, the state
 * lock, and the DSH session directories keyed by that state directory are
 * removed. The checkout clone is shared by repository and is left alone.
 * @param wsl - the distribution bridge.
 * @param workspace - the workspace whose deployment is removed.
 * @throws when the state directory is outside the plugin's state root or when
 *   the distribution refuses the deletion.
 */
export async function deleteDeployment(wsl: Wsl, workspace: Workspace): Promise<void> {
  const home = await homeOf(wsl)
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(workspace.profile)) {
    throw new Error('配置档名不合法：' + workspace.profile)
  }
  const stateRoot = home + '/.dsh/state/'
  const stateDir = (workspace.stateDir.length > 0 ? workspace.stateDir : stateRoot + workspace.profile)
    .replace(/\/+$/, '')
  const segments = stateDir.split('/')
  if (!stateDir.startsWith(stateRoot) || stateDir === stateRoot || segments.includes('..')) {
    throw new Error('状态目录不在 ' + stateRoot + ' 之下，拒绝删除：' + stateDir)
  }
  const script = [
    'set -e',
    'home=' + quote(home),
    'profile=' + quote(profileDir(home, workspace.profile)),
    'state=' + quote(stateDir),
    'slug=$(printf "%s" "$state" | sed "s|^/||; s|/|-|g")',
    'rm -rf -- "$profile"',
    'rm -rf -- "$state"',
    'rm -f -- "$state.lock"',
    'rm -rf -- "$home/.dsh/sessions/--$slug--"',
    'for d in "$home/.dsh/sessions/--$slug-work-"*; do [ -d "$d" ] && rm -rf -- "$d"; done',
    'exit 0',
  ].join('\n')
  const result = await wsl.bash(script, { timeoutMs: 120_000 })
  if (result.code !== 0) throw new Error(explain(result) ?? 'cannot delete the deployment inside WSL')
}

/**
 * Read the upstream service script's exit code for one deployment.
 * @param wsl - the distribution bridge.
 * @param config - resolved plugin configuration.
 * @param workspace - the workspace to check.
 * @returns the script's exit code: 0 normal, 1 down, 2 part error, 3 waiting for setup.
 */
export async function serviceStatus(wsl: Wsl, config: ResolvedConfig, workspace: Workspace): Promise<number> {
  const command = 'cd ' + quote(config.checkout) + ' && python3 scripts/dsh-superagent --profile ' +
    quote(workspace.profile) + ' --url ' + quote('http://127.0.0.1:' + String(workspace.port)) + ' status > /dev/null 2>&1'
  const result = await wsl.bash(command, { timeoutMs: 60_000 })
  return result.code
}

/**
 * Provision one workspace from nothing to a deployment that takes work.
 * @param input - distribution bridge, plugin configuration, the workspace, the operator account that may ask for
 *   work, and a progress report.
 * @returns the state directory the deployment was given.
 */
export async function provision(input: {
  wsl: Wsl
  config: ResolvedConfig
  workspace: Workspace
  /** GitHub login that may ask this deployment for work. */
  operator: string
  step: Step
}): Promise<{ stateDir: string }> {
  const { wsl, config, workspace, step } = input
  step('检查 ' + config.checkout + ' 的 dsh-superagent 检出')
  await ensureCheckout(wsl, config, step)
  const home = await homeOf(wsl)
  const stateDir = workspace.stateDir.length > 0 ? workspace.stateDir : stateDirFor(home, workspace.profile)
  const resolved = { ...workspace, stateDir }
  await ensureProfile(wsl, config, resolved, step)
  step('启动 ' + workspace.profile)
  const started = await startService(wsl, config, resolved)
  if (started !== undefined) throw new Error('the deployment did not start: ' + started)
  const cloneDir = home + '/src/' + workspace.repository.split('/')[1]
  await ensureClone(wsl, resolved, cloneDir, step)
  step('写入 Sources、Policy 与 Execution 设置')
  await applySettings(resolved.port, {
    repository: resolved.repository,
    agentCli: resolved.agentCli,
    allowedLogin: input.operator,
    cloneDir,
    writePrepare: true,
  })
  return { stateDir }
}
