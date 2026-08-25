IMPORTANT:
Before implementing any code changes, read:

- architecture-contract.md
- core-priorities.md

# ClashCookies - Project Brain

This file defines the architectural context for the project.
All AI tasks should read this file before making changes.

Related documents:
- docs/core-priorities.md
- docs/architecture-contract.md
- docs/deployment.md
- docs/observability.md

---

# Project Goals

Primary goals:

1. Reliable FWA and CWL tooling for Discord clans
2. Deterministic war, mail, and notify handling
3. Fast DB-first command response times
4. Clear state ownership boundaries
5. Safe schema and platform evolution
6. Strong operational visibility for production and staging

---

# System Architecture Overview

High-level runtime model:

- The Discord command surface renders primarily from persisted state.
- Active runtime instances own upstream pollers, schedulers, and refresh loops.
- Mirror runtime instances do not own upstream polling; they mirror a guarded runtime-table allowlist from production for staging-safe reads.
- Active runtime owns war-plan enrollment, finalization, and bounded retry through `WarPlanViolationService`; mirror runtime only mirrors the resulting tables.
- The app exposes health endpoints and emits internal telemetry in addition to the external droplet observability stack.

Core subsystems:

- War state: `TrackedClan -> WarEventLogService/poll loops -> CurrentWar -> ClanWarHistory / ClanWarParticipation / WarPlanComplianceEvaluation / WarPlanViolation / WarAttacks / WarLookup / WarEvent / WarMailLifecycle / ClanPostedMessage`
- Scheduled sync clan goal: `ScheduledSyncPostSchedulerService -> loadCompoActualStateContext + shared ACTUAL projection -> SyncClanReadinessSnapshot -> SyncEvent -> ClanGoalService -> /bot-logs type:clan-goals`; the scheduler owns cadence, the snapshot owns canonical immutable sync facts including exact designated filler tags present in the ACTUAL roster, and `SyncEvent` owns only sync-goal delivery idempotency. A canonical ended FWA war corroborates its persisted `ClanWarHistory.syncNumber` through chronological prep clustering, while `SyncCycle` remains the owner of the exact persisted scheduled sync time; prep time is never used as that exact boundary. `SyncRetrospectiveService` reads that mapping and the persisted evidence DB-first without Discord, writes, or mutable filler-registry inference. `SyncRetrospectiveAutoPostService` is a separate reconciliation phase in the same scheduler: `ClanPointsSync` defines participating clans, canonical ended `ClanWarHistory` rows prove completion, `SyncEvent` with `clanTag=""` owns once-only delivery, and the existing retrospective renderer supplies the public message.
- Pre-sync Home return alerts: `ScheduledSyncPost -> HomeAwaySyncAlertService -> HomeAwaySyncAlertSchedule / HomeAwaySyncAlertDelivery`; the service persists one randomized five-to-seven-hour fire window per upcoming sync, evaluates only authoritative `HomeRosterService` Away rows when due, bulk-routes linked accounts through `PlayerLink`, stores immutable per-user content, and claims/retries Discord delivery in active mode. Mirror mode copies the durable alert rows but never evaluates or sends them.
- Points sync: `points.fwafarm -> PointsSyncService -> ClanPointsSync`
- Feed-backed current state: `FWAStats JSON feeds -> FwaFeedSchedulerService -> FwaClanCatalog / FwaPlayerCatalog / FwaClanMemberCurrent / FwaWarMemberCurrent / FwaTrackedClanWarRosterCurrent / FwaTrackedClanWarRosterMemberCurrent / FwaClanWarLogCurrent / FwaClanMatchStatsCurrent / HeatMapRef`
- FWA weight alerts: `FwaClanCatalog.weightSubmitDate + FwaWeightAlertConfig + TrackedClan routing -> FwaWeightAlertDeliveryService -> FwaWeightAlertDelivery`; `FwaWeightAlertConfig` owns per-clan enablement and stale-age threshold, `TrackedClan.leaderChannelId` / `TrackedClan.leadRoleId` own routing, and `FwaClanCatalog.weightSubmitDate` remains the authoritative persisted submission date used for evaluation. The existing FWA Clans.json scheduler invokes the evaluator after `SUCCESS` or `NOOP`; there is no separate alert poller, and mirror/staging runtimes do not send.
- Historical observed alliance membership: `production activity observation -> AllianceClanMembershipInterval`; this table owns historical observed alliance clan-membership intervals for later camping analytics and future read-only reporting, while `PlayerCurrent` and `FwaClanMemberCurrent` remain current-state owners. `/cwl activity` does not read this table.
- Read-only membership streak analytics: `SyncCycle + SyncClanReadinessSnapshot / SyncClanMemberSnapshot + guild-scoped canonical FWA history/participation fallback + AllianceClanMembershipInterval -> MembershipStreakService`; this is a bounded bulk DB-first reader for physical FWA clan streaks and monitored-alliance streaks. Exact snapshots win over fallback, adjacent streak boundaries require consecutive canonical `SyncCycle.syncNumber` values, and sparse, missing, or contradictory canonical boundaries are never bridged. Historical participation fallback resolves through canonical `ClanWarHistory`, not raw `ClanPointsSync.warId`; no derived streak counters are persisted, and `ClanWarParticipation` is never written into `SyncClanMemberSnapshot`.
- Read-only Home membership analytics: `ClanHomeMembershipPeriod + MembershipStreakService batch -> HomeMembershipAnalyticsService -> /link list Tenure`; C counts canonical boundaries from the current active Home start, S is the authoritative consecutive streak in the current physical clan, and A is the authoritative monitored-alliance streak. C requires an active Home, while S/A remain independently available when physical evidence is safely resolved. Counters are derived only, temporary Away/physical moves do not reset C, and lower bounds use `+`.
- Durable Home membership and transfer decisions: `SyncClanMemberSnapshot + SyncClanReadinessSnapshot historical filler facts + TrackedClan + persisted CWL event/round timing -> ClanHomeMembershipService -> ClanHomeMembershipPeriod / ClanHomeTransferCandidate`; active production reconciliation establishes an account/player Home only after three consecutive exact non-filler boundaries in one permanent tracked clan, and creates a pending transfer candidate only after three consecutive ordinary exact boundaries in a different permanent tracked clan. `HomeRosterService` provides the read-only `/clan-health` Home Roster leadership surface from active Home periods, fresh CURRENT persisted CLAN_MEMBERS coverage, `FwaClanMemberCurrent`, fresh authoritative persisted `PlayerCurrent`, and bulk name/candidate reads. STALE or UNAVAILABLE coverage is explicitly Unknown, and pending candidates must belong to the active Home period. The ephemeral View Transfers panel re-reads that model for deterministic paging and routes Keep Home or Confirm Transfer through `ClanHomeMembershipService` with guild/Home-clan scope revalidation. Pending candidates never change Home; Keep Home requires three fresh post-decision boundaries, and Confirm Transfer transactionally ends the old Home and creates a `TRANSFER` successor. Mirror mode may render the read-only surfaces but cannot decide transfers. No current Away/Present/Unknown state is persisted, and staging mirrors the history read-only.
- Read-only CWL alliance activity reporting: `CwlEventInstance / CwlEventClan / persisted CWL round/history owners / CwlPlayerClanSeason / ClanWarHistory / ClanWarParticipation -> CwlAllianceActivityService -> /cwl activity`; the service derives deterministic report cohorts without writes, external API calls, `AllianceClanMembershipInterval` reads, or ownership changes.
- Read-only CWL camping reporting: `AllianceClanMembershipInterval + CwlAllianceActivityService historical home attribution/CWL window + CwlTrackedClan -> CwlAllianceCampingService -> /cwl camping`; the service measures observed non-home CWL-clan residence, keeps unattributed evidence separate, reconciles overlaps without writes, and is not a state owner.
- Snapshot-backed todo: `PlayerLink + TodoUserUsage + CurrentWar + CurrentCwlRound/CwlRoundMemberCurrent + activity signals -> TodoSnapshotService -> TodoPlayerSnapshot`, with event-owned WAR/RAID/CWL context plus Clan Games lifecycle state whose clan ownership remains current membership, so stale event state can be cleared independently of the latest clan observation.
- Roster signup foundation: `RosterService -> Roster / RosterGroup / RosterSignup / RosterGuildConfig`, with `visitorSignupOpensAt` now persisted as nullable roster metadata for later signup-window enforcement and roster-post display work and now configurable through `/roster create` and `/roster edit`. Public roster posts display the configured visitor signup status line from the shared roster payload builder: before opening they show the full and relative Discord timestamp, at or after opening they show `Open`, and null opening time omits the line entirely. The public `Signup` panel enforces the delayed visitor window before it opens account selection, and the final public confirmation now revalidates the same delayed-signup policy immediately before signup mutations commit. `RosterService` owns the pure delayed-signup eligibility policy that consumes already-resolved `visitorSignupOpensAt`, configured delayed roles, alliance-member precedence, manager bypass, and the exact `now < visitorSignupOpensAt` / `now >= visitorSignupOpensAt` boundary. Guild-scoped default roster board columns now live in `RosterGuildConfig`, while explicit per-roster `displayColumns` stays authoritative for customized boards. Discord/config resolution failures for the public gate fail open with bounded logging, valid confirmation-time policy blocks consume the stale selection session and stop the mutation, existing signups and opt-out remain unaffected, roster-post rendering is shared by initial post and refresh flows, no scheduler automatically edits the message at the opening instant, and panel opening/final confirmation enforcement remain authoritative.
- Roster delayed-signup config: `AutoRoleGuildConfig -> delayedSignupRoleIds`, with multiple Discord roles persisted for later delayed-signup policy use. It is configurable through `/roster delayed-signup-role add|remove|list|clear`, while `nonMemberRoleId` remains the separate existing autorole control.
- Persisted CWL state: `CwlEventInstance / CwlEventClan / CwlEventWarTag -> CwlTrackedClan -> CwlStateService -> CurrentCwlRound / CwlRoundMemberCurrent / CurrentCwlPrepSnapshot / CwlRoundHistory / CwlRoundMemberHistory / CwlPlayerClanSeason`, with event identity authoritative and `season` treated as display metadata.
- CWL planner state: `CwlEventClan.isCurrent -> CurrentCwlRound + CwlRoundMemberCurrent + CurrentCwlPrepSnapshot + CwlPlayerClanSeason -> CwlRotationService -> CwlRotationPlan / CwlRotationPlanDay / CwlRotationPlanMember`, with each plan owned by one CWL event instance and clan. `season` is display metadata; historical same-month event plans are retained but ignored by current commands.
- The active CWL alliance activity report is `CwlAllianceActivityService`, a read-only consumer of persisted CWL event/round/history owners, `CwlPlayerClanSeason`, `ClanWarHistory`, and `ClanWarParticipation`. Historical pre-CWL cohorts are derived DB-first from canonical war history. It does not consume `AllianceClanMembershipInterval`, which remains the sole owner of observed membership-duration history for `/cwl camping` and future read-only reporting. No manual/frozen CWL alliance baseline owner remains.
- Reminder delivery: `Reminder/UserActivityReminder config + snapshots/current war -> reminder schedulers -> delivery logs`
- Operational state: `TrackedMessage`, unlinked-alert persistence, telemetry aggregates, report schedules

---

# State Ownership

Each domain concept has a single authoritative owner.

Important owners:

| Concept | Owner |
| --- | --- |
| CWL event identity | CwlEventInstance |
| CWL clan-to-current-event pointer | CwlEventClan |
| CWL war-tag-to-event mapping | CwlEventWarTag |
| Tracked FWA clans and clan-owned Discord destinations | TrackedClan |
| Generic Clash layout link lifecycle, freshness, and post provenance | LayoutRecord |
| Canonical FWA `(Townhall, Type)` layout designation | FwaLayouts |
| Per-clan FWA weight-alert policy (enablement and stale-age threshold) | FwaWeightAlertConfig |
| Durable per-clan/date FWA weight-alert delivery claims and outcomes | FwaWeightAlertDelivery |
| Tracked FWA clan rep accounts | TrackedClanRep |
| Tracked FWA clan rep user profile metadata | TrackedClanRepUserProfile |
| Seasonal CWL tracked clans | CwlTrackedClan |
| Live battle-day CWL round identity and timing | CurrentCwlRound |
| Live battle-day CWL round member summaries | CwlRoundMemberCurrent |
| Live overlapping prep-day CWL snapshot | CurrentCwlPrepSnapshot |
| Ended CWL round history | CwlRoundHistory |
| Ended CWL round member history | CwlRoundMemberHistory |
| Derived observed CWL season roster | CwlPlayerClanSeason |
| CWL event-scoped child rows | CurrentCwlRound, CwlRoundMemberCurrent, CurrentCwlPrepSnapshot, CwlRoundHistory, CwlRoundMemberHistory, CwlPlayerClanSeason, CwlSeasonRosterState |
| CWL event-owned planner artifacts | CwlRotationPlan* tables |
| Historical observed alliance clan-membership intervals | AllianceClanMembershipInterval |
| Immutable scheduled-sync FWA physical-membership facts | SyncClanMemberSnapshot |
| Current player state | PlayerCurrent |
| Current FWA clan roster state | FwaClanMemberCurrent |
| Read-only CWL alliance activity reporting | CwlAllianceActivityService (consumer only; no interval/current-state writes) |
| Player-to-Discord links | PlayerLink |
| Live war state | CurrentWar |
| Ended-war canonical record | ClanWarHistory |
| Canonical sync-number to scheduled-sync-time identity | SyncCycle |
| Ended-war participation | ClanWarParticipation |
| Finalized war-plan evaluation | WarPlanComplianceEvaluation |
| Finalized war-plan player violation | WarPlanViolation |
| Points sync metadata | ClanPointsSync |
| Scheduled-sync clan readiness and exact filler-at-sync facts | SyncClanReadinessSnapshot |
| DB-first Sync Retrospective read model | SyncRetrospectiveService (consumer only; no writes) |
| Derived clan/alliance streak analytics | MembershipStreakService (consumer only; no writes or persisted counters) |
| Durable Home Clan membership periods | ClanHomeMembershipPeriod (active production reconciler writes; mirror only copies) |
| Proposed Home transfer and leader-decision history | ClanHomeTransferCandidate (production reconciler/decision APIs write; mirror only copies) |
| Mutable guild-scoped filler designations | FillerAccount |
| Scheduled-sync clan-goal and retrospective delivery claims | SyncEvent |
| Posted notify/mail messages | ClanPostedMessage |
| Active-war mail lifecycle | WarMailLifecycle |
| Active-runtime war-plan finalization/retry | WarPlanViolationService |
| Todo activation gate | TodoUserUsage |
| Todo render snapshots | TodoPlayerSnapshot (current membership, WAR, RAID, CWL, and Clan Games render context) |
| Guild reminders | Reminder* tables |
| Personal reminders | UserActivityReminder* tables |
| Delayed-signup role IDs | AutoRoleGuildConfig.delayedSignupRoleIds |
| Tracked long-lived posts | TrackedMessage* tables |
| FWA feed current-state tables | Fwa* current-state tables, including derived recreatable snapshots like `FwaClanMatchStatsCurrent` |
| FWA compo reference bands | HeatMapRef |
| Telemetry rollups and report schedules | Telemetry* tables |

`FwaWeightAlertConfig` owns per-clan alert enablement and stale-age threshold policy. `FwaWeightAlertDelivery` owns the durable per-clan/per-`weightSubmitDate` claim, retry, and Discord delivery outcome. Routing continues to be read from `TrackedClan.leaderChannelId` and `TrackedClan.leadRoleId`; neither routing field is copied into the alert tables. `FwaClanCatalog.weightSubmitDate` remains the authoritative persisted submission date used for stale-age evaluation. After each fresh Clans.json sync reports `SUCCESS` or `NOOP`, the active runtime evaluates enabled policies and may deliver claimed episodes; mirror/staging runtime never sends, and no separate alert scheduler or poller exists.

Do not duplicate ownership across tables.

`LayoutRecord` owns tracked Clash layout links, explicit submission/confirmation freshness, and Discord post provenance. `FwaLayouts` continues to own the canonical FWA `(Townhall, Type)` designation. The nullable `FwaLayouts.layoutId` relation is transitional only: current `LayoutLink`, `ImageUrl`, and `LastUpdated` fields remain legacy ownership, existing rows are not backfilled yet, and current FWA consumers remain unchanged. Layout freshness is `lastConfirmedAt ?? submittedAt`; Prisma `updatedAt`, `LastUpdated`, Discord message time, clicks, and reads are not freshness sources.

`AllianceClanMembershipInterval` remains the owner of observation-based, continuously observed alliance/CWL clan-membership intervals. `SyncClanMemberSnapshot` owns the separate immutable scheduled-sync FWA physical-membership fact for each normalized clan/player roster entry. They are different concepts, not competing owners: the former describes observed residence over time, while the latter describes exact membership available at one scheduled boundary. The sync snapshot deliberately contains no filler status; `SyncClanReadinessSnapshot` owns filler membership by intersecting the boundary's explicit `FillerAccount` registry read with that same boundary's ACTUAL roster.

---

# Polling Model

- Active mode owns external pollers and schedulers.
- Mirror mode is read-oriented and only runs guarded prod-to-staging snapshot sync for the runtime allowlist.
- Mirror mode does not capture sync-boundary readiness snapshots, claim sync-goal or retrospective events, or deliver scheduled-sync clan goals or automatic retrospectives.
- `AllianceClanMembershipInterval` and `SyncClanMemberSnapshot` are both included in the full-overwrite mirror allowlist. Active production remains the only writer/observer; mirror mode copies persisted rows for staging reads and performs no membership-history polling or writes.
- Expensive upstream fetches should happen in background services, not in user-facing commands.
- Derived tables and snapshots must be recreatable by their owning service.
- Mirror runtime should include runtime-owned CWL round/history tables, event identity tables, and planner tables when staging needs consistent `/cwl` rendering against mirrored prod data.

---

# Command Performance Expectations

Hot commands must remain fast.

Examples:

- `/fwa match`
- `/todo`
- `/inactive`

Rules:

- Avoid external HTTP calls inside hot command render paths when persisted state already exists.
- Prefer DB reads over live API calls.
- Use bulk reads instead of per-clan or per-player fan-out.
- Keep schedulers and poll loops bounded by tracked scope.

---

# Deployment Model

Current production and staging deployments are droplet-based.

- Production runs in active polling mode.
- Staging runs in mirror mode against production runtime data.
- The app exposes `/livez` and `/healthz`.
- External observability on the droplet is documented separately in `docs/observability.md`.

When deployment assumptions change, update:

- `README.md`
- `docs/deployment.md`
- `docs/observability.md`

---

# Schema Evolution Rules

When changing ownership of a field:

1. Introduce the new table.
2. Migrate reads.
3. Backfill data.
4. Remove old ownership.

Never perform ownership swaps in a single step.

---

# Expected Scale

Design should support:

- 50-100 tracked FWA clans
- seasonal CWL registries
- thousands of wars and participation rows
- growing reminder, telemetry, tracked-message, and feed-state tables
- years of historical data

---

# Working Style

Follow repository workflow defined in:

docs/core-priorities.md

Important expectations:

- feature branches only
- small commits
- tests required when behavior changes
- documentation updated for user-facing, architectural, runtime, or platform changes

---

# If Architectural Conflict Appears

Stop and explain the conflict.

Do not implement changes that violate architecture rules without explicit approval.
