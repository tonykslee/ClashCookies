# Architecture Contract (Do Not Violate Without Explicit Approval)

You must preserve these system flows unless I explicitly approve a redesign.

## System flow

War state:

TrackedClan
    ->
WarEventLogService / active poll loops
    ->
CurrentWar
    ->
ClanWarHistory
ClanWarParticipation
WarPlanComplianceEvaluation
WarPlanViolation
WarAttacks
WarLookup
WarEvent
WarMailLifecycle
ClanPostedMessage

Points state:

points.fwafarm
    ->
PointsSyncService
    ->
ClanPointsSync

Feed-backed current state:

FWAStats JSON feeds
    ->
FwaFeedSchedulerService
    ->
FwaClanCatalog
FwaPlayerCatalog
FwaClanMemberCurrent
FwaWarMemberCurrent
FwaTrackedClanWarRosterCurrent
FwaTrackedClanWarRosterMemberCurrent
FwaClanWarLogCurrent
FwaClanMatchStatsCurrent
HeatMapRef
FwaFeedSyncState
FwaClanWarsWatchState
FwaFeedCursor

Snapshot and reminder state:

PlayerLink + CurrentWar + CurrentCwlRound/CwlRoundMemberCurrent + activity signals
    ->
TodoSnapshotService
    ->
TodoPlayerSnapshot

CWL state:

CwlEventInstance / CwlEventClan / CwlEventWarTag
    ->
CwlTrackedClan
    ->
CwlStateService
    ->
CurrentCwlRound
CwlRoundMemberCurrent
CwlRoundHistory
CwlRoundMemberHistory
CwlPlayerClanSeason

CWL planner state:

CurrentCwlRound + CwlRoundMemberCurrent + CwlPlayerClanSeason
    ->
CwlRotationService
    ->
CwlRotationPlan
CwlRotationPlanDay
CwlRotationPlanMember

CWL alliance activity reporting:

CwlEventInstance + CwlEventClan + persisted CWL round/history owners + CwlPlayerClanSeason
    + ClanWarHistory + ClanWarParticipation
    ->
CwlAllianceActivityService
    ->
read-only `/cwl activity` report

`CwlAllianceActivityService` is the active DB-first reporting consumer. It reads persisted CWL event/round/history owners, `CwlPlayerClanSeason`, `ClanWarHistory`, and `ClanWarParticipation`; it does not consume `AllianceClanMembershipInterval`. It performs no writes, external API calls, interval/current-state ownership changes, or manual/frozen baseline reads. Historical pre-CWL cohorts are derived DB-first from canonical war history.

CWL camping reporting:

AllianceClanMembershipInterval
    +
CwlAllianceActivityService historical home attribution/CWL window
    +
CwlTrackedClan
    ->
CwlAllianceCampingService
    ->
read-only `/cwl camping` report

`CwlAllianceCampingService` is a read-only analytics consumer, not a state owner. It measures observed non-home CWL-clan residence, keeps accounts without historical home attribution in a separate diagnostic bucket, and reconciles overlapping interval evidence without mutating stored history. `/cwl activity` remains independent of membership intervals.

Reminder / UserActivityReminder config
    + TodoPlayerSnapshot / CurrentWar
    ->
Reminder schedulers
    ->
ReminderFireLog / UserActivityReminderDelivery

Operational state:

TrackedMessageService -> TrackedMessage / TrackedMessageClaim
RepWorkActivityService -> RepWorkActivityEvent
TelemetryIngestService -> Telemetry aggregates / report schedules
UnlinkedMemberAlertService -> UnlinkedAlertConfig / UnlinkedPlayer

Mirror runtime:

Prod runtime allowlist
    ->
MirrorSyncService
    ->
Staging runtime mirrors

Commands:

Read from CurrentWar + ClanPointsSync + TodoPlayerSnapshot + feed-backed tables + other persisted owners. `TodoPlayerSnapshot` keeps current membership separate from WAR lineup identity so stale WAR context can be cleared independently.

## 0) State ownership map (single source of truth)

Each domain concept must have exactly one authoritative owner.

| Concept | Owner |
| --- | --- |
| CWL event identity | CwlEventInstance |
| CWL clan-to-current-event pointer | CwlEventClan |
| CWL war-tag-to-event mapping | CwlEventWarTag |
| Tracked FWA clans | TrackedClan |
| Per-clan FWA weight-alert policy (enablement and stale-age threshold) | FwaWeightAlertConfig |
| Durable per-clan/date FWA weight-alert delivery claims and outcomes | FwaWeightAlertDelivery |
| Tracked FWA clan rep accounts | TrackedClanRep |
| Tracked FWA clan rep user profile metadata | TrackedClanRepUserProfile |
| Current player state | PlayerCurrent |
| Current FWA clan roster state | FwaClanMemberCurrent |
| Seasonal CWL tracked clans | CwlTrackedClan |
| Live battle-day CWL round identity and timing | CurrentCwlRound |
| Live battle-day CWL round member summaries | CwlRoundMemberCurrent |
| Live overlapping prep-day CWL snapshot | CurrentCwlPrepSnapshot |
| Ended CWL round canonical history | CwlRoundHistory |
| Ended CWL round member history | CwlRoundMemberHistory |
| Derived current-season CWL roster summary | CwlPlayerClanSeason |
| CWL event-scoped child rows | CurrentCwlRound, CwlRoundMemberCurrent, CurrentCwlPrepSnapshot, CwlRoundHistory, CwlRoundMemberHistory, CwlPlayerClanSeason, CwlSeasonRosterState |
| CWL event-owned planner state | CwlRotationPlan, CwlRotationPlanDay, CwlRotationPlanMember |
| Historical observed alliance clan-membership intervals | AllianceClanMembershipInterval |
| Immutable scheduled-sync FWA physical-membership facts | SyncClanMemberSnapshot |
| Durable Home Clan membership periods | ClanHomeMembershipPeriod |
| Proposed Home transfer and leader-decision history | ClanHomeTransferCandidate |
| Player-to-Discord links | PlayerLink |
| Guild-scoped roster default columns | RosterGuildConfig |
| Live war state | CurrentWar |
| Ended-war canonical record | ClanWarHistory |
| Canonical sync-number to scheduled-sync-time identity | SyncCycle |
| Ended-war player participation | ClanWarParticipation |
| Finalized war-plan evaluation | WarPlanComplianceEvaluation |
| Finalized war-plan player violation | WarPlanViolation |
| Current-war attack detail | WarAttacks |
| Archived war payloads | WarLookup |
| Points sync metadata | ClanPointsSync |
| War event idempotency | WarEvent |
| Scheduled-sync clan readiness snapshot and exact filler-at-sync facts | SyncClanReadinessSnapshot |
| Scheduled-sync clan-goal and sync-retrospective delivery idempotency | SyncEvent |
| Posted notify/mail messages | ClanPostedMessage |
| Active-war mail lifecycle | WarMailLifecycle |
| Active-runtime war-plan finalization/retry | WarPlanViolationService |
| Notify overrides | ClanNotifyConfig |
| Tracked FWA war-roster current identity | FwaTrackedClanWarRosterCurrent.sourceWarId, FwaTrackedClanWarRosterCurrent.sourceWarStartTime, FwaTrackedClanWarRosterCurrent.sourceWarEndTime, FwaTrackedClanWarRosterCurrent.sourceWarState, FwaTrackedClanWarRosterCurrent.sourceCurrentWarUpdatedAt |
| Current membership snapshot context | TodoPlayerSnapshot.clanTag, TodoPlayerSnapshot.clanName, TodoPlayerSnapshot.clanMembershipObservedAt |
| WAR snapshot context | TodoPlayerSnapshot.warClanTag, TodoPlayerSnapshot.warClanName, TodoPlayerSnapshot.warPosition, TodoPlayerSnapshot.warSourceUpdatedAt, TodoPlayerSnapshot.warOwnerSource, TodoPlayerSnapshot.warOwnerWarId, TodoPlayerSnapshot.warOwnerVerifiedAt, TodoPlayerSnapshot.warActive, TodoPlayerSnapshot.warPhase, TodoPlayerSnapshot.warAttacksUsed, TodoPlayerSnapshot.warAttacksMax, TodoPlayerSnapshot.warEndsAt |
| RAID snapshot context | TodoPlayerSnapshot.raidClanTag, TodoPlayerSnapshot.raidClanName, TodoPlayerSnapshot.raidSourceUpdatedAt, TodoPlayerSnapshot.raidActive, TodoPlayerSnapshot.raidAttacksUsed, TodoPlayerSnapshot.raidAttacksMax, TodoPlayerSnapshot.raidEndsAt |

| CWL snapshot context | TodoPlayerSnapshot.cwlClanTag, TodoPlayerSnapshot.cwlClanName, TodoPlayerSnapshot.cwlActive, TodoPlayerSnapshot.cwlPhase, TodoPlayerSnapshot.cwlAttacksUsed, TodoPlayerSnapshot.cwlAttacksMax, TodoPlayerSnapshot.cwlEndsAt |
| Clan Games snapshot context | TodoPlayerSnapshot.gamesActive, TodoPlayerSnapshot.gamesCycleKey, TodoPlayerSnapshot.gamesPoints, TodoPlayerSnapshot.gamesTarget, TodoPlayerSnapshot.gamesChampionTotal, TodoPlayerSnapshot.gamesSeasonBaseline, TodoPlayerSnapshot.gamesEndsAt |
| Todo render snapshots | TodoPlayerSnapshot (current membership, WAR, RAID, CWL, and Clan Games render state) |
| Guild reminder config and dedupe | Reminder, ReminderTimeOffset, ReminderTargetClan, ReminderFireLog |
| Personal reminder config and dedupe | UserActivityReminderRule, UserActivityReminderDelivery |
| Tracked reusable posts and claims | TrackedMessage, TrackedMessageClaim |
| Rep-work attribution snapshots | RepWorkActivityEvent |
| FWA feed current state | FwaClanCatalog, FwaPlayerCatalog, FwaClanMemberCurrent, FwaWarMemberCurrent, FwaTrackedClanWarRosterCurrent, FwaTrackedClanWarRosterMemberCurrent, FwaClanWarLogCurrent, FwaClanMatchStatsCurrent |
| FWA compo reference bands | HeatMapRef |
| FWA feed scheduler metadata | FwaFeedSyncState, FwaClanWarsWatchState, FwaFeedCursor |
| Unlinked alert routing and unresolved members | UnlinkedAlertConfig, UnlinkedPlayer |
| Telemetry rollups and scheduled reports | TelemetryCommandAggregate, TelemetryUserCommandAggregate, TelemetryApiAggregate, TelemetryStageAggregate, TelemetryReportSchedule, TelemetryReportRun |
| Police-handled dedupe | FwaPoliceHandledViolation |

`FwaWeightAlertConfig` is the authoritative owner of per-clan FWA weight-alert enablement and stale-age threshold configuration. `FwaWeightAlertDelivery` is the authoritative owner of the durable per-clan/per-`weightSubmitDate` claim, retry, and Discord delivery outcome; it does not own policy or routing. `TrackedClan.leaderChannelId` and `TrackedClan.leadRoleId` remain the authoritative routing fields and must not be duplicated in either alert table. `FwaClanCatalog.weightSubmitDate` remains the authoritative persisted weight-submission date used for stale-age evaluation. The delivery evaluator runs only after a fresh Clans.json catalog sync reports `SUCCESS` or `NOOP`; there is no separate alert poller. Active runtime may send after a successful claim, while mirror/staging runtime must not send.

`AllianceClanMembershipInterval` is the sole owner of historical observed alliance clan-membership intervals intended for camping analytics and future read-only reporting. `PlayerCurrent` and `FwaClanMemberCurrent` remain current-state owners; they are not interval history and are not duplicated by this table. Interval timing has observation-cadence precision: `firstObservedAt` and `lastObservedAt` describe positive roster observations, not exact join or leave timestamps. Production activity observation writes these intervals. No manual/frozen CWL alliance baseline owner remains.

`SyncClanMemberSnapshot` is the sole owner of immutable scheduled-sync FWA physical-membership facts. It records normalized roster presence at a specific scheduled boundary and intentionally does not store weight, composition, filler, or presentation fields. These are different concepts, not competing owners: the interval table represents continuously observed alliance/CWL membership over an observation interval, while the sync snapshot represents the exact FWA roster facts available at one scheduled boundary. The active runtime writes both owners; `MirrorSyncService` only copies their persisted rows to staging and performs no new membership polling or writes.

`ClanHomeMembershipPeriod` is the sole owner of durable guild-scoped account/player Home Clan membership periods. It permits one active period per guild/player through a PostgreSQL partial unique index; current Away/Present state is derived from this owner and current physical membership rather than persisted separately. Active production scheduled-sync reconciliation is the only automatic writer, and mirror mode only copies persisted periods.

`HomeAwaySyncAlertSchedule` and `HomeAwaySyncAlertDelivery` own only the durable lifecycle of randomized pre-sync Away reminders. `ScheduledSyncPost` remains the source of upcoming sync identity and timing, `HomeRosterService` remains the authoritative read-only source of current Present/Away/Unknown state, and `PlayerLink` remains the account-to-Discord routing owner. Alert rows store immutable fire/delivery facts and claims; active runtime may evaluate and send them, while mirror mode only copies the rows. Delivery claims prevent normal replay/concurrency duplicates; the unavoidable crash window after Discord accepts a DM but before `SENT` commits, or a source replacement after the final source read but before Discord accepts the DM, cannot be made cross-system atomic and remains bounded by the existing retry policy.

`ClanHomeTransferCandidate` owns proposed Home transfers and their leader decisions only. It never owns current Home, Away, or Present state: a pending candidate does not change `ClanHomeMembershipPeriod`, and only explicit confirmation ends the old period and creates the successor Home period. The `/clan-health` transfer review panel sends candidate ID plus actor, guild, and expected Home-clan scope to `ClanHomeMembershipService`; the service revalidates all scope and active-Home facts inside the same transaction. Keep Home preserves the active Home and suppresses overlapping evidence until three fresh post-decision boundaries qualify. Transfer evidence must be three consecutive ordinary exact `SYNC_SNAPSHOT` boundaries in one different permanent `TrackedClan`; fallback participation, alliance intervals, filler state, and CWL boundaries cannot qualify. The shared persisted CWL-window primitive derived from `CwlTrackedClan`, event rows, and round/prep/history timing is the suppression authority. Production Home reconciliation and authorized transfer decisions write candidates/history; mirror mode remains strictly read-only and blocks decision writes.

Rules:

- Do not duplicate ownership fields across tables.
- Do not store derived data where it can be queried from the owner.
- If a field appears in multiple tables, document which copy is authoritative and mark every other copy as derived or transitional.

## 1) Runtime ownership model

- `POLLING_MODE=active` owns upstream pollers and schedulers.
- `POLLING_MODE=mirror` must not duplicate upstream polling or reminder ownership.
- Mirror mode may only run guarded prod-to-staging snapshot sync for the allowlisted runtime tables.
- Mirror mode does not capture new `SyncClanReadinessSnapshot` rows, resolve `SyncCycle` mappings, claim `SyncEvent`, or deliver scheduled-sync clan goals; it may mirror the persisted `SyncCycle` and `SyncClanReadinessSnapshot` owners for staging-safe reads, while those writes and Discord sends remain active-runtime responsibilities.
- Derived runtime tables must be recreatable from active pollers or guarded mirror sync.

## 2) CurrentWar role

- `CurrentWar` stores live war state only.
- `CurrentWar` may hold materialized per-war notify and mail runtime flags, but those values are derived from persisted config.
- Do not treat `CurrentWar.syncNum` as the authoritative sync source.
- Do not turn `CurrentWar` into a historical archive.

## 3) War history ownership

- `ClanWarHistory` is the canonical ended-war record.
- `SyncCycle` is the canonical guild-scoped mapping from a positive canonical sync number to the exact persisted scheduled sync time selected from the bounded prior schedule window. Ended FWA history can corroborate chronological realized sync numbering, but `ClanWarHistory.prepStartTime` is not an exact SyncCycle time and a ScheduledSyncPost alone is not proof that a realized FWA cycle occurred. SyncCycle does not own war, readiness, filler, or message lifecycle state.
- `ClanWarParticipation` is the canonical per-player ended-war participation record.
- `WarPlanComplianceEvaluation` is the canonical finalized ended-war compliance record for one guild and one war.
- `ClanWarHistory` upsert and conditional `WarPlanComplianceEvaluation` enrollment for ended FWA wars happen in one transaction once the authoritative guild scope is known.
- `WarPlanViolation` is the canonical finalized per-player violation record for one evaluation.
- `WarAttacks` is current-war operational detail only.
- `WarLookup` owns archived/raw war payloads.
- `WarPlanViolationService` owns active-runtime enrollment, canonical correction handling, durable claim/lease ownership, and bounded retry for finalized war-plan compliance history.
- Completed evaluations with unchanged canonical history are immutable; canonical match/outcome corrections may re-finalize the same evaluation id, while canonical changes away from FWA terminalize the evaluation so it leaves the retry queue.
- Reconciliation must not select rows that are currently leased by another worker.
- `/inactive` and other historical commands must read ended-war tables, not historical reuse of `WarAttacks`.

## 4) Points sync ownership

- `ClanPointsSync` is the single source of truth for points.fwafarm sync metadata.
- `/fwa match` validation must read from `ClanPointsSync` first.
- Do not reintroduce `TrackedClan.pointsScrape`-style ownership.

## 5) Feed ingestion ownership

- FWAStats JSON feed reads flow into feed-backed current-state tables, not directly into command rendering.
- `FwaFeedSyncState`, `FwaClanWarsWatchState`, and `FwaFeedCursor` own feed scheduler metadata.
- `FwaClanMatchStatsCurrent` is a recreatable derived snapshot owned by the clan-wars feed domain and rebuilt from `FwaClanWarLogCurrent`; it is not a source of raw truth.
- Commands should prefer persisted feed rows over live feed calls on hot paths.

## 6) Snapshot and reminder ownership

- `TodoPlayerSnapshot` is the authoritative render source for `/todo`.
- Current membership is owned by `clanTag`, `clanName`, and `clanMembershipObservedAt`.
- WAR is owned by `warClanTag`, `warClanName`, `warPosition`, `warSourceUpdatedAt`, `warOwnerSource`, `warOwnerWarId`, `warOwnerVerifiedAt`, `warActive`, `warPhase`, `warAttacksUsed`, `warAttacksMax`, and `warEndsAt`. `clanTag`/`clanName` are legacy WAR identity fallbacks only while `warActive=true` and dedicated `warClanTag` is absent.
- WAR ownership from tracked roster data must match the current war identity for that clan before it can influence `/todo`; `FwaTrackedClanWarRosterCurrent` carries the tracked-war identity anchor.
- RAID is owned by `raidClanTag`, `raidClanName`, `raidSourceUpdatedAt`, `raidActive`, `raidAttacksUsed`, `raidAttacksMax`, and `raidEndsAt`. `clanTag`/`clanName` are legacy RAID identity fallbacks only while `raidActive=true` and dedicated `raidClanTag` is absent.
- CWL is owned by `cwlClanTag`, `cwlClanName`, `cwlActive`, `cwlPhase`, `cwlAttacksUsed`, `cwlAttacksMax`, and `cwlEndsAt`.
- Clan Games lifecycle and progress are owned by the dedicated `gamesActive`, `gamesCycleKey`, stored baseline/point totals, and `gamesEndsAt` fields, while clan ownership for GAMES intentionally remains current membership through `clanTag`/`clanName`.
- Changing current clans does not rewrite an already-observed active WAR, RAID, or CWL owner.
- `TodoUserUsage` is the lightweight per-user activation owner for `/todo` background refresh eligibility.
- `CwlEventInstance` owns CWL event identity and lifecycle, while `season` remains display metadata rather than event identity.
- `CwlEventClan` owns the authoritative current-event pointer for a clan.
- `CwlEventWarTag` owns the war-tag-to-event mapping used to resolve later refreshes idempotently.
- `CurrentCwlRound` and `CwlRoundMemberCurrent` own live battle-day CWL timing and lineup truth for one event instance.
- `CurrentCwlPrepSnapshot` owns the one live overlapping prep-day lineup snapshot for one event instance when the next day is simultaneously in preparation.
- `CwlRoundHistory` and `CwlRoundMemberHistory` own ended CWL round truth for one event instance.
- `CwlPlayerClanSeason` owns the derived observed current-season CWL roster summary for one event instance.
- `CwlRotationPlan` is owned by one `CwlEventInstance` plus clan through `CwlEventClan`; `season` and `clanTag` are denormalized display/query metadata, not event identity.
- Current `/cwl rotations` commands resolve the clan's authoritative event through `CwlEventClan.isCurrent` and only read or write plans for that exact event.
- Historical CWL rotation plans remain stored on their original event instance and must not block, render in, overwrite, validate against, import into, or export from a newer same-month event.
- `CwlRotationPlanDay` and `CwlRotationPlanMember` inherit event ownership through `planId`.
- Guild and personal reminder schedulers select the clan owner appropriate to the reminder type and must not emit or inherit every clan identity present on one snapshot row. Guild reminder ownership lives in `Reminder`, `ReminderTimeOffset`, `ReminderTargetClan`, and `ReminderFireLog`.
- Personal reminder ownership lives in `UserActivityReminderRule` and `UserActivityReminderDelivery`.
- Do not rebuild broad multi-source player state synchronously in command handlers when a maintained snapshot already exists.

## 7) Messaging and idempotency

- `WarEvent` is the war-event dedupe guard.
- `SyncClanReadinessSnapshot` is the immutable, per-guild/per-scheduled-sync/per-clan ACTUAL readiness snapshot used by `SYNC_ZERO_DEVIATION`. It owns exact boundary roster/readiness facts, including explicitly designated filler membership captured from the ACTUAL roster. `fillerCaptureComplete=false` means filler history is unavailable or unknown (including legacy rows); `true` with an empty tag array means exact zero designated fillers. Retrospective/history consumers must use captured `fillerPlayerTags`, not today's mutable `FillerAccount` registry. It stores audit facts only; it does not own delivery state.
- `SyncClanMemberSnapshot` is the immutable, per-guild/per-scheduled-sync/per-clan/player ACTUAL physical-membership fact. It is intentionally separate from `AllianceClanMembershipInterval`, which remains authoritative for continuously observed alliance/CWL membership intervals. A player can validly have facts in multiple source clan contexts at one boundary; consumers must handle that ambiguity rather than collapsing the source facts.
- `HomeAwaySyncAlertSchedule` owns one durable randomized pre-sync Away-alert lifecycle for an upcoming `ScheduledSyncPost`; `HomeAwaySyncAlertDelivery` owns immutable per-user content, claims, retries, and terminal delivery state. These tables do not own Home membership or current presence.
- `SyncRetrospectiveService` is a DB-first, read-only consumer of `SyncCycle`, `ClanWarHistory`, `ClanWarParticipation`, `WarLookup`, persisted compliance, and mapped readiness snapshots. It preserves unknown coverage rather than converting incomplete evidence to zero and must not infer filler history from mutable registries or membership intervals.
- `MembershipStreakService` is a DB-first, read-only bulk consumer for derived clan/alliance streak analytics. It unions database-distinct canonical `SyncCycle`, readiness, and member-snapshot boundaries, requires adjacent loaded boundaries to have consecutive canonical `SyncCycle.syncNumber` identities, and never bridges sparse, missing, or contradictory canonical boundaries. It uses exact `SyncClanMemberSnapshot` coverage before historical fallback (including authoritative physical absence), resolves fallback participation through canonical `ClanWarHistory` rather than raw `ClanPointsSync.warId`, and never writes calculated counters or creates a new state owner.
- `HomeMembershipAnalyticsService` is a DB-first, read-only bulk combiner for `/link list` Home analytics. It reads active `ClanHomeMembershipPeriod` rows through `ClanHomeMembershipService` and uses one `MembershipStreakService` batch to derive non-persisted C/S/A values from the canonical boundary universe. C is credited only to the current Home period; S remains the physical current-clan streak and A remains the recognized-alliance streak, independent of Home. Temporary Away/physical moves do not reset C, `+` preserves per-metric lower bounds, and no active Home leaves C unavailable while safely resolved S/A remain visible.
- `ClanHomeMembershipService` owns active Home-period reads and automatic establishment. It requires three consecutive exact non-filler `SyncClanMemberSnapshot` boundaries in the same currently tracked clan with complete historical filler capture; fallback participation and alliance intervals cannot qualify Home, and an active Home is never overwritten or ended by this automation.
- `HomeRosterService` is the read-only leadership read model for active Home periods. It counts only active `ClanHomeMembershipPeriod` rows for reserved slots, classifies `FwaFeedSyncState(feedType=CLAN_MEMBERS, scopeType=CLAN_TAG).lastSuccessAt` with the configured cadence freshness budget, and derives Present/Away only from CURRENT coverage plus `FwaClanMemberCurrent`; STALE and UNAVAILABLE coverage remains Unknown and does not expose current physical counts. It bulk-enriches Away locations only from fresh, authoritative, non-contradictory persisted `PlayerCurrent` evidence, uses deterministic DB name fallbacks, and annotates only pending `ClanHomeTransferCandidate` rows tied to the active Home period without mutating them. Present/Away/Unknown is never persisted.
- `ClanHomeMembershipService` also owns bulk pending-transfer reads, candidate creation, and Keep Home/Confirm Transfer domain decisions. A pending `ClanHomeTransferCandidate` never changes Home; confirmation transactionally validates the active source period and permanent destination, retains old Home history, and creates the successor `TRANSFER` period. Transfer qualification requires three ordinary exact boundaries and shared persisted CWL timing suppresses CWL or unresolved timing.
- `ClanWarParticipation` is historical FWA fallback evidence only for older canonical boundaries that lack exact member snapshots. It must be admitted through unambiguous guild-scoped canonical ownership, tagged internally as `FWA_WAR_PARTICIPATION_FALLBACK`, and is never backfilled into or written as `SyncClanMemberSnapshot`.
- `FillerAccount` remains the mutable guild-scoped filler-designation registry. `SyncClanReadinessSnapshot` remains the owner of exact filler-at-sync facts; neither membership-history table stores or infers filler status.
- `SyncEvent` is the sync-scoped claim/delivery owner for scheduled-sync clan goals and automatic sync retrospectives. It is distinct from `WarEvent` and never fabricates a war identity. For alliance-scoped event types, including `sync_retrospective:auto_post`, `clanTag=""` is reserved; the unique identity is `guildId + syncTime + clanTag + eventType`. These events own delivery claims, leases, terminal status, and retry state only. They do not own sync identity, participation, war history, readiness, filler facts, or retrospective metrics.
- `ClanPointsSync` is the participating-clan cohort for automatic sync-retrospective completion. `ClanWarHistory` is the canonical ended-war proof, `SyncCycle` owns sync-number/sync-time identity, and `BotSetting` through `BotLogChannelService` owns routing plus the durable no-backfill enable boundary.
- `ClanPostedMessage` tracks posted notify/mail messages.
- `WarMailLifecycle` owns active-war mail send lifecycle state, keyed by the full active-war identity instead of `warId` alone.
- `TrackedMessage` owns long-lived tracked posts such as sync-time and base-swap flows.
- `RepWorkActivityEvent` owns durable rep-work attribution snapshots only. It does not own mail lifecycle, sync claims, base-swap active state, or command telemetry.
- Do not collapse these responsibilities into one generic table or back into config blobs.

## 8) Notification routing

- `TrackedClan` owns default clan metadata plus default mail/log/notify destinations.
- `TrackedClan.leaderChannelId` and `TrackedClan.leadRoleId` remain the routing owner for the FWA weight-alert policy in `FwaWeightAlertConfig`; the policy table owns only enablement and threshold.
- `FwaWeightAlertDelivery` owns only durable per-clan/per-weight-submission-date claim and delivery state; it does not duplicate alert policy or routing fields.
- `ClanNotifyConfig` owns per-guild notify overrides.
- `CurrentWar` may materialize per-war runtime notify flags derived from those persisted configs.
- Do not add new notification ownership fields without explicit approval.

## 9) Command determinism and performance

Hot command paths must remain fast and predictable.

Rules:

- Preferred hierarchy is: database -> cache -> external API.
- Hot commands must avoid external HTTP calls on the render path whenever persisted state already exists.
- Poll loops must avoid N+1 database patterns.
- Prefer bulk reads followed by in-memory mapping.
- Poll loops and schedulers must stay bounded by tracked scope.
- Split `/todo` background refreshes by cadence: faster tracked-clan refresh for activated users in tracked clans, slower observe refresh for activated users outside tracked clans.

Preferred pattern:

1 query -> in-memory map -> command rendering

Avoid patterns like:

for each clan:
database query

## 10) Telemetry and health

- Health endpoints must stay cheap, side-effect free, and safe for frequent probes.
- Telemetry aggregate/report tables are observability state, not command-domain source of truth.
- Add telemetry to important command and scheduler paths without making commands depend on telemetry writes to succeed.

## 11) Schema evolution safety

When changing table ownership:

1. Introduce the new owner table.
2. Migrate reads to the new table.
3. Backfill data if necessary.
4. Remove the old ownership field.

Never switch ownership in a single step.

## 12) Change safety rule

If a requested change appears to conflict with any rule above:

1. Stop.
2. Explain the conflict.
3. Ask for explicit approval before implementing.

## Expected scale

The system should remain stable with:

- 50-100 tracked FWA clans
- seasonal CWL registries and linked-player snapshot workloads
- thousands of war participation rows and growing archived history
- growing reminder, telemetry, and feed-state tables
- years of historical data

Design decisions should prefer long-term clarity over short-term convenience.
