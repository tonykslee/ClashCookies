import {
  DuskLedgerBeneficiaryMode,
  DuskLedgerTransactionType,
  DuskReversalResolutionType,
} from "@prisma/client";

import {
  DUSK_REP_WORK_EVALUATION_MAX_EVENTS,
  evaluateDuskRepWorkRewardsFromStore,
  type DuskRepWorkRewardEvaluation,
  type DuskRepWorkRewardEvaluationScope,
  type DuskRepWorkRewardEvent,
  type DuskRepWorkRewardReasonCode,
} from "./DuskRepWorkRewardEvaluator";
import {
  duskLedgerService,
  type DuskRewardReconciliationLedgerSnapshot,
} from "./DuskLedgerService";
import { repWorkActivityService, type RepWorkActivityAuditEvent } from "./RepWorkActivityService";

/** Canonical source-event type for a future rep-work earning claim. */
export const DUSK_REP_WORK_SOURCE_EVENT_TYPE = "rep-work-activity";

/** Older aliases are read for reconciliation, but no new identity is derived from them. */
export const DUSK_REP_WORK_SOURCE_EVENT_TYPES = [
  DUSK_REP_WORK_SOURCE_EVENT_TYPE,
  "rep-work",
  "rep-work-activity-event",
  "repwork",
] as const;

export type DuskRewardReconciliationOutcome =
  | "ELIGIBLE_NOT_CLAIMED"
  | "ALREADY_RECORDED"
  | "DUPLICATE_EVIDENCE"
  | "CONFLICTING_CLAIM"
  | "UNKNOWN_EVIDENCE"
  | "SOURCE_EVIDENCE_CHANGED"
  | "REVERSED_CLAIM"
  | "UNRESOLVED_REVERSAL";

export type DuskRewardReconciliationReasonCode =
  | "NO_MATCHING_CLAIM_OBSERVED"
  | "MATCHING_CLAIM_AND_ENTRY"
  | "DUPLICATE_DEDUPE_KEY"
  | "LEDGER_SNAPSHOT_TRUNCATED"
  | "SOURCE_EVENT_WITHOUT_CLAIM"
  | "CLAIM_WITHOUT_LEDGER_ENTRY"
  | "ENTRY_WITHOUT_CLAIM"
  | "LEDGER_AMOUNT_MISMATCH"
  | "LEDGER_WALLET_MISMATCH"
  | "LEDGER_IDENTITY_MISMATCH"
  | "MULTIPLE_CLAIMS_FOR_SOURCE"
  | "REVERSED_LEDGER_ENTRY"
  | "UNRESOLVED_REVERSAL_REQUEST"
  | "DECLINED_REVERSAL_REVIEW"
  | "OBSERVED_SOURCE_UPDATE_NOT_PROVEN_CORRECTION"
  | "MISSING_PERSISTED_IDENTITY"
  | "EVALUATOR_UNKNOWN_EVIDENCE";

export type DuskRewardReconciliationLedgerEvidence =
  | "NO_MATCHING_RECORD_OBSERVED"
  | "SOURCE_EVENT_WITHOUT_CLAIM"
  | "MATCHED_CLAIM_AND_ENTRY"
  | "CLAIM_WITHOUT_LEDGER_ENTRY"
  | "ENTRY_WITHOUT_CLAIM"
  | "CONFLICTING_RECORDS"
  | "SNAPSHOT_TRUNCATED";

export type DuskRewardReconciliationEvent = {
  sourceEventType: typeof DUSK_REP_WORK_SOURCE_EVENT_TYPE;
  sourceEventId: string | null;
  canonicalDedupeKey: string | null;
  classification: DuskRepWorkRewardEvent["classification"];
  outcome: DuskRewardReconciliationOutcome;
  reasonCode: DuskRewardReconciliationReasonCode | DuskRepWorkRewardReasonCode;
  discordUserId: string | null;
  simulationOnlyDuskits: number;
  ledgerEvidence: DuskRewardReconciliationLedgerEvidence;
  matchedLedgerEntryId: string | null;
  matchedClaimId: string | null;
  reversalRequestId: string | null;
};

export type DuskRewardReconciliationWeeklyDiagnostic = {
  weekStart: string;
  eligibleRepWorkEvents: number;
  uncappedRepWorkSimulationOnlyDuskits: number;
  cappedRepWorkSimulationOnlyDuskits: number;
  capExceededInRepWorkOnlySimulation: boolean;
  allSourceCapEstablished: false;
};

export type DuskRewardReconciliationPreview = {
  evaluator: DuskRepWorkRewardEvaluation["evaluator"];
  reconciliation: "dusk-reward-reconciliation-preview";
  reconciliationVersion: "1";
  readOnly: true;
  amountsAreSimulationOnly: true;
  scope: DuskRepWorkRewardEvaluation["scope"];
  policy: DuskRepWorkRewardEvaluation["policy"] & {
    capScope: "REP_WORK_ONLY_SIMULATION";
    allSourceCapEstablished: false;
  };
  summary: {
    sourceRows: number;
    previewEvents: number;
    eligibleNotClaimedEvents: number;
    alreadyRecordedEvents: number;
    duplicateEvidenceEvents: number;
    unknownEvidenceEvents: number;
    sourceEvidenceChangedEvents: number;
    conflictingClaimEvents: number;
    reversedClaimEvents: number;
    unresolvedReversalEvents: number;
    manualReviewEvents: number;
    noMatchingRecordObserved: number;
    candidateUncappedSimulationOnlyDuskits: number;
    evaluatedUncappedSimulationOnlyDuskits: number;
    evaluatedCappedRepWorkSimulationOnlyDuskits: number;
    ledgerSnapshotTruncated: boolean;
    outcomeCounts: Record<DuskRewardReconciliationOutcome, number>;
    reasonCounts: Record<string, number>;
  };
  events: DuskRewardReconciliationEvent[];
  weekly: DuskRewardReconciliationWeeklyDiagnostic[];
};

export type DuskRewardReconciliationPreviewStore = {
  listEventsForEvaluation(input: {
    guildId: string;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<readonly RepWorkActivityAuditEvent[]>;
  listRewardReconciliationSnapshot(input: {
    sourceEventTypes: readonly string[];
    sourceEventIds: readonly string[];
    snapshotAt: Date;
    limit: number;
  }): Promise<DuskRewardReconciliationLedgerSnapshot>;
};

const defaultStore: DuskRewardReconciliationPreviewStore = {
  listEventsForEvaluation: (input) => repWorkActivityService.listEventsForEvaluation(input),
  listRewardReconciliationSnapshot: (input) => duskLedgerService.listRewardReconciliationSnapshot(input),
};

const OUTCOMES: readonly DuskRewardReconciliationOutcome[] = [
  "ELIGIBLE_NOT_CLAIMED",
  "ALREADY_RECORDED",
  "DUPLICATE_EVIDENCE",
  "CONFLICTING_CLAIM",
  "UNKNOWN_EVIDENCE",
  "SOURCE_EVIDENCE_CHANGED",
  "REVERSED_CLAIM",
  "UNRESOLVED_REVERSAL",
];

function emptyOutcomeCounts(): Record<DuskRewardReconciliationOutcome, number> {
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<DuskRewardReconciliationOutcome, number>;
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function isRepWorkSourceEventType(value: string): boolean {
  return (DUSK_REP_WORK_SOURCE_EVENT_TYPES as readonly string[]).includes(value);
}

function nonEmpty(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function isManualReview(outcome: DuskRewardReconciliationOutcome): boolean {
  return outcome !== "ELIGIBLE_NOT_CLAIMED" && outcome !== "ALREADY_RECORDED" && outcome !== "DUPLICATE_EVIDENCE";
}

function buildReconciliationEvent(
  event: DuskRepWorkRewardEvent,
  snapshot: DuskRewardReconciliationLedgerSnapshot,
): DuskRewardReconciliationEvent {
  const sourceEventId = nonEmpty(event.sourceEventId);
  const canonicalDedupeKey = nonEmpty(event.canonicalDedupeKey);
  const snapshotIncomplete = snapshot.truncated || snapshot.sourceEvents.some(
    (sourceEvent) => sourceEvent._count.claims > sourceEvent.claims.length,
  );
  const identityMissing = !sourceEventId || !canonicalDedupeKey;
  const base = {
    sourceEventType: DUSK_REP_WORK_SOURCE_EVENT_TYPE as typeof DUSK_REP_WORK_SOURCE_EVENT_TYPE,
    sourceEventId,
    canonicalDedupeKey,
    classification: event.classification,
    discordUserId: nonEmpty(event.discordUserId),
    simulationOnlyDuskits: event.simulationOnlyDuskits,
    matchedLedgerEntryId: null,
    matchedClaimId: null,
    reversalRequestId: null,
  };

  if (event.classification !== "ELIGIBLE") {
    return {
      ...base,
      outcome: event.reasonCode === "DUPLICATE_DEDUPE_KEY" ? "DUPLICATE_EVIDENCE" : "UNKNOWN_EVIDENCE",
      reasonCode: event.reasonCode === "DUPLICATE_DEDUPE_KEY" ? "DUPLICATE_DEDUPE_KEY" : event.reasonCode,
      ledgerEvidence: snapshotIncomplete ? "SNAPSHOT_TRUNCATED" : "NO_MATCHING_RECORD_OBSERVED",
    };
  }
  if (identityMissing) {
    return {
      ...base,
      outcome: "UNKNOWN_EVIDENCE",
      reasonCode: "MISSING_PERSISTED_IDENTITY",
      ledgerEvidence: snapshotIncomplete ? "SNAPSHOT_TRUNCATED" : "NO_MATCHING_RECORD_OBSERVED",
    };
  }
  if (event.sourceCorrectionStatus !== "NONE") {
    return {
      ...base,
      outcome: "SOURCE_EVIDENCE_CHANGED",
      reasonCode: "OBSERVED_SOURCE_UPDATE_NOT_PROVEN_CORRECTION",
      ledgerEvidence: snapshotIncomplete ? "SNAPSHOT_TRUNCATED" : "NO_MATCHING_RECORD_OBSERVED",
    };
  }

  const sourceEvents = snapshot.sourceEvents.filter(
    (sourceEvent) => isRepWorkSourceEventType(sourceEvent.sourceEventType) && sourceEvent.sourceEventId === sourceEventId,
  );
  const claims = sourceEvents.flatMap((sourceEvent) => sourceEvent.claims);
  const directEntries = snapshot.entries.filter(
    (entry) => isRepWorkSourceEventType(entry.sourceEventType) && entry.sourceEventId === sourceEventId,
  );
  const dedupeEntries = snapshot.entries.filter(
    (entry) => isRepWorkSourceEventType(entry.sourceEventType) && entry.idempotencyKey === canonicalDedupeKey,
  );
  const directReversalRequests = snapshot.reversalRequests.filter(
    (request) => isRepWorkSourceEventType(request.sourceEventType) && request.sourceEventId === sourceEventId,
  );

  const matchingEntry = directEntries.find(
    (entry) =>
      entry.walletId === event.discordUserId &&
      entry.transactionType === DuskLedgerTransactionType.EARNING &&
      entry.amount === event.simulationOnlyDuskits &&
      entry.beneficiaryMode === DuskLedgerBeneficiaryMode.SINGLE_RECIPIENT &&
      entry.beneficiaryKey === null &&
      entry.idempotencyKey === canonicalDedupeKey,
  );
  const matchingClaim = claims.find(
    (claim) => claim.walletId === event.discordUserId && claim.beneficiaryKey === null,
  );
  const matchingClaimEntry = matchingClaim
    ? snapshot.entries.find((entry) => entry.id === matchingClaim.ledgerEntryId)
    : null;
  const reversalEntries = matchingEntry
    ? snapshot.entries.filter((entry) => entry.reversalOfId === matchingEntry.id)
    : [];
  const reversalRequest = matchingEntry
    ? snapshot.reversalRequests.find((request) => request.originalEntryId === matchingEntry.id)
    : directReversalRequests[0];
  const hasAppliedReversal = Boolean(
    reversalEntries.length || reversalRequest?.resolution?.resolutionType === DuskReversalResolutionType.APPLIED,
  );
  const hasPendingReversal = Boolean(reversalRequest && !reversalRequest.resolution);
  const hasDeclinedReversal = reversalRequest?.resolution?.resolutionType === DuskReversalResolutionType.DECLINED;

  if (hasAppliedReversal) {
    return {
      ...base,
      outcome: "REVERSED_CLAIM",
      reasonCode: "REVERSED_LEDGER_ENTRY",
      ledgerEvidence: "MATCHED_CLAIM_AND_ENTRY",
      matchedLedgerEntryId: matchingEntry?.id ?? matchingClaimEntry?.id ?? null,
      matchedClaimId: matchingClaim?.id ?? null,
      reversalRequestId: reversalRequest?.id ?? null,
    };
  }
  if (hasPendingReversal) {
    return {
      ...base,
      outcome: "UNRESOLVED_REVERSAL",
      reasonCode: "UNRESOLVED_REVERSAL_REQUEST",
      ledgerEvidence: matchingEntry ? "MATCHED_CLAIM_AND_ENTRY" : "CONFLICTING_RECORDS",
      matchedLedgerEntryId: matchingEntry?.id ?? matchingClaimEntry?.id ?? null,
      matchedClaimId: matchingClaim?.id ?? null,
      reversalRequestId: reversalRequest?.id ?? null,
    };
  }
  if (hasDeclinedReversal) {
    return {
      ...base,
      outcome: "CONFLICTING_CLAIM",
      reasonCode: "DECLINED_REVERSAL_REVIEW",
      ledgerEvidence: "CONFLICTING_RECORDS",
      matchedLedgerEntryId: matchingEntry?.id ?? matchingClaimEntry?.id ?? null,
      matchedClaimId: matchingClaim?.id ?? null,
      reversalRequestId: reversalRequest?.id ?? null,
    };
  }
  if (matchingEntry && matchingClaim && matchingClaimEntry?.id === matchingEntry.id && directEntries.length === 1 && claims.length === 1 && dedupeEntries.length === 1) {
    return {
      ...base,
      outcome: "ALREADY_RECORDED",
      reasonCode: "MATCHING_CLAIM_AND_ENTRY",
      ledgerEvidence: "MATCHED_CLAIM_AND_ENTRY",
      matchedLedgerEntryId: matchingEntry.id,
      matchedClaimId: matchingClaim.id,
    };
  }
  if (!directEntries.length && !claims.length && !sourceEvents.length && !dedupeEntries.length && !directReversalRequests.length) {
    return {
      ...base,
      outcome: snapshotIncomplete ? "UNKNOWN_EVIDENCE" : "ELIGIBLE_NOT_CLAIMED",
      reasonCode: snapshotIncomplete ? "LEDGER_SNAPSHOT_TRUNCATED" : "NO_MATCHING_CLAIM_OBSERVED",
      ledgerEvidence: snapshotIncomplete ? "SNAPSHOT_TRUNCATED" : "NO_MATCHING_RECORD_OBSERVED",
    };
  }

  const reasonCode = claims.some((claim) => claim.walletId !== event.discordUserId)
    ? "LEDGER_WALLET_MISMATCH"
    : sourceEvents.length && !claims.length
    ? "SOURCE_EVENT_WITHOUT_CLAIM"
    : claims.length && !matchingClaimEntry
      ? "CLAIM_WITHOUT_LEDGER_ENTRY"
      : directEntries.some((entry) => entry.walletId !== event.discordUserId)
        ? "LEDGER_WALLET_MISMATCH"
        : directEntries.some((entry) => entry.idempotencyKey !== canonicalDedupeKey)
          ? "LEDGER_IDENTITY_MISMATCH"
          : directEntries.some((entry) => entry.amount !== event.simulationOnlyDuskits)
            ? "LEDGER_AMOUNT_MISMATCH"
            : claims.length > 1
              ? "MULTIPLE_CLAIMS_FOR_SOURCE"
              : "ENTRY_WITHOUT_CLAIM";
  return {
    ...base,
    outcome: "CONFLICTING_CLAIM",
    reasonCode,
    ledgerEvidence: claims.length && !matchingClaimEntry
      ? "CLAIM_WITHOUT_LEDGER_ENTRY"
      : directEntries.length && !claims.length
        ? "ENTRY_WITHOUT_CLAIM"
        : sourceEvents.length && !claims.length
          ? "SOURCE_EVENT_WITHOUT_CLAIM"
          : "CONFLICTING_RECORDS",
    matchedLedgerEntryId: matchingEntry?.id ?? matchingClaimEntry?.id ?? null,
    matchedClaimId: matchingClaim?.id ?? null,
    reversalRequestId: reversalRequest?.id ?? null,
  };
}

function buildWeeklyDiagnostics(evaluation: DuskRepWorkRewardEvaluation): DuskRewardReconciliationWeeklyDiagnostic[] {
  return evaluation.weekly.map((week) => ({
    weekStart: week.weekStart,
    eligibleRepWorkEvents: week.users.reduce((sum, user) => sum + user.eligibleEventCount, 0),
    uncappedRepWorkSimulationOnlyDuskits: week.totalUncappedSimulationOnlyDuskits,
    cappedRepWorkSimulationOnlyDuskits: week.totalCappedSimulationOnlyDuskits,
    capExceededInRepWorkOnlySimulation: week.totalUncappedSimulationOnlyDuskits > week.totalCappedSimulationOnlyDuskits,
    allSourceCapEstablished: false,
  }));
}

/** Purpose: compare read-only evaluated evidence with existing claims and ledger history. */
export function reconcileDuskRepWorkRewardPreview(
  evaluation: DuskRepWorkRewardEvaluation,
  ledgerSnapshot: DuskRewardReconciliationLedgerSnapshot,
): DuskRewardReconciliationPreview {
  const events = evaluation.events.map((event) => buildReconciliationEvent(event, ledgerSnapshot));
  const outcomeCounts = emptyOutcomeCounts();
  const reasonCounts: Record<string, number> = {};
  for (const event of events) {
    incrementCount(outcomeCounts, event.outcome);
    incrementCount(reasonCounts, event.reasonCode);
  }
  const candidates = events.filter((event) => event.outcome === "ELIGIBLE_NOT_CLAIMED");
  return {
    evaluator: evaluation.evaluator,
    reconciliation: "dusk-reward-reconciliation-preview",
    reconciliationVersion: "1",
    readOnly: true,
    amountsAreSimulationOnly: true,
    scope: evaluation.scope,
    policy: {
      ...evaluation.policy,
      capScope: "REP_WORK_ONLY_SIMULATION",
      allSourceCapEstablished: false,
    },
    summary: {
      sourceRows: evaluation.summary.sourceRows,
      previewEvents: events.length,
      eligibleNotClaimedEvents: outcomeCounts.ELIGIBLE_NOT_CLAIMED,
      alreadyRecordedEvents: outcomeCounts.ALREADY_RECORDED,
      duplicateEvidenceEvents: outcomeCounts.DUPLICATE_EVIDENCE,
      unknownEvidenceEvents: outcomeCounts.UNKNOWN_EVIDENCE,
      sourceEvidenceChangedEvents: outcomeCounts.SOURCE_EVIDENCE_CHANGED,
      conflictingClaimEvents: outcomeCounts.CONFLICTING_CLAIM,
      reversedClaimEvents: outcomeCounts.REVERSED_CLAIM,
      unresolvedReversalEvents: outcomeCounts.UNRESOLVED_REVERSAL,
      manualReviewEvents: events.filter((event) => isManualReview(event.outcome)).length,
      noMatchingRecordObserved: events.filter((event) => event.ledgerEvidence === "NO_MATCHING_RECORD_OBSERVED").length,
      candidateUncappedSimulationOnlyDuskits: candidates.reduce((sum, event) => sum + event.simulationOnlyDuskits, 0),
      evaluatedUncappedSimulationOnlyDuskits: evaluation.summary.uncappedSimulationOnlyDuskits,
      evaluatedCappedRepWorkSimulationOnlyDuskits: evaluation.summary.cappedSimulationOnlyDuskits,
      ledgerSnapshotTruncated: ledgerSnapshot.truncated,
      outcomeCounts,
      reasonCounts,
    },
    events,
    weekly: buildWeeklyDiagnostics(evaluation),
  };
}

/** Purpose: run the evaluator and reconciliation preview with bounded read-only stores. */
export async function previewDuskRepWorkRewardReconciliationFromStore(
  scope: DuskRepWorkRewardEvaluationScope,
  store: DuskRewardReconciliationPreviewStore = defaultStore,
): Promise<DuskRewardReconciliationPreview> {
  const evaluation = await evaluateDuskRepWorkRewardsFromStore(scope, {
    listEventsForEvaluation: store.listEventsForEvaluation,
  });
  const sourceEventIds = evaluation.events
    .map((event) => event.sourceEventId)
    .filter((value): value is string => Boolean(value));
  const ledgerSnapshot = await store.listRewardReconciliationSnapshot({
    sourceEventTypes: DUSK_REP_WORK_SOURCE_EVENT_TYPES,
    sourceEventIds,
    snapshotAt: scope.snapshotAt,
    limit: DUSK_REP_WORK_EVALUATION_MAX_EVENTS,
  });
  return reconcileDuskRepWorkRewardPreview(evaluation, ledgerSnapshot);
}
