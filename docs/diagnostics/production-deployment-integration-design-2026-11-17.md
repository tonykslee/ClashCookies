# Production deployment integration design — 2026-11-17

**Repository:** `tonykslee/ClashCookies` · **base:** `dev`
**Status:** proposed documentation-only design. This document does not install, replace, activate or execute any VM deployment component.

## 1. Verified current architecture

### Live VM observations

The November 17 read-only inspection, recorded in the [operator preflight](production-vm-discovery-operator-preflight-2026-11-17.md), established:

- The production entry point is `/home/tilo/deploy-prod.sh`, a canonical regular file with SHA-256 `ae5af2b09ca329553a55da633d0c3699f97d3559ecc65197dbf9d7cf91aeb507`, owner `1001:1001`, mode `0755`, and syntax-only parsing success.
- The wrapper has no observable `DEPLOY_LOCK_PATH`/`DEPLOY_LOCK_FILE`, `flock`, atomic lock-directory, owner-record, migration-runner, executor, credential-source or release-record implementation markers. It references `docker-compose` directly and uses Git/health checks.
- `docker-compose` was not found in the inspected noninteractive SSH `PATH`; it was not executed.
- The production checkout is `/home/tilo/apps/clashcookies-prod`, canonical owner `1000:1000`, mode `0775`, on historical `main` commit `0d2a49bbc33fe42bfbac56a2583e7d114b71cfad`, with pre-existing untracked files.
- The reviewed discovery, deployment-lock, migration-aware and migration-runner files are not installed in that checkout. The checkout's `ops/deploy` directory contained only `container-start.sh` and `ensure-yarn-deps.sh` in the bounded inspection.
- `/home/tilo/apps/clashcookies-prod/.env` is a canonical regular file owned `1000:1000`, mode `0664`, size `1,727` bytes. Its contents were not read. If it is the migration credential source, it does not satisfy the repository's required private credential boundary.
- No authoritative shared lock, migration lock, protected executor, credential source or append-only release-record path was identified. Historical example paths remain unverified and must not be treated as configuration.

These are live observations, not authorization to repair the VM. The wrapper's lack of contract markers is a verified integration discrepancy; the exact protected resource paths remain unresolved.

### Repository implementation and tests

The repository-side implementation is development/test infrastructure, not an installed VM integration:

- `ops/deploy/deploy-prod.sh` is a version-controlled non-migration helper. Its proposed behavior acquires an explicit outer directory lock before checkout/runtime inspection, preserves unknown files, builds a candidate without production credentials or the active runtime, rejects Prisma changes, promotes one direct-Docker app container, health-checks `/healthz`, and retains recovery state on failure.
- The direct-Docker adapter validates the canonical `clashcookies-app` identity, expected network and loopback port, host PID/container correlation, executor and credential metadata, distinct locks and release-record metadata. It remains unconditionally mutation-disabled in Phase 1.
- `ops/deploy/migration-aware-deploy.js` is a separate future state machine. It requires explicit authorization and preflight evidence, acquires the outer lock first, invokes the runner once under a distinct inner lock, keeps the outer lock through terminal release-record handling, and fails closed on ambiguous migration, runtime or health outcomes.
- `ops/deploy/migration-runner.js` validates the target SHA, migration manifest, database identity and explicit authorization, then runs only `npm run migrate:deploy` once with an allowlisted child environment. It never acquires the outer lock.
- The lock contract is an exclusive directory with an exclusively created `owner.json`; no stale cleanup or retry is permitted. Release verifies path and owner-file identity before removing anything.
- Focused tests cover lock contention/corruption, unknown-file preservation, candidate-build failure, Prisma-change blocking, direct-Docker identity, executor/credential/path validation, strict migration environment, single migration execution, ambiguous outcomes, terminal record ordering and recovery-required states.

## 2. Implicit startup migration boundary

The repository's current `package.json` maps `start` to build plus `start:runtime`, and `start:runtime` to the compiled application start. The repository search found the explicit `migrate:deploy` script and migration runner, but no current `premigrate:deploy` or `postmigrate:deploy` script. The recovery runbook also records historical production startup behavior in which the deployed startup path could apply Prisma migrations implicitly.

Because the live checkout is historical `main` and the VM artifact was not read beyond approved metadata, the actual production startup migration behavior remains **UNKNOWN**. Before any integration, independently verify the exact deployed package/startup artifact and prove that the active runtime cannot apply migrations as a startup side effect.

The target boundary is:

1. The active runtime starts the already-reviewed application only.
2. The migration-aware orchestrator is the sole path allowed to request production migration.
3. The migration runner validates the exact release, migration manifest, database identity and inner lock, then invokes `npm run migrate:deploy` exactly once.
4. No `container-start.sh`, `npm start`, `start:runtime`, active bot container, automatic retry, `migrate resolve`, reset, blind SQL replay or implicit migration is used for the migration stage.
5. A migration failure or ambiguous connection outcome remains an incident/recovery-required state until read-only database inspection and a separately approved recovery decision classify it.

If the deployed artifact still performs implicit migration, separating that behavior is a prerequisite code/release change; this design does not claim that change has been made.

## 3. Target integration architecture (proposed)

The smallest safe architecture is a separately installed, immutable deployment entry point outside the mutable checkout. A proposed location and filename must be selected during a future VM installation review; this document intentionally does not claim that any such path exists.

### Recommended shape

1. Keep `/home/tilo/deploy-prod.sh` unchanged while the replacement is staged and independently verified.
2. Install one reviewed, hash-pinned wrapper/executor outside `/home/tilo/apps/clashcookies-prod`, owned by a protected administrative identity and executable by the approved deployment operator.
3. Make that entry point the sole owner of the outer `DEPLOY_LOCK_PATH` and the deployment state machine. It must receive the canonical lock path explicitly; it must not rely on the repository helper's guessed default.
4. Have the future legacy handoff, if retained, perform only an argument-free `exec` to the immutable entry point before any checkout, runtime, Compose or release inspection. The handoff must not acquire a second outer lock.
5. Use the migration-aware orchestrator only for a release with an exact reviewed Prisma diff and complete preflight evidence. Non-migration deployment remains a separate path that fails closed when Prisma changes are present.
6. Preserve the actual production topology: the application is a direct-Docker `clashcookies-app` runtime on the expected network and loopback port; the database may remain the Compose-managed `clashcookies-db`. The integration must inspect the approved Compose configuration only for the database topology/credential selection and must not reconstruct or replace the application runtime as Compose-owned.

### Alternatives

| Approach | Benefit | Risk / decision |
| --- | --- | --- |
| Adapt `/home/tilo/deploy-prod.sh` in place | Smallest visible path change | It is live, historically owned by another UID, lacks the shared-lock contract, and has no established protected resources. A partial edit could strand the working deployment or create double-lock behavior. Not recommended as the first integration step. |
| Install a separate immutable entry point | Keeps the working legacy path intact during staging; supports hash/ownership verification and rollback | Requires a separately authorized VM installation, operator handoff, protected paths and a tested rollback. **Recommended.** |
| Add a thin legacy shim to the immutable entry point | Preserves the existing operator command after the new path is proven | The shim must be an atomic, reviewed handoff with no pre-inspection and no duplicate outer-lock acquisition. It remains a later change, not a current permission. |
| Continue using the legacy wrapper | No immediate VM change | Leaves lock coordination, migration boundaries, credential protection and release provenance unresolved. Not acceptable for a migration-capable release gate. |

## 4. Protected-resource contracts (proposed)

All paths below are contracts, not current VM paths. A future operator must select and independently verify exact locations before configuration.

### Deployment wrapper and immutable executor

- The wrapper and executor must be regular files outside the mutable checkout, with every parent component canonical and non-symlinked.
- The administrative owner must be the identity authorized to install/replace deployment code; the deployment operator may have execute/read access but must not have write access to the installed artifact or its parents.
- The installed mode must prevent group/other modification. A normal target is owner `root`, mode `0755` for an executable wrapper, with a separate root-owned executor at `0755` or stricter as required. Exact owner/group/mode require the VM authorization record.
- Record canonical path, owner UID/GID, mode, size, mtime, SHA-256 and parent metadata before handoff. Verify again through a no-follow, descriptor-stable read before use. A digest is evidence of bytes, not proof of immutability by itself.
- Do not install over the legacy wrapper, replace a symlink, or use a mutable checkout file as the protected executor.

### Outer and inner locks

- The outer lock is one exclusive directory outside the checkout, created with atomic `mkdir` by the wrapper before any checkout, worktree, runtime, Compose or release inspection.
- The lock parent must be canonical, non-symlinked and writable only by the authorized deployment identity or a narrowly controlled deployment group. The created lock directory should be mode `0700`; its exclusive `owner.json` should be mode `0600` and contain only bounded non-secret ownership data.
- The migration lock is a different canonical directory, also outside the checkout and restricted to the migration runner. It is acquired only around the single migration stage.
- Existing, stale-looking, replaced, symlinked, corrupt or extra-content lock state is `already_locked`/ambiguous. Never delete, repair, retry or guess ownership.
- Acquisition order is outer lock first, then inner migration lock. Release order is inner lock first, terminal release-record append while the outer lock remains held, then outer lock. The runner never acquires the outer lock.

### Protected migration credential

- The credential source must be an existing regular file outside the checkout, with canonical non-symlinked parents and no broad access. The repository contract requires the recorded owner/group and mode `0600`.
- Read metadata with no-follow and descriptor replacement checks. Read contents only inside the future protected runner boundary, never in diagnostics, command arguments, process listings, release records or logs.
- Pass only the database URL and fixed migration authorization metadata to the runner child. Do not inherit Discord, cloud, monitoring, application or unrelated deployment environment values.
- The observed production `.env` mode `0664` is not an acceptable source. Its contents must remain unread until a separately approved protected replacement is verified.

### Append-only release record

- The record target must be a pre-created regular file outside the checkout with canonical parents, verified owner/group/mode and no symlink components. The exact path is unresolved.
- The wrapper must append only bounded, sanitized records using no-follow/exclusive descriptor checks and verify the target identity after open. Records must reject URLs, passwords, tokens, secrets, private keys, multiline data and unbounded output.
- The terminal `end` record is written while the outer lock is still owned. If the write fails, the result is `AMBIGUOUS`; after lock ownership may be lost, no further record write is attempted.
- File existence and mode do not prove append-only semantics. The future installation must document the filesystem/provider control that supplies the required retention and append-only boundary.

## 5. Safe transition and rollback sequence (proposed)

1. **Offline contract review.** Run the repository tests and static checks against synthetic fixtures. Confirm the direct-Docker topology, lock ordering, credential boundary, release-record redaction and startup-migration separation without contacting the VM.
2. **Read-only VM revalidation.** Independently verify the exact current wrapper, checkout identity, runtime identity, parent paths, target ownership/modes, startup artifact, health/monitoring, backup/recovery and staging conditions. Keep every unresolved path `UNKNOWN/BLOCKED`.
3. **Separate installation approval.** Approve exact wrapper/executor paths, hashes, owners/modes, outer/inner lock paths, credential source, release-record target, operator identity and rollback artifact. No path may be inferred from the historical examples.
4. **Protected staging.** Install the new artifact only into the approved immutable location, verify canonical path and digest, and leave the legacy wrapper and all existing untracked checkout files unchanged. This is a separate VM change and is not performed by this design.
5. **Non-migration rehearsal.** Use the new entry point for one separately authorized non-migration release only after the live direct-Docker app, Compose-managed database topology, health gates and lock behavior are verified. The entry point must fail before stopping the old runtime on any unknown-file, lock, identity, credential, build or singleton ambiguity.
6. **Migration-capable transition.** Only after startup migration is proven absent and the migration preflight is complete may the migration-aware path be separately authorized. It must acquire the inner lock once, invoke the runner once, and preserve an ambiguous/recovery-required state on failure.
7. **Handoff and rollback.** After the immutable path is proven, a separately reviewed legacy shim may `exec` it. If the new wrapper fails before runtime stop, leave the current runtime untouched. If a post-stop or post-migration failure occurs, preserve the release record and database state for the reviewed recovery procedure; do not automatically restart an old runtime after a committed migration, delete unknown files, reset the database or retry blindly.
8. **Retirement.** Retire or replace the legacy wrapper only under a later explicit approval after successful handoff, rollback rehearsal and operator confirmation. Do not delete the old artifact as part of the first transition.

## 6. Offline validation versus VM authorization

### Fully offline

- `bash -n` and `node --check` for the reviewed entry points.
- Focused lock tests for atomic acquisition, contention, symlink/replacement/corruption handling and cleanup failure.
- Deployment tests for unknown-file preservation, candidate-build failure, Prisma-change blocking, direct-Docker identity and health-failure recovery state.
- Migration-runner tests for explicit authorization, target/migration digest, database identity, allowlisted child environment, one invocation, no retry, ambiguous results and secret-free logs.
- Direct-Docker adapter tests for runtime/PID correlation, protected executor/credential metadata, distinct locks and sanitized append-only records.
- Synthetic filesystem fixtures for ownership/mode/path-component checks and a synthetic startup test proving the active runtime cannot invoke Prisma migrations.
- `git diff --check`, exact documentation diff review and secret-pattern review.

These checks prove repository behavior only; they do not prove VM installation, live ownership, Docker state, database identity or production readiness.

### Requires separate VM authorization

- Installing or replacing the wrapper/executor, creating or changing lock directories, creating the release record, or replacing the permissive credential source.
- Reading live Docker/container/PID/cgroup state, database identity/migration state, health/monitoring, backup/timer, staging or release state.
- Running any non-migration deployment rehearsal, migration-aware deployment, migration runner, rollback, wrapper, Docker command or database query.
- Capturing discovery evidence or changing the production checkout, runtime, Compose resources, permissions or ownership.

## 7. Remaining release gates and unresolved questions

- Exact live outer lock, inner migration lock, protected executor, credential source and append-only release-record paths remain unresolved.
- The legacy wrapper must be replaced or safely adapted only after a reviewed installation plan proves ownership, hash, path safety, lock participation and rollback.
- The observed `.env` boundary must be replaced by a verified `0600` credential source outside the checkout; its contents must not be read during diagnosis.
- The actual deployed startup artifact must be checked for implicit Prisma migration before any migration-capable integration.
- Fresh direct-Docker singleton/PID/cgroup evidence, intended database identity and migration baseline are required.
- Backup freshness, off-host retrieval/restore, recovery-key custody, expected-object monitoring and timer state remain separate release gates.
- Staging isolation or an explicit reviewed waiver, health/monitoring, migration-failure recovery and final release diff/CI remain open.
- Release PR #1983 remains blocked; no `dev` to `main` promotion follows from this design.

No production deployment, migration, backup, timer, collector, evidence capture, Docker/DB inspection or VM modification is implied or authorized by this document.
