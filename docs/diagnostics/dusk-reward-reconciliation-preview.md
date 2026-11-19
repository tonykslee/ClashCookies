# Dusk Reward Reconciliation Preview

**Status:** M2a Part 2 implementation; bounded read-only preview only

## Scope

This preview connects the M2a Part 1 `DuskRepWorkRewardEvaluator` result to the existing `DuskLedgerService` read model. It compares evaluated `RepWorkActivityEvent` rows with persisted Dusk source events, source-event claims, ledger entries, executed reversals, and pending reversal requests. It does not create wallets, claims, ledger rows, corrections, reversals, spends, schedules, commands, payouts, or reward activation.

The preview is deterministic for a fixed evaluator result and fixed ledger snapshot. The ledger adapter obtains its bounded source-event, claim, earning, and reversal reads inside one read-only Prisma `REPEATABLE READ` transaction. Event identity is limited to the persisted `RepWorkActivityEvent.id` and persisted `dedupeKey`; mutable source fields are never used to create a replacement identity. The canonical future source-event type is `rep-work-activity`; older rep-work aliases are read only for reconciliation compatibility. Ledger entries are also bounded by the persisted canonical idempotency keys so an existing earning cannot be hidden by a changed source-event ID.

## Outcomes and fail-closed behavior

| Outcome | Meaning |
| --- | --- |
| `ELIGIBLE_NOT_CLAIMED` | Evaluator evidence is eligible and no matching source/ledger record was observed in a complete bounded snapshot. This is a preview candidate, not verified non-issuance or an award. |
| `ALREADY_RECORDED` | The persisted source claim and ledger entry match the Discord wallet, source ID, canonical idempotency key, single-recipient semantics, and simulation amount. Existing credit is never shown as new. |
| `DUPLICATE_EVIDENCE` | The evaluator suppressed a repeated canonical dedupe key. |
| `CONFLICTING_CLAIM` | Claim, source-event, ledger, beneficiary, wallet, amount, or identity records disagree or are incomplete. |
| `UNKNOWN_EVIDENCE` | The evaluator did not establish qualifying evidence, or the bounded ledger snapshot was truncated. Missing claims cannot upgrade this outcome. |
| `SOURCE_EVIDENCE_CHANGED` | `updatedAt > createdAt` was observed without durable correction proof. Manual review is required even when a claim is absent. |
| `REVERSED_CLAIM` | A matching earning has an executed compensating reversal. The preview never reissues it. |
| `UNRESOLVED_REVERSAL` | A matching earning has a pending reversal request. The preview never reissues it. |

`NO_MATCHING_RECORD_OBSERVED` is deliberately separate from verified non-issuance. A bounded snapshot only establishes what was visible in that read; it does not prove that no prior attempt, external correction, or unavailable ledger row exists.

The adapter filters both claims and claim counts at `snapshotAt`. Any bounded overflow, claim-count mismatch, non-repeatable snapshot marker, or other incomplete ledger evidence prevents `ALREADY_RECORDED` and `ELIGIBLE_NOT_CLAIMED`; the result remains UNKNOWN or requires review.

## Cap diagnostics

The evaluator’s +2 amount and 30-Duskit weekly cap remain `SIMULATION_ONLY_NOT_APPROVED`. The preview carries forward the UTC-week totals and labels them `REP_WORK_ONLY_SIMULATION`; `allSourceCapEstablished` is always `false`. This does not prove the future shared all-source cap because clean-war, Blacklist, transfer, quest, stipend, and other sources are not part of this preview.

## Remaining requirements before active crediting

The future active-only reconciliation/issuance slice still needs:

- an approved, versioned earning policy and explicit activation/disable gate;
- durable claim ownership and a stable canonical idempotency contract for the active writer, including safe retries after unknown database outcomes and concurrency tests against representative PostgreSQL;
- explicit correction provenance for mutable or corrected operational evidence, including when a prior earning is reversed and when a replacement claim is permitted;
- a reviewed manual workflow for conflicting claims, changed evidence, incomplete snapshots, declined reversals, and unresolved reversal requests;
- bounded batch checkpoints/observability and reconciliation of any ambiguous writer outcome before retrying;
- active-production-only behavior with staging/mirror, scheduler, command, payout, role, backfill, and deployment gates; and
- explicit approval of rates and caps. This preview itself does not approve or activate either.
