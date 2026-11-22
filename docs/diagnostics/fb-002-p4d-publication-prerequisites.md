# FB-002 P4d-0 — Native reference publication prerequisites

Status: proposed documentation-only contract. No native evidence owner, native
reference table, publication pointer, activation state, migration, or runtime
writer is implemented by this document.

Decision: **NO-GO for P4d implementation and native publication.** The existing
P4c evaluator is a useful diagnostic boundary, but no current upstream or
persisted owner independently proves all authority dimensions required for a
native reference. P4d-1 must establish that evidence owner first. P4d-2 may
publish only an independently verified native generation. P4e activation remains
a separate owner-approved milestone.

## 1. Scope and verified baseline

This investigation was performed on the existing owner-created branch
`feature/native-publication-prerequisites`. Its initial and current `HEAD`
are both `77d111ebe75c25dad304a84e4fc055ed622bbffe`, exactly `origin/dev` at
the start of the work. No second branch was created.

The current `dev` project instructions and canonical workflow were retrieved
from that `dev` revision, together with the issue and the relevant repository
implementation, schema, migrations, and focused tests:

- [FB-002 issue #2113](https://github.com/tonykslee/ClashCookies/issues/2113)
  records P0–P4b merged to `dev`, not production-verified, P4c pending as
  diagnostic source evidence, and P4d/P4e/P5 still separate.
- [P4c source-evidence boundary](fb-002-p4c-native-source-evidence.md) is the
  current diagnostic contract.
- [project brain](../project-brain.md), [architecture contract](../architecture-contract.md),
  [core priorities](../core-priorities.md), [observability](../observability.md),
  and the [canonical AI workflow](../ai-development-workflow.md) define the
  ownership, UNKNOWN, active/mirror, migration, and review constraints.

The verified current architecture is:

```text
FWAStats JSON
  -> FwaStatsClient / shared WarMembers parser
  -> FwaWarMembersSyncService
  -> FwaWarMemberCurrent + FwaPlayerCatalog + FwaFeedSyncState
  -> FwaTrackedClanWarRosterSyncService
  -> FwaTrackedClanWarRosterCurrent + ...MemberCurrent

CurrentWar / War history are separate owners.

FwaTrackedClanWarRosterCurrent (read-only)
  -> NativeHeatMapRefCandidateService
  -> diagnostic candidate artifact only

HeatMapRef + HeatMapRefBucketTarget
  <- HeatMapRefService / HeatMapRefRebuildService / seed and mirror writers
  -> legacy-v1 reader and normalized-parity resolver
```

`FwaWarMembersSyncService` replaces the latest `FwaWarMemberCurrent` rows in a
transaction and then asks `FwaTrackedClanWarRosterSyncService` to replace the
latest derived roster/member snapshot. Neither table is immutable history. The
derived roster may stamp fields copied from the freshest separately stored
`CurrentWar` row, but the schema has no foreign key or source-batch relation
between those rows and the WarMembers payload.

`NativeHeatMapRefCandidateService` reads only the derived tracked-roster
snapshot. Its persisted source category is explicitly
`persisted_fwa_snapshot`, its trust is
`persisted_unverified_source_binding`, and its source-authority dimensions are
`UNAVAILABLE`. Its SHA-256 content fingerprint is an integrity/consistency
check, not authentication, freshness, exact-war identity, or publication
provenance.

`HeatMapRef` remains the physically global legacy-v1 parent. Its nine
historical columns and `HeatMapRefBucketTarget` child remain the active legacy
owner and must not be modified, replaced, or reinterpreted by P4d. The existing
global `BotSetting` integrity record and advisory lock protect that legacy path
only. `MirrorSyncService` mirrors the legacy reference tables as an allowlisted
full-overwrite snapshot, but does not mirror the FWA current-state evidence
tables or `BotSetting` provenance. Native tables must not be added to that
allowlist implicitly.

## 2. Proven facts versus unavailable authority

The following table is the publication gate. `VERIFIED` means the current code
can establish the fact from the named source. `UNAVAILABLE` means the source
does not contain independent proof. `CONFLICTING` means the observation
contains contradictory or malformed facts and cannot qualify.

| Required authority dimension | Current source and proven result | P4d publication consequence |
| --- | --- | --- |
| Raw payload shape and parser outcome | `FwaStatsClient.fetchWarMembersEvidence` evaluates every raw row through the shared parser. Raw, parser-accepted, parser-rejected, evidence-eligible, and evidence-ineligible counts/indexes are retained in the diagnostic artifact. | Useful diagnostic input; necessary but not sufficient. |
| Exact roster position/identity structure | `FwaWarMembersSourceEvidence` can verify distinct identities, distinct positions, and declared `1..N` coverage only when the source itself declares `N`. A parser-rejected row or mismatch is `CONFLICTING`. | `VERIFIED` only for that observation and only with source-declared completeness; never infer from row count. |
| Source-declared roster completeness | Live `WarMembers.json?warNo=1` supplies no documented authoritative roster size. P4c therefore reports missing declaration as `UNAVAILABLE`. | Block native qualification. |
| Direct, non-imputed member weights | Positive integer raw weights and a declared total are checked when declared. Rejected rows, invalid weights, duplicates, or total mismatch make the dimension `CONFLICTING`; zero-block filling in the derived roster is explicitly imputed. | Native qualification requires all member weights `DIRECT/RAW`; current derived rows cannot provide this authority. |
| Exact upstream war identity | `sourceWarNo=1` is only a request selector. `FwaClanWarLogCurrent` has end time/opponent/team size but no upstream war ID, and `CurrentWar` is a separate guild-scoped owner. | `UNAVAILABLE`; no member rows may be bound to a native war. |
| FWA match classification | Opponent tags, names, `matched`, timestamps, current `matchType`, and historical classifications are observations owned by different flows. None is an independently attested classification for the same WarMembers payload and exact war. | `UNAVAILABLE`; matching tags/timestamps and `CurrentWar` association are not proof. |
| Source authenticity | HTTPS endpoint and request telemetry prove how the application observed data, not that the payload was signed or issued by an authenticated source authority. Hashes only detect changed content. | `UNAVAILABLE` until an upstream attestation/key or equivalent independently verifiable contract exists. |
| Stable source generation/freshness | `observedAt`, `ingestedAt`, `sourceSyncedAt`, `sourceCurrentWarUpdatedAt`, feed `lastSuccessAt`, and a content hash are local/current-state metadata. No durable upstream generation or monotonic source revision survives restarts and competing fetches. | `UNAVAILABLE`; no replay protection or freshness ordering. |
| Duplicate/replayed observations | Current rows are upserts keyed by clan/player and stale rows are deleted. `FwaFeedSyncState.lastContentHash` is one latest hash, not immutable history. | `UNAVAILABLE`; repeated or out-of-order observations cannot be classified safely. |
| Conflict retention | Current sync replaces rows and does not retain both conflicting payloads. P4c reports conflict diagnostics but does not persist them. | `UNAVAILABLE`; a native source owner is required before publication. |
| Candidate support threshold | The default threshold of ten distinct qualifying clans is a diagnostic engineering policy in `nativeHeatMapRefCandidate`; it is not a production confidence or authority policy. | Must be approved/versioned in the native publication policy. |
| Native target state | Diagnostic artifacts already distinguish `SUPPORTED` and `UNKNOWN` target results, but persisted native targets do not exist. | P4d must preserve this distinction per band and bucket. |

Matching tags, timestamps, `warNo=1`, a selected `CurrentWar`, a 50-row
snapshot, a current row hash, or a successful HTTP fetch cannot substitute for
the unavailable facts. A hash can prove that two readers saw the same bytes; it
cannot prove who issued them, which war they describe, or that they are newer
than an observation already in flight.

## 3. Source feasibility findings

### 3.1 FWAStats observations

`FwaStatsClient` fetches `Clans.json`, `Members.json`,
`WarMembers.json?warNo=1`, and `Wars.json` using bounded retries and request
telemetry. The WarMembers parser accepts a row with a tag/name even when its
position or weight is not eligible for native evidence. P4c correctly keeps
those categories separate.

The live contract currently lacks:

1. a documented exact upstream war identifier attached to the WarMembers
   payload;
2. an authoritative source-declared roster size and total weight;
3. a source-signed or otherwise independently verifiable FWA classification;
4. a durable source generation/revision comparable across fetches, processes,
   and restarts; and
5. an authoritative freshness/expiry rule and replay identifier.

`Wars.json` rows are useful historical observations, but their persisted unique
key is `(clanTag, endTime, opponentTag, teamSize)` and they do not bind the
members of one WarMembers response to one exact upstream war. `matched` is a
source field, not an attestation. `FwaClanMatchStatsCurrent` is a derived
summary and is not an evidence owner.

### 3.2 CurrentWar and tracked-roster state

`FwaTrackedClanWarRosterSyncService` selects one freshest `CurrentWar` row by
`updatedAt`, then start time, then guild ID. That deterministic choice is
useful for rendering but is not a source identity proof. The member rows were
fetched and persisted through a separate path. A later `CurrentWar` row can
therefore be newer, older, or for a different guild-scoped observation than the
member payload.

The service also applies zero-block rules and writes `RAW`,
`FILLED_FROM_LOWER_BLOCK`, or `UNRESOLVED_TRAILING_ZERO` effective weights.
The filled values are valid factual composition fallbacks for existing
consumers, but they are not direct source-declared war weights and cannot
qualify native reference evidence.

### 3.3 Existing tests and concurrency evidence

Focused tests cover parser/evidence fail-closed behavior, candidate artifact
validation, legacy parity, child publication failure rollback, generation-token
stale-writer rejection, and mirror safety. `HeatMapRefRebuildService` tests
exercise two mocked transaction phases and mocked advisory-lock calls; they
also verify that an older evaluation cannot overwrite newer pending/blocked
state.

Those tests are valuable contract tests, but they do **not** prove real
PostgreSQL contention, lock wait ordering, transaction isolation, unique-index
behavior under two processes, or crash recovery against a real database. The
P4d gate must retain live PostgreSQL contention and migration validation as
unverified until run against a representative existing-schema database. No
production, staging, or external upstream operation is authorized by this
document.

## 4. Minimum proposed immutable observation owner

This is a proposed ownership model, not an implemented schema. The owner must
be separate from `FwaWarMemberCurrent` and
`FwaTrackedClanWarRosterCurrent`; those tables remain latest-only factual
read models.

### 4.1 Envelope and keys

Propose an additive immutable `FwaNativeSourceObservation` envelope with:

- `observationId UUID` as the immutable primary key;
- `sourceSystem`, `sourceEndpoint`, normalized `clanTag`, and a versioned
  `sourceContractVersion`;
- `exactUpstreamWarId` and `sourceGenerationId`, nullable only for
  quarantined non-authoritative observations;
- `sourceGenerationSequence` when the provider supplies a monotonic sequence;
- `sourceObservedAt`, `receivedAt`, and `ingestedAt` with explicit clock
  semantics;
- raw payload bytes or a content-addressed immutable payload reference,
  `rawPayloadSha256`, canonical evidence hash, declared roster size, declared
  total weight, and source-declared opponent/classification fields;
- independent authority fields: attestation/key ID, signature or equivalent
  proof, verification result, and verifier contract version;
- immutable statuses for identity, match classification, completeness, direct
  weight provenance, authenticity, freshness, generation, replay, and overall
  eligibility; and
- immutable reason codes plus a local request/correlation ID for diagnostics.

The authoritative natural key is:

```text
(sourceSystem, clanTag, exactUpstreamWarId, sourceGenerationId)
```

when both upstream identifiers are present. A unique content key on that
envelope additionally makes an exact retry idempotent:

```text
(sourceSystem, clanTag, exactUpstreamWarId, sourceGenerationId,
 rawPayloadSha256)
```

An observation missing either upstream identifier is still retained as
`UNKNOWN`/quarantined under an ingestion UUID and a local deduplication key,
but it can never become authoritative merely because a later row has the same
hash or timestamps. If the same natural key arrives with different content,
the original observation is immutable and a
`FwaNativeSourceObservationConflict` row retains the competing observation,
hash, received time, reason, and writer identity. It is never silently
overwritten or collapsed to the latest row.

### 4.2 Source-to-member relationship

Propose an immutable `FwaNativeSourceObservationMember` child keyed by
`(observationId, playerTag)` with a unique
`(observationId, position)` when position is present. Every member row must
reference exactly one envelope by foreign key; no member row may be shared
between observations. Store the raw member fingerprint and normalized
tag/name/position/town hall, direct raw weight, opponent fields, and
`weightProvenance` (`DIRECT`, `IMPUTED`, or `UNKNOWN`).

The envelope owns completeness and classification; the child owns the
member-level projection and direct-weight provenance. A member with an
imputed/effective-only value remains stored for diagnostics but makes the
observation ineligible. The envelope's declared count/total and the child
rows' exact distinct identities, exact positions, and direct weights must be
validated in one transaction before an eligible observation can be referenced
by a candidate.

### 4.3 Proposed observation state transitions

Facts and raw payloads are immutable. A small lifecycle/state projection may
advance monotonically, or equivalent append-only status events may be used:

```text
RECEIVED
  -> EVALUATED
      -> ELIGIBLE_VERIFIED
      -> UNKNOWN (required authority missing or freshness cannot be proven)
      -> CONFLICTING (contradictory, duplicate, malformed, or replayed facts)
```

`ELIGIBLE_VERIFIED` requires exact war identity, source-declared FWA
classification, complete roster membership, direct weights, authenticity,
valid generation/freshness, and replay checks. `UNKNOWN` and
`CONFLICTING` are terminal for publication; a later fetch creates a new
observation rather than mutating one. `SUPERSEDED` may be a reader
classification for a valid older observation, but must not delete or rewrite
its evidence.

An append-only contradiction against a previously eligible natural key
(`sourceSystem`, `clanTag`, `exactUpstreamWarId`,
`sourceGenerationId`) changes the authority result for that key to
`CONFLICTING`. The original eligible observation and every generation that
used it remain immutable, but the conflict index is itself authoritative for
future eligibility: no new generation may cite the conflicted key, and any
existing native head or generation whose lineage cites it is unavailable for
target reads and rollback selection until an explicit, independently verified
conflict-resolution policy exists. Historical `ELIGIBLE_VERIFIED` status
cannot override a newly retained contradiction.

## 5. Isolated native reference generation model

The following model is proposed for P4d. It intentionally does not reuse the
legacy `HeatMapRef`, `HeatMapRefBucketTarget`, `BotSetting` integrity key,
or legacy scheduler checkpoint as a native owner.

### 5.1 Native tables and ownership

| Proposed owner | Responsibility | Immutable fields / constraints |
| --- | --- | --- |
| `NativeHeatMapReferenceGeneration` | One complete candidate/publication generation for one native profile | UUID `generationId`, monotonic per-profile `publicationSequence`, profile ID/version, policy ID/version, ordered-definition fingerprint, source-lineage fingerprint, content hash, authority result, created/verified times, and request/idempotency key. Content fields never change. |
| `NativeHeatMapReferenceGenerationBand` | Ordered numeric weight bands | `(generationId, ordinal)` primary key; unique band boundaries within generation; no overlap; immutable min/max/order. |
| `NativeHeatMapReferenceGenerationBucket` | Ordered native bucket definitions | `(generationId, ordinal)` primary key; unique bucket ID; immutable source-bucket mapping/order. |
| `NativeHeatMapReferenceTarget` | One target result per band/bucket | `(generationId, bandOrdinal, bucketId)` primary key; `SUPPORTED` requires a nonnegative integer count; `UNKNOWN` requires a null count and reason code. No implicit zero for missing/unsupported evidence. |
| `NativeHeatMapReferenceLineage` | Exact source observations used by a generation | `(generationId, observationId)` primary key, source content hash, role, and immutable ordering/input digest. Only `ELIGIBLE_VERIFIED` observations may support `SUPPORTED` targets. |
| `NativeHeatMapReferenceHead` | Current published pointer per profile/policy | One row per native profile/policy, current generation ID, monotonic fence token, head version, and last publication event. This is a mutable pointer, not evidence. |
| `NativeHeatMapReferencePublicationEvent` | Append-only publication, rejection, and rollback audit | Event ID, generation, previous/new head, fence token, actor/request, reason, content hash, and committed time. |
| `NativeHeatMapReferenceActivation` (P4e owner) | Separately approved runtime selection | Not created or changed by P4d-2. Its absence means native publication is not active. |

The tables may be consolidated physically if the same constraints and
ownership are preserved, but a JSON-only generation blob is insufficient for
FK lineage, exact target state constraints, ordered definitions, conflict
inspection, and consistent readers.

### 5.2 Integrity and authority contract

The generation content hash covers, in canonical order:

1. profile ID/version and calculation-policy ID/version;
2. ordered band and bucket definitions, including boundaries and source-bucket
   mappings;
3. source observation IDs, exact content hashes, source-generation IDs, and
   lineage roles;
4. every target's band order, bucket order, status, count, observed totals,
   normalization result, and reason code; and
5. the versioned authority/evaluation policy and evaluation time.

The source-lineage hash and generation content hash are consistency checks.
They are not independent authority. `authorityStatus=VERIFIED` requires the
source observation owner to have independently verified the provider's exact
identity, FWA classification, completeness, direct weights, authenticity,
generation, and replay rules. Any missing or conflicting dimension produces an
UNKNOWN generation/target result, regardless of hashes or sample size.

Conflict status is evaluated against the complete append-only observation
history, not only the generation's original snapshot. A later
`FwaNativeSourceObservationConflict` for any lineage natural key invalidates
that key's eligibility. A generation that cites the key remains historically
verifiable as an immutable artifact, but its native head is cleared or marked
unavailable and its targets/rollback eligibility fail closed. A historical
generation hash or `VERIFIED` state is never sufficient to override the
newer conflict.

Publication may retain an auditable generation containing `UNKNOWN` targets,
but a target consumer may use only a `SUPPORTED` target from a verified
generation. A generation with no supported targets is diagnostic/unavailable,
not a usable reference.

### 5.3 Atomic publication protocol

The proposed P4d-2 writer must:

1. Read a stable source snapshot of only immutable eligible observations and
   their members. Build a deterministic candidate, lineage, definition, target,
   and content hash outside the write transaction.
2. Begin a PostgreSQL transaction and acquire a transaction-scoped advisory
   lock keyed by the native profile/policy. Do not reuse the legacy
   `heatmapref_reference_integrity` lock key.
3. Lock the native head row (`FOR UPDATE`) and compare the caller's expected
   head generation and fence token. If either is stale, reject the writer and
   retain a rejected publication event; do not alter the head.
4. Re-read the complete conflict index and source-generation head rows inside
   this same transaction. If any lineage natural key is now conflicted,
   reject the candidate as stale/conflicting; do not insert or publish a
   generation from it. This is publication-time conflict revalidation, not a
   claim that the earlier source snapshot remains current.
5. Insert the immutable generation, bands, buckets, targets, and lineage under
   unique constraints. A deterministic request key/content hash makes an exact
   retry a no-op; a reused request key with different content is a conflict.
6. Recompute/verify all hashes and constraints in the transaction. Require
   complete target coverage; `UNKNOWN` must be explicit, never a fabricated
   zero.
7. Advance the generation to `VERIFIED`, update the native head with a new
   fence token, and append the publication event in the same transaction.
8. Commit once. A reader must never observe a head pointing to a partially
   inserted generation. If a source conflict is committed concurrently, the
   source-conflict writer and publication writer must use the same per-source
   fencing/lock order, or publication must retry from a fresh transaction and
   fail closed when the conflict wins.

For a writer that starts from an older snapshot, a newer writer may publish
first. The older writer's final transaction must fail the expected-head/fence
comparison even if its content is otherwise valid. It may remain in immutable
history as `REJECTED_STALE`, but it must not become the current head.

### 5.4 Consistent reader snapshots

Native readers must use one bounded database transaction at `REPEATABLE READ`
(or an equivalent single-snapshot read) as the baseline and:

1. read the native head token;
2. read the pointed generation, all ordered definitions, all targets, and all
   lineage rows;
3. read the conflict index for every lineage natural key visible in that
   snapshot; and
4. verify generation state, foreign-key coverage, authority status, absence of
   a source conflict, and the canonical content hash.

This baseline is snapshot-consistent: all of the head, generation, children,
lineage, and conflict reads describe one PostgreSQL snapshot. A
`REPEATABLE READ` transaction cannot observe a head update committed after
its snapshot was established, so re-reading the head inside that same
transaction cannot detect that later commit. It must not be described as a
freshness or race-free-latest check.

If a caller requires current-head freshness in addition to snapshot
consistency, perform a separate fresh-snapshot verification after the baseline
read: commit the baseline transaction, begin a new transaction, read the head
token and conflict index again, and accept the generation only if the token,
generation ID, lineage conflict results, and content hash still agree. Bound
this to a small retry count; after a head change, conflict, timeout, or
exhausted retry, return UNKNOWN rather than promising an impossible
race-free-latest result. Readers must never mix generations or silently treat
missing children as zero. Legacy readers continue to resolve only the
legacy-v1 tables and provenance.

### 5.5 Idempotency, crash recovery, and fencing

- Exact retry after a committed publication returns the existing generation
  for the same request/content identity; it does not create a second head
  transition.
- A crash before transaction commit leaves no visible generation/head change.
  A committed `VERIFIED` generation is complete and can be safely reread after
  restart.
- A crash after commit but before the caller receives the response is recovered
  by request-key lookup and hash verification, not by repeating blind writes.
- A committed `PREPARING`/`REJECTED` diagnostic record, if retained for
  operational visibility, can never be selected by the head. A repair job may
  append a terminal lifecycle event; it must not mutate source evidence or
  invent missing child rows.
- The native advisory lock serializes same-profile publication inside one
  PostgreSQL instance. The head fence/expected-generation compare is still
  required for stale-writer rejection and must be tested with two real
  processes/connections.
- A source conflict discovered after a generation was published does not mutate
  that generation. It makes the conflicted lineage ineligible, so a fresh
  target read or rollback-selection transaction must return UNKNOWN/reject
  rather than trusting the historical `VERIFIED` state.
- Database retry after serialization/deadlock failure is safe only when the
  request key and deterministic content are reused. A retry must re-read the
  head, conflict index, and rerun the stale-fence check.

## 6. Concurrency and replay failure matrix

| Scenario | Current behavior | Required native behavior |
| --- | --- | --- |
| Two fetches for the same clan overlap | Latest current rows can be overwritten by whichever transaction commits last; no immutable source history exists. | Persist both immutable observations; lock/update the per-clan source head only with a monotonic provider generation and reject stale head advancement. |
| Same exact payload is retried | Latest hash may result in a NOOP, but history and source identity are absent. | Unique natural/content key makes the retry idempotent and retains one observation. |
| Same source generation, different payload | Current state replaces prior rows. | Retain both; mark the generation/conflict key `CONFLICTING`; neither qualifies. |
| Older writer finishes after newer writer | No durable generation/fence prevents replay overwrite. | Transaction-scoped native lock plus expected head/fence compare rejects stale publication. |
| Process restarts between fetch and write | No durable batch identity exists. | Immutable observation ID/request key plus source generation and raw hash make replay classification deterministic. |
| Parser rejects one row | P4c marks discarded/ineligible and invalidates whole-source weight proof. | Persist the raw envelope/row conflict; never publish from the partial observation. |
| Source omits declared count/total | P4c reports `UNAVAILABLE`. | Store the observation as UNKNOWN; do not infer completeness or total from normalized rows. |
| CurrentWar points to another war | Current derived roster can still carry selected CurrentWar metadata. | No FK means no source-member relation; source authority remains UNKNOWN. |
| Child target insert fails | Legacy transaction tests model rollback; real DB evidence is not yet verified. | One native transaction rolls back generation/head/event; no partially publishable generation. |
| Reader races publication | Legacy readers can read parent/child separately. | Baseline `REPEATABLE READ` returns one snapshot-consistent generation. A separate fresh-snapshot verification with bounded retries is required only when current-head freshness is requested; never mix generations or treat missing children as zero. |
| Source conflict races publication/read | Current state has no append-only conflict owner, so a late contradiction is lost or overwritten. | Publication revalidates conflicts/fences inside its transaction. Readers and rollback selection recheck the conflict index in a fresh transaction when required; a generation citing a newly conflicted key fails closed even if its historical status was `VERIFIED`. |
| Mirror overwrite | Mirror allowlist overwrites legacy tables and locks the legacy key; it does not copy BotSetting. | Native data is not mirrored by default; any future mirror path needs its own allowlist, integrity, and active/mirror ownership gate. |
| Source is later reclassified | Current rows do not preserve prior classification. | Append a new observation/conflict; never rewrite the historical evidence or generation lineage. The conflicted key invalidates future publication and any head/rollback selection that cites it. |

## 7. Rollback and partial-failure scenarios

Rollback is a native head operation, not a down-migration and not a mutation of
historical evidence.

1. Select a previously `VERIFIED` native generation whose source lineage,
   definitions, targets, authority result, content hash, and current
   conflict-index status still validate. A lineage conflict makes the
   generation ineligible even when its historical status is `VERIFIED`.
2. Acquire the native profile lock and lock the native head.
3. Compare the expected current head/fence. If stale, reject the rollback
   request rather than undoing a newer decision.
4. Append a rollback publication event and move the head to the prior verified
   generation with a new fence token in one transaction. The old and newly
   selected generations remain immutable.
5. If no prior generation verifies, set the native head to unavailable/UNKNOWN
   (or retain no head). Legacy-v1 remains untouched and continues its own
   fail-closed behavior.

Partial failures must produce these outcomes:

- source observation insert failure: no member rows or eligible head update;
- conflict insert failure: preserve the original observation and fail closed;
- late source conflict: preserve both immutable observations and all published
  generations, but clear/withhold any native head or rollback candidate that
  cites the conflicted natural key;
- generation child/lineage failure: transaction rollback, no native head;
- head/event failure: transaction rollback, no generation becomes published;
- reader hash/coverage failure: return UNKNOWN and keep the head unchanged;
- activation failure in P4e: native publication remains recorded but inactive;
  do not modify the native generation or legacy reference; and
- migration failure: stop at the migration gate and use forward repair or an
  owner-approved recovery plan. Do not rely on code checkout rollback to undo
  committed SQL or use a down-migration as runtime rollback.

## 8. Legacy compatibility requirements

P4d must preserve:

- `HeatMapRef` parent ownership, its historical nine buckets, non-50 totals,
  explicit zeroes, source hash, normalized child parity, and existing
  `heatmapref_reference_integrity` semantics;
- the legacy-v1 calculation profile, including lower-bucket collapse and
  weighted behavior;
- factual composition rows, vacancy visibility, and existing UNKNOWN handling
  for unsupported TH19; no native target may silently flow into
  `/compo advice`, `/compo place`, `/compo replace`, `/compo fill`, or
  any `/link list` indicator;
- P0–P4c source, roster, movement, provenance, and fail-closed protections;
- active-runtime ownership of upstream polling and schedulers; mirror remains a
  guarded read-only snapshot runtime;
- no writes to active provenance, scheduler checkpoints, `CurrentWar`, FWA
  current tables, legacy `HeatMapRef`, or legacy normalized children; and
- native publication and P4e activation as independent states. A published
  native generation is not an active runtime profile until a later approved
  activation owner selects it.

The native reference profile may use the same ordered TH19-to-low bucket
registry and explicit `SUPPORTED`/`UNKNOWN` semantics as the diagnostic
candidate artifact, but it must store a versioned profile/policy identity and
must not reuse the legacy parent-row hash as proof of native authority.

## 9. Migration, rollout, and release gates

### P4d-1 — immutable source evidence

P4d-1 is complete only when:

1. The upstream contract supplies or independently attests exact war identity,
   FWA classification, complete roster membership, direct weights, source
   authenticity, durable generation/freshness, and replay semantics. If any
   dimension remains unavailable, the observation owner preserves it as
   UNKNOWN and P4d-1 does not authorize publication.
2. Additive migrations create the immutable envelope/member/conflict owner,
   strict keys/checks/FKs/indexes, and retention/audit policy. No historical
   latest-only rows are backfilled as authoritative.
3. Ingestion is transactionally idempotent, retains conflicting repeats,
   validates raw-to-member correspondence, rejects stale source-generation
   updates with durable fencing, and makes an append-only contradiction against
   a previously eligible natural key invalidate that key for publication.
4. Tests cover duplicate, conflict, stale, replay, missing-proof, partial-row,
   exact retry, restart, and source-to-member relation cases. At least one test
   uses two real PostgreSQL connections/processes, not only mocked Prisma.
5. The migration is applied to a representative existing-schema disposable
   database, including the full repository migration chain. The known
   pre-existing `20260305010000_currentwar_clantag_pk` issue involving a
   missing `CurrentWar_pkey` must remain a separately tracked validation gate;
   it must not be silently repaired in P4d.

P4d-1 still does not publish a native reference or activate a consumer.

### P4d-2 — isolated native publication

P4d-2 is complete only when:

1. The isolated generation/head/band/bucket/target/lineage/event model exists
   with immutable content, profile/policy versions, ordered definitions,
   integrity hashes, explicit target states, and no legacy ownership changes.
2. The publication transaction enforces complete target coverage, exact
   lineage, publication-time conflict revalidation, source authority,
   advisory-lock fencing, stale-generation rejection, and atomic head/event
   publication.
3. Readers consume one snapshot-consistent generation, verify the content hash
   and current conflict index, and return UNKNOWN on missing, mixed, stale,
   conflicted, malformed, or unavailable evidence. Any optional current-head
   freshness check uses a separate fresh snapshot with bounded retries and
   never promises a race-free latest result.
4. Tests prove exact retry idempotency, two-writer contention, stale writer
   rejection, late source-conflict invalidation, child failure rollback,
   crash/retry recovery, reader publication/conflict races, and safe rollback
   to an older verified native generation using real PostgreSQL where required.
5. The rollout is backward-compatible: native tables are additive, no current
   rows are promoted, no legacy table is rewritten, and no native target is
   visible to active consumers without P4e activation.

P4d-2 does not activate TH19 or any native consumer. P4e must separately define
activation ownership, approval, read-path migration, target selection,
operational telemetry, and activation rollback.

### Migration and release gates retained

Before any owner approval for a migration-bearing P4d PR:

- validate `prisma migrate deploy` on a representative existing-schema
  database, not only a fresh database;
- run real PostgreSQL lock/contention and isolation checks with at least two
  connections and capture stale-writer, retry, rollback, and crash-recovery
  outcomes;
- verify the resulting schema, indexes, constraints, and migration history;
- confirm no active/mirror scheduler or legacy provenance state changes;
- review backup/recovery and forward-repair implications at release time; and
- keep production, staging, upstream data fetches, backfills, activation, and
  deployment outside this documentation milestone.

The current mocked advisory-lock and transaction tests are not sufficient to
close these gates. Until live evidence exists, concurrency validation is
`UNVERIFIED` and the recommendation remains NO-GO.

## 10. Explicit recommendation

**Recommendation: do not implement native publication yet.** First obtain an
upstream contract or independent source authority that can prove exact war
identity, FWA classification, complete membership, direct weights,
authenticity, stable generation/freshness, and replay/conflict history. Then
implement P4d-1 as an additive immutable observation owner and validate it on
real PostgreSQL. Only after P4d-1 is green should P4d-2 add the isolated native
generation and publication head.

The current state is:

- **Proven:** raw parser/evidence diagnostics, structural checks when declared
  facts exist, latest-only current-state ownership, legacy-v1 parity and
  fail-closed behavior, diagnostic candidate versioning, and mocked rollback /
  stale-generation contract tests.
- **Proposed:** immutable observation ownership, conflict retention, native
  generation/target/head model, transactional fencing, snapshot readers,
  idempotent retry, crash recovery, and rollback protocol described here.
- **Blocked/UNAVAILABLE:** exact upstream war identity, independent FWA
  classification, source-declared completeness and totals, direct-weight
  authority for persisted snapshots, source authenticity, durable generation,
  replay protection, real PostgreSQL contention evidence, migration-chain
  validation, native publication, and P4e activation.

No application code, Prisma migration, native evidence, reference row,
provenance, scheduler state, production/staging state, or external service was
changed by this investigation.
