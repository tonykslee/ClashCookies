# Historical Duskits Earnings Simulation

> **M0a, part 2 — bounded offline simulation**
> **Status:** Tool and deterministic fixture tests prepared; real historical sample pending
> **Date:** 2026-11-12

## Purpose and current result

This diagnostic describes the first bounded historical earnings simulator. It is an operator-invoked analysis tool, not bot runtime behavior and not a reward issuer. It reads only persisted evidence for one explicit guild and a maximum of 12 complete Monday-to-Monday UTC weeks. It prints aggregate diagnostics only; it does not print player tags, Discord IDs, raw metadata, or source rows.

The implementation is split deliberately:

- `src/services/duskHistoricalEarningsSimulation.ts` contains pure scope validation, evidence classification, deduplication, weekly-cap calculation, and aggregate rendering.
- `src/scripts/duskHistoricalEarningsSimulation.ts` contains the manual operator adapter. It creates a direct Prisma client from a dedicated simulation URL, verifies the transaction is read-only and using the expected database role, then performs bounded `findMany`/`SELECT` reads.
- `tests/duskHistoricalEarningsSimulation.test.ts` covers identity joins, missing evidence, violations, historical-sensitive links, multi-account collapse, rep-event deduplication, UTC weeks, cap behavior, repeatability, and unsafe configuration refusal.

No wallet, ledger, currency model, migration, bot command, scheduler, poller, external API call, or production write was added. No real database sample was run in this investigation because a dedicated read-only simulation connection was not supplied; M0a part 2 remains incomplete until an operator runs and reviews a bounded sample.

## Modeled activities and verdicts

The simulator has two draft earning rows only: clean FWA participation at **+4** per Discord user per war, and recognized FWA rep-work events at **+2** per unique persisted `RepWorkActivityEvent.dedupeKey`. These are draft rates for analysis, not live policy.

| Candidate activity | Authoritative source/service | Available evidence and identity key | Event-level deduplication | Attribution and time rule | Correction/freshness limitation | Simulation verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Clean FWA participation | `ClanWarHistory`, `ClanWarParticipation`, completed `WarPlanComplianceEvaluation` and `WarPlanViolation` | Ended `warId`; exact clan/opponent/start/end tuple; canonical participation rows including attacks used/missed; completed evaluation with `completedAt`; player violation rows | Participation unique by `[guildId, warId, playerTag]`; evaluation unique by `[guildId, warId]`; violation unique by `[evaluationId, playerTag]`; simulator additionally collapses one award per `(Discord user, warId)` | Participation `playerTag` joins to `PlayerLink`; strict requires `VERIFIED`, verification timestamp no later than war end, and no later link update; provisional allows a current non-revoked link created by the event time | `PlayerLink` is not an ownership history. Canonical changes can reset/re-finalize evaluations and replace violations. `ClanWarParticipation` has no durable completeness marker, so production-normalized rosters remain `UNKNOWN` unless an independent completeness assertion is supplied | **PARTIAL** overall; **STRICT/PROVISIONAL** only inside the simulator when all gates pass |
| Attributable FWA rep action | `RepWorkActivityService` → `RepWorkActivityEvent` | Direct `discordUserId`, guild/clan, activity type, source message, optional war identity, `eventAt`, metadata/source | Database `dedupeKey @unique`; simulator counts each key once and treats repeats as duplicate | Accept only known FWA `BASES_CHECKED`, `MAIL_CHECKED`, or `MAIL_SENT` source metadata; exclude CWL; direct event user is the actor | No reversal/correction state; a known event proves the persisted rep action, not historical rep assignment or a gameplay result | **VERIFIED** for the narrowly defined event action after source filtering; **not verified** for recurring rep status |
| Verified Blacklist triple | `ClanWarHistory`, archived `WarLookup.payload`; current `WarAttacks` only while active | History identifies ended BL war; archive may contain attack detail and timestamps | No durable per-player historical triple key; `WarAttacks` keys are current-only and rows are deleted after archival | Would require a strict archive extractor for player attack identity plus event-time PlayerLink evidence | Archive payload shape/completeness and correction semantics need validation; current attacks cannot backfill old wars | **PARTIAL**, not modeled |
| Base-swap acknowledgment | `TrackedMessage` and FWA base-swap reaction logic | Mutable `metadata.entries[]` with player/user, section, and `acknowledged`; message/war timing context | No per-entry acknowledgment key or append-only event; split posts may share `referenceId` | Stored listed user is not a separate reaction actor; no acknowledgment timestamp | Message-level `createdAt`/`updatedAt` cannot establish when a particular entry was acknowledged; edits/replacements overwrite state | **PARTIAL**, not modeled |
| Early base swap | No authoritative owner; nearest records are `TrackedMessage` and publication rep events | Publication timing and current acknowledgment booleans only | None for actual layout change | No player layout before/after identity or action timestamp | Publication actor is not the recipient’s gameplay action | **UNSUPPORTED** |
| Recurring rep stipend | `TrackedClanRep`, `PlayerLink`, `RepWorkActivityEvent` | Current `[clanTag, playerTag]` assignment plus historical work events | Rep events deduped by `dedupeKey`; assignments have composite PK only | Current assignment cannot prove past role tenure; no threshold or period claim owner | No assignment interval, weekly eligibility record, rate policy, or reversal source | **UNSUPPORTED** |
| Beneficial transfer / 14-day continuation | `ClanHomeTransferCandidate`, Home periods, `SyncClanMemberSnapshot`, `AllianceClanMembershipInterval`, current roster owners | Candidate decision, observation-bound membership, Home periods, fresh current roster where available | Candidate composite identity and snapshot uniqueness; no physical-move completion event | Player tag and event-time link still need attribution; destination presence needs fresh bounded observations | Confirmation changes Home state but does not prove physical destination presence, consent, or exact move time; observation intervals are cadence-bounded | **PARTIAL**, not modeled |

## Strict and provisional rules

The report keeps `VERIFIED`, `PROVISIONAL`, `INELIGIBLE`, and `UNKNOWN` conceptually separate. Missing or contradictory evidence never becomes a completed action.

### Clean FWA

For a history discovered in the selected ended-war window, the simulator requires all of the following before considering a participation row:

1. The row belongs to the selected guild and joins the history by exact `warId`, normalized clan tag, opponent tag, war start, and war end.
2. Both history and participation say `FWA`.
3. The participation roster is non-empty, has valid identity fields, has no duplicate `(warId, clanTag, playerTag)` row in the bounded read, and has an explicit independent `participationCompleteness=COMPLETE` assertion. A missing, malformed, or completeness-unproven roster is `UNKNOWN` for the war.
4. The evaluation is `COMPLETED` and has a non-null `completedAt`. Missing, pending, insufficient, failed, or skipped evaluation is `UNKNOWN`, even when no violation rows are visible.
5. The player has no violation row in that completed evaluation.
6. The draft participation rule is `attacksUsed > 0 AND attacksMissed = 0`.
7. The player tag has a safe attribution result.

The strict link result requires a current `PlayerLink` row whose status is `VERIFIED`, whose `verifiedAt` or `lastVerifiedAt` is no later than the war end, whose link was created no later than the war end, and whose `updatedAt` is not later than the event. That last condition is intentionally conservative: the repository has no historical ownership interval. A current non-revoked row created by the event time can appear only in the provisional result when later updates make history-sensitive ownership possible. Missing, late-created, revoked, malformed, or conflicting tag ownership is `UNKNOWN`.

When multiple independently linked player tags map to one Discord user, the simulator first evaluates each account and then collapses the clean award to one user/war. A player tag mapped to multiple users in fixture or future imported evidence is an identity conflict, not a choice of owner.

### FWA rep work

The simulator accepts only the existing persisted source classifications:

- `BASES_CHECKED` with `metadata.source=base_swap` and `metadata.clanKind=FWA` exactly. `CWL`, missing, malformed, or otherwise unrecognized `clanKind` is `UNKNOWN`;
- `BASES_CHECKED` with `metadata.source=bases_checklist` and `viewType=Bases`;
- `MAIL_CHECKED` with `metadata.source=mail_checklist` and `viewType=Mail`;
- `MAIL_SENT` with `metadata.source=fwa_match_mail_send`.

These are the values persisted by `RepWorkActivityService`; caller-supplied source labels are overwritten while the event envelope is built. The checklist view type remains required. The `base_swap` source is shared by FWA and CWL, so only an explicit `clanKind=FWA` is eligible; absent or invalid clan-kind metadata is never treated as FWA.

The persisted `dedupeKey` is required. A repeated key is counted once; a missing key, invalid Discord ID, unknown source, or CWL source is `UNKNOWN`. The event’s direct `discordUserId` is the attribution authority. Current `TrackedClanRep` membership is reported only as a descriptive current rep/non-rep cohort; it is not used to backfill a recurring stipend or to upgrade an event’s historical status.

## Failure cases and historical gaps

- `WarAttacks` is not a historical owner. Ended-war cleanup deletes current attack rows after participation is snapshotted. A query that finds no old attacks must report unavailable evidence, not zero attacks.
- `ClanWarHistory` has no guild ID. The operator adapter discovers histories only through selected-guild participation/evaluation war IDs. A history with neither child evidence is outside attributable guild scope and is an unresolved coverage gap, not silently included.
- `ClanWarParticipation.warId` is a string while `ClanWarHistory.warId` is an integer. The adapter normalizes the values; the pure classifier also checks exact tuple identity to avoid a numeric ID collision with stale or cross-clan rows.
- `ClanWarParticipation` has no durable roster-completeness marker, expected team size, or capture-batch identity. A non-empty, well-shaped subset can therefore look complete while representing a partial snapshot.
- The simulator requires both a valid row shape and an explicit `participationCompleteness=COMPLETE` assertion. The production adapter supplies `UNKNOWN`; only controlled fixtures or a later independently verified importer may assert `COMPLETE`. Missing completeness evidence is never treated as a completed roster.
- A completed evaluation is mutable. Canonical history correction can reset it and replace violations; the current row does not provide a source fingerprint or reward reversal identity.
- `TrackedMessage` acknowledgment is mutable JSON state. It has no per-entry event timestamp, reaction actor, reaction ID, before/after layout identity, or append-only history. It cannot prove an early in-game base swap.
- Current `TrackedClanRep` assignment has no start/end interval. A current title cannot prove historical recurring eligibility.
- Current `PlayerLink` is not a historical ownership ledger. Deletion removes the row; reassignment history is not recoverable. The simulator therefore exposes late, revoked, missing, history-sensitive, and conflicting identity reasons.
- `RepWorkActivityEvent` has durable dedupe but no correction/reversal state. A source correction requires a future policy and reconciliation owner.
- A `base_swap` source without exact `clanKind=FWA` is ambiguous because the writer also records CWL base swaps; the simulator keeps CWL, missing, and invalid clan-kind values `UNKNOWN`.
- Home transfer confirmation changes the Home period but does not prove that the member physically joined the destination at the confirmation instant. Home/roster freshness and 14-day residence remain separate checks.
- Base-swap publication events identify the publisher, not each recipient’s swap action.
- Giveaway fulfillment, sponsor liability, quest rewards, transfer rewards, BL triples, and recurring stipends are intentionally unmodeled.

## Read-only query design for a historical sample

The manual adapter performs this sequence inside one Prisma interactive transaction:

1. `SELECT current_setting('transaction_read_only'), current_user`. It refuses to continue unless the transaction reports `on` and `current_user` equals `DUSK_SIMULATION_READ_ONLY_ROLE`.
2. `ClanWarParticipation.findMany` scoped to the explicit `guildId` and `warEndTime >= from AND warEndTime < to`, selecting only identity, attack, match, timestamps, and creation fields.
3. `WarPlanComplianceEvaluation.findMany` scoped to `guildId` and related `warHistory.warEndTime` in the same half-open window, selecting status, completion/correction timestamps, and violation player tags.
4. `ClanWarHistory.findMany` by the union of war IDs obtained in steps 2–3 and the same ended-war time bounds. This avoids an unbounded cross-guild history scan because `ClanWarHistory` has no guild column. The adapter does not infer roster completeness from the number or shape of returned participation rows.
5. `RepWorkActivityEvent.findMany` scoped to guild and `eventAt` in the half-open window, selecting source, actor, dedupe, metadata, and timing fields. A small actor-ID projection is used to bound the descriptive PlayerLink lookup.
6. `PlayerLink.findMany` only for participation tags and rep-event actor IDs. `TrackedClanRep.findMany` only for the resulting linked tags; it is descriptive and does not establish historical stipend eligibility.

The query design is bounded by one guild and at most 12 complete UTC weeks. The adapter does not call the Clash API, Discord, a poller, a scheduler, or the normal lazy/global Prisma proxy. It rejects missing simulation credentials, a URL equal to `DATABASE_URL`, a non-PostgreSQL URL, a missing `DUSK_SIMULATION_READ_ONLY=1` acknowledgement, a missing expected role, an invalid date window, or a transaction that is not read-only.

Suggested operator setup uses a dedicated PostgreSQL role with no write privileges and `default_transaction_read_only=on`, a separate database URL, and no production credential reuse. The repository does not create or alter that role.

Example (after the normal build):

```powershell
$env:DUSK_SIMULATION_DATABASE_URL = "postgresql://dusk_sim_readonly:<secret>@<host>/<database>?options=-c%20default_transaction_read_only%3Don"
$env:DUSK_SIMULATION_READ_ONLY = "1"
$env:DUSK_SIMULATION_READ_ONLY_ROLE = "clashcookies_dusk_readonly"
npm run diagnose:dusk-historical-earnings -- --guild <guild-id> --from 2026-01-05T00:00:00.000Z --to 2026-02-16T00:00:00.000Z --snapshot 2026-02-16T00:00:00.000Z
```

The command is deliberately not part of startup, CI, staging automation, or a scheduler. For repeatable operator comparisons, every run must provide the same fixed `--snapshot` value; omitting it uses the current clock and is not a comparable historical run. It prints an aggregate report with evidence counts, UNKNOWN reason counts, strict/provisional totals, duplicate/correction counts, weekly uncapped/capped distributions, current rep/non-rep descriptions, and 100-Duskit feasibility. It never emits raw identifiers or a proposed issuance file.

## Recommendation for the first earning activities

For a future active earning engine, the safest first activity is the narrowly source-filtered, deduplicated `RepWorkActivityEvent` action reward. It has a direct Discord actor, event timestamp, source-message context, and database-enforced unique key. Keep the activity allowlist small and exclude CWL/non-FWA sources.

The second candidate is clean FWA participation only after the historical sample demonstrates complete roster coverage, completed evaluation coverage, stable exact joins, and acceptable strict attribution. Start with a manual/reconciliation-only cohort; do not back-pay unknown or provisional rows automatically. Do not start with BL triples, base-swap/early-swap claims, recurring rep stipends, or transfers.

## M0a part 2 bounded simulation plan

1. Create a dedicated SELECT-only database role and provide a separate simulation URL to the operator. Confirm the role, transaction read-only setting, and grants without changing application schema or production behavior.
2. Run one explicit guild over a representative 4–12 complete-week UTC window. Capture the aggregate output and tool version/commit with the operator review; do not export identifiers.
3. Review ended-war discovery, roster completeness, completed evaluation coverage, violation counts, strict/provisional/UNKNOWN attribution, duplicate identities, rep source mix, current rep descriptive cohorts, and per-user weekly cap distributions.
4. Run the exact same command again with the same fixed `--snapshot` value and compare deterministic output. Investigate any source corrections, malformed joins, unexpected duplicate keys, or unsafe credential behavior.
5. Use the sample to decide whether the two draft activities and the 30-Duskit cap support the 100-Duskit target. Record policy decisions separately from observed evidence.
6. Keep M0a part 2 open until the real sample is reviewed. A successful local fixture test is not a historical data result and does not authorize issuance.
