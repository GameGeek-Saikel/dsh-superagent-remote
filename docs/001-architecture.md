# 001 Architecture

## Concepts

| Concept | Definition |
|---|---|
| Workspace | One GitHub repository plus the dsh-superagent deployment that serves it: one DSH profile, one loopback port, one state directory. |
| Deployment | The `dsh --profile <profile>` process inside WSL2. Its management API is the only source of settings and runtime state. |
| Conversation | One issue thread per workspace. Every message is a comment that mentions the agent account, and the deployment answers in the same thread. |
| Project pane | The harness workspace sidebar's shape, mounted inside the panel: 36 px header, 34 px rows, pin/archive/search, draggable width. |
| Panel view | The deployment's vendored six-tab `dt-column` panel, proxied to one deployment at a time. |

## Data flow

```text
browser (DSH web)                     Windows host                        WSL2
┌──────────────────┐  /superagent-remote/api/*  ┌────────────────┐
│ workspace shell  │ ─────────────────────────► │ host plugin    │
│ conversation     │  /superagent-remote/:id/   │ runtime        │ ──► dsh --profile <p>
│ vendored panel   │ ─── orchestrator/api/* ──► │ reverse proxy  │     127.0.0.1:<port>
└──────────────────┘                            └────────────────┘
```

- Panel `GET state` and `PUT settings/...` pass through the proxy unchanged, so the panel edits the WSL deployment.
- Conversation text is read with the operator's Windows `gh`; working/paused state comes from the deployment's management API.
- A send is a GitHub comment (or the first issue) written with the operator's account and an `@<agent>` mention.
- Health is cached for 1.5 s per workspace, the operator login for 60 s, and the WSL running state for 1 s. The snapshot probes workspaces in parallel.

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: config, registry, `/superagent-remote` route, process-exit hook. |
| `src/routes.ts` | Same-origin check, JSON API, management-API reverse proxy. |
| `src/runtime.ts` | Health, tasks, start/stop/restart, create/adopt/remove, default project, UI address, shutdown. |
| `src/ports.ts` | Lowest-free loopback port above the base; probes the Windows side so a port another process holds is skipped. |
| `src/provision.ts` | Profile, bundle install, clone, service control inside WSL. |
| `src/settings-api.ts` | Source/Policy/Execution writes with revision retries; seeds the role-model presets. |
| `src/chat.ts` | Conversation model: issue thread, message roles, reply room. |
| `src/github.ts` | Windows `gh` bridge: issue list/detail/comment/create, body cleanup. |
| `src/store.ts` | Workspace registry and last-open workspace, atomically written JSON. |
| `src/wsl.ts` | `wsl.exe` bridge; scripts go through stdin. |
| `src/client/shell.tsx` | Workspace shell, project pane, action row, cached runtime, default project. |
| `src/client/conversation/*` | Conversation window, composer, Markdown parser, width handles, official running mark. |
| `src/client/cache.ts` | Last runtime/chat snapshot for the tab's first paint. |
| `src/client/official/OfficialPane.tsx` | The **Session** button that opens the deployment's own DSH in a new tab. |
| `src/client/selection.ts` | Selection and dialog requests shared with the right-sidebar tab. |

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/superagent-remote/api/runtime` | Distribution, workspaces, last open workspace, operator, checkout |
| POST | `/superagent-remote/api/runtime/start` | Kick off WSL boot and enabled workspace starts; answers the snapshot at once |
| POST | `/superagent-remote/api/active` | Remember the open workspace `{ id }` |
| GET | `/superagent-remote/api/discovery` | Profiles inside WSL that load dsh-superagent |
| POST | `/superagent-remote/api/adopt` | Register a running deployment |
| POST/PATCH/DELETE | `/superagent-remote/api/workspaces[/:id]` | Create / rename, enable, pin, archive / remove (stops and deletes the WSL deployment) |
| POST | `/superagent-remote/api/workspaces/:id/{start,stop,restart}` | Control one deployment |
| GET/POST | `/superagent-remote/api/workspaces/:id/chat` | Read the thread or send `{ text }` |
| GET | `/superagent-remote/api/workspaces/:id/ui` | Launch-token address of that deployment's own DSH |
| ANY | `/superagent-remote/:id/orchestrator/api/*` | Reverse proxy to the deployment's management API |

The same-origin check requires a loopback `Host` (or a configured `trustedHosts` authority) and, when present, a matching `Origin`.

## Lifecycle

1. Opening the panel sends `POST /runtime/start`. The host starts WSL if needed, imports running deployments once when `autoImport` is on and the registry has never been initialized, and starts enabled workspaces; the HTTP answer does not wait for any of it. The import flag is persisted, so deleting the last workspace does not bring its still-running deployment back.
2. A start that boots the distribution records `wslOwned: true`. Later opens reuse it.
3. Closing the panel, switching views, or closing the browser tab stops nothing.
4. The whole DSH process exits: enabled deployments are stopped in parallel (8 s each, 60 s cap). If the policy says to and the plugin owns the distribution, `wsl --terminate` runs and ownership resets to false.

A stopped distribution is never started just to stop services: stop and shutdown check `wsl --list --running` first.

## Why scripts travel on stdin

`wsl.exe` re-parses its command line and drops quoting inside a script argument. The discovery loop silently did nothing that way. All multi-line scripts therefore go through `wsl.exe ... bash -s` with the text on standard input; `exec` is only used for a single program with no quoting.

## Ports

`firstFreePort(base, taken)` starts at `portBase` (default 3081) and picks the lowest port that is neither in the registry nor bindable by another process on the Windows side. Removing a workspace stops its deployment and deletes that deployment's profile, state directory, and DSH session records inside WSL, so the port becomes free and the profile no longer appears in discovery; the next creation takes the port again instead of moving to the next number. Explicit ports are accepted only when they are unassigned and currently free.

Existing workspaces keep the port they were created with; changing a port would move a deployment a person already knows.

## Default project

Selecting a workspace sends `POST /api/active`. The registry stores `lastWorkspaceId`, the runtime snapshot returns it as `lastWorkspace`, and the shell opens it when the tab has no remembered selection of its own. The tab's `sessionStorage` selection wins first because it is what that tab is currently showing; `localStorage` keeps the same choice for a new tab or browser session, and the first non-archived workspace is the fallback before the host has recorded one.

## Conversation

The client paints the last `ChatView` from `sessionStorage` before the poll returns, then replaces it. Idle polling is 3 s; while an answer is expected it is 1.5 s. The transport is a GitHub comment, not a token stream, so there is no partial reply to render: an answer appears when the agent writes it.

Each agent answer keeps its own card, with the writer above and the answer below. The date sits in the action row under the card, next to the copy and link buttons, as the harness puts an assistant message's time. A reply bar is not rendered for an answer that follows the message it answers, so the card itself carries the context. User messages stay right-aligned bubbles.

The running mark is the official one: an APNG whale tail used as an alpha mask. The static 16×16 tail is the fallback for a browser that cannot paint an animated mask and for reduced-motion preferences; while the mask paints, the still tail is hidden so it cannot cover the moving one. The same `--dsw-alias-label-deep-diving` color, 12 px text, divider, and shimmer timing are used.

## Saving and switching

`usePoll` preserves the last value across dependency changes; the cache adds the first paint after a reload. Writes go to the plugin's JSON file through a sibling temporary file and rename; the last-open workspace and `wslOwned` live in the same file. A workspace switch rebuilds the panel provider so the vendored panel points at the new deployment.

## Vendored panel

The upstream six-tab panel, glossary, policy editor, and ticket evidence chain are copied rather than reimplemented. Four files carry a `PATCHED` note: the API base, provider base, `openMaster`, and the app's provider wiring. Details and the upgrade procedure are in `src/client/panel/PATCHES.md`.
