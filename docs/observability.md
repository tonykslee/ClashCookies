# Observability

## Historical participation backfill

The one-time operator utility emits bounded, structured lines with the prefix `[membership-participation-backfill]`. Per-war lines include guild, sync, clan, canonical war ID, action, archive/reconstruction/existing/planned counts, expected team size, projected coverage, and reason codes. The summary includes selected syncs, canonical FWA candidates, validated/dirty point evidence, exact-tuple canonicalization and stale-ID repair counts, unmatched/ambiguous tuple counts, planned rows, unreconstructable rows, COMPLETE/PARTIAL/UNKNOWN projected rosters, skips, and conflicts. Dry runs perform no writes; apply mode prints a post-write verification summary.

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

### FWA weight-alert delivery

The existing FWA Clans.json scheduler invokes weight-alert evaluation only after a fresh catalog sync reports `SUCCESS` or `NOOP`. Delivery is failure-isolated from feed synchronization and uses the durable `FwaWeightAlertDelivery` row keyed by clan and persisted `weightSubmitDate` for claims, retries, and terminal `SENT` state. Bounded `[fwa-weight-alert]` events are `cycle_complete`, `cycle_skipped`, `routing_missing`, `delivery_sent`, and `delivery_failed`; cycle events contain aggregate counts, while per-event lines identify the affected clan and destination without logging message content. The evaluator bulk-reads enabled `FwaWeightAlertConfig` rows, `FwaClanCatalog.weightSubmitDate`, and `TrackedClan` routing; it does not perform FWAStats HTTP work.

Only an active runtime may send to the configured `TrackedClan.leaderChannelId` and mention its configured `TrackedClan.leadRoleId`. Mirror and staging runtimes skip delivery, and there is no separate alert timer, scheduler, or `BotPollJobStatus` entry.

### Layout expiration-alert delivery

`LayoutAlertSchedulerService` runs an immediate startup cycle and then one active-production cycle per hour. Mirror, staging, development, and unknown runtimes skip the timer and send path. `LayoutAlertDeliveryService` evaluates `LayoutRecord.lastConfirmedAt ?? submittedAt`, requires complete canonical Discord provenance, and claims independent DM and CHANNEL rows keyed by the immutable freshness anchor. Default-channel routing is resolved at send time from the canonical post guild's typed `layout-alerts` setting; missing routing has no generic fallback. A final layout/config re-read can supersede a stale episode or leave a policy-changed delivery retryable.

### Roster lifecycle reconciliation

`RosterLifecycleSchedulerService` runs one startup cycle and then every 60 seconds in active production only. It selects only OPEN/ACTIVE rosters with non-null `endsAt <= now`, conditionally transitions each due `Roster` row to CLOSED, and refreshes the tracked roster post from DB-backed state. Mirror, staging, development, and unknown runtimes do not close rosters or edit Discord posts. Bounded `[roster-lifecycle]` events include `scheduler_started`, `cycle_complete` counts (`due`, `closed`, `closure_failed`, `refreshed`, `refresh_skipped`, `refresh_failed`), `post_refresh_skipped`, and `post_refresh_failed`; one Discord refresh failure is isolated from other due-roster closures. The `roster_lifecycle_scheduler` `BotPollJobStatus` row reports the display name, 60-second interval, runtime guard outcome, and actionable failure state.

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
- autorole scheduler cadence decision logs with `guild_id`, `cadence_anchor_started_at`, `next_due_at`, `current_time`, `interval_minutes`, and `cadence_reason`; completed scheduled guild runs anchor the cadence, manual refreshes do not reset it, failed scheduled runs do not reset it, and overdue scheduled runs still dispatch with a fresh CoC queue deadline
- autorole run lifecycle logs with persisted `run_id`, `guild_id`, `run_scope`, `run_trigger`, `scope_target_id`, and final `status` so refresh outcomes are visible without inferring trigger correctness from telemetry
- war-event producer logs such as `war_event_player_refresh_plan`, `war_event_player_refresh_chunk`, `war_event_player_refresh_stagger`, `war_event_player_refresh_deferred`, and `war_event_player_refresh_complete`
- maintenance-window notices from active war polling, routed to the typed `/bot-logs type:maintenance` channel when configured and otherwise to the generic bot-log channel; dedupe state is persisted per guild by `MaintenanceWindowService`
- automatic sync retrospective reconciliation emits compact `[retrospective-auto-post]` events: `event=delivered` is INFO with guild, sync, participant, channel, and message identifiers; completed-before-enable suppression is DEBUG; incomplete/terminal/disabled skips are DEBUG; unavailable destinations are WARN; and claim, render, send, or delivery-state failures are ERROR. It runs inside the existing scheduled sync reconciliation loop and does not emit one INFO line per polling cycle.
- CWL event-resolution and persistence logs such as `event=event_resolution_unresolved`, `event=event_resolution_collision`, `event=event_war_tags_attached`, `event=clan_current_event_changed`, `event=tracked_cwl_persist`, and `event=tracked_cwl_season_roster_reconcile`
- finalized war-plan history logs such as `event=evaluation_completed`, `event=evaluation_failed`, `event=evaluation_terminalized_non_fwa`, `event=evaluation_claim_unavailable`, `event=evaluation_canonical_reset`, `event=evaluation_reactivated`, `event=evaluation_claim_lost`, and `event=reconcile_complete`, which should include `guild`, `war_id`, `clan_tag`, `status`, `violation_count`, `attempt`, `duration_ms`, and `failure_code` when applicable
- final war-end persistence should keep the canonical history/enrollment transaction boundary silent on success and only emit follow-up logs after `WarLookup`, participation, and finalization steps complete
- FWA tracked-war roster summaries such as `event=tracked_war_roster_sync` and `event=war_members_tracked_roster_refresh`, which show the exact current-war identity that was stamped onto the derived tracked roster after each successful WarMembers fetch
- active FWA sync resolution emits bounded `[sync-cycle] event=active_resolve` outcomes for exact, derived, ambiguous, terminal-schedule, and conflict decisions; these include guild, reason, and counts rather than points-site payloads, so local chronology failures remain visible while stale external data cannot silently rewrite `SyncCycle`
- todo snapshot WAR owner resolution logs such as `event=todo_war_owner_resolution_summary` and `event=todo_war_owner_resolution_ambiguous`, which summarize live-verification outcomes and surface ambiguous multi-clan matches when stale roster state needs correction
- alliance membership interval collection logs such as `[alliance-membership-history] event=reconcile_cycle`, which provide one bounded per-cycle summary with `monitored_clans`, `fwa_rosters_reused`, `cwl_only_fetches`, `failed_clans`, `observed_players`, `opened`, `refreshed`, `transferred`, `departed`, `tracking_stopped`, `ambiguous`, and `duration_ms`; failed interval transactions are logged as `event=reconcile_cycle_failed` and do not abort the rest of activity observation
- membership tenure analytics emits a bounded `[membership-streak] event=bulk_resolution` summary for guild/player/boundary counts; active-war roster identity/read failures are WARN-level and fail closed as UNKNOWN, with no player-level roster payloads logged.

CWL alliance activity logs should stay structured and compact. The active read-only report emits one bounded summary such as `[cwl-alliance-activity] event=activity_summary` with `season`, `cwl_clans`, `resolved_events`, `pre_fwa_clans_covered`, `pre_fwa_accounts`, `cwl_participants`, `both`, `fwa_only`, `cwl_only`, `post_fwa_clans_covered`, `duplicate_reconciliations`, and `duration_ms`. It must not log or imply external API work, and it does not emit view/page/guild counters.

CWL camping logs should stay to one bounded invocation summary: `[cwl-camping] event=report_summary` with `guild_id`, `season`, `tracking_coverage`, `interval_rows`, `attributed_accounts`, `campers`, `unattributed_accounts`, `currently_camping`, `overlap_reconciliations`, and `duration_ms`. The service is read-only and emits no per-player success logs.

## External Droplet Observability

The current droplet stack uses:

- Uptime Kuma for status pages, checks, and Discord alerts
- Dozzle for live Docker logs
- Netdata for host and container metrics

The stack is intentionally private by default:

- Uptime Kuma binds to `127.0.0.1:3001`
- Dozzle binds to `127.0.0.1:8080`
- Netdata binds to `127.0.0.1:19999`

Use SSH port forwarding to access the UIs from your machine instead of exposing them publicly:

```bash
ssh -i C:\Projects\clashcookies_codex ^
  -L 3001:127.0.0.1:3001 ^
  -L 8080:127.0.0.1:8080 ^
  -L 19999:127.0.0.1:19999 ^
  codex@64.23.164.95
```

After the tunnel is open:

- Uptime Kuma: `http://127.0.0.1:3001`
- Dozzle: `http://127.0.0.1:8080`
- Netdata: `http://127.0.0.1:19999`

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

3. Start the stack:

```bash
docker compose -f ops/observability/docker-compose.yml up -d
```

4. Open Uptime Kuma through the SSH tunnel and create the first admin account.
5. In Uptime Kuma, add a Discord notification endpoint using your Discord webhook URL.

## Recommended Monitors

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
