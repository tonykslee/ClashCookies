# FB-002 P4d-2 — Provisional native reference publication

Status: implemented locally; no production publication or operational activation performed.

P4d-2 adds an additive, isolated native reference lifecycle. The existing
legacy-v1 `HeatMapRef` parent/child tables, blacklist mode, calculation gates,
and operational recommendation paths remain unchanged.

## Approved provisional policy

The owner-approved policy is versioned as `native-provisional-v1`:

- two direct RAW/DEFERRED weight anchors;
- five distinct qualifying clans per band;
- partial supported-band coverage is allowed;
- unsupported bands persist as `UNKNOWN` with a reason and a null count;
- `TH19` is a first-class native bucket;
- source authority remains `UNKNOWN_UNVERIFIED`;
- native comparisons are informational only; no placement, fill, replacement,
  or recommendation activation is authorized.

The sensitivity matrix retains the ten-clan scenario as a diagnostic comparison.
The local owner-provided fixed audit reports 93 independent clans, 72 qualifying
rosters, 21 member-count exclusions, zero unresolved qualifying rosters, and
verified coverage without ambiguity or truncation. The audit evidence is not a
production write or an authority attestation.

## Persistence and integrity

The migration `20261124030000_add_native_heatmap_reference_publication` creates
only native tables: immutable generation metadata, ordered bands and buckets,
explicit targets, source lineage, and content fingerprints; one mutable native
head per profile/policy with a monotonic fence token; and append-only
publication, rejection, and rollback events.

Publication uses a transaction-scoped PostgreSQL advisory lock, expected
head/fence comparison, unique request-key idempotency, immutable child inserts,
and a single head/event commit. Readers fail closed when the head, generation,
children, authority status, or target coverage is unavailable. Rollback moves
only the native head to a prior verified generation; it never rewrites legacy
rows. There is no unattended scheduler and no P4e activation table or code
path in this change.

## Operator commands

```text
npm run native-reference -- preview --candidate <candidate.json>
npm run native-reference -- publish --candidate <candidate.json> --request-key <key> --expected-generation-id <id|none> --expected-fence-token <n> --confirm
npm run native-reference -- verify
npm run native-reference -- rollback --expected-generation-id <id> --expected-fence-token <n> --confirm
```

`preview` is read-only. `publish` and `rollback` require explicit operator
confirmation. No command publishes Discord references, changes production
permissions, or activates operational recommendations.

## `/compo` behavior

`/compo heatmapref` appends the current native generation as a clearly labeled
informational section to both the PNG and complete Copy Table output. It includes
the native profile/policy version, sample threshold, TH19, sample counts, and
`UNKNOWN` for unsupported bands without substituting legacy or zero values. The
Copy Table button attaches the complete text file when the Discord 2,000-character
content limit would be exceeded; it never silently truncates rows.

`/compo state` retains its legacy delta columns and recommendation behavior. If
the native head is readable, it adds labeled per-clan ACTUAL/WAR comparisons as
additional columns in the rendered state table, including TH19 and all native
bucket deltas, using the immutable TH19-inclusive native profile-aware
calculation engine. The Discord content is a bounded summary, so large alliances
remain safe for both ACTUAL and WAR. Native data cannot change eligibility,
bucket classification, placement, fill, replacement, or advice output.

## Migration rehearsal and blockers

`prisma validate`, Prisma client generation, migration review, focused tests,
TypeScript, ESLint, and the build path pass locally. A disposable PostgreSQL
18.1 rehearsal ran on port 55433/database `clashcookies_native_rehearsal`:
the existing-schema baseline was created, native tables were removed, the
feature migration was applied, and first publication, snapshot read, exact
retry, two-client stale-head rejection, rollback to validated history, and
first-publication deactivation all completed. No production or staging
connection was used. Docker smoke could not run because Docker is not installed
on this workstation. The owner-provided corrected artifacts remain the
production read-only evidence; no production rerun was needed or attempted.

The review findings are addressed as follows: the CLI is strict, BigInt-safe,
disconnecting, and nonzero on rejection; publication rejects synthetic or
mutable previews and revalidates retained evidence; canonical profile, policy,
band, bucket, threshold, and authority metadata are enforced from checked-in
constants; persisted rows come from regenerated validated content; exact retries
use the original successful request generation/fence parameters without requiring
the new fence, while superseded retries, stale writers, and request-key conflicts
are recorded as rejection events; rollback follows the immutable publication
chain; cross-profile heads and observation lineage are relationally constrained;
and native state/display surfaces are informational, profile-owned, TH19-inclusive,
and UNKNOWN-safe. Remaining blockers are independent authoritative source
attestation, exact upstream-war binding, production migration approval, and
owner approval before any future operational recommendation activation policy
change.

### Repeatable disposable PostgreSQL rehearsal

The rehearsal is intentionally operator-run and must use a disposable local
database, never a production or staging URL. With PostgreSQL available, set a
dedicated `DATABASE_URL`, apply the repository migrations with
`npx prisma migrate deploy`, and run this bounded sequence against that database:
`npm run native-reference -- verify`, preview a fixed candidate, publish with
`--expected-generation-id none --expected-fence-token 0 --confirm`, repeat the
same publish command with the original parameters, publish a second request from
the observed head, retry the first request, then run `verify` and
`rollback --confirm` with the observed generation/fence. Assert one generation
on the exact retry, a stale rejection after the head advances, no `PUBLISHED`
event for rejected requests, intact immutable lineage, and a monotonic fence
after rollback. Drop the disposable database afterward. The 2026-11-23 run used
PostgreSQL 18.1 on port 55433 and completed this sequence; no production or
staging connection was used.
