# Dusk Reward Evidence Diagnostic

> **M0a, part 1 — documentation and investigation only**  
> **Status:** Complete for the repository trace; historical sample not run  
> **Date:** 2026-11-12

## Scope and conclusion

This audit traces the proposed Duskits activities from their existing producer/service through Prisma persistence, identity, timestamps, deduplication, attribution, correction behavior, and freshness. It does not add currency functionality, query production data, poll any upstream API, or write any database rows.

The safest evidence available today is:

1. `RepWorkActivityEvent` rows for narrowly filtered, event-backed FWA rep work. They carry the acting Discord user, event time, source message, war context when available, and a database-enforced unique `dedupeKey`.
2. Clean ended FWA participation, but only as a conservative simulation cohort: canonical `ClanWarHistory` + complete `ClanWarParticipation` + `WarPlanComplianceEvaluation.status=COMPLETED` + zero player violations + an attribution gate. This is usable for analysis, not an authorization to issue rewards.

Blacklist triples, base-swap acknowledgments, recurring rep stipends, and transfer rewards need additional evidence rules or historical owners before they should be earning activities. Missing evidence is `UNKNOWN`; it is never treated as a completed action.

## Verdicts

The verdict below is for the complete reward eligibility path, not merely whether some related row exists. `VERIFIED` means the event itself is durable and attributable under the stated query filters. `PARTIAL` means useful evidence exists but a material proof or historical/attribution gap remains. `UNSUPPORTED` means no safe existing evidence path exists for the proposed claim.

| Candidate activity | Authoritative source model/service | Available evidence and identity keys | Event-level deduplication | Attribution rule | Time, completeness, correction, freshness | Eligibility verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Verified Blacklist war triple** | `ClanWarHistory` for ended war identity/type; `WarLookup` for archived attack detail; `WarAttacks` only while current | Ended history has integer `warId`, canonical `(warStartTime, clanTag, opponentTag)` uniqueness, `matchType=BL`, result/times, and player-independent summary. Archived attack detail is JSON in `WarLookup.payload`; `WarLookup.warId` is the string archive key. Current attack rows have `(warId, playerTag, attackNumber)` and `(clanTag, warStartTime, playerTag, attackOrder)` keys, but are deleted after archival. | No dedicated historical triple event. `WarLookup` has one row per archived war, not one row per player attack. `WarAttacks` keys dedupe current observations only. | Resolve `playerTag` from the archived attack detail, then join the current `PlayerLink` row. Require a non-revoked, accepted trust tier; do not infer ownership from player name. A link created or verified after the war is not proof of ownership at the event time. | `attackSeenAt` exists in current rows and is copied into archived payloads when available, but the archive payload shape/completeness must be validated. A war correction can update `ClanWarHistory` and archive payload. No durable per-attack correction/reversal identity exists. | **PARTIAL** — attack proof can be reconstructed only if the archive contains the exact player attack and a strict JSON extractor succeeds. Historical Discord ownership is not versioned. |
| **Clean FWA war participation** | `ClanWarHistory`, `ClanWarParticipation`, `WarPlanComplianceEvaluation`, `WarPlanViolation`; `WarPlanViolationService` | Ended history identifies the FWA war. Participation is the canonical complete own-clan roster, one row per `(guildId, warId, playerTag)`, including zero attacks, with `attacksUsed`, `attacksMissed`, `starsEarned`, `trueStars`, `firstAttackAt`, and `warStartTime`. | Participation: `@@unique([guildId, warId, playerTag])`. Evaluation: `@@unique([guildId, warId])`. Violation: `@@unique([evaluationId, playerTag])`. | Join `ClanWarParticipation.playerTag` to the current `PlayerLink`, then apply a conservative no-backpay rule (for example, link existed by the event timestamp and is not revoked now). Because `PlayerLink` has no ownership history, later link changes remain an attribution uncertainty. | Require `h.matchType=FWA`, a non-empty canonical participation row, and `e.status=COMPLETED` with `completedAt` non-null. Missing/PENDING/INSUFFICIENT_DATA/FAILED/SKIPPED evaluation is `UNKNOWN`, not clean. Re-finalization clears/recreates violations after canonical history changes; non-FWA correction terminalizes the evaluation. | **PARTIAL** — the war/player cleanliness proof is strong when complete, but historical Discord attribution and the exact product definition of “qualifying participation” still need a simulation policy. |
| **Base-swap acknowledgment** | `TrackedMessageService` and `TrackedMessage` with `featureType=FWA_BASE_SWAP`; existing FWA base-swap reaction listener | JSON metadata contains `entries[]` with `playerTag`, `discordUserId`, section, and `acknowledged`; message metadata also carries `createdAtIso`, optional `syncMessageId`, `warId`, `warStartTimeIso`, `opponentTag`, and `expiresAt`. Reaction handling marks the matching linked entry acknowledged and completes the message when all linked entries are acknowledged. | No per-ack row or per-entry event key. `TrackedMessage.messageId` is unique; split posts share `referenceId`. `TrackedMessageClaim` is for separate reminder claims, not acknowledgments. | Use the `entries[].discordUserId` captured in the tracked post, not a later player-name lookup. Acknowledgment is attributed to the listed Discord user, but the metadata does not retain who reacted or when. | `createdAt`/`updatedAt` are message-level only. The entry boolean is mutable JSON; later edits/replacement can overwrite historical state. `ACTIVE`/`COMPLETED` rows can be read while unexpired, but expired/replaced history is not an append-only acknowledgment log. `phaseTimingLine` describes war/preparation end, not a swap event. | **PARTIAL** — it proves a persisted acknowledgment snapshot, not an independently timed or verified in-game base change. |
| **Early base swap** | No existing authoritative owner; closest evidence is `TrackedMessage` metadata and base-swap rendering | A post may contain `createdAtIso`, `warStartTimeIso`, `phaseTimingLine`, and current acknowledgment booleans. These do not record the actual CoC layout change, a per-entry acknowledgment timestamp, or a before/after layout identity. | None for the claimed action. | No safe actor/time join beyond the static `discordUserId` embedded in the announcement entry. | `RepWorkActivityEvent` from base-swap publication records the command actor and event time, not the player’s actual swap. Prep time is computed from publication time/war start and cannot prove an early layout change. | **UNSUPPORTED** — do not pay an early-swap bonus from a post, reaction, reminder, or missing record. |
| **Attributable FWA rep action** (`BASES_CHECKED`, `MAIL_CHECKED`, `MAIL_SENT`) | `RepWorkActivityService` → `RepWorkActivityEvent`; report consumer is `RepWorkReportService` | Event row stores `guildId`, `activityType`, `discordUserId`, `clanTag`, optional `syncMessageId`, source message/tracked-message IDs, optional `warId`, `warStartTime`, opponent, `eventAt`, prep-time estimate, metadata, and `createdAt`. Existing callers record FWA base/checklist/mail actions at the user interaction or send boundary. | Database `dedupeKey` is unique and is built from activity type, guild, user, clan, and `sync:<syncMessageId>` or `source:<sourceMessageId>`. Repeated create races are treated as an idempotent success. The report additionally de-duplicates average-prep samples by `(user, activityType, COALESCE(syncMessageId, sourceMessageId, id))`; counts are the persisted event rows. | Direct `discordUserId` is captured at event time. Filter to known FWA sources/metadata and tracked clan scope; do not use a later PlayerLink join as the primary attribution. | `eventAt` is the activity timestamp; `createdAt` is persistence time. There is no correction/reversal state and no source-event update path. A missing war/sync identity is allowed by the writer and must remain `UNKNOWN` for any war-specific rule. | **VERIFIED** for a narrowly defined event-level action reward after source filtering and per-user caps. This does **not** verify that the user was historically assigned a rep account. |
| **Active rep weekly stipend / recurring rep eligibility** | `TrackedClanRep` + `PlayerLink` for current assignment; `RepWorkActivityEvent` for activity | `TrackedClanRep` is a current `(clanTag, playerTag)` assignment only. `RepWorkActivityEvent` supplies historical work counts. `hasTrackedClanRepAssignmentForDiscordUserId` resolves current assignments through `PlayerLink`. | Rep work is deduped as above; rep assignment has composite PK `[clanTag, playerTag]` but no assignment `createdAt`, `endedAt`, or history. | A current linked rep account cannot prove that the user held the rep role when older events occurred. `PlayerLink` can consolidate multiple accounts to one Discord user, but cannot establish historical role tenure. | No existing threshold, weekly eligibility row, period claim, or correction/reversal owner. `RepWorkReportService` is reporting only and does not define an earning rule. | **UNSUPPORTED** for automatic stipend eligibility. Use event counts only as inputs to a future explicit policy and historical-role design. |
| **Beneficial transfer confirmed** | `ClanHomeMembershipService`, `ClanHomeTransferCandidate`, `ClanHomeMembershipPeriod`; current read model `HomeRosterService` | Candidate records `fromClanTag`, `toClanTag`, three-boundary `startedAtSyncTime`/`qualifiedAtSyncTime`, status, decision actor/time. Automatic candidate creation requires three ordinary exact `SYNC_SNAPSHOT` boundaries in a different tracked clan and suppresses CWL/unknown timing. Confirmation transactionally ends the old Home period and creates a `TRANSFER` successor. | Candidate uniqueness is `[homeMembershipPeriodId, toClanTag, startedAtSyncTime, qualifiedAtSyncTime]`; active Home is queried by `endedAtSyncTime=null`. This dedupes candidate/decision state, not a physical roster move event. | Player identity is `playerTag`; Discord attribution requires a non-revoked `PlayerLink` at the reward boundary. Decision actor is a leader/admin and is not the moved member’s proof of consent. | Home candidate evidence is observation-bound and exact at sync boundaries, not a join/leave timestamp. `HomeRosterService` can show `PRESENT`, `AWAY`, or `UNKNOWN` only when CLAN_MEMBERS feed coverage is current; stale/unavailable coverage is `UNKNOWN`. Confirmation currently revalidates Home/candidate scope, not fresh destination membership inside the transaction. | **PARTIAL** — leader-confirmed Home transfer state is durable, but “actual roster move” and consent are not independently owned by a transfer-completion event. |
| **Continued destination membership after 14 days** | `AllianceClanMembershipInterval`, `SyncClanMemberSnapshot`, `FwaClanMemberCurrent`, `PlayerCurrent`, Home period/candidate history | Intervals provide observed positive residence with `firstObservedAt`, `lastObservedAt`, optional `endedAt`; sync snapshots provide immutable boundary rows; current feed/player rows provide latest state. | Intervals have no unique event identity beyond generated `id`; snapshots are unique by `[guildId, syncTime, clanTag, playerTag]`; current rows are one current snapshot per tag/clan. | Join by `playerTag` and the confirmed candidate/destination clan. Link changes and unlinked accounts remain attribution `UNKNOWN`. | Interval times have observation-cadence precision, not exact move time. A `CONFIRMED` Home period is not, by itself, proof of physical destination residence. Fresh current evidence can establish present location, but a 14-day historical claim needs bounded observations covering the entire required window. | **PARTIAL** — potentially simulatable as observed residence, but not a safe reward event until the transfer completion/continuation rule and coverage threshold are fixed. |

## Detailed findings and failure cases

### War identity and historical completeness

- `ClanWarHistory.warId` is the canonical ended-war integer primary key and is unique by `(warStartTime, clanTag, opponentTag)`. `ClanWarParticipation.warId` is a string foreign-key-like value with uniqueness scoped by guild/player; historical joins must use `p.warId = CAST(h.warId AS text)` in SQL or the equivalent normalized application join.
- `WarAttacks` is current-war operational detail. The normal history path snapshots participation and then deletes `WarAttacks` and `CurrentWar` for the ended `warId`. A simulation that reads `WarAttacks` for old wars will silently undercount or produce a false UNKNOWN.
- `WarLookup` is archived/raw evidence. Its `teamSize` metadata is diagnostic only; participation completeness comes from the canonical ended roster, not an inferred archive team size. Missing or malformed archived participants are UNKNOWN, not zero.
- `ClanWarParticipation` is complete only when the canonical war-end path or an all-or-nothing repair produced a valid non-empty roster. A row for one player proves that player’s row exists; it does not prove the entire war roster is complete unless the per-war coverage check also passes.

### Compliance and correction behavior

- A clean FWA result requires a completed evaluation. The evaluation row is created/enrolled for FWA history, finalized by `WarPlanViolationService`, and stores `completedAt`, engine/rule version fields, and the current violation set.
- `status != COMPLETED`, `completedAt IS NULL`, an absent evaluation, or a failed/insufficient evaluation is `UNKNOWN`. It is not equivalent to zero violations.
- Canonical history changes reset a completed evaluation to `PENDING` and delete old violations before re-finalization. If a war changes away from FWA, the evaluation is terminalized as `SKIPPED` and violations are deleted. A future ledger would need a source fingerprint and compensating reversal policy; this diagnostic does not add one.
- “Qualifying participation” is not one existing boolean. The simulation should report at least: roster presence; `attacksUsed > 0`; `attacksMissed = 0`; and zero player violations. Product policy must choose which combination is eligible.

### Base-swap evidence is acknowledgment state, not gameplay proof

- `TrackedMessage.metadata.entries[].acknowledged` is the durable state used by the reaction listener. It is not an append-only event and has no acknowledgment timestamp, reaction ID, or actor field separate from the entry’s pre-populated `discordUserId`.
- Split posts share a `referenceId`, and the handler updates related active rows. This is useful for consistent rendering but means a simulation should collapse split rows by `referenceId`/entry identity and avoid counting two posts twice.
- `RepWorkActivityEvent(metadata.source="base_swap")` records the person who published the announcement, not each recipient who acknowledged or changed a base. It is not evidence of an early swap.
- `phaseTimingLine`, `warStartTimeIso`, and `createdAtIso` allow a diagnostic comparison of post timing to war context, but not proof that a layout was changed before a deadline.

### Rep work and recurring eligibility

- The event writer accepts a normalized Discord user, clan, source message, optional tracked message, optional war identity, and event time. Invalid core IDs fail closed. Unique-key races return success without duplicating the row.
- Existing sources include base-swap publication, Bases checklist acknowledgment, Mail checklist acknowledgment, and in-game mail send. The simulation must filter `activityType` and metadata/source so CWL or non-FWA events do not enter an FWA earning bucket.
- `TrackedClanRep` has no temporal history. Removing/reassigning a rep deletes or changes current assignment state, so current assignment cannot prove historical eligibility. A recurring stipend must not be backfilled from report counts alone.
- The report’s prep-time average is a diagnostic metric. It is not an eligibility proof and must not be confused with the event timestamp.

### PlayerLink attribution, verification, and multi-account ownership

- `PlayerLink.playerTag` is the identity key. A tag can be linked to only one Discord user at a time; a Discord user can own many tags. This is the existing one-person/multi-account consolidation path.
- `/link create` refuses implicit reassignment and requires delete-first for a tag owned by another user. Deletion removes the durable link row, so historical ownership is not reconstructable from `PlayerLink` alone.
- Token verification requires the Clash API token to return the same normalized tag, then writes `VERIFIED`, `PLAYER_API_TOKEN`, `verifiedAt`, `lastVerifiedAt`, and verifier ID. Imports/admin/legacy links have separate trust semantics; `REVOKED` is fail-closed.
- A current `PlayerLink` row is not a historical ownership interval. For no-backpay simulation, require a link/accepted trust state with a conservative event-time gate; otherwise return `UNKNOWN`. Do not infer identity from `playerName`, `discordUsername`, or current clan roster.
- Multiple linked accounts should aggregate to one Discord user only after each tag independently passes the same trust/ownership gate. No player-to-player Duskits transfer is supported by current evidence.

### Alliance transfer verification and Home Clan constraints

- `SyncClanMemberSnapshot` is the evidence axis for Home establishment and automatic transfer candidates, not a fresh physical observation at the scheduled second. `SyncClanReadinessSnapshot` supplies immutable filler-at-boundary facts; missing filler capture makes Home qualification UNKNOWN.
- Automatic Home establishment requires three consecutive exact non-filler snapshots in one currently tracked permanent clan. Fallback participation, alliance intervals, and CWL boundaries cannot establish Home.
- Transfer candidates require three consecutive ordinary exact boundaries in a different tracked clan. CWL or unresolved timing suppresses candidate creation. A pending candidate does not change Home.
- `confirmHomeTransferCandidate` transactionally validates guild/candidate/source Home scope, marks the candidate `CONFIRMED`, ends the old Home period, and creates a `TRANSFER` Home period. It does not itself prove that the player is physically present in the destination at confirmation time.
- `HomeRosterService` reads the current FWA clan roster and classifies coverage from `FwaFeedSyncState.lastSuccessAt` using the configured cadence budget. `STALE`/`UNAVAILABLE` coverage yields `UNKNOWN`; only current coverage can yield `PRESENT`/`AWAY`. Away destination enrichment additionally requires fresh authoritative non-contradictory `PlayerCurrent` evidence.
- `AllianceClanMembershipInterval` is observation-cadence history. `firstObservedAt`/`lastObservedAt` are positive observations, not exact transfer instants. It can support a bounded residence analysis, but cannot independently prove the exact move or consent.

## Read-only query designs for M0a part 2

These are designs for a later historical simulation. They are intentionally read-only and should run against a bounded date range, one guild at a time, with no Prisma writes or upstream calls. Any row that fails a required condition must be returned with an explicit `UNKNOWN` reason.

### 1. War and participation coverage inventory

```sql
SELECT
  h."warId",
  h."warStartTime",
  h."warEndTime",
  h."clanTag",
  h."opponentTag",
  h."matchType",
  COUNT(DISTINCT p."id") AS participation_rows,
  e."status" AS evaluation_status,
  e."completedAt",
  COUNT(DISTINCT v."id") AS violation_rows
FROM "ClanWarHistory" h
LEFT JOIN "ClanWarParticipation" p
  ON p."guildId" = :guild_id
 AND p."warId" = h."warId"::text
LEFT JOIN "WarPlanComplianceEvaluation" e
  ON e."guildId" = :guild_id
 AND e."warId" = h."warId"
LEFT JOIN "WarPlanViolation" v
  ON v."evaluationId" = e."id"
WHERE h."warEndTime" >= :from_time
  AND h."warEndTime" < :to_time
GROUP BY h."warId", e."status", e."completedAt"
ORDER BY h."warEndTime", h."warId";
```

Interpretation: count each distinct participation/violation row (the two independent one-to-many joins otherwise multiply both totals). A non-empty participation count is not by itself COMPLETE. Join a separate per-war canonical roster coverage check, and emit `UNKNOWN(canonical_roster_incomplete)` when the full roster cannot be proven.

### 2. Clean FWA cohort with explicit UNKNOWN states

Use the inventory above plus a per-player query:

```sql
SELECT
  p."guildId", p."warId", p."clanTag", p."playerTag",
  p."warStartTime", p."warEndTime", p."attacksUsed", p."attacksMissed",
  h."matchType" AS history_match_type,
  e."status" AS evaluation_status, e."completedAt",
  COUNT(v."id") AS player_violation_count,
  l."discordUserId", l."verificationStatus", l."verificationMethod",
  l."createdAt" AS link_created_at, l."verifiedAt", l."lastVerifiedAt"
FROM "ClanWarParticipation" p
JOIN "ClanWarHistory" h ON p."warId" = h."warId"::text
  AND p."clanTag" = h."clanTag"
  AND p."warStartTime" = h."warStartTime"
LEFT JOIN "WarPlanComplianceEvaluation" e
  ON e."guildId" = p."guildId" AND e."warId" = h."warId"
LEFT JOIN "WarPlanViolation" v
  ON v."evaluationId" = e."id" AND v."playerTag" = p."playerTag"
LEFT JOIN "PlayerLink" l ON l."playerTag" = p."playerTag"
WHERE p."guildId" = :guild_id
  AND p."warEndTime" >= :from_time
  AND p."warEndTime" < :to_time
  AND h."matchType" = 'FWA'
GROUP BY p."id", h."warId", e."status", e."completedAt", l."playerTag";
```

The simulation layer, not SQL null behavior, must classify:

- `VERIFIED`: complete war roster; FWA history; participation policy passes; completed evaluation; zero player violations; accepted link passes the chosen event-time gate.
- `UNKNOWN`: missing/unfinished evaluation, incomplete roster, conflicting history identity, missing/revoked/late attribution, or missing required timestamps.
- `INELIGIBLE`: verified evidence exists but the player missed the policy threshold or has a violation.

### 3. Blacklist archive extraction design

First read only the bounded archive rows:

```sql
SELECT h."warId", h."warStartTime", h."warEndTime", h."clanTag", h."opponentTag",
       w."warId" AS lookup_war_id, w."payload"
FROM "ClanWarHistory" h
LEFT JOIN "WarLookup" w ON w."warId" = h."warId"::text
WHERE h."matchType" = 'BL'
  AND h."warEndTime" >= :from_time
  AND h."warEndTime" < :to_time;
```

The application extractor must then validate the actual payload shape and require an exact attack object with normalized `attackerTag`, attack identity/order, `stars=3` (and the repository’s chosen `trueStars` rule), exact war/clan identity, and a valid event timestamp. If `WarLookup` is absent, malformed, or contains only aggregate scores, return `UNKNOWN(attack_detail_unavailable)`; never substitute `ClanWarParticipation.starsEarned` for a single triple.

### 4. Rep-work weekly aggregation

```sql
SELECT
  DATE_TRUNC('week', "eventAt") AS week_start,
  "discordUserId",
  "activityType",
  COUNT(*)::int AS event_rows,
  COUNT(DISTINCT "dedupeKey")::int AS unique_events,
  COUNT(*) FILTER (WHERE "warId" IS NOT NULL)::int AS rows_with_war_id,
  COUNT(*) FILTER (WHERE "syncMessageId" IS NOT NULL)::int AS rows_with_sync_id,
  MIN("eventAt") AS first_event_at,
  MAX("eventAt") AS last_event_at
FROM "RepWorkActivityEvent"
WHERE "guildId" = :guild_id
  AND "eventAt" >= :from_time
  AND "eventAt" < :to_time
  AND "activityType" IN ('BASES_CHECKED', 'MAIL_CHECKED', 'MAIL_SENT')
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
```

Before counting, filter metadata/source to FWA-only origins and exclude rows whose source context is CWL, unknown, or contradictory. `event_rows` and `unique_events` should agree because `dedupeKey` is unique; any disagreement is a data-quality blocker. Do not join to current `TrackedClanRep` to manufacture historical rep eligibility.

### 5. Base-swap acknowledgement diagnostic

```sql
SELECT
  id, "guildId", "clanTag", "referenceId", "messageId", status,
  "createdAt", "updatedAt", "expiresAt", metadata
FROM "TrackedMessage"
WHERE "guildId" = :guild_id
  AND "featureType" = 'FWA_BASE_SWAP'
  AND "createdAt" < :to_time
  AND COALESCE("expiresAt", :to_time) >= :from_time
ORDER BY "createdAt", id;
```

Parse `metadata.entries[]`, collapse split rows by `referenceId` and entry/player identity, and report `acknowledged_observed=true|false`. Report `acknowledgment_time=UNKNOWN`; `updatedAt` is not a per-entry timestamp. Do not classify `acknowledged=true` as a verified layout change or early swap.

### 6. Transfer and Home safety read model

Read candidates, Home periods, intervals, current roster rows, feed freshness, and authoritative player-current rows in separate bounded queries, then combine in memory:

```sql
SELECT c.*, h."startedAtSyncTime", h."qualifiedAtSyncTime",
       h."endedAtSyncTime", h."establishmentSource"
FROM "ClanHomeTransferCandidate" c
JOIN "ClanHomeMembershipPeriod" h
  ON h."id" = c."homeMembershipPeriodId"
WHERE c."guildId" = :guild_id
  AND c."status" = 'CONFIRMED'
  AND c."decidedAt" >= :from_time
  AND c."decidedAt" < :to_time;

SELECT "playerTag", "clanTag", "firstObservedAt", "lastObservedAt", "endedAt"
FROM "AllianceClanMembershipInterval"
WHERE "guildId" = :guild_id
  AND "playerTag" = ANY(:player_tags)
ORDER BY "playerTag", "firstObservedAt";
```

For each candidate, require destination observations after the decision and enough bounded coverage to satisfy the selected 14-day rule. `FwaFeedSyncState.lastSuccessAt`/`FwaClanMemberCurrent.sourceSyncedAt` must be fresh for present-tense evidence; stale or missing coverage is `UNKNOWN`. A `CONFIRMED` Home period without destination physical evidence is `UNKNOWN(leader_decision_only)`.

## M0a part 2 plan: bounded weekly earnings simulation

1. Choose a bounded lookback (for example, 8–12 complete UTC weeks) and one or more guilds; record the exact time window and data snapshot time. Do not query outside the selected window except for the minimum identity/correction context.
2. Build an evidence coverage report first: canonical ended wars, complete participation rosters, completed evaluations, archive attack-detail availability, rep-event source coverage, tracked-message metadata survivability, PlayerLink timing/trust, and Home/transfer observation freshness.
3. Simulate two modes without writing: a strict mode that rejects late/missing historical attribution and incomplete source events, and a diagnostic mode that reports a lower-bound candidate with an explicit UNKNOWN reason. Neither mode issues Duskits.
4. Apply the proposed activity caps only after counting unique source events: per-war/user for war actions, per-source-event for rep work, and one weekly routine cap. Keep transfer rewards outside the routine cap until actual-move proof exists.
5. Produce weekly per-user distributions segmented by verified/trusted/legacy/unverified link state, single-account/multi-account, rep/non-rep current assignment, and UNKNOWN coverage. Report eligible, ineligible, unknown, duplicate, and corrected-source counts separately.
6. Re-run the same read-only simulation against a second `as-of` boundary if practical. Any result that changes because a current `PlayerLink`, mutable tracked-message JSON, or current rep assignment changed should be labeled historical-ownership-sensitive and excluded from launch calibration.
7. Use the output to decide whether clean FWA participation and event-backed rep actions can support the 15–20 Duskits/week target. Do not back-pay historical rows automatically; implementation requires a separate ledger, source-event identity, policy version, reversal, and active-runtime-only release design.

## Inspected repository files

Primary sources inspected:

- `prisma/schema.prisma` — models and unique/index constraints for all owners listed above.
- `src/services/war-events/history.ts` and `src/services/war-events/participationRowBuilder.ts` — ended-war archive, participation snapshot, and `WarAttacks` cleanup.
- `src/services/WarPlanViolationService.ts` and `src/services/WarPlanViolationHistoryService.ts` — evaluation completion, correction/reset, and completed-history consumers.
- `src/services/TrackedMessageService.ts`, `src/commands/Fwa.ts`, and `src/listeners/messageReactionAdd.ts` — base-swap metadata, acknowledgments, split-post identity, and rep-work capture.
- `src/services/RepWorkActivityService.ts`, `src/services/RepWorkReportService.ts`, and `src/commands/RepWork.ts` — event deduplication, timestamps, reporting, and the absence of a stipend policy.
- `src/services/TrackedClanRepService.ts` — current rep assignment and current PlayerLink resolution.
- `src/services/PlayerLinkService.ts`, `src/services/PlayerLinkVerificationService.ts`, and `src/services/PlayerLinkSyncService.ts` — ownership, verification, trust tiers, imports, deletion/reassignment behavior, and multi-account joins.
- `src/services/MembershipStreakService.ts` and `src/services/ClanHomeMembershipService.ts` — canonical boundary evidence, three-sync Home/transfer qualification, CWL suppression, and UNKNOWN handling.
- `src/services/HomeRosterService.ts` and `src/services/PlayerCurrentService.ts` — current roster freshness and authoritative physical-location evidence.
- `docs/roadmaps/dusk-economy.md`, `docs/architecture-contract.md`, `docs/core-priorities.md`, `docs/project-brain.md`, and `docs/observability.md` — required product, ownership, runtime, and observability constraints.

## Validation and unresolved blockers

Validation performed:

- Read all five required documents before repository investigation.
- Traced each requested signal to its Prisma model and owning service using repository search and source inspection.
- Confirmed the ended-war `WarAttacks` deletion path and the canonical `ClanWarParticipation` snapshot path.
- Confirmed completed-evaluation gating and correction/reset behavior.
- Confirmed `RepWorkActivityEvent.dedupeKey` uniqueness and its construction inputs.
- Confirmed base-swap acknowledgment is mutable tracked-message JSON without a per-ack timestamp.
- Confirmed Home/transfer three-boundary and freshness rules, including mirror write blocking in the Home decision service.
- Confirmed no Prisma schema, migration, command, scheduler, API polling, reward ledger, wallet, or production write was changed.

Unresolved blockers for simulation/launch calibration:

- No database sample was available or queried in this documentation pass, so this file makes no claim about row counts, historical coverage, actual weekly earnings, or the current state of any player/clan.
- The exact historical `WarLookup.payload` attack JSON shape and completeness must be measured before BL triple simulation.
- PlayerLink and TrackedClanRep lack historical validity intervals; strict no-backpay attribution will produce UNKNOWN for some historical rows.
- Tracked-message acknowledgment history is not append-only and has no per-entry timestamp; base-swap and early-swap rewards cannot be safely calibrated from old snapshots.
- Transfer confirmation is a Home decision, not a separately verified physical move/consent event; transfer rewards and the 14-day continuation reward remain blocked pending a read-only proof design.
- The project owner confirmed Elle's explicit permission and advocacy for Dusk-funded +1 giveaways, and clarified that the existing giveaway uses Discord bonus-entry roles (including distinct +1 roles from multiple avenues). Personal +1 is the proposed proof of concept. The user subsequently confirmed the +1 roles **persist until their holder wins**, at which point **Elle manually removes all the winner's +1 roles**. The M0b roadmap treats this as winner-consumed (not per-giveaway). The project owner additionally agreed that a former winner may buy a new Dusk-funded +1 whenever they have enough Duskits; confirming the earlier win remains an implementation proof requirement. The owner further confirmed the **three existing +1 roles stack**, and that a user holding all three **cannot purchase another personal +1** with Duskits; a clan-wide +1 is a separate future shop reward. The owner further authorized Dusk to assign **whichever of the three existing +1 roles are missing** and to let a member purchase **up to all three for themselves** if they can afford the price per role (still provisional). Exact role IDs, deterministic free-slot selection, source provenance controls, initial eligibility and non-win refunds remain implementation/governance follow-ups; no Rising Maple API or manual external entry registry is assumed.
