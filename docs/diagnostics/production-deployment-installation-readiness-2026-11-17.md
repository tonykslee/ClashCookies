# ClashCookies — Production Deployment Installation Readiness

> **ARCHIVED / SUPERSEDED (owner decision Nov 19, 2026):** This document records historical investigation of the now-withdrawn replacement deployment architecture. Do not run its collector, installation, Gate 1 commands, or proposed broker. The existing `~/deploy-prod.sh` workflow remains the deployment path; see rollback PR #2086 and `docs/deployment.md`.

**Repository:** `tonykslee/ClashCookies`

**Base reviewed:** `dev` at `9fc04b3e7fe6d00c12729f07ebb428ace86f4087`

**Assessment date:** 2026-11-18 (repository and documentation review)
**Status:** installation readiness **BLOCKED**; owner/operator custody packet prepared offline; no production execution

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

**Packet status:** prepared offline; the **fixed prerequisite-probe path** is distinct from retained evidence capture and may be considered for execution only after the separately recorded Gate B and SSH authorization checks pass. The **retained-evidence/collector path remains NOT READY FOR EXECUTION, NOT AUTHORIZED and NOT EXECUTED**. This packet does not authorize VM access by itself. The packet is based on `origin/dev` `694bb78e19af39ef1256bb696c7c8bf86a2ad551`, the merged discovery collector from PR #2027 at `1cb81528ea34dd25f51613557d6f6030fddd0b3a`, and the dated operator evidence reconciled above.

### 1. Remote identity and access method

- Target: the existing operator-managed SSH alias `clash-vm`, remote account `tilo`. The alias, account, UID/GID, groups and current authentication state are dated operator evidence and **must be freshly revalidated**; they are not assumed to be current.
- Access: one noninteractive SSH remote-command invocation with `BatchMode=yes`, `RequestTTY=no`, no interactive shell, no `sudo`, no agent forwarding and no shell-profile-dependent behavior. The operator owns the SSH client and confirms the target host before execution.
- The command must run as the named account. A failed identity check, unexpected host/account, privilege expansion, or need for `sudo` is an immediate stop.

### 1A. Fixed terminal-only prerequisite path versus retained evidence

This packet contains two deliberately separate paths:

- **Fixed prerequisite probe:** the exact bounded command in the “Minimal prerequisite inspection packet” emits only fixed summaries, digests, metadata fields, and bounded state labels. After Gate B and the one-command SSH authorization are independently closed, it may be run in the existing protected operator terminal with **no stdout capture, no age process, no evidence file, no provenance sidecar, and no validator input file**. Its terminal output is transient review material, not retained production evidence; do not copy it into chat, Git, a VM file, or an unencrypted local file.
- **Collector and retained evidence:** the later JSONL discovery collector, or any attempt to retain remote stdout for offline validation, requires the separate evidence-capture/custody authorization and the approved ciphertext/provenance boundary described below. The synthetic-only local capture and age modules do not authorize or implement that live path.

The protected-terminal allowance does not relax host-key, account, command, output-size, redaction, stop, or no-write requirements. The separate capture boundary remains mandatory whenever output is retained or the collector is executed.

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

### 5. Evidence destination and redaction — retained output only

This section applies only when remote output is retained, including the later collector. Evidence capture is a separate decision and is **not authorized or configured by this packet**. If separately approved, capture must be stdout-only to the existing approved local ciphertext-only destination `%USERPROFILE%\clashcookies-production-evidence-20261117\<UTC-timestamp>-gate1-1cb81528.ndjson.age`, with separately retained provenance and stderr sidecars. The destination must be rechecked as canonical/non-reparse and private immediately before use. No plaintext evidence, private key, passphrase, credential, environment value, process argument or secret-bearing output may be retained or displayed. Existing operator/Codex reports about that directory are preparation evidence only. The fixed prerequisite probe uses the terminal-only path in section 1A and must not write this destination.

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

**Resolution status (2026-11-19):** the **repaired replacement** fixed prerequisite probe is **NOT EXECUTED** and requires fresh Gate B checks and a new one-time SSH authorization. The earlier malformed version **was executed once** but produced invalid output and did not establish trusted protected-path evidence; that authorization is consumed. The collector and retained-evidence paths remain **NOT AUTHORIZED**. The collector cannot be proposed with guessed protected paths. The matrix below separates the already reported delivery and metadata observations from resources that are actually absent and from canonical resources that remain unresolved.

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

### Minimal prerequisite inspection packet — repaired replacement, not executed

#### Historical failed execution — 2026-11-19

The owner reported one execution of the previous fixed read-only SSH command. Its terminal output was not structurally valid and was not accepted as Gate 1 evidence; no raw output is retained here and no retry is authorized by that historical approval. Offline reproduction identified shell word splitting of the group list and unquoted `regular file` metadata, including candidate records, plus the archive-path mismatch between the old probe and the recorded delivered archive. This audit record is retained for provenance only. The repaired command below requires a separate future one-time execution decision.

#### Repaired packet merged to `dev` — 2026-11-19

- **Implementation verified in repository:** [PR #2082](https://github.com/tonykslee/ClashCookies/pull/2082), reviewed head `cc7f861231d0f3633786ecf0a790d2784612b85f`, merged at `650ba69f0fc007d976c1c4eef88ff11d0f10ba84`. It corrected the delivered archive name, quoted group/metadata/hash/candidate fields, and replaced unsafe CMD caret-escaped double quotes with CMD doubled quotes (`""`). The prior CMD `^"` transport made embedded `|` vulnerable to host-shell pipeline interpretation; this is a **verified defect of the old command**, not a claim about the VM's configuration.
- **Validation boundaries:** the new `tests/gate1-prerequisite-probe.test.ts` exercises the documented packet against synthetic Bash fixtures and the existing strict validator, and adds **two Windows-only native `cmd.exe` tests**. These resolve an isolated `ssh.cmd` before real SSH, check the received arguments/remote payload and one invocation, and execute synthetic success and malformed-hash/STOP fixtures. The owner/Codex **reported local Windows PASS** (57 focused tests passed, 3 intentional skips overall). GitHub [CI run 44601591863](https://github.com/tonykslee/ClashCookies/actions/runs/44601591863) passed lint, tests, and build on **Ubuntu**; its Windows-only tests were skipped there. The fake `ssh.cmd` batch forwarding layer is not identical to the real `ssh.exe` transport. A synthetic structural `VALID` remains `provenance=UNVERIFIED`, not host proof or readiness.
- **Historical observation only:** the single owner-run SSH command returned malformed duplicate identity and file/candidate records; the archive `ABSENT` result referred to the wrong path and cannot prove loss. It did display a checkout revision and candidate states, but **none are accepted as structurally validated/current production evidence**. Do not copy the historical raw output into Git, treat candidate `ABSENT` as canonical path absence, or reuse the consumed SSH approval.
- **Operational boundary:** this repaired packet has **never been run on the VM**. The next possible action is a **new, separately authorized one-shot protected-terminal-only inspection**, with fresh SSH alias/known-host/agent/account verification, no capture, redirection, transcript, logging, retry, or collector. Codex automation previously could not provide an isolated non-retaining protected CMD terminal; do not route real SSH through a logged runner. The two pre-existing evidence-root files remain untouched. Collector execution, retained ciphertext/provenance capture, protected-resource provisioning, and release promotion are separate blocked gates.



**Target and operator:** one SSH connection and one remote command to the existing operator-managed alias `clash-vm` as `tilo`, using `BatchMode=yes`, `RequestTTY=no`, `ForwardAgent=no`, `StrictHostKeyChecking=yes`, `ConnectTimeout=5` and `ConnectionAttempts=1`. The operator must verify the existing approved alias and its configured known-hosts binding in the protected local SSH configuration before interpreting any output. Do not create keys, change SSH configuration, disable host-key checking, accept a new key, use `sudo`, open an interactive shell, or retry. A host/account/UID/GID mismatch is an immediate stop.

This packet deliberately separates safe prerequisite facts from wrapper control-flow review. It does **not** inspect or emit wrapper source. It does **not** emit checkout status lines or filenames. The existing reviewed collector remains the only proposed source for redacted wrapper marker counts and sanitized checkout evidence; its execution remains separately unauthorized until protected paths are independently established.

The following is the complete proposed prerequisite probe: exactly one CMD-safe `ssh` invocation, one remote shell invocation, and no retry. It is the **fixed terminal-only path** described in section 1A, not the later collector or retained-evidence path. Embedded Bash double quotes are doubled for CMD transport; caret-escaped quotes are not used. `set -Eeuo pipefail` and the `stop` path prevent later probes after an unexpected utility, permission, timeout, hash, replacement or validation failure. Expected `ABSENT`, `SYMLINK` and detached classifications are fixed observations and do not themselves execute another probe. Every potentially blocking remote utility is wrapped with the existing GNU `timeout` utility for five seconds; utility stderr is discarded rather than captured. The remote command emits only fixed-field summaries: numeric identity, file kind/owner/mode/size, a 64-hex digest, `ATTACHED`/`DETACHED`/`UNKNOWN`, bounded state labels, or a numeric count. It never emits branch names, source lines, configuration values, credential values, command arguments, status records or filenames.

```cmd
ssh -T -l tilo -o BatchMode=yes -o RequestTTY=no -o ForwardAgent=no -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 clash-vm "set -Eeuo pipefail; stop(){ printf 'STOP|reason=%s\n' ""$1""; exit 1; }; need(){ command -v ""$1"" >/dev/null 2>&1 || stop MISSING_UTILITY; }; need timeout; need id; need stat; need sha256sum; need awk; need git; need bash; probe_hash(){ label=""$1""; path=""$2""; if test -L ""$path""; then printf '%s|SYMLINK\n' ""$label""; elif test ! -f ""$path""; then printf '%s|ABSENT\n' ""$label""; else meta=$(timeout --signal=TERM --kill-after=1s 5s stat -c '%F|%u|%g|%a|%s' -- ""$path"" 2>/dev/null) || stop METADATA; case ""$meta"" in regular\ file\|*) ;; *) stop REPLACED_OR_UNKNOWN;; esac; hash=$(timeout --signal=TERM --kill-after=1s 5s sha256sum -- ""$path"" 2>/dev/null | awk '{print $1}') || stop HASH; if printf '%s' ""$hash"" | awk 'length($0)==64 && $0 !~ /[^0-9a-fA-F]/ {ok=1} END {exit !ok}'; then :; else stop HASH_INVALID; fi; printf '%s|%s|sha256=%s\n' ""$label"" ""$meta"" ""$hash""; fi; }; probe_candidate(){ label=""$1""; path=""$2""; if test -L ""$path""; then printf '%s|SYMLINK\n' ""$label""; elif test ! -e ""$path""; then printf '%s|ABSENT\n' ""$label""; else meta=$(timeout --signal=TERM --kill-after=1s 5s stat -c '%F|%u|%g|%a|%s' -- ""$path"" 2>/dev/null) || stop METADATA; case ""$meta"" in regular\ file\|*|directory\|*) printf '%s|PRESENT|%s\n' ""$label"" ""$meta"";; *) stop REPLACED_OR_UNKNOWN;; esac; fi; }; uid=$(timeout --signal=TERM --kill-after=1s 5s id -u 2>/dev/null) || stop IDENTITY; gid=$(timeout --signal=TERM --kill-after=1s 5s id -g 2>/dev/null) || stop IDENTITY; groups=$(timeout --signal=TERM --kill-after=1s 5s id -G 2>/dev/null) || stop IDENTITY; group_count=$(printf '%s\n' ""$groups"" | awk '{print NF}') || stop IDENTITY; printf 'identity|uid=%s|gid=%s|group_count=%s\n' ""$uid"" ""$gid"" ""$group_count""; probe_hash archive /home/tilo/.clashcookies-discovery/clashcookies-production-vm-discovery-1cb81528.tar; probe_hash adapter /home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528/ops/deploy/direct-docker-adapter.js; probe_hash collector /home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528/ops/deploy/discovery/production-vm-discovery.sh; probe_hash validator /home/tilo/.clashcookies-discovery/production-vm-discovery-1cb81528/ops/deploy/discovery/runtime-contract-validator.js; if test -L ""/home/tilo/deploy-prod.sh""; then printf 'wrapper|SYMLINK\n'; elif test ! -f ""/home/tilo/deploy-prod.sh""; then printf 'wrapper|MISSING\n'; else meta=$(timeout --signal=TERM --kill-after=1s 5s stat -c '%F|%u|%g|%a|%s' -- ""/home/tilo/deploy-prod.sh"" 2>/dev/null) || stop WRAPPER_METADATA; case ""$meta"" in regular\ file\|*) ;; *) stop WRAPPER_REPLACED_OR_UNKNOWN;; esac; hash=$(timeout --signal=TERM --kill-after=1s 5s sha256sum -- ""/home/tilo/deploy-prod.sh"" 2>/dev/null | awk '{print $1}') || stop WRAPPER_HASH; if printf '%s' ""$hash"" | awk 'length($0)==64 && $0 !~ /[^0-9a-fA-F]/ {ok=1} END {exit !ok}'; then :; else stop WRAPPER_HASH_INVALID; fi; printf 'wrapper|metadata=%s|sha256=%s\n' ""$meta"" ""$hash""; if timeout --signal=TERM --kill-after=1s 5s bash -n -- ""/home/tilo/deploy-prod.sh"" 2>/dev/null; then printf 'wrapper|syntax=PASS\n'; else printf 'wrapper|syntax=FAIL_OR_TIMEOUT\n'; stop WRAPPER_SYNTAX; fi; printf 'wrapper|control_flow=DEFERRED_TO_REDACTED_COLLECTOR\n'; fi; app=""/home/tilo/apps/clashcookies-prod""; head=$(timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C ""$app"" rev-parse --verify HEAD 2>/dev/null) || stop CHECKOUT_HEAD; if printf '%s' ""$head"" | awk 'length($0)==40 && $0 !~ /[^0-9a-fA-F]/ {ok=1} END {exit !ok}'; then :; else stop CHECKOUT_HEAD_INVALID; fi; printf 'checkout|head=%s\n' ""$head""; if branch=$(timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C ""$app"" symbolic-ref --short -q HEAD 2>/dev/null); then printf 'checkout|branch=ATTACHED\n'; else rc=$?; case ""$rc"" in 1) printf 'checkout|branch=DETACHED\n';; 124|137) printf 'checkout|branch=UNKNOWN\n'; stop CHECKOUT_BRANCH_TIMEOUT;; *) printf 'checkout|branch=UNKNOWN\n'; stop CHECKOUT_BRANCH_UNKNOWN;; esac; fi; if timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C ""$app"" diff --quiet --no-ext-diff 2>/dev/null; then clean=CLEAN; else rc=$?; case ""$rc"" in 1) clean=CHANGED;; *) clean=UNKNOWN; printf 'checkout|tracked_clean=%s\n' ""$clean""; stop CHECKOUT_CLEANLINESS;; esac; fi; if timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C ""$app"" diff --cached --quiet --no-ext-diff 2>/dev/null; then :; else rc=$?; case ""$rc"" in 1) clean=CHANGED;; *) clean=UNKNOWN; printf 'checkout|tracked_clean=%s\n' ""$clean""; stop CHECKOUT_INDEX;; esac; fi; printf 'checkout|tracked_clean=%s\n' ""$clean""; count=$(timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C ""$app"" ls-files --others --exclude-standard -z 2>/dev/null | awk -v RS='\0' 'NF {n++} END {print n+0}') || stop UNTRACKED_COUNT; if printf '%s' ""$count"" | awk '$0 ~ /^[0-9]+$/ {ok=1} END {exit !ok}'; then :; else stop UNTRACKED_COUNT_INVALID; fi; printf 'checkout|untracked_count=%s\n' ""$count""; digest=$(timeout --signal=TERM --kill-after=1s 5s env GIT_OPTIONAL_LOCKS=0 git -C ""$app"" ls-files --others --exclude-standard -z 2>/dev/null | sha256sum 2>/dev/null | awk '{print $1}') || stop UNTRACKED_DIGEST; if printf '%s' ""$digest"" | awk 'length($0)==64 && $0 !~ /[^0-9a-fA-F]/ {ok=1} END {exit !ok}'; then :; else stop UNTRACKED_DIGEST_INVALID; fi; printf 'checkout|untracked_inventory_sha256=%s\n' ""$digest""; probe_candidate outer_lock /run/lock/clashcookies-prod-deploy.lock; probe_candidate migration_lock /run/lock/clashcookies-prod-migration.lock; probe_candidate executor_candidate /home/tilo/deploy-assets/REVIEWED-HELPER.sh; probe_candidate credential_candidate /etc/clashcookies/production-db.env; probe_candidate release_record_candidate /var/lib/clashcookies/release-record.ndjson; probe_candidate env_candidate ""/home/tilo/apps/clashcookies-prod/.env""; probe_candidate candidate_worktree ""/home/tilo/apps/clashcookies-prod-replacement"""
```

The packet emits no wrapper source, matching fragments, configuration values, environment contents, credential values, process arguments, arbitrary paths, branch names, or untracked filenames. Wrapper control-flow evidence is explicitly `DEFERRED_TO_REDACTED_COLLECTOR`; the marker remains metadata only and never proves live shared-lock participation. The checkout uses `GIT_OPTIONAL_LOCKS=0`, `git diff --quiet` for tracked cleanliness, and `git ls-files --others --exclude-standard -z` piped only to a numeric counter and SHA-256 digest; names and contents never reach stdout. The exact `HEAD`, tracked cleanliness, numeric unknown-file count and optional digest remain available without exposing names.

**Output and timeout contract:** the bounds below are deliberately separated:

| Property | Enforced by the remote command | Enforced by offline validator or manual review |
| --- | --- | --- |
| Per-utility execution | `timeout --signal=TERM --kill-after=1s 5s`, `set -Eeuo pipefail`, fixed allowlist and fail-closed `STOP` path | Confirm the expected utility result or `STOP` record |
| SSH connection | `BatchMode=yes`, `RequestTTY=no`, `ForwardAgent=no`, `StrictHostKeyChecking=yes`, `ConnectTimeout=5`, `ConnectionAttempts=1`; one invocation only | Verify the existing approved alias/known-host binding and reject unexpected host/account/UID/GID |
| Aggregate session runtime | **Not enforced**; per-utility timeout is not an aggregate SSH timeout | Do not claim a session deadline; stop manual review if the session exceeds the approved operational window |
| Output schema and redaction | Fixed `printf` records, no source/branch/name/value emission, stderr discarded, and no later probes after an unexpected failure | Strictly check one approved record per line, no extra fields/lines, line <=1 KiB, total <=8 KiB, valid hashes/metadata, no truncation and no mixed SSH diagnostics |

No general transport-size or aggregate-timeout guarantee is claimed. The command's normal fixed output is expected to remain below 8 KiB, but the 1 KiB line and 8 KiB total limits are not enforced by SSH itself. The offline validator below is for a retained envelope; it rejects unexpected, oversized, malformed, truncated, incomplete or sensitive input, but it cannot establish host identity, authorization or a trusted capture provenance. The fixed prerequisite probe has no retained stdout artifact and therefore does not use that validator; its bounded terminal output must be reviewed under the same stop conditions and then discarded. The later collector/retained-evidence path remains `NOT READY FOR EXECUTION` until the separate capture/provenance boundary is approved. Any extra line, oversized line/stream, malformed field, truncated stream, mixed diagnostic, nonzero SSH state or secret-bearing output is `INCOMPLETE`, `INVALID` or `UNKNOWN`, never evidence. A missing utility is `MISSING_UTILITY`; permission or timeout failure is `STOP`; a missing wrapper/candidate is `ABSENT`; no marker review is `DEFERRED`, not `PASS`.

**Private evidence handling:** for the fixed prerequisite probe, no remote evidence file is created and no stdout capture is authorized; display only the fixed summaries in a protected operator terminal and discard them after review. Retaining stdout, stderr or later collector evidence requires separate evidence-capture authorization and the approved local ciphertext-only destination. No plaintext, private key, passphrase, credential, environment value, raw wrapper source or filename may enter chat, Git, the VM, or an unencrypted file.

#### Owner-reported repaired prerequisite execution — 2026-11-19 (terminal-only, no trusted retained capture)

**Operational observation, not independently captured evidence:** After the repaired packet was merged, the owner ran one protected-terminal remote Gate B verification and then the unchanged repaired Gate C SSH command from current `dev`. The owner shared the displayed terminal records for review. The original previously failed command was **not retried**; the replacement command has now had **one live invocation**. This consumes the new one-shot Gate C execution authorization. No further SSH attempts, substitutions, collector invocation or capture follow from this report.

- **Gate B remote identity/access, operator-observed PASS:** `clash-vm` authenticated as `tilo`, UID/GID `1000:1000`, four numeric supplementary groups with named `tilo`, `sudo`, `users`, `docker`; the fixed read/traverse checks returned `GATE_B_ACCESS=PASS`. Earlier local checks had reported effective strict SSH controls, alias/account configuration, configured known-host entries and an agent identity. The expected approved host-key binding was **not independently attested by ChatGPT**, even though strict host-key checking permitted the connection.
- **Fixed Gate C output, manually schema-consistent:** one identity record, all four artifact metadata/hash records, wrapper metadata/syntax/deferred-control-flow records, checkout records and seven candidate records appeared in expected order with no visible `STOP` or malformed/extra record. Archive, adapter, collector and validator SHA-256 values **match the four pinned repository allowlist hashes**. The archive is a regular file reported as `1000:1000`, mode `0600`; extracted adapter, collector and validator are reported as regular `1000:1000`, mode `0664`. This establishes current *operator-reported terminal observations*, not encrypted evidence custody, signed provenance or execution authority for any artifact.
- **Wrapper and checkout:** wrapper regular file identity remains `1001:1001`, mode `0755`, size `7348`, same previously observed SHA-256; `bash -n` reported `PASS`, but control-flow participation remains `DEFERRED_TO_REDACTED_COLLECTOR` and the previously reviewed canonical-lock discrepancy remains **FAIL**. Production checkout `HEAD` remains `0d2a49bbc33fe42bfbac56a2583e7d114b71cfad`, branch `ATTACHED`, tracked state `CLEAN`, seven pre-existing untracked files inventoried by count/digest only and preserved.
- **Candidate classification:** fixed candidate records report `ABSENT` for historical outer lock, migration lock, executor example, credential example and release-record example, plus the replacement worktree; this is **not absence of canonical selected resources**. The observed `.env` candidate is `PRESENT`, regular file `1000:1000`, mode `0664`, size `1727`. Contents were not read. If selected as a migration credential source, `0664` fails the proposed protected-credential permission policy. Canonical outer/inner locks, immutable executor, protected credential source and append-only release-record location all remain **UNKNOWN/BLOCKED**.
- **Limitations:** The posted terminal text did not independently attest the SSH process exit code or byte-exact stdout capture. No approved retained envelope/provenance/ciphertext exists, and the offline validator was **not run on a live captured bundle**. The visible fixed-format output is manually consistent, **not a formal `VALID` provenance claim or a complete Gate 1 release PASS**. Display output was shared in chat despite the transient/no-chat handling instruction; do not re-copy it or treat this sharing as authorized retained evidence. No new evidence file or production mutation is established by this report.
- **Disposition:** **repaired prerequisite live invocation = OBSERVED / manual schema review consistent; trusted capture = UNVERIFIED; installation = BLOCKED; collector and release = NOT AUTHORIZED**. New scope/approval is required for any further remote inspection. Do not rerun this packet or interpret absent candidate paths as canonical protected configuration.

### Offline security regression validation

This update adds the offline-only validator `ops/deploy/discovery/gate1-prerequisite-validator.js` and focused synthetic tests. It adds no production execution test. Offline validation uses synthetic values and the existing reviewed collector contract only:

- Secret-bearing wrapper lines are represented only by `wrapper|control_flow=DEFERRED_TO_REDACTED_COLLECTOR`; no source fragment is emitted.
- Sensitive untracked names are consumed by the NUL-delimited count/digest pipeline; only `untracked_count` and a 64-hex digest are allowed out.
- No-marker wrapper state remains `DEFERRED`; missing wrapper is `MISSING`; missing utility, permission failure, timeout, malformed output, truncation and replacement are non-PASS outcomes.
- The validator regression suite covers exactly one fixed output order, expected `ABSENT`/`SYMLINK` states, `ATTACHED`/`DETACHED`/`UNKNOWN`, empty inventory, missing/duplicate/unexpected/out-of-order records, unknown/extra/missing fields, numeric/hash/HEAD/mode/size failures, raw branch/filename/source/credential-like input, blank/oversized/>8 KiB/truncated/mixed-diagnostic input, nonzero/interrupted/STOP/timeout streams, malformed provenance, identity and artifact mismatches, unsupported schema, contradictory status, control characters and secret-bearing malformed output. Rejected content is never included in validator output.
- Existing `tests/production-vm-discovery.test.ts` covers secret-bearing wrapper redaction, bounded output, malformed/failed commands, protected-path failures and `GIT_OPTIONAL_LOCKS=0`. The focused suite completed all 12 tests in 194.20 seconds on Windows; the delay is reproducible Git Bash subprocess overhead, not a test hang, timeout or orphaned process. A local synthetic summary check additionally rejects secret strings, filenames, extra lines and oversized/truncated sentinels before accepting the fixed summary shape.
- `tests/gate1-prerequisite-probe.test.ts` exercises this complete documented command against synthetic Bash fixtures and, on Windows, sends the unchanged line through native `cmd.exe` to an isolated fake `ssh.cmd` before running the received remote string locally. It covers regular-file metadata (including `.env` candidate metadata), absent archive/wrapper states, malformed artifact hashes, pipefail/STOP short-circuiting, the single numeric group count, the delivered archive path, actual CMD argv forwarding, and the existing validator. The focused repair run passed 4 Bash probe tests plus 2 Windows CMD transport tests and 54 validator tests, with 3 pre-existing validator tests skipped.
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
I authorize exactly one read-only Gate 1 protected-path prerequisite inspection of the named existing ClashCookies paths using the existing SSH alias clash-vm as the freshly verified account tilo. Before interpreting output, the operator must verify the existing approved alias and known-host binding; the command must use BatchMode=yes, RequestTTY=no, ForwardAgent=no, StrictHostKeyChecking=yes, ConnectTimeout=5 and ConnectionAttempts=1. It may run only the single fixed terminal-only command in the approved packet, with no stdout capture, evidence file, age process, provenance sidecar, sudo, TTY, retries, file transfer, extraction, collector execution, Docker, PostgreSQL, wrapper execution, credential/environment reads, lock acquisition, release-record operation, permission change, directory creation, deployment, migration, backup, timer activation, staging change or release promotion. Any identity mismatch, unresolved path, hash mismatch, secret-bearing output, mutation attempt or incomplete output is a stop. This authorization does not authorize Gate 1 collector execution, retained evidence capture or any later provisioning. A separate capture/custody authorization remains required before retaining output or running the collector.
UTC timestamp: ____________________   Approver: ____________________   Evidence reference: ____________________
```

## Gate 1 owner/operator authorization and encrypted-evidence custody decision packet

**Packet status:** `PROPOSED` and reviewable offline; all live-access, evidence-capture, custody, interpretation, collector, and provisioning gates remain `UNKNOWN`/`BLOCKED`. This section is the canonical owner/operator decision packet for the already merged offline components. It adds no executor, SSH wrapper, capture path, recipient, retention service, deployment infrastructure, or runtime behavior.

### Decision posture and classifications

Use the following meanings in every approval record:

| Classification | Meaning in this packet |
| --- | --- |
| `VERIFIED` | Directly established by the named bounded check or offline artifact inspection. It does not authorize another gate. |
| `OBSERVED` | Reported by an operator/Codex or found in a dated document; useful context, not independently fresh trust. |
| `PROPOSED` | A candidate contract or control awaiting owner approval. It is not a path, recipient, or permission. |
| `UNKNOWN` | Not independently established, unavailable, ambiguous, or intentionally withheld. Do not fill it by inference. |
| `BLOCKED` | A required authorization, custody, identity, recovery, or safety condition is not closed. |

Current decision: offline repository behavior is `VERIFIED` as repository evidence; local age ciphertext behavior is `OBSERVED`/repository-tested with `custody=RESTRICTED_UNVERIFIED`; production recipient ownership, private-root approval, retention, recovery, trusted SSH identity, and human evidence acceptance are `UNKNOWN`/`BLOCKED`.

### 1. Purpose, permitted scope, and named target

The exact purpose is one bounded decision-support packet for a possible future Gate 1 read-only production verification. The only proposed inspection purpose is to identify and classify, without changing them: the existing deployment wrapper and checkout; the approved operator identity; direct-Docker application/runtime singleton and host PID/cgroup correlation; Compose PostgreSQL topology and, only if separately selected, read-only database identity; deployed startup migration behavior; protected-resource metadata; health/monitoring/disk/inode/backup/timer/staging state; and the identity of the pinned inspection artifacts.

The permitted inspection scope is one existing SSH connection, one remote command, one existing remote account, fixed read-only probes, bounded sanitized summaries, and offline review. It excludes collector execution until Gate E, evidence capture until the separately named capture approval and Gate A custody approval, wrapper/app/Docker/PostgreSQL execution or restart, credential/environment/argument reads, locks and release records, file transfer/extraction unless separately approved, permission changes, directory creation, deployment, migration, backup, timer activation, staging changes, and release promotion. No production access is authorized by this document update.

### 2. Existing SSH alias, operator identity, and host-key requirements

| Item | Required value or check | Status |
| --- | --- | --- |
| SSH alias | Existing operator-managed alias `clash-vm` | `OBSERVED`; must be freshly verified in the operator's protected SSH configuration |
| Remote account | `tilo` | `OBSERVED`; must be freshly verified as the account used by the one invocation |
| UID/GID/groups | OS-backed effective UID, GID, and complete supplementary groups from the actual session | `UNKNOWN` until fresh evidence; caller-supplied claims are rejected |
| Host key | `StrictHostKeyChecking=yes`; existing approved alias-to-known-host binding and expected host key must be checked before interpreting output | `UNKNOWN` until the operator verifies the binding |
| SSH controls | `BatchMode=yes`, `RequestTTY=no`, `ForwardAgent=no`, `ConnectTimeout=5`, `ConnectionAttempts=1`, remote-command mode only | `PROPOSED` fixed contract; one invocation only |

The operator must not accept a new key, change `known_hosts`, disable host-key checking, use an alternate alias/identity, open an interactive shell, use `sudo`, or retry. A host, key, account, UID/GID, group, or privilege mismatch is an immediate stop. A successful SSH connection is transport evidence only; it does not prove authorization, wrapper safety, or evidence custody.

### 3. Pinned inspection packet and artifact identity

The inspection packet is `schema_version=clashcookies-gate1-prerequisite-v1`, `packet_version=2026-11-17`, `target=clash-vm`, `account=tilo`. The pinned source is the merged PR #2027 collector commit `1cb81528ea34dd25f51613557d6f6030fddd0b3a`. The four code-bound artifact hashes are:

| Artifact | SHA-256 | Status |
| --- | --- | --- |
| PR #2027 archive | `8138275d0f18451ea02955357c3f2e7c22c729175c575033aae64bff7dc81015` | `VERIFIED` as the validator allowlist; remote delivery remains `OBSERVED` |
| `ops/deploy/direct-docker-adapter.js` | `379490aa007ecf6d036d5ef95e6b5ed07c5d4fdf726904bbd152ee1486032666` | `VERIFIED` as the validator allowlist |
| `ops/deploy/discovery/production-vm-discovery.sh` | `bb56d8e4ff9cd8d7d2652ef6fb3fbc6dd07e98ca3b0d65252c8a7a2ec9626da9` | `VERIFIED` as the validator allowlist |
| `ops/deploy/discovery/runtime-contract-validator.js` | `e2fbc31275003aa631aa16b984e6d2a8eaabef57646b377b82e02d27a20e27d6` | `VERIFIED` as the validator allowlist |

The local validator compares these values but cannot prove where stdout came from. A mismatched hash, unverified remote delivery, extra archive member, changed relative structure, or missing artifact is `UNKNOWN`/`BLOCKED`; do not transfer, extract, or execute a substitute.

### 4. Local age executable identity and encryption contract

The merged age adapter requires an explicit absolute executable path, launches only that path with `shell=false`, accepts only syntactically valid age recipients, and reports `custody=RESTRICTED_UNVERIFIED`. It does not pin a production executable path or hash. The installed `age v1.3.2` report is `OBSERVED` operator/Codex preparation evidence, not an approval.

Before any future local custody approval, record all of the following in restricted provenance: absolute `age` path; regular-file and canonical non-reparse status; owner, mode, ACL and stable identity; `age --version` result; SHA-256 of the exact executable; and the named owner who approved that exact binary. Until every field is present, the local executable identity is `UNKNOWN`/`BLOCKED`. Do not use a backup executable identity or a production backup recipient for discovery evidence.

The proposed encryption operation is ciphertext-only: bounded stdout is streamed to the approved age process, plaintext is never written to disk, the final ciphertext path is exclusive-created and never overwritten, and the ciphertext is fsynced and read back for bounded size/hash verification. The offline adapter proves only synthetic local process completion and ciphertext integrity; it does not prove recipient ownership, confidentiality in the proposed root, retention, recovery, Windows atomicity, or production authorization.

### 5. Recipient ownership and private ciphertext-root approval

| Decision | Candidate/reference | Required owner decision | Status |
| --- | --- | --- | --- |
| Dedicated evidence recipient | Operator-reported public recipient `age15gwzpsek379vh09r9qylc2td3rzglls9hctum063p8qkqmxhagqqmtee3g` | Name the recipient owner/custodian and approve this exact public recipient for Gate 1 evidence; confirm it is not a backup recipient | `OBSERVED`; ownership and approval `UNKNOWN/BLOCKED` |
| Private ciphertext root | `%USERPROFILE%\clashcookies-production-evidence-20261117` | Approve this exact canonical root, its owner, ACL, non-reparse status, no-broad-principal rule, and use for ciphertext plus restricted sidecars | Local shape was `VERIFIED` only in the prior offline check; custody approval `UNKNOWN/BLOCKED` |
| Destination naming | UTC timestamp plus pinned commit, with exclusive creation | Approve the exact filename grammar and a separate owner-approved quarantine location | `PROPOSED` |
| Private material | No private age identity, passphrase, plaintext, credential, environment value, or key material in VM, repo, chat, or public storage | Owner/custodian must attest this boundary | `PROPOSED`; not yet attested for a live capture |

The root must be rechecked immediately before each use for canonical path, non-reparse components, owner, ACLs, absence of broad principals, free space, and no unexpected files. A path existing, being empty, or having a metadata claim does not establish custody approval. If the exact root or quarantine path is not approved in writing, do not create or write it.

Windows limitation: the current Node runtime has no portable `O_NOFOLLOW` guarantee for every reparse-point type, and ACL checks are not a substitute for an atomic no-follow/open operation. The loader and age adapter combine `lstat`, native canonical-path comparison, descriptor `fstat`, bounded reads, fsync and post-read/post-write identity checks, but these are not a complete atomic filesystem or TOCTOU guarantee. A race after the final check may remain, and Node has no portable atomic unlink-by-identity operation across Windows filesystems. Any detected reparse, replacement, mutation, short read, ambiguous identity, or unavailable ACL/reparse result fails closed; undetectable races keep custody `RESTRICTED_UNVERIFIED`.

### 6. Retention and recovery custody decision

Discovery evidence has no inherited backup retention. The retention duration, deletion authority, and responsible owner must be explicit and must not be inferred from production backup daily/weekly retention.

| Required decision field | Current state |
| --- | --- |
| Original ciphertext retention duration | `UNKNOWN` — owner must name an exact duration and UTC deletion rule |
| Separate stderr/provenance/validator-result retention | `UNKNOWN` — owner must state whether these expire with the ciphertext and how they remain linked by hash |
| Responsible evidence custodian | `UNKNOWN` — name one accountable owner and one backup/recovery custodian |
| Deletion/quarantine authority | `UNKNOWN` — only the named owner may authorize expiry; no automatic deletion is implemented |
| Recovery identity owner | `UNKNOWN` — must be separate from the operator where practical and named in the approval |
| Independent retrieval plan | `PROPOSED`: retrieve from the off-workstation recovery copy, compare its trusted SHA-256, recover a fixed synthetic sentinel through a masked local prompt, verify wrong-passphrase rejection, and retain no plaintext file |

The latest recovery object report is operator-supplied: `ClashCookies-Discovery-Evidence-20261117.identity.age`, SHA-256 `5a050ccea53f37a7ba8c579ba4c58816b8966e01dde4ad4a9f6e07c7550daa6a`; the older AES-CBC `.identity.enc` object has separate SHA-256 `58a16cce1e788350035a19e0456b2f2af7820505d9f3f354224bee5ca785d42c` and remains retained pending retirement approval. This is `OBSERVED`, not proof of owner approval or disaster recovery. The recovery plan is not `PASS` until an independently authorized custodian retrieves it without consulting the primary workstation copy, verifies the trusted hash and recipient, completes the synthetic round-trip and wrong-passphrase test, records the result, and confirms access protection. Private identity contents and passphrases must never be recorded.

### 7. Exact evidence fields and content sensitivity

The structural envelope must contain exactly `schema_version`, `packet_version`, `target`, `account`, `expected_artifact_sha256`, `capture`, `provenance`, and `stdout`. `capture` must contain exactly `ssh_exit_status`, `stream_status`, `eof_observed`, `stdout_sha256`, and `stdout_bytes`. `provenance` must contain exactly `captured_at`, `host_key_binding`, `authorization_scope`, and `source`. The current offline validator deliberately requires `host_key_binding=EXTERNAL_REVIEW_REQUIRED`, `authorization_scope=EXTERNAL_REVIEW_REQUIRED`, and `source=EXTERNAL_LOCAL_CAPTURE_WRAPPER`; these values keep provenance `UNVERIFIED`.

The restricted provenance record for any future live bundle must additionally bind: packet/schema version; collector commit and all four artifact hashes; SSH alias/account and fresh OS identity; known-host binding reference; capture method and UTC start/end; SSH exit/stream/EOF result; stdout and stderr byte counts and SHA-256 values; ciphertext path, byte count and SHA-256; exact age executable path/version/hash; recipient and owner-approval reference; ciphertext-root and quarantine-root metadata; retention duration and custodian; recovery identity object hash/custodian/retrieval result; validator result; reviewer decisions; and every stop/interruption/quarantine reason. These are metadata references, not permission to expose source or secrets.

The stdout evidence is bounded sanitized operational metadata and remains sensitive. The ciphertext is confidential evidence. Stderr, if retained under a separate approval, is bounded diagnostic material and must be redacted. No evidence bundle may contain plaintext JSONL, private keys, passphrases, database URLs, tokens, environment values, command arguments, full Docker labels/inspect data, raw wrapper source, untracked filenames, or private monitoring URLs. A secret-bearing, overlong, malformed, mixed, or unexpected record is never accepted as evidence.

### 8. Size, timeout, and one-attempt contract

The constraints are deliberately separated by boundary:

| Boundary | Fixed constraint |
| --- | --- |
| Prerequisite SSH | `BatchMode=yes`, `RequestTTY=no`, `ForwardAgent=no`, `StrictHostKeyChecking=yes`, `ConnectTimeout=5`, `ConnectionAttempts=1`; one SSH invocation |
| Prerequisite remote utilities | Five-second `timeout` with TERM/KILL-after-1s; fixed command and fail-closed stop path |
| Prerequisite stdout | Maximum 1 KiB per line and 8 KiB total; final newline required; no aggregate SSH deadline is claimed |
| Offline JSON envelope | Maximum 32,768 UTF-8 bytes; explicit absolute input and approved-root paths |
| Pinned later collector | `DISCOVERY_MAX_OUTPUT_BYTES=131072`, `DISCOVERY_MAX_COMMAND_SECONDS=5`, `DISCOVERY_MAX_CONTAINERS=64`; one bounded invocation only, not authorized by this packet |
| Offline age adapter | Synthetic plaintext/stdout/stderr diagnostic maximum 8,192 bytes; ciphertext maximum 16,384 bytes; explicit timeout, default 10,000 ms in the adapter; no retry |

The fixed prerequisite command is not the collector. A structural `VALID` result means only that the envelope and bounded records are well-formed; it does not establish host identity, capture provenance, authorization, recipient ownership, or custody. A timeout, nonzero exit, EOF failure, truncation, duplicate attempt, destination collision, stream error, or late event is a stop and must not trigger an automatic retry.

### 9. Failure, interruption, and quarantine procedure

Before any remote mutation—which Gate 1 forbids—stop on identity mismatch, host-key uncertainty, unresolved path, artifact mismatch, missing utility, permission expansion, secret-bearing output, malformed/truncated output, nonzero status, timeout, mutation attempt, lock/release-record touch, or incomplete capture. Preserve the original bounded artifact and provenance as `INCOMPLETE` or `MALFORMED`; never hand-edit, concatenate, repair, or replace it.

For age or filesystem failure, keep any partial ciphertext only in the separately approved quarantine location. Cleanup may unlink only a newly created file whose descriptor/path identity is revalidated; if identity is missing, ambiguous, replaced, symlinked, unavailable, or changed, do not unlink and classify the artifact `QUARANTINED_INCOMPLETE`. Do not retry, overwrite, delete remote files, or interpret a partial ciphertext as evidence. Record the sanitized failure code, artifact hash/size if available, and the owner-directed recovery decision without recording raw stderr or plaintext.

No rollback is authorized because the proposed inspection is read-only. If an unexpected mutation is observed, stop immediately, preserve the evidence, do not repair or roll back the VM/database/runtime, and escalate to the owner. A quarantine artifact is not evidence acceptance and does not authorize a second attempt.

### 10. Reviewer responsibilities and evidence acceptance

The operator is responsible for verifying the existing alias, known-host binding, account, OS identity, fixed command, source artifact hashes, capture completeness, and stop conditions. The evidence custodian is responsible for the exact root/quarantine ACL and reparse checks, recipient ownership record, retention, recovery identity custody, and independent retrieval plan. The offline validator/reviewer is responsible for structural validation, byte/hash reconciliation, schema/version checks, sensitivity review, classification of every record, and preservation of the original artifact. The release owner is responsible for keeping Gate 1 and all later gates separate; no reviewer may convert a local/offline PASS into production authorization.

Evidence may be accepted for human interpretation only when the original ciphertext, bounded provenance and validator result are present; all hashes and byte counts reconcile; the packet/artifact versions match; SSH host-key and operator identity are independently verified; content sensitivity review is clean; recipient/root/retention/recovery approvals are recorded; the result is complete and non-secret-bearing; and every `UNKNOWN`/`BLOCKED` item is explicitly retained. Acceptance of evidence is not acceptance of deployment readiness.

### 11. Independent authorization text for gates A–F

Each block below is a separate decision. Checking one box does not check, imply, or pre-authorize any other box.

```text
GATE A — LOCAL RECIPIENT AND PRIVATE CIPHERTEXT CUSTODY ONLY
I authorize only the named dedicated age recipient, exact local ciphertext root,
quarantine location, ACL/reparse checks, retention duration, evidence custodian,
recovery identity custodian, and independent retrieval plan recorded in this packet.
This authorizes no SSH connection, host-key decision, remote command, evidence
capture, collector execution, production access, deployment, migration, backup,
timer activation, staging change, or protected-resource provisioning.
Recipient/root reference: ____________________  Retention: ____________________
Custodian: ____________________  Recovery reference: ____________________
UTC timestamp: ____________________  Approver: ____________________

GATE B — TRUSTED SSH HOST AND OPERATOR VERIFICATION ONLY
I authorize only one local verification of the existing approved `clash-vm` alias,
known-host binding, remote account `tilo`, OS-backed UID/GID/groups, and required
read/traverse permissions using the fixed SSH controls in this packet. No remote
inspection command, collector, wrapper, sudo, TTY, retry, credential read, lock,
release record, Docker/DB operation, capture, deployment, migration, backup,
timer, staging, or release action is authorized.
UTC timestamp: ____________________  Approver: ____________________

GATE C — ONE EXACT READ-ONLY PREREQUISITE INSPECTION ONLY
I authorize exactly one fixed, bounded, read-only prerequisite inspection using
the already verified alias/account and the pinned packet/artifact hashes. It may
inspect only the named wrapper, checkout, approved identity, candidate metadata,
and other allowlisted facts in this packet. It may not execute the collector,
wrapper, app, Docker, PostgreSQL, or migration; read credentials/environment/
arguments; acquire/touch locks or release records; capture evidence; transfer or
extract files; change permissions; create directories; retry; or alter production.
UTC timestamp: ____________________  Approver: ____________________

GATE D — EVIDENCE INTERPRETATION AND HUMAN REVIEW ONLY
I authorize only offline decryption/validation, sensitivity review, hash/byte
reconciliation, classification, and human acceptance or rejection of the named
bounded evidence bundle. This does not authorize SSH, a new capture, a rerun,
collector execution, production access, deployment, migration, backup, timer,
staging change, provisioning, or release promotion.
Evidence reference: ____________________  UTC timestamp: ____________________
Approver: ____________________

GATE E — LATER COLLECTOR EXECUTION ONLY
I authorize one later bounded invocation of the exact pinned read-only collector,
after Gates A–D prerequisites and paths are independently closed, using the exact
approved SSH/capture method and verified resource paths. It permits no wrapper/app
execution, sudo, TTY, retry, credential/environment/argument read, lock or release
record operation, Docker/DB write, migration, backup, timer, staging change,
deployment, protected-resource provisioning, or release promotion.
Collector/path reference: ____________________  UTC timestamp: ____________________
Approver: ____________________

GATE F — LATER PROTECTED-RESOURCE PROVISIONING ONLY
I authorize only the separately named filesystem/ownership/ACL/reparse-safe
provisioning changes for the approved executor, outer/inner locks, protected
credential source, append-only release record, evidence/quarantine roots, and
candidate paths. This does not authorize wrapper execution, collector execution,
Docker/DB access, migration, backup, timer activation, deployment, runtime restart,
staging changes, or `dev` to `main` promotion. Exact paths, owners, modes, ACLs,
retention, and rollback authority must be attached before any write.
Provisioning reference: ____________________  UTC timestamp: ____________________
Approver: ____________________
```

These blocks are prepared signatures, not signatures in the repository. No checked box is recorded by this documentation change.

### 12. Explicit stop conditions

Stop and classify `UNKNOWN`/`BLOCKED`—without retry or inference—if any of the following occurs: the alias, known-host binding, host key, account, UID/GID/groups, artifact commit/hash, executable identity, recipient owner, ciphertext root, ACL, reparse state, retention owner, recovery custodian, or protected path is missing or mismatched; the remote command needs `sudo`, a TTY, a second connection, a retry, an alternate identity, or a guessed/default lock path; output is nonzero, interrupted, truncated, overlong, malformed, contradictory, mixed with SSH diagnostics, or secret-bearing; a lock/release record/credential/environment/argument is touched; a path is replaced, symlinked, non-regular, writable by an unapproved principal, or has incomplete identity; the age process errors, times out, emits oversized diagnostics, encounters EPIPE, or leaves ambiguous cleanup; the destination exists or is not exclusive; the recovery hash/recipient/sentinel/wrong-passphrase result does not reconcile; a reviewer cannot classify a result without inference; or any action would access production beyond the exact approved gate.

Gate 1 retained-evidence and collector execution remains **BLOCKED / NOT READY FOR EXECUTION** until the named owner decisions and separate authorizations are actually supplied, the live identity and host-key checks are freshly performed, and the resulting evidence is independently reviewed. This status does not prohibit the distinct fixed terminal-only prerequisite probe when its Gate B and one-command SSH authorization are separately recorded. The probe still does not authorize capture, collector execution, protected-resource provisioning, deployment, migration, backup, timer activation, staging changes, or release promotion.

### 13. Gate A offline local custody preflight — 2026-11-18

This is a workstation-only, read-only verification record. It does not approve Gate A, does not authorize evidence capture, and does not proceed to Gates B–F. The untracked repository file `powershell` was preserved. No SSH session, production/VM access, cloud access, private identity, passphrase, ACL mutation, evidence write, key generation, rotation, deletion, or relocation was performed.

#### Verified technical checks

| Gate A requirement | Exact local result | Classification | Evidence source and method | Remaining decision / stop condition |
| --- | --- | --- | --- | --- |
| Age executable path, type, version, hash | `C:\Users\tonyk\AppData\Local\Microsoft\WinGet\Packages\FiloSottile.age_Microsoft.Winget.Source_8wekyb3d8bbwe\age\age.exe`; regular file; `7,172,096` bytes; `v1.3.2`; SHA-256 `2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0` | `VERIFIED` technical identity; `UNKNOWN` approval | Resolved `age.exe` from the existing PATH command, ran `--version` on that resolved path, read file metadata, hashed twice, and compared size/timestamp/attributes | Owner must approve this exact executable identity. Any path/hash/version/stat mismatch is `BLOCKED`; do not download, install, replace, or upgrade. |
| Age executable canonical/reparse and parent chain | Resolved path equals the absolute path; file and every observed parent component had no reparse flag; file identity/stat and hash rechecks were stable | `VERIFIED` local shape | `Resolve-Path`, `Get-Item`, parent-chain inspection, ACL read, and repeated metadata/hash checks | Windows/Node filesystem limitations remain; an unavailable or changed identity is a stop and keeps custody `RESTRICTED_UNVERIFIED`. |
| Age executable owner and ACL | Owner `ANT-DESKTOP-202\\tonyk`; `tonyk`, `BUILTIN\\Administrators`, and `NT AUTHORITY\\SYSTEM` have FullControl; no tested broad-principal allow-write rule was found | `VERIFIED` observed ACL shape; `UNKNOWN` policy acceptance | `Get-Acl` on the exact file; broad-principal scan covered Everyone, Users, Authenticated Users, Anonymous Logon, and application-wide principals | Owner must accept privileged/admin access and exact ACL. Any unapproved write-capable principal is `BLOCKED`. |
| Candidate public recipient | `age15gwzpsek379vh09r9qylc2td3rzglls9hctum063p8qkqmxhagqqmtee3g`; 62 characters; matches the adapter's syntax contract and is consistent across the canonical roadmap, preflight, and packet | `VERIFIED` syntax/document consistency; `OBSERVED` identity evidence; `UNKNOWN/BLOCKED` approval | Compared the candidate with `^age1[0-9a-z]{50,}$` and searched the three canonical documentation sources | A syntactically valid string does not prove ownership. Owner must name the recipient custodian and approve non-reuse of production backup recipients. |
| Private ciphertext root | `C:\Users\tonyk\clashcookies-production-evidence-20261117`; exists as a directory; canonical path equals absolute path; non-reparse; owner `ANT-DESKTOP-202\\tonyk`; immediate inventory empty; parent chain to `C:\` had no reparse components; `25,707,442,176` bytes free on `C:` | `VERIFIED` technical local shape; `UNKNOWN/BLOCKED` custody approval | Read-only `Get-Item`, `Resolve-Path`, parent-chain inspection, `Get-Acl`, safe metadata-only inventory, and drive free-space query | Owner must approve this exact root, ACL, no-broad-write rule, and use for ciphertext/provenance sidecars. Do not create or write evidence until approved. |
| Root ACL | Root ACL grants `CodexSandboxUsers` read/execute only; owner, `BUILTIN\\Administrators`, and `SYSTEM` have FullControl; no tested broad-principal allow-write rule was found | `VERIFIED` observed ACL shape; `UNKNOWN` policy acceptance | Read-only `Get-Acl`; no ACL changes | An ACL result is not owner approval or a complete Windows custody guarantee. Any broadened write access is a stop. |

The executable and root checks establish local technical facts only. They do not establish owner approval, confidentiality, recipient ownership, retention, recovery, or Gate A authorization. The adapter must continue to report `custody=RESTRICTED_UNVERIFIED` and `provenance=UNVERIFIED`.

#### Quarantine, retention, and recovery decisions

| Decision field | Current finding | Classification | Owner action required |
| --- | --- | --- | --- |
| Quarantine root | No separately approved quarantine path is documented; the verified evidence root is empty and contains no quarantine directory. Required status: `QUARANTINE_LOCATION_UNKNOWN`. Recommended candidate only: `C:\Users\tonyk\clashcookies-production-evidence-20261117\quarantine` | `UNKNOWN` / `PROPOSED` candidate / `BLOCKED` for use | Approve the exact separate location and verify its parent chain, ACL, non-reparse state, and separation from accepted evidence. Do not create it in this preflight. |
| Original ciphertext retention | No explicit owner-approved duration or UTC expiry rule exists | `UNKNOWN` / `BLOCKED` | Recommended policy for owner acceptance or modification: retain for 30 calendar days after final human review or incident closure, whichever is later; no automatic deletion. |
| Stderr/provenance/validator sidecars | No explicit sidecar retention rule exists | `UNKNOWN` / `BLOCKED` | Recommended policy: retain with the linked ciphertext for the same 30-day period, keyed by original hashes; preserve the original artifact and never hand-edit it. |
| Evidence custodian | No named custodian is recorded in the approval packet | `UNKNOWN` / `BLOCKED` | Name one accountable primary custodian and record the exact approval reference. |
| Secondary/recovery custodian | No named secondary custodian is recorded | `UNKNOWN` / `BLOCKED` | Name a separate recovery custodian where practical and record the independent retrieval responsibility. |
| Quarantine authority | No named authority is recorded | `UNKNOWN` / `BLOCKED` | Name who may classify, preserve, or release an incomplete artifact; no cleanup or retry is authorized by this preflight. |
| Deletion authority | No named authority is recorded; no retention automation exists | `UNKNOWN` / `BLOCKED` | Name the owner who may authorize expiry, with secondary-custodian acknowledgement if required. |
| Recovery object | Operator-reported `ClashCookies-Discovery-Evidence-20261117.identity.age`, SHA-256 `5a050ccea53f37a7ba8c579ba4c58816b8966e01dde4ad4a9f6e07c7550daa6a`; older AES-CBC object SHA-256 `58a16cce1e788350035a19e0456b2f2af7820505d9f3f354224bee5ca785d42c` remains pending retirement approval | `OBSERVED`; current local metadata `UNKNOWN` | Evidence is documented in `docs/roadmaps/production-backup-readiness.md` and the November 17 preflight. This task did not locate, download, open, or decrypt either object. |
| Independent retrieval | Documentation records operator/Codex-reported cloud-copy recovery and synthetic tests, but no independent retrieval was performed in this preflight | `OBSERVED` report; `UNKNOWN/BLOCKED` for current custody acceptance | An independently authorized custodian must retrieve from the off-workstation copy, compare the trusted hash, verify recipient and synthetic recovery/wrong-passphrase rejection, and retain no plaintext. |

The proposed 30-day policy is not an approval and must not be treated as inherited from backup retention. Recovery objects remain retained until the owner approves retirement after replacement custody and independent retrieval are closed. No cloud credentials or recovery material were accessed.

#### Windows/Node residual risk

The exact local checks passed, but Windows ACLs and reparse checks do not create a portable atomic no-follow/open guarantee. The current Node runtime combines `lstat`, canonical-path comparison, descriptor `fstat`, bounded reads, fsync, and post-operation identity checks; it cannot guarantee all reparse-point types or atomic unlink-by-identity. A race after the last check remains possible. Any detected replacement, reparse point, ambiguous identity, unavailable ACL/reparse result, collision, interruption, timeout, stream error, or cleanup uncertainty is `QUARANTINED_INCOMPLETE`/`BLOCKED`; do not retry or delete by guesswork.

#### Ready-to-review Gate A decision record

The references below are resolved technical candidates, not approvals. Blank or `UNKNOWN` fields must be completed by the owner; no signature or timestamp is inserted here.

```text
GATE A — OWNER DECISION RECORD (PREPARED, NOT APPROVED)

age_executable_path=
C:\Users\tonyk\AppData\Local\Microsoft\WinGet\Packages\FiloSottile.age_Microsoft.Winget.Source_8wekyb3d8bbwe\age\age.exe
age_executable_version=v1.3.2
age_executable_sha256=2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0
recipient_candidate=age15gwzpsek379vh09r9qylc2td3rzglls9hctum063p8qkqmxhagqqmtee3g
ciphertext_root=C:\Users\tonyk\clashcookies-production-evidence-20261117
quarantine_root=C:\Users\tonyk\clashcookies-production-evidence-20261117\quarantine (PROPOSED; NOT CREATED)
retention_policy=PROPOSED: 30 calendar days after final human review or incident closure, whichever is later
sidecar_retention=PROPOSED: same period as linked ciphertext, keyed by original hashes
recovery_object=ClashCookies-Discovery-Evidence-20261117.identity.age
recovery_object_sha256=5a050ccea53f37a7ba8c579ba4c58816b8966e01dde4ad4a9f6e07c7550daa6a

recipient_custodian=UNKNOWN
evidence_custodian=UNKNOWN
secondary_recovery_custodian=UNKNOWN
quarantine_authority=UNKNOWN
deletion_authority=UNKNOWN
independent_retrieval_status=UNKNOWN/BLOCKED
owner_acl_reparse_acceptance=UNKNOWN
owner_approval=NOT RECORDED
approval_timestamp=NOT RECORDED

[ ] Owner accepts the exact executable, recipient, root, quarantine candidate,
    ACL/reparse safeguards, retention, custodians, and recovery plan above.
[ ] Owner records named custodians/authorities and independently verified retrieval.
[ ] Owner authorizes Gate A only; no Gates B–F are authorized by this record.
Owner: ____________________  Approval reference: ____________________
UTC timestamp: ____________________
```

Gate A is not complete. The exact executable and evidence-root technical checks are `VERIFIED`; recipient ownership, owner approval, quarantine, retention, custodians, recovery custody, and Windows residual-risk acceptance remain `UNKNOWN`/`BLOCKED`. Stop here; do not proceed to Gate B.

### 14. Final Gate A owner-decision preparation — 2026-11-18

PR #2067 reconciled the recovery-object references above: the newer age object is `5a050ccea53f37a7ba8c579ba4c58816b8966e01dde4ad4a9f6e07c7550daa6a`; the older AES-CBC object is separately `58a16cce1e788350035a19e0456b2f2af7820505d9f3f354224bee5ca785d42c`. The following is a compact final decision summary; it does not repeat or upgrade the completed technical checks.

| Gate A item | Reused evidence | Classification | Final owner decision required |
| --- | --- | --- | --- |
| A. Exact age executable approval | Local `age.exe` identity, `v1.3.2`, SHA-256, ACL, canonical path and parent-chain checks from the 2026-11-18 preflight | Technical `VERIFIED`; approval `UNKNOWN` | Approve the exact path, version, hash and ACL as the only local age executable for this custody boundary |
| B. Recipient ownership and custody | Candidate syntax/document consistency is verified; operator/Codex reports recovery to the same recipient | `OBSERVED` identity evidence; ownership/approval `UNKNOWN/BLOCKED` | Name the recipient custodian and approve this exact public recipient; confirm no production backup recipient is reused |
| C. Private ciphertext root | Existing root is empty, canonical, non-reparse, ACL-checked and has sufficient free space | Technical `VERIFIED`; custody approval `UNKNOWN/BLOCKED` | Approve the exact root and its ACL/reparse safeguards for ciphertext and linked sidecars |
| D. Quarantine location | No approved location exists; proposed `C:\Users\tonyk\clashcookies-production-evidence-20261117\quarantine` has not been created or inspected | `UNKNOWN` / `PROPOSED` / `BLOCKED` for use | Approve this candidate or name another exact location; require separate metadata/ACL/reparse verification before use |
| E. Windows residual-risk acceptance | Current Node/Windows checks are best-effort, not atomic no-follow or atomic unlink-by-identity | `VERIFIED` limitation; acceptance `UNKNOWN/BLOCKED` | Explicitly accept the residual reparse/TOCTOU/ACL limitation while retaining fail-closed cleanup |
| F. Ciphertext retention | No approved duration exists; a 30-day policy is proposed | `PROPOSED` / `BLOCKED` pending acceptance | Accept or modify the precise UTC policy below |
| G. Sidecar retention | No separate rule exists | `PROPOSED` / `BLOCKED` | Accept the same retention and hash linkage for provenance, validator output and permitted diagnostics |
| H. Primary evidence custodian | No named person is recorded | `UNKNOWN/BLOCKED` | Name the accountable primary custodian; recommended role is the owner |
| I. Secondary recovery custodian | No named person is recorded | `UNKNOWN/BLOCKED` | Name a separate trusted individual where practical; do not infer from operator access |
| J. Quarantine authority | No named authority is recorded | `UNKNOWN/BLOCKED` | Name who may classify, preserve or release incomplete artifacts; recommended role is the owner |
| K. Deletion authority | No named authority or automation exists | `UNKNOWN/BLOCKED` | Name who may authorize expiry; recommended model is owner approval with secondary acknowledgement |
| L. Independent recovery evidence | Cloud retrieval and synthetic recovery are operator/Codex-reported, not freshly accepted in this preflight | `OBSERVED`; acceptance `UNKNOWN/BLOCKED` | Owner authorizes a separately named secondary custodian to perform one independent retrieval and retain only bounded provenance/results |

#### Ready for owner decision

- Technical identity and local shape of the exact age executable and private ciphertext root are verified; no additional safe offline check materially closes the approval gaps.
- Proposed choices are available: the quarantine candidate, 30-day retention, matching sidecar retention, no automatic deletion, owner-primary custody, separate secondary recovery custody, and recovery-object retention until explicit retirement approval.
- Residual risk is explicit: recipient syntax is not ownership, ACL/reparse checks are not atomic Windows custody, and operator-reported recovery is not fresh independent acceptance.

#### Requires owner input

The owner must name/accept the recipient custodian, primary evidence custodian, secondary recovery custodian, quarantine authority, deletion authority, exact quarantine path, retention wording, and Windows residual-risk acceptance. The owner must also decide whether to authorize the independent recovery verification described below. No person is assigned by this document.

#### Secondary recovery custodian deferral — 2026-11-19

**Owner decision: DEFER appointment only.** The owner expressly chose not to assign a secondary recovery custodian yet. Record `secondary_recovery_custodian=UNASSIGNED — DEFERRED`, not an appointment, substitute custodian, waiver, acceptance of recovery evidence, or approval of Gate A. The existing operator/Codex-reported independent cloud-copy recovery remains `OBSERVED`; independent secondary-custodian recovery remains `UNKNOWN/BLOCKED`. All other proposed Gate A decisions (executable/recipient/root, quarantine, retention, named primary/recipient/quarantine/deletion authorities, Windows residual-risk acceptance and evidence acceptance) still require explicit owner choices. **Gate A remains NOT APPROVED, Gate 1 remains BLOCKED, and Gates B–F remain unauthorized.** No SSH, evidence capture, recovery-object access, collector execution, provisioning, deployment, migration, timer activation, or release action follows from this deferral.

#### Owner-approved Gate A custody policy defaults — 2026-11-19

**Owner decision:** The project owner approved the *remaining proposed Gate A custody-policy defaults as one package* in the 2026-11-19 conversation, after separately directing that the secondary recovery custodian be deferred. This is a **recorded policy decision only**; no standalone signed approval reference or exact UTC approval time was supplied, and neither is invented here. This decision supersedes the earlier *proposed / awaiting owner choice* labels for the specific defaults below, but does not rewrite the historical pre-approval evidence or complete Gate A.

| Decision | Recorded owner-approved policy | Operational boundary |
| --- | --- | --- |
| Dedicated local age executable | Accept the exact `age.exe` path, version `v1.3.2`, SHA-256 `2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0`, and prior reported owner/ACL/reparse checks in the prepared Gate A record above | Approval of an identity is not fresh verification or permission to launch age against real evidence |
| Dedicated public recipient | Accept `age15gwzpsek379vh09r9qylc2td3rzglls9hctum063p8qkqmxhagqqmtee3g` exclusively for discovery evidence, not production backup recipient reuse; assign recipient custody to the project/repository owner (`tonykslee`) | Recipient syntax and prior observed matching recovery do not prove independent secondary custody |
| Private ciphertext root | Accept `C:\Users\tonyk\clashcookies-production-evidence-20261117` with the previously checked canonical, restricted-ACL and non-reparse requirements | No output capture, file write or new access is authorized |
| Quarantine root | Accept `C:\Users\tonyk\clashcookies-production-evidence-20261117\quarantine` as the selected location | Location remains **UNVERIFIED FOR USE** until a separately authorized metadata/ACL/reparse inspection; do not create it by this policy decision |
| Ciphertext and sidecar retention | Retain original accepted ciphertext, original-hash-linked provenance, validator results and permitted diagnostics for **30 calendar days after the later of recorded UTC final human review or recorded UTC incident closure**; legal/security/owner hold suspends expiry; no automatic deletion or editing | Quarantined/incomplete objects remain preserved until separately authorized classification/disposition; legacy and new recovery objects remain retained until independent recovery custody and specific retirement approval |
| Primary evidence custodian | Project/repository owner (`tonykslee`) | Does not implicitly approve future capture or give another principal access |
| Quarantine authority | Project/repository owner (`tonykslee`) | No quarantine cleanup or release authorized now |
| Deletion authority | Project/repository owner (`tonykslee`), with secondary acknowledgement when an independent secondary custodian is appointed | No deletion without a separate owner disposition; no automated deletion |
| Windows / Node residual risks | Owner accepts the documented best-effort ACL/reparse/TOCTOU and non-atomic unlink-by-identity limitations **for the proposed local custody policy**, while retaining fail-closed quarantine and no-guess cleanup | Risk acceptance does not establish atomic filesystem safety or expand operational authorization |
| Secondary recovery custodian | **UNASSIGNED — DEFERRED**, per the earlier owner decision | No substitute custodian, waiver or secondary recovery attestation |
| Previous recovery evidence | Retain earlier operator/Codex-reported cloud-copy recovery and synthetic tests as `OBSERVED` | Independent secondary-custodian recovery acceptance stays **UNKNOWN/BLOCKED**; no fresh test is authorized or claimed |

**Disposition:** owner-approved *custody-policy defaults* = **RECORDED**; **full Gate A acceptance/execution = BLOCKED** pending unassigned secondary recovery custody and independent acceptance, the unverified quarantine path, and any separately required operational authorizations. `custody=RESTRICTED_UNVERIFIED` and `provenance=UNVERIFIED` remain unchanged. **Retained Gate 1 evidence/collector execution is not ready; Gates B–F remain separately gated.** This dated custody decision does not authorize or prohibit the distinct fixed terminal-only prerequisite probe; that probe requires its own recorded Gate B and one-command SSH authorization and must not retain output. No evidence capture, collector invocation, recovery-object access, provision/install/rehearsal, backup, migration, timer, staging, or `dev` to `main` promotion is authorized by this decision. Draft release PR #1983 remains NO-GO.

The earlier proposed authorization example and historical `UNKNOWN` entries below remain an audit trail of their pre-decision state; use this dated decision record for the owner-approved defaults, not as evidence of completed live custody controls.

#### Proposed precise retention wording

`PROPOSED — not approved:` retain the original accepted ciphertext, linked provenance, validator result, and permitted diagnostic sidecars until 30 calendar days after the later of (1) final human review completion recorded in UTC or (2) incident closure recorded in UTC. A legal, security, or owner-directed hold suspends expiry until explicitly released. Quarantined or incomplete artifacts remain preserved until classification and the same owner-directed disposition; expiry is owner-authorized deletion only, with no unattended deletion. Recovery objects remain until replacement custody and independent retrieval are accepted and retirement is separately approved.

#### Recovery acceptance plan if the owner keeps it as a Gate A condition

The owner authorizes the named secondary recovery custodian—not an inferred operator—to retrieve the newer age object from the approved off-workstation copy. That custodian must compare the trusted SHA-256, confirm the unchanged recipient, perform the fixed synthetic NUL/CRLF round-trip and wrong-passphrase rejection, retain only timestamped bounded provenance and result hashes, and retain no plaintext or private identity material. Cloud credentials, passphrases, key rotation, object deletion, recovery-file relocation, and repository/chat storage remain prohibited. Until this is completed and accepted, recovery remains `UNKNOWN/BLOCKED`.

#### Proposed Gate A authorization wording

```text
I authorize Gate A only for the exact local custody decision recorded here:
age executable C:\Users\tonyk\AppData\Local\Microsoft\WinGet\Packages\FiloSottile.age_Microsoft.Winget.Source_8wekyb3d8bbwe\age\age.exe
version v1.3.2, SHA-256 2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0;
recipient age15gwzpsek379vh09r9qylc2td3rzglls9hctum063p8qkqmxhagqqmtee3g;
ciphertext root C:\Users\tonyk\clashcookies-production-evidence-20261117;
quarantine root [OWNER-APPROVED EXACT PATH]; retention [OWNER-ACCEPTED UTC POLICY];
primary custodian [NAMED OWNER]; secondary recovery custodian [NAMED TRUSTED INDIVIDUAL].
I accept the stated Windows/Node residual risks and authorize no Gates B–F, SSH,
production access, evidence capture, collector execution, provisioning, deployment,
migration, backup, timer activation, staging change, or release promotion.
Owner decision: [ ] ACCEPT  [ ] MODIFY  [ ] DECLINE
Approval reference: ____________________  UTC timestamp: ____________________
```

#### Blocking evidence

No additional local technical evidence is required for the already checked executable or root. Gate A remains blocked by missing owner decisions and, if retained as a condition, fresh independently accepted recovery evidence. `custody=RESTRICTED_UNVERIFIED`, `provenance=UNVERIFIED`, and Gate 1 **BLOCKED / NOT READY FOR EXECUTION** remain unchanged.

### 15. Owner-managed recovery alternative — 2026-11-19 (PROPOSED — NOT APPROVED)

The owner may choose to manage recovery without appointing a second person, but that is not equivalent to independent human custody. The smallest safe owner-managed arrangement reuses the existing dedicated recipient and authenticated age recovery object; it does not create another identity or recovery object. It would require two owner-controlled failure domains: the existing primary workstation copy plus the documented off-workstation recovery copy, and a separately accessible owner-controlled device/storage and credential path that does not depend on the primary workstation alone. The exact second location and access path are not established by this document.

| Scenario | Owner-managed coverage | Residual decision |
| --- | --- | --- |
| Primary workstation loss | Covered only if the off-workstation object and its access path remain available; verify from a separate device without consulting the primary copy | Separate owner-managed verification required |
| Off-workstation object corruption or loss | Covered only by a second owner-controlled copy in a distinct storage failure domain, with matching trusted hash | Exact second location and copy policy are unresolved |
| Loss of the owner’s cloud account | Not covered by the current documented OneDrive arrangement | Owner must provide a distinct storage path or accept the risk |
| Loss of the owner’s password-manager access | Not covered merely by storing the passphrase in that password manager | Owner must provide a distinct credential-recovery path or accept the risk |
| Recovery-credential compromise | Not solved by redundancy; requires incident response, recipient replacement and separately approved re-encryption | Cannot be waived by this proposal |
| Owner unavailability or incapacity | Not covered by a single-person arrangement | Explicit residual-risk acceptance is required; another person or managed escrow is necessary if this threat must be covered |
| Existing evidence | Operator/Codex-reported cloud retrieval, hash match, recipient match, synthetic recovery and wrong-passphrase rejection are reusable observations | They do not prove the second failure domain or owner-approved policy |

#### Recommendation

Do not treat owner-managed recovery as an independent-recovery PASS under the current Gate A contract. Keep `secondary_recovery_custodian=UNASSIGNED — DEFERRED` and Gate A `UNKNOWN/BLOCKED` unless the owner explicitly approves a policy exception that accepts owner unavailability/incapacity as a residual risk. External escrow is unnecessary unless the owner requires recovery while unavailable; introducing it would add a new service, credential and approval boundary.

If the owner elects the exception, the minimum acceptance evidence is: a separately authorized owner-run recovery from the existing off-workstation object on a distinct device; trusted hash and unchanged recipient match; fixed synthetic NUL/CRLF round-trip; nonempty wrong-passphrase rejection; no plaintext or private identity retained; and a recorded statement that this proves workstation/storage separation only, not independent human availability. No new recovery object, key rotation, upload, deletion or relocation is authorized by this proposal.

#### Required owner decisions

The owner must choose one of the following without inference:

1. retain the current requirement and later name a separate recovery custodian;
2. approve the owner-managed policy exception, name the distinct device/storage and credential failure domains, accept owner unavailability/incapacity as residual risk, and authorize the bounded verification above; or
3. defer Gate A without changing the contract.

Until that choice and its exact boundaries are recorded, the existing recovery evidence remains `OBSERVED`, recovery acceptance remains `UNKNOWN/BLOCKED`, and no Gate A or Gate 1 status changes.

#### Owner decision — owner-managed recovery in principle (2026-11-19; CONDITIONAL, NOT EXECUTION-APPROVED)

The owner **approved pursuing the owner-managed Gate A recovery policy exception in principle**, explicitly in reference to the previously documented recoverable secret material (the dedicated discovery-evidence age identity and off-workstation encrypted recovery object, not all application, VM, production backup, or database secrets). The owner accepted **owner unavailability/incapacity as a residual risk for this proposed single-person arrangement**; no secondary human recovery custodian is appointed. This is a **conditional policy-direction decision**, not a completed exception, approval of new credentials, or authorization for any test or operation.

- **Existing evidence reused, not upgraded:** the encrypted age recovery object `ClashCookies-Discovery-Evidence-20261117.identity.age` in the owner-controlled OneDrive arrangement was operator-reported retrieved, SHA-256 checked, recipient-matched, synthetically decrypted, and wrong-passphrase-rejected; cloud-account access remains operator-reported rather than independently inspected by GitHub/ChatGPT. The earlier legacy AES-CBC recovery arrangement documented a **Bitwarden-held passphrase**. These records must not be stretched to assert that a separate Bitwarden-independent credential path exists, that the exact newer age-object passphrase has independently verified custody, or that every Dusk production secret has this protection.
- **Still to specify and validate:** the exact distinct owner-controlled device/storage failure domain and an access path that does not solely depend on the primary workstation or the same OneDrive/Bitwarden account chain; whether independent cloud-account loss, password-manager loss, and recovery-object loss are mitigated or explicitly accepted; and a separately approved, bounded workstation-only test against the existing object if justified by the remaining evidence gap. Previous successfully reported tests must not be repeated without a demonstrated new verification purpose and separate authorization.
- **Hard limits:** credential compromise requires incident response and separately approved rotation/re-encryption; redundancy cannot protect against owner incapacity. Keep the original and legacy recovery objects until explicit disposition; do not generate, move, overwrite, access, decrypt, retire, or rotate recovery credentials under this decision.
- **Gate status unchanged:** `secondary_recovery_custodian=UNASSIGNED — DEFERRED`, `custody=RESTRICTED_UNVERIFIED`, `provenance=UNVERIFIED`, **full Gate A acceptance = BLOCKED**, **Gate 1 = BLOCKED**, and **Gates B–F = NOT AUTHORIZED**. Draft release PR #1983 stays NO-GO. The owner has **not** approved SSH, private account or secret access, off-workstation retrieval, a recovery test, collector execution, protected-path inspection, evidence capture, provisioning, broker installation, deployment, migration, backup, timer activation, staging change, or release promotion.

#### Owner-reported independent access verification — 2026-11-19 (ATTESTED; NOT REPRODUCED)

The owner stated **"yes verified"** when asked whether they have an independent way to regain access if OneDrive or Bitwarden becomes unavailable, and explicitly instructed the team to stop revisiting recovery custody and move to the next milestone. Record this as **OWNER-ATTESTED** availability of an alternative access path, **not** as evidence that ChatGPT/GitHub inspected a separate device, storage location, password-manager-independent credential path, or a fresh cryptographic recovery run. No exact alternate device, medium, access method, hash result, test log, or UTC validation timestamp was provided. Do not invent or publish these private details. Do not automatically generalize this attestation to all production secrets or backup identities.

**Decision:** maintain the previously accepted owner-managed recovery policy exception *in principle*, with owner unavailability/incapacity risk accepted and `secondary_recovery_custodian=UNASSIGNED — DEFERRED`. Reuse prior operator/Codex-reported age recovery checks as `OBSERVED`. An owner statement does not prove independent human custody or constitute a new explicit authorization for recovery tests, secret/account access, SSH, VM inspection, collector execution, evidence capture or deployment. The technical custody/provenance classifications `RESTRICTED_UNVERIFIED`/`UNVERIFIED` are unchanged; Gate A operational readiness and Gate 1 stay **BLOCKED** until their separately specified gates are satisfied.

**Next workstream:** shift to the already prepared, bounded, read-only production verification packet and identify only what can be prepared *without* accessing production. Do not initiate Gates B–F, install the broker, alter protected paths, enable backups/timers, migrate, deploy, or merge the draft release PR #1983 absent separate scoped authorization.

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

`ops/deploy/discovery/gate1-offline-age-custody.js` now provides the narrowly scoped implementation boundary for disposable local testing. It requires an explicit absolute `age` executable path, launches only that allowlisted executable with `shell=false`, streams synthetic plaintext through stdin and age ciphertext through stdout, and never exposes raw stdout/stderr in diagnostics. Plaintext and age diagnostics are bounded at **8,192 bytes**; ciphertext is bounded at **16,384 bytes**. The destination must be inside an explicitly supplied regular non-reparse root, is opened with exclusive creation (`O_EXCL`), is not overwritten, is chmod-restricted to `0600` when the platform permits, is fsynced, and is verified by post-write size and SHA-256 readback from the same descriptor. Failed-operation cleanup revalidates descriptor and pathname `dev`/`ino` identity before unlinking, rejects symlink/non-regular replacements, and leaves a quarantined incomplete artifact when identity is missing, ambiguous, unavailable or changed. There is no retry.

Disposable tests generated a test-only age identity at runtime, encrypted synthetic bounded input with the installed age `v1.3.2`, decrypted the ciphertext in memory, and verified byte-exact recovery. The suite also covers wrong identity, invalid recipient syntax, missing/process failure, interruption, timeout, truncation/oversize, tamper, collision, concurrent duplicate attempts, unsafe destinations, cleanup failure, no plaintext persistence and no production invocation. Test keys and ciphertext are removed with the disposable fixture; no key, plaintext evidence or production recipient was added to the repository.

The adapter attaches persistent error handlers to stdin/stdout/stderr and the child process, routes EPIPE, stream, spawn, interruption and timeout failures through one sanitized terminal path, clears timers on failure, ignores late data, and performs cleanup at most once. Error listeners remain installed after terminal failure so repeated shutdown errors cannot become uncaught; they are retired only when the corresponding stream/process exposes a closed lifecycle. This adapter proves age process completion and local ciphertext integrity only. It reports `custody=RESTRICTED_UNVERIFIED` and `provenance=UNVERIFIED`; recipient ownership, host identity, authorization, Windows ACL/reparse/TOCTOU guarantees, retention, recovery and evidence custody remain external decisions. Node has no portable atomic unlink-by-identity operation across Windows filesystems: identity checks prevent detectable replacements from being unlinked, but a race after the final check remains a platform limitation and keeps custody unverified. The adapter does not upload, replicate, schedule retention deletion, use B2, generate production keys, or enable a production capture path. A future production capture invocation, approved recipient, approved private destination and retention/recovery procedure require separate owner authorization. Gate 1 remains **BLOCKED / NOT READY FOR EXECUTION**, and `PHASE1_EXECUTION_ENABLED=false` remains in force.

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

**Immediate next possible step — not authorized:** the already merged, repaired **terminal-only protected-path prerequisite probe**, not the collector or the broad runtime/database verification. It requires fresh Gate B checks and a *new* explicit one-command owner authorization; the previous authorization was consumed by the malformed attempt. Its output is transient and no trusted captured evidence is created. Only after that bounded review can the owner choose a separate collector/capture decision; do not infer resolved canonical locks, executor, credentials or release-record paths from absent historical candidates.

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
