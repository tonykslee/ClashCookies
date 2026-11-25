# FB-026 Scheduler rejection audit

Date: 2026-11-25 (America/Los_Angeles)

Repository: `tonykslee/ClashCookies`

Investigated checkout: `ca017d36d49886b8e51ad6fbe8a2cd69761c9944` (`dev@ca017d3`)

Issue: #2176

## Scope and finding

The current checkout was audited for recurring timers, startup cycles, delayed or jittered invocations, and detached asynchronous work that can reach a rejected Promise without a local boundary.

The equivalent production scheduler gap was confined to `src/services/remindme/UserActivityReminderSchedulerService.ts`:

- `start()` launched the immediate cycle with `void this.runCycle()` and registered an interval with another bare `void this.runCycle()`.
- `runCycle()` can reject after Prisma rule reads, snapshot reads, `CurrentWar` reads, delivery claims, or delivery-state persistence.
- Its `finally` block already releases `inFlight`, and its non-queue-skip branch intentionally rethrows for direct callers.
- Both automatic boundaries now attach rejection handlers. They emit bounded `event=automatic_cycle_failed` diagnostics with `scheduler=user_activity_reminder_scheduler`, `trigger=startup|interval`, and a sanitized/truncated `failure_code`. No automatic retry was added.

## Reviewed paths

| Path | Entry points reviewed | Existing containment / result |
| --- | --- | --- |
| `src/services/reminders/ReminderSchedulerService.ts` | Immediate and interval guild reminder cycles | Already catches both automatic `runCycle()` rejections; direct `runCycle()` semantics remain rejecting. |
| `src/services/ActivityObserveStartupService.ts` | Startup, delayed startup, interval, and mirror-disabled status writes | Inner cycle/status writes and the outer detached wrapper are caught; no equivalent gap confirmed. |
| `src/listeners/ready.ts` | Recruitment, deferment, tracked-message, war-event, mirror-sync, scheduler startup, active/mirror branching | Startup calls are awaited or intentionally started through services; interval callbacks attach catches and preserve queue-skip handling. User-activity scheduling is active-only; mirror disables it. |
| `src/services/AutoRoleSchedulerService.ts` | Immediate and interval cycles plus mirror status write | Automatic cycle and status-write rejections are caught. |
| `src/services/ScheduledSyncPostSchedulerService.ts` | Immediate and interval cycles plus mirror status write | Automatic cycle and status-write rejections are caught. |
| `src/services/fwa/basesChecklistReminderSchedulerService.ts` | Immediate and interval cycles | Automatic cycle rejections are caught. |
| `src/services/fwa/baseSwapDmReminderSchedulerService.ts` | Immediate and interval cycles | Automatic cycle rejections are caught. |
| `src/services/fwa/matchChecklistAutoPostSchedulerService.ts` | Immediate and interval refresh cycles | Automatic cycle rejections are caught. |
| `src/services/LayoutAlertSchedulerService.ts` | Immediate and interval production cycles | Automatic cycle rejections are caught with bounded failure codes. |
| `src/services/RosterLifecycleSchedulerService.ts` | Immediate and interval production cycles | Automatic cycle rejections are caught with bounded failure codes. |
| `src/services/fwa-feeds/FwaFeedSchedulerService.ts` | Startup jitter and five recurring feed timers | Jitter and interval callbacks attach catches; per-job failures remain isolated. |
| `src/services/telemetry/schedule.ts` and `telemetry/ingest.ts` | Immediate/interval schedule polling and aggregate flush | `tick()`/`flush()` attach catches. |
| Presentation and command timers | Layout auto-collapse, CWL detailed auto-refresh, war-mail polling, interaction timeouts | Reviewed as detached best-effort/UI work; their async operations have local catches or internal `try/catch`. No equivalent production scheduler Prisma gap was changed in this scope. |

## Validation and limitations

Focused Vitest coverage injects Prisma-boundary `P2024` failures into the real scheduler startup and registered interval callbacks, covers consecutive failures followed by recovery, rejected failure-status persistence, overlap prevention and `inFlight` release, direct rejection semantics, and the already-claimed delivery path after successful external dispatch followed by failed persistence. An isolated child process runs the real scheduler under `--unhandled-rejections=strict` with synthetic Prisma failures and a bounded timeout; it must remain alive long enough for a later interval to recover.

The incident report documents `P2024` during deployment run `45506759751` and strongly supports host memory/swap pressure as a contributing condition. The exact connection-pool saturation mechanism is not independently verified here. This change does not alter Prisma pool size, timeouts, concurrency, retry policy, schema, deployment wrappers, production access, or active/mirror ownership.
