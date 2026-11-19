# 002 Runbook

## Prerequisites

| Item | Requirement | Check |
|---|---|---|
| WSL2 | A distribution is installed and `wsl.exe` answers | `wsl -l -v` |
| Networking | `networkingMode=mirrored`, so Windows can reach `127.0.0.1:<port>` inside the distribution | `Get-Content $env:USERPROFILE\.wslconfig` |
| Upstream checkout | The official Node/TypeScript dsh-superagent; cloned, then `pnpm install` and `pnpm build`, once on first provisioning | `wsl -d Ubuntu-22.04 -u root -- test -d /root/dsh-superagent/lib && echo ok` |
| Distribution tools | `python3`, `tmux`, `git`, `dsh` | `command -v` in the same `wsl` call |
| Windows `gh` | Signed in as the operator (writes issue and comments) | `gh auth status` |
| Agent CLI | `/root/.local/bin/gh-agent` inside the distribution, signed in as the agent | `wsl … -- /root/.local/bin/gh-agent api user --jq .login` |

## Install and upgrade

```powershell
cd D:\Projects\dsh-plugins\dsh-superagent-remote
pnpm install; pnpm check
dsh plugin --profile web add link:D:\Projects\dsh-plugins\dsh-superagent-remote
# restart dsh web; the sidebar shows Superagent
```

Upgrade with `pnpm check`, then restart `dsh web`: the browser loads the client bundle by build revision, and the host half only reloads with the process.

Uninstall with `dsh plugin --profile web remove @gamegeek-saikel/dsh-superagent-remote`. Registered workspaces stay in `<DSH_HOME>/storages/dsh-superagent-remote/workspaces.json`.

## Ports

| Port | Use |
|---|---|
| 3080 | The Windows DSH web server |
| 3081 | First Superagent workspace (`portBase`) |
| 3082, 3083, … | Next lowest free port, reused after a workspace is removed |

Windows and the distribution share the port in mirrored mode. A port another program holds is skipped, and an explicit port is refused when it is taken. Removing a project stops its deployment, deletes its profile and state directory inside WSL, and frees its port for the next project. The checkout clone under `~/src` is kept. Existing workspaces keep their recorded port.

## First workspace

1. Open the panel. Running deployments are imported automatically; stopped ones are listed in the empty state and can be registered with **Import**.
2. **New project conversation** asks for `owner/name` and the agent account, then: checks the checkout, clones it and runs its setup once when missing → creates the DSH profile → writes port and state directory → installs the bundle → starts the deployment → clones the repository → writes Sources / Policy / Execution through the management API. A create whose provisioning failed can be retried with **Start**. Setup is marked under `<checkout>/.artifacts`; remove that marker to run it again.
3. The task strip reports each step. A failed step names the reason and can be retried with Start.

A new workspace seeds its main Session with Low reasoning effort and its Executor with Max effort, using the deployment's default model. The preset is written once at provisioning; an existing workspace keeps the model selection its Sessions recorded. Change it in that deployment's Superagent → Settings panel.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "wsl.exe is not on this machine" | WSL is not installed; verify `wsl --version` |
| "WSL distribution failed to start" | Wrong distribution name or a broken WSL service; verify `wsl -d <distro> -u root -- true` |
| Workspace stays stopped | Press **Start**; the task strip shows the `scripts/dsh-superagent` exit reason |
| Panel tab says it cannot reach dsh-superagent | Proxy 502: the deployment is down, the port is wrong, or `networkingMode` is not mirrored |
| Panel looks empty although deployments run | The host half only reloads with the process: restart `dsh web`. On first open, running deployments are imported; stopped ones are in the empty state under Import |
| Chat is empty or `gh` errors | Windows `gh` is not signed in as the operator; verify `gh auth status` |
| Message sent but the agent does not answer | ① The deployment's GitHub Source does not observe the repository's Issues and comments — the plugin turns both on for new workspaces; check Settings → Sources for old ones. ② The account is not in the Policy allow list. ③ The message does not mention the agent |
| New workspace hangs on "installing dsh-superagent" | `dsh plugin add` needs npm; check network and the `/root/dsh-superagent` path |
| WSL still runs after DSH exits | The distribution was not started by the plugin (`wslOwned=false`); set `terminateWslOnExit: always` |
| **Session** reports the deployment is not running | Start the deployment first; the button only opens a live deployment's launch-token address |
| The panel shows the previous chat for a moment | The tab paints its cached snapshot before the poll replaces it; it is not stale data after the first second |

## Conversation delivery

The conversation is written as issues and comments; delivery depends on the deployment's GitHub Source. Two read modes exist:

| Mode | When it applies |
|---|---|
| Repository observation ("Receive new Issues", "Receive comments") | Default; the plugin turns both on when it provisions a workspace, so delivery does not depend on notification timing |
| `@` notifications | Fallback when observation is off: the Source checks the agent's notification box, then reads the issue it points at |

Notification-only delivery can lose messages: a notification may arrive after the polling cursor has passed the issue's creation time, and the Source silently drops it.

## Closing and stopping

Closing the page, switching panels, or refreshing the browser stops nothing. Only the entire `dsh web` process exit stops the deployments and, per `terminateWslOnExit`, terminates the distribution. To stop one deployment immediately, use **Stop** in its action row.

## Data and backup

| Location | Content |
|---|---|
| `<DSH_HOME>/storages/dsh-superagent-remote/workspaces.json` | Workspaces, last-open workspace, `wslOwned` |
| `~/.dsh/profiles/<profile>/` inside the distribution | One deployment's DSH profile |
| `<stateDir>/orchestrator.sqlite` | The deployment's ticket database; back it up before upgrading upstream |

## Relation to the manual setup

An existing manual checkout (for example `D:\Projects\dsh-superagent` with its own start scripts) is independent of this plugin. Once the plugin manages a deployment, do not also run the manual start script for it: the upstream service's duplicate-instance guard makes one of the two fail.
