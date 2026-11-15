# DBH P1 production baseline and Phase A rollback preflight — 2026-11-15

**Status:** investigation complete; Phase A production introduction and any Phase B activation remain **BLOCKED pending separate approval and release gates**.

**Scope:** documentation-only preflight. No application deployment, branch promotion, environment-variable change, database mutation, backup, restore, cleanup, service start, timer enablement, privilege change, or staging recreation was performed.

**Evidence window:** 2026-11-15 UTC. Live droplet observations below were collected at the timestamps shown. Credentials, tokens, passwords, private keys, and environment values other than the requested flag/mode classifications were intentionally not displayed.

## Executive result

The actual production baseline is now established:

- **Production checkout/revision:** `main` at `0d2a49bbc33fe42bfbac56a2583e7d114b71cfad`.
- **Deployed DBH content:** the live checkout and compiled runtime contain neither the Phase A compatibility reader nor the Phase B v2 writer.
- **Effective v2-write flag:** **OFF** because `PLAYER_SIGNAL_STATE_V2_WRITES_ENABLED` is absent from the production container environment.
- **Runtime health:** production `/livez` and `/healthz` returned HTTP 200; the app is active production mode.
- **Backup/recovery:** **BLOCKED**. The backup service is inactive, the timer is disabled/inactive, no local backup artifact was found in the runner staging directory, and the dated off-host evidence is only transport/harmless-test evidence, not a real production database backup and restore.
- **Staging gate:** **BLOCKED**. The documented staging deployment was decommissioned; both `127.0.0.1:8086/livez` and `/healthz` were unreachable.

The exact Phase A-compatible code artifact is merge commit `a3fc53f6bffa82e937e331fbf541849ccc221ab0` (PR #1998 merged to `dev`). It reads v1/v2 state and writes v1; it does not contain the Phase B environment gate. It is the correct rollback target after a future v2 write, but it is **not yet deployment-ready**: the live-to-artifact diff also includes the already-merged Dusk wallet migration/schema change, so migration compatibility and the normal production recovery gates must be completed before deployment.

## Repository and GitHub baseline

| Check | Result | Evidence/source |
| --- | --- | --- |
| Local checkout | **PASS** — clean at start on `dev`; `origin/dev` matched `4deb78ae9c110d70b09e2b3f43ae95ead78f27a6` | `git status --short --branch`, `git log`; session checkout |
| Remote `dev` | **PASS** — `4deb78ae9c110d70b09e2b3f43ae95ead78f27a6` | `git ls-remote origin refs/heads/dev` |
| Remote `main` | **PASS** — `0d2a49bbc33fe42bfbac56a2583e7d114b71cfad` | `git ls-remote origin refs/heads/main` |
| DBH diagnosis PR | **PASS** — PR #1997 merged to `dev`; CI `checks` succeeded | GitHub PR metadata, `13dad59caac7c78e3f4c78923c57244b1ace73c0` |
| Phase A compatibility PR | **PASS** — PR #1998 merged to `dev`; CI `checks` succeeded | GitHub PR metadata, merge `a3fc53f6bffa82e937e331fbf541849ccc221ab0` |
| Phase B gated-write PR | **PASS** — PR #1999 merged to `dev`; CI `checks` succeeded | GitHub PR metadata, merge `4deb78ae9c110d70b09e2b3f43ae95ead78f27a6` |
| Open release path | **BLOCKED** — PR #1983 remains a draft `dev` → `main` release PR | GitHub PR metadata |
| Open PR duplication | **PASS** — no open PR targeting `dev` was returned by the session check; this preflight uses one new docs-only PR | GitHub PR list |

The Phase A and Phase B implementation slices change only the DBH diagnostic, `src/services/ActivitySignalService.ts`, and its focused tests. The live-to-Phase-A diff is broader than that slice: it includes `prisma/migrations/20261112120000_add_dusk_wallet_ledger_foundation/migration.sql` and `prisma/schema.prisma` from earlier work on `dev`.

## Live production evidence

### Runtime and deployment checkout

Observed from the droplet using read-only SSH/operator commands:

| Observation | Result | Timestamp/source |
| --- | --- | --- |
| Host | Ubuntu 24.04, `clashcookies` | 2026-11-15T09:39:06Z; SSH read-only probe |
| Production checkout | `/home/tilo/apps/clashcookies-prod`, owner `tilo:tilo`, mode `775` | 2026-11-15T09:41:37Z; `stat` |
| Checkout revision | `0d2a49bbc33fe42bfbac56a2583e7d114b71cfad`, branch `main` | 2026-11-15T09:41:55Z; `git -c safe.directory=...` |
| Checkout hygiene | Seven untracked audit/config files present; no checkout update was made | 2026-11-15T09:39:06Z/09:41:55Z; `git status` |
| App container | `clashcookies-app`, image `node:20-bookworm`, up 3 days, `127.0.0.1:8085 → 8080` | 2026-11-15T09:40:25Z; `docker ps` |
| Actual runtime mount | Host checkout bind-mounted at `/app`; Yarn cache and `node_modules` are volumes | 2026-11-15T09:40:25Z; `docker inspect` |
| Startup script | `bash ./ops/deploy/container-start.sh` via Docker entrypoint | 2026-11-15T09:40:25Z; `docker inspect` |
| Runtime mode | `POLLING_MODE=active`, `POLLING_ENV=prod` | 2026-11-15T09:41:37Z; read-only environment-name/value filter |
| Production liveness | HTTP 200 from `http://127.0.0.1:8085/livez` | 2026-11-15T09:40:25Z |
| Production readiness | HTTP 200 from `http://127.0.0.1:8085/healthz`; database and Discord checks reported OK | 2026-11-15T09:40:25Z |

The checkout is the runtime source of truth because it is bind-mounted into `/app` and the container starts the repository script. The exact deployment invocation/account audit trail is not present in the container metadata. The checkout owner is `tilo:tilo`; the container uses the image default user. Treat the precise host-side release operator identity as **UNKNOWN** until the operator records the deploy command/account used for a reviewed release.

### Phase A / Phase B presence

The following read-only checks were made against the actual mounted source and compiled runtime at `2026-11-15T09:41:37Z`:

- `/app/src/services/ActivitySignalService.ts`: the Phase A/B markers were **ABSENT**.
- `/app/dist/services/ActivitySignalService.js`: the Phase A/B markers were **ABSENT**.
- Local repository inspection confirms that `main` at `0d2a49bb` has only the v1 implementation, while `a3fc53f6` introduces `PLAYER_SIGNAL_STATE_FINGERPRINT_VERSION = 2` and the compatibility reader.

**Conclusion:** production is neither Phase A nor Phase B. It is the pre-DBH v1 runtime.

### Effective v2-write flag

The only requested environment value was classified; no other environment values were printed.

| Flag | Production result | Evidence |
| --- | --- | --- |
| `PLAYER_SIGNAL_STATE_V2_WRITES_ENABLED` | **OFF — UNSET** | 2026-11-15T09:40:25Z; container environment filter |

The source contract in `docs/diagnostics/database-health-player-signal-state.md` and `src/services/ActivitySignalService.ts` recognizes only `1`, `true`, `yes`, and `on` (case-insensitive, surrounding whitespace ignored) as enabled. An absent, false, empty, or invalid value is OFF. No environment change was made.

## Backup, recovery, staging, and monitoring gates

| Gate | Classification | Current evidence and consequence |
| --- | --- | --- |
| Backup service/timer state | **PASS for unchanged safety / BLOCKED for release** | At 2026-11-15T09:40:25Z, `clashcookies-backup.service` was loaded/static/inactive/dead and `clashcookies-backup.timer` was loaded/disabled/inactive with no next trigger. Neither was started or enabled. |
| Current local backup artifact | **UNKNOWN/BLOCKED** | `/var/lib/clashcookies-backup` contained no files at the 09:41:37Z read-only check. This does not prove off-host state. |
| Off-host production backup | **BLOCKED** | The 2026-11-14 operator record documents B2 listing/transport and harmless encrypted test-object recovery only. It explicitly says no real production dump/encryption/upload or retained production object verification was performed. |
| Independent disposable restore | **BLOCKED** | No real encrypted production object has been retrieved, decrypted, inspected, or restored into disposable PostgreSQL 17. A prior local restore is not sufficient. |
| Backup monitoring | **PARTIAL/BLOCKED** | Prior harmless failure-alert transport was verified, but successful-backup delivery and independent expected-object freshness monitoring remain unverified. |
| Production health | **PASS** | `/livez` and `/healthz` were HTTP 200 at 09:40:25Z. |
| Monitoring availability | **PARTIAL** | `clashcookies-uptime-kuma` and `clashcookies-dozzle` were running/healthy at 09:40:25Z; port probes returned 302/307. Netdata was absent and port 19999 was unreachable. |
| Staging mirror gate | **BLOCKED** | Staging was documented as decommissioned; 8086 liveness/readiness probes failed with connection refused at 09:43:35Z. No staging evidence or waiver exists in this preflight. |
| Migration-failure recovery | **UNKNOWN/BLOCKED** | The Phase A artifact includes the Dusk wallet migration relative to live `main`; representative existing-schema validation and a tested migration-failure recovery path remain required. |

The isolated backup runner also requires provenance recheck: `/opt/clashcookies` was observed at `15677f03796f14c098af8d7dad22888bd691acde` on `dev` with a modified `yarn.lock` at 2026-11-15T09:41:55Z. This is not clean-runner evidence for a future production backup.

## Exact Phase A-compatible rollback artifact

**Candidate:** `a3fc53f6bffa82e937e331fbf541849ccc221ab0`, the merge commit for PR #1998 (`feature/dbh-signal-compatibility` → `dev`).

Why it is the correct compatibility boundary:

1. It contains the Phase A v1/v2 reader/comparator and exact legacy canonicalization.
2. It has no `PLAYER_SIGNAL_STATE_V2_WRITES_ENABLED` gate and continues to write v1 state.
3. It can read a valid v2 record, so it remains safe after a later Phase B v2 write when the flag is disabled.
4. PR #1999's Phase B work is a descendant of this merge commit; `a3fc53f6` is therefore the reviewed pre-Phase-B compatibility point, not an invented or duplicate branch.

The older production `main` artifact is **not** the post-v2 rollback target. Its v1-only parser would treat v2 state as missing and can create false freshness/activity. After any v2 write, disable the flag and roll back only to a v2-reading Phase A-compatible artifact (or a later v2-aware artifact with the same safety properties). Code rollback does not undo database migrations or restore prior data values.

### Provenance and deployment-readiness checks still required

Before treating `a3fc53f6` as deployable, a reviewed operator must record:

1. Exact source SHA, clean checkout, remote ref, PR #1998 merge provenance, and successful CI checks.
2. A reproducible locked-dependency build from that SHA; compiled `dist` must be produced from the same clean source and its image/artifact digest recorded.
3. The complete `0d2a49bb..a3fc53f6` diff review, including the Dusk wallet migration/schema change. Validate the migration against a safe representative existing-schema database and document migration-failure recovery; do not infer this from a fresh database or CI alone.
4. A reviewed production deployment plan identifying the operator account, container/image creation path, checkout hygiene, health gate, log checks, and exact `OLD_SHA` recovery procedure.
5. A pre-deployment flag check proving the v2 flag remains absent/OFF, followed by a post-deployment check with no credential values displayed.
6. Health-gated production verification and a bounded observation window covering normal activity observation, v1/v2 read compatibility, freshness, and error signals. No backfill or mass rewrite is part of this step.
7. Explicit confirmation that the Phase B gate remains OFF and that no v2 rows were written before any decision to use the artifact as a rollback target.

## Proposed later activation and rollback sequence

This sequence is a proposal for a separately approved change; it authorizes nothing by itself.

### Stage 0 — approval and gates

- Keep `dev` and `main` separate; do not merge PR #1983 or promote `dev` automatically.
- Close the backup/recovery gate with a recent encrypted off-host production backup, independent disposable PostgreSQL 17 restore, key custody, retention, expected-object monitoring, and success/failure alert verification.
- Resolve the absent staging gate with a reviewed staging deployment or an explicit waiver. Confirm the production migration-failure recovery plan and deploy identity.

### Stage 1 — Phase A introduction with Phase B disabled

- Build and package the exact reviewed Phase A artifact from `a3fc53f6` after the checks above.
- Capture the live `OLD_SHA` (`0d2a49bb` at this preflight), the Phase A artifact SHA/digest, migration diff, and rollback command before changing production.
- Confirm `PLAYER_SIGNAL_STATE_V2_WRITES_ENABLED` is unset/recognized OFF.
- Use the documented health-gated deployment path. Because the live-to-artifact diff includes Prisma files, use the intentional migration-deploy path, not the non-migration parallel-container assumption.
- Verify `/healthz` HTTP 200, `/livez` HTTP 200, active production mode, database/Discord readiness, bounded logs, and monitoring state. Record the actual deployed image/artifact digest and runtime checkout.

### Stage 2 — observation

- Observe the agreed number of normal production observation cycles with the flag still OFF.
- Compare aggregate-only activity/freshness/error evidence against the pre-change baseline. Do not print player tags, payloads, credentials, or full environment values; do not run a backfill or cleanup.
- Stop and classify UNKNOWN/BLOCKED if health, parity, freshness, malformed-state, or migration evidence is incomplete.

### Stage 3 — later Phase B activation

- Only after Phase A is independently verified as the rollback target and the release gates are green, obtain a separate approval to set the v2-write flag ON.
- Record the exact flag change, time, operator, deployed artifact digest, and observation window. Verify the effective state without displaying other environment values.
- Observe conversion/write/error/version aggregates and retain the ability to set the flag OFF immediately. No data restore or mass rewrite is an emergency response.

### Rollback decision tree

1. **Before the first v2 write:** set/confirm the flag OFF, then the reviewed Phase A artifact is the preferred rollback target; an older v1-only artifact is only a separate release decision.
2. **After any v2 write:** set the flag OFF first, verify OFF, and roll back code only to the Phase A-compatible v2-reading artifact (or a later reviewed equivalent). Do not roll back to production `main`'s v1-only artifact.
3. **If migration/startup fails:** follow the documented migration-failure recovery path; do not assume code rollback reverses a committed migration. Keep database restore separate and require the verified recovery gate.
4. **If activity parity or malformed-state evidence is uncertain:** leave writes OFF, keep affected records read-only for diagnosis, preserve logs/aggregate evidence, and obtain a new reviewed decision.

## Final classification and approval boundary

| Acceptance item | Classification |
| --- | --- |
| Actual deployed revision established | **PASS** — `0d2a49bb` on `main`; it contains neither Phase A nor Phase B |
| Effective v2-write flag established | **PASS** — `UNSET/OFF` |
| Phase A rollback target identified | **PASS as a candidate / BLOCKED as deployable** — `a3fc53f6`; provenance is clear, production validation is pending |
| Backup service/timer unchanged and classified | **PASS** — inactive/disabled; no action taken |
| Real encrypted off-host backup and independent restore | **BLOCKED** |
| Staging/release gate | **BLOCKED** — staging absent; waiver or deployment required |
| Runtime health and monitoring | **PASS for current production health; PARTIAL for monitoring** — Kuma/Dozzle available, Netdata absent |
| Precise activation/rollback proposal | **PASS** — staged above, subject to later approval |
| Production state modified by this preflight | **NO** |

No Phase A deployment, Phase B activation, backup, restore, timer enablement, service start, database write, privilege change, or `dev` → `main` promotion is authorized by this document.
