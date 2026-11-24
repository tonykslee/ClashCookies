# Observability

## Production backup monitoring — 2026-11-14 operator checkpoint

The independent [production backup readiness roadmap](roadmaps/production-backup-readiness.md) and [backup runbook](../ops/backup/README.md) govern backup activation. The operator configured an external Healthchecks.io `ClashCookies Production Backup` check for UTC cron `15 2 * * *`, with paired HTTPS POST success and `/fail` URLs stored only in root-owned `/etc/clashcookies/backup.env` (0600). A harmless `/log` POST and a simulated failure POST from the restricted backup account both returned HTTP 200; the operator confirmed corresponding events and receipt of the failure email. The check was reported **paused** afterward.

**Updated 2026-11-15 operator evidence (supersedes the historical 2026-11-14 limitations above):** A separately authorized corrected manual runner completed encrypted daily and Sunday weekly B2 objects, delivered a real Healthchecks.io success ping, and the operator received a real missed-schedule email while the timer remained disabled. An earlier encrypted daily archive was independently retrieved and restored into disposable PostgreSQL 17. Independent B2 expected-object/freshness monitoring, unattended scheduled success, recovery-key disaster retrieval, and release readiness remain unverified. The timer remains disabled; the service is inactive after the completed run. Do not infer that the new daily/weekly objects were independently restored. Never issue a success ping merely to clear a test failure or claim a backup occurred.

**Actual droplet deployment caveat:** Uptime Kuma and Dozzle were preserved, but staging and Netdata were removed by separate explicit authorization to reclaim storage. The configuration and historical instructions below may still describe staged/mirror services or Netdata as installable; they are **not** evidence those services currently run. Do not run a blanket observability Compose `up` command that could recreate retired components without a separately reviewed plan.

## Historical participation backfill

The one-time operator utility emits bounded, structured lines with the prefix `[membership-participation-backfill]`. Per-war lines include guild, sync, clan, canonical war ID, action, archive/reconstruction/existing/planned counts, the compatibility `expected_team_size` field (derived from distinct canonical participant tags when the roster is complete), projected coverage, and reason codes. The summary includes selected syncs, canonical FWA candidates, validated/dirty point evidence, exact-tuple canonicalization and stale-ID repair counts, unmatched/ambiguous tuple counts, planned rows, unreconstructable rows, COMPLETE/PARTIAL/UNKNOWN projected rosters, skips, and conflicts. `canonical_roster_complete`, `canonical_roster_unreconstructable`, `missing_canonical_participants`, and `malformed_participant` explain roster completeness decisions. The backfill is all-or-nothing per canonical war: incomplete or malformed archives plan no participation inserts. Dry runs perform no writes; apply mode prints a post-write verification summary against the derived canonical roster count.

ClashCookies currently uses two observability layers:

1. Internal app observability
2. External droplet observability

## Internal App Observability

The application itself provides:

- structured startup, poller, and scheduler logs
- always-on CoC queue priority logs for interactive vs background dispatch
- telemetry aggregate tables and scheduled Discord reports
- health endpoints for liveness and readiness

Built-in health endpoints:

- `/livez` for process liveness
- `/healthz` for readiness

Readiness returns HTTP `200` only when:

- the Discord client is ready
- the database probe succeeds

Configured by environment:

- `HEALTHCHECK_ENABLED`
- `HEALTHCHECK_HOST`
- `HEALTHCHECK_PORT`
- `HEALTHCHECK_LIVE_PATH`
- `HEALTHCHECK_READY_PATH`

Internal telemetry surfaces:

- `/telemetry report`
- `/telemetry schedule set`
- `/telemetry schedule show`
- `/telemetry schedule disable`
- `/telemetry schedule run-now`

### Dozzle log levels

App-owned log lines are normalized to one of these Dozzle-friendly levels:

- `fatal`: boot-blocking or process-ending failures
- `error`: failed command, job, API, or database operations
- `warn`: recovered failures, skipped work, stale config, slow waits, retry exhaustion
- `info`: startup milestones, readiness, command invocation/completion, scheduler lifecycle, successful side effects
- `debug`: routine scheduler summaries, telemetry success samples, config and payload summaries
- `trace`: high-volume loop churn such as CoC queue enqueue and dispatch events

Representative examples:

- `[info] [startup:login] start ...`
- `[warn] [coc-queue] event=degraded_delay ...`
- `[debug] [telemetry-v2] ...`
- `[trace] [coc-queue] event=enqueue ...`

Filtering Dozzle to `info` hides high-volume trace chatter while keeping startup, command usage, scheduler milestones, and important side effects visible.

### FWA composition reference containment

HeatMapRef rebuild summaries must distinguish supported, partial/excluded, and unavailable evidence. The shared rebuild helper reports explicit exclusion codes including `unsupported_th19`, `roster_size`, `missing_weights`, `no_reference_band`, and `unresolved_effective_weights`. Ordinary legacy eligibility exclusions do not block a replacement when another supported roster remains; the supported cohort may publish with partial evidence. An effective TH19 exclusion is different: it blocks global publication even when supported rosters exist, because the legacy schema cannot represent that evidence safely. A source set with no qualifying evidence, or no source rosters, is also blocked. Existing rows remain intact and seed-only data is never labeled freshly validated.

The scheduled checkpoint records a blocked evaluation with its actionable reason and reason code (`th19_integrity`, `no_qualifying_evidence`, or `no_source_evidence`), preserves the prior `lastSuccessAtIso` and content hash, and treats the cycle as terminal until the next sync cycle. A genuine unchanged rebuild requires current supported evidence and records `no_op` success semantics. Manual evaluation uses the same blocked/success distinction and may be explicitly retried; scheduled polling does not repeatedly mutate a blocked cycle. Ready-time diagnostics log only an actual evaluation, with bounded exclusion summaries; not-due and already-handled ticks remain quiet.

Blacklist sample generation reuses the same effective-weight containment and reports skipped reason codes. Blacklist profile aggregation requires `rosterSize=50`, raw nonnegative integer bucket counts, and an exact bucket sum of 50 before normalization. Malformed or incomplete samples are rejected, never clamped or truncated; if no complete samples remain, existing blacklist profile rows are preserved.

Downstream contract: the physical global `HeatMapRef` table has one versioned integrity/provenance record in `BotSetting` under `heatmapref_reference_integrity`; the guild-scoped checkpoint remains scheduler cadence/attempt metadata only. A successful replacement writes the rows and matching SHA-256 content hash in one PostgreSQL transaction under a transaction-scoped advisory lock. Each evaluation also persists a unique generation/fencing token in its pending record; finalization rechecks that token under the same lock and a superseded evaluation fails before publishing rows or changing provenance. The pending marker is conservative: initial rollout, an in-progress evaluation, malformed/missing provenance, or unreadable evidence withholds target use as UNKNOWN. A global blocked record persists across new sync cycles, running/failed checkpoints, manual evaluations, restarts, guilds, and unscoped reads until a genuinely safe supported success or no-op validation records `validated`. Readers require the version, strict timestamps, valid hash, and a hash match against the actual rows used for target calculations; a mismatch fails closed. Blocked, malformed, missing, or unreadable provenance withholds retained rows from target projection while factual observed composition, vacancies, and filler availability remain visible; target deltas, deviation, readiness, automated zero-deviation goals, placement, replacement surplus, and fill recommendations remain UNKNOWN/unavailable. Historical `/compo heatmapref` rows remain viewable with a truthful warning. Seed/upsert and mirror writers do not write provenance; mirror-side missing provenance and independently changed rows therefore fail closed. Complete database unavailability cannot provide an atomicity or fencing guarantee and is reported as an operational failure rather than a successful validation.

P4a placement/replacement telemetry and rendering must preserve this distinction: persisted ACTUAL observations, `CLAN_MEMBERS` sync-state-backed roster evidence/coverage, target availability, placement eligibility, and replacement evaluation availability are separate facts. Complete-count authority requires a `SUCCESS`/`NOOP` `FwaFeedSyncState` row with ordered nonfuture timestamps, configured cadence freshness, a matching row count, and a content hash bound to the exact persisted roster snapshot; source adapters reject missing identities, malformed/discarded rows, contradictory declared counts, and over-capacity payloads before the sync owner records success. FWA and CoC writers hash the canonical rows read back from their transaction, preserve source-specific fields, verify persisted coherence before NOOP, and do not publish a superseded attempt. Stale, partial, contradictory, missing, same-cardinality-changed, or discarded member evidence remains visible but fails closed. Replacement outcomes are classified as evaluated-with-candidates, evaluated-empty, unavailable, or partial; empty contexts and empty arrays are not a complete availability signal. Unsupported TH19 input, incomplete/missing roster coverage, lower-confidence fallback weights, and invalid reference provenance may retain bounded factual rows but cannot emit target-derived deltas, surplus recommendations, or healthy/no-candidate claims. Discord factual rows are field/embed-bounded and retain every clan's status; `/compo place` delivers one page embed per message with requester-owned navigation so the aggregate 6000-character message limit is not exceeded. Diagnostics remain aggregate and must not include player details or private Discord response bodies.

Bounded read-only production verification plan (not executed): read the global `BotSetting` value `heatmapref_reference_integrity` and, separately for each configured guild, read scheduler checkpoint keys `heatmapref_rebuild_state:<guild>`; read current FWA roster members and source timestamps for configured clan tags; derive effective weights with the shared helper and record TH19/exclusion reasons; read persisted `HeatMapRef` rows (`sourceVersion`, `refreshedAt`, bands, counts) and blacklist samples (`createdAt`, `confidence`, `rosterSize`, raw counts); then compare dry-run supported/excluded evidence to the global integrity record, persisted reference timestamps, and downstream UNKNOWN behavior. Limit the review to the latest current snapshot plus bounded persisted reference/sample rows, with no writes, rebuilds, seeds, backfills, repairs, or spreadsheet access.

P2 adds a bounded `[heatmapref-resolver]` read boundary. It records only aggregate state (`verified`, `missing`, `invalid`, or `unavailable`) and allowlisted failure codes (`child_delegate_missing`, `child_query_failed`) or bounded validation reasons such as incomplete coverage, extra bucket, parent-child mismatch, or invalid band continuity; raw database exception text is never logged and target payloads are never logged. The nine legacy child targets must be present, explicit, nonnegative, unique, and exactly equal to the hash-validated parent columns. A missing normalized delegate or failed child read retains factual parent observations but never reuses v1 provenance to authorize targets. A future bucket identifier is representable but is treated as an unexpected extra in the v1 profile until a new provenance version and source-approved profile exist. Migration/backfill completion is not emitted as validation, and a blocked record is never cleared by schema, seed, mirror, or reconciliation alone.

### Automatic sync-status lookup

`/sync post status` and `/sync spin status` emit one bounded `[sync-status] automatic_lookup` event for automatic discovery. The event records the guild, resolution result (`active`, `expired`, `deleted`, `missing`, `unavailable`, `format_mismatch`, `no_active_tracked_announcement`, or `stale_saved_pointer`), selected root identity/status, saved-pointer identity, and whether the saved pointer matched the DB-selected root. Discord permission, temporary API, and format failures preserve `TrackedMessage`; only a definitive missing-message response may mark the tracked root deleted. Message contents and unbounded exception text are not logged.

### Sync Spin Status leader-account button

The persistent `My Leader Accounts` button emits bounded `[sync-leader-accounts]` events with `STARTED`, `SUCCESS`, `FAILURE`, and `INVALID_CONTEXT` outcomes. Success records only clan count, matched-account count, page counts, and duration; failures record a bounded reason/code and duration. The flow reads tracked sync metadata and performs one bulk persisted roster/`PlayerLink` lookup for the clicking user. It never logs player names, tags, links, account details, or ephemeral response content, and it does not call live CoC APIs or write state.

### Tracked-clan leaders view

`/clan list display:leaders` emits bounded `[tracked-clan] event=leaders_refresh` lines for manual refresh lifecycle (`STARTED`, `SUCCESS`, `PARTIAL`, `FAILURE`, or `SKIPPED reason=mirror_mode`). Events contain only displayed and failed counts; player names, links, and Discord message content are not logged. Initial leaders rendering is DB-first and performs no CoC/FWAStats request. Manual refresh uses the interactive CoC queue with bounded clan concurrency, deduplicates normalized tags across registries, and preserves persisted results with explicit freshness labels when a clan refresh fails. Mirror mode remains read-only, preserves the persisted freshness state, and does not call CoC.

### FWA weight-alert delivery

The existing FWA Clans.json scheduler invokes weight-alert evaluation only after a fresh catalog sync reports `SUCCESS` or `NOOP`. Delivery is failure-isolated from feed synchronization and uses the durable `FwaWeightAlertDelivery` row keyed by clan and persisted `weightSubmitDate` for claims, retries, and terminal `SENT` state. Bounded `[fwa-weight-alert]` events are `cycle_complete`, `cycle_skipped`, `routing_missing`, `delivery_sent`, and `delivery_failed`; cycle events contain aggregate counts, while per-event lines identify the affected clan and destination without logging message content. The evaluator bulk-reads enabled `FwaWeightAlertConfig` rows, `FwaClanCatalog.weightSubmitDate`, and `TrackedClan` routing; it does not perform FWAStats HTTP work.

Only an active runtime may send to the configured `TrackedClan.leaderChannelId` and mention its configured `TrackedClan.leadRoleId`. Mirror and staging runtimes skip delivery, and there is no separate alert timer, scheduler, or `BotPollJobStatus` entry.

### Layout expiration-alert delivery

`LayoutAlertSchedulerService` runs an immediate startup cycle and then one active-production cycle per hour. Mirror, staging, development, and unknown runtimes skip the timer and send path. `LayoutAlertDeliveryService` evaluates `LayoutRecord.lastConfirmedAt ?? submittedAt`, requires complete canonical Discord provenance, and claims independent DM and CHANNEL rows keyed by the immutable freshness anchor. Default-channel routing is resolved at send time from the canonical post guild's typed `layout-alerts` setting; missing routing has no generic fallback. A final layout/config re-read can supersede a stale episode or leave a policy-changed delivery retryable.

### Roster lifecycle reconciliation

`RosterLifecycleSchedulerService` runs one startup cycle and then every 60 seconds in active production only. It selects only OPEN/ACTIVE rosters with non-null `endsAt <= now`, conditionally transitions each due `Roster` row to CLOSED, and refreshes the tracked roster post from DB-backed state. Mirror, staging, development, and unknown runtimes do not close rosters or edit Discord posts. Bounded `[roster-lifecycle]` events include `scheduler_started`, `cycle_complete` counts (`due`, `closed`, `closure_failed`, `refreshed`, `refresh_skipped`, `refresh_failed`), `post_refresh_skipped`, and `post_refresh_failed`; one Discord refresh failure is isolated from other due-roster closures. The `roster_lifecycle_scheduler` `BotPollJobStatus` row reports the display name, 60-second interval, runtime guard outcome, and actionable failure state.

### FWA checklist automatic refresh

The existing `fwa_match_checklist_auto_post_scheduler` also evaluates current-sync Mail and Bases checklist posts for a durable 15-minute refresh cadence. It records the attempt, completion, and six-hour safety-stop state in checklist-owned tracked-message metadata, so restarts do not replay a due interval. Each cycle establishes a background CoC queue context. When Mail lookup evidence is unavailable, a prior row is reused only after exact CurrentWar context-key and sync-identity validation; successful live updates and verified war transitions are never replaced by the baseline. Bounded `[fwa-checklist-auto-refresh]` events include `guild`, `sync_identity`, `view_type`, `message_id`, `result`, `reason`, `unresolved_count`, and `changed`; checklist baseline diagnostics include `guild`, `clan`, `view`, `sync_identity`, and one of `lookup_unavailable`, `previous_identity_matched`, `previous_identity_mismatch`, `previous_row_missing`, or `verified_war_transition`. Logs do not include full checklist bodies. Mirror and staging runtimes do not refresh, and an Unknown Message target is marked deleted so it is not retried.

Manual checklist button refresh uses bounded `[fwa-checklist-manual-refresh]` events with `guild`, `message`, `view`, `phase`, `duration_ms` when available, `outcome`, and `reason`. The `prepare` phase covers the tracked-message read and checklist state build and is capped at 30 seconds. The `apply` phase gives the existing tracked-message refresh write a separate 30-second user-visible wait; a timeout does not cancel that write or release its per-guild/message guard until the original promise settles. Events include `started`, `duplicate`, `prepare_timeout`, `prepare_failed`, `apply_timeout`, `apply_completed`, `apply_failed`, and `expired`. Manual diagnostics never include message bodies or unbounded error text.

Mail checklist completion is event-driven: `checkedClanTags` in `TrackedMessage` metadata is authoritative. Ordinary refreshes, automatic refreshes, opponent/match updates, and incomplete reaction-cache observations preserve that set. Only a matching non-bot reaction add changes one clan to checked; a matching remove clears it only when the remaining human reaction count is authoritatively zero. `[fwa_checklist_reaction_observation]` with `action=preserve_completion` means the remove could not be resolved safely. Tracked-message diagnostics distinguish `initial_cas`, `reconciliation_cas`, `reconciliation_failed`, and edit/recovery phases; a CAS conflict merges concurrent checked-tag changes instead of applying last-writer-wins.

FWA mail preview and final confirmation emit bounded `[fwa-mail-gate]` reason-code events for blocked sends. `reason=match_type` means the active match type is still inferred, `reason=outcome` means FWA WIN/LOSE is still unresolved, `reason=war_identity` means the exact current-war identity or revision changed during revalidation, `reason=permissions` means the requester is not authorized, and `reason=duplicate_mail` means an up-to-date or in-flight lifecycle claim already exists. Manual WIN/LOSE selections remain transient revision drafts until the existing final confirmation and are never treated as fresh points-site evidence.

Bounded `[layout-alert]` events include `cycle_complete` aggregate counters (`configs`, `eligibleLayouts`, `eligibleTargets`, `claimed`, `sent`, `failed`, `deduped`, `retryDeferred`, `recentClaims`, `superseded`, `unknownFreshness`, `notDue`, `missingRouting`, `skipped`), `delivery_sent` identifiers, `delivery_failed` with target/attempt/failure code, `routing_missing`, `episode_superseded`, and `cycle_skipped`. Logs do not include raw Clash links, full message bodies, temporary image data, or unbounded exception text. The five-minute claim lease and six-hour failed retry delay prevent normal replay, while the unavoidable Discord-accepted-before-`SENT` commit window remains bounded by the retry policy.

## Home Away sync alerts

The existing scheduled-sync scheduler runs the Home Away alert lifecycle as a failure-isolated sibling. Useful bounded lifecycle events include:

- `[home-away-sync-alert] schedule_created` for a newly persisted randomized fire time
- `[home-away-sync-alert] evaluated` for a due HomeRoster evaluation and recipient count
- `[home-away-sync-alert] delivery_failed` for a claim failure classified as retryable or terminal
- `[home-away-sync-alert] completed`, `schedule_cancelled`, and `schedule_expired` for terminal lifecycle transitions

Logs contain identifiers, counts, status, and failure codes; schedule lifecycle logs may include operational epochs, but never DM bodies. Exact sync timing is not exposed in Discord. The immutable message content and delivery claims remain in the alert tables for restart-safe auditing; mirror mode only copies those rows.

At runtime, the app installs a console shim so existing app-owned `console.*` call sites are normalized without changing their structured fields.

Queue observability now includes:

- interactive vs background CoC queue depth in runtime status/logs
- queue wait timing telemetry for interactive and background CoC work
- stale background skip counts and logs
- degraded-delay and 429 recovery logs from the shared CoC pacing owner
- bounded `[raids-overview]` history and dependency summaries with clan/request counts, successful/empty/failed history counts, failure codes, selected weekend, defender metadata duration, layout-mark lookup duration, and defender-upgrade lookup duration; `[raids]` overview completion/failure events include source, clan count, selected weekend, outcome, and total command duration
- CoC requests use an abortable bounded request timeout that starts when a task begins HTTP execution after queue dispatch; queue wait is reported separately, so normal raid-overview pacing cannot create false network timeouts, and timeout failures retain the existing API timing/error taxonomy
- autorole scheduler cadence decision logs with `guild_id`, `cadence_anchor_started_at`, `next_due_at`, `current_time`, `interval_minutes`, and `cadence_reason`; completed scheduled guild runs anchor the cadence, manual refreshes do not reset it, failed scheduled runs do not reset it, and overdue scheduled runs still dispatch with a fresh CoC queue deadline
- autorole run lifecycle logs with persisted `run_id`, `guild_id`, `run_scope`, `run_trigger`, `scope_target_id`, and final `status` so refresh outcomes are visible without inferring trigger correctness from telemetry
- configured CWL autorole live-membership logs such as `event=cwl_role_roster_loaded`, `event=cwl_role_roster_failure`, `event=live_clan_fetch`, and `event=refresh_start` include scope, live/persisted membership source, roster fetch count, failed clan tags, candidate/member counts, role mutation counts, and elapsed time; failed or inconsistent live rosters are fail-closed before mutations and do not emit per-member fetch noise
- war-event producer logs such as `war_event_player_refresh_plan`, `war_event_player_refresh_chunk`, `war_event_player_refresh_stagger`, `war_event_player_refresh_deferred`, and `war_event_player_refresh_complete`
- maintenance-window notices from active war polling, routed to the typed `/bot-logs type:maintenance` channel when configured and otherwise to the generic bot-log channel; dedupe state is persisted per guild by `MaintenanceWindowService`
- automatic sync retrospective reconciliation emits compact `[retrospective-auto-post]` events: `event=delivered` is INFO with guild, sync, participant, channel, and message identifiers; completed-before-enable suppression is DEBUG; incomplete/terminal/disabled skips are DEBUG; unavailable destinations are WARN; and claim, render, send, or delivery-state failures are ERROR. It runs inside the existing scheduled sync reconciliation loop and does not emit one INFO line per polling cycle.
- FB-020 accountability delivery emits bounded `[fwa-accountability]` diagnostics for claim, missing/inaccessible destination, delivered, failed, expired-claim, finalization-unknown, and ambiguous Discord delivery outcomes. Durable rows are keyed by guild, event type, normalized clan, and authoritative event identity: bases/manual checklist confirmations use complete current-war identity when provable and suppress notification for incomplete sync-only identity, while mail publication uses the successful Discord channel/message pair so legitimate resends remain independently loggable. Notification failures never roll back the source checklist or mail state; ambiguous and post-send-finalization uncertainty is fail-closed as `UNKNOWN`, and retry acquisition only considers `FAILED` rows.
- automatic sync all-spun delivery emits bounded `[sync-all-spun]` events. `event=evaluation_incomplete` is DEBUG with the claimed and participating clan counts; `event=delivery_suppressed` is DEBUG for a concurrent or already-terminal `SyncEvent`; `event=delivered` is INFO with guild, root message, exact sync time, participating-clan count, destination channel, and announcement message identifiers; routing, root ownership, metadata, expiry, and non-production skips are WARN/DEBUG as appropriate; and evaluation, claim, Discord-send, or delivery-state failures are ERROR. The one-minute tracked-message recovery pass emits `event=recovery_summary` only when it delivered, suppressed, or failed work. The delivery payload is the plain text `all spun`; logs do not include claim users, message bodies beyond that fixed value, or reaction timestamps. Mirror and non-production runtimes do not send.
- sync reaction history emits bounded `[sync-reaction-history] event=transition_recorded` DEBUG lines only after a current-state ADD/REMOVE transition and transaction commit, with guild, canonical root message, actual message, exact metadata sync time, observation phase, action, and clan tag. Failures emit a bounded `transition_failed` ERROR without Discord user identifiers or reaction payloads. `observedAt` is bot observation time; `eventOrder` is sequence allocation order only and must not be treated as commit order, verified Clash search timing, or a Discord event ID.
- CWL event-resolution and persistence logs such as `event=event_resolution_unresolved`, `event=event_resolution_collision`, `event=event_war_tags_attached`, `event=clan_current_event_changed`, `event=tracked_cwl_persist`, and `event=tracked_cwl_season_roster_reconcile`
- finalized war-plan history logs such as `event=evaluation_completed`, `event=evaluation_failed`, `event=evaluation_terminalized_non_fwa`, `event=evaluation_claim_unavailable`, `event=evaluation_canonical_reset`, `event=evaluation_reactivated`, `event=evaluation_claim_lost`, and `event=reconcile_complete`, which should include `guild`, `war_id`, `clan_tag`, `status`, `violation_count`, `attempt`, `duration_ms`, and `failure_code` when applicable
- final war-end persistence should keep the canonical history/enrollment transaction boundary silent on success and only emit follow-up logs after `WarLookup`, participation, and finalization steps complete
- FWA tracked-war roster summaries such as `event=tracked_war_roster_sync` and `event=war_members_tracked_roster_refresh`, which show the exact current-war identity that was stamped onto the derived tracked roster after each successful WarMembers fetch
- active FWA sync resolution emits bounded `[sync-cycle] event=active_resolve` outcomes for exact, derived, ambiguous, terminal-schedule, and conflict decisions; these include guild, reason, and counts rather than points-site payloads, so local chronology failures remain visible while stale external data cannot silently rewrite `SyncCycle`
- internal point estimates emit at most one bounded `[points-estimate] event=resolve` line per resolver call, identifying the selected provenance (`validated_same_war`, `history_reconstruction`, last-known, or unavailable) and reason. The typed result coverage is authoritative for projection safety; the reason is diagnostic only. Fetch time alone is not post-war balance evidence, and the history writer's website-derived `pointsAfterWar` is not a numeric proof. A successful fetch after canonical war end cannot establish whether the overwritten balance is pre-war or post-war; without a retained pre-war anchor or independently verified post-war balance, the resolver retains it only diagnostically. Baseline lifecycle ambiguity, unresolved-baseline termination, checkpoint/result disagreement, absent balance anchors, absent baseline history, unverified actual-outcome or checkpoint provenance, opponent-history absence, and sync conflicts remain diagnostic conditions rather than implicit current-balance claims. `/fwa match` may render a complete same-sync pair as explicitly labeled persisted/projected points/outcome while the website is stale; resolver `isEstimate` remains provenance metadata and does not authorize treating that fallback as current website evidence. A complete, exact-war, same-sync, projection-safe pair may additionally provide an inferred FWA outcome for mail eligibility, but it never authorizes estimated points, bypasses inferred-match-type/manual-confirmation/live-identity/final-send gates, or creates a write. The resolver performs scoped, baseline-bounded read-only database queries, no points-site work, and no database writes, and estimate logs do not present an estimate as confirmed current-matchup evidence.
- bounded `[fwa-mail-outcome]` diagnostics identify whether a rendered WIN/LOSE came from confirmed current-war state, validated current website evidence, a safe persisted projection, or remained unresolved. They are emitted only when the source/signature changes for the same stage, guild, clan, and war, so routine refreshes do not produce per-poll info noise.
- Partial FWA point display reuses the bounded `[points-estimate] event=resolve` provenance diagnostics; it does not emit a new per-clan or per-refresh telemetry stream. Last-known/history-incomplete and unavailable participants remain diagnostic labels and never appear as inferred outcome sources.
- todo snapshot WAR owner resolution logs such as `event=todo_war_owner_resolution_summary` and `event=todo_war_owner_resolution_ambiguous`, which summarize live-verification outcomes and surface ambiguous multi-clan matches when stale roster state needs correction
- alliance membership interval collection logs such as `[alliance-membership-history] event=reconcile_cycle`, which provide one bounded per-cycle summary with `monitored_clans`, `fwa_rosters_reused`, `cwl_only_fetches`, `failed_clans`, `observed_players`, `opened`, `refreshed`, `transferred`, `departed`, `tracking_stopped`, `ambiguous`, and `duration_ms`; failed interval transactions are logged as `event=reconcile_cycle_failed` and do not abort the rest of activity observation
- membership tenure analytics emits a bounded `[membership-streak] event=bulk_resolution` summary for guild/player/boundary counts plus `cwl_neutral_boundaries`, `cwl_neutral_players`, `cwl_candidates_rejected`, `cwl_ambiguous`, `bl_mm_accepted`, `bl_mm_rejected`, and `bl_mm_conflicting`; one `[membership-streak] event=historical_canonicalization` aggregate reports validated/dirty point, exact-tuple recovery, stale-ID, unmatched/ambiguous tuple, canonical-history, and negative-coverage-uncertainty counts; active-war roster identity/read failures, BL/MM evidence read failures, and CWL continuity read failures are WARN-level and fail closed, with no player-level roster payloads logged.

CWL alliance activity logs should stay structured and compact. The active read-only report emits one bounded summary such as `[cwl-alliance-activity] event=activity_summary` with `season`, `cwl_clans`, `resolved_events`, `pre_fwa_clans_covered`, `pre_fwa_accounts`, `cwl_participants`, `both`, `fwa_only`, `cwl_only`, `post_fwa_clans_covered`, `duplicate_reconciliations`, and `duration_ms`. It must not log or imply external API work, and it does not emit view/page/guild counters.

CWL camping logs should stay to one bounded invocation summary: `[cwl-camping] event=report_summary` with `guild_id`, `season`, `tracking_coverage`, `interval_rows`, `attributed_accounts`, `campers`, `unattributed_accounts`, `currently_camping`, `overlap_reconciliations`, and `duration_ms`. The service is read-only and emits no per-player success logs.

## External Droplet Observability

**Observed deployment snapshot (2026-11-14):** Uptime Kuma and Dozzle are **running/preserved**; Netdata's container, image and named volumes were **removed** with operator authorization to reclaim disk. The staging app/database were also decommissioned. The configuration and instructions below describe the **repository's available/legacy stack**, not a guarantee that every service is currently deployed. In particular, `ops/observability/docker-compose.yml` may recreate Netdata if run without review. See [backup/droplet preflight](diagnostics/backup-operator-preflight-2026-11-14.md). Host/container metrics coverage must be reviewed before production release.

The repository's observability design includes:

- Uptime Kuma for status pages, checks, and Discord alerts (currently preserved)
- Dozzle for live Docker logs (currently preserved)
- Netdata for host/container metrics (currently **not installed/running**)

The stack is intentionally private by default:

- Uptime Kuma binds to `127.0.0.1:3001`
- Dozzle binds to `127.0.0.1:8080`
- Netdata *when deployed* binds to `127.0.0.1:19999`; currently removed

Use SSH port forwarding to access the UIs from your machine instead of exposing them publicly:

```bash
ssh -i C:\Projects\clashcookies_codex ^
  -L 3001:127.0.0.1:3001 ^
  -L 8080:127.0.0.1:8080 ^
  codex@64.23.164.95
```

After the tunnel is open:

- Uptime Kuma: `http://127.0.0.1:3001`
- Dozzle: `http://127.0.0.1:8080`
- Netdata (only if intentionally redeployed): `http://127.0.0.1:19999`

## Files

- Compose stack: `ops/observability/docker-compose.yml`
- Runtime env template: `ops/observability/.env.example`
- Dozzle auth bootstrap script: `ops/observability/scripts/generate-dozzle-users.sh`
- Netdata local-only bind config: `ops/observability/netdata/netdata.conf`

## First-Time Setup

1. Copy `ops/observability/.env.example` to `ops/observability/.env`.
2. Generate a Dozzle user file:

```bash
cd ops/observability
./scripts/generate-dozzle-users.sh ops-admin '<strong-password>' ops@example.com 'ClashCookies Ops'
```

3. **Only when explicitly provisioning/redeploying the stack:** review the compose file first. The observed 2026-11-14 host intentionally removed Netdata, so the following legacy command is **not approved** for routine operations; it may recreate retired services.

```bash
docker compose -f ops/observability/docker-compose.yml up -d
```

4. Open Uptime Kuma through the SSH tunnel and create the first admin account.
5. In Uptime Kuma, add a Discord notification endpoint using your Discord webhook URL.

## Recommended Monitors

**Current deployment note:** Production monitors are applicable. Staging references below are **design examples for an environment that was removed in November 2026**, not monitors/URLs expected to be live; do not create or re-enable staging automatically.

### Safe default on the droplet

Use Docker Container monitors from inside Uptime Kuma:

- Production app container
- Staging app container

This works immediately with the localhost-only Uptime Kuma deployment because the Kuma container mounts the Docker socket privately.

### Optional HTTP health monitors

If you also map the app health endpoint to localhost ports, use HTTP monitors:
### HTTP readiness monitors to add alongside container monitors

Keep the Docker Container monitors above, and add HTTP monitors for app readiness:

- Production URL: `http://host.docker.internal:8085/healthz`
- Staging URL: `http://host.docker.internal:8086/healthz`
- Expected status: `200`

If `host.docker.internal` is not available in your Docker runtime, use the droplet host gateway IP from inside the Uptime Kuma container instead.

Result:

- container monitors tell you whether the container is up
- HTTP monitors tell you whether the bot is actually ready

## Bot Health Endpoint

The bot exposes:

- `/livez` for process liveness
- `/healthz` for readiness

Readiness returns HTTP `200` only when:

- the Discord client is ready
- the database probe succeeds

Recommended container port mapping on the droplet:

- Production app: `127.0.0.1:8085:8080`
- Staging app: `127.0.0.1:8086:8080`

## Secrets And Manual Inputs

- Discord webhook URL for Uptime Kuma notifications
- Dozzle username/password generated into `ops/observability/dozzle/users.yml`
- Optional custom bind ports in `ops/observability/.env`

Do not commit `ops/observability/.env` or `ops/observability/dozzle/users.yml`.

## Update And Restart Workflow

Refresh observability images and restart the stack:

```bash
docker compose -f ops/observability/docker-compose.yml pull
docker compose -f ops/observability/docker-compose.yml up -d
```

Restart without image updates:

```bash
docker compose -f ops/observability/docker-compose.yml restart
```

Check status:

```bash
docker compose -f ops/observability/docker-compose.yml ps
```

Check logs:

```bash
docker compose -f ops/observability/docker-compose.yml logs --tail=100
```

## Notes

- Dozzle reads the Docker socket, so keep it localhost-only or put it behind strong auth if you ever expose it.
- Netdata is configured for local-only access in `ops/observability/netdata/netdata.conf`.
- The bot and database deployment flow stays separate from the observability compose stack.
- Keep internal telemetry docs and external stack docs aligned when monitors, health paths, or scheduled report behavior change.

## FB-002 P4b calculation diagnostics

Composition calculation policy is identified by the immutable, deeply validated `legacy-v1` profile and its policy version inside code; this is diagnostic context, not reference provenance. The shared profile core validates original factual observations before aggregation, rejects contradictory calculation overrides and malformed generic reader values, checks safe count/weight/deviation arithmetic and missing-slot bounds, and centralizes unavailable projection construction so stale target deltas, scores, and recommendations cannot survive failed validation. Auto reports supported status only with finite deviation arithmetic and a safe resolved-plus-added total; Custom clears target-derived fields when its score is unavailable, while Raw retains its intentional null-score behavior. Member-count and unresolved-weight metadata are validated before both allocation and no-missing projection paths, and missing-slot execution is bounded to the 50-member roster contract. It keeps factual observations while reporting target-dependent results as UNKNOWN when normalized target evidence, global integrity, roster evidence, representative evidence, or profile coverage is unavailable. Generic profiles may provide an independent reference/count reader through every projection, scoring, and action-simulation path; advice diagnostics retain calculation identities, grouped swaps use a deterministic populated factual source, display deltas derive from calculation-space counts, display mappings are explicitly unambiguous, and Best Fit uses profile-derived upper bounds to add previously absent supported display buckets. Unavailable action evaluations are excluded from ranked alternatives. Diagnostic native profile/candidate artifacts remain non-authoritative and must never be logged or treated as active targets solely because they contain a profile name or populated counts. P4b does not add persistence, scheduler, source-ingestion, or native activation behavior.

## FB-002 P4c source-evidence diagnostics

`[fwa-feed] event=war_members_tracked_roster_refresh` now includes bounded source-evidence statuses for structure, completeness, direct weights, exact-war binding, source generation, and sorted reason codes. The evidence contract also distinguishes raw rows, ordinary parser-accepted rows, parser-rejected/discarded rows, and parsed rows ineligible for native evidence. These fields describe the fetch observation only; they do not authenticate the source, authorize a native target, or expose member payloads. Missing source-declared size/total is `UNAVAILABLE`; malformed rows, declared mismatches, invalid direct weights/positions, duplicate identities/positions, and contradictory opponents are `CONFLICTING`. Whole-source weight proof requires no parser-rejected rows, and completeness requires distinct player identities and exact positions with no discarded rows. The live source is expected to report exact-war and generation authority as `UNAVAILABLE` until an approved upstream proof and durable history owner exist. Persisted candidate generation remains read-only and reports UNKNOWN for the current source category.
