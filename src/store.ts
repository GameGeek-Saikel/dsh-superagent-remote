/**
 * Persistent workspace registry.
 *
 * One small JSON file under the DeepSeek Harness home holds the workspaces and
 * the one piece of runtime ownership that must survive a restart: whether this
 * plugin started the WSL distribution, and therefore terminates it on exit.
 * Writes go through a sibling temporary file and a rename, so a crash leaves the
 * previous file intact.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One workspace record, as stored. */
export interface Workspace {
  id: string
  name: string
  /** owner/name on github.com. */
  repository: string
  /** The GitHub account the agent acts as. */
  agentLogin: string
  /** DSH profile inside the distribution. */
  profile: string
  /** Loopback port the deployment serves on inside the distribution. */
  port: number
  /** Absolute state directory inside the distribution. */
  stateDir: string
  /** Absolute path of the agent's GitHub CLI wrapper. */
  agentCli: string
  /** Whether the plugin starts this workspace with the rest. */
  enabled: boolean
  /** Whether the profile predates this plugin and was adopted rather than created. */
  adopted: boolean
  /** Whether the DSH profile loads dsh-superagent; false while provisioning is unfinished. */
  provisioned: boolean
  /** Whether the row is kept at the top of the project pane. */
  pinned?: boolean
  /** Whether the row is hidden from the pane unless archived rows are shown. */
  archived?: boolean
  /** Issue number of this workspace's one conversation, once it exists. */
  chatThread?: number
  createdAt: string
}

/** Shape of the stored file. */
export interface StoreFile {
  version: 1
  /** True when this plugin started the distribution and must terminate it on exit. */
  wslOwned: boolean
  /** True once the first-open import has run, so a removed workspace is not re-imported. */
  initialized: boolean
  /** Workspace that was open when the panel last closed, restored on the next open. */
  lastWorkspaceId?: string
  workspaces: Workspace[]
}

/** Default file: no workspaces, no ownership, and the first open still pending. */
export const EMPTY_STORE: StoreFile = { version: 1, wslOwned: false, initialized: false, workspaces: [] }

/**
 * Read one JSON store, tolerating a file another version wrote.
 * @param text - file contents.
 * @returns the parsed store, with unknown entries dropped.
 * @throws when the text is not JSON or not an object.
 */
export function parseStore(text: string): StoreFile {
  if (text.trim().length === 0) return { ...EMPTY_STORE, workspaces: [] }
  const value = JSON.parse(text) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the workspace file is not a JSON object')
  }
  const record = value as Partial<StoreFile>
  const workspaces = Array.isArray(record.workspaces) ? record.workspaces.filter(isWorkspace) : []
  return {
    version: 1,
    wslOwned: record.wslOwned === true,
    // A file written before this flag existed has already served its first open.
    initialized: typeof record.initialized === 'boolean' ? record.initialized : text.trim().length > 0,
    ...typeof record.lastWorkspaceId === 'string' && record.lastWorkspaceId.length > 0
      ? { lastWorkspaceId: record.lastWorkspaceId }
      : {},
    workspaces,
  }
}

/** Whether a stored entry has every field this version reads. */
function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.repository === 'string'
}

/**
 * Slug a display name into a workspace id.
 * @param name - what the operator typed.
 * @param taken - ids already in use.
 * @returns a lowercase id unique among `taken`.
 */
export function workspaceId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace'
  if (!taken.includes(base)) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = base + '-' + String(index)
    if (!taken.includes(candidate)) return candidate
  }
  return base + '-' + String(Date.now())
}

/** The workspace registry, cached in memory and written through on every change. */
export class WorkspaceStore {
  private file: StoreFile
  private constructor(private readonly path: string, file: StoreFile) {
    this.file = file
  }

  /**
   * Read the registry, treating a missing file as empty.
   * @param path - absolute path of the JSON file.
   * @returns the loaded store.
   * @throws when the file exists and cannot be parsed; the caller reports it instead of overwriting the file.
   */
  static async open(path: string): Promise<WorkspaceStore> {
    const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    return new WorkspaceStore(path, parseStore(text))
  }

  /** Every workspace, in creation order. */
  list(): Workspace[] {
    return this.file.workspaces.slice()
  }

  /** One workspace by id, or undefined. */
  get(id: string): Workspace | undefined {
    return this.file.workspaces.find(entry => entry.id === id)
  }

  /** Whether this plugin owns the running distribution. */
  get wslOwned(): boolean {
    return this.file.wslOwned
  }

  /** Whether the first-open import has already run. */
  get initialized(): boolean {
    return this.file.initialized
  }

  /** Record that the first-open import has run. */
  async setInitialized(initialized: boolean): Promise<void> {
    if (this.file.initialized === initialized) return
    this.file.initialized = initialized
    await this.save()
  }

  /** The workspace that was open when the panel last closed, if it still exists. */
  get lastWorkspaceId(): string | undefined {
    const id = this.file.lastWorkspaceId
    return id !== undefined && this.file.workspaces.some(entry => entry.id === id) ? id : undefined
  }

  /** Record the workspace the panel is showing; `undefined` forgets it. */
  async setLastWorkspace(id: string | undefined): Promise<void> {
    const current = this.lastWorkspaceId
    const next = id !== undefined && this.file.workspaces.some(entry => entry.id === id) ? id : undefined
    if (current === next) return
    if (next === undefined) delete this.file.lastWorkspaceId
    else this.file.lastWorkspaceId = next
    await this.save()
  }

  /** Record the open workspace on the calling thread, for shutdown. */
  setLastWorkspaceSync(id: string | undefined): void {
    const next = id !== undefined && this.file.workspaces.some(entry => entry.id === id) ? id : undefined
    if (next === undefined) delete this.file.lastWorkspaceId
    else this.file.lastWorkspaceId = next
  }

  /** Record whether this plugin started the distribution. */
  async setWslOwned(owned: boolean): Promise<void> {
    if (this.file.wslOwned === owned) return
    this.file.wslOwned = owned
    await this.save()
  }

  /** Record ownership on the calling thread, for shutdown. */
  setWslOwnedSync(owned: boolean): void {
    this.file.wslOwned = owned
  }

  /** Add a workspace and persist. */
  async add(workspace: Workspace): Promise<void> {
    this.file.workspaces = [...this.file.workspaces, workspace]
    await this.save()
  }

  /** Replace the fields given for one workspace and persist. */
  async update(id: string, patch: Partial<Workspace>): Promise<Workspace> {
    const index = this.file.workspaces.findIndex(entry => entry.id === id)
    if (index < 0) throw new Error('workspace ' + id + ' does not exist')
    const next = { ...this.file.workspaces[index]!, ...patch, id }
    this.file.workspaces = this.file.workspaces.map((entry, at) => at === index ? next : entry)
    await this.save()
    return next
  }

  /** Remove one workspace and persist. The deployment it named is left alone. */
  async remove(id: string): Promise<void> {
    this.file.workspaces = this.file.workspaces.filter(entry => entry.id !== id)
    if (this.file.lastWorkspaceId === id) delete this.file.lastWorkspaceId
    await this.save()
  }

  /** Write the file atomically. */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = this.path + '.tmp'
    await writeFile(temporary, JSON.stringify(this.file, undefined, 2) + '\n', 'utf8')
    await rename(temporary, this.path)
  }

  /** Write the file atomically on the calling thread, for shutdown. */
  saveSync(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = this.path + '.tmp'
    writeFileSync(temporary, JSON.stringify(this.file, undefined, 2) + '\n', 'utf8')
    renameSync(temporary, this.path)
  }

  /** Default location of the registry under a DeepSeek Harness home. */
  static location(home: string): string {
    return join(home, 'storages', 'dsh-superagent-remote', 'workspaces.json')
  }
}
