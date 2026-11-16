# ClashCookies — Production Migration-Aware Deployment and Recovery Runbook

**Status:** proposed design; documentation only. No production command in this document was executed by this task.

**Repository/base:** tonykslee/ClashCookies, dev

**Source revision reviewed:** dfa01cb1b8f39c47283e4ca01ae187fb023db1ef
**Release boundary:** draft release PR #1983 remains blocked, unmerged, and unauthorized.

This runbook is the design target for a separately reviewed production migration workflow. It does not install a VM wrapper, change the application startup path, run a migration, restart a container, enable backup automation, recreate staging, or promote dev to main.

## 1. Evidence and implementation status

| Area | Status and source of truth |
| --- | --- |
| Current non-migration helper | Implemented and reviewed: ops/deploy/deploy-prod.sh. It acquires a lock, preserves unknown files, builds without production credentials, requires one active runtime, refuses Prisma changes, promotes one container, and health-checks /healthz. Its fixture coverage is in tests/deploy-prod.test.ts. |
| VM entry point | Not adopted: the GitHub production workflow still invokes the VM-owned ~/deploy-prod.sh. The reviewed helper is not a substitute for that wrapper until a separately reviewed, hash-pinned VM change installs it outside the mutable checkout. |
| Startup migration behavior | Observed: ops/deploy/container-start.sh runs npm run start; package.json maps start to build plus start:runtime, and start:runtime currently runs prisma migrate deploy before node dist/ClashCookies.js. Application startup can therefore apply migrations implicitly. |
| Runtime health | Implemented: /livez returns process liveness; /healthz returns HTTP 200 only when Discord is ready and SELECT 1 succeeds. The production mapping documented by the operator is 127.0.0.1:8085 -> container:8080. |
| Production topology | Operator-observed, dated: Ubuntu droplet, one active clashcookies-app runtime, PostgreSQL 17.9 in clashcookies-db, production polling active. These facts require a fresh operator check before every release. |
| Compose source | Dependency, not in this repository: the application Compose file is expected under the live app directory and is required by deploy-prod.sh. The only version-controlled Compose file here is ops/observability/docker-compose.yml; it is not the production app/database Compose and must not be used to recreate production or staging. |
| Staging | Decommissioned: staging containers, volumes, and checkout were removed. A release requires either a separately restored mirror validation environment or an explicit reviewed waiver. |
| Backup/recovery | Partial: M1a/M6 restore evidence and one corrected M5 backup run exist, but timer activation, independent expected-object monitoring, and disaster/key-custody gates remain open. Follow docs/roadmaps/production-backup-readiness.md and ops/backup/README.md; this runbook does not authorize backup actions. |
| Migration evidence | M1a–M1d: representative existing-schema restore, legitimate migration chain, transactional failure recovery, and committed-side-effect recovery were validated on disposable PostgreSQL 17.12. M1d evidence is recorded in PR #2015 while that docs PR remains separate from this design branch. |

The central operational rule is: a Prisma migration failure is a database incident until the actual database state has been inspected. migrate resolve changes Prisma migration history; it is not SQL rollback.

## 2. Release gates

Every gate is recorded as PASS, BLOCKED, or NOT APPLICABLE with an operator, UTC timestamp, evidence reference, and reviewer. A missing observation is BLOCKED, not an inferred pass.

| Gate | PASS condition | BLOCKED condition |
| --- | --- | --- |
| Release approval | A named release approver has approved the exact target SHA, migration diff, maintenance/restart window, recovery authority, and release record. | Draft/unreviewed PR, moving target, missing approver, or approval for a different SHA. |
| Target identity | OLD_SHA is the observed production checkout; NEW_SHA is the immutable reviewed target; both are recorded before any checkout. | SHA cannot be proven, target is mutable, or the live checkout differs from the release record. |
| Migration scope | A reviewed OLD_SHA..NEW_SHA diff lists every prisma/schema.prisma and prisma/migrations/** change; migration order and existing-schema evidence are attached. | Diff is unavailable, contains unreviewed SQL, or the release is treated as non-migration despite Prisma changes. |
| Operator identity | The exact SSH/VM account, sudo/Docker/Git/lock permissions, and production app directory are verified by the authorized operator without exposing credentials. | Account, wrapper ownership, Docker access, or target checkout is uncertain. |
| Checkout safety | Tracked and staged changes are absent; all unknown files are inventoried; the target cannot overwrite an unknown path; the replacement worktree path is absent and owned by the deploy process. | Dirty checkout, unknown-file collision, stale replacement path, or unsafe cleanup would be required. |
| Runtime singleton | Exactly one recognized active ClashCookies runtime exists, named clashcookies-app, on the canonical port; no unlabeled or unidentified bot-like runtime exists. | Zero, multiple, or unidentified candidate runtimes exist. Do not stop one to guess which is canonical. |
| Database identity | The migration runner proves host/socket, port, database, role, PostgreSQL major version, schema, and connection target without logging the URL or password. | Any identity field is unknown, points outside the approved production database, or cannot be verified independently. |
| Migration baseline | prisma migrate status and _prisma_migrations show no pre-existing unresolved row; historical rolled-back rows are recorded and understood; the baseline matches the release record. | Any unresolved row, checksum mismatch, unexpected migration name, or unexplained history exists before the release. |
| Backup and restore | A recent encrypted off-host backup was retrieved or otherwise independently verified, its key custody is proven, and a compatible disposable PostgreSQL 17 restore passed the required checks. | Backup is local-only, stale, not independently retrievable, key custody is unproven, or restore evidence is incomplete. |
| Disk and capacity | Current root, Docker, database, and temporary staging headroom supports candidate/build logs, migration work, and recovery artifacts; inode headroom is recorded. | Space is below the reviewed threshold, storage is unknown, or cleanup would require deleting unknown files. |
| Health and monitoring | /livez, /healthz, Docker/runtime state, Uptime Kuma/Dozzle coverage, and alert paths are observed before release; health evidence is timestamped. | Health or monitoring is stale, unavailable, or only inferred from a running container. |
| Staging or waiver | A mirror-mode staging validation passed with no active pollers, or a named release authority approved a documented waiver and alternate isolation evidence. | Staging is assumed to exist, would poll production, or no waiver/alternate evidence exists. |
| Historical compatibility | The old runtime has representative read/compatibility evidence for the final schema, or a named authority accepts the explicit incompatibility risk and selects a safe outage/recovery path. | Old-version behavior is unknown and the plan relies on automatic code rollback. |

No gate authorizes another gate. Green CI, a local dump, or a successful candidate build does not authorize a production database write.

## 3. Proposed migration-aware architecture

The architecture below is proposed and unimplemented unless a row above explicitly says implemented.

### 3.1 Stable operator entry point

Install a separately reviewed VM wrapper outside the application checkout. The wrapper must pin:

- the reviewed migration-aware helper commit;
- the installed helper file SHA-256;
- the application directory and canonical runtime identity;
- the approved release record location; and
- the prior helper for operator rollback.

The wrapper must verify its own path and hash before execution. It must expose two explicit modes:

1. non-migration: invoke the reviewed helper only when the Prisma diff is empty;
2. migration: invoke the migration-aware workflow below.

The non-migration helper must continue to fail closed when it sees Prisma changes. It must never silently fall through to the migration workflow. The wrapper must remain usable after the target checkout changes or lacks ops/deploy/deploy-prod.sh.

### 3.2 Exclusive lock and release record

Acquire one host-level exclusive lock before reading checkout state, runtime state, Compose configuration, or database identity. Hold it through migration outcome, runtime promotion, health verification, or explicit escalation. A second deploy must exit with a bounded already_locked result and must not inspect or stop the active runtime.

Create an append-only, access-controlled release record outside the mutable application checkout. It records the release ID, operator identity, approver, helper commit/hash, OLD_SHA, NEW_SHA, migration diff digest, database identity digest without credentials, gate results, command exit codes, Prisma outcome, runtime/container revision, health results, and escalation decisions. It must never contain DATABASE_URL, passwords, tokens, private keys, raw environment files, or unbounded command output.

### 3.3 Candidate build without runtime or migrations

Keep the current safe candidate-build properties:

- create a disposable worktree at NEW_SHA;
- install dependencies and run the build only;
- do not pass production .env, DATABASE_URL, Discord credentials, active polling settings, or the production Docker network;
- do not invoke container-start.sh, npm start, start:runtime, or any migration command;
- retain the owned candidate worktree and dependency volume until the explicit migration and promotion phases finish; and
- remove it only after ownership and path safety are rechecked.

Candidate-build success is evidence that the target compiles. It is not evidence that the migration is compatible or that the final mounted production checkout is the exact built artifact.

### 3.4 Explicit one-shot migration runner

The migration runner must be a separate one-shot container/process using the exact NEW_SHA worktree and reviewed dependencies. It must:

- receive only the approved database connection secret through a protected runtime mechanism;
- have no Discord token, guild IDs, POLLING_MODE=active, scheduler startup, public port, or bot command;
- connect only to the approved production database network;
- verify database identity before applying SQL;
- run the reviewed migration command exactly once;
- emit a bounded result containing release ID, target SHA, migration names/digest, start/end, exit code, and sanitized Prisma classification; and
- stop after success or failure rather than restart and retry automatically.

The production Compose configuration currently is not versioned here, so the implementation must add or document a reviewed migration service/runner contract on the VM. A migration service must not reuse the full application environment merely because it is convenient.

### 3.5 Prevent implicit startup migrations

The current start:runtime command performs prisma migrate deploy; this must be separated before migration releases are possible. The smallest proposed application change is:

~~~json
{
  "scripts": {
    "migrate:deploy": "prisma migrate deploy",
    "start": "npm run build && npm run start:runtime",
    "start:runtime": "node dist/ClashCookies.js"
  }
}
~~~

This is a proposed change, not current behavior. container-start.sh may continue to ensure dependencies and call npm start, but startup must no longer apply migrations. The migration runner explicitly calls npm run migrate:deploy; the active runtime only starts the already-reviewed application. A separate local/development command may be documented if developers need automatic migrations, but production must not depend on an implicit side effect.

### 3.6 Promotion and health gate

Only after the migration runner succeeds and post-migration database status is verified may the workflow:

1. stop the one old active runtime;
2. check out NEW_SHA without deleting unknown files;
3. start exactly one labeled active runtime with POLLING_MODE=active and POLLING_ENV=prod;
4. verify the runtime revision and canonical container identity;
5. require HTTP 200 from /healthz and record /livez; and
6. verify Uptime Kuma/Dozzle visibility and bounded startup logs.

The health gate is application-level: /healthz proves Discord readiness and a database probe, not merely process existence. A successful migration followed by failed runtime health is a release failure, not evidence that the database should be rolled back.

### 3.7 Interruption handling

At every phase, an interruption leaves the lock and release record as the source of truth. On resume, do not re-run the phase blindly:

1. identify the current operator and release ID;
2. inspect the lock owner, active containers, checkout SHA, and candidate worktree;
3. verify database identity and _prisma_migrations state;
4. classify SQL effects using the recovery procedure below; and
5. continue, reconcile, or escalate based on evidence.

An interrupted migration is treated as UNKNOWN until the database state is proven. The workflow must not use --force, migrate reset, unconditional container replacement, or automatic retry to make the state appear complete.

## 4. Operator workflow and evidence

The following commands are proposed interfaces for the future implementation. They were not run against production. Remote commands are explicitly labeled; local review commands are Windows CMD-compatible.

### 4.1 Local Windows CMD — review only

Use these commands to inspect the release artifacts before handing the release to the authorized production operator. They do not connect to production.

~~~cmd
git fetch origin dev && git rev-parse origin/dev && git status --short --branch
~~~

~~~cmd
git diff --name-status <OLD_SHA> <NEW_SHA> -- prisma/schema.prisma prisma/migrations
~~~

~~~cmd
git show --stat --oneline <NEW_SHA> && git diff --check <OLD_SHA> <NEW_SHA>
~~~

The operator must attach the exact SQL diff, existing-schema validation, compatibility evidence, approval record, and backup/restore evidence to the release record. Do not paste secrets or raw production environment files.

### 4.2 Remote Ubuntu droplet — preflight, proposed

These examples require the authorized production operator and the actual VM paths. <APP_DIR>, <COMPOSE_FILE>, <DB_NAME>, and <DB_ROLE> are placeholders, not discovered values.

~~~bash
git -C <APP_DIR> status --short --branch
git -C <APP_DIR> rev-parse HEAD
git -C <APP_DIR> ls-files --others --ignored --exclude-standard --directory
~~~

~~~bash
docker ps --format '{{.Names}}|{{.Ports}}|{{.Label "com.clashcookies.runtime"}}|{{.Image}}|{{.Command}}'
~~~

~~~bash
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8085/livez && curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8085/healthz
~~~

~~~bash
df -h / /var/lib/docker && df -i / /var/lib/docker
~~~

Inspect the approved application Compose configuration with docker compose -f <COMPOSE_FILE> config --format json, but capture only redacted service names, image/revision, network, port, and the normalized database host/port/name/user. Never print the raw JSON when it contains environment values. The operator must prove that the database is the intended production database and that no other service has an unexpected DATABASE_URL.

### 4.3 Remote Ubuntu droplet — database baseline, proposed

The future migration runner must perform the identity query through its protected connection mechanism. The result must include current database, current role, server address/port, PostgreSQL major version, schema, and a release-record digest of the target; it must not include a password or full connection URL.

~~~sql
SELECT current_database(), current_user, inet_server_addr(), inet_server_port(), current_setting('server_version'), current_schema();
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
       COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NOT NULL) AS rolled_back,
       COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unresolved
FROM "_prisma_migrations";
SELECT migration_name, started_at, finished_at, rolled_back_at, checksum
FROM "_prisma_migrations"
ORDER BY started_at, finished_at NULLS FIRST;
~~~

This SQL is a proposed read-only baseline query. If the unresolved count is nonzero, stop before applying the new release.

### 4.4 Remote Ubuntu droplet — explicit migration phase, proposed

After all gates pass and the release approver authorizes the write, the stable helper invokes the reviewed one-shot migration runner. The runner must expose a command equivalent to:

~~~bash
npm run migrate:deploy -- --schema=prisma/schema.prisma
~~~

The command must run in the migration-only service described above, not through container-start.sh, npm start, the active bot container, or the legacy VM wrapper. The runner must not retry after an ambiguous connection loss. Record the sanitized exit classification and stop for inspection on any nonzero result.

### 4.5 Remote Ubuntu droplet — post-migration and promotion, proposed

~~~bash
<MIGRATION_RUNNER> migrate status --schema=prisma/schema.prisma
docker ps --format '{{.Names}}|{{.Ports}}|{{.Label "com.clashcookies.runtime"}}|{{.Image}}|{{.Command}}'
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8085/healthz
~~~

Only the migration-aware helper may proceed from a successful database result to runtime promotion. If promotion or health fails, keep the release record open and follow Section 7; do not infer that code checkout rollback reverses SQL.

## 5. Failure classification and decisions

| Failure case | Evidence to collect | Database may be changed? | Old runtime restart | Prisma resolve | Stop/escalate rule |
| --- | --- | --- | --- | --- | --- |
| Before SQL execution | Runner exit/log stage, no migration row or a started row with no SQL evidence, lock/runner state | Only to retry the reviewed command after cause is corrected and approval remains valid | Yes if it was never stopped; otherwise normal startup gate | None; do not resolve without a failed migration row | Stop if the phase is uncertain or the target changed. |
| Transactional rollback, no persisted effects | P3018, database error, _prisma_migrations, catalog/data checks proving every fixture effect is absent | Only approved cleanup of disposable/test effects; no production destructive cleanup | Yes only after database identity and compatibility are confirmed | --rolled-back may be appropriate after proof of no effects | Stop if any effect remains or the error is ambiguous. |
| Committed partial side effects | Exact SQL, checksum, catalog objects, columns/constraints/indexes/triggers/enums, affected rows and migration row | Only reviewed forward reconciliation or restore-to-new-database plan; never automatic DROP/reset | Only if old runtime compatibility with the committed state is proven | Do not resolve first. --applied is allowed only when intended state is complete and accounted for; --rolled-back does not undo effects | Stop and escalate when any effect is unexplained, partial, irreversible, or production data is affected. |
| Migration reported failed but SQL effects are complete | Failed row/log, checksum, full intended-vs-observed comparison, repeat-deploy result | Forward repair or --applied only after an independent reviewer confirms consistency | Do not restart old code merely because Prisma failed | --applied can represent a completed intended state; never use it as a blind acknowledgement | Stop if the failed statement could have skipped required effects. |
| Schema compatibility failure | Database error, exact statement, target/old schema, migration SQL, application compatibility evidence | No ad hoc schema edits; use reviewed forward repair or restore-to-new | Old runtime only if compatibility is proven; otherwise keep stopped | Neither resolve command repairs incompatibility | Stop and obtain migration/DB review. |
| Connection loss or timeout | Runner/container logs, PostgreSQL logs/locks, _prisma_migrations, catalog and transaction evidence | Assume state is unknown; read-only inspection first | Do not restart either version until DB state and compatibility are known | Neither resolve command is appropriate until state is classified | Stop; no blind retry. |
| Lock contention | Lock owner/query, migration runner state, PostgreSQL activity/lock views | Do not kill sessions or change timeouts by guesswork | Keep the current runtime unless the release authority orders a controlled stop | None while lock ownership is unresolved | Stop and escalate to the DB operator. |
| Concurrent deploy attempt | Host lock record, process/container inventory, release IDs and wrapper logs | No database action by the losing attempt | Do not stop the winner or start a second bot | None | Stop the losing attempt; investigate any lock bypass. |
| Application start fails after successful migration | Migration success record, container exit/log stage, checkout SHA, /livez, /healthz, runtime inventory | Do not roll back SQL automatically | Old runtime only after explicit backward-compatibility decision; otherwise keep stopped or repair new runtime | None unless a separate migration incident exists | Stop if both versions are unhealthy or identity is ambiguous. |
| Health check fails after promotion | HTTP status/body classification, Discord readiness, DB probe, container logs, monitoring view | Do not alter DB merely because health is red | Old runtime only if it is schema-compatible; otherwise no automatic code rollback | None for a health-only failure | Stop promotion, preserve evidence, and escalate. |
| Old runtime is incompatible with new schema | Verified old-client error and schema dependency, migration state, new-runtime health | Forward repair, compatible runtime promotion, or restore-to-new; never destructive live rollback | Do not restart old code automatically | Resolve does not restore compatibility | Stop and use the approved outage/recovery decision. |

P3009 means Prisma found failed migrations and blocked new migrations; it does not identify whether earlier SQL committed. P3018 means a migration failed; it does not prove that all statements rolled back. The database inspection determines the recovery path.

## 6. Recovery and reconciliation procedure

### 6.1 Common first response

1. Keep the exclusive lock and mark the release FAILED_NEEDS_CLASSIFICATION.
2. Do not run migrate resolve, migrate reset, DROP, DELETE, TRUNCATE, or a blind retry.
3. Preserve the exact target SHA, migration SQL/checksum, sanitized runner result, timestamps, container state, and health result.
4. Verify the database identity again through the protected connection.
5. Run migrate status and inspect _prisma_migrations read-only.
6. Inspect actual catalogs and affected data before choosing a recovery action.
7. Have the database/recovery authority and release approver record the decision; the production operator executes only that decision.

### 6.2 Inspect Prisma state and SQL effects

Inspection must cover, at minimum:

- migration name, checksum, start/finish/rollback timestamps, and sanitized error log;
- whether any same-name applied or rolled-back history row already exists;
- tables, columns, types/enums, sequences, indexes, constraints, foreign keys, triggers, and functions named or affected by the SQL;
- row counts and sentinel/identity records for any DML;
- application invariants and representative historical counts; and
- locks, active sessions, server version, schema name, and connection identity.

The result is classified as ABSENT, COMPLETE, PARTIAL, or UNKNOWN for every intended effect. UNKNOWN is not treated as ABSENT.

### 6.3 migrate resolve --applied

Use only when all intended SQL effects are present, the actual state matches the reviewed migration, the checksum is the reviewed checksum, and an independent reviewer authorizes representing the migration as applied. It does not execute missing SQL and does not undo or validate arbitrary effects. Re-run read-only status and catalog checks afterward, then continue only through the reviewed forward path.

### 6.4 migrate resolve --rolled-back

Use only when the failed migration has no persisted effects, or a separately reviewed forward reconciliation has removed every effect and the resulting state is explicitly documented. It changes Prisma history; it does not reverse SQL. Never use it to make a committed partial migration disappear.

### 6.5 Forward repair migration

When the intended state is not complete but the committed effects are understood, create a new reviewed forward migration that reconciles only the observed production state. Never edit, delete, reorder, or rewrite a historical migration. Validate the repair on a representative existing-schema disposable restore, record its checksum and intended end state, apply it under the same lock, and verify status/invariants before runtime promotion.

### 6.6 Restore-to-new-database recovery

If production state is unexplained, the migration is unsafe to reconcile, or the database is damaged:

1. Keep the live database untouched and stop/escalate according to the outage decision.
2. Retrieve an approved encrypted off-host backup with the read-only recovery key.
3. Verify encrypted checksum, object retention, decryption, PostgreSQL 17 pg_restore --list, and restore into a new UTF-8/C-locale PostgreSQL 17 database.
4. Validate migration history, schema/catalog, representative data, constraints, triggers, application compatibility, and health in isolation.
5. Obtain separate explicit approval for any connection cutover. Never restore over the live database and never treat a code checkout rollback as database recovery.

The detailed backup/key procedure remains in ops/backup/README.md; this section only defines when that procedure becomes the migration recovery path.

## 7. Service restoration strategy

| Event | Safe service action |
| --- | --- |
| Candidate build fails | Leave the current active runtime untouched. Preserve the bounded failure result and remove only an owned candidate worktree after ownership checks. No database action. |
| Migration fails before the old runtime stops | Leave the old runtime running if it is healthy. Classify the database before any retry or resolve. |
| Migration fails after the old runtime stops | Do not automatically start old or new code. Classify _prisma_migrations and catalogs first; restart old only after the compatibility decision explicitly allows it. |
| Migration succeeds but new runtime start fails | Keep the database change. Inspect the exact target runtime and candidate artifact. Restart the new runtime only after correcting the start cause; use old runtime only with an approved compatibility decision. |
| Health fails after promotion | Keep one runtime maximum, preserve logs/health evidence, and determine whether the failure is Discord, database, configuration, or application. Do not resolve or reset a migration for a health symptom. |
| Code rollback is incompatible | Do not check out old code automatically. Keep the service stopped or run the reviewed compatible target; use forward repair or restore-to-new under the recovery authority. |
| Rollback itself fails | Report rollback_result=failed, do not claim recovery, do not retry blindly, and keep the observed state for the operator/incident commander. |

The person who starts/stops a production container, executes a migration, resolves Prisma history, applies a forward repair, enables backup automation, or performs a database cutover must be explicitly named in the release record. Codex and CI do not receive implicit authority from a green build or a merged documentation PR.

## 8. Audit trail and post-release monitoring

### Required before evidence

- approval and review references for the exact target;
- OLD_SHA, NEW_SHA, migration file list/digest, helper commit/hash, and release ID;
- operator account, app directory, lock path, runtime inventory, checkout cleanliness, and unknown-file inventory;
- exact database identity/version/schema and baseline migration summary;
- backup object ID/checksum/retention, key-custody evidence, and disposable restore result;
- disk/inode headroom, current /livez and /healthz, monitor availability, and staging pass/waiver;
- historical-client compatibility result or explicit accepted risk; and
- authorization for migration write, service restart, and recovery authority.

### Required after evidence

- migration runner start/end, exit code, exact target, applied migration names, and sanitized classification;
- _prisma_migrations final summary and no unresolved rows;
- catalog/invariant comparison and representative historical counts;
- active runtime count, container name/labels, mounted revision, /livez, /healthz, and monitor observations;
- startup/migration logs reduced to allowlisted fields and stored with restricted access;
- release outcome COMPLETE, FAILED_NEEDS_CLASSIFICATION, ESCALATED, or ROLLED_BACK_CODE_ONLY; and
- scheduled post-release observations at startup, +5 minutes, +30 minutes, and the next normal polling/scheduler boundary.

Post-release monitoring must cover application readiness, database probe, Docker/runtime singleton, startup errors, Discord readiness, and existing Uptime Kuma/Dozzle routes. Do not create or recreate Netdata or staging as an incidental response; those are separate reviewed infrastructure decisions.

### Redaction rules

Logs may contain release IDs, SHAs, migration names, checksums, timestamps, exit codes, bounded error codes, HTTP status, container names, and counts. Redact database URLs, passwords, tokens, private keys, monitoring URLs, Discord identifiers where not required, raw environment content, SQL values, and unbounded stderr/stack traces. Store raw logs only if the security/recovery authority has separately approved their protected location.

## 9. Stop conditions and authorization boundaries

Stop immediately and leave the release open when:

- the database identity, operator identity, lock owner, or active runtime identity cannot be proven;
- any pre-existing unresolved migration or unexplained schema drift is found;
- a migration failure has ambiguous or committed SQL effects;
- a resolve command would be used before catalog/data inspection;
- old runtime compatibility after a schema change is unknown;
- the target or helper hash differs from the release record;
- unknown files would be overwritten or cleanup would require force deletion;
- backup/recovery-key custody or disposable restore evidence is missing;
- staging is assumed rather than passed or explicitly waived;
- health/monitoring evidence is unavailable; or
- recovery would require changing production data outside the reviewed migration/repair scope.

No automatic database rollback exists. No production operator should use migrate reset, restore over the live database, edit historical migrations, delete unknown files, kill an unknown database session, enable the backup timer, or recreate staging as a recovery shortcut.

## 10. Smallest implementation slice and dependencies

The smallest safe code/testing slice is to remove implicit production migration execution from startup and add a dedicated explicit migration command:

1. change package.json so migrate:deploy is explicit and start:runtime only starts the compiled app;
2. adjust ops/deploy/container-start.sh only as needed to preserve build/start behavior without migrations;
3. add a migration-runner fixture to tests/deploy-prod.test.ts proving that the runner receives only database configuration, never starts Discord/pollers, runs exactly once, and stops on nonzero/ambiguous results; and
4. add a startup regression test proving start:runtime cannot invoke Prisma migrations.

This slice is a code/runtime change and requires its own reviewed PR and explicit approval. It must be followed by a separate migration-aware helper/VM-wrapper slice that adds the lock-held preflight, database identity check, release record, promotion state machine, and interruption/recovery handling. The production Compose migration service and wrapper adoption cannot be inferred from this documentation PR.

Required implementation dependencies before production use are:

- a reviewed, immutable VM wrapper and helper hash installed outside the mutable checkout;
- a versioned or operator-reviewed migration-only Compose/service contract;
- secret handling that exposes only the database credential to the migration runner;
- release-record storage and retention with restricted access;
- fixture coverage for every state-machine branch, including M1c/M1d semantics and connection-loss ambiguity;
- representative existing-schema migration validation and historical-client compatibility evidence;
- backup, restore, recovery-key, monitoring, staging/waiver, and deployment-identity gates closed; and
- explicit production release approval after all evidence is fresh.

Until these dependencies are complete, production releases containing Prisma changes remain blocked and the reviewed non-migration helper must continue to fail closed.
