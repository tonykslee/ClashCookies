IMPORTANT:

> **Owner deployment decision — 2026-11-19:** The replacement broker/immutable-executor/systemd deployment project was withdrawn; the existing SSH `~/deploy-prod.sh` workflow was restored by [PR #2086](https://github.com/tonykslee/ClashCookies/pull/2086) (`f98b2c4`). A reviewed and explicitly owner-approved `dev` → `main` merge automatically deploys through this established workflow. Feature code and migrations should be production-ready before merging into `dev`; current backup/recovery/runtime checks remain release-time operator verification, not a second infrastructure project. Historical Gate 1/broker proposals below are superseded.
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
- Scheduled sync clan goal: `ScheduledSyncPostSchedulerService -> loadCompoActualStateContext + shared ACTUAL projection -> SyncClanReadinessSnapshot -> SyncEvent -> ClanGoalService -> /bot-logs type:clan-goals`; the scheduler owns cadence, the snapshot owns canonical immutable sync facts including exact designated filler tags present in the ACTUAL roster, and `SyncEvent` owns only sync-goal delivery idempotency. A canonical ended FWA war corroborates its persisted `ClanWarHistory.syncNumber` through chronological prep clustering, while `SyncCycle` remains the owner of the exact persisted scheduled sync time; prep time is never used as that exact boundary. During an active positively identified FWA war, an exact mapping may be read and the immediate next eligible boundary may produce a non-persisted candidate while match type is inferred; only confirmed FWA evidence may establish that candidate in `SyncCycle`, and schedule-only or ambiguous chronology never establishes a cycle. `SyncRetrospectiveService` reads that mapping and the persisted evidence DB-first without Discord, writes, or mutable filler-registry inference. `SyncRetrospectiveAutoPostService` is a separate reconciliation phase in the same scheduler: `ClanPointsSync` defines participating clans, canonical ended `ClanWarHistory` rows prove completion, `SyncEvent` with `clanTag=""` owns once-only delivery, and the existing retrospective renderer supplies the public message.
- Pre-sync Home return alerts: `ScheduledSyncPost -> HomeAwaySyncAlertService -> HomeAwaySyncAlertSchedule / HomeAwaySyncAlertDelivery / HomeAwaySyncAlertDeliveryAccount`; the service persists one randomized five-to-seven-hour fire window per upcoming sync, evaluates only authoritative `HomeRosterService` Away rows when due, bulk-routes linked accounts through `PlayerLink`, stores immutable per-user content plus normalized active-Home-period/account membership, and claims/retries Discord delivery in active mode. A successfully sent account is suppressed across later schedules until a later unambiguous exact Home `SyncClanMemberSnapshot` boundary re-arms it; failed or expired deliveries do not establish suppression. Mirror mode copies the durable alert rows but never evaluates or sends them.
- Points sync: `points.fwafarm -> PointsSyncService -> ClanPointsSync`
- FWA match points display: `/fwa match` consumes the two independent resolver results once per stale matchup and may retain already-loaded exact-war stored balances after a resolver read failure. It keeps complete safe balances visibly labeled Estimated/Persisted only when active-sync identity is established, retains finite unresolved balances with their limitation and baseline anchor, and marks each missing side independently; only the existing complete exact-war same-sync safe pair can derive an outcome or satisfy the mail outcome gate.
- Internal points estimate: `ClanPointsSync + ClanWarHistory + read-only SyncCycle chronology -> PointsEstimateResolverService`; this is a DB-first read model, not a second points owner. It first uses validated same-war evidence only when the row sync matches the resolved active sync and the active-war identity is exact, then correctly attributed opponent observations, then reconstructs from an observed/derived baseline and completed-war deltas using the shared FWA/MM/BL rules. `ClanPointsSync.warId` is a game-war identifier and is correlated to `ClanWarHistory` by exact start time plus normalized clan/counterpart identity; the history table's internal ID remains the `WarLookup` key. Fetch time alone cannot establish that a stale points page is post-war: only a correctly identified observation fetched before canonical war end with matching sync evidence may serve as a pre-war anchor, while an independently proven post-war balance is not applied again. FWA requires only verified outcome evidence, MM remains zero-delta, and BL retains its input gates. Persisted checkpoints require independently supported ended-war evidence and agreement with a safely calculable endpoint when possible; a verified outcome does not prove a website-derived numeric `pointsAfterWar`, so conflicts, unresolved baselines, absent balance anchors, post-end observations without retained provenance, absent baseline history, expected-outcome-only actuals, and opponent observations without the opponent's own history remain unsafe, and later wars never advance an unresolved baseline. Typed coverage distinguishes complete reconstruction (projection-safe), a retained last-known balance with unresolved history (diagnostic only), and no usable balance. Future/beyond-boundary rows, pre-baseline history, missing actual results, incomplete BL inputs, or contiguous-history gaps never become a confirmed current projection. Reads are clan-scoped and bounded from the selected baseline, archived team-size payloads are read only when needed, and the resolver performs no writes or points-site work. `/fwa match` may use a complete same-sync pair as visibly labeled display-only persisted/projected points/outcome evidence while the website is stale; `isEstimate` preserves resolver provenance but does not make stale-site fallback current website evidence. The pair never becomes validated website points or persistence. When the exact active FWA match type is confirmed, that same complete pair may provide the inferred WIN/LOSE required for mail eligibility, but it never bypasses inferred-match-type, manual-confirmation, identity, permission, or final-send gates; checklist/mail parity remains separate.
- Feed-backed current state: `FWAStats JSON feeds -> FwaFeedSchedulerService -> FwaClanCatalog / FwaPlayerCatalog / FwaClanMemberCurrent / FwaWarMemberCurrent / FwaTrackedClanWarRosterCurrent / FwaTrackedClanWarRosterMemberCurrent / FwaClanWarLogCurrent / FwaClanMatchStatsCurrent / HeatMapRef`
- FWA weight alerts: `FwaClanCatalog.weightSubmitDate + FwaWeightAlertConfig + TrackedClan routing -> FwaWeightAlertDeliveryService -> FwaWeightAlertDelivery`; `FwaWeightAlertConfig` owns per-clan enablement and stale-age threshold, `TrackedClan.leaderChannelId` / `TrackedClan.leadRoleId` own routing, and `FwaClanCatalog.weightSubmitDate` remains the authoritative persisted submission date used for evaluation. The existing FWA Clans.json scheduler invokes the evaluator after `SUCCESS` or `NOOP`; there is no separate alert poller, and mirror/staging runtimes do not send.
- Layout expiration alerts: `LayoutRecord freshness/provenance + LayoutAlertConfig policy -> LayoutAlertSchedulerService -> LayoutAlertDeliveryService -> LayoutAlertDelivery`; delivery is keyed by layout, immutable freshness anchor, and independent DM/CHANNEL target. The config owns policy only, default-channel routing is resolved dynamically from the canonical post guild at send time, and the delivery row owns claims, retries, actual destination, and terminal outcome. Only active production schedules and sends; mirror, staging, development, and unknown runtimes do not send.
- Historical observed alliance membership: `production activity observation -> AllianceClanMembershipInterval`; this table owns historical observed alliance clan-membership intervals for later camping analytics and future read-only reporting, while `PlayerCurrent` and `FwaClanMemberCurrent` remain current-state owners. `/cwl activity` does not read this table.
- Tenure roster authority: `SyncCycle + active-war identity/current persisted identity + WarAttacks(attackOrder=0) while an FWA war is active, or canonical ClanWarHistory + guild-owned ClanWarParticipation after archival -> MembershipStreakService`; C remains strictly the nonconsecutive FWA-roster count in Home, while S/A count verified FWA roster boundaries and use exact BL/MM own-clan roster evidence only to preserve continuity. `ClanWarParticipation` is the complete canonical ended-war own-clan roster: one row per distinct canonical participant, including zero-attack players, with its distinct player count defining roster size. `WarLookup` is archived/raw reconstruction evidence; `teamSize` metadata is compatibility/diagnostic data rather than the completeness denominator. `SyncClanMemberSnapshot`, readiness snapshots, and feed-backed current-roster tables are not tenure evidence. BL/MM is never relabeled FWA and does not change C, Home ownership, or transfers. A verified physical clan change breaks S; a verified outside-alliance BL/MM observation breaks A; leading BL/MM without a qualifying FWA anchor does not create a streak. Persisted player-specific CWL roster plus alliance-interval and exact event-owned round-lifecycle timing proof can make an existing UNKNOWN/ABSENT boundary neutral for S/A only; a neutral boundary preserves but never increments. FWA evidence, canonical gaps, C, Home ownership, and persisted state remain unchanged. Incomplete newest coverage remains pending/UNKNOWN. The one-time participation repair is all-or-nothing per canonical war and may append only a safely reconstructed full roster; it never creates SyncCycles, counters, snapshots, or Home rows.
- Home tenure analytics: `ClanHomeMembershipPeriod + MembershipStreakService batch -> HomeMembershipAnalyticsService -> /link list Tenure`; C is the nonconsecutive count of canonical FWA-roster observations in the current Home clan across available canonical history, while S is the FWA-counted physical-clan streak bridged by verified BL/MM continuity and A is the FWA-counted tracked-alliance streak bridged by verified tracked-clan BL/MM continuity. An authoritative latest BL/MM observation may preserve prior S/A display values without incrementing them; pending newest coverage preserves prior displayed values.
- Read-only membership streak analytics: `SyncCycle + shared active-war identity + WarAttacks(attackOrder=0) / ClanWarHistory + ClanWarParticipation -> MembershipStreakService`; this is a bounded bulk DB-first reader for canonical-sync physical-clan and monitored-alliance streaks. The existing FWA canonicalization is unchanged; a separate BL/MM reader validates exact history/roster identity, guild ownership, match type, and safe roster completeness for the player batch and canonical sync window, then supplies continuity-only evidence. Orphaned or unrelated history rows are ignored unless guild-owned player/war participation makes them relevant; BL/MM roster omission alone does not prove global alliance absence, while a verified outside-alliance physical observation does. Active rows are used only after exact persisted identity resolution; ended participation is joined through canonical guild-scoped history; UNKNOWN and ambiguous coverage remain unresolved; adjacent streak boundaries require consecutive canonical `SyncCycle.syncNumber` identities; verified FWA/BL/MM membership takes precedence over a CWL-neutral marker, but only verified FWA increments and verified BL/MM preserves. Persisted CWL continuity proof can skip only an otherwise UNKNOWN/ABSENT boundary for S/A, and a neutral boundary preserves but never increments. If the CWL end is unresolved, the exact player/event boundary must still be covered by that event's persisted round lifecycle coverage; registry, event-instance, clan, fetch, and source-observation timestamps cannot extend it. Pre-CWL queueing instead relies on an interval continuing into the resolved start. No derived streak counters are persisted.
- Read-only Home membership analytics: `ClanHomeMembershipPeriod + MembershipStreakService batch -> HomeMembershipAnalyticsService -> /link list Tenure`; C is the nonconsecutive count of resolved FWA-roster observations matching the current Home clan across available canonical history; the Home period selects the Home clan but its `startedAtSyncTime` is not the historical C floor. S is the authoritative FWA-counted streak in one physical clan bridged by verified BL/MM evidence, and A is the authoritative FWA-counted streak in tracked alliance clans bridged by verified tracked-clan BL/MM evidence. C requires an active Home, while S/A remain independently available when physical evidence is safely resolved. Unknown historical coverage produces a lower-bound C rather than guessed membership, pending newest coverage preserves prior displayed values, counters are derived only, and temporary Away/physical moves do not reset C.
- Durable Home membership and transfer decisions: `SyncClanMemberSnapshot + SyncClanReadinessSnapshot historical filler facts + TrackedClan + persisted CWL event/round timing -> ClanHomeMembershipService -> ClanHomeMembershipPeriod / ClanHomeTransferCandidate`; active production reconciliation establishes an account/player Home only after three consecutive exact non-filler boundaries in one permanent tracked clan, and creates a pending transfer candidate only after three consecutive ordinary exact boundaries in a different permanent tracked clan. `HomeRosterService` provides the read-only `/clan-health` Home Roster leadership surface from active Home periods, fresh CURRENT persisted CLAN_MEMBERS coverage, `FwaClanMemberCurrent`, fresh authoritative persisted `PlayerCurrent`, and bulk name/candidate reads. STALE or UNAVAILABLE coverage is explicitly Unknown, and pending candidates must belong to the active Home period. The ephemeral View Transfers panel re-reads that model for deterministic paging and routes Keep Home or Confirm Transfer through `ClanHomeMembershipService` with guild/Home-clan scope revalidation. Pending candidates never change Home; Keep Home requires three fresh post-decision boundaries, and Confirm Transfer transactionally ends the old Home and creates a `TRANSFER` successor. Mirror mode may render the read-only surfaces but cannot decide transfers. No current Away/Present/Unknown state is persisted, and staging mirrors the history read-only.
- Read-only CWL alliance activity reporting: `CwlEventInstance / CwlEventClan / persisted CWL round/history owners / CwlPlayerClanSeason / ClanWarHistory / ClanWarParticipation -> CwlAllianceActivityService -> /cwl activity`; the service derives deterministic report cohorts without writes, external API calls, `AllianceClanMembershipInterval` reads, or ownership changes.
- Read-only CWL camping reporting: `AllianceClanMembershipInterval + CwlAllianceActivityService historical home attribution/CWL window + CwlTrackedClan -> CwlAllianceCampingService -> /cwl camping`; the service measures observed non-home CWL-clan residence, keeps unattributed evidence separate, reconciles overlaps without writes, and is not a state owner.
- Snapshot-backed todo: `PlayerLink + TodoUserUsage + CurrentWar + CurrentCwlRound/CwlRoundMemberCurrent + activity signals -> TodoSnapshotService -> TodoPlayerSnapshot`, with event-owned WAR/RAID/CWL context plus Clan Games lifecycle state whose clan ownership remains current membership, so stale event state can be cleared independently of the latest clan observation.
- Roster signup foundation: `RosterService -> Roster / RosterGroup / RosterSignup / RosterGuildConfig`, with `visitorSignupOpensAt` and `endsAt` persisted as nullable roster metadata and configurable through `/roster create` and `/roster edit`. `Roster.endsAt` is the authoritative self-service signup deadline: `RosterService` checks it with `lifecycleState` when opening the public Signup panel and immediately before signup insertion, while manager maintenance remains available on non-archived rosters. `RosterLifecycleSchedulerService` runs only in active production, reconciles due OPEN/ACTIVE rows to CLOSED on startup and an approximately 60-second cadence, and refreshes tracked posts from DB-backed roster state with per-post failure isolation. Public roster posts render the effective state, opening/deadline status, and disabled signup controls from the shared payload builder. The public `Signup` panel still enforces the delayed visitor window before it opens account selection, and final public confirmation revalidates that delayed-signup policy immediately before signup mutations commit. `RosterService` owns the pure delayed-signup eligibility policy that consumes already-resolved `visitorSignupOpensAt`, configured delayed roles, alliance-member precedence, manager bypass, and the exact `now < visitorSignupOpensAt` / `now >= visitorSignupOpensAt` boundary. Guild-scoped default roster board columns now live in `RosterGuildConfig`, while explicit per-roster `displayColumns` stays authoritative for customized boards. Discord/config resolution failures for the public delayed gate fail open with bounded logging, valid confirmation-time policy blocks consume the stale selection session and stop the mutation, existing signups and opt-out remain unaffected, and roster-post rendering is shared by initial post and refresh flows.
- Roster delayed-signup config: `AutoRoleGuildConfig -> delayedSignupRoleIds`, with multiple Discord roles persisted for later delayed-signup policy use. It is configurable through `/roster delayed-signup-role add|remove|list|clear`, while `nonMemberRoleId` remains the separate existing autorole control.
- Persisted CWL state: `CwlEventInstance / CwlEventClan / CwlEventWarTag -> CwlTrackedClan -> CwlStateService -> CurrentCwlRound / CwlRoundMemberCurrent / CurrentCwlPrepSnapshot / CwlRoundHistory / CwlRoundMemberHistory / CwlPlayerClanSeason`, with event identity authoritative and `season` treated as display metadata.
- The configured CWL autorole role has a focused live refresh path shared by role-scoped and guild-wide/scheduled runs: each unique current-season `CwlTrackedClan` roster is fetched once through the CoC queue with bounded concurrency and strict clan-tag/member-count/member validation, bulk PlayerLink rows determine eligible Discord users under the existing trust policy, and any failed/incomplete roster aborts before mutations. Guild-wide discovery adds live-linked users through the existing bounded Discord member-fetch path; historical CWL participation and `CwlRoundMemberCurrent` never override live membership. The role-scoped path only reconciles CWL-role holders and eligible users and does not call player endpoints, refresh FWA clans, reconcile unrelated roles, or update nicknames.
- CWL planner state: `CwlEventClan.isCurrent -> CurrentCwlRound + CwlRoundMemberCurrent + CurrentCwlPrepSnapshot + CwlPlayerClanSeason -> CwlRotationService -> CwlRotationPlan / CwlRotationPlanDay / CwlRotationPlanMember`, with each plan owned by one CWL event instance and clan. `season` is display metadata; historical same-month event plans are retained but ignored by current commands.
- The active CWL alliance activity report is `CwlAllianceActivityService`, a read-only consumer of persisted CWL event/round/history owners, `CwlPlayerClanSeason`, `ClanWarHistory`, and `ClanWarParticipation`. Historical pre-CWL cohorts are derived DB-first from canonical war history. It does not consume `AllianceClanMembershipInterval`, which remains the sole owner of observed membership-duration history for `/cwl camping` and future read-only reporting. No manual/frozen CWL alliance baseline owner remains.
- Reminder delivery: `Reminder/UserActivityReminder config + snapshots/current war -> reminder schedulers -> delivery logs`
- Operational state: `TrackedMessage`, unlinked-alert persistence, telemetry aggregates, report schedules
- FWA checklist automatic refresh: the existing `FwaMatchChecklistAutoPostSchedulerService` owns the 60-second publication loop and restart-safe 15-minute in-place refresh cadence for current-sync Mail/Bases checklist posts; typed row metadata supplies completion decisions, while `TrackedMessage` metadata owns the durable attempt/completion/stop markers. Scheduler cycles establish their own background CoC queue context. Mail refreshes preserve a prior row only when the live lookup is unavailable and the CurrentWar identity plus sync identity match; successful live updates and verified transitions remain authoritative. It never reposts, changes publication claims, or runs in mirror/staging.
- FB-020 accountability: `FwaMatchChecklist`/`WarMailLifecycle` source transitions -> `FwaAccountabilityNotificationService` -> `FwaAccountabilityNotification`; the notification table is the sole durable owner of notification event identity, immutable actor attribution, claim state, actual destination, and Discord delivery outcome. Complete normalized clan+war identity is authoritative over sync enrichment and is reused when current-war enrichment proves the same scope; incomplete sync-only identity may persist checklist state but suppresses accountability notification until a complete war identity is available. Mail publication rows use the successful Discord channel/message identity so legitimate republications remain distinct.

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
| Per-layout expiration-alert policy | LayoutAlertConfig |
| Durable per-layout/freshness-episode/target expiration-alert delivery claims and outcomes | LayoutAlertDelivery |
| Canonical FWA `(Townhall, Type)` layout designation | FwaLayouts |
| Per-clan FWA weight-alert policy (enablement and stale-age threshold) | FwaWeightAlertConfig |
| Durable per-clan/date FWA weight-alert delivery claims and outcomes | FwaWeightAlertDelivery |
| Durable FB-020 accountability event identity, actor, claims, and Discord outcomes | FwaAccountabilityNotification |
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
| Immutable scheduled-sync persisted clan-member state snapshots | SyncClanMemberSnapshot |
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
| Immutable Home return alert account membership | HomeAwaySyncAlertDeliveryAccount (active alert delivery writes; mirror only copies) |
| Proposed Home transfer and leader-decision history | ClanHomeTransferCandidate (production reconciler/decision APIs write; mirror only copies) |
| Mutable guild-scoped filler designations | FillerAccount |
| Scheduled-sync clan-goal and retrospective delivery claims | SyncEvent |
| Immutable bot-observed sync reaction transitions | SyncReactionHistory |
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
| FWA compo reference bands | HeatMapRef (legacy v1 parent remains authoritative during FB-002 P2 transition) |
| FWA compo normalized target projection | HeatMapRefBucketTarget (transactional derived child; exact nine-bucket parity required; future IDs representable but not activated) |
| FWA compo reference integrity/provenance | Versioned BotSetting key `heatmapref_reference_integrity` (global; guild checkpoints remain scheduler metadata; rows and matching SHA-256 provenance publish in one transaction; generation token fences superseded evaluations) |
| Telemetry rollups and report schedules | Telemetry* tables |

`FwaWeightAlertConfig` owns per-clan alert enablement and stale-age threshold policy. `FwaWeightAlertDelivery` owns the durable per-clan/per-`weightSubmitDate` claim, retry, and Discord delivery outcome. Routing continues to be read from `TrackedClan.leaderChannelId` and `TrackedClan.leadRoleId`; neither routing field is copied into the alert tables. `FwaClanCatalog.weightSubmitDate` remains the authoritative persisted submission date used for stale-age evaluation. After each fresh Clans.json sync reports `SUCCESS` or `NOOP`, the active runtime evaluates enabled policies and may deliver claimed episodes; mirror/staging runtime never sends, and no separate alert scheduler or poller exists.

Do not duplicate ownership across tables.

`LayoutRecord` owns tracked Clash layout links, explicit submission/confirmation freshness, and Discord post provenance. `FwaLayouts` owns the canonical FWA `(Townhall, Type)` designation through `layoutId`; its `LayoutLink` and `ImageUrl` remain transitional compatibility copies for legacy consumers and are written transactionally from the selected `LayoutRecord`. `LastUpdated` is non-semantic and never supplies freshness. Backfill assigns legacy rows to shared records with unknown historical freshness, and seed/bootstrap repairs missing associations without overwriting customized rows or creating lifecycle dates. Layout freshness is `lastConfirmedAt ?? submittedAt`; Prisma `updatedAt`, `LastUpdated`, Discord message time, clicks, reads, and merely revealing the link are not freshness sources. Only explicit “Yes, It Opened” confirmation advances `lastConfirmedAt`.

`LayoutAlertConfig` owns only per-layout expiration-alert mode and optional custom channel. `LayoutRecord` owns freshness and canonical post provenance. `LayoutAlertDelivery` owns durable per-layout/freshness-episode/target claim, retry, and Discord outcome state, including the actual attempted destination but no copied routing configuration. DM and CHANNEL targets are independently deduped and retried. The typed `/bot-logs type:layout-alerts` setting remains the guild default-channel owner and is resolved dynamically from the canonical post guild at send time. Only active production schedules and sends; mirror, staging, development, and unknown runtimes do not send. The shared 28-day stale-age value is a conservative internal reminder threshold, not a guaranteed expiration date, and the cross-system Discord/DB crash window remains bounded rather than atomic.

`FwaAccountabilityNotification` owns only FB-020 notification event identity and delivery state; it does not own checklist completion, mail publication, routing configuration, or source actor selection. Its unique key is guild + event type + canonical event key, and the canonical checklist key includes normalized clan identity. A complete war identity (`warId`, war start, opponent) is authoritative and ignores later sync enrichment; source transitions use that identity when current-war enrichment proves it, while incomplete sync-only acknowledgments remain valid checklist state but do not notify. Mail publication identity is the successful Discord channel/message pair, not merely the lifecycle `sendKey`. `actorUserId` is immutable after the event row is created, and retries render from that persisted actor.

Bases completion persistence is an atomic false-to-true transition owner shared by command and reaction paths. A complete war identity is the canonical scope, regardless of whether one caller also has sync metadata; legacy war- and sync-scoped rows are reconciled only when their persisted metadata proves the same logical scope, with contradictory partial identity rejected. An uncheck clears every validated equivalent active alias in the relevant clan scope, never stale or contradictory rows. The owner returns the transition and committed actor, uses conditional create/update ownership, preserves the first actor for repeated acknowledgments, and permits only a later uncheck followed by recheck to establish a new actor attribution. Command and reaction paths must notify only when their returned transition is `COMMITTED` and its actor matches the persisted transition actor.

Known Discord nondelivery failures become retryable `FAILED` rows, and retry acquisition is conditional on `status=FAILED` so an active `CLAIMED` owner cannot be overwritten. Ambiguous send failures, database finalization failures after Discord accepts a message, and claims that expire before `SENT` confirmation become terminal `UNKNOWN`; expired claims are never blindly reclaimed. This intentionally fails closed across the Discord/DB crash window and requires operator reconciliation before any future resend. Rows are retained indefinitely for audit/idempotency in this feature; no cleanup or backfill is implemented, so any future retention job must preserve the event-key evidence needed to prevent replay.

`AllianceClanMembershipInterval` remains the owner of observation-based, continuously observed alliance/CWL clan-membership intervals. `SyncClanMemberSnapshot` owns the separate immutable scheduled-sync snapshot of persisted clan-member state available to that flow for each normalized clan/player roster entry. It is not a fresh physical observation at the scheduled second and is not C/S/A evidence; the snapshot remains relevant to Home establishment policy. The sync snapshot deliberately contains no filler status; `SyncClanReadinessSnapshot` owns filler membership by intersecting the boundary's explicit `FillerAccount` registry read with that same boundary's persisted ACTUAL roster state.

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

## Production release Gate 1 checkpoint (2026-11-18)

- The repository-only read-only Gate 1 prerequisite inspection packet and 12-resource protected-path matrix are documented in `docs/diagnostics/production-deployment-installation-readiness-2026-11-17.md`; PR #2058 merged to `dev` at `694bb78e19af39ef1256bb696c7c8bf86a2ad551`.
- PR #2059 merged the **offline-only** strict local prerequisite evidence validator (`ops/deploy/discovery/gate1-prerequisite-validator.js`) at `d3bac03c5a825e902369a85ec6fb22ee8a75e228`. The validator enforces a 32,768-byte local JSON envelope cap and an 8,192-byte stdout cap, checks fixed records and pinned digests, and emits sanitized structural `VALID`/`INVALID`/`INCOMPLETE` results. `VALID` is **not** proof of host identity, authorization, or readiness.
- PR #2061 merged the **offline-only synthetic capture/provenance metadata boundary** (`ops/deploy/discovery/gate1-local-capture-boundary.js`) at `2f845cea0a6b13d31490a6f9da0f63bb64ca5e09`, following security review and passing final-head CI. It computes bounded (8,192-byte each) synthetic stdout/stderr byte counts and hashes, delegates structural checks to the PR #2059 validator, rejects forged trust and duplicate attempts in an in-memory ledger, and enforces pre-copy bounds on synthetic inputs and mock encryptor output. Its mock encryption is expressly `SYNTHETIC_UNTRUSTED`, not encrypted custody.
- PR #2063 merged the **offline-only real age encryption/ciphertext file adapter** (`ops/deploy/discovery/gate1-offline-age-custody.js`) at `100927bd017dfd9b970b61e7819437b7e18a54ab` after independent security reviews and passing final-head CI. It encrypts bounded synthetic data with locally supplied age tooling and disposable test identities, writes only ciphertext through exclusive creation, verifies size/hash/fsync, performs identity-checked failure cleanup, and handles repeated subprocess stream errors safely. Its Windows unlink/ACL/reparse/TOCTOU limitations remain explicit; no live capture path was enabled.
- Local file `boundary=UNVERIFIED` and capture `provenance=UNVERIFIED` remain intentional; offline ciphertext `custody=RESTRICTED_UNVERIFIED`, **not approved production custody**. The canonical owner/operator authorization and encrypted-evidence custody packet is now documented in `docs/diagnostics/production-deployment-installation-readiness-2026-11-17.md`; its recipient, private-root, retention/recovery, trusted-host, evidence-review, collector, and provisioning decisions remain separate and unapproved. Do not imply execution authorization or reimplement the already-merged offline adapters.
- Gate 1 remains **BLOCKED / NOT READY FOR EXECUTION**. The legacy deployment wrapper has no verified canonical shared-lock participation; protected lock, migration-lock, executor, credential and release-record paths remain unresolved. Delivery and prior remote hashes are operator-reported, not freshly reproduced. No SSH, capture, collector invocation, provisioning, deployment, migration, backup activation, or `dev`→`main` promotion is authorized by repository merges. Release PR #1983 remains blocked.
- Full ownership, approvals, and release progress live in `docs/roadmaps/production-backup-readiness.md` and the installation-readiness diagnostic, **not** this project-brain summary.

## Production Gate 1 follow-up (2026-11-19)

- **Observed, not accepted as Gate 1 evidence:** the owner ran the first, separately approved fixed SSH prerequisite probe once; malformed Windows CMD/Bash quoting created duplicate identity and split metadata records, and a wrong remote archive filename gave an untrustworthy `ABSENT` result. That approval is consumed. No read-only collector or runtime/database inspection was performed under that approval.
- **Implemented and merged:** [PR #2082](https://github.com/tonykslee/ClashCookies/pull/2082), reviewed head `cc7f861231d0f3633786ecf0a790d2784612b85f`, merged at `650ba69f0fc007d976c1c4eef88ff11d0f10ba84`, repaired the **replacement** one-line CMD/remote Bash command, exact archive path and synthetic regressions. GitHub Ubuntu CI passed; the two native Windows `cmd.exe`/fake-SSH tests were **reported passed locally**, not run on Ubuntu CI. The replacement is **not executed against the VM**; synthetic `VALID` is not verified production provenance.
- **Authorization split:** [PR #2080](https://github.com/tonykslee/ClashCookies/pull/2080) clarified terminal-only, no-retention prerequisite inspection versus separately gated ciphertext capture and later collector. The next one-shot terminal-only inspection requires **fresh Gate B and new owner SSH authorization**; the earlier approval is not reusable. Codex's normal logged runner is not the required protected terminal. Preserve `UNKNOWN` for canonical outer/migration locks, executor, protected credential source, release record and complete group memberships. The existing two local evidence-root files are untouched.
- **Release status unchanged:** protected deployment installation, collector/capture, staging waiver, backup/timer activation and `dev` to `main` are not authorized. Draft release PR #1983 remains NO-GO. The exact command and dated evidence belong in the installation-readiness diagnostic, operator preflight and production-backup roadmap; do not expand this project-brain summary into another operational runbook.

**Gate 1 live operator report (2026-11-19, after repaired packet merge):** The owner ran one protected-terminal Gate B remote check and the first one-shot repaired Gate C prerequisite inspection. The visible fixed summaries were manually schema-consistent; four pinned artifact hashes matched; existing wrapper syntax and tracked-clean checkout were reconfirmed; groups/read permissions passed. This is operator-shared transient-terminal observation only, **not** validated retained evidence or verified SSH-exit provenance. Historical lock/executor/credential/release-record candidates were absent, but their actual canonical paths remain **UNKNOWN/BLOCKED**; the observed `.env` candidate was mode `0664`, unsafe if selected as a protected migration credential source. Gate C's authorization is consumed; do not retry or execute the collector. Installation and draft PR #1983 remain **BLOCKED / NO-GO**. The canonical detailed record is in the installation-readiness diagnostic and backup-readiness roadmap.

# Deployment Model

## FB-028B-2b-3 retention/readiness checkpoint (repository-verified, 2026-11-25)

- Implemented on the feature branch: identity-bound durable retention metadata, first-legacy rollback baseline representation, shared delivery/retention/GC locking, metadata-nonmutating dry-run plus bounded explicit GC and separate recovery, serialized metadata/inventory bounds, shared-filesystem byte/inode admission, conservative interrupted-operation handling, independent-root historical verification, and sanitized repository-local readiness assessment.
- Retained evidence remains independent of GitHub Actions expiry. Authorization private keys, independently pinned trusted roots, replay journals, and historical verification evidence remain distinct custody domains; offline re-verification requires the independently maintained root and exact root version/fingerprint used at intake. A reserved authorization is consumed only through the real replay-journal contract; retained evidence cannot authorize a new activation. No production key, credential, trust anchor, or VM change was created.
- Production eligibility, runtime activation, wrapper installation, live VM access, and `dev`→`main` promotion remain disabled/NO-GO. Current live VM compatibility, installed wrapper identity, native ABI, health, scheduler singleton, trust custody, and actual resource headroom are not repository-verified.
- FB-027 kernel-backed deployment locking, candidate ownership, bounded cleanup, health gates, rollback preservation, and resource admission remain the deployment authority. Authenticated artifact retention must coordinate with detached-volume cleanup by using exact ownership labels/metadata and must never broaden cleanup to unknown resources.
- Retention GC is dry-run by default and does not mutate metadata; bounded execution revalidates ownership under the shared lock. Interrupted or missing-path deletion transactions remain recovery-protected until an explicit transaction-owner acknowledgment, and no automatic disk-pressure eviction is permitted.

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

# FB-002 P2 reference-model transition

`HeatMapRefBucketTarget` is a normalized child derived from and foreign-keyed to `HeatMapRef`. P2 keeps the legacy parent authoritative for the version-1 hash and compatibility projection; exact nine-bucket child parity, explicit nonnegative counts (including zero), and validated global provenance are required before target use. Missing, extra, malformed, duplicate, or tampered child evidence is UNKNOWN. No TH19 target is created. A future native profile needs separate source validation, approval, and a version-aware integrity contract before ownership transfers; migration backfill is not independent validation.

# FB-002 P3 native candidate foundation

Implemented locally on `feature/compo-native-reference-generation` as a read-only candidate path. The native profile is separate from legacy v1: it reads the persisted tracked-war roster snapshot, uses the shared weight classifier, preserves TH19, and never writes `HeatMapRef`, `HeatMapRefBucketTarget`, `BotSetting`, scheduler checkpoints, feed state, or Discord state. The current active v1 parent/child projection and global integrity owner remain authoritative.

Candidate eligibility is intentionally conservative. An explicit `explicit-window-v1` era policy and evaluation timestamp are required. A roster must have a valid clan identity, exactly 50 distinct players, positions 1 through 50 exactly once, direct `RAW` weights, shared-band-valid positive weights, matching member and roster totals, independently verified FWA source identity and completeness, coherent source war identity/state/timestamps, and source observation metadata inside the requested era window. Imputed or unresolved effective weights are excluded with bounded diagnostics. The current persisted schema does not bind the tracked roster/member rows to an exact FWA `CurrentWar`, so the DB service records that identity as unavailable and remains UNKNOWN; it does not infer FWA support from separate same-clan rows. `observedAt` and feed-sync/source timestamps establish persisted observation metadata only; they do not prove a newly observed war.

The ordered native registry contains `TH19`, `TH18` through `TH11`, and `TH10_OR_LOWER`. Aggregation is registry-driven for future groupings, with no seed blending or implicit interpolation. Ten distinct qualifying clan rosters per weight band is the explicit initial threshold, recorded in the candidate provenance and evaluated independently per band. Supported bands produce deterministic nonnegative integer targets summing to 50; a supported zero TH19 count is explicit, while missing, unsupported, malformed, stale, ambiguous, or insufficient evidence is `UNKNOWN`.

The diagnostic artifact includes explicit synthetic-versus-persisted source trust, exclusion attribution, per-band source/support diagnostics, direct bucket totals and averages, source observation bounds, ordered registry and numeric classification definitions, era policy, deterministic source-evidence fingerprint, and deterministic content fingerprint. Runtime validation checks the complete artifact contract and derived invariants before checking its checksum; fingerprints do not authenticate source identity or make a candidate active. It is an inspection artifact only. Fixture output is synthetic and cannot establish production support. No native candidate is active, validated, publishable, or equivalent to legacy active provenance. Later activation remains an owner-approved architecture decision requiring version-aware persistence, atomic publication, reader compatibility, and rollback/recovery coverage. Remaining dependencies are P4 composition intelligence, production verification of the existing P0/P1/P2 protections, and explicit owner approval for any future activation.

P4a `/compo place` composition intelligence is implemented as a consumer-side evidence separation. `CompoActualStateService` remains the DB-first ACTUAL context owner; the shared pure `assessCompoActualRosterEvidence` helper is reused by fill, placement, and replacement paths. The existing `CLAN_MEMBERS` `FwaFeedSyncState` owner supplies `SUCCESS`/`NOOP` status, ordered nonfuture timestamps, configured cadence freshness, matching row count, and a content hash bound to the persisted roster snapshot; FWA and CoC writers hash the canonical rows read back inside their transaction, preserve source-specific ownership, verify NOOP coherence, and fence older competing attempts. No second state owner or per-clan query fan-out is introduced. CoC and FWA source adapters reject missing identities, malformed/discarded rows, contradictory declared counts, and over-capacity payloads before authoritative sync evidence is recorded. Factual observation rows are retained for all tracked clans, while validated legacy target eligibility and replacement evaluation availability are independently typed. Missing, stale, partial, contradictory, same-cardinality-changed, or lower-confidence roster evidence is truthful but cannot authorize target-derived advice; TH19, unsupported clans, and unavailable HeatMapRef provenance remain UNKNOWN. Large responses use bounded fields and requester-owned one-embed-per-message pagination, preserving every clan across pages. No native reference is activated and no persisted projection or migration is added.

P4b calculation profiles are immutable validated policy adapters, not reference owners. The legacy-v1 profile centralizes ordered calculation buckets, factual mapping, weighted deviation penalties, representative weights, action priorities, validated target mappings, and legacy planner/display compatibility. The shared core requires deeply frozen nested policy, validates original factual observations before aggregation, validates optional calculation overrides against derived counts, checks safe count/weight/deviation arithmetic and missing-slot bounds, fails closed for malformed reader results or unvalidated profiles, and centralizes unavailable Raw/Auto/Best/Custom projections. Auto requires finite deviation and safe final weight arithmetic before supported status; Custom clears target-derived values when its score fails, while Raw retains its intentional null-score contract. Member-count and unresolved-weight metadata are validated before both allocation and no-missing paths, with missing-slot execution bounded to the 50-member roster contract while bounded over-capacity source observations remain available to existing planner characterization. A generic profile can provide an independent reference/count reader through every projection, scoring, and simulated-action path; advice retains calculation identities, grouped swaps decrement deterministic populated factual sources, and grouped display deltas derive from calculation-space counts. Ambiguous display mappings are rejected explicitly, and Best Fit uses profile-specific upper bounds and can fill a supported bucket absent from the initial observation map. Unavailable action evaluations are excluded from ranked alternatives. Its legacy adapter preserves the historical TH13 collapse, weighted midpoint fallback, and custom post-action band evaluation. Target evidence remains explicit: zero is a supported count, while missing/invalid/unavailable/unsupported evidence is UNKNOWN. Synthetic profiles are test-only extensibility evidence; native candidate artifacts remain diagnostic-only, and TH19 native targets remain inactive. P4c source evidence, P4d versioned publication, P4e approved activation, and P5 consumer migration remain separate.

# FB-002 P4d-2 provisional native publication

The owner-approved provisional native policy is versioned as
`native-provisional-v1`: two direct RAW/DEFERRED anchors, five distinct
qualifying clans per band, partial coverage allowed, and `UNKNOWN_UNVERIFIED`
source authority. Additive native generation/band/bucket/target/lineage tables,
a fenced current head, and append-only publication events provide immutable
content, idempotent atomic publication, snapshot-safe reads, and operator
rollback. Unsupported bands remain UNKNOWN. `/compo heatmapref` renders native
TH19, samples, versions, and UNKNOWN states in both PNG and Copy Table output;
`/compo state` adds only a labeled informational comparison through the
profile-aware calculation engine. Legacy-v1 references, blacklist mode, gates,
schedulers, and operational recommendations remain unchanged; no P4e activation
is included.

# FB-002 P4c native source-evidence boundary

P4c adds a read-only raw WarMembers evidence evaluator and keeps source facts separate from candidate eligibility and reference-publication authority. The evaluator records raw/accepted/discarded counts, duplicate and position integrity, direct-weight/total checks when declared by the source, opponent conflicts, local observation timing, deterministic content fingerprints, and explicit reason/status codes. The live FWAStats `WarMembers.json?warNo=1` contract does not currently provide an exact upstream war identity, declared authoritative roster size/total, or durable source-generation binding; those dimensions remain `UNAVAILABLE` even for a clean-looking payload. The existing normalized rows remain available to factual consumers, but invalid/partial evidence cannot qualify native source.

The native candidate artifact now carries a separate source-authority decision. Persisted latest-only rows remain `UNKNOWN`; synthetic fixture counts remain non-authoritative. No schema migration, source-history backfill, native target activation, HeatMapRef replacement, scheduler change, or live external verification is included. An owner-approved immutable observation/history schema and upstream exact-war proof contract remain prerequisites for replay/contradiction durability and any future authority decision. See `docs/diagnostics/fb-002-p4c-native-source-evidence.md`.

The corrected P4c evaluator uses one shared WarMembers parser for every raw row and records parser-accepted, parser-rejected/discarded, evidence-eligible, and evidence-ineligible outcomes separately. Caller-supplied accepted rows are checked only for correspondence and cannot establish verified facts. Missing source-declared roster size/total remains `UNAVAILABLE`; actual declared mismatches, malformed rows, invalid direct values, duplicate identity/position evidence, contradictory opponents, or raw/normalized correspondence defects are `CONFLICTING`. Full evidence validation checks structural counts, row indexes, statuses, reasons, fingerprints, and the invariant that exact-war/source-generation authority remains unavailable; hashes are consistency checks, not authenticity.

# If Architectural Conflict Appears

Stop and explain the conflict.

Do not implement changes that violate architecture rules without explicit approval.

## November 24, 2026 — Accountability and sync reliability checkpoint

- FB-020 [#2141](https://github.com/tonykslee/ClashCookies/issues/2141), merged [PR #2165](https://github.com/tonykslee/ClashCookies/pull/2165) (`fb87146d`): independent bases-checked, mail-posted and manual mail-confirmed typed routes, defaulting to clan-lead. The notification owner does not establish actual base correctness or in-game mail delivery. Canonical Bases persistence is shared by command and reaction; validated legacy aliases do not create duplicate transitions.
- FB-016 [#2127](https://github.com/tonykslee/ClashCookies/issues/2127), merged [PR #2166](https://github.com/tonykslee/ClashCookies/pull/2166) (`8371a13d`): regression-only verification of the existing FB-020 correction, with real service paths behind an isolated Prisma seam. No additional production logic was needed. The original November 20 production incident was not independently reconstructed.
- FB-023 [#2155](https://github.com/tonykslee/ClashCookies/issues/2155), merged [PR #2168](https://github.com/tonykslee/ClashCookies/pull/2168) (`be72ce5e`): explicit h23 formatting fixes local midnight conversion and modal defaults. Existing two-pass DST mapping is preserved, not redesigned.
- FB-021 [#2143](https://github.com/tonykslee/ClashCookies/issues/2143), merged [PR #2169](https://github.com/tonykslee/ClashCookies/pull/2169) (`825c9463`): shared Town Hall application-emoji resolver supports TH19; live inventory/rendering of the supplied emoji remains unverified. All four final feature PRs passed GitHub CI.
- Owner-selected next task: FB-015 (#2126), premature all-spun announcement. Investigate persisted root participant denominator, claim identity, and delivery revalidation before changing code. Do not presume that the November 20 incident was caused by any one observed code weakness. Then review the next production release, before resuming FB-002 operational composition recovery (advice #2162, place #2163, fill #2164). FB-017 is not in the current quick-win batch.
- Production distinction: main `5bdba1e4` was observed with FB-020's additive Prisma migration and FB-016 tests in the release diff; actual VM completion was not independently verified here. The documented deployment chooses intentional downtime if the actual OLD_SHA..NEW_SHA diff contains Prisma schema/migration changes; non-migration changes are build-first, near-zero downtime when the live wrapper matches the reviewed procedure. No infrastructure change is authorized.

