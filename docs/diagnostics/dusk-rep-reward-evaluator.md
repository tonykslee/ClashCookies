# Duskits Verified Rep-Work Reward Evaluator

**Status:** M2a Part 1 merged in PR #1992 (`8d0b46be`); read-only evaluation only (evaluator version 2)
**Date:** 2026-11-14

## Scope

`DuskRepWorkRewardEvaluator` evaluates a bounded, explicit Monday-to-Monday UTC window of persisted `RepWorkActivityEvent` rows. It does not call `recordEarning()`, `spend()`, wallet mutation helpers, ledger writes, Discord APIs, schedulers, or upstream Clash APIs.

The store adapter reads through `RepWorkActivityService` with a stable `eventAt, id` order and a hard maximum of 10,000 rows. The pure evaluator can also be used with fixture or reconciliation input. Repeating the same input produces the same event classifications, provenance, user attribution, weekly buckets, and draft cap totals.

## Sufficiently verified evidence

The evaluator recognizes only the source variants already accepted by the historical simulation classifier:

- `BASES_CHECKED` + `metadata.source=base_swap` + exact `metadata.clanKind=FWA`;
- `BASES_CHECKED` + `metadata.source=bases_checklist` + `metadata.viewType=Bases`;
- `MAIL_CHECKED` + `metadata.source=mail_checklist` + `metadata.viewType=Mail`;
- `MAIL_SENT` + `metadata.source=fwa_match_mail_send`.

An eligible result is attributed to the event's persisted `discordUserId`, not to a current `PlayerLink` or current rep assignment. The immutable event `id`, canonical persisted `dedupeKey`, source message IDs, clan/war context, timestamps, and source metadata are retained in the result for future reconciliation.

## Classification and draft calculations

Each in-scope row is classified as `ELIGIBLE`, `INELIGIBLE`, or `UNKNOWN` with a reason code. Rows are first grouped by canonical persisted `dedupeKey`, then each group is evaluated as a unit. Identical recognized evidence produces one `ELIGIBLE` row and deterministic `INELIGIBLE` duplicates only when Discord attribution, exact `eventAt`, activity/source metadata, clan/war identity, and message provenance all agree. Any mixed UNKNOWN evidence, conflicting Discord attribution, conflicting FWA/CWL/source evidence, or contradiction in those authoritative context fields makes every row in that key group `UNKNOWN` with `REP_EVENT_DEDUPE_CONFLICT`; no row in the group contributes draft Duskits. Optional context fields are equivalent only when absent on both rows or equal; missing-versus-present is conservative UNKNOWN. Missing immutable IDs, missing dedupe keys, invalid Discord IDs/timestamps, unknown source metadata, and CWL source metadata remain `UNKNOWN` and contribute no draft Duskits.

The evaluator reports +2 per eligible event and a shared 30-Duskit per-user UTC-week cap only as `SIMULATION_ONLY_NOT_APPROVED` calculations. It never creates an earning, claim, ledger entry, wallet, redemption, role, payout, or announcement.

## Evidence still requiring review or new persistence

- `metadata.clanKind=CWL`, missing `clanKind`, or another ambiguous `base_swap` source is not FWA proof and remains `UNKNOWN`.
- `updatedAt > createdAt` is reported as `OBSERVED_UPDATE_NOT_PROVEN_CORRECTION`; the evaluator emits zero proven correction rows. A source update is not an independent correction or reversal identity.
- No active-only reconciler, issuance path, reversal path, policy approval, or production reward activation is implemented here. The separate M2a Part 2 preview compares this evaluator's output with existing ledger/source claims but remains read-only; see [Dusk reward reconciliation preview](dusk-reward-reconciliation-preview.md).
- Clean-FWA participation, BL triples, proactive base swaps, recurring rep stipends, transfers, giveaway fulfillment, and sponsorship remain outside this evaluator and retain the evidence limitations documented by the historical simulation.
- Proposed rates and caps require explicit policy approval and later reconciliation/rollback design before any wallet mutation can be considered.
