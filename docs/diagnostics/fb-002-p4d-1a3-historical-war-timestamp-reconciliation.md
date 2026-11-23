# FB-002 P4d-1a.3 — Historical war timestamp reconciliation diagnostic

Status: diagnostic packet prepared; the new per-war comparison is **not
executed** and has no production result. This document references issue
[#2113](https://github.com/tonykslee/ClashCookies/issues/2113) and preserves
the P4d-1b **NO-GO** boundary. TH19 native targets remain UNKNOWN/inactive.

## Scope and evidence boundary

This diagnostic compares Dusk's retained `ClanWarHistory` end timestamp with
the retained `ClanWarParticipation` end timestamp, then compares each against
the supplied ClashPerk export fixture. It does not change history, add an
archive writer, poll ClashPerk, query Discord, access FWAStats, or publish a
native reference.

The approved Dusk scope is exactly:

```text
clan:        #2YUYLJCGV (Rising Dawn)
window:      [2026-09-23T00:00:00Z, 2026-11-22T00:00:00Z)
selection:   latest 20 ended wars
ordering:    warEndTime DESC, warStartTime DESC, warId DESC
```

Both SQL files fail closed unless the psql variables equal the exact clan and
both exact UTC boundaries above; a shifted 60-day interval is rejected.

The ClashPerk fixture is stored at
`scripts/fixtures/fb-002-p4d-1a3-clashperk-rising-dawn.json`. Its numeric
ClashPerk IDs are trace identifiers only and are never joined to Dusk
`warId`. The export's `Etc/GMT` timezone is treated as UTC, a documented
comparison assumption rather than an authority claim. The November 22
`03:55:39Z` observation is outside the half-open window and is not included.

## Previously reported B1 observations

The following are operator-reported results from the earlier, separately
approved aggregate B1 inspection. They are recorded here as prior evidence,
not as results produced by this diagnostic:

- Rising Dawn `#2YUYLJCGV` and Rocky Road `#2RYGLU2UY` were each reported as
  20 selected ended wars.
- Each clan was reported with 1,000 participation rows.
- Each clan was reported with 12 wars containing end-time mismatches and 600
  mismatch rows.
- Both clans were reported with zero start-time mismatch rows, zero additional
  cross-guild identity copies, and participation records for every selected
  war.
- Selection used `ORDER BY warEndTime DESC, warStartTime DESC, warId DESC
  LIMIT 20`.

Those observations do not authorize this new per-war extraction. No
ClashPerk-vs-Dusk comparison result is claimed until the owner separately
authorizes both stages below.

## Dusk timestamp paths and the canonical archive contract

The archive path now resolves one timestamp decision before the history,
lookup, payload, and participation writes:

1. An exact `CurrentWar` row is eligible only when normalized clan, opponent,
   start time, guild scope, and compatible persisted war ID evidence agree.
   Its direct end-time observation is preferred only when an exact
   `WarAttacks.warEndTime` observation from the same war corroborates it.
2. Exact `WarAttacks` rows are the fallback direct API evidence. Rows with
   missing or conflicting identity/timestamp evidence fail closed rather than
   selecting an arbitrary candidate.
3. The clan-war log is not a timestamp authority. Its entries do not carry
   the exact Dusk war start or persisted ID, so the old `log[0]` fallback is
   removed. Log result fields are used only when a verified end timestamp and
   a unique matching log timestamp provide bounded contextual corroboration;
   otherwise the event payload/current snapshot fallbacks remain in use.
4. No source and no derived `startTime + 24 hours` estimate produce a null,
   UNKNOWN timestamp rather than fabricated evidence.

The selected value is passed consistently to `ClanWarHistory.warEndTime`,
`WarLookup.endTime`, newly constructed `warMeta.endTime`,
`compliance.canonical.warEndTime`, and `ClanWarParticipation.warEndTime`.
Existing history and lookup timestamps are preserved on conflict/replay, and
an existing lookup payload is preserved when no live attack rows remain.
Participation is not independently allowed to substitute `CurrentWar.endTime`.

This contract establishes Dusk's internal timestamp consistency only. It does
not establish FWAStats or ClashPerk upstream identity, source authenticity,
source generation, or direct historical weight provenance. Agreement with
ClashPerk remains corroboration only; Dusk and ClashPerk may both ultimately
derive from Supercell API data.

## SQL stages and approval gates

### Stage B0 — EXPLAIN only

File: `docs/diagnostics/sql/fb-002-p4d-1a3-war-timestamp-explain.sql`

This file validates the restricted role/database, read-only transaction,
timeouts, UTC timezone, SELECT-only permissions, required indexes, fixed
scope, and exact 60-day interval. It then runs `EXPLAIN (COSTS TRUE,
VERBOSE FALSE)` on the exact B1 query. It never uses `EXPLAIN ANALYZE` and
does not query `WarLookup`.

The history index assertion requires all of:

```text
index:  WarClanHistory_clanTag_warEndTime_idx
table:  public.ClanWarHistory
keys:   clanTag, warEndTime (leading order)
state:  indisvalid = true and indisready = true
```

The participation index assertion requires
`ClanWarParticipation_warId_idx` on `public.ClanWarParticipation`, with
`warId` as its leading key and valid/ready state.

Stop after B0. Review the plan for an index-backed bounded selection and
acceptable cost before considering B1.

### Stage B1 — per-war aggregate SELECT

File: `docs/diagnostics/sql/fb-002-p4d-1a3-war-timestamp-select.sql`

B1 repeats its own safeguards and executes only after a separate owner
approval. It uses an index-aware lateral selection with `LIMIT 20` applied
during selection. It joins participation by `ClanWarHistory.warId::text`
and matching `clanTag`.

The output contains one aggregate row per selected war and no player names,
player tags, Discord IDs, or JSON payloads. It includes history and
participation timestamps, participation row/identity counts, distinct and
null participation end-time counts, minimum/maximum participation end times,
start/opponent mismatch counts, and cross-guild duplicate indicators. It
does not collapse contradictory participation timestamps.

`history_minus_participation_seconds` is populated only when participation
end-time evidence has one non-null distinct timestamp and no null end-time
rows. Otherwise the value is NULL and the offline comparator reports
`INCONSISTENT_PARTICIPATION` or `MISSING_EVIDENCE`.

## Offline comparator

The comparator is pure offline code:

```cmd
npm run diagnose:compare-historical-war-timestamps -- --clashperk scripts/fixtures/fb-002-p4d-1a3-clashperk-rising-dawn.json --dusk <approved-dusk-result.json> --output <comparison-report.json>
```

It accepts JSON arrays or `{ "rows": [...] }` JSON envelopes. It also accepts
headered CSV files. A future Dusk export must contain the final B1 result rows
using the SQL column names; only that final result set should be supplied, not
the preflight result sets.

To capture only that final headered CSV without redirecting preflight output,
run the B1 file with its optional psql output gate. Preflight results remain
on the console; only the final SELECT is written locally:

```cmd
psql -X -v ON_ERROR_STOP=1 -v capture_final=on -v final_output="C:\Temp\fb002-p4d1a3-b1-final.csv" --host=<PRODUCTION_HOST> --port=<PORT> --username=clashcookies_dusk_readonly --dbname=clashcookies --file="%SQLDIR%\fb-002-p4d-1a3-war-timestamp-select.sql"
if errorlevel 1 (
  echo B1 capture failed. STOP.
  exit /b 1
)
```

The file's `\o` and CSV-format commands are active only around the final
SELECT and are not SQL statements or database writes. Do not redirect the
whole psql process, because that would mix preflight output with comparator
input. The capture remains separately gated after B0 review.

Matching is deterministic and fail-closed:

1. normalize clan and opponent tags case-insensitively with a leading `#`;
2. restrict Dusk candidates to the fixed UTC window;
3. require the same clan and normalized opponent tag; and
4. require exactly one candidate.

The numeric ClashPerk ID is never used for matching. Zero candidates produce
`UNMATCHED`; multiple candidates produce `AMBIGUOUS`. No tolerance is used to
select an identity. For a unique candidate with complete, internally
consistent participation evidence, the report preserves these raw offsets:

Duplicate external identities, reused Dusk candidate identities, and multiple
Dusk candidates are all reported as `AMBIGUOUS`; the comparator never assigns
one Dusk war to two external observations and never selects by proximity or
numeric external ID.

```text
ClashPerk - Dusk history
ClashPerk - participation
Dusk history - participation
```

The report also identifies which source is closer, exact-match controls,
positive/negative extrema, descriptive small-offset cases, contradictory
participation, and unmatched/ambiguous records. “Closer” is descriptive and
never authorizes a source or changes an outcome to authoritative.

Explicit outcomes are:

```text
CLOSER_TO_HISTORY
CLOSER_TO_PARTICIPATION
EQUAL_DISTANCE
UNMATCHED
AMBIGUOUS
INCONSISTENT_PARTICIPATION
MISSING_EVIDENCE
```

## Operator procedure and separate approvals

No command below was executed by Codex. The owner must provide the approved
production host/port and run each stage separately with the existing
restricted role. Do not create a tunnel or use a production credential in an
environment variable inspected by Codex.

```cmd
set "PSQL=C:\Program Files\PostgreSQL\17\bin\psql.exe"
set "SQLDIR=C:\Projects\ClashCookies\docs\diagnostics\sql"
```

After owner approval for the new plan inspection only:

```cmd
"%PSQL%" -X -v ON_ERROR_STOP=1 --host=<PRODUCTION_HOST> --port=<PORT> --username=clashcookies_dusk_readonly --dbname=clashcookies --file="%SQLDIR%\fb-002-p4d-1a3-war-timestamp-explain.sql"
if errorlevel 1 (
  echo B0 failed. STOP.
  exit /b 1
)
```

Stop and review the B0 plan. Only after separate approval for the data
extraction:

```cmd
"%PSQL%" -X -v ON_ERROR_STOP=1 --host=<PRODUCTION_HOST> --port=<PORT> --username=clashcookies_dusk_readonly --dbname=clashcookies --file="%SQLDIR%\fb-002-p4d-1a3-war-timestamp-select.sql"
if errorlevel 1 (
  echo B1 failed. STOP.
  exit /b 1
)
```

The operator must stop on a wrong role/database, missing table or index,
unexpected privilege, non-read-only transaction, non-UTC timezone, timeout,
lock wait, expensive plan, schema mismatch, invalid scope, or any nonzero
exit status. There are no automatic retries and B1 is never chained after B0.

## What remains unverified

- No new production EXPLAIN or per-war SELECT has been executed.
- No ClashPerk live access, API polling, scraping, or Google Sheets fetch was
  performed by Codex.
- The 20-row ClashPerk fixture is external evidence supplied for comparison;
  its records are not proven to share Dusk numeric war identity.
- A timestamp match cannot establish source authenticity, generation,
  replay semantics, FWA classification, complete roster coverage, or direct
  historical weight provenance.
- The comparison cannot determine whether Dusk history or participation is
  authoritative; it only measures the observed relationship.
- P4d-1b remains NO-GO. No native reference, TH19 target, or publication
  authority is introduced.
