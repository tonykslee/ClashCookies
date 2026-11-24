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
npm run native-reference -- publish --candidate <candidate.json> --request-key <key> --expected-fence-token <n> [--expected-generation-id <id>] --confirm
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
the native head is readable, it adds a labeled informational comparison using
the immutable `legacy-v1` profile-aware calculation engine. Native data cannot
change eligibility, bucket classification, placement, fill, replacement, or
advice output.

## Migration rehearsal and blockers

`prisma validate`, Prisma client generation, migration static review, and the
deterministic application tests pass locally. A real PostgreSQL migration,
advisory-lock contention test, and production read-only rerun require the
restricted database connection and are intentionally not run by Codex here.
The owner-provided artifacts are the accepted read-only audit evidence for this
implementation. Remaining blockers are independent authoritative source
attestation, exact upstream-war binding, and owner approval before any future
operational activation policy change.
