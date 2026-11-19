# Vendored panel patches

`vendor/` is a copy of the upstream `dsh-superagent` panel, taken from
[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
at commit `8c32a9d` (2026-10-31, `main`). It stays under the upstream MIT license;
see `LICENSE` in this directory.

The panel is vendored rather than reimplemented because the project asks for the
same `dt-column` pages the deployment serves on WSL: the six tabs, the glossary,
the policy editor and the ticket evidence chain are upstream behaviour, and a
second implementation would drift from it.

## What is copied

| Upstream | Here |
| --- | --- |
| `src/client/*` except `index.tsx` | `vendor/client/*` |
| `src/app/api.ts` | `vendor/app/api.ts` (rewritten, see below) |
| `src/core/{errors,model,reasons,stage}.ts` | `vendor/core/*` (verbatim) |
| `src/infra/text.ts`, `src/setup.ts`, `src/admission.ts`, `src/limits.ts` | here (verbatim) |
| `src/sources/host.ts`, `src/sources/kind.ts` | here (trimmed to what the panel reads) |
| `LICENSE` | `vendor/LICENSE` |

`src/client/index.tsx` is not copied: the upstream entry registers the panel for
a deployment's own DSH process, while this plugin registers one panel for many
deployments and passes the deployment's proxy base into it.

## Patches

Four upstream files carry a `PATCHED` comment where they changed. Everything
else under `vendor/client/` is byte-identical to upstream.

1. `client/api.ts` — `api()` and `caller()` take a `base` path. Upstream calls
   its own host at `/orchestrator/api`; this page reaches a deployment through
   `/superagent-remote/<workspace>/orchestrator`, so the base is a parameter.
2. `client/provider.tsx` — `PanelProvider` takes the same `base` and rebuilds the
   caller when it changes, which also restarts the poll for the new workspace.
3. `client/app.tsx` — `App` takes `openMaster` (the main Session lives inside the
   deployment, not in this DSH process) and `base`, which it hands to the provider
   it mounts. The panel keeps its own provider: rendering it under a caller-mounted
   provider replaced its `navigate` callback and made every in-panel link inert,
   and leaving `base` unset made it call the DSH host instead of the deployment.

## Rewrites

- `app/api.ts` imports its response types from `app/view-types.ts` instead of
  from the host view modules. The upstream file derives them from the modules
  that build them, which would pull the whole host into the browser bundle's
  type graph. `view-types.ts` declares them loosely, and `tests/wire.spec.ts`
  pins the fields the panel reads against a recorded management API answer.
- `sources/host.ts` keeps `HEALTH_TEXT`, `HealthCode`, `Health`, and `health()`;
  the upstream host and context interfaces reach the store and the source
  registry, which the browser half may not import.
- `sources/kind.ts` keeps `Localized`, `FieldSpec`, and `AdmissionRowView`, which
  describe the settings and policy forms. The rest describes a Source plugin to
  the host.

## Updating

1. Export the new upstream tree and diff `src/client` against `vendor/client`.
2. Copy the changed files, then re-apply the four patches above.
3. Re-copy the support modules listed in the table and re-trim the two trimmed
   ones.
4. Run `pnpm typecheck` and `pnpm test`: `tests/wire.spec.ts` fails when the panel
   reads a field the management API no longer sends.
