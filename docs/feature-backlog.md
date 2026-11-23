# ClashCookies — Feature Backlog (migrated)

**As of 2026-11-21, [GitHub Issues](https://github.com/tonykslee/ClashCookies/issues?q=is%3Aissue+label%3Abacklog) are the authoritative feature backlog.** Do not maintain a second live backlog here.

The running feature backlog is [GitHub Issues](https://github.com/tonykslee/ClashCookies/issues?q=is%3Aissue+label%3Abacklog). ChatGPT has standing owner authorization to create, update, label, reprioritize and close backlog issues directly when requested or when verified progress warrants reconciliation; no branch, commit, PR or separate approval is required for issue metadata. Search existing issues first, preserve legacy FB identifiers, requirements and history, link related PRs, and distinguish proposed, in progress, merged-to-dev, and production-verified status. Keep implementation and deployment approval gates unchanged. `docs/feature-backlog.md` is a migration pointer, not a second backlog; feature history and durable architecture/roadmaps remain in versioned docs.

Use `backlog`, type/domain, priority and evidence-based status labels. Issues with implementation merged to dev but production unverified remain open with `merged-to-dev` and `pending-production`; close when the specified acceptance and release/verification requirements are satisfied, or explicitly withdrawn. Do not infer production deployment from a merge. Priorities are suggestions, not delivery commitments.

## Legacy ID migration index (static)

| Legacy ID | Issue |
| --- | --- |
| FB-001 | [#2112](https://github.com/tonykslee/ClashCookies/issues/2112) |
| FB-002 | [#2113](https://github.com/tonykslee/ClashCookies/issues/2113) |
| FB-003 | [#2114](https://github.com/tonykslee/ClashCookies/issues/2114) |
| FB-004 | [#2115](https://github.com/tonykslee/ClashCookies/issues/2115) |
| FB-005 | [#2116](https://github.com/tonykslee/ClashCookies/issues/2116) |
| FB-006 | [#2117](https://github.com/tonykslee/ClashCookies/issues/2117) |
| FB-007 | [#2118](https://github.com/tonykslee/ClashCookies/issues/2118) |
| FB-008 | [#2119](https://github.com/tonykslee/ClashCookies/issues/2119) |
| FB-009 | [#2120](https://github.com/tonykslee/ClashCookies/issues/2120) |
| FB-010 | [#2121](https://github.com/tonykslee/ClashCookies/issues/2121) |
| FB-011 | [#2122](https://github.com/tonykslee/ClashCookies/issues/2122) |
| FB-012 | [#2123](https://github.com/tonykslee/ClashCookies/issues/2123) |
| FB-013 | [#2124](https://github.com/tonykslee/ClashCookies/issues/2124) |
| FB-014 | [#2125](https://github.com/tonykslee/ClashCookies/issues/2125) |
| FB-015 | [#2126](https://github.com/tonykslee/ClashCookies/issues/2126) |
| FB-016 | [#2127](https://github.com/tonykslee/ClashCookies/issues/2127) |
| FB-017 | [#2128](https://github.com/tonykslee/ClashCookies/issues/2128) |
| FB-018 | [#2129](https://github.com/tonykslee/ClashCookies/issues/2129) |
| FB-019 | [#2130](https://github.com/tonykslee/ClashCookies/issues/2130) |

Original full specifications are preserved in [the pre-migration backlog](https://github.com/tonykslee/ClashCookies/blob/766d509a49e5952f0b2336f57fd188ce3b4ae381/docs/feature-backlog.md) and [FB-019's intake PR](https://github.com/tonykslee/ClashCookies/pull/2111), and copied into their corresponding issues. The table is a historical crosswalk, not a live status tracker. Future requests use native issue numbers.

## Historical release reconciliation snapshot

The following is preserved from the pre-migration document for historical traceability only, not current release status. Consult [feature history](feature-history.md), linked issues and actual release evidence for subsequent updates.

These are **not proposed implementation tasks**. Production deployment, migration, and activation must be verified separately before changing their status.

| Feature | Dev implementation | Production status | Historical record |
| --- | --- | --- | --- |
| `/link list` optional Compo surplus/deficit (`↑N`, `↓N`, `=`, `—`) | [#1987](https://github.com/tonykslee/ClashCookies/pull/1987) merged 2026-11-14 UTC; fallback fix [#2011](https://github.com/tonykslee/ClashCookies/pull/2011) merged 2026-11-16 UTC | **Pending production confirmation**. Selective release [#2007](https://github.com/tonykslee/ClashCookies/pull/2007) closed unmerged; full release [#1983](https://github.com/tonykslee/ClashCookies/pull/1983) open/unmerged. | [Feature history](feature-history.md) |
| FB-012 — TH19 and Legend autorole safeguards | [#2089](https://github.com/tonykslee/ClashCookies/pull/2089) merged 2026-11-20 UTC at `ab6316a` | **Pending production verification**; historic removed roles not restored; cause of historic mass removal not established | [Feature history](feature-history.md) |
| FB-005 — automatic `all spun` | [#2008](https://github.com/tonykslee/ClashCookies/pull/2008) merged 2026-11-16 UTC | Production delivery/activation not verified | [Feature history](feature-history.md) |
| Immutable sync reaction history foundation (supporting FB-006/007) | [#2010](https://github.com/tonykslee/ClashCookies/pull/2010) merged 2026-11-16 UTC | Production deployment/migration not verified; leaderboard/analytics remain proposed | [Feature history](feature-history.md) |

For other dev-completed features and patches, see [Feature Patch History and Release Tracking](feature-history.md); it is a curated historical seed, not a full deploy manifest.

