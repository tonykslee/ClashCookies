# FB-002 P4d-1d Native Cohort Qualification Audit

Status: implemented as a read-only diagnostic; owner policy is not approved.

P4d-1d adds an aggregate audit over the immutable
`FwaWarMembersObservation`, member, and quality-evidence records retained by
P4d-1c. It does not publish a native reference, activate TH19, change
legacy-v1, fetch WarMembers, write the database, or add a migration.

Run it explicitly with a bounded as-of policy:

```text
npm run diagnose:heatmap-ref-native -- --evaluation-at 2026-11-21T00:00:00.000Z --era-start 2026-11-19T00:00:00.000Z --era-end 2026-11-22T00:00:00.000Z --cohort-audit
```

The default CLI mode and the existing `--fixture`, `--db`, and
`--retained-observations` artifact contracts are unchanged. The audit's
schema is `native-cohort-qualification-audit-v1` and its proposed policy
version is `proposed-cohort-policy-v1`. Its content fingerprint covers the
aggregate report, band summaries, sensitivity scenarios, policy labels, the
validated P4d-1c candidate content fingerprint, and source evidence
fingerprint. Different retained quality-evidence lineage therefore cannot
reuse the same audit fingerprint when roster data and counts match.

## Implemented diagnostic contract

The audit reuses P4d-1c's as-of observation selection, quality-revision
lineage, member validation, scoped deferment lookup, and the shared
`RAW > DEFERRED > ESTIMATED > UNRESOLVED` resolver. Repeated semantic polls
and quality revisions are retained as lineage, not counted as independent
clans. Only evidence ingested by the evaluation cutoff contributes to the
as-of report. Future-ingested revisions are excluded from the as-of lineage
and fingerprint but remain retained evidence for a later evaluation. A
malformed observation available by that cutoff prevents misleading fallback
to an older observation for the same clan.

The aggregate report includes:

- observed semantic samples, selected independent clans, superseded samples,
  quality revisions, selection-stage exclusions, fully resolved rosters,
  inference-dependent rosters, and unresolved rosters;
- bounded read-row count (including the sentinel row when the read is
  limited), a separate `readLimited` flag, eligible semantic-lineage count,
  and malformed available-observation count;
- selection exclusion reason counts, including quality and structural
  failures that occur before the native calculator;
- global `VERIFIED`, `TRUNCATED`, or `AMBIGUOUS` coverage and explicit
  ambiguity status;
- per-band qualifying distinct-clan count, excluded count and reason
  breakdown, resolved-weight provenance counts, calculation-outcome
  distribution, and retained `QUALITY_ELIGIBLE` evidence distribution only
  where band attribution is established. Unattributable quality exclusions
  remain explicit globally rather than being assigned to a band; and
- a deterministic sensitivity matrix using direct-anchor thresholds 1, 2,
  and 3 crossed with distinct-clan thresholds 1, 5, 10, and 15. The report
  records the effective ordinary sample threshold separately from the
  proposed default. Alternative anchor thresholds use a diagnostic evaluator
  only and never produce ordinary candidate artifacts.

Rejected rosters receive an independent band only when their 50-position
structure and all effective weights establish that band without relying on
the rejected evidence. Otherwise the exclusion is `UNATTRIBUTABLE`; the
audit never invents a band for an unresolved or malformed total.

When global observation coverage is truncated or ambiguous, every sensitivity
scenario remains `UNKNOWN`. Sensitivity results are diagnostic comparisons,
not policy activation or publication approval. The current engineering
proposal remains two RAW/DEFERRED direct anchors for inference-dependent
rosters and ten distinct qualifying clans per band; the audit labels these
thresholds `PROPOSED_NOT_OWNER_APPROVED`.

## Proposed qualification policy for owner review

The smallest policy that can be reviewed is versioned and explicit:

1. Evaluate a named era and cutoff using `WarMembers.json?warNo=1` only.
2. Select one immutable first-retained semantic roster per normalized clan;
   do not treat repeated polls, revisions, or fetch time as independent
   samples or proof of leader-submission age.
3. Require the expected 50 distinct positions and preserve zero weights as
   missing-weight evidence. Negative and fractional weights remain invalid.
4. Resolve weights with the existing RAW, scoped DEFERRED, ESTIMATED,
   UNRESOLVED precedence. Missing direct weight alone does not invalidate a
   clan; insufficient anchors and unresolved totals remain visible and
   diagnostic.
5. Attribute a rejected roster to a band only when the band is independently
   established. Otherwise retain it in unattributed exclusion statistics.
6. Treat source authority, exact historical-war identity, source generation,
   freshness, and replay proof as `UNKNOWN_UNVERIFIED` until separately
   established. A supported diagnostic band is not a publishable reference.
7. Require owner approval of the policy version and representative real
   evidence before any P4d-2 persistence or publication decision.

These are proposed modeling rules, not active native-calculator defaults or
production gates. The current legacy-v1 profile remains authoritative.

The parent P4d-1c observation identifies one distinct semantic roster. Its
quality fields are first-seen historical facts, not automatically the latest
eligibility decision. Future candidate evaluation must consider retained
immutable quality revisions: later clean evidence does not erase earlier
contradictions, and an earlier contradiction does not permanently disqualify
a roster when later valid evidence exists. Repeated unchanged polls are not
independent composition samples and cannot prove latest live-roster recency
after intervening changes. Source authority remains `UNKNOWN_UNVERIFIED`.

## Evidence and blockers

The repository tests exercise synthetic retained rows and deterministic mocks.
They prove selection, lineage, exclusions, mixed provenance, sensitivity,
cutoff behavior, ambiguity/truncation handling, determinism, and no-write
behavior. They do not establish real-world cohort coverage, leader-submission
age, exact upstream-war identity, FWA classification, source authenticity,
source generation, or publication authority. No production or staging
database is accessed by this diagnostic.

Older P4d-0/P4d-1a documents required historical exact-war identity,
historical-war reconstruction, and stricter direct-source authority as hard
prerequisites. The owner's current contract instead treats
`WarMembers.json?warNo=1` as a current selected 50-position,
leader-submitted-weight modeling source. The older requirements remain
historical context and are not silently deleted; this audit keeps exact-war
identity and source authority explicitly UNKNOWN rather than using those
older assumptions as an arbitrary sample-retention gate.

Before P4d-2, the owner still needs to decide the qualification policy and
obtain representative real observations. P4d-2 must separately define
versioned native persistence/publication, atomicity, conflict handling,
rollback/forward recovery, and release validation. The known historical
Prisma migration-chain limitation involving
`20260305010000_currentwar_clantag_pk` and the absent `CurrentWar_pkey` remains
unchanged.
