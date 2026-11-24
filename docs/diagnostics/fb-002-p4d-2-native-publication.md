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
informational section to both the PNG and Copy Table output. It includes the
native profile/policy version, sample threshold, TH19, sample counts, and
`UNKNOWN` for unsupported bands without substituting legacy or zero values.

`/compo state` retains its legacy delta columns and recommendation behavior. If
the native head is readable, it adds labeled individual ACTUAL/WAR comparisons
using the immutable TH19-inclusive native profile-aware calculation engine.
Native data cannot
change eligibility, bucket classification, placement, fill, replacement, or
advice output.

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
mutable previews and revalidates retained evidence; canonical content hashing
is shared by preview and persisted reads; head/fence/cutoff checks and exact
retry semantics are fenced; rollback follows the immutable publication chain;
cross-profile heads and observation lineage are relationally constrained; and
native state/display surfaces are informational, profile-owned, TH19-inclusive,
and UNKNOWN-safe. Remaining blockers are independent authoritative source
attestation, exact upstream-war binding, production migration approval, and
owner approval before any future operational activation policy change.
