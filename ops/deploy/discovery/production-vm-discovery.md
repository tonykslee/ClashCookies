# Production VM discovery operator guide

This guide accompanies `production-vm-discovery.sh`. It is a single, bounded, read-only evidence collection entry point for the next production-release gate. It does not deploy, migrate, start or stop containers, run backups, activate timers, modify Git, inspect credential contents, or claim that a VM was inspected by Codex.

## Review and boundary

Review the script and this guide in the draft PR before any operator executes it. The operator, not Codex, must run the command on the production VM. The script uses only fixed direct-argv commands and does not use `sudo`, SSH, `docker exec`, `docker compose config`, environment dumps, process arguments, full Docker inspect JSON, or unredacted wrapper/configuration output.

The script keeps bounded command output in a short-lived in-memory pipe and does not create a scratch or evidence file on the VM. Redirect stdout to a protected operator workstation or approved evidence sink only after reviewing the security policy for that sink. Stderr from inspected commands is suppressed.

The output is JSON Lines. Each record has `schema`, `evidence`, `status` (`PASS`, `FAIL`, or `UNKNOWN`), `observed_at`, `provenance=live-vm-read-only`, and a bounded sanitized `detail`. `PASS` describes only the observed probe; it is not production release authorization. `FAIL` describes an observed unsafe or contradictory condition. `UNKNOWN` includes command failure, missing resources, permissions, malformed output, timeouts, or an unconfigured protected path. A `summary` record reports counts and explicitly says that no VM execution was claimed and no production resource was changed.

## Operator invocation

Run from the VM's existing operator shell with the reviewed script copied or checked out in a separately approved read-only manner. Do not execute the legacy wrapper. Do not use `sudo` for this discovery bundle.

```bash
DISCOVERY_APP_DIR=/home/tilo/apps/clashcookies-prod \
DISCOVERY_WRAPPER_PATH=/home/tilo/deploy-prod.sh \
DISCOVERY_LOCK_PATH=/run/lock/clashcookies-prod-deploy.lock \
DISCOVERY_MIGRATION_LOCK_PATH=/run/lock/clashcookies-prod-migration.lock \
DISCOVERY_EXECUTOR_PATH=/home/tilo/deploy-assets/REVIEWED-HELPER.sh \
DISCOVERY_CREDENTIAL_PATH=/etc/clashcookies/production-db.env \
DISCOVERY_RELEASE_RECORD_PATH=/var/lib/clashcookies/release-record.ndjson \
bash ops/deploy/discovery/production-vm-discovery.sh
```

Replace only the resource paths that the operator has independently identified. Do not put a password, database URL, token, private key, monitoring URL, or file contents in an environment variable for this command. If an executor, credential, lock, or release-record path is not known, omit it and accept `UNKNOWN`; the script intentionally does not guess.

The single command is the complete execution entry point. The operator may save stdout as evidence outside the VM, but must not append to a release record, create a lock, run a service, enable a timer, alter ownership/mode, or clean residual staging resources.

## Evidence interpretation

The wrapper probe checks regular-file identity, SHA-256, owner, mode, size, path-component symlinks, and a stable before/after digest. It never executes or emits wrapper source. Its control-flow record contains only fixed marker counts and line ordering after redaction. Marker presence can establish that the file contains lock-related mechanics; it cannot establish that the deployed wrapper is the canonical shared-lock participant during a live run. If the probe is `UNKNOWN`, perform a separate controlled review: an authorized reviewer should read the exact wrapper from a protected terminal, verify the lock path and atomic acquisition/release order against `ops/deploy/deployment-lock.md`, inspect the old-runtime rollback branch, and record only redacted findings. Never paste the wrapper or secret-bearing lines into chat.

Runtime evidence is the Phase 2B collector contract expressed as fixed Docker and `ps` probes: running containers, selected non-secret labels, published/exposed ports, networks, host PID, and sanitized Node/npm/yarn cgroup correlation. The bounded internal validator delegates parsing and identity decisions to `ops/deploy/direct-docker-adapter.js`; it does not invent a separate singleton rule. The script does not collect command lines, environments, full labels, or database data. A healthy application container alone is insufficient: the direct-Docker app must be unambiguous and every potential host process must correlate or the result remains blocked.

Checkout evidence records HEAD, symbolic branch when available, tracked cleanliness, and a SHA-256 inventory digest/count for untracked files. Every Git probe runs with `GIT_OPTIONAL_LOCKS=0` so status inspection cannot take optional index locks or refresh index metadata. Filenames and contents are not emitted. Existing files, volumes, networks, and staging remnants are preserved.

Protected-resource records inspect only type, owner UID/GID, mode, size, symlink state, and a path fingerprint. The `*_metadata` evidence names and a `PASS` status mean only that the requested candidate path's observed metadata matched the probe; they are not proof of immutability, append-only protection, ownership readiness, or release authorization. Credential contents are never read. A missing path is `UNKNOWN`, not a pass. Release-record readiness is not proven by the existence of a file; append ownership, immutable/append-only protection, and the canonical protected location still require a separate reviewed check.

PostgreSQL is queried only when an operator-provided existing selection is available (`DISCOVERY_PG_SERVICE` or the already configured `PG*` variables). The identity query is a read-only transaction and reports database/role/schema/server identity and PostgreSQL major version without connection strings. The migration baseline is only a bounded count from `_prisma_migrations`. No grant, schema, migration, write, connection-string disclosure, or privilege escalation occurs. If least-privilege access is unavailable, the result is `UNKNOWN`.

Health probes are fresh localhost `/livez` and `/healthz` HTTP status checks. Capacity is read-only root disk/inode metadata. Monitoring probes inspect only named service/container presence and localhost status codes; bodies, tokens, and private URLs are not emitted. Backup status uses read-only `systemctl show`/`is-enabled`; it never starts the service or timer. Staging probes list matching container/network/volume names and deliberately distinguish observed residual resources from an approved staging waiver. No waiver is inferred.

## Required review questions after collection

The evidence bundle must be reviewed against the current `dev` source-of-truth documents, especially `docs/roadmaps/production-backup-readiness.md`, `docs/deployment.md`, `docs/diagnostics/production-deployment-lock-coordination-phase2a-2026-11-16.md`, the Phase 1 diagnostic, and `ops/deploy/deployment-lock.md`.

Do not convert this bundle into release authorization. The following remain separate gates and must be explicitly recorded as `PASS` or `BLOCKED`: actual wrapper adoption and shared-lock participation; exact deploy account and Docker/filesystem permissions; immutable executor and protected credential ownership; append-only release-record ownership; direct-Docker singleton/PID correlation; read-only PostgreSQL identity and migration compatibility; fresh backup/retrieval/restore and recovery-key custody; monitoring and alerting; staging isolation or an explicit reviewed waiver; migration-failure recovery; and release approval.

No VM execution is claimed by this repository change. Stop after the script is reviewed and, only if separately authorized, after the operator returns the sanitized evidence bundle. Do not merge this PR, deploy, run a migration, enable backup automation, recreate staging, or promote `dev` to `main` as part of discovery.
