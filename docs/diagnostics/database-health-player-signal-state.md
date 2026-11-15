# DBH P1 — `player_signal_state` fingerprint and write-amplification diagnosis

**Repository:** `tonykslee/ClashCookies`
**Base:** `dev`
**Scope:** DBH P1 Phase A compatibility implementation and verified diagnostic; no schema change, migration, production query, data mutation, deletion, deployment, reward activation, or currency issuance
**Evidence date:** 2026-11-14/15 UTC production aggregates plus `dev` source inspection
**Related:** [DBH Part 1 audit](database-health-audit.md), [Dusk economy roadmap](../roadmaps/dusk-economy.md)

## 1. Decision summary

`player_signal_state:<PLAYER_TAG>` is an active current-state record owned by `ActivitySignalService`, stored through the generic `SettingsService` wrapper in `BotSetting`. It is not safe to delete or compact by age alone.

The verified P1 storage defect is narrower and actionable:

1. Production has 1,941 `player_signal_state` rows and approximately 43 MB of uncompressed logical `BotSetting.value` text. 1,364 rows were last written 30+ days ago; 1,117 were 90+ days old; 437 were 180+ days old. These are write-age measurements, not proof that the rows are unused.
2. `ActivitySignalService.stableHashFromArray()` does not return a digest. It returns a sorted, duplicate-preserving, pipe-joined serialization of six player object arrays: `achievements`, `troops`, `heroes`, `spells`, `pets`, and `heroEquipment` (`src/services/ActivitySignalService.ts:19-26,132-144`).
3. `processPlayer()` rewrites the complete JSON state through `SettingsService.set()` on every successful observation, including unchanged observations (`src/services/ActivitySignalService.ts:237-316`; `src/services/SettingsService.ts:13-23`). This is a plausible TOAST and write-amplification source, but production dead-tuple and WAL savings remain UNKNOWN.
4. The state is semantically important. Its counters and timestamps feed `PlayerActivity`, `/lastseen`, `/inactive` coverage/results, `/todo` GAMES totals/freshness, and todo snapshots. A fingerprint-only format change that compares v1 text directly with v2 digests would create synthetic activity.
5. No direct Dusk reward-evidence reader uses `player_signal_state`. Current Dusk evidence uses persisted rep-work events, war history/participation/compliance, archived attack detail, Home/transfer evidence, and conservative `PlayerLink` attribution. This diagnosis therefore protects economy-adjacent activity state but does not make player-signal state reward evidence.

Phase A implementation direction: preserve the existing normalization exactly, hash the resulting canonical string with SHA-256, read and compare valid v1 and v2 states, and keep every persisted write on the existing v1 envelope and serialized hash representation. This slice does not enable v2 writes, run a v1-to-v2 backfill, or perform retention cleanup.

## 2. Verified source map

### 2.1 Producer and storage owner

| Path | Role | Finding |
| --- | --- | --- |
| `src/services/ActivitySignalService.ts:80-88` | Key owner | Builds the global key `player_signal_state:<TAG-IN-UPPERCASE>`. The key is not guild-scoped. |
| `src/services/ActivitySignalService.ts:156-187` | State initializer | Initializes counters, six array representations, empty `signalTimes`, `lastSeenAtMs: null`, and `updatedAtMs: nowMs`. |
| `src/services/ActivitySignalService.ts:228-235` | State reader | Reads one key through `SettingsService.get()` and accepts only the current version. |
| `src/services/ActivitySignalService.ts:237-323` | Signal producer | Compares counters and array representations, advances signal timestamps, computes `lastSeenAtMs`, and writes the complete JSON state. |
| `src/services/SettingsService.ts:4-30` | Generic persistence wrapper | Uses parameterized raw SQL against `BotSetting`; `set()` is an upsert and changes `BotSetting.updatedAt` on every write. |
| `prisma/schema.prisma:205-212` | Schema owner | `BotSetting` has only `key`, `value`, `createdAt`, and `updatedAt`; there is no state-specific foreign key, version column, or retention metadata. |

The two application call paths to `processPlayer()` are:

- The active polling path: `src/listeners/ready.ts:652-805,857-993` calls `ActivityService.observeClanDetailed()` for tracked clans. That service fetches each player and calls `processPlayer()` at `src/services/ActivityService.ts:185-245`.
- The `/lastseen` fallback path: `src/commands/LastSeen.ts:185-251` fetches a player when no `PlayerActivity` row exists, creates an inferred `PlayerActivity` row, and then calls `processPlayer()`.

The activity scheduler is separate from signal-state persistence: `src/services/ActivityObserveStartupService.ts:21-139` records the `activity_observe_cycle` status, runs startup/delayed/scheduled observations, and skips the poller in mirror mode. `src/listeners/ready.ts:995-1017` uses `activity_observe:last_run_at_ms` for initial-delay calculation. Neither scheduler key is the player signal-state key.

### 2.2 Consumers and downstream effects

| Consumer | Source path | Dependency and consequence |
| --- | --- | --- |
| `PlayerActivity` writer | `src/services/ActivityService.ts:247-296` | Copies counter signal times to `lastDonationAt`, `lastCapitalAt`, `lastTrophyAt`, `lastWarAt`, and `lastBuilderAt`; uses the returned `lastSeenAtMs` to set `PlayerActivity.lastSeenAt`; always updates the current scalar fields and upserts the row. |
| `/lastseen` | `src/commands/LastSeen.ts:185-307` | Reads `PlayerActivity.lastSeenAt` for the headline and signal state `signalTimes` for the detailed breakdown and confidence. Its no-row fallback is also a producer. |
| `/inactive` | `src/commands/Inactive.ts:635-715` | Reads `PlayerActivity.updatedAt` for observation freshness/coverage, then filters by `PlayerActivity.lastSeenAt`. A false signal timestamp can move a member out of the inactive result; a lost freshness update can fail closed with a stale-data message. |
| `/kick-list` | `src/commands/KickList.ts:257-270` | Uses `PlayerActivity.lastSeenAt` as one inactive-candidate input. |
| Clan health inactive-days view | `src/services/ClanHealthSnapshotService.ts:401-410` and `:227-235` | Reads recent `PlayerActivity` rows and counts players whose `lastSeenAt` is before the selected cutoff. |
| `/todo` GAMES freshness | `src/services/TodoService.ts:477-489,928-987` | Bulk-reads linked players' signal-state values; `extractSignalStateFreshnessMsFromState()` contributes GAMES displayed freshness. The state `updatedAtMs` therefore has a freshness contract, not just diagnostic value. |
| Todo snapshot refresh | `src/services/TodoSnapshotService.ts:962-1041,2745-2796` | Reads signal-state values in bulk and extracts `counters.gamesChampion` for `TodoPlayerSnapshot.gamesChampionTotal` and cycle points/baseline derivation. It writes snapshot `lastUpdatedAt` on refresh. |
| `/todo` snapshot/cache | `src/services/TodoSnapshotService.ts:393-473` and `src/services/TodoService.ts:179-227` | Snapshot rows and their `lastUpdatedAt`/`updatedAt` form the snapshot version and render-cache key. GAMES still uses the signal-state freshness candidate described above. |
| Dusk evidence | `src/services/DuskRepWorkRewardEvaluator.ts`, `src/services/DuskRewardReconciliationPreview.ts`, `docs/diagnostics/dusk-reward-evidence.md:13-30` | No direct `player_signal_state` read. The evidence diagnostic explicitly names `RepWorkActivityEvent`, war history/participation/compliance, `WarLookup`, tracked-message evidence, Home/transfer state, and `PlayerLink`. |

`PlayerActivity.lastSeenAt` is the activity timestamp consumed by `/lastseen`, `/inactive`, kick-list, and clan-health reporting. `PlayerActivity.updatedAt` is an observation-coverage timestamp used by `/inactive`; it must not be confused with signal activity. A v2 implementation must preserve both meanings.

## 3. Exact representation diagnosis

### 3.1 Existing normalization contract

The current `stableHashFromArray()` contract is not a normal hash function:

- Non-array or missing input is normalized to `[]`, whose representation is the empty string.
- Each array item is handled as follows: falsy/non-object values use `JSON.stringify(item)`; objects use their own enumerable entries sorted by `key.localeCompare()` and serialized as an array of `[key,value]` pairs.
- Array-item representations are sorted lexicographically.
- Duplicate item representations are retained; no set conversion occurs.
- Nested object/array values are not recursively canonicalized. Only the top-level object keys are sorted.
- The final value is `normalized.join("|")`.

The v2 fingerprint must hash the exact output of that algorithm. Replacing `localeCompare`, recursively sorting nested objects, deduplicating, changing primitive handling, or treating missing arrays differently would be an activity-semantics change, not a storage-only optimization.

### 3.2 Safe local fixture byte accounting

This fixture mirrors the current function locally and is not production data. It contains two items per field except `achievements`, which contains a deliberate duplicate. UTF-8 byte lengths equal character lengths for this fixture.

| Hash field | v1 serialized value bytes | v2 SHA-256 hex value bytes | Value-only reduction |
| --- | ---: | ---: | ---: |
| `achievements` | 154 | 64 | 90 |
| `troops` | 100 | 64 | 36 |
| `heroes` | 79 | 64 | 15 |
| `spells` | 61 | 64 | -3 |
| `pets` | 73 | 64 | 9 |
| `heroEquipment` | 85 | 64 | 21 |
| **Six hash values** | **552** | **384** | **168 (30.4%)** |

Using the same fixture in the full state envelope, compact hashes reduce the JSON text from **1,053 bytes to 797 bytes**, or **256 bytes (24.3%)**. The small-field expansion for `spells` demonstrates why production savings must be measured per field rather than assumed. The fixture is an exact regression oracle for the chosen input, not an extrapolation of production savings.

### 3.3 Operator-approved production measurement proposal

The following is a proposal only. It was not executed by this diagnosis. It returns aggregates and deliberately does not return keys, tags, values, or payload bodies. Run it only in the approved read-only transaction described by `docs/ai-development-workflow.md` and the DBH Part 1 measurement record. If the JSON cast encounters malformed state, stop and record the failure rather than widening access or adding a production function.

```sql
WITH signal_rows AS (
  SELECT
    "value",
    "updatedAt",
    "value"::jsonb AS state
  FROM "BotSetting"
  WHERE "key" LIKE 'player_signal_state:%'
)
SELECT
  count(*) AS rows,
  sum(octet_length("value")) AS full_value_bytes,
  min(octet_length("value")) AS min_full_value_bytes,
  max(octet_length("value")) AS max_full_value_bytes,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY octet_length("value")) AS p50_full_value_bytes,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY octet_length("value")) AS p95_full_value_bytes,
  sum(octet_length(COALESCE(state->'hashes'->>'achievements', ''))) AS achievements_bytes,
  sum(octet_length(COALESCE(state->'hashes'->>'troops', ''))) AS troops_bytes,
  sum(octet_length(COALESCE(state->'hashes'->>'heroes', ''))) AS heroes_bytes,
  sum(octet_length(COALESCE(state->'hashes'->>'spells', ''))) AS spells_bytes,
  sum(octet_length(COALESCE(state->'hashes'->>'pets', ''))) AS pets_bytes,
  sum(octet_length(COALESCE(state->'hashes'->>'heroEquipment', ''))) AS hero_equipment_bytes,
  sum((state->'hashes' ? 'achievements')::int) AS rows_with_achievements,
  sum((state->'hashes' ? 'troops')::int) AS rows_with_troops,
  sum((state->'hashes' ? 'heroes')::int) AS rows_with_heroes,
  sum((state->'hashes' ? 'spells')::int) AS rows_with_spells,
  sum((state->'hashes' ? 'pets')::int) AS rows_with_pets,
  sum((state->'hashes' ? 'heroEquipment')::int) AS rows_with_hero_equipment
FROM signal_rows;
```

For the per-field distribution, repeat the same aggregate shape with `min`, `max`, and `percentile_cont` over each `octet_length(state->'hashes'->>'field')`. The operator should separately report version counts and age buckets using only `count(*)`, `sum`, and date buckets. Production savings are **UNKNOWN** until this field-level result exists; the 43 MB measurement is full logical value text, not a physically recoverable byte count.

## 4. Compact deterministic fingerprint design

### Recommended v2 representation

For each of the six fields:

```text
fingerprint = SHA-256(UTF-8(canonicalLegacyRepresentation(normalizeArray(input))))
stored value = lowercase 64-character hexadecimal digest
```

The canonical representation is the current v1 function extracted without semantic edits. The state version distinguishes v1 serialized representations from v2 digests; no prefix is necessary for v2 values. A fixed-length binary digest would be smaller, but a 64-character hex string avoids JSON/binary transport ambiguity and is already materially smaller than the observed serialized arrays.

The comparison contract is:

- v1 record: compare the incoming canonical legacy representation to the stored v1 `hashes[field]`; persist the unchanged v1 representation.
- v2 record: compare the incoming v2 digest to the stored digest; persist through the unchanged v1 writer contract.
- v1 and v2 compare equal only through the same incoming observation; never compare a v1 representation directly with a v2 digest.
- All counters, `signalTimes`, `lastSeenAtMs`, `tag`, `name`, `clanTag`, and timestamp rules remain unchanged.

SHA-256 introduces the normal cryptographic collision assumption. The implementation must not use a weaker non-cryptographic checksum, because an accidental collision would suppress a real activity signal. The implementation must also retain the canonical function as a pure testable unit so the v1-to-v2 equivalence is directly testable.

## 5. Phase A read compatibility and transition boundary

### Required rollout boundary

Deploy this v2-aware compatibility release before any future release enables v2 writes. Phase A itself keeps the v1 writer active, so it does not create v2 records or convert the existing v1 population. A direct rollback to a v1-only binary is safe for records written by Phase A; it remains **unsafe** if a later release has already written v2 records because the old parser treats v2 as missing.

### Per-observation algorithm

1. Read the state once by the existing key.
2. If it is valid v1, compute the six incoming canonical legacy representations and compare each with the stored v1 representation to produce exactly the v1 `changedSignals` result.
3. If it is valid v2, compute the six v2 digests from the same canonical legacy representations and compare digests. Keep the existing counter, signal-time, last-seen, name/clan, and current timestamp semantics.
4. For either valid version, advance a signal timestamp only for a semantic comparison change. Do not use conversion itself as a signal.
5. Preserve counters exactly for a valid state. In particular, do not rebuild counters from the incoming array; `gamesChampion` is a persisted lifetime counter used by `/todo` GAMES.
6. Persist the complete v1 JSON state for a valid v1/v2 observation while the current freshness contract remains in force. `updatedAtMs` must continue to advance on each successful observation unless a separate lightweight freshness owner is introduced and reviewed.
7. If state is missing or malformed, do not invent `changedSignals`, and baseline from the current observation without advancing `lastSeenAtMs` from malformed state. If a `PlayerActivity` row already exists, do not let the baseline’s `now` overwrite its established `lastSeenAt`; the existing row is evidence that this is not a first-ever observation. A new `PlayerActivity` row may retain the current first-observation behavior of setting `lastSeenAt` to `now`.
8. Never batch-rewrite rows or activate a v2 writer as part of this phase. The v2 parser/comparator is compatibility code; the persisted writer remains v1.

This distinguishes two cases that the current implementation conflates: “no prior state exists for this player” and “a prior state exists but cannot be parsed.” A malformed record cannot recover historical counters or activity times; those fields must be reported as unavailable/UNKNOWN rather than silently claimed to be preserved.

### Compatibility matrix

| Case | Read/compare behavior | Timestamp/counter rule | `/todo` GAMES and rollback result |
| --- | --- | --- | --- |
| v1 record, unchanged observation | Compare incoming canonical v1 representations to stored v1 strings; no hash signal changes; persist v1 | Preserve counters, `signalTimes`, and `lastSeenAtMs`; advance only `updatedAtMs` as current observation freshness | GAMES total/freshness remains equivalent. Rollback to the v1-only release is safe for Phase A writes. |
| v1 record, actual array/counter/name/clan change | Use the existing v1 comparison and counter activity predicates; record the same changed signal(s); persist v1 | Advance only the same signal timestamps current v1 would advance; preserve all other timestamps/counters | GAMES total and activity timestamps are equivalent. |
| Valid v2 record, unchanged observation | Compare v2 digests generated from the unchanged canonical representation; persist through the v1 writer contract | No activity timestamp change; preserve counters and `lastSeenAtMs`; update observation freshness per the current contract | GAMES reads the same lifetime total and a current freshness timestamp. A v1-only rollback remains unsafe for that pre-existing v2 row. |
| Valid v2 record, actual change | Digest differs only when the canonical v1 representation differs, subject to SHA-256 collision resistance; persist through the v1 writer contract | Same changed-signal and counter predicates as v1 | No false activity from format comparison; v2-aware rollback is required while v2 rows exist. |
| Missing state | Treat as a first observation for the signal store, with no changed signal; initialize current counters and v1 representations | For a new `PlayerActivity`, first-observation `lastSeenAt=now` is retained. For an existing `PlayerActivity`, do not reset `lastSeenAt` from missing signal state | GAMES lifetime is current-input-only and historical continuity is UNKNOWN. Do not delete the player’s snapshot or historical rows. |
| Malformed/unparseable state | Same no-synthetic-signal baseline as missing state; emit bounded diagnostics and preserve the existing `PlayerActivity` timestamp when present | No recoverable v1 counters/timestamps are silently claimed; current input may initialize the new signal record | GAMES historical total/freshness is UNKNOWN until a valid observation; snapshot refresh must not turn parse failure into activity. |
| First observation with no prior `PlayerActivity` | Initialize state with v1 representations; no signal changes | `lastSeenAt=now` follows current first-observation behavior | Snapshot/GAMES may show a baseline observation, not an inferred historical activity event. |
| Unchanged observation | Semantic activity is unchanged even though the current code writes `updatedAtMs` and `BotSetting.updatedAt` | Do not advance `lastSeenAt` or any signal time; preserve `PlayerActivity.updatedAt` observation-coverage behavior | Under the current consumer contract, skipping the state write would make GAMES freshness stale because it reads state `updatedAtMs`; a full skip is not safe without a reviewed freshness redesign. |
| Actual changes | Apply existing field-by-field predicates and array comparison semantics | Do not change counter direction rules or timestamp maxima | `/lastseen`, `/inactive`, snapshots, and GAMES remain behaviorally equivalent. |
| Process restart | Recompute canonical representation/digest from the live payload; no in-memory state is required | Persisted v1/v2 state remains the source of comparison and counters | Deterministic across restarts when the same runtime normalization is used. |
| Older v1-only code rollback | Phase A writes only v1, so rows written by this slice remain readable. Any pre-existing v2 row is rejected and treated as missing | For a pre-existing v2 row, it can seed `lastSeenAt=now` and write v1, causing false freshness/activity | **Safe only for Phase A-created state.** Use the v2-aware release whenever v2 rows may exist. |
| `/todo` `GAMES` | Read both versions; extract `counters.gamesChampion` independently of hash format; derive freshness from the valid state | No hash conversion changes the lifetime counter or cycle baseline | Test active earning, reward-collection, off-cycle lifetime totals, stale freshness, missing state, and malformed state. |

### Unchanged-write evaluation

Skipping the `BotSetting` value write for an unchanged observation is **not semantically safe in the current design**, even though it would reduce write amplification. `TodoService` uses `extractSignalStateFreshnessMsFromState()` and includes `updatedAtMs` in GAMES freshness (`src/services/TodoService.ts:107-118,928-987`). Leaving the old `updatedAtMs` would make live observations look stale. The scheduler’s cadence and `activity_observe:last_run_at_ms` would continue to operate, but the user-facing GAMES freshness contract would change.

A future write-reduction slice can be safe only if it explicitly chooses one of these reviewed contracts:

- keep a small, separately owned observation-freshness write while skipping the large state-value rewrite; or
- move the GAMES freshness source to an already-updated, player-scoped observation owner and prove that guild scope, linked-account scope, startup/restart behavior, and stale-data fail-closed behavior remain equivalent.

That is a separate payload/freshness design decision. It is not implied by compacting hashes.

## 6. Stale-record ownership and historical references

### Current ownership

The signal key is global by player tag, while several consumers are guild-scoped. Current references that may make a row operationally relevant include:

- `TrackedClan` observations (`src/listeners/ready.ts:689-805`) and current player data maintained by `PlayerCurrent`, `FwaPlayerCatalog`, `FwaClanMemberCurrent`, and `FwaWarMemberCurrent`.
- Current `PlayerLink` rows and linked-account todo usage. `/todo` reads only linked tags but the key itself has no link foreign key.
- `PlayerActivity` rows keyed by `(guildId, tag)`, including `/lastseen`, `/inactive`, kick-list, and clan-health coverage.
- `TodoPlayerSnapshot` keyed by player tag, plus active todo usage, reminders, roster signups, raid/filler/deferment state, and current war/CWL read models that independently reference the same tag.
- Current and historical operational evidence in `AllianceClanMembershipInterval`, `ClanHomeMembershipPeriod`, `ClanHomeTransferCandidate`, sync snapshots, war participation/history/compliance/violations, CWL history/rotation rows, raid and blacklist evidence, and Dusk rep-work evidence. These tables do not directly read `player_signal_state`, but a shared tag is not evidence that either side is safe to remove.

The Prisma schema confirms many historical/current `playerTag` owners, including `PlayerLink`, `PlayerCurrent`, `TodoPlayerSnapshot`, membership intervals/home periods, CWL current/history/rotation rows, war attacks/participation/violations, FWA catalogs/current rosters, reminders, signups, and operational task rows (`prisma/schema.prisma` entries around lines 232-250, 315-429, 850-1147, 893-947, 1599-1774, 1889-2040, and 2173-2300).

### Retention conclusion

The 30/90/180-day buckets are **not deletion candidates**. `BotSetting.updatedAt` records the last write, not last read; the key has no ownership metadata; the state is global by tag; and stale rows can still be referenced by a current link, tracked roster, todo snapshot, or future `/lastseen` lookup. Historical Dusk evidence does not directly depend on the signal row, but deleting the row can change future activity baselines and GAMES lifetime continuity.

Safe retention work would require an aggregate-only reference report that classifies each stale key as current tracked, currently linked, active-todo/snapshot referenced, present in current/historical operational evidence, or unreferenced across all approved ownership surfaces. Any “unreferenced” result remains a review candidate, not deletion authorization. No deletion or archival proposal is made here.

Payload optimization and retention cleanup are separate workstreams:

- **Payload optimization:** compact six fingerprints, preserve semantics, and reduce future value/WAL/TOAST pressure without removing rows.
- **Retention cleanup:** decide whether old global keys have an owner or recovery purpose, with approved backup/recovery, dry-run counts, rollback, and explicit production authorization. Age alone is insufficient.

## 7. Minimal implementation sequence

1. Add pure, directly tested helpers for the unchanged v1 canonical representation and the v2 SHA-256 digest. Do not alter normalization or object/array ordering.
2. Add a version-tolerant parser with strict shape checks for valid v1/v2 state. Never rebuild valid counters from the live array payload.
3. Compare v1 states using the legacy representation and v2 states using the digest, while keeping the persisted writer on v1.
4. Add explicit malformed/missing-state handling so an existing `PlayerActivity.lastSeenAt` cannot be reset merely because a signal record is unavailable. Keep first-observation behavior only when no downstream activity row exists.
5. Validate read parity, `/lastseen`, `/inactive` coverage, `/todo` GAMES freshness, snapshots, and rollback assumptions before any separate v2-writer slice.
6. Measure version distribution and field byte aggregates after a representative observation window. Review value size, WAL/dead-tuple/autovacuum indicators, and activity parity before considering additional write-reduction design.
7. Handle retention as a later, separate diagnostic/approval. Do not combine it with payload optimization or use compacting as a reason to delete stale rows.

No Prisma schema change is required for the recommended first payload slice. A future separate freshness-owner design may require a schema or ownership change and must be reviewed as a different PR.

## 8. Rollback and recovery

- Phase A rollback: revert to the existing v1-only writer; Phase A has not produced v2 records or run a v1-to-v2 conversion.
- After a future v2-writer release: roll back only to this v2-aware compatibility release, which must continue reading v2 and must not treat it as missing. It may keep v2 rows read-compatible while v2 writing is disabled.
- A direct v1-only rollback is prohibited after v2 writes unless an explicitly reviewed compatibility shadow/restore procedure exists. Code rollback alone cannot restore database values or undo a migration.
- If malformed records or parity regressions appear, stop new v2 writes, keep the records read-only for diagnosis, and compare aggregate version/conversion/error counts. Do not mass-rewrite or delete state as an emergency fix.
- Any production data restore or cleanup requires the backup/recovery gates in `docs/ai-development-workflow.md` and `docs/roadmaps/production-backup-readiness.md`. This diagnosis does not authorize those operations.

## 9. Targeted regression test plan

The Phase A implementation adds focused helper, parser, v1/v2 parity, counter-predicate, malformed-state, freshness, and GAMES extraction tests. Downstream command/snapshot suites remain the regression gate for `/lastseen`, `/inactive`, `/todo` GAMES, and snapshot freshness.

### Exact activity equivalence

- Compare v1 and v2 for every one of the six fields with identical input.
- Permute array order and object property insertion order; confirm the result matches current v1 semantics.
- Preserve duplicate items; confirm removing or adding one duplicate is a change.
- Cover missing/non-array fields, empty arrays, `null`, booleans, numbers, strings, and object items with nested values.
- Cover counter predicates: increasing/decreasing donation/capital/war/game counters, any trophy/builder-trophy difference, name change, clan change, and simultaneous changes.
- Verify a v1-to-v2 conversion produces no changed signal when the live payload matches the stored v1 representation.
- Verify an actual payload change produces the same changed signal list and timestamp updates under v1 and v2.

### Timestamp and state safety

- Preserve `signalTimes`, `lastSeenAtMs`, all counters including `gamesChampion`, and the maximum timestamp across conversion.
- Missing state with no `PlayerActivity` initializes once; missing/malformed state with an existing `PlayerActivity` does not advance or reset `lastSeenAt`.
- Malformed JSON, wrong version, missing `hashes`, and malformed counter fields fail closed with bounded diagnostics and no synthetic signal.
- Process the same player after a service restart and confirm deterministic comparison.
- Confirm `PlayerActivity.updatedAt` still represents observation coverage for `/inactive`, while `lastSeenAt` changes only on the existing activity rules.

### Snapshot freshness and `/todo` GAMES

- Active Clan Games: preserve `gamesChampionTotal`, baseline, cycle key, points, and target for v1 and v2.
- Reward-collection and off-cycle views: preserve lifetime totals and phase messaging.
- Unchanged observation: verify the GAMES freshness timestamp remains current under the selected write contract; a test that merely checks the compact hash is insufficient.
- Missing/malformed signal state: show UNKNOWN/stale-safe behavior rather than inventing a lifetime total or activity event.
- Confirm `TodoPlayerSnapshot.lastUpdatedAt`, render-cache versioning, and background observe refresh behavior remain unchanged.

## 10. Savings estimate and limitations

| Item | Status |
| --- | --- |
| Current production logical values | Observed: ~43 MB across 1,941 rows; max row ~26 kB; physical `BotSetting` footprint ~32 MB with TOAST, so logical bytes must not be treated as recoverable disk bytes. |
| Local compact-fingerprint fixture | Exact: hash-value reduction 168/552 bytes (30.4%); full-state reduction 256/1,053 bytes (24.3%). |
| Production per-field contribution | UNKNOWN until the aggregate-only field query is approved and run. |
| Production disk/WAL/dead-tuple reduction | UNKNOWN until after an implementation is measured under representative observations. |
| Stale-row deletion/archival opportunity | UNKNOWN; no deletion candidate established. |
| Dusk reward-evidence impact | No direct dependency found; activity/GAMES behavior still matters to member-facing state and must remain correct. |

Limitations: the production record reports uncompressed logical text and write age, not WAL volume, TOAST compression ratio, dead tuples, vacuum lag, update frequency, or field-by-field bytes. The local fixture cannot represent every CoC payload shape. SHA-256 collision probability is treated as negligible but is not mathematical identity. Historical ownership and external consumers of generic `BotSetting` are not proven by repository search alone.

## 11. Diagnosis acceptance checklist

- [x] Every repository-visible producer/consumer of `player_signal_state` is mapped.
- [x] Downstream `PlayerActivity` timestamps, `/lastseen`, `/inactive`, kick-list, clan-health, `/todo`, snapshots, and Dusk evidence dependencies are mapped.
- [x] Exact local fixture byte contributions are recorded; an aggregate-only production SELECT proposal is included for separate approval.
- [x] Current normalization, ordering, duplicates, comparison predicates, and missing-value behavior are specified for preservation.
- [x] v1/v2 lazy conversion, malformed state, timestamp/counter safety, and older-code rollback boundaries are explicit.
- [x] Unchanged-write safety and GAMES freshness implications are evaluated.
- [x] Stale-record ownership and historical references are separate from payload optimization; insufficient evidence remains UNKNOWN.
- [x] Minimal implementation sequence, rollback, savings, limitations, and targeted regression tests are documented.
- [x] Phase A application changes keep the v1 persisted writer and do not add schema, migration, production data, deletion, deployment, or reward/currency behavior.
