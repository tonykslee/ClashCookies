import { DuskLedgerBeneficiaryMode, DuskLedgerTransactionType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  previewDuskRepWorkRewardReconciliationFromStore,
  reconcileDuskRepWorkRewardPreview,
  type DuskRewardReconciliationLedgerSnapshot,
} from "../src/services/DuskRewardReconciliationPreview";
import { evaluateDuskRepWorkRewards, type DuskRepWorkRewardEvaluationScope } from "../src/services/DuskRepWorkRewardEvaluator";
import type { HistoricalRepWorkEventRow } from "../src/services/duskHistoricalEarningsSimulation";

const scope: DuskRepWorkRewardEvaluationScope = {
  guildId: "guild-1",
  from: new Date("2026-01-05T00:00:00.000Z"),
  to: new Date("2026-01-19T00:00:00.000Z"),
  snapshotAt: new Date("2026-01-20T00:00:00.000Z"),
};

function event(id: string, dedupeKey: string, overrides: Partial<HistoricalRepWorkEventRow> = {}): HistoricalRepWorkEventRow {
  return {
    id,
    guildId: "guild-1",
    activityType: "BASES_CHECKED",
    discordUserId: "111111111111111",
    clanTag: "#HOME",
    syncMessageId: "sync-1",
    sourceMessageId: "message-1",
    sourceTrackedMessageId: "tracked-1",
    warId: "100",
    warStartTime: new Date("2026-01-06T12:00:00.000Z"),
    opponentTag: "#OPPONENT",
    eventAt: new Date("2026-01-07T10:00:00.000Z"),
    dedupeKey,
    metadata: {
      activityType: "BASES_CHECKED",
      source: "base_swap",
      clanKind: "FWA",
      viewType: "Bases",
    },
    createdAt: new Date("2026-01-07T10:00:01.000Z"),
    updatedAt: new Date("2026-01-07T10:00:01.000Z"),
    ...overrides,
  };
}

type LedgerEntry = DuskRewardReconciliationLedgerSnapshot["entries"][number];
type SourceEvent = DuskRewardReconciliationLedgerSnapshot["sourceEvents"][number];
type Claim = SourceEvent["claims"][number];
type ReversalRequest = DuskRewardReconciliationLedgerSnapshot["reversalRequests"][number];

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "ledger-1",
    walletId: "111111111111111",
    amount: 2,
    transactionType: DuskLedgerTransactionType.EARNING,
    beneficiaryMode: DuskLedgerBeneficiaryMode.SINGLE_RECIPIENT,
    beneficiaryKey: null,
    sourceEventType: "rep-work-activity",
    sourceEventId: "event-1",
    idempotencyKey: "dedupe-1",
    reversalOfId: null,
    createdAt: new Date("2026-01-08T00:00:00.000Z"),
    ...overrides,
  };
}

function sourceEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    id: "source-1",
    sourceEventType: "rep-work-activity",
    sourceEventId: "event-1",
    beneficiaryMode: DuskLedgerBeneficiaryMode.SINGLE_RECIPIENT,
    claims: [claim()],
    _count: { claims: 1 },
    ...overrides,
  };
}

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "claim-1",
    beneficiaryKey: null,
    walletId: "111111111111111",
    ledgerEntryId: "ledger-1",
    createdAt: new Date("2026-01-08T00:00:00.000Z"),
    ...overrides,
  };
}

function reversalRequest(overrides: Partial<ReversalRequest> = {}): ReversalRequest {
  return {
    id: "reversal-request-1",
    walletId: "111111111111111",
    originalEntryId: "ledger-1",
    requestedAmount: -2,
    sourceEventType: "technical-reversal",
    sourceEventId: "case-1",
    idempotencyKey: "case-1",
    createdAt: new Date("2026-01-09T00:00:00.000Z"),
    resolution: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<DuskRewardReconciliationLedgerSnapshot> = {}): DuskRewardReconciliationLedgerSnapshot {
  return {
    entries: [],
    sourceEvents: [],
    reversalRequests: [],
    truncated: false,
    ...overrides,
  };
}

function recordedSnapshot(overrides: Partial<DuskRewardReconciliationLedgerSnapshot> = {}): DuskRewardReconciliationLedgerSnapshot {
  return snapshot({ entries: [ledgerEntry()], sourceEvents: [sourceEvent()], ...overrides });
}

describe("Dusk reward reconciliation preview", () => {
  it("reports a clean candidate without calling missing ledger evidence verified non-issuance", () => {
    const evaluation = evaluateDuskRepWorkRewards({ scope, events: [event("event-1", "dedupe-1")] });
    const result = reconcileDuskRepWorkRewardPreview(evaluation, snapshot());

    expect(result.events[0]).toMatchObject({
      outcome: "ELIGIBLE_NOT_CLAIMED",
      reasonCode: "NO_MATCHING_CLAIM_OBSERVED",
      ledgerEvidence: "NO_MATCHING_RECORD_OBSERVED",
      sourceEventId: "event-1",
      canonicalDedupeKey: "dedupe-1",
      simulationOnlyDuskits: 2,
    });
    expect(result.summary).toMatchObject({
      eligibleNotClaimedEvents: 1,
      candidateUncappedSimulationOnlyDuskits: 2,
      noMatchingRecordObserved: 1,
      ledgerSnapshotTruncated: false,
    });
    expect(result.amountsAreSimulationOnly).toBe(true);
  });

  it("recognizes an existing matching claim and provenance as already recorded", () => {
    const evaluation = evaluateDuskRepWorkRewards({ scope, events: [event("event-1", "dedupe-1")] });
    const result = reconcileDuskRepWorkRewardPreview(evaluation, recordedSnapshot());

    expect(result.events[0]).toMatchObject({
      outcome: "ALREADY_RECORDED",
      reasonCode: "MATCHING_CLAIM_AND_ENTRY",
      matchedLedgerEntryId: "ledger-1",
      matchedClaimId: "claim-1",
    });
    expect(result.summary.candidateUncappedSimulationOnlyDuskits).toBe(0);
  });

  it("separates duplicate evaluated evidence from a conflicting wallet claim", () => {
    const duplicateEvaluation = evaluateDuskRepWorkRewards({
      scope,
      events: [event("event-1", "dedupe-1"), event("event-2", "dedupe-1")],
    });
    const duplicateResult = reconcileDuskRepWorkRewardPreview(duplicateEvaluation, snapshot());
    expect(duplicateResult.events.map((row) => row.outcome)).toEqual([
      "ELIGIBLE_NOT_CLAIMED",
      "DUPLICATE_EVIDENCE",
    ]);

    const conflictEvaluation = evaluateDuskRepWorkRewards({ scope, events: [event("event-1", "dedupe-1")] });
    const conflictResult = reconcileDuskRepWorkRewardPreview(
      conflictEvaluation,
      snapshot({
        entries: [ledgerEntry({ walletId: "222222222222222" })],
        sourceEvents: [sourceEvent({ claims: [claim({ walletId: "222222222222222" })] })],
      }),
    );
    expect(conflictResult.events[0]).toMatchObject({
      outcome: "CONFLICTING_CLAIM",
      reasonCode: "LEDGER_WALLET_MISMATCH",
    });
  });

  it("fails closed for reversed entries and unresolved reversal requests", () => {
    const evaluation = evaluateDuskRepWorkRewards({ scope, events: [event("event-1", "dedupe-1")] });
    const reversed = reconcileDuskRepWorkRewardPreview(
      evaluation,
      recordedSnapshot({
        entries: [ledgerEntry(), ledgerEntry({ id: "reversal-1", amount: -2, transactionType: DuskLedgerTransactionType.REVERSAL, reversalOfId: "ledger-1" })],
      }),
    );
    expect(reversed.events[0]).toMatchObject({ outcome: "REVERSED_CLAIM", reasonCode: "REVERSED_LEDGER_ENTRY" });

    const pending = reconcileDuskRepWorkRewardPreview(
      evaluation,
      recordedSnapshot({ reversalRequests: [reversalRequest()] }),
    );
    expect(pending.events[0]).toMatchObject({
      outcome: "UNRESOLVED_REVERSAL",
      reasonCode: "UNRESOLVED_REVERSAL_REQUEST",
      reversalRequestId: "reversal-request-1",
    });
  });

  it("keeps UNKNOWN evidence UNKNOWN even when no claim is present", () => {
    const evaluation = evaluateDuskRepWorkRewards({
      scope,
      events: [event("event-unknown", "dedupe-unknown", { metadata: { source: "other" } })],
    });
    const result = reconcileDuskRepWorkRewardPreview(evaluation, snapshot());

    expect(result.events[0]).toMatchObject({ outcome: "UNKNOWN_EVIDENCE", reasonCode: "REP_EVENT_SOURCE_UNKNOWN" });
    expect(result.summary.eligibleNotClaimedEvents).toBe(0);
  });

  it("reports the cap boundary as rep-work-only simulation and never as an approved shared policy", () => {
    const evaluation = evaluateDuskRepWorkRewards({
      scope,
      events: Array.from({ length: 16 }, (_, index) => event(`event-${index}`, `dedupe-${index}`, {
        eventAt: new Date(`2026-01-07T${String(index + 1).padStart(2, "0")}:00:00.000Z`),
      })),
    });
    const result = reconcileDuskRepWorkRewardPreview(evaluation, snapshot());

    expect(result.weekly[0]).toMatchObject({
      uncappedRepWorkSimulationOnlyDuskits: 32,
      cappedRepWorkSimulationOnlyDuskits: 30,
      capExceededInRepWorkOnlySimulation: true,
      allSourceCapEstablished: false,
    });
    expect(result.policy).toMatchObject({
      weeklyCapDuskits: 30,
      status: "SIMULATION_ONLY_NOT_APPROVED",
      capScope: "REP_WORK_ONLY_SIMULATION",
      allSourceCapEstablished: false,
    });
  });

  it("requires manual review when source evidence changed", () => {
    const evaluation = evaluateDuskRepWorkRewards({
      scope,
      events: [event("event-1", "dedupe-1", { updatedAt: new Date("2026-01-08T00:00:00.000Z") })],
    });
    const result = reconcileDuskRepWorkRewardPreview(evaluation, snapshot());

    expect(result.events[0]).toMatchObject({
      outcome: "SOURCE_EVIDENCE_CHANGED",
      reasonCode: "OBSERVED_SOURCE_UPDATE_NOT_PROVEN_CORRECTION",
    });
  });

  it("is repeatable and uses only bounded read-only store calls", async () => {
    const listEventsForEvaluation = vi.fn().mockResolvedValue([event("event-1", "dedupe-1")]);
    const listRewardReconciliationSnapshot = vi.fn().mockResolvedValue(snapshot());
    const store = { listEventsForEvaluation, listRewardReconciliationSnapshot };

    const first = await previewDuskRepWorkRewardReconciliationFromStore(scope, store);
    const second = await previewDuskRepWorkRewardReconciliationFromStore(scope, store);

    expect(first).toEqual(second);
    expect(listRewardReconciliationSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventIds: ["event-1"],
      sourceEventTypes: expect.arrayContaining(["rep-work-activity"]),
      snapshotAt: scope.snapshotAt,
      limit: 10_000,
    }));
    expect(listEventsForEvaluation).toHaveBeenCalledTimes(2);
    expect(listRewardReconciliationSnapshot).toHaveBeenCalledTimes(2);
  });
});
