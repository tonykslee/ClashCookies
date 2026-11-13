# Historical Duskits Earnings Simulation

> **M0a, part 2 — bounded offline simulation**
> **Status:** M0a part 2 completed — bounded real sample, provenance diagnosis, post-fix rerun, and policy-limit review recorded; no issuance authorized
> **Date:** 2026-11-12

## Purpose and current result

This diagnostic describes the first bounded historical earnings simulator. It is an operator-invoked analysis tool, not bot runtime behavior and not a reward issuer. It reads only persisted evidence for one explicit guild and a maximum of 12 complete Monday-to-Monday UTC weeks. It prints aggregate diagnostics only; it does not print player tags, Discord IDs, raw metadata, or source rows.

The implementation is split deliberately:

- `src/services/duskHistoricalEarningsSimulation.ts` contains pure scope validation, evidence classification, deduplication, weekly-cap calculation, and aggregate rendering.
- `src/scripts/duskHistoricalEarningsSimulation.ts` contains the manual operator adapter. It creates a direct Prisma client from a dedicated simulation URL, verifies the transaction is read-only and using the expected database role, then performs bounded `findMany`/`SELECT` reads.
- `tests/duskHistoricalEarningsSimulation.test.ts` covers identity joins, missing evidence, violations, historical-sensitive links, multi-account collapse, rep-event deduplication, UTC weeks, cap behavior, repeatability, and unsafe configuration refusal.

No wallet, ledger, currency model, migration, bot command, scheduler, poller, external API call, or production write was added. The first real sample used a dedicated SELECT-only connection and was executed twice with the same fixed snapshot; the post-fix run reused the same bounded scope and fixed snapshot. No credentials, player identifiers, or raw rows are recorded here. The M0a part 2 **simulation and review** milestone is complete; live payout eligibility, prices, and approval remain separate open decisions.

## First real sample — aggregate findings

The bounded sample covered guild `1324040917602013261` from `2026-09-14T00:00:00.000Z` through `2026-11-09T00:00:00.000Z` (eight complete UTC weeks). Both SELECT-only executions produced identical aggregate reports:

- 199 ended wars and 9,950 participation rows were observed.
- 81 wars had an exact history/participation end timestamp.
- 115 wars differed by 1–51 seconds, and 3 wars differed by 70–101 seconds.
- All 5,900 reported identity conflicts were end-time-only mismatches; each affected war had 50 participation rows with one consistent offset.
- All 199 production rosters remain `UNKNOWN` because `ClanWarParticipation` has no authoritative completeness marker.

The initial sample establishes an observed, consistent timestamp-provenance difference, not a blanket time tolerance and not proof that any source row was corrected. Merged PR #1962 updates the simulator to use shared persisted `warId`, exact normalized clan/opponent tags, and exact start time as canonical identity. It reconciles a differing end time only when every participation row for that war has one valid common persisted end time. A missing or contradictory end-time set remains `UNKNOWN`; wrong clan, opponent, or start remains an identity conflict. The operator completed the bounded post-fix rerun below.

## Post-fix rerun and policy-limit review

An operator built merged `dev` commit `1f4843a0` and reran the same SELECT-only scope, guild, eight complete UTC weeks, and `2026-11-13T00:00:00.000Z` snapshot. This is one recorded post-fix run; repeatability was demonstrated by the two matching initial-run reports and deterministic fixture coverage, not by claiming two post-fix executions.

| Measure | Initial run | Post-fix rerun |
| --- | ---: | ---: |
| Ended wars / participation rows | 199 / 9,950 | 199 / 9,950 |
| `WAR_IDENTITY_CONFLICT` participation events | 5,900 | 0 |
| Complete / UNKNOWN canonical rosters | 0 / 199 | 0 / 199 |
| Clean-FWA UNKNOWN events | 9,500 | 8,700 |
| Clean-FWA ineligible events | 450 | 1,250 |
| Clean-FWA verified awards | 0 | 0 |
| Recognized FWA rep actions | 589 of 592 | 589 of 592 |
| Raw simulated rep Duskits | 1,178 | 1,178 |

The 800-row shift from `UNKNOWN` to `INELIGIBLE` reflects later classification after the end-time identity check succeeds; it does **not** establish 800 newly qualified players. `WAR_ROSTER_COMPLETENESS_UNPROVEN=199` remains the gating reason for otherwise relevant FWA rosters. The zero strict/provisional player-link counters do **not** mean that no linked players exist: those downstream checks are not reached when the roster-completeness gate fails. There were 174 `observedSourceUpdates` and zero *proven* correction rows; the latter is an evidence limitation, not a claim that no corrections occurred. Evaluation coverage was 174 completed / 25 missing or incomplete; 329 player-violation rows were observed, but clean-FWA eligibility cannot be established from them without authoritative roster completeness.

Rep-work source mix was 81 FWA base-swap publications, 106 Bases checklist actions, 203 FWA match-mail sends, and 199 Mail checklist actions. Three CWL-source events remained `UNKNOWN`; zero duplicate rep-event keys were observed. Sixteen distinct users had recognized earnings across the eight weeks. Total draft earnings after the per-user weekly 30-Duskit cap were **992 Duskits**, compared with 1,178 uncapped. Only one of those 16 users is projected to reach the proposed 100-Duskit target within seven weeks at their observed eight-week average. This rep-work-heavy sample does not measure ordinary members' possible clean-war or other currently unmodeled earning opportunities.

**Policy review / scope of completion:** M0a part 2 has fulfilled its read-only sampling and diagnostic objective. Preserve the **provisional** +2 per recognized rep action, +4 clean-FWA participation, 30-Duskit routine weekly cap, and 100-Duskit personal entry target for further deliberation; do not raise rep rates solely to compensate for low historical activity. The clean-FWA action stays **ineligible for issuance** without independently evidenced canonical roster completeness and historical player attribution. BL triples, early swaps, recurring rep stipends, voluntary transfers, giveaway fulfillment, and sponsorship remain unmodeled or undecided. Neither the sample nor this review authorizes live currency, backpay, product launch, or an automatic giveaway.

## Modeled activities and verdicts

The simulator has two draft earning rows only: clean FWA participation at **+4** per Discord user per war, and recognized FWA rep-work events at **+2** per unique persisted `RepWorkActivityEvent.dedupeKey`. These are draft rates for analysis, not live policy.

| Candidate activity | Authoritative source/service | Available evidence and identity key | Event-level deduplication | Attribution and time rule | Correction/freshness limitation | Simulation verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Clean FWA participation | `ClanWarHistory`, `ClanWarParticipation`, completed `WarPlanComplianceEvaluation` and `WarPlanViolation` | Shared persisted `warId`; exact clan/opponent tags and start time; end time from either writer only when participation rows have one valid common value; canonical participation rows including attacks used/missed; completed evaluation with `completedAt`; player violation rows | Participation unique by `[guildId, warId, playerTag]`; evaluation unique by `[guildId, warId]`; violation unique by `[evaluationId, playerTag]`; simulator additionally collapses one award per `(Discord user, warId)` | Participation `playerTag` joins to `PlayerLink`; strict requires `VERIFIED`, verification timestamp no later than war end, and no later link update; provisional allows a current non-revoked link created by the event time | `PlayerLink` is not an ownership history. Canonical changes can reset/re-finalize evaluations and replace violations. `ClanWarParticipation` has no durable completeness marker, so production-normalized rosters remain `UNKNOWN` unless an independent completeness assertion is supplied. End-time variance is provenance-reconcilable only when the per-war participation timestamps are valid and consistent; no numeric tolerance is used | **PARTIAL** overall; **STRICT/PROVISIONAL** only inside the simulator when all gates pass |
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

1. The row belongs to the selected guild and joins the history by shared `warId`, exact normalized clan/opponent tags, and exact war start. A differing end time is accepted only when all participation rows for that war carry one valid common persisted end time; no elapsed-seconds tolerance is applied. Missing or contradictory end-time evidence is `UNKNOWN`.
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
- `war-events/history.ts` has two persisted end-time paths: `ClanWarHistory` uses the final war-end result or a `WarAttacks` fallback, while the participation snapshot prefers `CurrentWar.endTime` and otherwise uses the history path. This independently explains a consistent per-war offset without proving which source is “corrected.”
- Exact `warId`, clan, opponent, and start-time agreement is the canonical identity. End-time variance is safe only with one valid, internally consistent participation end time for the war. Wrong opponent, wrong clan, wrong start, missing end, or contradictory participation end times remain `UNKNOWN`/identity conflict.
- `ClanWarParticipation` has no durable roster-completeness marker, expected team size, or capture-batch identity. A non-empty, well-shaped subset can therefore look complete while representing a partial snapshot.
- The simulator requires both a valid row shape and an explicit `participationCompleteness=COMPLETE` assertion. The production adapter supplies `UNKNOWN`; only controlled fixtures or a later independently verified importer may assert `COMPLETE`. Missing completeness evidence is never treated as a completed roster.
- A completed evaluation is mutable. Canonical history correction can reset it and replace violations; the current row does not provide a source fingerprint or reward reversal identity.
- `TrackedMessage` acknowledgment is mutable JSON state. It has no per-entry event timestamp, reaction actor, reaction ID, before/after layout identity, or append-only history. It cannot prove an early in-game base swap.
- Current `TrackedClanRep` assignment has no start/end interval. A current title cannot prove historical recurring eligibility.
- Current `PlayerLink` is not a historical ownership ledger. Deletion removes the row; reassignment history is not recoverable. The simulator therefore exposes late, revoked, missing, history-sensitive, and conflicting identity reasons.
- `RepWorkActivityEvent` has durable dedupe but no correction/reversal state. A source correction requires a future policy and reconciliation owner. `updatedAt > createdAt` is reported only as an observed source update; it is not evidence that a correction was proven. The simulator reports `observedSourceUpdates` separately from `provenCorrectionRows` (currently zero).
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

The command is deliberately not part of startup, CI, staging automation, or a scheduler. For repeatable operator comparisons, every run must provide the same fixed `--snapshot` value; omitting it uses the current clock and is not a comparable historical run. It prints an aggregate report with evidence counts, UNKNOWN reason counts, strict/provisional totals, duplicate counts, observed source updates, proven corrections, weekly uncapped/capped distributions, current rep/non-rep descriptions, and 100-Duskit feasibility. It never emits raw identifiers or a proposed issuance file.

## Recommendation for the first earning activities

For a future active earning engine, the safest first activity is the narrowly source-filtered, deduplicated `RepWorkActivityEvent` action reward. It has a direct Discord actor, event timestamp, source-message context, and database-enforced unique key. Keep the activity allowlist small and exclude CWL/non-FWA sources.

The second candidate is clean FWA participation only after the historical sample demonstrates complete roster coverage, completed evaluation coverage, stable exact joins, and acceptable strict attribution. Start with a manual/reconciliation-only cohort; do not back-pay unknown or provisional rows automatically. Do not start with BL triples, base-swap/early-swap claims, recurring rep stipends, or transfers.

## M0a part 2 bounded simulation plan

1. Create a dedicated SELECT-only database role and provide a separate simulation URL to the operator. Confirm the role, transaction read-only setting, and grants without changing application schema or production behavior.
2. Run one explicit guild over a representative 4–12 complete-week UTC window with a fixed `--snapshot`. Capture the aggregate output and tool version/commit with the operator review; do not export identifiers.
3. Review ended-war discovery, roster completeness, completed evaluation coverage, violation counts, strict/provisional/UNKNOWN attribution, duplicate identities, rep source mix, current rep descriptive cohorts, and per-user weekly cap distributions.
4. Run the exact same command again with the same fixed `--snapshot` value and compare deterministic output. Investigate source-update observations, proven-correction evidence, timestamp provenance, malformed joins, unexpected duplicate keys, or unsafe credential behavior.
5. Use the sample and any post-diagnosis rerun to decide whether the two draft activities and the 30-Duskit cap support the 100-Duskit target. Record policy decisions separately from observed evidence.
6. The timestamp-identity findings, post-change sample, and policy-limit review are now recorded, completing the bounded M0a part 2 **diagnostic** milestone. This remains no authorization for clean-FWA eligibility, reward issuance, retroactive payouts, or market fulfillment.
