/**
 * Workspace shell for the Superagent panel.
 *
 * One workspace at a time, in two views: the conversation with the deployment,
 * and the deployment's own Superagent panel. The conversation is the harness
 * conversation window, built in ./conversation; the chat groups sit in a
 * collapsible pane on the right, shaped like the harness right sidebar.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { RuntimeView, WorkspaceView } from '../types.ts'
import { panelApi, type DiscoveryRow } from './api.ts'
import { dialogRequest, selection } from './selection.ts'
import { App } from './panel/vendor/client/app.tsx'
import { usePoll } from './panel/vendor/client/api.ts'
import { Button, Icon, Input, Modal, StateDot, type DotState } from './panel/vendor/client/controls.tsx'
import type { T as UpstreamT } from './panel/vendor/client/text.ts'
import type { Key, T } from './locales.ts'
import { Conversation } from './conversation/Conversation.tsx'
import { Glyph } from './conversation/icons.tsx'
import { WidthHandle } from './conversation/WidthHandle.tsx'
import { PANE_START, clampPane, sortWorkspaces, type ArchivedFilter } from './pane.ts'
import { OfficialButton } from './official/OfficialPane.tsx'
import { cache } from './cache.ts'

export type { T }

/** Which view was open. */
const VIEW = 'superagent-remote/view'
/** Whether the project pane was open. */
const PROJECTS = 'superagent-remote/projects-pane'
/** The project pane's width, so a reader's drag survives a reload. */
const PROJECTS_WIDTH = 'superagent-remote/projects-width'

const errorText = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)

/** Dot color for one workspace health phase. */
export function healthDot(health: WorkspaceView['health']): DotState {
  switch (health.phase) {
    case 'ready': return health.setup !== undefined ? 'warning' : health.paused === true ? 'idle' : 'done'
    case 'error': return 'error'
    case 'starting': return 'ongoing'
    case 'booting': return 'ongoing'
    default: return 'idle'
  }
}

/** One line describing the workspace's health. */
export function healthLabel(t: T, health: WorkspaceView['health']): string {
  if (health.setup !== undefined) return t('health.setup', { detail: health.setup.detail })
  if (health.phase === 'ready' && health.paused === true) return t('health.paused')
  return t(('health.' + health.phase) as Key)
}

/** Header of the whole panel: title, distribution state, operator account, pane toggle. */
/**
 * The header control that shows and hides the project pane.
 *
 * It keeps the glyph, size and corner position of the harness's right-sidebar
 * button; what it opens is the project pane inside this panel, because the
 * harness does not mount its right sidebar beside a global panel.
 */
function ProjectToggle({ t, open, onToggle }: { t: T; open: boolean; onToggle: () => void }) {
  const label = open ? t('proj.hide') : t('proj.show')
  return <button type="button" className="sar-expand" aria-label={label} title={label} aria-pressed={open}
    onClick={onToggle}>
    <svg width={16} height={16} aria-hidden><use href="#dsw-icon-panel-left-outline-regular" /></svg>
  </button>
}

function RuntimeBar({ t, runtime, starting, projectsOpen, onToggleProjects }: {
  t: T; runtime: RuntimeView | undefined; starting: boolean; projectsOpen: boolean; onToggleProjects: () => void
}) {
  const wsl = runtime?.wsl
  return <header className="sar-head">
    <div className="sar-head-title">
      <h1 className="sar-title">{t('title')}</h1>
      {starting && <span className="sar-pill sar-pill-busy">{t('wsl.starting')}</span>}
    </div>
    <div className="sar-toolbar">
      <span className="sar-pill" title={wsl?.owned === true ? t('wsl.owned') : t('wsl.kept')}>
        <StateDot state={wsl === undefined ? 'idle' : wsl.available === false ? 'error' : wsl.running ? 'done' : 'idle'} />
        <span>{wsl === undefined ? t('loading') : wsl.available === false ? t('wsl.unavailable')
          : wsl.running ? t('wsl.running', { distro: wsl.distro }) : t('wsl.stopped', { distro: wsl.distro })}</span>
      </span>
      <span className="sar-pill">
        <Icon name="user" size={13} />
        <span>{runtime === undefined ? t('loading') : runtime.operator.length > 0 ? t('operator.me', { login: runtime.operator }) : t('operator.none')}</span>
      </span>
      <ProjectToggle t={t} open={projectsOpen} onToggle={onToggleProjects} />
    </div>
  </header>
}

/**
 * The project pane.
 *
 * It reproduces the harness right sidebar's chrome — a tab strip with the pane's
 * name and a collapse glyph — over rows with the metrics of the left sidebar's
 * workspace rows: 34px tall, 12px radius, a folder glyph, and the name at 14px.
 */
export function ProjectPane({ t, workspaces, selected, width, onSelect, onNew, onFlags, onRemove, onNotice }: {
  t: T; workspaces: WorkspaceView[]; selected: string | undefined; width: number
  onSelect: (id: string) => void; onNew: () => void
  onFlags: (id: string, patch: { pinned?: boolean; archived?: boolean }) => void
  onRemove: (id: string) => void; onNotice: (text: string) => void
}) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [options, setOptions] = useState(false)
  const [showRepository, setShowRepository] = useState(false)
  // Archived rows stay in the list by default, as they do in the harness sidebar.
  const [archived, setArchived] = useState<ArchivedFilter>('show')
  const [menu, setMenu] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const search = useRef<HTMLInputElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // A menu opened by a button closes on the next press outside it.
  useEffect(() => {
    if (!options && menu === undefined) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (options && head.current?.contains(event.target) !== true) setOptions(false)
      if (menu !== undefined && list.current?.contains(event.target) !== true) { setMenu(undefined); setConfirming(undefined) }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menu, options])
  const open = (): void => {
    setSearching(true)
    requestAnimationFrame(() => search.current?.focus())
  }
  const clear = (): void => {
    setQuery('')
    search.current?.focus()
  }
  const needle = query.trim().toLowerCase()
  const ordered = sortWorkspaces(workspaces, archived)
  const shown = needle.length === 0 ? ordered
    : ordered.filter(workspace => (workspace.name + ' ' + workspace.repository).toLowerCase().includes(needle))
  const empty = needle.length > 0 ? t('proj.noMatch') : archived === 'only' ? t('proj.noneArchived') : t('rail.empty')
  const filters: [ArchivedFilter, string][] = [['hide', t('proj.hideArchived')], ['show', t('proj.allArchived')], ['only', t('proj.onlyArchived')]]
  return <aside className="sar-projects" aria-label={t('proj.label')} style={{ width: String(width) + 'px' }}>
    <div className="sar-proj-head" ref={head}>
      <span className="sar-proj-section" data-hidden={searching ? 'true' : undefined}>{t('proj.label')}</span>
      <div className="sar-proj-search" data-expanded={searching ? 'true' : undefined}>
        <button type="button" className="sar-proj-icon" aria-label={t('proj.search')} title={t('proj.search')}
          aria-expanded={searching} onClick={() => { if (searching) { clear(); setSearching(false) } else open() }}>
          <Glyph name="search-outline" size={14} />
        </button>
        <input ref={search} className="sar-proj-input" type="search" value={query}
          placeholder={t('proj.searchHint')} aria-label={t('proj.search')} maxLength={500}
          tabIndex={searching ? 0 : -1}
          onChange={event => setQuery(event.target.value)}
          onBlur={() => { if (query.length === 0) setSearching(false) }}
          onKeyDown={event => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            clear()
            setSearching(false)
          }} />
        {query.length > 0 && <button type="button" className="sar-proj-clear" aria-label={t('proj.clear')}
          title={t('proj.clear')} onClick={clear}>
          <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
          </svg>
        </button>}
      </div>
      <div className="sar-proj-actions" data-hidden={searching ? 'true' : undefined}>
        <button type="button" className="sar-proj-icon" aria-label={t('proj.options')} title={t('proj.options')}
          aria-expanded={options} onClick={() => { setOptions(!options); setMenu(undefined) }}>
          <Glyph name="sliders-two-outline" size={16} />
        </button>
        <button type="button" className="sar-proj-icon" aria-label={t('rail.new')} title={t('rail.new')}
          onClick={onNew}>
          <Glyph name="new-chat-outline" size={14} />
        </button>
      </div>
      {options && <div className="sar-proj-menu" role="menu">
        <p className="sar-proj-menu-label">{t('proj.filter')}</p>
        {filters.map(([value, label]) => <button key={value} type="button" role="menuitemradio"
          aria-checked={archived === value} className="sar-proj-menu-row"
          onClick={() => setArchived(value)}>
          <span>{label}</span>
          {archived === value && <Glyph name="check-outline" size={14} />}
        </button>)}
        <button type="button" role="menuitemcheckbox" aria-checked={showRepository} className="sar-proj-menu-row"
          onClick={() => setShowRepository(!showRepository)}>
          <span>{t('proj.showRepo')}</span>
          {showRepository && <Glyph name="check-outline" size={14} />}
        </button>
      </div>}
    </div>
    <div className="sar-proj-list" role="list" aria-label={t('proj.label')} ref={list}>
      {shown.map(workspace => <div key={workspace.id} className="sar-proj-item" role="treeitem"
        aria-selected={workspace.id === selected} tabIndex={0}
        data-archived={workspace.archived ? 'true' : undefined}
        data-menu={menu === workspace.id ? 'true' : undefined}
        aria-description={workspace.archived ? t('proj.archivedNotice') : undefined}
        title={workspace.repository}
        onClick={() => { if (workspace.archived) { onNotice(t('proj.archivedNotice')); return } onSelect(workspace.id) }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          if (workspace.archived) { onNotice(t('proj.archivedNotice')); return }
          onSelect(workspace.id)
        }}>
        <span className="sar-proj-name">{workspace.name}</span>
        <span className="sar-proj-resting">{workspace.archived ? t('proj.archivedTag') : healthLabel(t, workspace.health)}
          {workspace.pinned && !workspace.archived && <span className="sar-proj-pin" role="img"
            aria-label={t('proj.pinnedTag')} title={t('proj.pinnedTag')}>
            <Glyph name="pin-fill" size={14} />
          </span>}
        </span>
        <span className="sar-proj-acts">
          <button type="button" className="sar-proj-act" aria-label={t('proj.more')} title={t('proj.more')}
            aria-haspopup="menu" aria-expanded={menu === workspace.id}
            onClick={event => { event.stopPropagation(); setConfirming(undefined); setMenu(menu === workspace.id ? undefined : workspace.id) }}>
            <Glyph name="ellipsis-outline" size={16} />
          </button>
          <span className="sar-proj-quick">
            {workspace.archived
              ? <button type="button" className="sar-proj-act" aria-label={t('proj.unarchive')} title={t('proj.unarchive')}
                onClick={event => { event.stopPropagation(); onFlags(workspace.id, { archived: false }) }}>
                <Glyph name="unarchive-outline" size={14} />
              </button>
              : <>
                <button type="button" className="sar-proj-act" aria-label={t('proj.archive')} title={t('proj.archive')}
                  onClick={event => { event.stopPropagation(); onFlags(workspace.id, { archived: true }) }}>
                  <Glyph name="archive-outline" size={14} />
                </button>
                <button type="button" className={'sar-proj-act' + (workspace.pinned ? ' sar-proj-act-pinned' : '')}
                  aria-label={workspace.pinned ? t('proj.unpin') : t('proj.pin')}
                  title={workspace.pinned ? t('proj.unpin') : t('proj.pin')}
                  onClick={event => { event.stopPropagation(); onFlags(workspace.id, { pinned: !workspace.pinned }) }}>
                  <Glyph name={workspace.pinned ? 'pin-fill' : 'pin-outline'} size={14} />
                </button>
              </>}
          </span>
        </span>
        {menu === workspace.id && <div className="sar-proj-item-menu" role="menu">
          {confirming === workspace.id ? <>
            <p className="sar-proj-menu-question">{t('proj.removeHint')}</p>
            <button type="button" role="menuitem" className="sar-proj-menu-row"
              onClick={() => { setMenu(undefined); setConfirming(undefined); onRemove(workspace.id) }}>
              <span>{t('proj.confirmRemove')}</span>
            </button>
            <button type="button" role="menuitem" className="sar-proj-menu-row"
              onClick={() => { setConfirming(undefined); setMenu(undefined) }}>
              <span>{t('proj.keep')}</span>
            </button>
          </> : <>
            <button type="button" role="menuitem" className="sar-proj-menu-row"
              onClick={() => { setMenu(undefined); onFlags(workspace.id, { archived: !workspace.archived }) }}>
              <span>{workspace.archived ? t('proj.unarchive') : t('proj.archive')}</span>
            </button>
            <button type="button" role="menuitem" className="sar-proj-menu-row"
              onClick={() => { setMenu(undefined); onFlags(workspace.id, { pinned: !workspace.pinned }) }}>
              <span>{workspace.pinned ? t('proj.unpin') : t('proj.pin')}</span>
            </button>
            <button type="button" role="menuitem" className="sar-proj-menu-row"
              onClick={() => { setMenu(undefined); window.open('https://github.com/' + workspace.repository, '_blank', 'noopener,noreferrer') }}>
              <span>{t('proj.openRepo')}</span>
            </button>
            <button type="button" role="menuitem" className="sar-proj-menu-row"
              onClick={() => setConfirming(workspace.id)}>
              <span>{t('proj.remove')}</span>
            </button>
          </>}
        </div>}
      </div>)}
      {shown.length === 0 && <p className="sar-proj-hint">{empty}</p>}
    </div>
  </aside>
}

/** Progress of the task the host is running for this workspace. */
function TaskStrip({ t, workspace }: { t: T; workspace: WorkspaceView }) {
  const task = workspace.task
  if (task === undefined) return null
  if (task.error !== undefined) {
    return <p className="sar-banner sar-banner-error" role="alert"><strong>{t('error.title')}</strong>
      <span>{task.error}</span></p>
  }
  if (task.finishedAt !== undefined) return null
  return <p className="sar-banner" role="status"><span className="sar-spin" aria-hidden />
    <span>{task.step}</span><span className="dt-hint">{task.kind}</span></p>
}

/** Actions offered for the selected workspace. */
function WorkspaceActions({ t, workspace, busy, onStart, onStop, onRestart, onToggle, onRemove, onError }: {
  t: T; workspace: WorkspaceView; busy: boolean
  onStart: () => void; onStop: () => void; onRestart: () => void; onToggle: () => void; onRemove: () => void
  onError: (text: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const running = workspace.health.phase === 'ready' || workspace.health.phase === 'starting'
  return <div className="sar-actions">
    {running
      ? <Button size="sm" icon={<Icon name="stop" size={14} />} disabled={busy} onClick={onStop}>{t('ws.stop')}</Button>
      : <Button size="sm" variant="primary" icon={<Icon name="play" size={14} />} disabled={busy} onClick={onStart}>{t('ws.start')}</Button>}
    <Button size="sm" icon={<Icon name="refresh" size={14} />} disabled={busy} onClick={onRestart}>{t('ws.restart')}</Button>
    <OfficialButton t={t} workspace={workspace} onError={onError} />
    <Button size="sm" icon={<Icon name={workspace.enabled ? 'pause' : 'play'} size={14} />} onClick={onToggle}>
      {workspace.enabled ? t('ws.disable') : t('ws.enable')}</Button>
    {confirming
      ? <>
        <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>{t('cancel')}</Button>
        <Button size="sm" variant="primary" icon={<Icon name="trash" size={14} />} onClick={onRemove}
          title={t('proj.removeHint')}>{t('ws.remove')}</Button>
      </>
      : <Button size="sm" icon={<Icon name="trash" size={14} />} onClick={() => setConfirming(true)}>{t('ws.remove')}</Button>}
  </div>
}

/** The deployment's own Superagent panel. */
function PanelPane({ workspace, upstreamT }: { workspace: WorkspaceView; upstreamT: UpstreamT }) {
  // Sessions named by the panel live in the deployment's own DSH process, which this
  // client cannot address, so the button reports that instead of doing nothing.
  const noSession = async () => {
    throw new Error('这个 Session 在 WSL 内的 DSH 进程里，本客户端无法打开；请到那台机器的面板查看。')
  }
  return <div className="sar-panel">
    <App t={upstreamT} openSession={noSession} deploymentForm={undefined} openMaster={false} base={workspace.basePath} />
  </div>
}

/** Create form for a new workspace. */
function NewWorkspaceDialog({ t, open, onClose, onCreated }: {
  t: T; open: boolean; onClose: () => void; onCreated: (workspace: WorkspaceView) => void
}) {
  const [name, setName] = useState('')
  const [repository, setRepository] = useState('')
  const [agentLogin, setAgentLogin] = useState('')
  const [agentCli, setAgentCli] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      const created = await panelApi.create({
        name: name.trim(), repository: repository.trim(), agentLogin: agentLogin.trim(),
        ...agentCli.trim().length > 0 ? { agentCli: agentCli.trim() } : {},
      })
      setName(''); setRepository(''); setAgentLogin(''); setAgentCli('')
      onCreated(created)
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return <Modal open={open} onClose={onClose} title={t('form.new')} closeLabel={t('close')} description={t('form.newHint')}
    footer={<>
      <Button onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" type="submit" icon={<Icon name="plus" size={14} />} disabled={busy}
        onClick={() => { void submit(new Event('submit') as unknown as FormEvent) }}>
        {busy ? t('form.creating') : t('form.create')}
      </Button>
    </>}>
    <form className="sar-form" onSubmit={submit}>
      <label className="sar-field">
        <span>{t('form.name')}</span>
        <Input value={name} onChange={event => setName(event.target.value)} placeholder="demo-project" />
        <small>{t('form.nameHint')}</small>
      </label>
      <label className="sar-field">
        <span>{t('form.repository')}</span>
        <Input value={repository} onChange={event => setRepository(event.target.value)} placeholder="owner/name" />
        <small>{t('form.repositoryHint')}</small>
      </label>
      <label className="sar-field">
        <span>{t('form.agentLogin')}</span>
        <Input value={agentLogin} onChange={event => setAgentLogin(event.target.value)} placeholder="agent-account" />
        <small>{t('form.agentLoginHint')}</small>
      </label>
      <label className="sar-field">
        <span>{t('form.agentCli')}</span>
        <Input value={agentCli} onChange={event => setAgentCli(event.target.value)} placeholder="/root/.local/bin/gh-agent" />
        <small>{t('form.agentCliHint', { cli: '/root/.local/bin/gh-agent' })}</small>
      </label>
      {failure !== undefined && <p className="sar-banner sar-banner-error" role="alert">{failure}</p>}
    </form>
  </Modal>
}

/** Import form for a deployment that already runs inside WSL. */
function ImportDialog({ t, open, onClose, onAdopted }: {
  t: T; open: boolean; onClose: () => void; onAdopted: (workspace: WorkspaceView) => void
}) {
  const [rows, setRows] = useState<DiscoveryRow[] | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    setRows(undefined)
    setFailure(undefined)
    panelApi.discovery().then(value => setRows(value.items)).catch(error => setFailure(errorText(error)))
  }, [open])
  const adopt = async (row: DiscoveryRow) => {
    setBusy(row.profile)
    setFailure(undefined)
    try {
      onAdopted(await panelApi.adopt(row.profile, row.port))
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setBusy(undefined)
    }
  }
  return <Modal open={open} onClose={onClose} title={t('form.import')} closeLabel={t('close')} description={t('form.importHint')}
    footer={<Button onClick={onClose}>{t('close')}</Button>}>
    <div className="sar-form">
      {rows === undefined && failure === undefined && <p className="dt-hint">{t('form.importLoading')}</p>}
      {rows !== undefined && rows.length === 0 && <p className="dt-hint">{t('form.importNone')}</p>}
      {rows?.map(row => <div key={row.profile} className="sar-import-row">
        <div className="sar-import-main">
          <span className="sar-import-profile">{row.profile}</span>
          <span className="dt-hint">{row.repository ?? row.stateDir ?? ''}{row.port !== undefined ? ' · :' + String(row.port) : ''}</span>
        </div>
        {row.adopted
          ? <span className="sar-chip">{t('form.importAdopted')}</span>
          : <Button size="sm" variant="outline" disabled={busy !== undefined}
            onClick={() => { void adopt(row) }}>{busy === row.profile ? t('loading') : t('form.importAdd')}</Button>}
      </div>)}
      {failure !== undefined && <p className="sar-banner sar-banner-error" role="alert">{failure}</p>}
    </div>
  </Modal>
}

/** The two views of one workspace, in the shape of the conversation view tabs. */
type View = 'chat' | 'panel'

function ViewTabs({ t, view, onChange }: { t: T; view: View; onChange: (next: View) => void }) {
  const views = [['chat', t('view.chat')], ['panel', t('view.panel')]] as const
  return <div className="sar-views" role="tablist" aria-label={t('title')}>
    {views.map(([value, label]) => <button key={value} type="button" role="tab" className="sar-view"
      aria-selected={view === value} tabIndex={view === value ? 0 : -1} onClick={() => onChange(value)}>
      <span>{label}</span></button>)}
  </div>
}

/** The whole panel. */
export function WorkspaceApp({ t, upstreamT }: { t: T; upstreamT: UpstreamT }) {
  const runtime = usePoll(() => panelApi.runtime(), [], 5_000)
  // The last snapshot this tab saw paints at once; the poll replaces it.
  const [cached] = useState<RuntimeView | undefined>(() => cache.runtime())
  const data = runtime.data ?? cached
  const [starting, setStarting] = useState(true)
  const [banner, setBanner] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  // A short, neutral notice; the pane's archived-row hint uses it.
  const say = (text: string): void => {
    setNotice(text)
    window.setTimeout(() => setNotice((current) => current === text ? undefined : current), 3_000)
  }
  const selectedId = useSyncExternalStore(selection.subscribe, selection.get)
  const requested = useSyncExternalStore(dialogRequest.subscribe, dialogRequest.get)
  const [view, setView] = useState<View>(() => {
    try {
      const stored = window.sessionStorage.getItem(VIEW)
      return stored === 'panel' ? stored : 'chat'
    } catch { return 'chat' }
  })
  const [dialog, setDialog] = useState<'new' | 'import' | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [detected, setDetected] = useState<DiscoveryRow[] | undefined>(undefined)
  const [projectsOpen, setProjectsOpen] = useState<boolean>(() => {
    try { return window.sessionStorage.getItem(PROJECTS) === 'open' } catch { return false }
  })
  const [projectsWidth, setProjectsWidth] = useState<number>(() => {
    try {
      const stored = Number(window.localStorage.getItem(PROJECTS_WIDTH))
      return Number.isFinite(stored) && stored > 0 ? clampPane(stored) : PANE_START
    } catch { return PANE_START }
  })
  const opened = useRef(false)
  const empty = data !== undefined && data.workspaces.length === 0

  useEffect(() => {
    if (opened.current) return
    opened.current = true
    panelApi.start()
      .then(() => runtime.reload())
      .catch(error => setBanner(errorText(error)))
      .finally(() => setStarting(false))
  }, [runtime])

  // The cache is the first paint only; replace it with what the poll returns.
  useEffect(() => {
    if (runtime.data !== undefined) cache.saveRuntime(runtime.data)
  }, [runtime.data])

  // With nothing registered, show what the machine already runs.
  useEffect(() => {
    if (!empty) return
    let active = true
    panelApi.discovery()
      .then(value => { if (active) setDetected(value.items.filter(item => !item.adopted)) })
      .catch(() => { if (active) setDetected([]) })
    return () => { active = false }
  }, [empty])

  useEffect(() => {
    try { window.sessionStorage.setItem(VIEW, view) } catch { /* view memory is a convenience */ }
  }, [view])
  useEffect(() => {
    try { window.sessionStorage.setItem(PROJECTS, projectsOpen ? 'open' : 'closed') } catch { /* pane memory is a convenience */ }
  }, [projectsOpen])
  useEffect(() => {
    try { window.localStorage.setItem(PROJECTS_WIDTH, String(projectsWidth)) } catch { /* width memory is a convenience */ }
  }, [projectsWidth])
  // A dialog asked for from the right-sidebar tab opens here, where the forms live.
  useEffect(() => {
    if (requested === undefined) return
    setDialog(requested)
    dialogRequest.set(undefined)
  }, [requested])

  const workspaces = data?.workspaces ?? []
  // The session's own choice wins; then the workspace that was open when the
  // panel last closed; then the first live, non-archived row.
  const selected = workspaces.find(workspace => workspace.id === selectedId)
    ?? workspaces.find(workspace => workspace.id === data?.lastWorkspace && !workspace.archived)
    ?? workspaces.find(workspace => workspace.id === selection.last() && !workspace.archived)
    ?? workspaces.find(workspace => !workspace.archived)
    ?? workspaces[0]
  // Remember what the panel is showing, so the next browser session starts here.
  const remembered = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (selected === undefined || remembered.current === selected.id) return
    remembered.current = selected.id
    if (selected.id !== data?.lastWorkspace) void panelApi.activate(selected.id).catch(() => undefined)
  }, [selected, data?.lastWorkspace])

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setBanner(undefined)
    try { await run() } catch (error) { setBanner(errorText(error)) } finally {
      setBusy(false)
      await runtime.reload()
    }
  }

  const adoptOrCreate = (workspace: WorkspaceView) => {
    selection.set(workspace.id)
    setView('chat')
    setDialog(undefined)
    void runtime.reload()
  }

  return <div className="sar-root" data-projects={projectsOpen && selected !== undefined ? 'open' : undefined}>
    <div className="sar-main">
      <RuntimeBar t={t} runtime={data} starting={starting} projectsOpen={projectsOpen}
        onToggleProjects={() => setProjectsOpen(!projectsOpen)} />
      {notice !== undefined && <p className="sar-banner" role="status">{notice}</p>}
      {banner !== undefined && <p className="sar-banner sar-banner-error" role="alert">
        <span>{banner}</span><Button size="sm" onClick={() => setBanner(undefined)}>{t('close')}</Button></p>}
      {runtime.error !== undefined && <p className="sar-banner sar-banner-error" role="alert">
        <span>{errorText(runtime.error)}</span><Button size="sm" onClick={() => void runtime.reload()}>{t('retry')}</Button></p>}
      {selected === undefined
        ? <div className="sar-blank">
          <h2 className="sar-h2">{t('rail.empty')}</h2>
          <p className="dt-hint">{t('rail.emptyHint')}</p>
          <div className="sar-actions">
            <Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => setDialog('new')}>{t('rail.new')}</Button>
            <Button variant="outline" icon={<Icon name="inbox" size={14} />} onClick={() => setDialog('import')}>{t('rail.import')}</Button>
          </div>
          {detected !== undefined && detected.length > 0 && <section className="sar-detected">
            <p className="sar-label">{t('chat.detected')}</p>
            <p className="dt-hint">{t('chat.detectedHint')}</p>
            {detected.map(row => <div key={row.profile} className="sar-import-row">
              <div className="sar-import-main">
                <span className="sar-import-profile">{row.profile}</span>
                <span className="dt-hint">{row.repository ?? row.stateDir ?? ''}{row.port !== undefined ? ' · :' + String(row.port) : ''}</span>
              </div>
              <Button size="sm" variant="outline" disabled={busy}
                onClick={() => void act(async () => { adoptOrCreate(await panelApi.adopt(row.profile, row.port)) })}>
                {t('form.importAdd')}
              </Button>
            </div>)}
          </section>}
        </div>
        : <>
          <div className="sar-ws-head">
            <div className="sar-ws-title">
              <StateDot state={healthDot(selected.health)} />
              <h2 className="sar-h1">{selected.name}</h2>
              <a className="dt-inline-link" href={'https://github.com/' + selected.repository} target="_blank" rel="noopener noreferrer">
                {selected.repository}</a>
              {selected.adopted && <span className="sar-chip">{t('ws.adopted')}</span>}
              {!selected.enabled && <span className="sar-chip">{t('ws.disabled')}</span>}
            </div>
            <WorkspaceActions t={t} workspace={selected} busy={busy}
              onStart={() => void act(() => panelApi.startWorkspace(selected.id))}
              onStop={() => void act(() => panelApi.stopWorkspace(selected.id))}
              onRestart={() => void act(() => panelApi.restartWorkspace(selected.id))}
              onToggle={() => void act(() => panelApi.update(selected.id, { enabled: !selected.enabled }))}
              onError={setBanner}
              onRemove={() => void act(async () => {
                await panelApi.remove(selected.id)
                selection.set(undefined)
              })} />
          </div>
          <p className="sar-ws-meta">
            <span>{healthLabel(t, selected.health)}</span>
            <span className="dt-hint">{t('ws.detail', { profile: selected.profile, port: String(selected.port) })}</span>
          </p>
          <TaskStrip t={t} workspace={selected} />
          <ViewTabs t={t} view={view} onChange={setView} />
          <div className="sar-body">
            {view === 'chat'
              ? <Conversation key={selected.id} t={t} workspace={selected} onOpenProjects={() => setProjectsOpen(true)} />
              : <PanelPane key={selected.id} workspace={selected} upstreamT={upstreamT} />}
          </div>
        </>}
    </div>
    {projectsOpen && selected !== undefined && <div className="sar-pane-edge">
      <WidthHandle side="left" className="sar-pane-handle" scale={1}
        onStart={() => projectsWidth}
        onDrag={next => setProjectsWidth(clampPane(next))}
        onCommit={next => setProjectsWidth(clampPane(next))} />
    </div>}
    {projectsOpen && selected !== undefined && <ProjectPane t={t} workspaces={workspaces} selected={selected.id}
      width={projectsWidth} onSelect={id => { selection.set(id); setView('chat') }} onNew={() => setDialog('new')}
      onFlags={(id, patch) => { void act(() => panelApi.update(id, patch)) }}
      onRemove={id => { void act(async () => { await panelApi.remove(id) }) }} onNotice={say} />}
    <NewWorkspaceDialog t={t} open={dialog === 'new'} onClose={() => setDialog(undefined)} onCreated={adoptOrCreate} />
    <ImportDialog t={t} open={dialog === 'import'} onClose={() => setDialog(undefined)} onAdopted={adoptOrCreate} />
  </div>
}