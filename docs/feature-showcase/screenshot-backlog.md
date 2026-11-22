# Dusk Screenshot Capture Backlog

**Status:** Initial curated seed; full command inventory and `/example` implementation remain pending.  
**Owner:** Dusk development / command documentation  
**Established:** 2026-11-17  
**Parent policy:** [Feature showcase](README.md) · [Command spotlight template](../templates/command-spotlight.md) · [Feature backlog](../feature-backlog.md)

## How this backlog works

This table is the **operator's capture queue**, not a list of proven live `/example` references. Each row gives an intended stable reference, the exact image to capture, and tracking state. Do not tell the owner to invoke a reference until its registry entry and permission-safe rendering have been verified in a deployed bot.

When `/example` goes live, first **inventory the actual registered commands and usable fixture reference IDs** from the deployed version, then expand this into a prioritized backfill queue. Backfill command discovery starting with high-utility leader and member surfaces; do not claim complete coverage until checked against command registration, `/help`, and active production capabilities.

### State machine

**Fixture state:** `Planned` → `Implemented on dev` → `Deployed / verified` (or `Unsupported`). Record the PR, actual reference ID, and deployment evidence; never assume planned names are executable.

**Image state:**
- `Needed`: no approved current screenshot has been uploaded.
- `Awaiting ref`: desired screenshot exists as a plan but the `/example` reference is not usable yet.
- `Captured / review`: file uploaded, awaiting privacy/accuracy and layout review.
- `Current`: sanitized image reviewed against relevant rendering code and current documented UI version.
- `Outdated`: changed rendering, labels, data semantics, access, defaults, or message structure plausibly invalidate the image. **Do not publish.**
- `Deprecated`: feature removed/superseded or example intentionally retired. Keep historical record/link; never use in current spotlights.
- `Not applicable`: justified absence of useful/safe screenshot.

**Publication state:** `Unpublished` / `Ready after production verification` / `Published` (record actual Discord message link and date). Publication is independent of an image being current or a feature merging into `dev`.

### Starter capture queue (provisional reference codes)

All reference codes below are **proposed**, not verified available. No screenshot assets are claimed to exist.

| Priority | Feature / audience | Planned `/example` invocation | Screenshot goal / caption | Fixture state | Image state | Source / notes |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | `/link list` · clan leaders | `/example ref:linklist-01` | Main linked-member list, normal table with Compo column | Planned | Awaiting ref | [Compo feature #1987](https://github.com/tonykslee/ClashCookies/pull/1987), [fallback #2011](https://github.com/tonykslee/ClashCookies/pull/2011); FB-002 requires factual TH19 weight/count handling without a guessed indicator |
| P0 | `/link list` · clan leaders | `/example ref:linklist-02` | Highlight side-by-side surplus and deficit indicators | Planned | Awaiting ref | Same formatter; synthetic ACTUAL weight/compo; include a legacy supported target case and keep TH19 unsupported comparison as unavailable |
| P0 | `/link list` · clan leaders | `/example ref:linklist-03` | Missing/partial composition data; accurate placeholder/fallback | Planned | Awaiting ref | Preserve UNKNOWN and fallback semantics; add an observed-TH19 partial-data fixture when `/example` is available |
| P1 | `/compo state` · clan leaders | `/example ref:compo-state-01` | Current dashboard overview with readable composition summary | Planned | Awaiting ref | FB-002 adds an explicit TH19 observed-count column only when present; target-derived TH19 values remain unknown. Revalidate again when FB-003 redesign ships |
| P1 | `/compo advice` · clan leaders | `/example ref:compo-advice-th19-01` | Observed TH19 advice with factual weight/count and unsupported target comparison | Planned | Awaiting ref | New FB-002 capture need; no HeatMapRef target or recommendation ranking may be fabricated |
| P1 | `/compo place` · clan leaders | `/example ref:compo-place-th19-01` | TH19 placement input showing bucket and UNKNOWN target comparison | Planned | Awaiting ref | New FB-002 capture need; synthetic data only, no production operation |
| P1 | `/compo place` · clan leaders | `/example ref:compo-place-legacy-01` | Supported legacy placement with factual observations, vacancy, and valid recommendations | Planned | Awaiting ref | FB-002 P4a capture need; synthetic complete ACTUAL roster and validated legacy reference; no production identities |
| P1 | `/compo place` · clan leaders | `/example ref:compo-place-mixed-01` | Mixed supported/unavailable cohorts retaining factual rows and UNKNOWN target status | Planned | Awaiting ref | FB-002 P4a capture need; synthetic mixed cohort; unsupported clans must not enter rankings |
| P1 | `/compo place` · clan leaders | `/example ref:compo-place-evidence-01` | Fresh, stale, partial, contradictory, same-cardinality-changed and missing `CLAN_MEMBERS` evidence rendered as observed/stale/UNKNOWN without guessed vacancies | Planned | Awaiting ref | FB-002 P4a capture need; synthetic fixtures only; verify per-clan freshness, post-write snapshot coherence, target availability, preserved FWA weight/in-war fields, and no lower-bound wording for stale/contradictory observations |
| P1 | `/compo place` · clan leaders | `/example ref:compo-place-large-cohort-01` | 50–100 tracked clans with long names paginated into one bounded placement embed per Discord message while every factual observation remains present across pages | Planned | Awaiting ref | FB-002 P4a payload-limit regression; synthetic data only; no production identities; verify requester-owned navigation and refresh behavior |
| P1 | `/compo place` replacement drill-down · clan leaders | `/example ref:compo-replacement-unavailable-01` | Replacement evaluation unavailable/partial state distinct from evaluated empty candidates | Planned | Awaiting ref | FB-002 P4a capture need; synthetic blocked or TH19 reference evidence, no stale candidates |
| P1 | `/compo fill` · clan leaders | `/example ref:compo-fill-01` | Ordinary planner result: validated legacy target, a correctly bucketed recommended move, open slots and available/unavailable filler counts | Planned | Awaiting ref | [FB-002 P1 #2133](https://github.com/tonykslee/ClashCookies/pull/2133); synthetic complete ACTUAL roster only; reference ID is proposed, not executable |
| P1 | `/compo fill` · clan leaders | `/example ref:compo-fill-unknown-01` | Incomplete roster, unavailable reference or unsupported TH19: explicit UNKNOWN target, zero unsupported moves, factual vacancies and fillers retained | Planned | Awaiting ref | [FB-002 P1 #2133](https://github.com/tonykslee/ClashCookies/pull/2133); privacy-safe synthetic data, no real transfers or live writes |
| P1 | `/fwa base-swap` · clan leaders | `/example ref:baseswap-01` | Typical actionable base-swap alert / acknowledgment view | Planned | Awaiting ref | No actual reminders/posts; fake identities only |
| P1 | `/todo` · members/leaders | `/example ref:todo-01` | Typical action checklist and priorities | Planned | Awaiting ref | Confirm present renderer and permissions before implementing |
| P1 | `/remaining` · leaders | `/example ref:remaining-01` | Remaining attacks summary for an active war | Planned | Awaiting ref | Synthetic war only |
| P2 | `/cwl` · leaders | `/example ref:cwl-01` | One valuable CWL management/report view | Planned | Awaiting ref | Select exact subcommand after actual inventory |
| P2 | `/help` · all eligible users | `/example ref:help-01` | Interactive help discoverability / command lookup | Planned | Awaiting ref | Show how to find commands |
| Future | Duskits · authorized members | `/example ref:duskits-01` | Private wallet/earned reward overview | Planned | Awaiting ref | **Do not publish until actual production launch and authorized audience; private example only** |

These seed rows reflect requested areas and known command names; they are **not** an exhaustive implementation audit, confirmation that exact variants exist, or instructions to execute unavailable references. Before making a screenshot checklist actionable, replace the proposed reference with a verified code and link its fixture test/PR.

## Owner-facing capture packet

Once a row's fixture is **Deployed / verified**, give the owner a short batch of 2–5 rows in priority order, with copyable `/example ref:...` commands, what should appear, any crop/redaction notes, and a clear way to return the captured files. The operator takes screenshots; Codex/assistant reviews files, curates captions, commits approved versions to `docs/feature-showcase/<slug>/images/`, and moves status `Captured / review` → `Current`. Record capture date, source commit/UI version, privacy-review status, screenshot path and PR link in the feature page.

Do not insist on all screenshots in one session. Keep unfinished rows in the backlog and prioritize by monthly updates/spotlights and underused commands.

## Automatic *review trigger*, not automatic image replacement

On **every PR changing a user-visible rendering surface or command behavior**, the reviewer/Codex must cross-check this backlog and linked feature pages for affected rows, including changed shared renderers, column names/format, permissions, defaults, button behavior, and synthetic fixture semantics.

1. List impacted screenshot IDs, current file paths, and why they may no longer match. Where impact is uncertain, mark **Outdated — review needed**; do not assume unchanged because the slash command name is unchanged.
2. On the **same feature PR where practical**, update the fixture/ref and replace screenshots or record a dedicated docs follow-up linked to that PR. Missing new screenshots remain `Needed`/ `Awaiting ref`.
3. When an implementation PR merges and makes old captures misleading, mark them **Outdated** immediately in a reviewed docs-only PR even if replacement capture is unavailable. Do not delete or overwrite historical evidence without preserving provenance. For removed features, mark **Deprecated**, note replacement/retirement PR, and archive rather than silently erasing the row.
4. For a new approved screenshot, record **captured against commit**, **last checked against commit**, capture method (synthetic vs real), privacy status and published URLs. Moving `Outdated` → `Current` requires review of the new/corrected image against the relevant renderer, **not** just an updated date.
5. Before any monthly update or spotlight post, filter to **Current** images and independently production-verified features. If images are `Outdated`/`Deprecated`/`Awaiting ref`, omit them from publication or request a new capture first.

**This is a required human/Codex PR-review maintenance process, not a currently implemented GitHub bot trigger.** No process can determine visual staleness automatically with full accuracy from PR names alone; explicit impact checks are necessary.

## Per-feature record template

```markdown
| Field | Value |
| --- | --- |
| Screenshot ID | <stable-id> |
| Command surface | /<name> <subcommand> |
| Exact reference | /example ref:<verified-id> |
| Fixture availability | Planned / Implemented on dev / Deployed verified / Unsupported |
| Expected scenario | <one sentence> |
| Screenshot file | <repo-relative path or —> |
| Image state | Needed / Awaiting ref / Captured review / Current / Outdated / Deprecated / N/A |
| Captured against SHA | <commit or —> |
| Last checked against SHA | <commit or —> |
| Privacy review | Pending / Passed |
| Changed-by PR / replacement | <link or —> |
| Spotlight/publication | Unpublished / Ready / Published + URL + date |
```

See [README.md](README.md) for the full privacy, safe-demo, and production-verification rules.
