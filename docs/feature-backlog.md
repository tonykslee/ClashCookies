# ClashCookies — Feature Backlog

**Owner:** Rising Dawn / Dusk operations  
**Base branch:** `dev`  
**Established:** 2026-11-17

This is the running intake list for user-requested ClashCookies features. Related completed patches, dates, and production evidence belong in [feature-history.md](feature-history.md). It is **not** an authorization to deploy, alter production, or implement code. Keep items marked `Proposed` until separately designed, approved for implementation as applicable, and verified. Reconcile implementation status against merged PRs and evidence.

## Maintenance policy

- When the project owner adds, edits, reprioritizes, or removes a backlog item, update this file via a **docs-only PR targeting `dev`** without requesting separate approval. Review the exact GitHub diff, consistency, checks, and mergeability before using the standing docs-only merge permission.
- Do not commit directly to `dev` or `main`. Do not mix backlog edits with code, schema, runtime, deployment, or migration changes.
- Preserve stable IDs, original intent, and substantive requirements. When an item is withdrawn, move it to the archived section (rather than silently deleting its history), unless the owner requests complete removal.
- Distinguish **Proposed**, **Agreed specification**, **In progress**, **Implemented**, and **Archived**. An item being on this list does not imply acceptance criteria or implementation details have been finalized.
- Track dev-completed but not production-verified features in the release reconciliation section below; preserve independent merge and deployment dates. Update [feature-history.md](feature-history.md) for each verified feature patch and production milestone. Do not infer production from `dev` or `main` merges.
- Priorities are suggestions, not approved delivery commitments. Follow `docs/ai-development-workflow.md`, architecture contracts, and feature-specific roadmaps before code work.

## Implemented on dev / pending production verification

These are **not proposed implementation tasks**. Production deployment, migration, and activation must be verified separately before changing their status.

| Feature | Dev implementation | Production status | Historical record |
| --- | --- | --- | --- |
| `/link list` optional Compo surplus/deficit (`↑N`, `↓N`, `=`, `—`) | [#1987](https://github.com/tonykslee/ClashCookies/pull/1987) merged 2026-11-14 UTC; fallback fix [#2011](https://github.com/tonykslee/ClashCookies/pull/2011) merged 2026-11-16 UTC | **Pending production confirmation**. Selective release [#2007](https://github.com/tonykslee/ClashCookies/pull/2007) closed unmerged; full release [#1983](https://github.com/tonykslee/ClashCookies/pull/1983) open/unmerged. | [Feature history](feature-history.md) |
| FB-005 — automatic `all spun` | [#2008](https://github.com/tonykslee/ClashCookies/pull/2008) merged 2026-11-16 UTC | Production delivery/activation not verified | [Feature history](feature-history.md) |
| Immutable sync reaction history foundation (supporting FB-006/007) | [#2010](https://github.com/tonykslee/ClashCookies/pull/2010) merged 2026-11-16 UTC | Production deployment/migration not verified; leaderboard/analytics remain proposed | [Feature history](feature-history.md) |

For other dev-completed features and patches, see [Feature Patch History and Release Tracking](feature-history.md); it is a curated historical seed, not a full deploy manifest.

## Open requests

### FB-001 — Mirror FWA Police violations into clan alert channels

- **Status:** Proposed
- **Suggested priority:** High
- **Request:** Duplicate each FWA Police violation post into the corresponding tracked clan's alert channel so clan leaders have a convenient ongoing view of violations.
- **Design considerations (not yet decided):** Resolve the correct configured clan alert destination; avoid duplicate cross-posts on retries; preserve original violation context and message references; fail safely when no alert channel is configured; protect private/member information and channel permissions.
- **Done when:** Eligible police violations are reliably visible in the correct clan alert channel with no duplicate posts, unexpected channel leakage, or changed existing Police enforcement.

### FB-002 — Add TH19 weight ranges to composition tools

- **Status:** Proposed
- **Suggested priority:** High
- **Request:** Update composition tools to support the new Town Hall 19 war-weight range.
- **Scope to investigate:** Shared weight-to-TH bucket logic, `/compo place`, `/compo advice`, `/compo state`, linked spreadsheet assumptions, and tests.
- **Important:** Verify the authoritative TH19 range against the current FWA composition specification before choosing numeric cutoffs. Do not guess the range or silently reclassify existing entries.
- **Done when:** TH19 weights are correctly recognized and represented across affected composition outputs with boundary tests and no regression to earlier TH buckets.

### FB-003 — Redesign `/compo state` for quick visual scanning

- **Status:** Proposed
- **Suggested priority:** Medium
- **Request:** Make the composition state image easier to read at a glance.
- **Desired changes:**
  - Swap the current X and Y axes.
  - Replace clan-name labels with their configured clan badges.
  - Abbreviate large numeric values (for example, `145k` rather than `145,000`) without hiding precision needed for decisions.
  - Improve scanability with meaningful color cues, clear grouping/spacing, and obvious attention/exception states.
- **Design considerations (not yet decided):** Provide text fallback for missing clan badges, maintain legibility in Discord and accessible contrast, preserve data accuracy and refresh behavior.
- **Done when:** The transposed dashboard reliably conveys clan/bucket status faster and remains readable with missing badges and long or unusual values.

### FB-004 — Post per-clan retrospective after each sync

- **Status:** Proposed
- **Suggested priority:** High
- **Request:** Dusk posts a retrospective in each clan's corresponding alert channel, summarizing important signals from the last sync.
- **Existing related implementation:** The read-only retrospective, alliance command, per-clan drilldown, and automatic **alliance-wide** post are already merged through PRs [#1753](https://github.com/tonykslee/ClashCookies/pull/1753)–[#1756](https://github.com/tonykslee/ClashCookies/pull/1756). This backlog item is specifically for **per-clan alert-channel delivery and requested accountability sections**, not recreating the existing alliance post.
- **Requested sections:**
  - FWA violations, including repeat offenders.
  - Failed base swaps, including repeat offenders.
  - New-member summary.
  - AFK / missed-war-hit summary.
  - Potential mooching: accounts that used only attacks 1 and 2 without contributing war stars (definition and evidence require validation).
  - Count of distinct individual people versus filler accounts.
  - Other important signals as they are identified.
- **Additional candidate insights (suggestions, not yet agreed):** Attack completion rate; comparison with the previous sync.
- **Design considerations (not yet decided):**
  - Define the sync boundary, covered wars, publishing trigger, and whether reports should be editable/re-runnable.
  - Use authoritative persisted war/violation/base-swap/member evidence; make missing or ambiguous values `UNKNOWN`, not accusations.
  - Define a fair repeat-offender window and avoid treating linked alternate accounts as separate people; don't infer filler identity without verified evidence.
  - Scope each report to its correct clan and authorized private alert channel, with idempotent posting and safe handling of unavailable channels or incomplete evidence.
- **Done when:** One accurate, concise, clan-scoped retrospective is posted per eligible completed sync, with correct attribution, repeat-offender logic, no duplicate posts, and explicit unknowns.

### FB-005 — All Spun Announcement (already implemented on `dev`)

- **Status:** Implemented in repository; production deployment/activation not established by this backlog review.
- **Original request:** Announce exactly `all spun` when every participating clan has a valid spin-status claim.
- **Verified existing implementation:** `src/services/SyncAllSpunAnnouncementService.ts` and `docs/sync-all-spun-announcement.md` describe post-sync-time completion, the configured typed `sync` destination, persisted `SyncEvent` delivery state, one-minute recovery, and suppression outside active production. This is **not** a new proposed implementation task.
- **Follow-up only if requested:** Verify deployment/operational behavior separately; do not duplicate the existing feature.

### FB-006 — Sync Spin Race Leaderboard

- **Status:** Proposed (analytics/UI); historical reaction capture foundation exists.
- **Request:** Show a friendly leaderboard ranking clans/leaders by elapsed time from the exact sync time to when the bot observes their valid spin-status claim, plus historical performance.
- **Existing foundation:** `SyncReactionHistory` records immutable accepted ADD/REMOVE transitions and bot-observed timestamps; `TrackedMessageClaim` owns current claimed status. See `docs/sync-reaction-history.md`.
- **Important limitations:** Reactions are **not verified evidence of who queued the search or when the search happened**; pre-sync claims, reversals, duplicates, tied/out-of-order events, missing timestamps, and multiple claimants need explicit policy and UNKNOWN handling. Don't label a leaderboard as confirmed spin speed.
- **Done when:** A read-only, clearly labeled reaction-speed leaderboard derives from canonical sync identity/history, with fair ranking and anti-gaming caveats; no duplicate state owner or historical backfill is assumed.

### FB-007 — Spin Timing and Match Outcome Analytics

- **Status:** Proposed.
- **Request:** Study whether reaction timing relative to sync and official war start is associated with composition deviation or mismatch probability; compare early/on-time/late cohorts over repeated syncs.
- **Available evidence:** Bot-observed `SyncReactionHistory.observedAt` and canonical sync times, plus persisted war timing/outcome and composition evidence where verified.
- **Important limitations:** Reaction time is a proxy, **not actual Clash matchmaking search entry time**. War start is not search start. Report data coverage, measurement uncertainty, possible confounders, and sample size; distinguish association from causation and classify gaps UNKNOWN.
- **Done when:** A reproducible read-only analysis clearly distinguishes observation time, confirmed war start, unobserved search time, composition deviation, and mismatch outcomes without unsupported causal claims.

### FB-008 — Base-Swap Accountability and Repeat Follow-up

- **Status:** Proposed (additional reporting/analytics; existing base-swap posts, acknowledgments, reminders and audit routing already exist).
- **Request:** Track who acknowledged or did not acknowledge required base swaps, unresolved follow-up, and repeat missed acknowledgments across wars/syncs. Surface actionable clan-leader summaries without shaming unsupported cases.
- **Existing foundation:** `/fwa base-swap` uses tracked posts and acknowledgments, optional reminders and audit routes; `TrackedMessage` and existing swap logic own source state. Duskits roadmap also distinguishes an acknowledgment from **proof of an actual base change**.
- **Important limitations:** Nonacknowledgment is not proof that a base was left wrong; an acknowledgment is not proof that a base was corrected. Separate these metrics, and prefer verified war/roster identity. Reuse FB-004 retrospective presentation where suitable rather than duplicating collection.
- **Done when:** Repeat/unresolved swap-accountability reporting is DB-first, clan-scoped, idempotent where messaged, privacy-safe, and accurately separates observed responses from independently verified actions.

## Archived / withdrawn requests

_None yet._
