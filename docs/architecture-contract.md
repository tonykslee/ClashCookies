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
FwaClanWarLogCurrent
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

Reminder / UserActivityReminder config
    + TodoPlayerSnapshot / CurrentWar
    ->
Reminder schedulers
    ->
ReminderFireLog / UserActivityReminderDelivery

Operational state:

TrackedMessageService -> TrackedMessage / TrackedMessageClaim
TelemetryIngestService -> Telemetry aggregates / report schedules
UnlinkedMemberAlertService -> UnlinkedAlertConfig / UnlinkedPlayer

Mirror runtime:

Prod runtime allowlist
    ->
MirrorSyncService
    ->
Staging runtime mirrors

Commands:

Read from CurrentWar + ClanPointsSync + TodoPlayerSnapshot + feed-backed tables + other persisted owners

## 0) State ownership map (single source of truth)

Each domain concept must have exactly one authoritative owner.

| Concept | Owner |
| --- | --- |
| Tracked FWA clans | TrackedClan |
| Seasonal CWL tracked clans | CwlTrackedClan |
| Live/prep CWL round identity and timing | CurrentCwlRound |
| Live/prep CWL round member summaries | CwlRoundMemberCurrent |
| Ended CWL round canonical history | CwlRoundHistory |
| Ended CWL round member history | CwlRoundMemberHistory |
| Derived current-season CWL roster summary | CwlPlayerClanSeason |
| Current-season CWL planner state | CwlRotationPlan, CwlRotationPlanDay, CwlRotationPlanMember |
| Player-to-Discord links | PlayerLink |
| Live war state | CurrentWar |
| Ended-war canonical record | ClanWarHistory |
| Ended-war player participation | ClanWarParticipation |
| Current-war attack detail | WarAttacks |
| Archived war payloads | WarLookup |
| Points sync metadata | ClanPointsSync |
| War event idempotency | WarEvent |
| Posted notify/mail messages | ClanPostedMessage |
| Active-war mail lifecycle | WarMailLifecycle |
| Notify overrides | ClanNotifyConfig |
| Todo render snapshots | TodoPlayerSnapshot |
| Guild reminder config and dedupe | Reminder, ReminderTimeOffset, ReminderTargetClan, ReminderFireLog |
| Personal reminder config and dedupe | UserActivityReminderRule, UserActivityReminderDelivery |
| Tracked reusable posts and claims | TrackedMessage, TrackedMessageClaim |
| FWA feed current state | FwaClanCatalog, FwaPlayerCatalog, FwaClanMemberCurrent, FwaWarMemberCurrent, FwaClanWarLogCurrent |
| FWA feed scheduler metadata | FwaFeedSyncState, FwaClanWarsWatchState, FwaFeedCursor |
| Unlinked alert routing and unresolved members | UnlinkedAlertConfig, UnlinkedPlayer |
| Telemetry rollups and scheduled reports | TelemetryCommandAggregate, TelemetryUserCommandAggregate, TelemetryApiAggregate, TelemetryStageAggregate, TelemetryReportSchedule, TelemetryReportRun |
| Police-handled dedupe | FwaPoliceHandledViolation |

Rules:

- Do not duplicate ownership fields across tables.
- Do not store derived data where it can be queried from the owner.
- If a field appears in multiple tables, document which copy is authoritative and mark every other copy as derived or transitional.

## 1) Runtime ownership model

- `POLLING_MODE=active` owns upstream pollers and schedulers.
- `POLLING_MODE=mirror` must not duplicate upstream polling or reminder ownership.
- Mirror mode may only run guarded prod-to-staging snapshot sync for the allowlisted runtime tables.
- Derived runtime tables must be recreatable from active pollers or guarded mirror sync.

## 2) CurrentWar role

- `CurrentWar` stores live war state only.
- `CurrentWar` may hold materialized per-war notify and mail runtime flags, but those values are derived from persisted config.
- Do not treat `CurrentWar.syncNum` as the authoritative sync source.
- Do not turn `CurrentWar` into a historical archive.

## 3) War history ownership

- `ClanWarHistory` is the canonical ended-war record.
- `ClanWarParticipation` is the canonical per-player ended-war participation record.
- `WarAttacks` is current-war operational detail only.
- `WarLookup` owns archived/raw war payloads.
- `/inactive` and other historical commands must read ended-war tables, not historical reuse of `WarAttacks`.

## 4) Points sync ownership

- `ClanPointsSync` is the single source of truth for points.fwafarm sync metadata.
- `/fwa match` validation must read from `ClanPointsSync` first.
- Do not reintroduce `TrackedClan.pointsScrape`-style ownership.

## 5) Feed ingestion ownership

- FWAStats JSON feed reads flow into feed-backed current-state tables, not directly into command rendering.
- `FwaFeedSyncState`, `FwaClanWarsWatchState`, and `FwaFeedCursor` own feed scheduler metadata.
- Commands should prefer persisted feed rows over live feed calls on hot paths.

## 6) Snapshot and reminder ownership

- `TodoPlayerSnapshot` is the authoritative render source for `/todo`.
- `TodoUserUsage` is the lightweight per-user activation owner for `/todo` background refresh eligibility.
- `CurrentCwlRound` and `CwlRoundMemberCurrent` own current/prep CWL timing and lineup truth.
- `CwlRoundHistory` and `CwlRoundMemberHistory` own ended CWL round truth.
- `CwlPlayerClanSeason` owns the derived observed current-season CWL roster summary.
- `CwlRotationPlan*` owns current-season planner artifacts only, and sheet import/export commands treat those rows as the active planner source once confirmed.
- Guild reminder ownership lives in `Reminder`, `ReminderTimeOffset`, `ReminderTargetClan`, and `ReminderFireLog`.
- Personal reminder ownership lives in `UserActivityReminderRule` and `UserActivityReminderDelivery`.
- Do not rebuild broad multi-source player state synchronously in command handlers when a maintained snapshot already exists.

## 7) Messaging and idempotency

- `WarEvent` is the war-event dedupe guard.
- `ClanPostedMessage` tracks posted notify/mail messages.
- `WarMailLifecycle` owns active-war mail send lifecycle state.
- `TrackedMessage` owns long-lived tracked posts such as sync-time and base-swap flows.
- Do not collapse these responsibilities into one generic table or back into config blobs.

## 8) Notification routing

- `TrackedClan` owns default clan metadata plus default mail/log/notify destinations.
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
