# ClashCookies — Feature Patch History and Release Tracking

**Owner:** Rising Dawn / Dusk operations  
**Established:** 2026-11-17  
**Source of truth for changes:** merged GitHub PRs and their final diffs; **source of truth for official release promotion:** merged PRs targeting `main`; **source of truth for published announcements and deployment:** separately verified announcement/delivery and production runtime evidence.

This is a **curated, non-exhaustive historical seed**, not a claim that every historical feature is listed or that every merged patch runs in production. Expand it incrementally when older PRs or newly merged patches are verified. Feature-specific roadmaps (including `docs/roadmaps/dusk-economy.md`) remain authoritative for detailed work and safeguards; this index links to them rather than duplicating specifications.

## Status definitions and maintenance

- **Proposed:** No verified merged implementation of the requested behavior. Track scope in [feature-backlog.md](feature-backlog.md).
- **Merged to dev:** The named PR was merged into `dev` on the UTC date shown; this is **development completion**, not deployment.
- **Pending production / unverified:** A merged dev patch has no verified production deployment evidence in this ledger. `main` inclusion alone does not establish runtime activation; a closed, unmerged release PR is not a release.
- **Official release promotion:** A release PR merged to `main`; record its version/label, GitHub UTC merge timestamp, merge SHA and PR separately from runtime deployment and announcement delivery.
- **Release announcement posted:** Record the actual publication destination, message/release URL and observed posting timestamp only after verified delivery. A GitHub release PR, webhook configuration, or successful workflow run alone does not prove a Discord message was posted.
- **Production verified:** Record an observed deployed commit/image, authorized rollout date/time, and operational/health evidence. Only use this label after independent release evidence; leave the date `—` otherwise.
- **Inactive / gated:** A feature may require configuration, flags, migrations, or explicit activation even after deployment. Do not infer this from GitHub merge.
- **Withdrawn/superseded:** Preserve history and link the replacement.

Maintenance: update this document alongside the backlog after verified feature PR merges, `main` release promotions, official publication confirmations, production deployment confirmations, fixes, and release changes, through reviewed docs-only PRs targeting `dev` under the standing documentation approval. Preserve the source PR and dates. Never silently convert `dev` completion to a production release, or duplicate a roadmap as a backlog. Never auto-deploy or merge code.

Dates in the patch table are **GitHub dev PR merge timestamps in UTC (calendar day)**; dates in the release table are **GitHub main PR merge timestamps in UTC (calendar day)**. Neither is automatically the official announcement time or runtime deployment date. Production status was **not independently inspected** at initial creation.

## Awaiting production verification / release reconciliation

| Feature | Completed on dev (UTC) | Deployment evidence | Tracking |
| --- | --- | --- | --- |
| `/link list` optional composition surplus/deficit column | 2026-11-14 | **Pending production**: selective release [#2007](https://github.com/tonykslee/ClashCookies/pull/2007) closed **without merge**; full release [#1983](https://github.com/tonykslee/ClashCookies/pull/1983) still open, not authorized. Follow-up weight-fallback fix [#2011](https://github.com/tonykslee/ClashCookies/pull/2011) merged 2026-11-16. | [#1987](https://github.com/tonykslee/ClashCookies/pull/1987), [#2011](https://github.com/tonykslee/ClashCookies/pull/2011) |
| Automatic `all spun` announcement | 2026-11-16 | No independently verified production rollout or runtime activation. | [#2008](https://github.com/tonykslee/ClashCookies/pull/2008), backlog FB-005 |
| Immutable sync reaction transition evidence | 2026-11-16 | No independently verified production rollout/migration. Does **not** implement a leaderboard or verified search timestamps. | [#2010](https://github.com/tonykslee/ClashCookies/pull/2010), backlog FB-006/007 |
| Duskits wallet/ledger + private views/admin audit foundation | 2026-11-13 | Full release [#1983](https://github.com/tonykslee/ClashCookies/pull/1983) remains open/unmerged; do not activate issuance, migrate production, or infer deployment. | [#1975](https://github.com/tonykslee/ClashCookies/pull/1975), [#1977](https://github.com/tonykslee/ClashCookies/pull/1977), [#1980](https://github.com/tonykslee/ClashCookies/pull/1980), [Duskits roadmap](roadmaps/dusk-economy.md) |

This section lists **high-value known release questions**, not a complete production deployment manifest. The complete patch table below records other verified dev merges, with production dates deliberately blank.

## Historical feature and patch table

| dev merge date (UTC) | Feature / patch | Verified dev change | Source PR(s) | Production verified date |
| --- | --- | --- | --- | --- |
| 2026-08-14 | Base-swap progress | War-base acknowledgment progress display | [#1737](https://github.com/tonykslee/ClashCookies/pull/1737) | — |
| 2026-08-14 | CWL alliance activity report | DB-first alliance activity reporting | [#1741](https://github.com/tonykslee/ClashCookies/pull/1741) | — |
| 2026-08-15–16 | Sync retrospective foundation | Read-only model, alliance command, per-clan drilldowns, and automatic alliance-wide posting | [#1753](https://github.com/tonykslee/ClashCookies/pull/1753), [#1754](https://github.com/tonykslee/ClashCookies/pull/1754), [#1755](https://github.com/tonykslee/ClashCookies/pull/1755), [#1756](https://github.com/tonykslee/ClashCookies/pull/1756) | — |
| 2026-08-22 | `/link list` Home tenure | Initial Home tenure analytics | [#1790](https://github.com/tonykslee/ClashCookies/pull/1790) | — |
| 2026-11-13 | Duskits accounting foundation | Transaction-safe wallet/ledger foundation | [#1975](https://github.com/tonykslee/ClashCookies/pull/1975) | — |
| 2026-11-13 | Duskits private wallet | Private member wallet views (not automated earning) | [#1977](https://github.com/tonykslee/ClashCookies/pull/1977) | — |
| 2026-11-13 | Duskits admin audit | Administrative read-only wallet audit | [#1980](https://github.com/tonykslee/ClashCookies/pull/1980) | — |
| 2026-11-14 | `/link list` Compo | Optional ACTUAL surplus/deficit indicators | [#1987](https://github.com/tonykslee/ClashCookies/pull/1987) | — |
| 2026-11-14 | PostgreSQL backup implementation | Encrypted backup automation **code** merged; not timer activation | [#1984](https://github.com/tonykslee/ClashCookies/pull/1984) | — |
| 2026-11-15 | DBH signal compatibility | Read compatibility for v1/v2 player-signal state | [#1998](https://github.com/tonykslee/ClashCookies/pull/1998) | — |
| 2026-11-15 | DBH gated fingerprint writes | Feature-gated lazy v2 writes; merge does **not** enable the flag | [#1999](https://github.com/tonykslee/ClashCookies/pull/1999) | — |
| 2026-11-16 | `all spun` sync notification | Post-time aggregate completion announcement with durable delivery | [#2008](https://github.com/tonykslee/ClashCookies/pull/2008) | — |
| 2026-11-16 | Sync reaction history | Append-only bot-observed ADD/REMOVE transition history | [#2010](https://github.com/tonykslee/ClashCookies/pull/2010) | — |
| 2026-11-16 | `/link list` weight fallback | Preserve Weight when optional ACTUAL Compo is unavailable | [#2011](https://github.com/tonykslee/ClashCookies/pull/2011) | — |
| 2026-11-17 | Production VM adapter Phase 1 | Fail-closed deployment adapter **repository code**; not VM installation | [#2021](https://github.com/tonykslee/ClashCookies/pull/2021) | — |
| 2026-11-17 | Deployment lock coordination | Phase 2A lock coordination **repository code** | [#2024](https://github.com/tonykslee/ClashCookies/pull/2024) | — |
| 2026-11-17 | Runtime snapshot collector | Phase 2B read-only runtime snapshot **repository code** | [#2025](https://github.com/tonykslee/ClashCookies/pull/2025) | — |

## Official release milestones (verified main PR merges)

Release events are separate from completed development patches. These rows verify **repository promotion to `main`**, not GitHub Release publication, Discord release notes delivery, or healthy production deployment. A version is transcribed from the release PR title, not inferred from the branch. **Posted** means an actual release announcement was delivered; that has **not** been independently verified for the rows below.

| main merge date (UTC) | Official release / promotion | Scope (PR title summary) | GitHub evidence | Announcement posted | Production runtime verified |
| --- | --- | --- | --- | --- | --- |
| 2026-02-22 | v1.2.0 | Sync-time posting, permissions, compo | [#56](https://github.com/tonykslee/ClashCookies/pull/56) | Unknown | — |
| 2026-02-22 | v1.3.0 | `/cc`, sheet refresh, permissions | [#59](https://github.com/tonykslee/ClashCookies/pull/59) | Unknown | — |
| 2026-02-22 | v1.3.1 hardening | Sheet-refresh reliability | [#66](https://github.com/tonykslee/ClashCookies/pull/66) | Unknown | — |
| 2026-02-22 | v1.3.1 follow-up | Sheet-refresh and permissions UX | [#68](https://github.com/tonykslee/ClashCookies/pull/68) | Unknown | — |
| 2026-02-23 | v1.4.0 | Interactive help and activity accuracy | [#76](https://github.com/tonykslee/ClashCookies/pull/76) | Unknown | — |
| 2026-02-23 | v1.4.1 | Permission/reliability hotfixes | [#83](https://github.com/tonykslee/ClashCookies/pull/83) | Unknown | — |
| 2026-02-23 | v1.4.2 | Inactive accuracy/deploy workflow detection | [#86](https://github.com/tonykslee/ClashCookies/pull/86) | Unknown | — |
| 2026-02-23 | v1.4.2 follow-up | Inactive accuracy/deploy workflow stabilization | [#93](https://github.com/tonykslee/ClashCookies/pull/93) | Unknown | — |
| 2026-02-24 | v1.4.3 | Railway deployment auth/status | [#97](https://github.com/tonykslee/ClashCookies/pull/97) | Unknown | — |
| 2026-02-24 | v1.5.0 | Points reliability and telemetry | [#117](https://github.com/tonykslee/ClashCookies/pull/117) | Unknown | — |
| 2026-02-24 | v1.6.0 | Kick-list and opponent lookup | [#123](https://github.com/tonykslee/ClashCookies/pull/123) | Unknown | — |
| 2026-02-25 | v1.7.0 | Recruitment, sync status, visibility | [#132](https://github.com/tonykslee/ClashCookies/pull/132) | Unknown | — |
| 2026-02-26 | v1.8.0 | Recruitment templates, account linking | [#141](https://github.com/tonykslee/ClashCookies/pull/141) | Unknown | — |
| 2026-02-26 | Unversioned promotion | Dev-to-main release notes | [#165](https://github.com/tonykslee/ClashCookies/pull/165) | Unknown | — |
| 2026-02-27 | Unversioned promotion | FWA permissions, sync bootstrap, match persistence | [#170](https://github.com/tonykslee/ClashCookies/pull/170) | Unknown | — |
| 2026-03-09 | Unversioned promotion | Telemetry, points lock, FWA updates | [#448](https://github.com/tonykslee/ClashCookies/pull/448) | Unknown | — |
| 2026-03-31 | Unversioned promotion | Police templates, reminders, todo/account, war events | [#711](https://github.com/tonykslee/ClashCookies/pull/711) | Unknown | — |
| 2026-04-01 | Unversioned promotion | Observability, CWL reminders/todo, compliance | [#728](https://github.com/tonykslee/ClashCookies/pull/728) | Unknown | — |

This is a **verified sample, not an exhaustive main release history**. Further release PRs, actual GitHub Releases/tags, Discord announcements, and deployment observations should be reconciled before claiming a complete official-release catalog. Preserve repeated version labels (such as v1.3.1 and v1.4.2) as distinct merge events until tag/release semantics are verified. For announcements, separately capture `postedAt UTC`, channel, message ID/permalink, version/label and associated main merge SHA.

**Not released:** [#1983](https://github.com/tonykslee/ClashCookies/pull/1983) is an open dev-to-main release PR; [#2007](https://github.com/tonykslee/ClashCookies/pull/2007) is a closed **unmerged** selective release PR. Neither is an official released milestone.

## Release evidence log

| Verified at | Production SHA / image | Deployment action and operator evidence | Feature coverage |
| --- | --- | --- | --- |
| — | — | **No current production rollout was independently verified while seeding this table.** | Do not fill production dates from PR merge dates, draft release descriptions, or inference. |

## Cross-references and exclusions

- [General feature backlog](feature-backlog.md) owns open requests and stable FB IDs; FB-004 requests **per-clan alert-channel** retrospectives, which are not established by the existing alliance-wide retrospective implementation.
- [Duskits economy roadmap](roadmaps/dusk-economy.md) owns Duskits feature status, safeguards, and activation decisions; this table lists only selected merged foundations.
- [Production release and backup readiness roadmap](roadmaps/production-backup-readiness.md) governs release/backup gates, not this historical patch inventory.
- Other patches, security fixes, and earlier releases are **not yet exhaustively inventoried**. Expand from verified PRs without claiming completeness.
