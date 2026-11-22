# FB-002 P4d-1a — Existing war history and source-authority inventory

Status: repository inventory complete; production inventory not performed.
This document records Codex's pre-publication repository work and is now
included in published PR #2142. It remains a read-only diagnostic and does not
implement a collector, archive, schema change, migration, native publication,
activation, or TH19 target.

Decision: **NO-GO for P4d-1b authority implementation.** The repository has
durable Dusk-owned ended-war history, but it does not have a durable FWAStats
observation owner that proves exact FWA-war identity, source generation,
complete native roster, direct weights, authenticity, or replay/contradiction
history. The smallest next step is **C — seek upstream identity and source
contract evidence first**. Reuse of Dusk owners is appropriate only for Dusk
war history; an immutable FWA archive (B) should be designed only if the
upstream contract cannot supply the missing identity and contradiction facts.

## 1. Scope, baseline, and authorization

This inventory was prepared during Codex's pre-publication work for PR #2142;
PR #2142 is now published. The checked-out branch is
`feature/p4d-1-source-authority-feasibility`, at local SHA
`660f3689193b21bedb543ff0cb53a1ab7e82194d7`, which matches local
`origin/dev` and the supplied starting development baseline. The repository is
clean at the verified baseline. No application code, Prisma schema or
migration, runtime configuration, production process, external service, or
backup was changed.

An earlier GitHub file-API lookup failed with `404 No commit found for the
ref`; that was an access/tooling result during the earlier inspection, not
evidence that the commit was absent. GitHub independently verified that the
starting dev SHA is `660f3689193b21bedb543ff0cb53a1ab7e82194d`. The local
checkout and that independent verification agree on the baseline.

The production-data inspection authorization basis is **none for this task**.
No SSH session, database connection, tunnel, VM, secrets, environment file,
backup object, or live FWAStats HTTP request was used. The SQL below is a
proposed operator packet, not observed production output. Every production
count, date range, scheduler override, overlap, and recovery result remains
**UNVERIFIED**.

The following repository instructions and evidence were used:

- [FB-002 issue #2113](https://github.com/tonykslee/ClashCookies/issues/2113)
  and the P4c/P4d diagnostics;
- `docs/ai-development-workflow.md`, `docs/project-brain.md`,
  `docs/architecture-contract.md`, `docs/core-priorities.md`, and
  `docs/observability.md`;
- the Prisma models and focused FWA, war-history, mirror, and atomicity tests;
- backup/recovery documentation in `docs/roadmaps/production-backup-readiness.md`
  and `ops/backup/README.md`.

The issue and the existing P4d-0 contract remain authoritative for the
separation of P4d-1, P4d-2, and P4e. The legacy-v1 `HeatMapRef` owner remains
isolated and authoritative for its existing profile. TH19 native targets
remain inactive.

## 2. Architecture map

```text
Dusk / Clash API war snapshots
  -> CurrentWar (live per clan/guild)
  -> WarAttacks (current-war staging, including attackOrder=0 roster rows)
  -> war-end transaction
       -> ClanWarHistory (ended-war summary)
       -> WarLookup (archived/reconstruction payload)
       -> ClanWarParticipation (complete ended-war own-clan roster)
       -> WarEvent (delivery/idempotency facts)

FWAStats JSON
  -> FwaStatsClient
       -> Clans.json / Members.json / WarMembers.json?warNo=1 / Wars.json
  -> current-state sync services
       -> FwaClanCatalog / FwaClanMemberCurrent / FwaWarMemberCurrent
       -> FwaClanWarLogCurrent
       -> FwaTrackedClanWarRosterCurrent + members
       -> FwaFeedSyncState / FwaFeedCursor / FwaClanWarsWatchState
  -> diagnostic native candidate reader only
       -> NativeHeatMapRefCandidateService
       -> no native authority and no publication
```

The two branches meet only in diagnostic or operational consumers. A Dusk
`ClanWarHistory` row or `ClanWarParticipation` row cannot silently become an
FWAStats observation, and an FWA current snapshot cannot be treated as a Dusk
ended-war archive.

## 3. Owner and retention matrix

| Owner | Scope and writer | Identity/key | Mutation and retention | Evidence available | Authority conclusion |
| --- | --- | --- | --- | --- | --- |
| `CurrentWar` | Live Dusk war state per `(clanTag, guildId)`; active war-event/polling runtime | `warId` may be nullable; composite primary key is `(clanTag, guildId)`; start/opponent are indexed | Upserted while live; deleted after the ended-war archive transition | Live state, match type, points, times, opponent, team size; no immutable observation generation | Live Dusk state only; never a historical or FWA source owner |
| `WarAttacks` | Dusk current-war staging per clan/start time | Primary key `(warId, playerTag, attackNumber)` and unique current snapshot key `(clanTag, warStartTime, playerTag, attackOrder)` | Reconciled/upserted from current API snapshots; rows for other war start times are deleted; all rows for the ended `warId` are deleted after archive | Attack facts and `attackOrder=0` roster rows; observation/update times; no durable post-end copy in this table | Useful input to Dusk archive transaction; not retained FWA evidence |
| `ClanWarHistory` | Canonical Dusk ended-war summary | Auto-increment `warId`; unique `(warStartTime, clanTag, opponentTag)` | Ended-war transaction inserts or updates the canonical row; no repository retention/deletion policy found | Dusk result, stars/destruction, points, classification, names/tags, prep/start/end times | Durable Dusk identity and summary; not proof of FWAStats authority |
| `WarLookup` | Archived Dusk payload/reconstruction input | String `warId` primary key, normally the Dusk `ClanWarHistory.warId` rendered as a string | Ended-war transaction inserts/upserts the payload; existing payload is reused when live attacks are absent; no repository purge policy found | JSON payload with Dusk war metadata, participant snapshots, and attack-derived facts; `teamSize` is diagnostic/compatibility metadata | Durable Dusk raw/reconstruction evidence, not an FWA source observation or authenticity proof |
| `ClanWarParticipation` | Canonical Dusk ended-war own-clan roster | Composite guild/war/player identity in the model; rows are created from the canonical Dusk participant snapshot | Transactional `createMany(skipDuplicates)`; intended append-only per ended war; no repository purge policy found | One row per distinct Dusk participant, including zero-attack members; roster completeness for that Dusk war | Strongest existing roster owner for Dusk-owned wars; no FWA classification or native weight authority |
| `WarEvent` | Dusk war-event delivery/idempotency facts | Composite `(warId, clanTag, eventType)` | Idempotent insert/upsert semantics by event key; payload is event evidence; no FWA generation | Event type and payload sufficient for Dusk event replay/deduplication | Dusk event idempotency only; not a cross-source generation ledger |
| `FwaClanWarLogCurrent` | FWAStats `Wars.json` recent-war rows per clan | Unique `(clanTag, endTime, opponentTag, teamSize)`; no upstream war ID | Content-hash gated sync upserts incoming rows and deletes existing rows absent from the newest payload | End/result, opponent, team size, summary fields, `matched`, and `sourceSyncedAt`; latest payload only | Rolling snapshot; cannot recover an omitted row or prove exact FWA identity/generation |
| `FwaWarMemberCurrent` | FWAStats `WarMembers.json?warNo=1` current member rows per clan/player | Primary key `(clanTag, playerTag)`; no war or batch key | Sync deletes stale player rows and upserts the newest rows; `FwaFeedSyncState.lastContentHash` is latest-only | Player tag/name, position, TH, direct weight as parsed, opponent/attack fields, source time; no raw payload persistence | Current factual observation only; exact war and generation are explicitly unavailable |
| `FwaTrackedClanWarRosterCurrent` plus members | Derived current roster for tracked clans | Parent primary key `clanTag`; member keys `(clanTag, playerTag)` and unique `(clanTag, position)` | Service deletes/recreates the current parent and child rows transactionally | Current roster, raw/effective weight, unresolved-weight status, copied `CurrentWar` source fields, observation time | Derived latest-only snapshot; fields copied from separate owners are not a source-batch binding |
| `FwaFeedSyncState` | Per-feed/per-scope operational state | Unique `(feedType, scopeType, scopeKey)` | Upserted on attempt/success/failure; status, counts, hash, and next eligibility are overwritten | Fetch health, latest row count/change count, latest content hash, errors and cadence | Operational telemetry; no immutable evidence or source generation |
| `FwaFeedCursor` | Global FWA sweep cursor per feed | `feedType` primary key | Updated after bounded cursor sweep | Last scope key and run time | Sweep progress only; not retention or ordering proof |
| `FwaClanWarsWatchState` | Tracked-clan daily watch window | `clanTag` primary key | Upserted as windows activate/expire and content changes are acquired | Schedule, poll window, current cycle key, last hash, detected end and stop reason | Operational watch state; no immutable war identity or replay history |

The FWA tables are therefore not interchangeable. A content hash detects that
the latest fetched payload changed; it does not identify a source generation,
authenticate the source, or preserve the payload that was replaced.

## 4. Repository evidence by owner

### 4.1 Dusk current and ended-war path

`CurrentWar` is the live owner. `WarEventLogService` refreshes `WarAttacks`
from current Dusk war snapshots. The service explicitly deletes
`WarAttacks` rows for other war start times, then writes one `attackOrder=0`
row per current own-clan member and attack rows for observed attacks. At war
end, `WarEventHistoryService.persistWarEndHistory`:

1. resolves the Dusk war start/result snapshot;
2. inserts or updates `ClanWarHistory` by `(warStartTime, clanTag,
   opponentTag)`;
3. builds or reuses a `WarLookup` JSON payload in the same transaction;
4. appends `ClanWarParticipation` from the complete `attackOrder=0` member
   rows with `skipDuplicates`; and
5. after the archive transaction, deletes the ended war's `WarAttacks` and
   `CurrentWar` rows.

The atomicity tests cover preserving an existing `WarLookup`/participation
record on re-entry, rollback when archive input is missing, and rollback when
participation persistence fails. This is meaningful durability for Dusk-owned
war identity and roster completeness. It is not a claim that the Dusk war
record is the same object as an FWAStats `Wars.json` or `WarMembers.json`
record.

The existing Dusk path can establish these dimensions for its own source:

- **Identity:** a Dusk `warId` plus the unique Dusk clan/start/opponent key;
- **Roster binding:** participant rows are produced from one Dusk war snapshot
  before current rows are removed;
- **Completeness:** the canonical Dusk own-clan member list includes
  zero-attack players;
- **Attack/result facts:** stored in the history payload and summary;
- **Classification:** Dusk's persisted `matchType` and event context;
- **Atomic archive transition:** summary, payload, and participation are
  written transactionally.

It does not establish an FWAStats source generation, direct FWA weight
provenance, upstream authenticity, or historical contradictions against an
FWA source. Dusk history is option A only for Dusk-owned evidence.

### 4.2 FWAStats client and selectors

The repository client uses these endpoints:

| Endpoint | Repository use | Stable identity in returned normalized type |
| --- | --- | --- |
| `Clans.json` | Global FWA clan catalog | Clan tag and catalog fields only |
| `Clan/{tag}/Members.json` | Current clan members | Clan/player tags; no war identity |
| `Clan/{tag}/WarMembers.json?warNo=1` | Current war-member feed | `warNo` is a request selector; normalized rows have no upstream war ID or source generation |
| `Clan/{tag}/Wars.json` | Recent clan war summary | End time/opponent/team size and summary fields; no upstream war ID or generation |

`FwaStatsClient` normalizes `Wars.json` rows using `endTime`, `teamSize`, and
`opponentTag`; it discards rows that cannot provide those values. The sync
service constructs its database identity from those same fields. The source
contract visible in this repository does not show that `warNo=1` is a stable
identifier for one exact FWA war, nor that a `Wars.json` row and a
`WarMembers.json?warNo=1` payload share a durable identity.

The P4c evaluator intentionally records:

- raw and accepted-row fingerprints and row-level reasons;
- optional declared roster size and declared total weight;
- opponent observations and structural/completeness/weight status;
- `exactWarBindingStatus = UNAVAILABLE`;
- `sourceGenerationStatus = UNAVAILABLE`; and
- candidate eligibility that cannot become `VERIFIED` without the unavailable
  identity/generation facts.

The live client does not supply a declared roster size or declared total
weight. Consequently, a cleanly parsed live payload can be a useful factual
observation while still being `UNAVAILABLE` for native authority. A
fingerprint is an integrity/consistency aid, not an authenticity token.

### 4.3 FWA sync, replacement, and scheduling behavior

`FwaClanWarsSyncService.syncClan` fetches `Wars.json`, sorts rows by end time,
computes a content hash, and returns `NOOP` when the latest hash is unchanged.
On change, one transaction deletes rows no longer present in the new payload
and upserts the incoming rows by `(clanTag, endTime, opponentTag, teamSize)`.
The result is a bounded recent snapshot, not an append-only log.

`FwaWarMembersSyncService.syncClan` similarly replaces stale current member
rows, records only the latest hash in `FwaFeedSyncState`, and then refreshes
the tracked current roster. `FwaTrackedClanWarRosterSyncService` reads current
FWA members plus the freshest separate `CurrentWar` row, applies its
effective-weight rules, and deletes/recreates the current parent and child
rows. It does not retain the raw FWA payload, a source batch relation, or a
historical war observation.

`FwaClanWarsWatchService` activates tracked-clan watch windows from active
sync-time messages. During an active window it force-syncs the current war log
and current members, compares the latest content hash, records the latest
detected end time, and stops after an update is acquired. The hash comparison
is useful for watch control; it is not a generation fence.

`FwaFeedSchedulerService` reads environment-controlled enablement and cadence.
Repository defaults are:

- clans catalog sync enabled, 360 minutes with a 15-minute minimum;
- clan members sync enabled, 15 minutes;
- WarMembers sweep enabled, 15-minute tick, chunk size 6;
- tracked-clan Wars watch enabled, 5-minute tick; and
- global Wars sweep **disabled by default**, 15-minute tick when enabled,
  chunk size 20, max concurrency 4.

Production environment overrides were not inspected. The default therefore
cannot be reported as the production setting.

## 5. FWAStats history semantics: warNo=1/2/3 and `Wars.json`

No live external HTTP request was made, and no repository fixture or recorded
payload was found that independently proves the upstream retention window,
the reported “approximately three recent wars” behavior, or the availability
of `warNo=2`/`warNo=3` selectors. The repository proves only that the current
client calls `warNo=1` for `WarMembers.json` and calls `Wars.json` without a
war-number selector.

Accordingly:

- `warNo=1`, if accepted by the upstream service, is treated as a selector,
  not a stable war identity;
- the existence or meaning of `warNo=2` and `warNo=3` is **UNVERIFIED**;
- a three-war upstream window is **UNVERIFIED** and cannot be used as a
  retention guarantee;
- `Wars.json` is a summary feed whose normalized rows lack an upstream exact
  war ID and source generation; and
- a matching timestamp, opponent tag, team size, or content hash cannot
  substitute for an upstream identity contract.

The reported Chocolate Clash endpoint outage and any external retention
observations are intentionally not used as evidence in this repository-only
inventory.

## 6. Source-authority matrix

| Required dimension | Existing Dusk owner | Existing FWA owner | P4d-1a result |
| --- | --- | --- | --- |
| Exact war identity | Dusk `warId` plus canonical start/clan/opponent key | No upstream war ID; current keys are derived from mutable summary fields | Dusk-only; FWA `UNAVAILABLE` |
| FWA classification | Dusk `matchType` for Dusk processing | `matched`/opponent/summary fields are diagnostic and not an attestation | FWA `UNAVAILABLE` |
| Exact source-to-roster binding | Dusk current snapshot to ended-war transaction | Current FWA members and current Dusk `CurrentWar` are separate reads | FWA `UNAVAILABLE` |
| Complete roster | `ClanWarParticipation`, including zero-attack members | Current rows can be replaced or absent; no declared live roster size | Dusk-only; FWA `UNAVAILABLE` |
| Direct member weights | Not owned by the Dusk ended-war participation contract | Parsed current weights, but no durable raw observation or declared total in live client | FWA factual-only; authority `UNAVAILABLE` |
| Raw payload preservation | `WarLookup` preserves a Dusk reconstruction payload | No raw FWA payload table; current normalized rows only | FWA `UNAVAILABLE` |
| Authenticity | Dusk API/event path is the source used by Dusk runtime; no cryptographic upstream attestation | Fingerprints detect content changes only | No native authenticity proof |
| Source generation/replay | Dusk event and unique archive keys provide Dusk idempotency | `FwaFeedSyncState` and cursors retain latest operational state only | FWA `UNAVAILABLE` |
| Late contradiction history | Dusk archive updates are scoped to the Dusk canonical key | Replaced FWA rows and absent rows are not retained as contradictions | No FWA conflict history |
| Recovery of replaced evidence | Backup may contain a point-in-time Dusk/FWA table snapshot if it predates replacement | No guarantee that a current-table backup includes already-deleted rows | Requires operator evidence; not observed |

## 7. Production inventory packet and result

### 7.1 Result

Actual production-data inspection: **not performed**.

Explicit authorization basis: **none**. The user’s request requires a
read-only packet when production access is unavailable and forbids use of
production state, secrets, VM/Postgres access, backups, or external services
without separate authorization. No counts below are observed counts.

### 7.2 Bounded operator requirements

If separately authorized later, an operator should run the packet using the
existing SELECT-only diagnostic role, with the session timezone set to UTC,
inside a read-only transaction, and with a bounded statement timeout. The
statement timeout is an execution-time bound, not a row-count or date-range
bound: the full-history aggregates below have no date predicate and may scan
large tables before timing out. A reviewed UTC date range or row limit would be
a separate operator choice and must be stated in the result; it must not be
silently inferred from the timeout. The operator should return aggregate rows
only: no player names, Discord IDs, raw JSON, credentials, URLs containing
secrets, or full clan/member/tag dumps. The packet must not run `EXPLAIN
ANALYZE`, write temporary tables, alter session roles, or access the live
FWAStats endpoints.

The operator must separately report the sanitized production process settings
`FWA_GLOBAL_CLAN_WARS_SWEEP_ENABLED`, `FWA_TRACKED_CLAN_WARS_WATCH_ENABLED`,
`FWA_WAR_MEMBERS_SWEEP_ENABLED`, and the effective polling mode. Environment
configuration is not available from SQL and must not be inferred from table
rows.

The canonical-war coverage query counts distinct `playerTag` values within
each Dusk `ClanWarHistory.warId`, avoiding double-counting guild-scoped
participation rows. Even that deduplicated participation count does not itself
prove authoritative roster completeness: it is only a count of persisted rows
available for that canonical war and must remain separate from the source
authority decision.

### 7.3 Proposed read-only SQL

The following is a proposed query packet, not an execution record; every
statement remains proposed and unexecuted. It uses aggregate counts only, but
the full-history aggregates are not row- or date-bounded. If a table or column
is missing on the target database, or if any required table lacks SELECT
permission, stop and report the mismatch rather than requesting a grant or
editing the query into a write or migration.

```sql
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';
SET LOCAL TIME ZONE 'UTC';

SELECT current_database() AS database_name,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('TimeZone') AS reporting_timezone,
       now() AS observed_at_utc;

-- Non-mutating permission preflight. Stop before the data queries unless every
-- required row reports exists=true and select_granted=true. Do not request
-- additional grants from this packet.
WITH required(table_schema, table_name) AS (
  VALUES
    ('public','CurrentWar'),
    ('public','WarAttacks'),
    ('public','ClanWarHistory'),
    ('public','WarLookup'),
    ('public','WarEvent'),
    ('public','ClanWarParticipation'),
    ('public','FwaClanWarLogCurrent'),
    ('public','FwaWarMemberCurrent'),
    ('public','FwaTrackedClanWarRosterCurrent'),
    ('public','FwaTrackedClanWarRosterMemberCurrent'),
    ('public','FwaFeedSyncState'),
    ('public','FwaFeedCursor'),
    ('public','FwaClanWarsWatchState')
)
SELECT table_schema,
       table_name,
       to_regclass(format('%I.%I', table_schema, table_name)) IS NOT NULL AS exists,
       CASE
         WHEN to_regclass(format('%I.%I', table_schema, table_name)) IS NULL THEN false
         ELSE has_table_privilege(
           current_user,
           format('%I.%I', table_schema, table_name),
           'SELECT'
         )
       END AS select_granted
FROM required;

SELECT 'CurrentWar' AS owner, count(*)::bigint AS row_count,
       count(DISTINCT "clanTag")::bigint AS clan_count,
       min("startTime") AS min_start, max("startTime") AS max_start
FROM "CurrentWar"
UNION ALL
SELECT 'WarAttacks', count(*)::bigint, count(DISTINCT "clanTag"),
       min("warStartTime"), max("warStartTime") FROM "WarAttacks"
UNION ALL
SELECT 'ClanWarHistory', count(*)::bigint, count(DISTINCT "clanTag"),
       min("warStartTime"), max("warStartTime") FROM "ClanWarHistory"
UNION ALL
SELECT 'WarLookup', count(*)::bigint, count(DISTINCT "clanTag"),
       min("startTime"), max("startTime") FROM "WarLookup"
UNION ALL
SELECT 'ClanWarParticipation', count(*)::bigint, count(DISTINCT "clanTag"),
       NULL::timestamptz, NULL::timestamptz FROM "ClanWarParticipation"
UNION ALL
SELECT 'FwaClanWarLogCurrent', count(*)::bigint, count(DISTINCT "clanTag"),
       min("endTime"), max("endTime") FROM "FwaClanWarLogCurrent"
UNION ALL
SELECT 'FwaWarMemberCurrent', count(*)::bigint, count(DISTINCT "clanTag"),
       min("sourceSyncedAt"), max("sourceSyncedAt") FROM "FwaWarMemberCurrent"
UNION ALL
SELECT 'FwaTrackedClanWarRosterCurrent', count(*)::bigint, count(DISTINCT "clanTag"),
       min("observedAt"), max("observedAt") FROM "FwaTrackedClanWarRosterCurrent"
UNION ALL
SELECT 'FwaTrackedClanWarRosterMemberCurrent', count(*)::bigint, count(DISTINCT "clanTag"),
       min("updatedAt"), max("updatedAt") FROM "FwaTrackedClanWarRosterMemberCurrent"
UNION ALL
SELECT 'FwaFeedSyncState', count(*)::bigint, count(DISTINCT "scopeKey"),
       min("lastAttemptAt"), max("lastAttemptAt") FROM "FwaFeedSyncState"
UNION ALL
SELECT 'FwaFeedCursor', count(*)::bigint, count(DISTINCT "feedType"),
       min("lastRunAt"), max("lastRunAt") FROM "FwaFeedCursor"
UNION ALL
SELECT 'FwaClanWarsWatchState', count(*)::bigint, count(DISTINCT "clanTag"),
       min("updatedAt"), max("updatedAt") FROM "FwaClanWarsWatchState";

-- Dusk classification and canonical roster coverage. The per-war count uses
-- distinct playerTag values so guild-scoped duplicate participation rows do
-- not inflate the canonical-war identity count. This count is diagnostic only:
-- participation rows do not themselves prove authoritative completeness.
SELECT "matchType", count(*)::bigint AS history_rows,
       count(DISTINCT "clanTag")::bigint AS clans,
       min("warStartTime") AS min_start, max("warStartTime") AS max_start
FROM "ClanWarHistory"
GROUP BY "matchType"
ORDER BY "matchType" NULLS FIRST;

SELECT count(*)::bigint AS ended_wars,
       count(*) FILTER (WHERE distinct_participants > 0)::bigint AS wars_with_participation,
       count(*) FILTER (WHERE distinct_participants = 0)::bigint AS wars_without_participation,
       min(distinct_participants)::bigint AS min_distinct_participants,
       max(distinct_participants)::bigint AS max_distinct_participants
FROM (
  SELECT h."warId",
         count(DISTINCT p."playerTag")::bigint AS distinct_participants
  FROM "ClanWarHistory" h
  LEFT JOIN "ClanWarParticipation" p ON p."warId" = h."warId"::text
  GROUP BY h."warId"
) coverage;

-- FWA current-state freshness and conflict indicators; aggregate only.
SELECT "feedType", "scopeType", count(*)::bigint AS scopes,
       count(*) FILTER (WHERE "lastStatus" = 'SUCCESS')::bigint AS success_scopes,
       count(*) FILTER (WHERE "lastStatus" = 'FAILURE')::bigint AS failed_scopes,
       min("lastSuccessAt") AS oldest_success,
       max("lastSuccessAt") AS newest_success
FROM "FwaFeedSyncState"
GROUP BY "feedType", "scopeType"
ORDER BY "feedType", "scopeType";

SELECT count(*)::bigint AS current_war_log_rows,
       count(DISTINCT ("clanTag", "endTime", "opponentTag", "teamSize"))::bigint AS derived_keys,
       count(*) FILTER (WHERE "matched" IS TRUE)::bigint AS matched_rows,
       count(*) FILTER (WHERE "matched" IS FALSE)::bigint AS explicitly_unmatched_rows,
       count(*) FILTER (WHERE "matched" IS NULL)::bigint AS unclassified_rows
FROM "FwaClanWarLogCurrent";

SELECT count(*)::bigint AS current_member_rows,
       count(*) FILTER (WHERE "weight" IS NULL)::bigint AS missing_weight_rows,
       count(DISTINCT "clanTag")::bigint AS clans,
       min("sourceSyncedAt") AS oldest_source_sync,
       max("sourceSyncedAt") AS newest_source_sync
FROM "FwaWarMemberCurrent";

SELECT count(*)::bigint AS tracked_rosters,
       count(*) FILTER (WHERE "hasUnresolvedWeights")::bigint AS unresolved_rosters,
       count(*) FILTER (WHERE "sourceWarId" IS NULL)::bigint AS without_source_war_id,
       count(*) FILTER (WHERE "sourceWarStartTime" IS NULL)::bigint AS without_source_start,
       min("observedAt") AS oldest_observed,
       max("observedAt") AS newest_observed
FROM "FwaTrackedClanWarRosterCurrent";

ROLLBACK;
```

The packet deliberately does not claim that a normalized overlap between
`FwaClanWarLogCurrent` and `ClanWarHistory` proves identity. If an operator
needs an overlap estimate, it must be a separately reviewed aggregate using
normalized clan/opponent tags and an explicitly stated time tolerance; the
result is only a lead for manual review, never a native-authority count.

## 8. Backup and recovery feasibility

Repository backup documentation reports one operator-authorized November 2026
production backup and a disposable PostgreSQL 17 restore of an earlier real
daily archive. It also records that the timer remains disabled, independent
freshness monitoring and some key-custody gates remain open, and that the
reports are operator evidence rather than an authorization for another run.
Those records were not re-executed or independently inspected during this
task.

That recovery path could potentially recover a deleted
`FwaClanWarLogCurrent` row only if all of the following are true:

1. a retained backup was captured before the row was deleted or overwritten;
2. the backup contains the relevant table data and the selected point in
   time; and
3. the archive can be restored to an isolated PostgreSQL instance for a
   read-only comparison.

The current table's rolling deletion behavior means a recent backup taken
after an upstream payload omission may already lack the row. The repository
does not provide table-specific point-in-time coverage, an append-only FWA
archive, or a verified list of backups containing the required historical
row. No backup was selected, downloaded, decrypted, restored, or queried for
this inventory. Recovery feasibility is therefore **POSSIBLE IN PRINCIPLE;
UNVERIFIED FOR ANY SPECIFIC WAR**.

## 9. P4d-1b recommendation and gates

### Recommendation

Choose **C — seek upstream identity first**. Request or verify an upstream
contract that supplies, at minimum:

- an immutable exact war identifier shared by the war summary and member
  payloads;
- a source generation or monotonic observation identifier with replay rules;
- a declared roster boundary and direct-weight semantics;
- a durable way to detect a late contradictory response for the same exact
  war; and
- source-level classification/authenticity facts or an explicit attestation
  contract.

If that contract cannot be obtained, return to option B with an owner-approved
immutable observation/archive design. That design must preserve raw source
observations, accepted/rejected rows, exact identity, generation, direct
weight provenance, source classification, and contradictions. It must not
promote the existing current tables by backfill or treat Dusk history as a
substitute.

Option A is still the smallest safe reuse for Dusk-owned history consumers:
`ClanWarHistory`, `WarLookup`, and `ClanWarParticipation` may support Dusk
historical reporting where their own identity and completeness contract is
enough. They cannot authorize native FWA reference publication.

### P4d-1b NO-GO conditions

P4d-1b must remain **NO-GO for implementation** until the inventory's missing
facts are resolved. In particular, it must not:

- derive exact FWA identity from `warNo`, end time, opponent, team size, or
  content hash;
- use `FwaClanWarLogCurrent`, `FwaWarMemberCurrent`, or the tracked current
  roster as immutable history;
- infer completeness from the number of current rows when the source declares
  no roster boundary;
- treat `matched`, historical Dusk `VERIFIED`/FWA classification, or a
  previously eligible row as proof against newly contradictory source facts;
- overwrite or reinterpret legacy-v1 `HeatMapRef` rows;
- activate TH19 targets; or
- collapse P4d-1 evidence ownership, P4d-2 publication, and P4e activation
  into one change.

The next permitted activity is a repository-only upstream-contract review or
a separately authorized, read-only operator inventory using the packet above.
No production counts were observed in this task, and no implementation is
authorized by this diagnostic.

## 10. Validation boundary

This document is the only intended worktree file change. The final validation
must include the normal tracked diff check, exact changed-path review, and
`git status`. No application test suite is required for this docs-only
inventory. The required validation is:

```text
git diff --check
git status --short --untracked-files=all
git diff --name-only
```

The work stops without committing, pushing, creating or updating a PR,
merging, deploying, connecting to production, or restoring a backup.
