# Production VM adapter Phase 1 — discovery and implementation boundary

**Repository:** `tonykslee/ClashCookies`
**Base:** `dev`
**Reviewed source:** `6b85f95de815f0e97c3a0323ba20cc4cc347a32f`
**Status:** development/test evidence and proposed adapter boundary only. No VM installation or production execution was performed by this change.

## Operator-verified production findings

These values are the supplied operator snapshot for Phase 1. They are not an independent VM inspection by CI or this repository change and must be rechecked before any production release.

| Area | Finding | Adapter consequence |
| --- | --- | --- |
| Production checkout | `/home/tilo/apps/clashcookies-prod`, production `main` at `0d2a49bbc33fe42bfbac56a2583e7d114b71cfad` | Preserve the checkout and all seven existing untracked files. |
| Legacy entry point | `/home/tilo/deploy-prod.sh`, SHA-256 `ae5af2b09ca329553a55da633d0c3699f97d3559ecc65197dbf9d7cf91aeb507`, owner `codex:codex`, mode `755` | Do not modify or replace it in Phase 1. |
| App runtime | Direct Docker container `clashcookies-app`, `node:20-bookworm`, host port `127.0.0.1:8085` | Adapter must not infer that Compose owns the app. |
| Database runtime | Compose-managed `clashcookies-db` | Compose may be inspected for database topology, but app lifecycle remains direct-Docker. |
| Network and services | Network `clashcookies-prod_default`; Compose services `app` and `db` | Expected network is an explicit identity gate. |
| Health | `/livez` and `/healthz` returned HTTP 200 in the supplied snapshot | Fresh probes remain required before release. |
| Capacity | Approximately 6.48 GiB available | Recheck root/Docker capacity and inode headroom before any release. |
| Backup | Backup timer disabled/inactive | No backup activation is implied or performed. |
| Credentials | Production `.env` reported as `tilo:tilo`, mode `664` | This is not an acceptable protected migration-credential boundary. |
| Lock and records | No established deployment lock or release-record directory | Adapter configuration must remain blocked until ownership is established. |
| Host processes | One possible Node process identified; singleton not proven | Process names remain potential-candidate evidence only. |
| Retained resources | Old staging network and replacement volumes remain | No cleanup is permitted by Phase 1. |

## Implemented Phase 1 infrastructure

`ops/deploy/direct-docker-adapter.js` now provides:

- fail-closed adapter configuration validation;
- direct-Docker container, volume, and network metadata parsers using exact `|` field counts;
- canonical runtime and expected-network validation without requiring Compose ownership labels;
- potential host-process detection that never claims singleton proof;
- verified container-PID/container-ID correlation for host-visible runtime processes;
- immutable executor checksum/ownership/mode validation;
- protected credential-source validation;
- strict migration-child environment construction;
- distinct release-lock and runner-lock validation;
- bounded, secret-rejecting append-only release-record support; and
- an operation surface matching the migration-aware orchestrator.

The adapter is disabled without explicit verified configuration. All production-dependent mutating operations and migration execution remain blocked by an unconditional Phase 1 execution gate; configuration flags cannot enable them.

The migration runner now constructs its child environment from an allowlist instead of inheriting the full parent environment.

## Unresolved production requirements

- Direct inspection of the live legacy wrapper control flow and its actual lock behavior.
- Exact deploy-account Docker, Git, sudo, lock, credential, and release-record permissions.
- Root-owned immutable executor placement and installation procedure.
- Protected database credential source with mode/ownership proof.
- One host-level release lock shared by legacy, non-migration, and migration paths.
- Append-only release-record location, ownership, retention, and access controls.
- Runtime singleton proof including unlabeled containers and independent host processes.
- Read-only database identity and migration-baseline verification.
- Fresh health, monitoring, disk, inode, backup, staging-waiver, and historical-compatibility evidence.

Successful isolated tests do not close these VM gates and do not authorize installation, deployment, migration, backup activation, staging recreation, or `dev` to `main` promotion. Release PR #1983 remains draft and blocked.
