# ClashCookies — Feature Backlog

**Owner:** Rising Dawn / Dusk operations  
**Base branch:** `dev`  
**Established:** 2026-11-17

This is the running intake list for user-requested ClashCookies features. It is **not** a record of shipped functionality or an authorization to deploy, alter production, or implement code. Keep items marked `Proposed` until separately designed, approved for implementation as applicable, and verified. Reconcile implementation status against merged PRs and evidence.

## Maintenance policy

- When the project owner adds, edits, reprioritizes, or removes a backlog item, update this file via a **docs-only PR targeting `dev`** without requesting separate approval. Review the exact GitHub diff, consistency, checks, and mergeability before using the standing docs-only merge permission.
- Do not commit directly to `dev` or `main`. Do not mix backlog edits with code, schema, runtime, deployment, or migration changes.
- Preserve stable IDs, original intent, and substantive requirements. When an item is withdrawn, move it to the archived section (rather than silently deleting its history), unless the owner requests complete removal.
- Distinguish **Proposed**, **Agreed specification**, **In progress**, **Implemented**, and **Archived**. An item being on this list does not imply acceptance criteria or implementation details have been finalized.
- Priorities are suggestions, not approved delivery commitments. Follow `docs/ai-development-workflow.md`, architecture contracts, and feature-specific roadmaps before code work.

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

## Archived / withdrawn requests

_None yet._
