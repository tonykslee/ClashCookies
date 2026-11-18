# ClashCookies — Production Deployment Installation Readiness

**Repository:** `tonykslee/ClashCookies`

**Base reviewed:** `dev` at `650c6c37c3e8c7f5a1d94490bdb169906e6f0494`

**Assessment date:** 2026-11-17 (repository and documentation review)
**Status:** installation readiness **BLOCKED**; documentation and repository evidence only

This document closes the documentation and planning portion of the production deployment installation-readiness blocker. It defines the proposed boundary for a separately managed immutable deployment entry point, the protected resources that must be verified before installation, and the authorization gates for a safe handoff from the legacy wrapper.

No production VM was accessed or modified for this assessment. No credentials were read or created. No Docker or database command, migration, backup, timer activation, lock acquisition, release-record write, collector execution, wrapper execution, staging change, or release promotion was performed. The pre-existing untracked repository file `powershell` was preserved.

The terms **implemented**, **repository-only**, **proposed**, **observed**, **UNKNOWN**, and **BLOCKED** are intentional. A passing offline fixture is not live VM evidence, and a proposed path is not the production configuration.

## Executive summary

The repository-side deployment safety chain is substantially implemented and tested:

1. Immutable executor validation binds the approved path, SHA-256, owner/mode and canonical parent chain to OS-backed operator identity and stable device/inode evidence.
2. The offline integration guard composes that validation with the direct-Docker adapter and migration-aware orchestrator. A successful result is bounded verification evidence only.
3. The direct-Docker adapter validates the expected active runtime, host PID/container identity, protected credential metadata, lock paths and release-record boundary.
4. The shared outer lock and distinct inner migration lock have a tested repository contract. Terminal release records are written before outer-lock release.
5. The migration runner is isolated from the application startup path and runs the explicit `migrate:deploy` command once, with database identity and migration-manifest checks.
6. The migration-aware orchestrator is fail-closed and has mocked success/failure/recovery coverage. Its default VM-dependent operations remain unsupported.

The installation blocker is the missing separately reviewed VM integration. The live `/home/tilo/deploy-prod.sh` is a legacy wrapper and does not demonstrate participation in the canonical shared-lock contract. The actual immutable executor, outer lock, inner migration lock, protected credential source, append-only release-record target, fresh operator identity, and deployed startup artifact remain unresolved or require fresh verification. The versioned helper, adapter, collector and orchestrator are not installed or authorized to mutate production. `PHASE1_EXECUTION_ENABLED=false` remains enforced.

Therefore:

- the installation gate is **BLOCKED**, not PASS;
- offline verification cannot authorize execution;
- the optional orchestrator integration guard must not be described as universal protection; and
- the safe next milestone is a separately authorized, read-only production verification of the legacy wrapper, checkout, runtime/database topology, startup artifact and protected-resource metadata.

## Verified architecture and implementation status

### Deployment topology that must be preserved

The intended production topology remains a direct-Docker application runtime with a Compose-managed PostgreSQL database. The canonical application contract is:

- one active production runtime named `clashcookies-app`;
- `POLLING_MODE=active` and `POLLING_ENV=prod`;
- loopback health endpoints at `127.0.0.1:8085/livez` and `127.0.0.1:8085/healthz`, mapped to the application container port 8080;
- application runtime on the expected production network, with direct-Docker ownership rather than Compose ownership;
- PostgreSQL remaining Compose-managed and separate from the direct-Docker application lifecycle; and
- staging remaining mirror-mode only if it is restored and separately validated. The dated operator evidence says staging was decommissioned, so a staging pass cannot be assumed.

The repository cannot establish the current live runtime, database identity, Compose file location or deployed checkout. Those require a fresh authorized operator check.

### Complete proposed path

| Stage | Repository evidence | Status | Boundary and remaining gap |
| --- | --- | --- | --- |
| Immutable executor validation | `validateImmutableExecutor()` in `ops/deploy/direct-docker-adapter.js`; protected-path fixtures in `tests/direct-docker-adapter.test.ts` | Implemented and tested offline | Validates synthetic fixtures only. No VM-installed executor, trusted live identity or approved production SHA has been verified. |
| Offline integration guard | `ops/deploy/offline-deployment-integration.js`; `tests/offline-deployment-integration.test.ts` | Implemented and tested offline | A valid result is `status=PASS` plus `productionExecutionEnabled=false`; it stops before the clock, lock, records and deployment operations. It is an optional orchestrator hook, not universal protection for calls that omit it. |
| Direct-Docker adapter | `ops/deploy/direct-docker-adapter.js`; direct-Docker and runtime-evidence tests | Repository-only, fail-closed | The adapter validates runtime evidence and protected resources but is not wired to a production CLI, installed on the VM, or enabled to mutate production. |
| Shared deployment lock | `ops/deploy/deployment-lock.js`, `ops/deploy/deployment-lock.md`, `ops/deploy/deploy-prod.sh`; cross-process lock tests | Implemented and tested as a repository contract | The live legacy wrapper has not been proven to acquire this lock. Its actual lock path and parent remain unresolved. |
| Migration-aware orchestrator | `ops/deploy/migration-aware-deploy.js`; `tests/migration-aware-deploy.test.ts` | Implemented and tested with injected operations | Default VM-dependent operations deliberately refuse execution. The success path is simulated; no end-to-end VM adapter exists. |
| Migration runner | `ops/deploy/migration-runner.js`, `npm run migrate:runner`; `tests/migration-runner.test.ts` | Implemented and tested in isolation | Performs SHA, manifest, protected database identity and inner-lock checks, then invokes only `npm run migrate:deploy`. It is not installed or authorized on the VM. |
| Release-record handling | Adapter append-only validators; orchestrator terminal-record tests | Repository contract implemented; production sink unresolved | Records are bounded and sanitized in the tested path. The actual production location, ownership, retention and append-only protection do not exist as verified VM facts. |
| Runtime promotion and recovery | `ops/deploy/deploy-prod.sh`, orchestrator state machine, `production-migration-recovery-runbook.md` | Non-migration helper implemented; migration promotion repository-only | The versioned helper preserves unknown files, builds without production secrets, refuses Prisma changes and health-gates one runtime. Migration promotion/recovery is not installed or production-authorized. Old-runtime restart after a migration or failed health is intentionally not automatic. |

### Specific safety findings

- `PHASE1_EXECUTION_ENABLED` is a source-level constant set to `false` in `ops/deploy/direct-docker-adapter.js`. Mutating operations and migration execution fail closed even when configuration requests them.
- `offline-deployment-integration.js` returns bounded evidence only. `runMigrationAwareDeployment()` rejects an offline-only PASS before `ops.now()`, outer-lock acquisition, release-record handling or any injected deployment operation. Missing, malformed or production-enabled integration results also fail closed.
- The guard is supplied through the orchestrator's optional `integrationGuard` hook. Tests intentionally show that calls without the hook retain the separately tested orchestrator contract; the hook is not a universal protection layer. No document or operator procedure may treat a standalone offline PASS as production authorization.
- The repository lock contract uses one shared outer directory lock and a distinct inner migration-runner lock. The runner never acquires the outer lock, preventing recursive acquisition. Existing lock state is never treated as stale and is never removed by guesswork.
- The versioned non-migration helper keeps the direct-Docker application and Compose database topology separate. It refuses Prisma changes before stopping production, uses a build-only candidate without production credentials, preserves unknown files and promotes only one health-gated runtime.
- The current `dev` startup contract is explicit: `package.json` maps `migrate:deploy` to `prisma migrate deploy`, `start` to build plus `start:runtime`, and `start:runtime` to `node dist/ClashCookies.js`; `container-start.sh` calls `npm run start`. The deployed startup artifact must still be checked independently before relying on this repository fact.
- No reviewed production VM mutation primitive has been installed, and no production deployment capability has been activated. Repository code, mocked operations and synthetic fixtures are not VM installation evidence.

## Proposed protected-resource manifest

The following is an installation manifest proposal, not a report of current production paths. Every path marked `UNRESOLVED` must remain unknown until a separately authorized read-only VM verification identifies the exact regular file/directory and records its ownership, mode, symlink status and identity. The examples below are design candidates only.

| Resource | Proposed path or value | Required identity and permissions | Symlink and file-identity rules | Read / execute / modify boundary | Verification and evidence | VM fact still required |
| --- | --- | --- | --- | --- | --- | --- |
| Immutable deployment entry point | `UNRESOLVED`; design candidate: `/home/tilo/deploy-assets/clashcookies-prod-deploy-<approved-commit>.sh` outside the mutable checkout | Proposed regular file owned by a separately approved administrative UID/GID, mode `0755`; the deployment operator may execute/read but must not write; exact UID/GID/mode are unresolved | No symlinked file or parent; canonical `realpath`, complete numeric `dev`/`ino`, descriptor identity and subsequent parent-chain identity must match | Approved operator: execute/read. Administrative owner: replace only through a separately approved installation. Deploy operator: no modify, rename or unlink. | `validateImmutableExecutor()` and its fixtures prove the offline contract. The existing design in `docs/deployment.md` requires a hash-pinned helper outside the checkout. | Exact installed path, owner, mode, SHA-256, parent chain, ACLs and operator access. The live legacy wrapper is not this resource. |
| Immutable executor and approved SHA-256 | `UNRESOLVED`; SHA-256 is `UNRESOLVED` until the exact reviewed artifact is selected and installed | Same protected owner as the entry point; mode must not grant operator write access; approved SHA-256 must match both the release record and file bytes | Reject symlink/replacement; hash the verified regular-file descriptor/path under the protected identity checks | Only the approved entry point may execute it. No mutable checkout path or `ops/deploy` copy may be the production executor. | PRs #2053 and #2055 establish offline hash/identity and non-execution behavior; PR #2055 is merged in `83c1fd66`. | Exact reviewed commit, installed file hash, install provenance, and independent post-install hash. |
| Administrative ownership and deployment operator identity | `UNRESOLVED` | Administrative owner UID/GID and deployment operator UID/GID/groups require separate approval. The operator identity must be bound to OS-backed `process.getuid()`, `process.getgid()` and `process.getgroups()` evidence; no caller-supplied claim is sufficient | Identity evidence is not a path; reject missing, malformed or contradictory evidence | Operator may execute and inspect only the approved surface. Administrative account may provision/revoke protected resources. No implicit `sudo`, Docker, database or credential access follows from repository access | Dated operator evidence reported `tilo` as UID/GID `1000:1000` with `docker` membership, but it is not fresh evidence for this installation gate | Fresh approved account, UID/GID/groups, effective permissions, and named administrative owner. |
| Canonical parent-directory chain | `UNRESOLVED`; proposed parent chain for an approved asset directory must be outside the mutable checkout | Every parent must be a canonical directory, owned by the approved administrative owner or approved root/deploy group, with no operator write access; proposed mode is `0755` for non-writable administrative parents unless a tighter approved mode is required | No symlink/reparse component; record complete numeric `dev`/`ino` for each parent and verify again after opening the executor | Operator may traverse and execute; only the administrative owner may create/replace protected files | Immutable executor validation walks and rechecks the full parent chain in offline fixtures | Exact parent paths, ownership/modes, ACLs, mount boundary and stable identity. |
| Shared outer deployment-lock parent and lock path | `UNRESOLVED`; repository default `/run/lock/clashcookies-prod-deploy.lock` is only an unverified candidate, not configuration | Proposed parent: root-owned or approved lock-admin-owned directory with write permission only for the named deploy operator/group. Lock directory is created atomically by the runner with a restrictive umask and one owner record; exact UID/GID/modes are unresolved | Parent and lock path must not be symlinked. Existing lock state is not stale-cleaned, guessed or deleted. Owner record is exclusive-created and identity-checked on release | All coordinated entry points may attempt atomic acquisition; only the holder may release its matching directory and owner record. No arbitrary modification or recursive cleanup | `deployment-lock.js` and cross-process tests prove atomic directory acquisition, owner/path checks and non-recursive release. Dated VM evidence says no lock path was established | Exact parent/path, owner/group/mode, existing-state classification and proof the legacy wrapper participates. |
| Separate inner migration-lock parent and lock path | `UNRESOLVED`; must be distinct from the outer lock and outside the checkout | Same protected lock-parent policy; exact UID/GID/modes unresolved. Only the one-shot migration runner may acquire/release it inside the already-held outer lock | No symlink; no inference from a filename; no recursive acquisition of the outer lock | Migration runner only; non-migration helper and legacy wrapper must not acquire it directly | `migration-runner.js` requires `MIGRATION_LOCK_PATH`; `deployment-lock.md` defines distinct lock ordering and tests reject equal paths | Exact path, parent metadata, owner policy and evidence that it is distinct from the outer lock. |
| Protected migration credential source | `UNRESOLVED`; do not select or read the production `.env` as a substitute | Proposed regular file or approved secret mechanism owned by an administrative UID/GID, mode `0600` or stricter. Exact UID/GID, ACL and mechanism are unresolved | No symlinked components; `O_NOFOLLOW`, descriptor identity and replacement checks; contents must never be printed, hashed into public evidence or stored in records | Migration runner may read only the database credential. Application token, guild IDs, cloud credentials and monitoring values must not enter the child environment | Adapter contract requires an external protected source and strict child allowlist. Dated evidence identified `/home/tilo/apps/clashcookies-prod/.env` as `0664`; if it contains the credential it fails this boundary. | Exact source type/path, owner/mode/ACL, secret-delivery mechanism and proof that only the migration child receives it. |
| Append-only release-record location and ownership | `UNRESOLVED`; historical `/var/lib/clashcookies/release-record.ndjson` is an absent candidate, not a selected path | Proposed parent/file owned by an approved administrative/release-record owner with restricted reader access and a reviewed append-only writer boundary; exact UID/GID/modes, ACL and retention are unresolved | No symlink; regular-file descriptor opened with no-follow and identity rechecked. Reject replacement, multiline, oversized, URL-shaped, password/token/private-key content. Do not infer append-only protection from existence or mode alone | Orchestrator may append bounded sanitized records while holding the outer lock. Reviewers may read through the approved evidence path. No truncate, rewrite, rotate or delete in the deployment path | Adapter tests cover sanitization and append-only descriptor checks; orchestrator tests require terminal record before outer-lock release and fail ambiguous on write failure | Exact parent/file, owner/group/mode/ACL, append-only enforcement, retention, backup and reviewer access. |
| Preflight authorization/evidence storage | `UNRESOLVED`; outside the mutable checkout and outside public/chat storage | Proposed regular file with restricted operator/reviewer read access, mode `0600` or stricter; exact owner/GID/mode unresolved | No symlink; bind evidence to release ID, OLD_SHA, NEW_SHA, migration digests, approver and gate results; recheck identity before use | Named release operator may read; no production operation may write or replace it during execution | `verifyPreflightEvidence()` requires exact target, authorization digest and all required gates PASS. Offline tests prove malformed/mismatched evidence blocks | Exact path, owner/mode, evidence provenance, retention and replacement protection. |
| Candidate worktree | Proposed by the versioned helper as `${APP_DIR}-replacement`; with the documented app directory this is `/home/tilo/apps/clashcookies-prod-replacement`, but it is not verified live | Owned by the deploy operator for the bounded build; restrictive mode and no pre-existing path. Exact UID/GID/mode unresolved | Must be absent before creation, nonsymlinked and proven to be the owned Git worktree at the expected NEW_SHA before cleanup | Candidate builder may read/write only the candidate; it receives no production secrets, active polling mode, production network or startup helper. Cleanup may remove only the owned worktree | `deploy-prod.sh` checks the exact replacement path, refuses an existing path, and removes only an owned worktree. | Live parent ownership/mode, absence/collision state and operator ability to create/remove only this candidate path. |
| Runtime identity | Proposed contract: exactly one `clashcookies-app`, active/prod, direct-Docker, expected loopback port/network, expected revision and correlated host PID/container ID | Runtime/container identity is evidence, not a protected file. Exact image, port, network, labels, PID/cgroup and revision must be recorded; no second bot-like runtime | No reliance on Compose labels or process names alone; ambiguous or uncorrelated candidates are UNKNOWN/FAIL | Read-only inspection before stop; only a separately approved primitive may stop/start the one verified runtime | Direct-Docker adapter and collector contract; dated operator evidence observed `clashcookies-app`, but one host Node process was not conclusively classified | Fresh runtime inventory, host PID/cgroup correlation, health and revision identity. |
| Database identity and topology | Proposed contract: Compose-managed PostgreSQL identity proven by read-only query; exact path/name/role are `UNRESOLVED` | Database host, port, name, role, schema, PostgreSQL major version and server address/port must match the approved release evidence; credential not exposed | No database mutation during Gate 1. A database URL must never appear in arguments, logs or records | Migration runner only receives the protected credential after Gate 5 approval; active app topology remains direct-Docker app plus Compose DB | `migration-runner.js` verifies database identity before the explicit migration; dated evidence reports PostgreSQL 17.9 and Compose DB but requires recheck | Fresh read-only identity query, exact Compose service mapping, role/grants, migration baseline and expected server identity. |

## Safe installation and handoff sequence

This is an operator procedure for later approval. It does not authorize any step. The initial installation stage must leave the live `/home/tilo/deploy-prod.sh` wrapper unchanged.

### 1. Fresh read-only verification of the legacy wrapper and checkout

Under Gate 1, inspect the exact wrapper used by the approved deployment operator. Record its canonical path, regular-file status, owner, group, mode, size, SHA-256 and syntax result without executing it. Review its control flow for checkout, Docker, health, lock, rollback, migration and release-record behavior. A marker count is not proof of participation in the canonical lock contract.

Inspect the production checkout read-only: branch/detached state, HEAD, tracked/staged status, unknown and ignored files, app directory ownership/mode and the candidate replacement path. Preserve all unknown files. Do not fetch, checkout, clean, delete or repair anything. A fresh result must retain the known discrepancy if the wrapper still does not expose the canonical shared lock.

### 2. Verify the approved operator identity and permissions

Record the approved operator account, UID/GID and complete primary/supplementary group set from the actual OS-backed process. Verify only the permissions needed to inspect the wrapper, checkout, Docker metadata and approved protected parents. Do not elevate privileges, acquire credentials or broaden Docker/database access for convenience.

The immutable executor record must bind its claimed operator UID/groups to live OS-backed identity. Missing, malformed, contradictory or unavailable identity evidence is STOP/UNKNOWN. A previously observed `tilo` identity is not a substitute for fresh Gate 1 evidence.

### 3. Independently confirm runtime and database topology

Before any protected installation, confirm exactly one canonical active application runtime and correlate the container ID, host PID and cgroup. Confirm that the application is direct-Docker and that PostgreSQL remains the intended Compose-managed service. Inspect only allowlisted metadata; do not dump environments, full labels, process arguments or raw Compose configuration.

Prove the database identity through an approved read-only connection or existing least-privilege selection. Record database, role, schema, server address/port and PostgreSQL major version without recording a URL or password. Record the migration baseline and unresolved count only if the authorized read-only procedure can do so safely. Unexpected identity, multiple runtimes, an uncorrelated host process or unresolved migration state stops the sequence.

### 4. Verify the deployed startup artifact's Prisma behavior

For the exact deployed startup artifact, verify that the artifact matches the reviewed startup contract: `container-start.sh` may ensure dependencies and call `npm run start`; `start` may build and call `start:runtime`; `start:runtime` must start the compiled application and must not invoke Prisma migration. `npm run migrate:deploy` is the explicit migration command owned by the isolated runner.

This must be verified against the deployed checkout/artifact, not inferred solely from `origin/dev`. If the deployed startup path still performs implicit migration, STOP before installation or rehearsal. Do not fix the deployed artifact as part of this installation step; that is a separate reviewed code/runtime change.

### 5. Obtain separate authorization for protected-path provisioning

Do not create, repair or infer protected paths from defaults. Approve the exact entry-point path, parent chain, outer and inner lock locations, credential source, release-record target, evidence location and candidate path. For each, approve UID/GID, modes, ACLs, symlink policy, retention and replacement checks. Record the exact helper commit and SHA-256.

Gate 2 must explicitly authorize filesystem provisioning. It does not authorize wrapper execution, Docker operations, database queries beyond the Gate 1 scope, migrations, release records, or runtime restart.

### 6. Install the reviewed hash-pinned immutable entry point

Only after the protected-resource decision and Gate 3 approval, install the reviewed immutable artifact outside the mutable application checkout. Preserve the legacy wrapper and do not edit or replace `/home/tilo/deploy-prod.sh` during this initial installation. Retain the previously selected helper for operator rollback if the installation plan requires it.

The installed entry point must verify its own canonical path, parent chain, owner/mode, stable device/inode identity and SHA-256 before exposing any operation surface. An installation result is not a deployment result.

### 7. Perform post-installation identity, checksum and ownership verification

Re-open the installed path through the approved no-follow checks. Verify regular-file type, exact owner/group/mode, no symlinked parents, approved SHA-256, complete device/inode identity and operator non-writability. Verify the parent chain again after installation. Any mismatch is STOP; do not repair in place or continue with a guessed path.

### 8. Run non-executing validation of the new entry point

Use only the reviewed offline verification mode or an equivalent non-executing inspection that returns bounded evidence. It must not acquire a lock, sample an execution clock, create a candidate, read credentials, write a release record, inspect production Docker, connect to PostgreSQL, start/stop a runtime or invoke a migration.

A successful offline result must remain `status=PASS`, `productionExecutionEnabled=false`, with no execution handle. When routed through the optional orchestrator guard, the call must stop before all injected deployment operations. Do not call the orchestrator without the guard and then claim the offline result protected it; the hook is optional and not universal.

### 9. Run a separately approved non-migration rehearsal

After Gate 4 approval, select a release whose reviewed `OLD_SHA..NEW_SHA` diff contains no Prisma schema or migration changes. Under the shared outer lock, perform the repository helper's candidate-only build and singleton/health-gated handoff using the separately reviewed VM adapter. The candidate must receive no production credentials, active polling mode, production network or startup helper. Preserve the direct-Docker app and Compose database topology.

The rehearsal must record the installed helper identity, lock ownership, runtime revision, candidate ownership, health result and rollback result. A rehearsal does not authorize migration execution or wrapper handoff.

### 10. Perform a separately reviewed legacy-wrapper handoff

Only after the immutable entry point passes independent identity checks and the non-migration rehearsal, review the transition from the legacy wrapper. The handoff must name the exact old wrapper, new entry point, helper commit/hash, operator, lock path, rollback target and approval. It must prove that the old wrapper cannot run concurrently or bypass the shared outer lock.

Do not edit the legacy wrapper during initial installation. Any later wrapper change is a separate production filesystem change requiring its own review and Gate 3-style authorization. If the legacy wrapper cannot be shown to cooperate, retain it as an explicitly uncoordinated legacy path until a reviewed transition is approved; do not assume compatibility from a matching filename or hash.

### 11. Rollback and recovery

For a pre-runtime-stop failure, keep the current active runtime untouched, retain the release/preflight evidence, and remove only an owned candidate worktree after rechecking identity. Release only the lock held by the current process. Do not delete unknown files, retry blindly or touch the database.

For a post-migration or post-runtime-stop failure, keep the release open and preserve the outer lock while evidence is classified. Do not automatically restart either runtime, check out an old incompatible revision, replay the migration, run `migrate resolve`, reset the database or restore over the live database. Reconfirm database identity, inspect `_prisma_migrations` and actual catalogs/data read-only, and classify every intended effect as ABSENT, COMPLETE, PARTIAL or UNKNOWN. Resume, forward-repair, compatible-runtime restoration or restore-to-new requires a separately recorded recovery decision.

The existing recovery contract is the source for migration incident handling: [production migration recovery runbook](../../ops/deploy/production-migration-recovery-runbook.md). A code checkout rollback never undoes committed SQL.

## Failure and rollback gates

The following conditions are explicit STOP gates. They leave the release open for review; they are not reasons to guess, clean, retry or downgrade evidence.

| STOP condition | Required response before runtime stop | Required response after migration starts or runtime stops |
| --- | --- | --- |
| Incorrect executable SHA-256 | Stop installation; preserve the reviewed artifact identity; do not execute | Keep any installed artifact unused; classify target/helper mismatch and do not promote |
| Wrong owner, group or mode | Stop; do not repair in place | Keep the release blocked; obtain a new protected-resource decision |
| Writable executable or parent directory | Stop; fail the immutable-path gate | Do not execute; preserve evidence and re-provision only after approval |
| Missing or ambiguous operator identity | Stop; no offline PASS or installation authorization | Keep release open; no lock, DB or runtime action |
| Symlinked or replaced path | Stop and retain the path for inspection; never follow or overwrite | Treat identity as ambiguous; do not continue or clean the path |
| Missing protected credential source | Stop before any migration operation | Keep runtime state unchanged if possible; do not read `.env` as a shortcut or expose credentials |
| Unexpected lock state or lock-owner ambiguity | Stop; do not stale-clean, retry or acquire a second lock | Preserve the current owner/evidence; no competing deploy or migration |
| Release-record failure | Stop before runtime transition; record failure only through an approved bounded fallback | Classify outcome AMBIGUOUS; do not release the outer lock until terminal handling is resolved, and never append after ownership is lost |
| Unknown checkout files or collision risk | Stop before candidate/checkout mutation; preserve unknown files | Do not delete or overwrite; retain current/new checkout for review |
| Multiple application runtimes or uncorrelated host process | Stop before runtime stop | Do not stop one by guesswork or start another; establish singleton identity first |
| Unexpected database identity | Stop before migration and runtime transition | Do not retry or change the database; re-establish identity through the protected path |
| Implicit Prisma migration on startup | Stop before any rehearsal or release | Do not promote or restart an incompatible runtime; require a separate reviewed startup fix |
| Failed health checks | Keep the old runtime if it has not been stopped; preserve bounded evidence | Do not infer database rollback or restart the old runtime automatically; use the compatibility/recovery decision |
| Migration failure or ambiguous outcome | No migration retry or resolve before classification | Keep the release `FAILED_NEEDS_CLASSIFICATION`; inspect migration state and effects; no blind retry, replay or reset |
| Missing backup/recovery evidence | Stop before migration-capable approval | Do not change database state; use the separate backup/recovery gate |
| Staging isolation or waiver not approved | Stop before migration-capable release | Do not treat absent staging as passed; obtain an explicit waiver or restore isolation |

### Pre-runtime-stop recovery

This applies to candidate-build, preflight, lock, identity, checkout, credential and pre-migration failures. The old runtime remains authoritative if it is healthy. The operator may preserve bounded logs and remove only the exact owned candidate worktree after path/ownership checks. No database write, migration, runtime replacement, unknown-file deletion or automatic retry is permitted.

### Post-migration recovery

Once the migration runner has started, or once the old runtime has stopped, the state is recovery-sensitive. Keep the release record open, retain evidence and classify database effects read-only. A nonzero Prisma result does not prove rollback; a successful code rollback does not reverse SQL. Do not automatically restart the old runtime, restart an incompatible target, run `migrate resolve`, replay a failed migration, drop/delete/truncate data, or restore over the live database. Any forward repair, compatible runtime start, or restore-to-new cutover requires separate database/recovery authority and release approval.

## Authorization checklist

No gate grants permission for a later gate. Each gate needs a named approver, exact scope, UTC timestamp, evidence reference and explicit outcome.

| Gate | Decision and evidence required | Can be completed entirely offline? | Production authorization required |
| --- | --- | --- | --- |
| Gate 1 — Read-only production verification | Fresh wrapper identity/control flow; checkout/unknown-file inventory; approved operator identity/permissions; runtime singleton and PID/cgroup; database identity and migration baseline; deployed startup behavior; protected-path metadata where safely inspectable; health/monitoring/disk/staging/backup state | Preparation, repository comparison and evidence validation can be offline; the live facts cannot | Yes, for one bounded read-only VM verification. No mutation or credential read is included. |
| Gate 2 — Protected-resource provisioning | Exact entry point, executor SHA, parent chain, lock parent/paths, credential mechanism, release-record boundary, evidence store, candidate path, UID/GID/modes/ACLs and symlink rules | The manifest review can be offline; provisioning cannot | Yes. This authorizes only the named filesystem/ownership/protection changes. |
| Gate 3 — Immutable entry-point installation | Install the reviewed hash-pinned artifact outside checkout; verify identity/ownership/checksum; preserve legacy wrapper; record rollback helper | Artifact review and hash calculation can be offline; installation is a VM write | Yes. Does not authorize rehearsal, migration, backup or wrapper replacement. |
| Gate 4 — Non-migration rehearsal | Separately approved no-Prisma target; outer-lock coordination; candidate build; direct-Docker singleton and health-gated handoff; bounded rollback evidence | Fixture/rehearsal planning can be offline; the real VM rehearsal cannot | Yes. Runtime stop/start and health validation require explicit scope. |
| Gate 5 — Migration-capable release readiness | Exact migration diff and existing-schema evidence; database identity/baseline; migration/recovery authority; fresh backup/retrieval/restore and key custody; staging pass or waiver; monitoring; immutable helper/lock/release-record proof; final release review | Migration diff review, tests and evidence review can be offline; production DB/runtime readiness cannot | Yes, including a separate database-write and runtime-promotion authorization. |
| Gate 6 — `dev` to `main` promotion | Fresh full release diff, CI, migration review, production readiness evidence and explicit owner approval; target SHA must be fixed | Diff/CI/review can be offline; release promotion and production rollout cannot | Yes. This is separate from every installation gate and does not authorize changing `main` as part of this document PR. |

## Gate 1 read-only production verification packet

**Packet status:** prepared offline; **NOT READY FOR EXECUTION, NOT AUTHORIZED and NOT EXECUTED**. This packet is scoped to one fresh, bounded read-only verification of the existing production environment. It does not authorize VM access by itself. The packet is based on `origin/dev` `694bb78e19af39ef1256bb696c7c8bf86a2ad551`, the merged discovery collector from PR #2027 at `1cb81528ea34dd25f51613557d6f6030fddd0b3a`, and the dated operator evidence reconciled above.

### 1. Remote identity and access method

- Target: the existing operator-managed SSH alias `clash-vm`, remote account `tilo`. The alias, account, UID/GID, groups and current authentication state are dated operator evidence and **must be freshly revalidated**; they are not assumed to be current.
- Access: one noninteractive SSH remote-command invocation with `BatchMode=yes`, `RequestTTY=no`, no interactive shell, no `sudo`, no agent forwarding and no shell-profile-dependent behavior. The operator owns the SSH client and confirms the target host before execution.
- The command must run as the named account. A failed identity check, unexpected host/account, privilege expansion, or need for `sudo` is an immediate stop.

### 2. Pinned collector record — not included in this packet

The local pinned archive is present and hashes to `8138275d0f18451ea02955357c3f2e7c22c729175c575033aae64bff7dc81015`; it contains exactly the three files approved by PR #2027. The previously reported remote extraction path is an operator-reported staging candidate, not independently reverified in this task. **No new delivery or extraction is part of this packet.** If the remote files or hashes do not match, stop and request a separate delivery decision.

The pinned collector archive and its SHA-256 are preparation evidence only. **No collector command is included or authorized in this prerequisite packet.** The angle-bracket path substitutions, reviewed bounded-output behavior and optional read-only database selection require a later, separately approved collector-execution decision after this packet resolves the protected paths. If any path is unresolved, the collector must not run; the collector's non-empty shared-lock default must never be accepted as production configuration.

### 3. Minimum read-only probes and allowed resources

The collector or separately reviewed fixed probes may read only:

| Probe | Allowed observation | Required classification |
| --- | --- | --- |
| Legacy wrapper | `/home/tilo/deploy-prod.sh` type, canonical path, owner/group, mode, size, digest, syntax and bounded static control-flow markers; no execution | `VERIFIED`, `OBSERVED`, `UNKNOWN` or `BLOCKED`; absence of canonical shared-lock participation is a failure against the contract |
| Operator | Effective UID/GID, supplementary groups and bounded effective permissions needed for the named read-only paths | Fresh evidence bound to the executing process; missing or contradictory identity fails closed |
| Checkout | `/home/tilo/apps/clashcookies-prod` path metadata, exact `HEAD`, branch/detached state, tracked cleanliness and bounded unknown-file inventory using `GIT_OPTIONAL_LOCKS=0` | `VERIFIED` only for the exact observed checkout; unknown files are preserved |
| Runtime | Direct-Docker application identity, selected container metadata, singleton count, host PID/cgroup correlation and required published-port identity | `VERIFIED` only when list/inspect/process evidence is fresh and mutually consistent |
| Database topology | Compose-managed PostgreSQL service/container identity and network/port relationship, without data or full inspect output | `OBSERVED`/`UNKNOWN` unless the topology is independently bound to the application |
| Startup migration | Deployed startup artifact and bounded static/runtime evidence showing whether startup invokes migrations; never start the wrapper or app | `UNKNOWN` unless the artifact and behavior are directly evidenced |
| Lock/release participation | Metadata and bounded static evidence for the shared deployment lock, separate migration lock and release-record path; no acquisition or write | `VERIFIED` only for independently identified paths and ownership/protection; otherwise `UNKNOWN/BLOCKED` |
| Protected credentials | Candidate credential-source path type, canonicality, owner/group, mode, size and symlink status only | Contents, values and environment expansion are prohibited; unsafe metadata is a stop |
| Executor/lock/release candidates | Candidate path metadata, parent-chain canonicality, owner/group, mode, size and symlink status | Candidate names are not configuration; unresolved or writable protected parents are `UNKNOWN/BLOCKED` |
| Database identity/baseline | Server/database/role identity and migration baseline only, in a read-only transaction, and only after separate DB authorization with an operator-provided existing selection | No grants, schema/data reads, migration writes, locks, resets or credentials |
| Health/operations | Fresh localhost `/livez` and `/healthz`, bounded monitoring/backup unit state, disk/inode metadata and staging presence/name evidence | No ping, timer activation, backup, cleanup or staging modification |

### 4. Explicit exclusions

No credential or `.env` contents; no environment dumps; no command-line arguments; no full Docker inspect or Compose configuration dump; no `docker exec`; no wrapper, app, Docker or PostgreSQL start/stop/restart; no deployment, migration, backup, timer activation, lock acquisition, release-record write, permission change, checkout/fetch, unknown-file deletion, staging change, evidence upload, or release promotion. A collector being installed, transferred or hash-verified does not authorize its execution.

### 5. Evidence destination and redaction

Evidence capture is a separate decision and is **not authorized or configured by this task**. If separately approved, capture must be stdout-only to the existing approved local ciphertext-only destination `%USERPROFILE%\clashcookies-production-evidence-20261117\<UTC-timestamp>-gate1-1cb81528.ndjson.age`, with separately retained provenance and stderr sidecars. The destination must be rechecked as canonical/non-reparse and private immediately before use. No plaintext evidence, private key, passphrase, credential, environment value, process argument or secret-bearing output may be retained or displayed. Existing operator/Codex reports about that directory are preparation evidence only.

### 6. Maximum scope and stop conditions

One SSH connection, one bounded collector call, one remote account, read-only commands only, no retry, no privilege escalation and no writes. Stop before or during execution if the host/account/SSH identity is unexpected; a protected path is unresolved; a default or guessed path would be used; the remote artifact hash differs; output is truncated, malformed, contradictory or secret-bearing; Docker/DB access would require broader privilege; a command would mutate state; a lock or release record would be created/touched; or any health, staging, backup or migration result cannot be classified without inference. Preserve partial evidence as incomplete and report the stop; do not rerun automatically.

### 7. Rollback requirements

No rollback is expected because Gate 1 performs no remote writes. If an unexpected mutation or partial capture is observed, stop immediately, preserve the bounded ciphertext/provenance as `INCOMPLETE` or `MALFORMED`, do not delete or repair remote artifacts, and escalate for owner-directed recovery. No database or runtime rollback is authorized by this packet.

### 8. Facts that remain UNKNOWN until fresh approval and evidence

Current SSH host identity and account permissions; exact live wrapper control flow and shared-lock participation; checkout SHA/cleanliness/unknown files; direct-Docker singleton and PID/cgroup identity; Compose database mapping; deployed startup migration behavior; exact outer/inner lock paths; immutable executor path/digest and parent protection; credential-source path and protection; release-record path and append-only protection; read-only DB identity and migration baseline; health/monitoring/backup/staging state; and any installation or release readiness conclusion. Dated operator evidence remains `OBSERVED`, not fresh `VERIFIED`, unless the new bounded evidence independently supports it.

### 9. Separate authorization decisions and owner text

- **Artifact delivery:** no new transfer or extraction is requested. If the pinned remote staging candidate is absent or mismatched, authorize a separate delivery-only action naming the exact archive SHA, destination, extraction root and verification steps. Delivery does not authorize capture or execution.
- **Evidence capture:** not granted by this packet. Authorize separately only if the owner approves the exact local ciphertext destination, redaction rules, retention and stdout-only capture method. Capture does not authorize collector execution.
- **Collector execution:** not granted by this packet. Authorize separately only after the remote identity, artifact, protected candidate paths, output limits and stop conditions above are reviewed. Collector execution does not authorize deployment, migration, backup, timer, lock, release-record or staging changes.

The owner approval text, when and only when each decision is intended, is:

```text
I authorize exactly the named Gate 1 decision below for ClashCookies production, and no other action:
[ ] Delivery only: transfer/extract the pinned PR #2027 artifact at SHA-256 8138275d0f18451ea02955357c3f2e7c22c729175c575033aae64bff7dc81015 to the separately named destination and verify the three expected files.
[ ] Evidence capture only: capture one approved stdout-only, ciphertext-only result to the separately named local destination under the stated redaction and retention rules.
[ ] Collector execution only: using the existing approved SSH access as the freshly verified named account, run exactly one bounded read-only collector invocation with independently confirmed paths; no sudo, TTY, wrapper/app execution, Docker/DB writes, secrets, locks, release records, migrations, backups, timers, staging changes or retries.
UTC timestamp: ____________________   Approver: ____________________   Scope/evidence reference: ____________________
```

## Gate 1 protected-path prerequisite resolution

**Resolution status:** prepared offline; **NOT AUTHORIZED and NOT EXECUTED**. The collector cannot be proposed with guessed protected paths. The matrix below separates the already reported delivery and metadata observations from resources that are actually absent and from canonical resources that remain unresolved.

### Prerequisite matrix

| Resource | Exact known/proposed path | Evidence source and time | Type, owner, permissions, symlink state | Status and remaining requirement |
| --- | --- | --- | --- | --- |
| Remote discovery collector and dependencies | `/home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528/`; archive `/home/tilo/.clashcookies-discovery/clashcookies-production-vm-discovery-1cb81528.tar` | 2026-11-17 operator preflight delivery checkpoint; operator/Codex-reported | Root and parent reported real directories, owner `1000:1000`, mode `0700`; extracted directories `0775`; three files owner `1000:1000`, mode `0664`; no links/special entries reported | **OBSERVED** remote delivery and extraction; local archive shape/hash is independently checked offline. A fresh read-only hash/metadata check is still required if current remote identity must be independently confirmed. |
| Legacy production wrapper | `/home/tilo/deploy-prod.sh` | 2026-11-17 protected-path checkpoint; operator/Codex-reported | Regular canonical file, owner `1001:1001`, mode `0755`, 7,348 bytes, SHA-256 `ae5af2b0…`; no symlink reported; `bash -n` passed | **OBSERVED** metadata; **FAIL** against canonical shared-lock participation because no lock/migration/executor/release markers were found. Fresh identity/control-flow review remains required. |
| Production checkout | `/home/tilo/apps/clashcookies-prod` | 2026-11-17 protected-path checkpoint; operator/Codex-reported | Canonical directory, owner `1000:1000`, mode `0775`; `main` at `0d2a49bb…`; pre-existing untracked files | **OBSERVED**. Fresh SHA, cleanliness and bounded unknown-file inventory remain required; existing files must be preserved. |
| Shared outer deployment lock | Canonical path **UNRESOLVED**; historical candidate `/run/lock/clashcookies-prod-deploy.lock` | 2026-11-17 protected-path checkpoint | Candidate reported absent; `/run/lock` reported root-owned, mode `1777`; no lock was created/acquired | **ABSENT candidate / UNKNOWN canonical resource / BLOCKED**. Identify only from reviewed live wrapper or approved deployment inventory; do not infer the repository default. |
| Separate migration lock | Canonical path **UNRESOLVED**; historical candidate `/run/lock/clashcookies-prod-migration.lock` | 2026-11-17 protected-path checkpoint | Candidate reported absent; no migration runner or lock was installed/identified | **ABSENT candidate / UNKNOWN canonical resource / BLOCKED**. It must be distinct from the outer lock and established from reviewed runner configuration. |
| Immutable deployment executor | No selected path; historical example `/home/tilo/deploy-assets/REVIEWED-HELPER.sh` is not configuration | 2026-11-17 protected-path checkpoint and design docs | No live immutable executor identified; no ownership/mode/symlink/hash record exists for a selected executor | **UNKNOWN/BLOCKED**. A read-only inspection may identify an existing invoked helper, but must not execute it or treat a repository path as installed. |
| Protected migration credential source | Actual source **UNRESOLVED**; observed candidate `/home/tilo/apps/clashcookies-prod/.env` | 2026-11-17 protected-path checkpoint | Candidate regular file, owner `1000:1000`, mode `0664`, size 1,727 bytes; contents not read; no symlink reported | **UNKNOWN**, with an unsafe candidate. If selected, `0664` fails the required credential boundary. Identify metadata only; never read or export contents. |
| Append-only release-record target | Canonical path **UNRESOLVED**; historical candidate `/var/lib/clashcookies/release-record.ndjson` | 2026-11-17 protected-path checkpoint | Candidate reported absent; no parent/file ownership or append-only proof exists | **ABSENT candidate / UNKNOWN canonical resource / BLOCKED**. Do not create, append, rotate, truncate or infer append-only protection from existence/mode. |
| Preflight evidence storage | `C:\Users\tonyk\clashcookies-production-evidence-20261117` | Local offline check in this task; prior operator/Codex preparation report | Windows directory, non-reparse, empty; Unix UID/GID not applicable; prior report describes restricted ACLs | **VERIFIED for local shape only**. Capture is not configured or authorized; any future ciphertext capture remains separately gated. |
| Candidate worktree | Design candidate `/home/tilo/apps/clashcookies-prod-replacement` | Installation-readiness design; not a live observation | No live type/owner/mode/symlink/absence evidence | **UNKNOWN**. Do not probe or create it during prerequisite resolution; candidate provisioning is a later authorization. |
| Deployment operator identity | `tilo` | 2026-11-17 operator/Codex-reported identity checkpoint | UID/GID `1000:1000`; groups `tilo`, `sudo`, `users`, `docker`; session/agent state is time-dependent | **OBSERVED**, not fresh. Revalidate host/account and effective read permissions in any separately authorized inspection; group membership is not authorization. |
| Administrative installation identity | No independently named identity; wrapper/helper ownership includes `1001:1001` | Existing evidence and repository contracts | No approved administrative UID/GID, ACL, or installation account recorded | **UNKNOWN/BLOCKED**. Do not infer administrative authority from file ownership, `sudo` membership or repository access. |

The local archive was created and hash-verified offline. The 2026-11-17 record reports that it was transferred, extracted and hash-verified remotely under separate authorization, but that remote result is **operator/Codex-reported**, not independently reproduced in this task. No transfer or extraction is to be repeated.

### Deadlock resolution

The safest distinction is a single, separately authorized prerequisite inspection with a finite allowlist:

- Existing resources requiring identity verification: the known wrapper, known checkout, known collector staging root/files and the operator account.
- Candidates confirmed absent by the existing report: the historical outer-lock path, inner migration-lock path and release-record path. Their absence does not prove that no other canonical path exists.
- Resources requiring further inspection: the actual wrapper-referenced lock/executor/credential/release paths, if any; current remote collector file hashes; current account/host identity.
- Resources not to probe: credential contents, environment files, process arguments, Docker state, PostgreSQL state, whole-filesystem searches, unknown secret stores, and any path creation or lock/release-record operation.

### Minimal prerequisite inspection packet — proposed, not executed

**Target and operator:** one SSH connection and one remote command to the existing operator-managed alias `clash-vm` as `tilo`, using `BatchMode=yes`, `RequestTTY=no`, `ForwardAgent=no`, `StrictHostKeyChecking=yes`, `ConnectTimeout=5` and `ConnectionAttempts=1`. The operator must verify the existing approved alias and its configured known-hosts binding in the protected local SSH configuration before interpreting any output. Do not create keys, change SSH configuration, disable host-key checking, accept a new key, use `sudo`, open an interactive shell, or retry. A host/account/UID/GID mismatch is an immediate stop.

This packet deliberately separates safe prerequisite facts from wrapper control-flow review. It does **not** inspect or emit wrapper source. It does **not** emit checkout status lines or filenames. The existing reviewed collector remains the only proposed source for redacted wrapper marker counts and sanitized checkout evidence; its execution remains separately unauthorized until protected paths are independently established.

The following is the complete proposed prerequisite probe: exactly one CMD-safe `ssh` invocation, one remote shell invocation, and no retry. `set -Eeuo pipefail` and the `stop` path prevent later probes after an unexpected utility, permission, timeout, hash, replacement or validation failure. Expected `ABSENT`, `SYMLINK` and detached classifications are fixed observations and do not themselves execute another probe. Every potentially blocking remote utility is wrapped with the existing GNU `timeout` utility for five seconds; utility stderr is discarded rather than captured. The remote command emits only fixed-field summaries: numeric identity, file kind/owner/mode/size, a 64-hex digest, `ATTACHED`/`DETACHED`/`UNKNOWN`, bounded state labels, or a numeric count. It never emits branch names, source lines, configuration values, credential values, command arguments, status records or filenames.

```cmd
ssh -T -l tilo -o BatchMode=yes -o RequestTTY=no -o ForwardAgent=no -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 clash-vm "set -Eeuo pipefail; stop(){ printf 'STOP|reason=%s\n' $1; exit 1; }; need(){ command -v $1 >/dev/null 2>&1 || stop MISSING_UTILITY; }; need timeout; need id; need stat; need sha256sum; need awk; need git; need bash; probe_hash(){ label=$1; path=$2; if test -L $path; then printf '%s|SYMLINK\n' $label; elif test ! -f $path; then printf '%s|ABSENT\n' $label; else meta=$(timeout --signal=TERM --kill-after=1s 5s stat -c '%F|%u|%g|%a|%s' -- $path 2>/dev/null) || stop METADATA; case $meta in regular\ file\|*) ;; *) stop REPLACED_OR_UNKNOWN;; esac; hash=$(timeout --signal=TERM --kill-after=1s 5s sha256sum -- $path 2>/dev/null | awk '{print $1}') || stop HASH; if printf '%s' $hash | awk 'length($0)==64 && $0 !~ /[^0-9a-fA-F]/ {ok=1} END {exit !ok}'; then :; else stop HASH_INVALID; fi; printf '%s|%s|sha256=%s\n' $label $meta $hash; fi; }; probe_candidate(){ label=$1; path=$2; if test -L $path; then printf '%s|SYMLINK\n' $label; elif test ! -e $path; then printf '%s|ABSENT\n' $label; else meta=$(timeout --signal=TERM --kill-after=1s 5s stat -c '%F|%u|%g|%a|%s' -- $path 2>/dev/null) || stop METADATA; case $meta in regular\ file\|*|directory\|*) printf '%s|PRESENT|%s\n' $label $meta;; *) stop REPLACED_OR_UNKNOWN;; esac; fi; }; uid=$(timeout --signal=TERM --kill-after=1s 5s id -u 2>/dev/null) || stop IDENTITY; gid=$(timeout --signal=TERM --kill-after=1s 5s id -g 2>/dev/null) || stop IDENTITY; groups=$(timeout --signal=TERM --kill-after=1s 5s id -G 2>/dev/null) || stop IDENTITY; group_count=$(printf '%s\n' $groups | awk '{print NF}') || stop IDENTITY; printf 'identity|uid=%s|gid=%s|group_count=%s\n' $uid $gid $group_count; probe_hash archive /home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528.tar; probe_hash adapter /home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528/ops/deploy/direct-docker-adapter.js; probe_hash collector /home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528/ops/deploy/discovery/production-vm-discovery.sh; probe_hash validator /home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528/ops/deploy/discovery/runtime-contract-validator.js; if test -L /home/tilo/deploy-prod.sh; then printf 'wrapper|SYMLINK\n'; elif test ! -f /home/tilo/deploy-prod.sh; then printf 'wrapper|MISSING\n'; else meta=$(timeout --signal=TERM --kill-after=1s 5s stat -c '%F|%u|%g|%a|%s' -- /home/tilo/deploy-prod.sh 2>/dev/null) || stop WRAPPER_METADATA; case $meta in regular\ file\|*) ;; *) stop WRAPPER_REPLACED_OR_UNKNOWN;; esac; hash=$(timeout --signal=TERM --kill-after=1s 5s sha256sum -- /home/tilo/deploy-prod.sh 2>/dev/null | awk '{print $1}') || stop WRAPPER_HASH; if printf '%s' $hash | awk 'length($0)==64 && $0 !~ /[^0-9a-fA-F]/ {ok=1} END {exit !ok}'; then :; else stop WRAPPER_HASH_INVALID; fi; printf 'wrapper|metadata=%s|sha256=%s\n' $meta $hash; if timeout --signal=TERM --kill-after=1s 5s bash -n -- /home/tilo/deploy-prod.sh 2>/dev/null; then printf 'wrapper|syntax=PASS\n'; else printf 'wrapper|syntax=FAIL_OR_TIMEOUT\n'; stop WRAPPER_SYNTAX; fi; printf 'wrapper|control_flow=DEFERRED_TO_REDACTED_COLLECTOR\n'; fi; app=/home/tilo/apps/clashcookies-prod; head=$(timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C $app rev-parse --verify HEAD 2>/dev/null) || stop CHECKOUT_HEAD; if printf '%s' $head | awk 'length($0)==40 && $0 !~ /[^0-9a-fA-F]/ {ok=1} END {exit !ok}'; then :; else stop CHECKOUT_HEAD_INVALID; fi; printf 'checkout|head=%s\n' $head; if branch=$(timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C $app symbolic-ref --short -q HEAD 2>/dev/null); then printf 'checkout|branch=ATTACHED\n'; else rc=$?; case $rc in 1) printf 'checkout|branch=DETACHED\n';; 124|137) printf 'checkout|branch=UNKNOWN\n'; stop CHECKOUT_BRANCH_TIMEOUT;; *) printf 'checkout|branch=UNKNOWN\n'; stop CHECKOUT_BRANCH_UNKNOWN;; esac; fi; if timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C $app diff --quiet --no-ext-diff 2>/dev/null; then clean=CLEAN; else rc=$?; case $rc in 1) clean=CHANGED;; *) clean=UNKNOWN; printf 'checkout|tracked_clean=%s\n' $clean; stop CHECKOUT_CLEANLINESS;; esac; fi; if timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C $app diff --cached --quiet --no-ext-diff 2>/dev/null; then :; else rc=$?; case $rc in 1) clean=CHANGED;; *) clean=UNKNOWN; printf 'checkout|tracked_clean=%s\n' $clean; stop CHECKOUT_INDEX;; esac; fi; printf 'checkout|tracked_clean=%s\n' $clean; count=$(timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C $app ls-files --others --exclude-standard -z 2>/dev/null | awk -v RS='\0' 'NF {n++} END {print n+0}') || stop UNTRACKED_COUNT; if printf '%s' $count | awk '$0 ~ /^[0-9]+$/ {ok=1} END {exit !ok}'; then :; else stop UNTRACKED_COUNT_INVALID; fi; printf 'checkout|untracked_count=%s\n' $count; digest=$(timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C $app ls-files --others --exclude-standard -z 2>/dev/null | sha256sum 2>/dev/null | awk '{print $1}') || stop UNTRACKED_DIGEST; if printf '%s' $digest | awk 'length($0)==64 && $0 !~ /[^0-9a-fA-F]/ {ok=1} END {exit !ok}'; then :; else stop UNTRACKED_DIGEST_INVALID; fi; printf 'checkout|untracked_inventory_sha256=%s\n' $digest; probe_candidate outer_lock /run/lock/clashcookies-prod-deploy.lock; probe_candidate migration_lock /run/lock/clashcookies-prod-migration.lock; probe_candidate executor_candidate /home/tilo/deploy-assets/REVIEWED-HELPER.sh; probe_candidate credential_candidate /etc/clashcookies/production-db.env; probe_candidate release_record_candidate /var/lib/clashcookies/release-record.ndjson; probe_candidate env_candidate /home/tilo/apps/clashcookies-prod/.env; probe_candidate candidate_worktree /home/tilo/apps/clashcookies-prod-replacement"
```

The packet emits no wrapper source, matching fragments, configuration values, environment contents, credential values, process arguments, arbitrary paths, branch names, or untracked filenames. Wrapper control-flow evidence is explicitly `DEFERRED_TO_REDACTED_COLLECTOR`; the marker remains metadata only and never proves live shared-lock participation. The checkout uses `GIT_OPTIONAL_LOCKS=0`, `git diff --quiet` for tracked cleanliness, and `git ls-files --others --exclude-standard -z` piped only to a numeric counter and SHA-256 digest; names and contents never reach stdout. The exact `HEAD`, tracked cleanliness, numeric unknown-file count and optional digest remain available without exposing names.

**Output and timeout contract:** the bounds below are deliberately separated:

| Property | Enforced by the remote command | Enforced by offline validator or manual review |
| --- | --- | --- |
| Per-utility execution | `timeout --signal=TERM --kill-after=1s 5s`, `set -Eeuo pipefail`, fixed allowlist and fail-closed `STOP` path | Confirm the expected utility result or `STOP` record |
| SSH connection | `BatchMode=yes`, `RequestTTY=no`, `ForwardAgent=no`, `StrictHostKeyChecking=yes`, `ConnectTimeout=5`, `ConnectionAttempts=1`; one invocation only | Verify the existing approved alias/known-host binding and reject unexpected host/account/UID/GID |
| Aggregate session runtime | **Not enforced**; per-utility timeout is not an aggregate SSH timeout | Do not claim a session deadline; stop manual review if the session exceeds the approved operational window |
| Output schema and redaction | Fixed `printf` records, no source/branch/name/value emission, stderr discarded, and no later probes after an unexpected failure | Strictly check one approved record per line, no extra fields/lines, line <=1 KiB, total <=8 KiB, valid hashes/metadata, no truncation and no mixed SSH diagnostics |

No general transport-size or aggregate-timeout guarantee is claimed. The command's normal fixed output is expected to remain below 8 KiB, but the 1 KiB line and 8 KiB total limits are not enforced by SSH itself. The offline validator below now rejects unexpected, oversized, malformed, truncated, incomplete or sensitive input, but it cannot establish host identity, authorization or a trusted capture provenance. The current SSH command also has no independent terminal completeness record; a raw stdout file alone cannot prove that the final record was not truncated. Until a separately reviewed local capture/provenance boundary is approved, this packet remains `NOT READY FOR EXECUTION`. Any extra line, oversized line/stream, malformed field, truncated stream, mixed diagnostic, nonzero SSH state or secret-bearing output is `INCOMPLETE`, `INVALID` or `UNKNOWN`, never evidence. A missing utility is `MISSING_UTILITY`; permission or timeout failure is `STOP`; a missing wrapper/candidate is `ABSENT`; no marker review is `DEFERRED`, not `PASS`.

**Private evidence handling:** no remote evidence file is created and no stdout capture is authorized. Display only the fixed summaries in a protected operator terminal. Retaining stdout, stderr or later collector evidence requires separate evidence-capture authorization and the approved local ciphertext-only destination. No plaintext, private key, passphrase, credential, environment value, raw wrapper source or filename may enter chat, Git, the VM, or an unencrypted file.

### Offline security regression validation

This update adds the offline-only validator `ops/deploy/discovery/gate1-prerequisite-validator.js` and focused synthetic tests. It adds no production execution test. Offline validation uses synthetic values and the existing reviewed collector contract only:

- Secret-bearing wrapper lines are represented only by `wrapper|control_flow=DEFERRED_TO_REDACTED_COLLECTOR`; no source fragment is emitted.
- Sensitive untracked names are consumed by the NUL-delimited count/digest pipeline; only `untracked_count` and a 64-hex digest are allowed out.
- No-marker wrapper state remains `DEFERRED`; missing wrapper is `MISSING`; missing utility, permission failure, timeout, malformed output, truncation and replacement are non-PASS outcomes.
- The validator regression suite covers exactly one fixed output order, expected `ABSENT`/`SYMLINK` states, `ATTACHED`/`DETACHED`/`UNKNOWN`, empty inventory, missing/duplicate/unexpected/out-of-order records, unknown/extra/missing fields, numeric/hash/HEAD/mode/size failures, raw branch/filename/source/credential-like input, blank/oversized/>8 KiB/truncated/mixed-diagnostic input, nonzero/interrupted/STOP/timeout streams, malformed provenance, identity and artifact mismatches, unsupported schema, contradictory status, control characters and secret-bearing malformed output. Rejected content is never included in validator output.
- Existing `tests/production-vm-discovery.test.ts` covers secret-bearing wrapper redaction, bounded output, malformed/failed commands, protected-path failures and `GIT_OPTIONAL_LOCKS=0`. The focused suite completed all 12 tests in 194.20 seconds on Windows; the delay is reproducible Git Bash subprocess overhead, not a test hang, timeout or orphaned process. A local synthetic summary check additionally rejects secret strings, filenames, extra lines and oversized/truncated sentinels before accepting the fixed summary shape.
- No probe in this packet starts a service, reads Docker/PostgreSQL, reads credentials, acquires a lock, writes a record, changes Git state, changes permissions, or mutates production.

### Strict local validator contract

The validator is local-only and accepts exactly one explicitly supplied UTF-8 JSON envelope. It does not read stdin, initiate SSH, invoke a child process, invoke Docker/PostgreSQL, capture evidence, write files or rerun a probe. The input path and approved local boundary must both be explicit absolute paths; naming a directory does not itself establish trust. Windows CMD invocation is:

```cmd
node ops\deploy\discovery\gate1-prerequisite-validator.js --input C:\Users\tonyk\clashcookies-production-evidence-20261117\gate1-prerequisite-envelope.json --approved-root C:\Users\tonyk\clashcookies-production-evidence-20261117
```

The complete input envelope is limited to **32 KiB (32,768 UTF-8 bytes)**. The loader checks the explicit boundary and canonical path before opening, rejects symlinks, Windows reparse/junction components when detectable, directories, devices, FIFOs and other non-regular files, checks the size before reading, reads through a bounded descriptor, and compares file identity before and after the read. The 32 KiB envelope limit is distinct from the 8 KiB `stdout` limit below. The loader never follows an unsafe path as a fallback and never creates or changes evidence files.

On Windows, the current Node runtime does not provide a portable `O_NOFOLLOW` guarantee for every reparse-point type. The loader combines `lstat`, native canonical-path comparison, descriptor `fstat`, bounded reads and post-read identity checks, but this is not an atomic filesystem or complete TOCTOU guarantee. A detected reparse/symlink, replacement, mutation, short read, inaccessible path or unsupported boundary is rejected; undetectable Windows races remain a trusted-provenance limitation and keep Gate 1 **BLOCKED**.

The envelope must contain exactly these top-level fields: `schema_version`, `packet_version`, `target`, `account`, `expected_artifact_sha256`, `capture`, `provenance` and `stdout`. The fixed values are `schema_version=clashcookies-gate1-prerequisite-v1`, `packet_version=2026-11-17`, `target=clash-vm` and `account=tilo`. `expected_artifact_sha256` must contain exactly the reviewed values below; caller-supplied values are compared to this code-bound allowlist and cannot establish remote identity:

| Record | Required SHA-256 |
| --- | --- |
| `archive` | `8138275d0f18451ea02955357c3f2e7c22c729175c575033aae64bff7dc81015` |
| `adapter` | `379490aa007ecf6d036d5ef95e6b5ed07c5d4fdf726904bbd152ee1486032666` |
| `collector` | `bb56d8e4ff9cd8d7d2652ef6fb3fbc6dd07e98ca3b0d65252c8a7a2ec9626da9` |
| `validator` | `e2fbc31275003aa631aa16b984e6d2a8eaabef57646b377b82e02d27a20e27d6` |

The `stdout` record order is exact: `identity`; `archive`, `adapter`, `collector`, `validator`; `wrapper` (one `MISSING`/`SYMLINK` record, or metadata, `syntax=PASS` and deferred `control_flow` records); checkout `head`, branch classification, tracked cleanliness, untracked count and inventory digest; then `outer_lock`, `migration_lock`, `executor_candidate`, `credential_candidate`, `release_record_candidate`, `env_candidate` and `candidate_worktree`. Metadata uses only the fixed record names, regular-file/directory types, decimal UID/GID/size, three-or-four-digit octal mode and lowercase SHA-256 fields. Branch state is only `ATTACHED`, `DETACHED` or `UNKNOWN`; no branch names, paths, filenames, source, arguments or values are accepted.

The `capture` object must contain exactly `ssh_exit_status`, `stream_status`, `eof_observed`, `stdout_sha256` and `stdout_bytes`. It requires SSH exit status `0`, `stream_status=COMPLETE`, EOF observed, and a SHA-256/byte count matching the supplied `stdout`. This is an external capture attestation because the current SSH command has no terminal marker; the validator does not create or verify that attestation. The `provenance` object must contain exactly `captured_at`, `host_key_binding`, `authorization_scope` and `source`, with `host_key_binding=EXTERNAL_REVIEW_REQUIRED`, `authorization_scope=EXTERNAL_REVIEW_REQUIRED` and `source=EXTERNAL_LOCAL_CAPTURE_WRAPPER`. These values deliberately produce `provenance=UNVERIFIED`; they are not authorization or host identity proof.

The validator enforces a maximum of 1 KiB per record line and 8 KiB total `stdout` bytes, requires a final newline, rejects blank/partial/duplicate/extra/malformed records, SSH diagnostics, control characters, sensitive-looking malformed content and `STOP` records, and never prints rejected records. Results are bounded to `VALID`, `INVALID` or `INCOMPLETE` with schema, count, safe reason, `review=REQUIRED`, `boundary=UNVERIFIED` and `provenance=UNVERIFIED`. `VALID` means structural validation only, never production readiness; an `UNKNOWN_OR_UNRESOLVED` result remains review-required. Input-boundary failures return fixed sanitized reasons with `records=0`; malformed UTF-8/JSON and unsafe file types are `INVALID`, while missing, inaccessible, replaced, mutated, short or interrupted reads are `INCOMPLETE`. Exit codes are 0 for structural `VALID`, 2 for `INVALID` and 3 for `INCOMPLETE`.

The canonical path and safe-file checks establish file properties only. They do not establish that the directory is owner-approved, that the envelope originated from production, that a host key was trusted, that capture was authorized, or that the collector may execute. Those capture/provenance and production-access decisions remain separate.

**Required owner authorization:**

```text
I authorize exactly one read-only Gate 1 protected-path prerequisite inspection of the named existing ClashCookies paths using the existing SSH alias clash-vm as the freshly verified account tilo. Before interpreting output, the operator must verify the existing approved alias and known-host binding; the command must use BatchMode=yes, RequestTTY=no, ForwardAgent=no, StrictHostKeyChecking=yes, ConnectTimeout=5 and ConnectionAttempts=1. It may run only the single fixed command in the approved packet, with no sudo, TTY, retries, file transfer, extraction, collector execution, evidence capture, Docker, PostgreSQL, wrapper execution, credential/environment reads, lock acquisition, release-record operation, permission change, directory creation, deployment, migration, backup, timer activation, staging change or release promotion. Any identity mismatch, unresolved path, hash mismatch, secret-bearing output, mutation attempt or incomplete output is a stop. This authorization does not authorize Gate 1 collector execution or any later provisioning, and it is not executable until the separately reviewed local capture/provenance boundary is approved and the validator reports structural `VALID`.
UTC timestamp: ____________________   Approver: ____________________   Evidence reference: ____________________
```

## Offline local capture/provenance boundary — implemented, not production-authorized

The repository now contains one narrowly scoped metadata owner, `ops/deploy/discovery/gate1-local-capture-boundary.js`. It accepts only an in-memory synthetic fixture, computes the complete-stream byte count and SHA-256, requires packet version `2026-11-17`, separates `source_identity` from `asserted_identity`, rejects nonzero exit/interruption/timeout/truncation/empty output, and delegates the final structural decision to the existing `gate1-prerequisite-validator.js`. It does not duplicate the validator, read or write files, invoke a process, initiate SSH, retry, access Docker/PostgreSQL, or enable a live capture path.

The metadata contract is deliberately fail-closed:

- `source_identity=SYNTHETIC_LOCAL_FIXTURE` is the only development source accepted; an asserted host/account string is retained separately and is never trusted.
- The module checks `Buffer.length` or `Buffer.byteLength(value, "utf8")` **before** copying/encoding. stdout and stderr are independently capped at **8,192 bytes**; synthetic plaintext and injected mock output use the same pre-copy cap. The module does not claim to bound memory already allocated by a caller.
- `ssh_exit_status=0`, `stream_status=COMPLETE`, `eof_observed=true`, exact stdout/stderr byte counts, exact complete-stream stdout/stderr SHA-256 values, nonempty stdout and `stdout_bytes <= 8,192` are required before structural validation.
- `boundary`, `provenance` and `custody` remain `UNVERIFIED`. Caller fields such as `VERIFIED` or `AUTHORIZED` are rejected, not promoted.
- `CaptureLedger` rejects duplicate attempt IDs and destination collisions in the offline model. It is metadata-only and is not a deployment lock, release record or append-only custody store.
- `validateCiphertextDestination` checks only caller-supplied destination metadata and returns `storage_approved=false`; an `approved=true` field is not an approval. `encryptSyntheticInMemory` accepts only an injected test encryptor and a recipient with syntax matching; syntax is not key or recipient trust. Its result is explicitly `SYNTHETIC_UNTRUSTED` / `MOCK_ENCRYPTOR_OUTPUT`, never verified ciphertext or approved encrypted evidence. It does not claim age-format correctness, cryptographic confidentiality, recipient/key verification, durable custody, or retention. It does not call `age`, generate keys, persist plaintext, upload, overwrite or select a production identity.

The existing backup `createAgeEncryptor` remains scoped to encrypted backup dump files and is not reused for evidence: it is path-based and coupled to the backup runner's temporary dump lifecycle. The metadata-only local capture boundary remains separate from the streaming adapter and does not itself persist evidence. No evidence file, temporary plaintext, credential, private key or production recipient was added. Synthetic mock output containing visible plaintext is quarantined or rejected and is never a confidentiality test.

### Offline streaming age custody adapter — implemented, synthetic-only

`ops/deploy/discovery/gate1-offline-age-custody.js` now provides the narrowly scoped implementation boundary for disposable local testing. It requires an explicit absolute `age` executable path, launches only that allowlisted executable with `shell=false`, streams synthetic plaintext through stdin and age ciphertext through stdout, and never exposes raw stdout/stderr in diagnostics. Plaintext and age diagnostics are bounded at **8,192 bytes**; ciphertext is bounded at **16,384 bytes**. The destination must be inside an explicitly supplied regular non-reparse root, is opened with exclusive creation (`O_EXCL`), is not overwritten, is chmod-restricted to `0600` when the platform permits, is fsynced, and is verified by post-write size and SHA-256 readback from the same descriptor. Only a newly created incomplete ciphertext is eligible for cleanup; there is no retry.

Disposable tests generated a test-only age identity at runtime, encrypted synthetic bounded input with the installed age `v1.3.2`, decrypted the ciphertext in memory, and verified byte-exact recovery. The suite also covers wrong identity, invalid recipient syntax, missing/process failure, interruption, timeout, truncation/oversize, tamper, collision, concurrent duplicate attempts, unsafe destinations, cleanup failure, no plaintext persistence and no production invocation. Test keys and ciphertext are removed with the disposable fixture; no key, plaintext evidence or production recipient was added to the repository.

This adapter proves age process completion and local ciphertext integrity only. It reports `custody=RESTRICTED_UNVERIFIED` and `provenance=UNVERIFIED`; recipient ownership, host identity, authorization, Windows ACL/reparse/TOCTOU guarantees, retention, recovery and evidence custody remain external decisions. The adapter does not upload, replicate, schedule retention deletion, use B2, generate production keys, or enable a production capture path. A future production capture invocation, approved recipient, approved private destination and retention/recovery procedure require separate owner authorization. Gate 1 remains **BLOCKED / NOT READY FOR EXECUTION**, and `PHASE1_EXECUTION_ENABLED=false` remains in force.

The trust boundary remains explicit: remote command output, transport completion/exit status, local capture metadata, host-key evidence, owner authorization, encryption/custody, structural validation and final human approval are separate facts. The implementation proves only synthetic local behavior. It does not prove a production host, SSH known-host binding, operator authorization, complete live capture, encryption custody, retention or human approval. Gate 1 remains **BLOCKED / NOT READY FOR EXECUTION**.

## Outstanding `UNKNOWN` / `BLOCKED` items

1. The exact immutable entry-point path, executor file and approved SHA-256 are **UNKNOWN/BLOCKED**.
2. The live wrapper's actual control flow and participation in the shared outer lock are **BLOCKED**; dated evidence found no canonical lock markers. The legacy wrapper remains unchanged.
3. The outer lock parent/path and distinct inner migration-lock parent/path are **UNKNOWN/BLOCKED**. Repository defaults and historical candidate paths are not production configuration.
4. The protected migration credential source, its owner/mode/ACL and child-delivery mechanism are **UNKNOWN**. The observed `.env` candidate mode `0664` is not an acceptable credential boundary if selected.
5. The append-only release-record parent/path, ownership, retention and protection are **UNKNOWN/BLOCKED**.
6. Fresh approved operator identity, effective filesystem/Docker/Git permissions and administrative ownership are **UNKNOWN** for this installation gate.
7. Fresh exact runtime singleton, host PID/container correlation, deployed revision and Compose database mapping are **UNKNOWN**.
8. Fresh database identity, least-privilege role, migration baseline and deployed startup artifact behavior are **UNKNOWN**.
9. Staging isolation is absent in the dated evidence; a separately approved waiver or restored mirror validation remains **BLOCKED**.
10. Backup expected-object monitoring, recovery-key disaster retrieval and unattended scheduling remain open in the backup roadmap; they are not installation evidence.
11. The installed helper, wrapper handoff, non-migration rehearsal and migration-capable production release have not occurred. `PHASE1_EXECUTION_ENABLED=false` remains in force.
12. Draft release PR #1983 remains blocked and unmerged. PR #2055 is merged, but that merge proves only the repository/offline trust boundary.

## Next executable milestone after approval

The next separately authorized milestone is **Gate 1 only**: one fresh, bounded, read-only production verification of the exact legacy wrapper, production checkout, approved operator identity, direct-Docker/Compose runtime topology, database identity and migration baseline, deployed startup behavior, health/monitoring state and protected-resource metadata. It must preserve `UNKNOWN/BLOCKED` for any path or identity not independently established.

Gate 1 must not install a helper, create a lock or release record, read credentials, run the collector without its separate authorization, execute the legacy/new wrapper, start or stop Docker, connect with a write-capable database role, run migrations/backups, enable timers, alter staging or promote a release. After Gate 1 evidence is reviewed, the owner may decide whether to authorize Gate 2 protected-resource provisioning. No installation or release readiness claim follows automatically from Gate 1.

## References

- [Canonical AI development workflow](../ai-development-workflow.md)
- [Project brain](../project-brain.md)
- [Architecture contract](../architecture-contract.md)
- [Core priorities](../core-priorities.md)
- [Observability contract](../observability.md)
- [Deployment contract](../deployment.md)
- [Production backup readiness roadmap](../roadmaps/production-backup-readiness.md)
- [Production deployment integration design](production-deployment-integration-design-2026-11-17.md)
- [Production VM discovery operator preflight](production-vm-discovery-operator-preflight-2026-11-17.md)
- [Deployment lock contract](../../ops/deploy/deployment-lock.md)
- [Direct-Docker adapter contract](../../ops/deploy/direct-docker-adapter.md)
- [Migration-aware deployment contract](../../ops/deploy/migration-aware-deploy.md)
- [Migration runner contract](../../ops/deploy/migration-runner.md)
- [Production migration recovery runbook](../../ops/deploy/production-migration-recovery-runbook.md)
- [PR #2055 — offline deployment integration boundary](https://github.com/tonykslee/ClashCookies/pull/2055)
