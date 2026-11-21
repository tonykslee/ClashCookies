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
| FB-012 — TH19 and Legend autorole safeguards | [#2089](https://github.com/tonykslee/ClashCookies/pull/2089) merged 2026-11-20 UTC at `ab6316a` | **Pending production verification**; historic removed roles not restored; cause of historic mass removal not established | [Feature history](feature-history.md) |
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

- **Status:** Classification work is present on `dev`; **P0 containment is in progress on `feature/th19-reference-integrity` (PR #2109 review pending)** — not merged or published.
- **Suggested priority:** High
- **Request:** Update composition tools to support the new Town Hall 19 war-weight range.
- **Owner-confirmed range (2026-11-19):** TH19 is **181,000–190,000 inclusive**, following the existing 10k TH bucket convention. Preserve TH18 as 171,000–180,000; malformed or out-of-band weights must not silently map to an adjacent TH.
- **Scope to investigate:** Shared weight-to-TH bucket logic, `/compo place`, `/compo advice`, `/compo state`, linked spreadsheet assumptions, and tests.
- **Important:** The owner confirmed the classification cutoff, **not** a TH19 target composition or replacement HeatMapRef profile. Current reference tables and seed workbook top out at TH18. Extend actual classification and the user-facing commands without inventing TH19 reference counts or claiming unsupported composition advice; mark target comparisons UNKNOWN until valid reference data is available. Prefer one shared ordered TH weight-band definition and dynamic command upper limits rather than repeated hardcoded TH18/TH19 maximums.
- **Done when:** TH19 weights are correctly recognized and represented across affected composition outputs with boundary tests and no regression to earlier TH buckets.
- **Implementation note:** This slice keeps the existing `/compo state` layout for clans without observed TH19, adds factual TH19 count/weight visibility when present, and fails closed for target-derived advice, placement, replacement, fill, and `/link list` indicators. No schema or HeatMapRef seed change is included.
- **P0 containment note (local PR validation, pending merge):** Unsupported TH19 effective rosters are excluded before legacy HeatMapRef conversion, including weights imputed by existing missing-weight handling. Ordinary legacy eligibility exclusions remain eligible for a supported cohort, while any effective TH19 evidence blocks global replacement; no-source and no-qualifying evidence also preserve prior rows. The global versioned `BotSetting` integrity/provenance record is distinct from guild scheduler checkpoints and persists blocked state across cycles, retries, restarts, guilds, and unscoped reads until a genuinely safe validation succeeds. Each evaluation fences its pending and final state with a unique durable generation token, so superseded cross-process evaluations cannot publish rows or clear newer blocks. Replacement rows and matching SHA-256 provenance publish together under a transaction lock; pending, missing, malformed, or mismatched provenance is UNKNOWN. Seed/upsert and mirror writers do not inherit validation, so historical rows remain displayable but target use fails closed when provenance is absent. Consumers withhold retained references as UNKNOWN; factual composition, vacancies, and filler availability remain visible, historical display remains available with a warning, and fill recommendations are suppressed. Blacklist samples require exact 50-player, nonnegative-integer, sum-complete raw counts before normalization. This is containment only; it does not add TH19 targets or establish whether existing production references are contaminated.

### FB-003 — Redesign `/compo state` for quick visual scanning

- **Status:** **Queued next after FB-002 (second)** — redesign proposed
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
- **Reported regression (2026-11-20):** The owner observed `all spun` after only one clan was marked spun, despite other participating clans remaining unchecked. Track the corrective investigation separately under **FB-015**; the existing `dev` implementation does not establish correct observed production behavior or a known root cause.

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

### FB-009 — Monthly Dusk Update: approved one-click Discord publishing

- **Status:** Proposed (draft/reminder is scheduled outside the bot; Discord publishing automation is **not** implemented).
- **Request:** Generate one human-readable monthly update from `docs/feature-history.md`, verified production deployments and user/leader-facing changes, then present a private **Approve / Revise / Skip** action. The first public edition follows independently verified Duskits economy production launch.
- **Existing foundations:** [Monthly editorial template and policy](monthly-dusk-updates.md); `.github/workflows/discord-releases.yml` already posts GitHub Releases to configured DEV/PROD Discord webhooks on `release:published`, which may be broader than the intended audience.
- **Required safeguards:** Explicit authenticated per-edition approval; separate draft from publication; verify destinations, audience, and optional role pings; no unpublished/development-only claims; stable edition ID and idempotent delivery; store posting timestamp, channel/message link, operator identity and publish outcome; handle retries without duplicate posts; SKIP or missing approval means no publication. Do not reuse an approved edition to authorize a later one. Preserve GitHub release/deployment independence.
- **Done when:** A qualified monthly draft can be approved once and delivered exactly once to the intended channel, or revised/skipped without posting; the publishing action and verification evidence are recorded in feature history. No automatic code release, deployment, wallet issuance, or unapproved announcement.

### FB-010 — Discord `/example ref:` screenshot showcase command

- **Status:** Proposed code/tooling implementation; documentation policy is agreed in [feature showcase](feature-showcase/README.md).
- **Suggested priority:** Medium-high (developer productivity and command discovery).
- **Agreed UX:** An admin/developer-only Discord slash command, `/example ref:<stable-reference>`, with autocomplete. For example, `/example ref:linklist-01` renders one capture-ready synthetic `/link list` view directly in Discord; `linklist-02` renders a purposeful alternate state. Each user-facing feature PR supplies 1–3 stable references as its screenshot checklist. No local command or live war/roster setup should be needed for the operator.
- **Required behavior:** Register `/example` for a tightly limited authorized admin/developer audience only, default private/ephemeral response and prevent generic Post to Channel exposure. No public unrestricted command, production/staging DB or CoC API, unauthorized Discord posts/DMs, reward issuance, historical mutations, or real identities. Use synthetic named fixtures, real rendering path where feasible, clear `DEMO / SYNTHETIC` labeling, minimal dependency footprint, and coverage for normal, partial/UNKNOWN, and critical alternate states. If an actual Discord screenshot is required, keep it inside a deliberately isolated opt-in developer sandbox with an explicit safety gate; never reuse prod routing.
- **Integration:** Store sanitized images, captions, command/permissions, PR and capture provenance under `docs/feature-showcase/<feature-slug>/`. Reuse the canonical [spotlight template](templates/command-spotlight.md). Require a small screenshot plan for user-visible feature PRs, with justified exceptions for urgent or nonvisual work.
- **Initial implementation slice:** Support `linklist-01` normal Compo indicators, `linklist-02` mixed surplus/deficit, and `linklist-03` missing/partial ACTUAL data. Route synthetic view models into existing `LinkListRender` helpers, preserve actual embed formatting, and avoid live interactions/buttons unless proved inert/sandboxed. Unknown refs reply privately with valid suggestions.
- **Done when:** The user invokes `/example ref:linklist-01` in an authorized Discord context and sees a capture-ready, correctly labeled example using the real renderer; all three refs are stable, tests verify non-admin denial and absence of external side effects, and an example feature showcase is committed and reviewed. No code merge or production deployment is authorized by this backlog entry.

### FB-011 — Command discovery, spotlight content library and screenshot backfill

- **Status:** Agreed editorial/process goal; posting automation is not implemented.
- **Request:** Curate concise command spotlights and sanitized visuals so Rising Dawn members and leaders discover useful Dusk capabilities instead of relying on finding commands through `/help`.
- **Existing foundation:** [showcase policy](feature-showcase/README.md), [command spotlight template](templates/command-spotlight.md), [monthly Dusk Updates](monthly-dusk-updates.md). Build from verified commands, permissions and current production capabilities.
- **Approach:** Capture most relevant 1–3 images per command during feature delivery or a scoped post-merge doc follow-up, maintain a reusable command page with scenarios/captions, and select valuable spotlights for approved monthly announcements. Prioritize popular, underused leader commands first; do not require mass backfilling or automatic Discord posts.
- **Done when:** Each spotlight is copy-ready with audience, value, exact invocation, expected output, limitations, sanctioned screenshots and GitHub source evidence. Only actual approved and verified posts are recorded as published.

### FB-012 — Urgent TH19 autorole and league-role regression

- **Status:** **Implemented on `dev`** in [merged PR #2089](https://github.com/tonykslee/ClashCookies/pull/2089) (2026-11-20 UTC; merge `ab6316a`); **not production-verified**. No historical mass-role restoration has occurred.
- **Priority:** **Urgent / P0** — role assignment is user-visible and reported to interfere with existing league autoroles.
- **Observed by owner (2026-11-17 and clarified 2026-11-19):** No members were receiving the new **TH19** Discord role. Existing league roles were being **removed**, apparently including almost everyone with `@legend`, costing access to the Legend channel. An upstream API league-definition change is a hypothesis, **not** verified production evidence. Exact affected cohort, mappings, and how the symptoms relate remain unverified.
- **Repository diagnosis (2026-11-19):** The autorole rule validator rejected TH19 due to a hardcoded TH18 maximum. League matching already understands Legend I/II/III, but stale removal can act on missing/unknown league observations. Merged #2089 adds future-compatible TH validation, league-tier ID matching, and a shared evidence-safety predicate protecting both league-role grants and removals under missing, stale or contradictory observations. It does not establish the cause of historical Discord role removals or restore them.
- **Request:** Update Dusk's Town Hall autorole support for **TH19** and investigate/fix the associated **league autorole** regression without breaking prior TH tiers or league assignment/removal rules.
- **Diagnosis required before coding:** Inspect `/autorole` configuration, TH and league role mapping/resolution, account and Discord identity grouping, CoC source-level parsing, permission/role hierarchy and update/reconciliation paths. Verify why no TH19 roles were assigned and whether TH19 changes are suppressing, clearing, or misclassifying league roles; distinguish code behavior from missing role IDs/configuration or Discord permissions.
- **Safety:** Use read-only diagnostics and synthetic/disposable tests; do not mass-edit Discord member roles, run production reconciliation, backfill assignments or deploy without separately reviewed authorization. Preserve intended roles on ambiguous/missing data; fail safely and avoid unnecessary role churn.
- **Done when:** Verified TH19 accounts are deterministically eligible for the configured TH19 role, prior TH roles and league autoroles continue to behave correctly, permission/missing-role cases fail safely, and focused tests cover TH18→TH19, multiple linked accounts, missing/unknown league information and role add/remove behavior. Any required production role reconciliation must have its own controlled plan and approval.
- **Related but separate:** FB-002 (TH19 composition weight buckets) is **not** the autorole fix.

### FB-013 — Browse non-FWA layout posts by author and freshness

- **Status:** Proposed
- **Suggested priority:** Medium
- **Request:** Add a browse/list view for tracked non-FWA `/layout post` submissions, analogous to the existing `/fwa layout` listing and freshness table. Allow a user to specify a Discord poster to see that person's posted layouts.
- **Requested presentation:** Paginated Discord embeds showing each post's **Town Hall**, **Title**, and the same useful freshness information available in the FWA layout listing. Order entries by **Town Hall first**, then **Title alphabetically** within each Town Hall. Include a direct link to each canonical Discord layout post where available.
- **Design considerations (not yet decided):** Choose a clear command name and whether the author filter is optional or required; define whether the default view is the invoking user's posts or all accessible posts; reuse authoritative `LayoutRecord` post provenance and freshness (`lastConfirmedAt ?? submittedAt`), rather than `FwaLayouts` or `updatedAt`; exclude FWA-canonical records from the non-FWA view without losing other generic submissions; preserve guild visibility, authorization and privacy; handle untitled posts, missing/deleted Discord messages, unknown freshness, stable sorting/tie-breakers and pagination boundaries. Do not infer that a poster is the owner of a layout solely from a link.
- **Done when:** A user can browse the requested poster's non-FWA layout posts in a readable paginated embed, sorted by Town Hall and title, with accurate freshness and links, without exposing inaccessible guild posts or mixing in the FWA catalog.

### FB-014 — Improve FWA outcome intelligence using current points

- **Status:** Proposed
- **Suggested priority:** High
- **Request:** Improve FWA war outcome inference when the FWA points site displays a stale or incorrect matchup. Currently this can leave the bot showing an UNKNOWN outcome despite having points for the relevant FWA clans.
- **Owner-reported source behavior:** The points site displays each clan's current points and the timestamp of its latest war update; the owner reports that current points remain correct even when the displayed matchup is wrong. Treat this as a hypothesis to verify against actual snapshots, timing and existing outcome rules rather than silently assuming every observed value is fresh.
- **Desired logic:** Use the **current points for both verified FWA clans** to determine the expected winner/loser even when the displayed opponent pairing is stale or incorrect. If points are tied, apply the **correct canonical sync number** and established tie-resolution policy; investigate and reuse existing sync-number hardening rather than reimplementing it.
- **Requested presentation:** Do not show UNKNOWN radio bullets merely because the points-site matchup is wrong when both clans have known, sufficiently fresh and trustworthy points and the applicable sync/tie rules resolve the outcome. Preserve an explicit UNKNOWN state for genuinely insufficient, contradictory or stale evidence.
- **Investigation and safeguards:** Trace points-site ingestion, latest-war-update timestamps, clan identity matching, outcome inference, sync number and Discord radio/indicator rendering. Establish when a points snapshot is applicable to the war being evaluated (including asynchronous updates, rollover, stale caches and opponent changes), and distinguish expected FWA winner from independently verified actual war result. Avoid guessing from one clan's points, an unverified opponent, or an unverified tie-break; record inference provenance and regression-test the failure cases.
- **Done when:** A stale/mismatched points-site opponent no longer forces UNKNOWN for a verifiable FWA-versus-FWA matchup with applicable points (including correctly resolved ties), and the indicator reliably shows the inferred outcome without mislabeling ambiguous or outdated evidence.

### FB-015 — Regression: `all spun` posts before every participating clan is marked spun

- **Status:** Proposed regression fix; **owner-observed 2026-11-20**, root cause and deployed code revision not yet verified.
- **Suggested priority:** High — false alliance-wide completion announcements.
- **Observed:** Dusk sent the exact `all spun` message after **only one clan** was marked spun, even though other required clans had not been checked off.
- **Expected:** Publish `all spun` **only once**, and only after every distinct participating clan on the **current canonical sync** has a valid active spin-status claim. A single clan's reaction must never complete a multi-clan sync.
- **Investigation:** Examine the source sync root's `metadata.clans` participant set, root/status-child identity resolution, accepted reactions and persisted `TrackedMessageClaim` state, claimed/participating counts, and `SyncAllSpunAnnouncementService` delivery/recovery. Distinguish an incomplete/malformed participant denominator from incorrect claim counting, stale sync identity, or a deployed-version mismatch; do not pre-assign a cause.
- **Regression coverage:** Multi-clan case with only 1/N, N−1/N, and N/N claims; duplicate/reacted-across-posts claims counting once; removed/reversed claims; stale/prior-sync claims and cross-guild isolation; missing/ambiguous participant data must fail closed; concurrent/replayed evaluations must not send duplicate announcements. Preserve the configured sync destination and production-only delivery guard.
- **Done when:** The announcement never fires early for an incomplete current sync, fires once when the last required clan is acknowledged, and the underlying cause is documented with focused tests. Related implemented feature: **FB-005**; this entry is a **fix request**, not a claim that the original feature was never implemented.

### FB-016 — Regression: Bases checklist completion does not suppress clan reminders

- **Status:** Proposed regression fix; **owner-observed 2026-11-20**, root cause and affected cohort not yet verified.
- **Suggested priority:** High — false, unnecessary clan-leader notifications.
- **Observed:** Clan leaders marked their corresponding clan's **FWA Bases checklist** as checked and `Bases checked and all good`, yet those same clans still received messages saying bases needed checking.
- **Expected:** A valid, persisted `/fwa match-checklist type:Bases` completion (via the supported command or reaction flow) for the **same guild, clan, war, and sync identity** must suppress `Bases not checked` reminders for that clan. Other clans with legitimately incomplete checklists must continue receiving applicable reminders.
- **Investigation:** Trace persisted checklist acknowledgment/completion, current effective Bases render state, status refresh timing, `findPendingFwaBasesChecklistReminderCandidates`, `basesChecklistReminderSchedulerService`, active-war/sync fallback identity matching and offset dedupe. Inspect whether a completed acknowledgment was overlooked, became associated with a different identity, or raced with reminder delivery; do not conflate a Bases checklist acknowledgment with proof of an actual base swap/correction.
- **Regression coverage:** Completed versus unchecked clans in the same guild/war; both command and reaction acknowledgments; late completion before an offset fires; stale/previous-war completion; missing or inconsistent identity; repeated scheduler ticks and reminder dedupe (currently 12h/6h/3h/1h buckets). Do not suppress genuine unchecked reminders or create new notification routing.
- **Done when:** No `Bases not checked` reminder is delivered for a validly checked-and-all-good clan for that war/sync, while incomplete clans still receive correctly scoped, idempotent reminders. Related reporting request **FB-008** remains a separate feature, not this regression.

### FB-017 — Replace `/link list` Compo arrows with repeated plus/minus signs

- **Status:** Proposed
- **Suggested priority:** Low (display refinement)
- **Request (2026-11-20):** Replace the numeric up/down arrow indicators in the optional `/link list` Compo view with one `+` per surplus unit and one `-` per deficit unit; retain `=` for an equal composition bucket.
- **Examples:** Three surplus: `+++` instead of `↑3`; two deficit: `--` instead of `↓2`; equal: `=`. Magnitude is represented by the number of signs, not a numeric suffix. Preserve the existing distinct `—` unknown/unavailable indicator.
- **Scope:** Presentation only; retain the existing composition calculations, weight buckets, data sources, optional view behavior, and sorting. Maintain readable alignment and Discord message/pagination limits for larger magnitudes without silently misrepresenting counts. Update affected render tests, help/legend text and screenshot records when implemented.
- **Done when:** All affected Compo rows render the corresponding repeated signs, equal and unknown remain distinguishable, and existing surplus/deficit calculations are unchanged.

## Archived / withdrawn requests

_None yet._
