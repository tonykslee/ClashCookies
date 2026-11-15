# ClashCookies — DBH Part 1: Database Health and Legacy Data Audit

**Repository:** `tonykslee/ClashCookies`
**Base:** `dev`
**Audit branch:** `diagnostics/database-health-audit`
**Audit date:** 2026-11-14
**Scope:** repository, Prisma schema, migrations, services, schedulers, scripts, diagnostics, and tests only

## 1. Executive summary

This is a read-only repository audit. No production database, SSH session, SQL measurement, migration, schema change, cleanup, retention change, or runtime change was performed. The working tree was clean before the audit branch was created from the refreshed `origin/dev` (`9d3677a0`). PR #1994 was already merged, so its DBH scope was used as roadmap context rather than treated as pending work.

The strongest conclusion is that `BotSetting` is active infrastructure, not an abandoned catch-all that can be removed. `SettingsService` reaches it through parameterized raw SQL, so searching only for `prisma.botSetting` undercounts callers. The audit identified 29 concrete namespace variants in 16 semantic families. Most are bounded configuration, preference, checkpoint, or current-state records. Two families require special caution:

- `active_sync_post:<guild>` is a legacy pointer retained beside the typed `TrackedMessage` owner and still has active fallback readers.
- `warStartPointsCheck:<clan>` stores a serialized retry job and overwrites one row per clan, but completed rows are not deleted; historical clan-tag churn could accumulate keys.

The main data-growth risk is not a proven runaway table. It is the absence of repository-visible retention policy for several append-only or historical structures: telemetry buckets and report runs, war-history/provenance evidence, rep-work activity, CWL exports/history, raid observations, blacklist samples, posted-message records, and delivery histories. These records have active readers or explicit accounting/compliance/provenance obligations, so deletion is not recommended from code-only evidence.

The repository contains several deliberate compatibility paths. Current migrations already removed earlier structures such as `PlayerSnapshot`, `WarHistoryParticipant`, the former `ClanWarPlan` shape, FWA police template tables, `TrackedClanRepProfile`, and the old CWL alliance baseline tables. Current code still preserves compatibility for `CurrentWar.syncNum`, `FwaLayouts` raw link/image projections, Google Sheet fallback keys, and the legacy sync-post pointer. None is proven safe to remove without production evidence and a separately reviewed migration.

### Finding counts at this code-only checkpoint

| Classification | Count | Meaning |
| --- | ---: | --- |
| ACTIVE | 8 | Confirmed active readers/writers or active schema ownership |
| LEGACY_REFERENCED | 4 | Historical, compatibility, or dual-owner path still used |
| CANDIDATE_UNUSED | 0 | No structure met the bar for “no active use” after raw-SQL and fallback tracing |
| UNKNOWN | 7 | Requires representative database measurements or query plans |

These are audit findings, not row counts or production facts. Actual table sizes, key counts, age distributions, dead tuples, index utility, orphan counts, query latency, and storage savings remain unmeasured.

### Highest-priority recommendations

1. **P0 — Keep M2a Part 3 live reward crediting behind the DBH/recovery gate.** Review this diagnostic, verify representative existing-schema migration compatibility, and do not activate live crediting based on repository evidence alone.
2. **P0 — Measure `BotSetting` distribution and the `warStartPointsCheck` family.** Use the approved SELECT-only plan below; do not retrieve raw values.
3. **P1 — Establish retention/archival policy per evidence class.** Start with telemetry/report runs and operational delivery histories; preserve ledger, accounting, compliance, war-history, membership, and provenance records unless explicit retention obligations permit another treatment.
4. **P1 — Resolve dual ownership deliberately.** Plan a compatibility-first migration for `active_sync_post`, `CurrentWar.syncNum`, `FwaLayouts` projections, and Google Sheet fallback namespaces only after measuring live key presence and proving all readers have moved.
5. **P1 — Capture query plans and high-water marks for history-heavy readers.** Confirm whether bounded windows and existing composite indexes are sufficient before adding or dropping indexes.

No issue identified here should independently block M2a Part 3 as a correctness defect. Live reward activation should remain blocked by the roadmap’s existing policy, evidence, migration-compatibility, backup/recovery, and explicit activation gates. The audit is a prerequisite review input, not activation authorization.

## 2. Evidence and method

Reviewed the latest `dev` copies of:

- `docs/ai-development-workflow.md`
- `docs/project-brain.md`
- `docs/architecture-contract.md`
- `docs/core-priorities.md`
- `docs/observability.md`
- `docs/roadmaps/dusk-economy.md`
- `docs/roadmaps/production-backup-readiness.md`
- `prisma/schema.prisma`
- Prisma migration history, relevant services, schedulers, commands, scripts, diagnostics, and tests

The audit used repository search and code tracing. Direct `BotSetting` model references were treated as incomplete because `src/services/SettingsService.ts` uses `SELECT`, `INSERT ... ON CONFLICT`, and `DELETE` raw SQL. Model-name scans were also cross-checked against raw SQL: the six telemetry models and `DuskRewardPolicyVersion` initially looked unused by lower-camel-case Prisma calls but are active through raw SQL readers/writers or typed audit data.

Evidence labels used below:

- **ACTIVE:** active reader/writer or current schema owner confirmed in repository code.
- **LEGACY_REFERENCED:** old or compatibility path still has a reader, writer, fallback, or migration obligation.
- **CANDIDATE_UNUSED:** no active use established after tracing typed calls, raw SQL, scripts, schedulers, and tests. None identified.
- **UNKNOWN:** code cannot establish live row presence, growth, query cost, index utility, or external retention obligations.

## 3. `BotSetting` inventory

### 3.1 Storage contract

`BotSetting` is a primary-keyed `(key, value)` table with `createdAt` and `updatedAt`, plus an `updatedAt` index (`prisma/schema.prisma:205-212`; created in `prisma/migrations/20260220100000_add_bot_setting/migration.sql` and indexed by `20260305033000_warattacks_pk_and_indexes/migration.sql`). `SettingsService.set()` upserts the current value; it does not preserve prior values. There is no generic namespace, value-size, sensitivity, owner, or deletion metadata in the schema.

That design is appropriate for small current settings and checkpoints, but it makes historical reconstruction impossible from the table alone. `updatedAt` is mutation time, not read time or business-event time. A large serialized value is rewritten in full on every update.

### 3.2 Semantic family inventory

The table below collapses 29 concrete namespace variants into 16 semantic families. “No typed equivalent” means the current owner is intentionally a service wrapper over `BotSetting`; it is not evidence that the family is unused.

| Family / concrete key shape | Purpose and owner | Read / write / delete paths | Data class, growth, sensitivity | Startup/deploy dependence | Classification and action |
| --- | --- | --- | --- | --- | --- |
| `player_signal_state:<PLAYER_TAG>` | Current player activity signal snapshot owned by `ActivitySignalService`; `TodoService` and `TodoSnapshotService` consume it. | `ActivitySignalService.ts:81-86,234,316`; bulk readers in `TodoService.ts:369-377` and `TodoSnapshotService.ts:968-1009`. | Serialized JSON with fixed counter/hash fields and timestamps; one row per player tag, arrays reduced to hashes. Bounded per row, cardinality follows observed players. May contain player names/tags and activity statistics; not credentials. | Activity observation loop, not deployment. | **ACTIVE.** Keep bounded; measure key count/value sizes and stale-tag age before considering retirement. A typed table would need an explicit owner migration. |
| `bot_logs_channel:<GUILD>` and `bot_logs_channel:<GUILD>:<TYPE>` | Bot-log channel routing, owned by `BotLogChannelService`. | `BotLogChannelService.ts:3-67,202-368`; legacy sync cleanup in `BotLogs.ts:831`. | Scalar Discord channel IDs; bounded per guild/type, not historical. Low sensitivity but private routing metadata. | Used by log routing and command flows; no migration-start requirement found. | **ACTIVE.** Keep until a typed routing owner is approved; do not delete rows merely because a channel is currently missing. |
| `bot_logs_base_swap_routing:<GUILD>` | Base-swap routing mode and optional custom channel. | `BotLogChannelService.ts:4,71-78,225-268`. | Small JSON configuration; bounded. | Runtime routing, not deployment. | **ACTIVE.** Preserve as the current owner; validate malformed values and stale channel IDs through existing diagnostics. |
| `bot_logs_routing:<GUILD>:<TYPE>` plus `bot_logs_sync_retrospective_enabled_at:<GUILD>` | Typed routing policy and durable no-backfill enable boundary for routed bot logs. | `BotLogChannelService.ts:5-6,80-186,276-338`. | Small JSON policy plus ISO timestamp; bounded. Timestamp is policy history boundary, not an event log. | Required when routed log features start; not a migration prerequisite. | **ACTIVE.** Treat the enable boundary as correctness state; any typed-table migration must preserve it exactly. |
| `command_roles:<TARGET>`, `command_roles_additions:<TARGET>`, `command_roles_exclusions:<TARGET>`, `command_roles_restrictive:<TARGET>` | Command permission policy, including legacy restrictive whitelist compatibility and additive/exclusion layers. | Key builders `CommandPermissionService.ts:341-362`; readers/writers/deletes `620-1028`. | JSON arrays of Discord role IDs and a marker; bounded by configured roles/targets but can be oversized by bad input. | Permission checks can run during command handling; no startup dependency found. | **ACTIVE** with **LEGACY_REFERENCED** substate for the restrictive layer. Consolidate only after exporting/equivalence-testing effective policies. |
| `fwa_leader_role:<GUILD>` | FWA leader role default used by permissions and defer routing. | `CommandPermissionService.ts:11,360-616`; read by `WeightInputDefermentService.ts:759-763`. | Scalar Discord role ID; bounded. | Used in command/scheduler routing; no deployment dependency. | **ACTIVE.** Candidate for future typed guild configuration only if the same owner is retained. |
| `google_sheet_id`, `google_sheet_tab`, `google_sheet_actual_id`, `google_sheet_actual_tab`, `google_sheet_war_id`, `google_sheet_war_tab` | Google Sheet linkage with generic, ACTUAL, and WAR fallback namespaces, owned by `GoogleSheetsService`. | `GoogleSheetsService.ts:6-11,174-223,698-699`; command flows in `Sheet.ts` and `Fwa.ts`. | Scalars; bounded. Sheet IDs and tab names are configuration, not credentials. | Sheet-backed commands may need them after startup, but no deploy dependency. | **LEGACY_REFERENCED** for fallback precedence. Measure coexistence before collapsing namespaces; preserve mode-specific behavior. |
| `active_sync_post:<GUILD>` | Serialized channel/message/epoch pointer for the active sync announcement. Typed `TrackedMessage` is newer/canonical, but this pointer remains a fallback. | Writer `SyncTimePostPublisherService.ts:123-125,496-503`; readers/deleter `Post.ts:276,434`; fallback reader `PointsDirectFetchGateService.ts:151-152,532-534,977-979`. | Small JSON pointer; one row per guild. Historical value is overwritten; stale pointer can persist. | Used during command/recovery paths, not schema deployment. | **LEGACY_REFERENCED.** Do not remove until production key presence is measured and every fallback reader is retired or proven unnecessary. |
| `activity_observe:last_run_at_ms` and `clashking:unresolved_last_sync_ms` | Global scheduler/link-sync cadence markers. | `ready.ts:126,839,1005-1008`; `PlayerLinkSyncService.ts:13-14,397-462`. | Scalar epoch milliseconds; bounded singleton runtime state. | `ready` activity observation uses it to decide due work; no deployment dependency. | **ACTIVE.** Keep as current checkpoint state; malformed/missing values already fall back to due behavior. |
| `heatmapref_rebuild_state:<GUILD>` | Per-guild HeatMapRef rebuild checkpoint and failure-recovery state. | `HeatMapRefRebuildService.ts:30,69-70,665-695`; startup/manual repair wiring in `ready.ts` and `Force.ts`. | Serialized JSON checkpoint; one row per guild, potentially retained after terminal completion. | Can be consulted by startup/manual repair; not a deployment prerequisite. | **ACTIVE.** Add explicit terminal-state lifecycle/age measurement before any pruning. |
| `points_lock_state:<CLAN_TAG>` | Current points-transition lock/baseline lifecycle state owned by `PointsDirectFetchGateService`. | `PointsDirectFetchGateService.ts:151-152,526-534,1127-1135`. | Serialized JSON per clan tag; bounded per current clan but may retain historical tags. | Runtime points gate only. | **ACTIVE.** Measure stale clan-tag cardinality; future cleanup must be keyed to authoritative tracked-clan/history evidence. |
| `warStartPointsCheck:<CLAN_TAG>` | War-start points-site retry job, owned by `WarStartPointsSyncService`. | `war-events/pointsSync.ts:44-118,188-210,298-334`; reset from `WarEventLogService.ts:4924-4928`. | Serialized retry JSON; attempts are capped at 10, but completed/error rows are overwritten and never deleted. Key cardinality can grow with distinct clan tags. | Resumed by war event processing; no deployment dependency. | **ACTIVE; P0 growth candidate.** Measure completed/old rows. A bounded tombstone policy or typed job table needs explicit recovery semantics. |
| `user_timezone:<DISCORD_USER>` | Shared remembered timezone for `/post` sync-time and `/recruitment` dashboard flows. | Builders `Post.ts:1314-1319` and `Recruitment.ts:437`; reads/writes `Post.ts:1599-1600,2040-2051` and `Recruitment.ts:451-464`. | Scalar IANA timezone; one row per user, potentially stale indefinitely. Low sensitivity. | Command preference only. | **ACTIVE; ownership-sprawl risk.** Keep one shared owner or migrate both callers together; do not split into conflicting sources. |
| `remaining:war:last-clan:<GUILD>:<USER>` and `remaining:cwl:last-clan:<GUILD>:<USER>` | Per-user last-viewed clan preferences for Remaining views. | `Remaining.ts:109-117,256-291,369-390`. | Scalars; cardinality follows guild/user combinations and has no visible expiry. | Command preference only. | **ACTIVE.** Low priority retention/cleanup candidate after measuring inactive users and privacy requirements. |
| `todo:last-viewed-type:<USER>` | Per-user last-viewed `/todo` page type. | `TodoLastViewedTypeService.ts:3-35`; invoked by `Todo.ts`. | Scalar enum; one row per user, no expiry. | Command preference only. | **ACTIVE.** Low-risk preference; no deletion without an account/privacy policy. |
| `defer_config_channel:<GUILD>`, `defer_config_ping_role:<GUILD>`, `defer_config_enable_ping:<GUILD>`, `defer_config_enable:<GUILD>` | Defer-routing overrides, owned by `WeightInputDefermentService`. | Key definitions `WeightInputDefermentService.ts:60-63,145-158`; reads/writes/deletes `759-820`. | Scalars/booleans; bounded per guild. | Runtime command/reminder routing only. | **ACTIVE.** Preserve precedence with `fwa_leader_role`; future typed migration must be atomic across all four keys. |

### 3.3 BotSetting conclusions

- The table is not unused. The generic wrapper currently serves configuration, user preference, scheduler checkpoints, current-state locks, compatibility pointers, and serialized retry jobs.
- There is no evidence in source that `BotSetting.value` contains credentials or Discord private message bodies. That is not a database measurement; a generic API could accept arbitrary future values. Measurement must use key prefixes, byte lengths, counts, and dates only.
- No `BotSetting` family stores an append-only history in this table. The risk is stale current rows and unbounded key cardinality, not old-value version accumulation.
- The highest-value consolidation targets are `active_sync_post`, the Google Sheet fallback set, and the shared `user_timezone` ownership boundary. They require compatibility reads, dual-write or backfill design, verification, and rollback—not direct deletion.

## 4. Legacy schema and code candidates

### 4.1 Current structures with confirmed active ownership

The Prisma schema contains 125 models. A model-name pass found source/test references for the apparent candidates; raw-SQL tracing resolved the false zero-use results for telemetry rollups/report scheduling and `DuskRewardPolicyVersion`. Examples:

- Telemetry aggregates are written by `src/services/telemetry/ingest.ts`, read by `report.ts`, scheduled through `schedule.ts`, and exposed by `Telemetry.ts`.
- `DuskRewardPolicyVersion` is the immutable policy-provenance owner described in `schema.prisma:2762-2771`; Dusk ledger/admin services read policy data through the ledger snapshot/audit path even though the model name is not used as a lower-camel Prisma delegate.
- `WarAttacks` is not an append-only archive despite its name. `WarEventLogService` deletes/rebuilds current-war rows before upserting the snapshot (`WarEventLogService.ts:6117-6217`). Do not classify it as a historical retention target.
- Current FWA tables, `CurrentWar`, `FwaLayouts`, `TrackedMessage`, and current CWL/roster tables have active readers/writers and mirror synchronization paths.

### 4.2 Compatibility and superseded ownership

| Structure/path | Evidence | Classification | Safe next action |
| --- | --- | --- | --- |
| `CurrentWar.syncNum` beside `CurrentWar.syncNumber` | `ActiveWarSyncResolutionService.ts:466-468` explicitly says older releases could fill the materialized field incorrectly; the persistence path still requires/reads the legacy field (`1515-1540`). | LEGACY_REFERENCED | Measure non-null legacy-only and disagreement rows. Retire only after a compatibility window and a migration/rollback plan. |
| `FwaLayouts.LayoutLink/ImageUrl/LastUpdated` beside `LayoutRecord` | `FwaLayoutService.ts:94-127,165-229` reads the typed relation, creates/updates `LayoutRecord`, and synchronizes compatibility copies. `LayoutService.ts:597-607` projects canonical values back. | LEGACY_REFERENCED | Keep both owners synchronized. Candidate for later removal only after all seed/import/read paths use `LayoutRecord` and live rows are verified. |
| `active_sync_post:<guild>` beside `TrackedMessage` | New typed tracked-message owner is preferred, but `Post.ts` and `PointsDirectFetchGateService.ts` still read/delete the setting fallback. | LEGACY_REFERENCED | Migrate readers first; retain a rollback-compatible read path until measured absence and deployment coverage are proven. |
| Google Sheet generic/ACTUAL/WAR key set | `GoogleSheetsService.getLinkedSheet()` has explicit precedence and mode-key cleanup. | LEGACY_REFERENCED | Treat coexistence as compatibility behavior, not duplicate data, until live key combinations are measured. |
| Prior table/column names in migration history | Migrations removed or renamed `PlayerSnapshot`, `WarHistoryParticipant`, former `ClanWarPlan` shape, FWA police template tables, `TrackedClanRepProfile`, and `CwlAllianceSeasonBaseline*`; war tables were renamed to current owners. | LEGACY_REFERENCED historical lineage, not current tables | No further action in this documentation PR. Preserve migration history; validate deployed chains before any new migration. |

### 4.3 No candidate-unused structure proven

No table, column, index, or compatibility path is classified `CANDIDATE_UNUSED` from repository evidence alone. A literal search is insufficient because this repository uses raw SQL, generic settings, mirror synchronization, scripts, and fallback paths. “No active database rows” would require a separately authorized measurement and still would not prove removal safety for accounting, compliance, war-history, membership, provenance, or audit data.

## 5. Data growth and retention risks

### 5.1 Potentially unbounded or high-cardinality structures

These are risk candidates, not measured production growth claims:

| Structure | Repository evidence | Risk | Required confirmation |
| --- | --- | --- | --- |
| `BotSetting` dynamic key families | Current-value upsert, no namespace metadata, no generic retention; `warStartPointsCheck` and per-user/per-clan keys can retain stale identities. | Medium. Key cardinality and large values may grow with guild/user/clan churn. | Prefix counts, max/percentile value bytes, age buckets, and stale-identity samples without exposing values. |
| Telemetry aggregates and `TelemetryReportRun` | Time-bucketed rows are inserted/upserted in `telemetry/ingest.ts` and report runs are inserted in `telemetry/schedule.ts`; no repository-wide retention job was found. | High if enabled for long periods; user/guild/command dimensions multiply buckets. | Row counts by month, oldest/newest bucket, total/index bytes, and whether external reporting requires historical retention. |
| `RepWorkActivityEvent` | Append-only `create` in `RepWorkActivityService.ts:235`; simulation/evaluator reads date windows; no delete path found. | Medium/high as observed activity accumulates. Dusk reward provenance may require retention. | Age distribution, source/event uniqueness, JSON byte sizes, and approved retention obligation. |
| `ClanWarHistory`, `ClanWarParticipation`, `WarLookup`, `WarPlanComplianceEvaluation`, `WarPlanViolation` | War-end persistence and many historical analytics/readers; JSON payloads in `WarLookup` and `attackDetails` in violations. | High volume over time, but retention is constrained by war-history, compliance, membership, and provenance obligations. | Counts/bytes by war end, payload size percentiles, query plans, and legal/operational retention decision. No deletion recommendation is made here. |
| `CwlRoundHistory` / `CwlRoundMemberHistory` and `CwlRotationExport` | Historical CWL readers; export uses `upsert` by event/clan/season-like identity but no general export retention policy is visible. | Medium; seasonal history and exports may accumulate. | Count/bytes by season, duplicate/obsolete export rows, and product retention requirement. |
| `RaidDistrictHitHistory`, `BlacklistMatchSample`, `ClanPostedMessage`, and delivery histories | Timestamped observation/delivery rows with active readers; no common retention service identified. | Medium; operational history may grow steadily. | Per-table age/size and confirmation of whether rows are audit, user-facing history, or rebuildable cache. |
| Large JSON / array fields | `WarLookup.payload`, `WarEvent.payload`, `WarPlanViolation.attackDetails`, Dusk attribution/policy definition, metadata fields, and several `String[]` schema fields. | Query and TOAST/index pressure if values are large or repeatedly rewritten. | `pg_column_size` percentiles and top-N bucketed values; never retrieve private payload content. |

### 5.2 Structures with bounded/current behavior

`WarAttacks` is explicitly rebuilt for current-war state. `CurrentWar`, feed catalogs/current rosters, `ApiUsage`, `FwaFeedCursor`, `FwaFeedSyncState`, `FwaClanWarsWatchState`, `MaintenanceWindowRuntimeState`, and most per-guild configuration tables are current-state owners. Their risk is stale-row cardinality or index overhead, not append-only history. Measure before pruning.

Immutable Dusk ledger entries, source events/claims, reversal requests/resolutions, and policy provenance are accounting/audit records. They must not be deleted, rewritten, or compacted as a generic database-cleanup step.

## 6. Query and index efficiency findings

### Confirmed code observations

- The code uses broad `findMany()` in many history and reporting services, but most user-facing paths apply guild/clan/date filters, ordering, or explicit windows. Scripts similarly accept bounded windows and batch IDs. Static search alone cannot establish a production N+1 or latency defect.
- High-frequency war polling joins/reads `CurrentWar`, `TrackedClan`, `ClanNotifyConfig`, and `ClanPointsSync` in raw SQL (`WarEventLogService.ts:4055-4100` and `4636-4678`). Existing indexes cover several lookup shapes, but `EXPLAIN (FORMAT JSON)` is required to verify selectivity and join strategy.
- History-heavy readers are already bounded in several places, and the schema includes composite indexes for `ClanWarHistory`, `ClanWarParticipation`, `WarPlanComplianceEvaluation`, `WarPlanViolation`, `WarLookup`, and `ClanPointsSync` (`prisma/schema.prisma:1829-2040`). This is evidence of intended access paths, not proof that every index is useful.
- `WarAttacks` current-war synchronization deletes and rebuilds rows, so repeated writes can create table/index churn even though row count is bounded. Confirm with write frequency and `pg_stat_user_tables` dead-tuple statistics before changing it.
- `BotSetting` reads are single-key raw selects; bulk signal-state reads use `key IN (...)`. Rewriting large JSON values is a possible TOAST/write-amplification concern, but the signal-state schema is fixed-size by code.

### Unknowns requiring measurement

1. Actual latency and query plans for history windows, war polling joins, telemetry reports, and bulk signal-state reads.
2. Whether any `findMany()` path receives an unexpectedly broad production scope despite repository bounds.
3. Whether indexes are unused, redundant, or bloated. Do not drop or add indexes from schema shape alone.
4. Whether high-frequency current-state rewrites create material dead tuples or autovacuum lag.
5. Whether delivery/history tables are queried by age without a matching index.

## 7. Measurement plan — operator approval required

Do not execute this section automatically. It is a narrowly bounded plan for an operator using the dedicated `clashcookies_dusk_readonly` PostgreSQL role described in `docs/ai-development-workflow.md` and `docs/roadmaps/production-backup-readiness.md`.

### Approval and safety contract

- Scope: one approved production database connection through the operator-managed local tunnel only; no SSH/production access is granted by this document.
- Role: `clashcookies_dusk_readonly`; verify `current_user`, database, server version, and read-only grants before running measurements.
- Transaction: `BEGIN READ ONLY`; set a 5-second statement timeout and 1-second lock timeout where the operator’s role permits session settings. Roll back after each bounded batch.
- Cost limits: catalog/metadata queries first; one table-size/row-statistics pass; no full-table scans of JSON payloads; no `COUNT(*)` on every table unless approved; use `pg_class.reltuples` for approximate counts and exact counts only for a bounded target list.
- Output: aggregates only. Do not export `BotSetting.value`, Discord message content, private Discord IDs beyond approved aggregates, raw JSON, credentials, or payload bodies.
- Stop conditions: cancel on timeout, lock wait, unexpected sequential scan of a large table, or any permission error; record the query and stop reason without widening access.

### SELECT-only query groups

The operator should adapt identifiers to the deployed PostgreSQL version and run each group separately.

1. **Environment and table/index footprint**

   - `SELECT current_user, current_database(), version();`
   - `SELECT schemaname, relname, n_live_tup, n_dead_tup, last_analyze, last_autoanalyze, last_vacuum, last_autovacuum FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;`
   - `SELECT schemaname, relname, pg_total_relation_size(relid) AS total_bytes, pg_relation_size(relid) AS table_bytes, pg_indexes_size(relid) AS index_bytes FROM pg_catalog.pg_statio_user_tables ORDER BY total_bytes DESC;`
   - `SELECT schemaname, relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch, pg_relation_size(indexrelid) AS index_bytes FROM pg_stat_user_indexes ORDER BY index_bytes DESC;`

2. **`BotSetting` without values**

   - Group by `split_part("key", ':', 1)` and report count, minimum/maximum `octet_length("value")`, and percentile sizes.
   - Report `date_trunc('month', "updatedAt")` counts and min/max `updatedAt`.
   - Report only namespace and size/age aggregates. For key families with embedded IDs, report counts by family and whether the key is older than approved inactivity thresholds; do not emit full keys or values.

3. **Age distributions and accumulation**

   - For timestamped tables, report approximate row counts and month buckets for `createdAt`, `updatedAt`, `eventAt`, `warEndTime`, `observedAt`, `generatedAt`, or equivalent business timestamps.
   - Focus first on telemetry aggregates/runs, `RepWorkActivityEvent`, `ClanWarHistory`, `ClanWarParticipation`, `WarLookup`, `WarPlanComplianceEvaluation`, `WarPlanViolation`, CWL histories/exports, raid history, blacklist samples, posted messages, and delivery histories.

4. **Orphan candidates**

   - Count only: `LEFT JOIN` child rows to their declared parent and return `COUNT(*)` where the parent is null, for example layout alert rows, delivery rows, tracked-message claims, war-plan violations/evaluations, Dusk claims/reversals, roster children, and Home/Away child rows.
   - Treat mirror-owned rows and rows in compatibility windows separately. An orphan count is a diagnostic signal, not deletion authorization.

5. **Statistics and expensive query candidates**

   - Query `pg_stat_statements` only if the extension is already enabled and the role is allowed to read it; return normalized query identifiers, calls, total/mean/max time, rows, and shared-read blocks, with query text redacted or restricted to approved internal operators.
   - For the top approved query shapes, use `EXPLAIN (FORMAT JSON)` without `ANALYZE` first. `EXPLAIN ANALYZE` executes the query and must be separately approved with a small bounded parameter set.

6. **Historical storage trends**

   - Compare current aggregate output with prior operator snapshots, backup object metadata, or monitoring history if available. Repository code cannot establish a growth rate or storage saving.

### Evidence to record

Record timestamp, commit SHA, database/server version, role, query identifiers, timeout settings, approximate row counts, byte sizes, age buckets, and any errors. Keep raw outputs outside the repository and outside chat when they contain operational identifiers.

## 8. Prioritized remediation backlog

| Priority | Item | Evidence/confidence | Benefit | Risk/validation/rollback |
| --- | --- | --- | --- | --- |
| P0 | Review DBH findings before live M2a Part 3 activation; verify representative existing-schema migration compatibility and recovery gates. | Roadmap/workflow policy; high confidence. | Protects reward correctness and recoverability. | No code change in this PR. Activation remains separately approved. |
| P0 | Measure `BotSetting` namespace/key age/size distribution and `warStartPointsCheck` completed-row accumulation. | Repository shows dynamic keys and no delete for completed jobs; live severity unknown. | Confirms or disproves the highest generic-store growth concern. | SELECT-only approval; no value export. Any cleanup requires backup, migration, rollback, and compatibility tests. |
| P1 | Optimize `player_signal_state` payload representation and establish evidence-backed stale-tag lifecycle. | **Observed:** 1,941 live rows / ~43 MB uncompressed logical values; 1,364 last updated 30+ days ago. **Implemented code:** `stableHashFromArray()` stores sorted serialized object content rather than a compact digest; `ActivitySignalService` rewrites full JSON on observation. **Unknown:** active read/reference needs, eligibility of individual rows for retirement, safe savings. | Reduce per-tag payload and TOAST write amplification; prevent unbounded retention if proven safe. | Start with read-only field-size composition, tag-reference/lifecycle review, compatibility/versioned fingerprint design and fixture tests that prevent synthetic activity events. Do not delete or alter production records; migration/cleanup requires approved backup/recovery, replay checks, and separate authorization. |
| P1 | Define retention classes and owners for telemetry, report runs, delivery histories, rep-work activity, CWL exports/history, raid/blacklist observations, and posted-message rows. | No common repository retention policy found; medium confidence. | Prevents silent long-term growth and clarifies audit obligations. | Preserve accounting/compliance/provenance until obligations are documented; validate with historical views and restore tests. |
| P1 | Capture query plans and runtime statistics for war polling, history/participation windows, telemetry reports, and signal-state bulk reads. | Static query/index review; impact unknown. | Identifies real N+1, sequential scans, or missing indexes. | Use bounded read-only plans first; any index change needs migration and existing-schema validation. |
| P1 | Plan compatibility-first consolidation of `active_sync_post`, `CurrentWar.syncNum`, `FwaLayouts` projections, and Google Sheet fallback namespaces. | Active fallback readers/writers confirmed; high confidence. | Reduces duplicate ownership and migration ambiguity. | Requires dual-read/rollback window, data comparison, and proof all callers moved. |
| P1 | Add explicit lifecycle/expiry semantics for serialized checkpoints and retry jobs where operationally safe. | `BotSetting` checkpoint/job rows persist without generic expiry; severity unknown. | Limits stale-key accumulation and improves observability. | Must preserve restart/recovery behavior; test interrupted jobs and rollback. |
| P2 | Document a namespace registry for `BotSetting` with owner, value contract, sensitivity, max size, and deletion policy. | Generic API and 16 semantic families confirmed. | Prevents future configuration sprawl. | Documentation-only first; no runtime impact. |
| P2 | Review redundant or low-use indexes only after `pg_stat_user_indexes`, size, and query-plan evidence. | No live index evidence. | Possible write/storage reduction. | Dropping an index can regress production; require migration, rollback, and representative plans. |

## 9. Safety, migration, backup, and rollback requirements

- This audit made no SQL connection and no data or schema change.
- No cleanup, retention change, archival, VACUUM FULL, REINDEX, migration, DDL, backfill, wallet adjustment, reward issuance, or runtime behavior change is authorized by this document.
- Accounting, compliance, war-history, membership, provenance, Dusk ledger, source claims, reversal, and audit records are presumed retention-protected until an operator/product/legal decision says otherwise.
- Any future typed-settings migration must use compatibility reads, preserve exact key semantics, compare old/new effective results, support rollback to the old owner, and include a deployed-existing-schema rehearsal.
- Any data deletion or table/index change requires a recent encrypted off-host backup, successful retrieval, disposable restore, and explicit approval in accordance with `production-backup-readiness.md`. Code rollback does not undo committed database migrations.
- Mirror/staging synchronization must not be mistaken for a production retention policy. A mirror delete/recreate cycle is replication behavior, not evidence that source history may be deleted.

## 10. Open questions and evidence gaps

1. How many `BotSetting` rows and bytes exist by family, and how many are stale or malformed?
2. Do completed `warStartPointsCheck` rows accumulate across retired clan tags, and what recovery behavior depends on them?
3. Are telemetry and report-run rows retained intentionally, and what window do operators need?
4. What retention obligations apply to rep-work evidence, war/compliance history, CWL history/exports, raid observations, blacklist samples, posted messages, and delivery rows?
5. Which production queries dominate total time/IO, and do any broad `findMany()` paths lack effective bounds under real guild/clan cardinalities?
6. Are any indexes unused or redundant, and what is the dead-tuple/autovacuum profile of current-state rewrite tables?
7. What external scripts, dashboards, backups, or operator runbooks depend on legacy `BotSetting` keys or compatibility columns?
8. Is `DuskRewardPolicyVersion` populated in production, and which policy definitions are required for future live crediting? Inspect only through approved aggregate/provenance-safe measurements.

## 11. Audit completion status

Repository inspection and the diagnostic/measurement plan are complete. **A bounded, operator-run DBH Part 1b production snapshot has now been captured (see §12), but broader database measurement is incomplete.** Cleanup, migration, retention change, and live reward activation remain incomplete and separately gated.

## 12. DBH Part 1b — operator-run production measurement record (2026-11-14/15 UTC)

**Evidence class:** OBSERVED database aggregates supplied from the operator's restricted PostgreSQL session, compared with IMPLEMENTED `dev` source behavior. This entry updates the earlier repository-only audit; the original Part 1 scope and findings above remain the historical code-only baseline. **No cleanup or application code change occurred.**

### Measurement boundary

- Production PostgreSQL **17.9** on database `clashcookies`, user `clashcookies_dusk_readonly`; Windows localhost tunnel `127.0.0.1:15432`, operator-managed.
- Each successful SQL measurement used `BEGIN READ ONLY`, `SET LOCAL statement_timeout=5000`, `SET LOCAL lock_timeout=1000`, and `ROLLBACK`. Only aggregate namespace labels, row counts, sizes, and dates were returned; no raw keys/values/player tags were exported.
- Initial `BotSetting` SELECT was denied. With explicit operator approval, `GRANT SELECT ON TABLE public.\"BotSetting\" TO clashcookies_dusk_readonly` was executed by the authorized host operator. Restricted-account verification returned **SELECT=true; INSERT=false; UPDATE=false; DELETE=false**. This was a narrowly scoped **production access-control change**, not a data mutation; it must not be confused with the SQL measurement transactions. No broader role grant was approved.
- Catalog estimates (`pg_stat_user_tables`) are not exact row counts; later `BotSetting` counts are exact within each query's database snapshot. `updatedAt` is **write time, not last access**, so old rows are not automatically unused. Logical `octet_length(value)` sizes are **uncompressed** and cannot be treated as physically recoverable bytes.

### Storage and namespace observations

| Table / group | Measured finding | Interpretation / limit |
| --- | --- | --- |
| `FwaPlayerCatalog` | ~69 MB total; ~65 MB indexes; ~41,332 estimated rows | Index cost candidate; no proof of redundant indexes/bloat |
| `TelemetryApiAggregate` | ~43 MB total; ~100,060 estimated rows | Large active telemetry owner; no retention decision |
| `BotSetting` | ~32 MB total; 448 kB main heap, 9,336 kB main indexes, ~23 MB TOAST (including its storage/indexes); ~4,393 initially estimated rows | TOAST-dominated physical footprint, not proof of waste |
| `PlayerCurrent` | ~26 MB total | Not measured for live-value composition |
| `ClanWarParticipation` | ~21 MB total | Evidence-protected historical data |
| `WarLookup` | ~12 MB total; 176 kB main heap | Separate potential TOAST-heavy structure, needs owner review |
| `player_signal_state` in `BotSetting` | **1,941 rows; ~43 MB logical values; max ~26 kB**; first/last write 2026-02-28/2026-11-15 UTC | Dominates `BotSetting` logical bytes; highly compressible serialized payload likely contributes to TOAST |
| `todo_games_baseline` | **2,257 rows; 2,257 logical bytes**; all last updated 2026-03-26 | High key count but negligible value bytes; do not infer safe deletion |
| `points_cache` / `points_matchup_cache` | 22 rows / ~12 kB; 7 rows / 1,308 bytes; February writes only | Legacy-reference review candidate, not a cleanup authorization |
| `warStartPointsCheck` | 11 rows / 4,601 logical bytes; 8 updated within seven days | Actively rewritten, not a major current size concern |

Other large tables observed included `FwaClanWarLogCurrent` (~20 MB), `AutoRoleSyncRun` (~14 MB), and `TelemetryStageAggregate` (~8.6 MB). Among the top 20 tables, the restricted account originally had SELECT on `ClanWarParticipation` and `RepWorkActivityEvent` only; `BotSetting` access was independently authorized afterward. No broader table contents were measured.

### `player_signal_state` age and logical payload

| Time since last `updatedAt` | Rows | Logical values | Average bytes / row |
| --- | ---: | ---: | ---: |
| Under 7 days | 465 | ~11 MB | 24,975 |
| 7–30 days | 112 | ~2,590 kB | 23,682 |
| 30–90 days | 247 | ~5,632 kB | 23,349 |
| 90–180 days | 680 | ~14 MB | 22,254 |
| 180+ days | 437 | ~9,443 kB | 22,127 |

**Observed:** 1,364 / 1,941 (~70.3%) rows last written 30+ days ago; 1,117 (~57.5%) last written 90+ days ago; 437 (~22.5%) last written 180+ days ago. Approximately **29 MB** logical data falls in 30+ days, and **23 MB** in 90+ days. Rounded size buckets must not be used as a precise savings estimate. The averages are consistently ~22–25 kB, suggesting broadly repeated payload shape rather than a tiny outlier population.

**Implemented code diagnosis (`src/services/ActivitySignalService.ts`, read on `dev`):** `PlayerSignalState.hashes` has `achievements`, `troops`, `heroes`, `spells`, `pets`, `heroEquipment`. Despite its name, `stableHashFromArray()` normalizes, serializes and sorts objects, then returns `normalized.join('|')` **not a fixed-length digest**. `processPlayer()` stores the full current JSON with `SettingsService.set()` on each observation. `TodoService` and `TodoSnapshotService` also consume this state. This establishes a plausible mechanism for the uniform ~22–25 kB values and a compatibility hazard if fingerprint format changes. It does **not** establish that 30/90-day-old accounts are unlinked, untracked, nonessential, or safe to prune.

### Focused optimization backlog / acceptance criteria

1. **P1: Payload/fingerprint optimization, diagnostic first.** Use bounded SELECT-only aggregates to estimate bytes per `hashes` field without revealing raw content. Trace all producers, consumers, comparisons, persist/replay behavior, version parsing and migration-on-read or explicit versioning. Design compact deterministic fingerprints; verify representation-only transitions do **not** trigger artificial `changedSignals` / activity timestamps. Test old state, null/malformed records, renamed accounts, changes in player object-array ordering, and multi-account scenarios. Evaluate actual before/after size and write-amplification on fixtures/disposable database; do not ship an untested in-place conversion.
2. **P1: Stale-tag retention policy, evidence first.** Trace tracked-clan, linked-account, `TodoSnapshot`, player activity, and historical evidence dependencies; distinguish *not recently written* from *safe to delete*. Propose owner-approved limits or archival only after evidence/retention obligations and recovery behavior are documented. Provide dry-run aggregate counts, rollback/recovery plan and explicit production approval before any deletion.
3. **P2: Legacy micro-state review.** Check `todo_games_baseline` and February-only points cache readers/writers through live `dev` paths, including fallback compatibility, before considering retirement. Low byte-savings priority despite high `todo_games_baseline` row count.
4. **P2: Physical/index footprint follow-up.** Use safe catalog/statistics and representative query plans to evaluate `FwaPlayerCatalog` indexes, `WarLookup` TOAST footprint, and telemetry retention. No `REINDEX`, `VACUUM FULL`, index drop or data purge without separate approval and proven backup/recovery readiness.

**No implementation, SQL cleanup, data migration, historical backfill, index operation, automatic reward, deployment, or expansion of privileges is authorized by this measurement record.** The backup roadmap still reports no verified encrypted off-host production backup and disposable restore, so cleanup/migrations remain separately blocked.
