import {
  type CompoWarBucketCounts,
} from "../helper/compoWarBucketCounts";
import {
  getCompoWarWeightBucket,
  type CompoWarWeightBucket,
} from "../helper/compoWarWeightBuckets";

export type CompoFillTrackedClanState = {
  clanTag: string;
  clanName: string;
  shortName?: string | null;
  memberCount: number;
  currentBucketCounts: Partial<Record<CompoWarWeightBucket, number>>;
  targetBucketCounts: Partial<Record<CompoWarWeightBucket, number>>;
};

export type CompoFillCandidate = {
  playerTag: string;
  playerName: string;
  resolvedWeight: number | null;
  resolvedWeightBucket?: CompoWarWeightBucket | null;
  currentClanTag?: string | null;
  currentClanName?: string | null;
};

export type CompoFillReasonCode =
  | "missing_weight"
  | "missing_bucket"
  | "source_member_count_below_target"
  | "source_bucket_deficit";

type CompoFillSourceKind = "untracked" | "tracked_surplus";

export type CompoFillBaseFiller = {
  playerTag: string;
  playerName: string;
  resolvedWeight: number;
  resolvedWeightBucket: CompoWarWeightBucket;
  currentClanTag: string | null;
  currentClanName: string | null;
};

export type CompoFillAvailableFiller = CompoFillBaseFiller & {
  sourceClanTag: string | null;
  sourceClanName: string | null;
  sourceKind: CompoFillSourceKind;
};

export type CompoFillUnavailableFiller = CompoFillBaseFiller & {
  sourceClanTag: string | null;
  sourceClanName: string | null;
  reasonCodes: CompoFillReasonCode[];
};

export type CompoFillExcludedFiller = {
  playerTag: string;
  playerName: string;
  resolvedWeight: number | null;
  resolvedWeightBucket: CompoWarWeightBucket | null;
  currentClanTag: string | null;
  currentClanName: string | null;
  reasonCodes: CompoFillReasonCode[];
};

export type CompoFillPlannedMove = {
  sequence: number;
  matchedBucket: CompoWarWeightBucket | null;
  filler: CompoFillAvailableFiller;
  destinationClanTag: string;
  destinationClanName: string;
  destinationShortName: string | null;
  destinationMemberCountBefore: number;
  destinationMemberCountAfter: number;
  destinationBucketCountsBefore: CompoWarBucketCounts;
  destinationBucketCountsAfter: CompoWarBucketCounts;
  sourceClanTag: string | null;
  sourceClanName: string | null;
  sourceMemberCountBefore: number | null;
  sourceMemberCountAfter: number | null;
  sourceBucketCountsBefore: CompoWarBucketCounts | null;
  sourceBucketCountsAfter: CompoWarBucketCounts | null;
};

export type CompoFillDestinationPlan = {
  clanTag: string;
  clanName: string;
  shortName: string | null;
  initialMemberCount: number;
  targetMemberCount: number;
  remainingSlots: number;
  initialBucketCounts: CompoWarBucketCounts;
  targetBucketCounts: CompoWarBucketCounts;
  plannedMoves: CompoFillPlannedMove[];
};

export type CompoFillRemainingSlot = {
  clanTag: string;
  clanName: string;
  shortName: string | null;
  remainingSlots: number;
  currentMemberCount: number;
  targetMemberCount: number;
};

export type CompoFillPlanResult = {
  destinationPlans: CompoFillDestinationPlan[];
  unavailableFillers: CompoFillUnavailableFiller[];
  excludedFillers: CompoFillExcludedFiller[];
  unusedAvailableFillers: CompoFillAvailableFiller[];
  remainingUnfilledClanSlots: CompoFillRemainingSlot[];
};

type MutableClanState = {
  clanTag: string;
  clanName: string;
  shortName: string | null;
  memberCount: number;
  currentBucketCounts: CompoWarBucketCounts;
  targetBucketCounts: CompoWarBucketCounts;
  targetMemberCount: number;
};

type NormalizedCandidate = {
  playerTag: string;
  playerName: string;
  resolvedWeight: number;
  resolvedWeightBucket: CompoWarWeightBucket;
  currentClanTag: string | null;
  currentClanName: string | null;
};

const COMPO_FILL_BUCKET_ORDER: CompoWarWeightBucket[] = [
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "TH13",
  "TH12",
  "TH11",
  "TH10",
  "TH9",
  "TH8_OR_LOWER",
];

function normalizeInteger(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function trimToNull(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function cloneBucketCounts(
  counts: Partial<Record<CompoWarWeightBucket, number>> | null | undefined,
): CompoWarBucketCounts {
  return {
    TH18: normalizeInteger(counts?.TH18),
    TH17: normalizeInteger(counts?.TH17),
    TH16: normalizeInteger(counts?.TH16),
    TH15: normalizeInteger(counts?.TH15),
    TH14: normalizeInteger(counts?.TH14),
    TH13: normalizeInteger(counts?.TH13),
    TH12: normalizeInteger(counts?.TH12),
    TH11: normalizeInteger(counts?.TH11),
    TH10: normalizeInteger(counts?.TH10),
    TH9: normalizeInteger(counts?.TH9),
    TH8_OR_LOWER: normalizeInteger(counts?.TH8_OR_LOWER),
  };
}

function sumBucketCounts(counts: CompoWarBucketCounts): number {
  return COMPO_FILL_BUCKET_ORDER.reduce((sum, bucket) => sum + counts[bucket], 0);
}

function compareBucketsByPriority(
  left: CompoWarWeightBucket,
  right: CompoWarWeightBucket,
): number {
  return COMPO_FILL_BUCKET_ORDER.indexOf(left) - COMPO_FILL_BUCKET_ORDER.indexOf(right);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function getLargestBucketDeficit(
  current: CompoWarBucketCounts,
  target: CompoWarBucketCounts,
): { bucket: CompoWarWeightBucket; deficit: number } | null {
  let best: { bucket: CompoWarWeightBucket; deficit: number } | null = null;
  for (const bucket of COMPO_FILL_BUCKET_ORDER) {
    const deficit = target[bucket] - current[bucket];
    if (deficit <= 0) {
      continue;
    }
    if (!best) {
      best = { bucket, deficit };
      continue;
    }
    if (deficit > best.deficit) {
      best = { bucket, deficit };
      continue;
    }
    if (deficit === best.deficit && compareBucketsByPriority(bucket, best.bucket) < 0) {
      best = { bucket, deficit };
    }
  }
  return best;
}

function getMemberDeficit(input: {
  memberCount: number;
  targetMemberCount: number;
}): number {
  return Math.max(0, input.targetMemberCount - input.memberCount);
}

function normalizePositiveWeight(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function buildSourceStateMap(clans: readonly MutableClanState[]): Map<string, MutableClanState> {
  return new Map(clans.map((clan) => [clan.clanTag, clan] as const));
}

function isCandidateAvailableNow(
  candidate: NormalizedCandidate,
  sourceStateByTag: Map<string, MutableClanState>,
): {
  available: boolean;
  sourceClanTag: string | null;
  sourceClanName: string | null;
  sourceKind: CompoFillSourceKind;
  reasonCodes: CompoFillReasonCode[];
} {
  const sourceClanTag = candidate.currentClanTag;
  const sourceClan = sourceClanTag ? sourceStateByTag.get(sourceClanTag) ?? null : null;

  if (!sourceClan) {
    return {
      available: true,
      sourceClanTag,
      sourceClanName: candidate.currentClanName,
      sourceKind: "untracked",
      reasonCodes: [],
    };
  }

  const reasonCodes: CompoFillReasonCode[] = [];
  const memberCountAfter = sourceClan.memberCount - 1;
  const targetMemberCount = sourceClan.targetMemberCount;
  if (memberCountAfter < targetMemberCount) {
    reasonCodes.push("source_member_count_below_target");
  }

  const bucketCountAfter = sourceClan.currentBucketCounts[candidate.resolvedWeightBucket] - 1;
  const targetBucketCount = sourceClan.targetBucketCounts[candidate.resolvedWeightBucket];
  if (bucketCountAfter < targetBucketCount) {
    reasonCodes.push("source_bucket_deficit");
  }

  return {
    available: reasonCodes.length === 0,
    sourceClanTag: sourceClan.clanTag,
    sourceClanName: sourceClan.clanName,
    sourceKind: "tracked_surplus",
    reasonCodes,
  };
}

function selectBestCandidateForDestination(input: {
  destination: MutableClanState;
  candidates: readonly NormalizedCandidate[];
  sourceStateByTag: Map<string, MutableClanState>;
  usedPlayerTags: Set<string>;
}): {
  candidate: NormalizedCandidate;
  sourceClanTag: string | null;
  sourceClanName: string | null;
  sourceKind: CompoFillSourceKind;
  matchedBucket: CompoWarWeightBucket | null;
} | null {
  const availableCandidates = input.candidates.filter((candidate) => {
    if (input.usedPlayerTags.has(candidate.playerTag)) {
      return false;
    }
    return isCandidateAvailableNow(candidate, input.sourceStateByTag).available;
  });

  if (availableCandidates.length === 0) {
    return null;
  }

  const bucketDeficits = COMPO_FILL_BUCKET_ORDER
    .map((bucket) => ({
      bucket,
      deficit: input.destination.targetBucketCounts[bucket] - input.destination.currentBucketCounts[bucket],
    }))
    .filter((entry) => entry.deficit > 0)
    .sort((left, right) => {
      if (left.deficit !== right.deficit) {
        return right.deficit - left.deficit;
      }
      return compareBucketsByPriority(left.bucket, right.bucket);
    });

  const evaluatePool = (
    pool: readonly NormalizedCandidate[],
    matchedBucket: CompoWarWeightBucket | null,
  ) => {
    const sorted = [...pool].sort((left, right) => {
      const leftSource = isCandidateAvailableNow(left, input.sourceStateByTag);
      const rightSource = isCandidateAvailableNow(right, input.sourceStateByTag);
      if (leftSource.sourceKind !== rightSource.sourceKind) {
        return leftSource.sourceKind === "untracked" ? -1 : 1;
      }
      if (left.resolvedWeight !== right.resolvedWeight) {
        return right.resolvedWeight - left.resolvedWeight;
      }
      const leftClanName = leftSource.sourceClanName ?? left.currentClanName ?? "";
      const rightClanName = rightSource.sourceClanName ?? right.currentClanName ?? "";
      if (leftClanName !== rightClanName) {
        return compareStrings(leftClanName, rightClanName);
      }
      if (left.playerName !== right.playerName) {
        return compareStrings(left.playerName, right.playerName);
      }
      return compareStrings(left.playerTag, right.playerTag);
    });

    const selected = sorted[0];
    if (!selected) {
      return null;
    }
    const source = isCandidateAvailableNow(selected, input.sourceStateByTag);
    return {
      candidate: selected,
      sourceClanTag: source.sourceClanTag,
      sourceClanName: source.sourceClanName,
      sourceKind: source.sourceKind,
      matchedBucket,
    };
  };

  for (const deficit of bucketDeficits) {
    const pool = availableCandidates.filter(
      (candidate) => candidate.resolvedWeightBucket === deficit.bucket,
    );
    const selection = evaluatePool(pool, deficit.bucket);
    if (selection) {
      return selection;
    }
  }

  return evaluatePool(availableCandidates, null);
}

function buildAvailableFiller(
  candidate: NormalizedCandidate,
  availability: ReturnType<typeof isCandidateAvailableNow>,
): CompoFillAvailableFiller {
  return {
    playerTag: candidate.playerTag,
    playerName: candidate.playerName,
    resolvedWeight: candidate.resolvedWeight,
    resolvedWeightBucket: candidate.resolvedWeightBucket,
    currentClanTag: candidate.currentClanTag,
    currentClanName: candidate.currentClanName,
    sourceClanTag: availability.sourceClanTag,
    sourceClanName: availability.sourceClanName,
    sourceKind: availability.sourceKind,
  };
}

function buildBaseFiller(
  candidate: NormalizedCandidate,
): CompoFillBaseFiller {
  return {
    playerTag: candidate.playerTag,
    playerName: candidate.playerName,
    resolvedWeight: candidate.resolvedWeight,
    resolvedWeightBucket: candidate.resolvedWeightBucket,
    currentClanTag: candidate.currentClanTag,
    currentClanName: candidate.currentClanName,
  };
}

function buildMoveForSelection(input: {
  sequence: number;
  destination: MutableClanState;
  sourceClanTag: string | null;
  sourceClanName: string | null;
  sourceMemberCountBefore: number | null;
  sourceBucketCountsBefore: CompoWarBucketCounts | null;
  candidate: NormalizedCandidate;
  matchedBucket: CompoWarWeightBucket | null;
}): CompoFillPlannedMove {
  const fillerAvailability = buildAvailableFiller(
    input.candidate,
    {
      available: true,
      sourceClanTag: input.sourceClanTag,
      sourceClanName: input.sourceClanName,
      sourceKind: input.sourceClanTag ? "tracked_surplus" : "untracked",
      reasonCodes: [],
    },
  );

  return {
    sequence: input.sequence,
    matchedBucket: input.matchedBucket,
    filler: fillerAvailability,
    destinationClanTag: input.destination.clanTag,
    destinationClanName: input.destination.clanName,
    destinationShortName: input.destination.shortName,
    destinationMemberCountBefore: input.destination.memberCount,
    destinationMemberCountAfter: input.destination.memberCount + 1,
    destinationBucketCountsBefore: cloneBucketCounts(input.destination.currentBucketCounts),
    destinationBucketCountsAfter: cloneBucketCounts(input.destination.currentBucketCounts),
    sourceClanTag: input.sourceClanTag,
    sourceClanName: input.sourceClanName,
    sourceMemberCountBefore: input.sourceMemberCountBefore,
    sourceMemberCountAfter:
      input.sourceMemberCountBefore === null ? null : input.sourceMemberCountBefore - 1,
    sourceBucketCountsBefore: input.sourceBucketCountsBefore
      ? cloneBucketCounts(input.sourceBucketCountsBefore)
      : null,
    sourceBucketCountsAfter: input.sourceBucketCountsBefore
      ? cloneBucketCounts(input.sourceBucketCountsBefore)
      : null,
  };
}

/** Purpose: plan compo fillers using only plain tracked-clan and filler data. */
export function buildCompoFillPlan(input: {
  trackedClans: readonly CompoFillTrackedClanState[];
  fillers: readonly CompoFillCandidate[];
}): CompoFillPlanResult {
  const trackedStates: MutableClanState[] = input.trackedClans.map((clan) => {
    const currentBucketCounts = cloneBucketCounts(clan.currentBucketCounts);
    const targetBucketCounts = cloneBucketCounts(clan.targetBucketCounts);
    return {
      clanTag: String(clan.clanTag ?? "").trim(),
      clanName: String(clan.clanName ?? "").trim(),
      shortName: trimToNull(clan.shortName),
      memberCount: normalizeInteger(clan.memberCount),
      currentBucketCounts,
      targetBucketCounts,
      targetMemberCount: sumBucketCounts(targetBucketCounts),
    };
  });

  const destinationPlanOrder: CompoFillDestinationPlan[] = [];

  for (const clan of trackedStates) {
    const remainingSlots = getMemberDeficit({
      memberCount: clan.memberCount,
      targetMemberCount: clan.targetMemberCount,
    });
    if (remainingSlots <= 0) {
      continue;
    }
    const plan: CompoFillDestinationPlan = {
      clanTag: clan.clanTag,
      clanName: clan.clanName,
      shortName: clan.shortName,
      initialMemberCount: clan.memberCount,
      targetMemberCount: clan.targetMemberCount,
      remainingSlots,
      initialBucketCounts: cloneBucketCounts(clan.currentBucketCounts),
      targetBucketCounts: cloneBucketCounts(clan.targetBucketCounts),
      plannedMoves: [],
    };
    destinationPlanOrder.push(plan);
  }

  destinationPlanOrder.sort((left, right) => {
    const leftDeficit = left.remainingSlots;
    const rightDeficit = right.remainingSlots;
    if (leftDeficit !== rightDeficit) {
      return rightDeficit - leftDeficit;
    }

    const leftBucket = getLargestBucketDeficit(
      cloneBucketCounts(left.initialBucketCounts),
      cloneBucketCounts(left.targetBucketCounts),
    );
    const rightBucket = getLargestBucketDeficit(
      cloneBucketCounts(right.initialBucketCounts),
      cloneBucketCounts(right.targetBucketCounts),
    );
    const leftBucketDeficit = leftBucket?.deficit ?? 0;
    const rightBucketDeficit = rightBucket?.deficit ?? 0;
    if (leftBucketDeficit !== rightBucketDeficit) {
      return rightBucketDeficit - leftBucketDeficit;
    }
    const leftBucketName = leftBucket?.bucket ?? "";
    const rightBucketName = rightBucket?.bucket ?? "";
    if (leftBucketName !== rightBucketName) {
      return compareStrings(leftBucketName, rightBucketName);
    }
    if (left.clanName !== right.clanName) {
      return compareStrings(left.clanName, right.clanName);
    }
    return compareStrings(left.clanTag, right.clanTag);
  });

  const normalizedCandidates: NormalizedCandidate[] = [];
  const excludedFillers: CompoFillExcludedFiller[] = [];
  for (const candidate of input.fillers) {
    const resolvedWeight = normalizePositiveWeight(candidate.resolvedWeight);
    const playerTag = String(candidate.playerTag ?? "").trim();
    const playerName = String(candidate.playerName ?? "").trim() || playerTag;
    const currentClanTag = trimToNull(candidate.currentClanTag);
    const currentClanName = trimToNull(candidate.currentClanName);

    if (resolvedWeight === null) {
      excludedFillers.push({
        playerTag,
        playerName,
        resolvedWeight: null,
        resolvedWeightBucket: null,
        currentClanTag,
        currentClanName,
        reasonCodes: ["missing_weight"],
      });
      continue;
    }

    const resolvedWeightBucket = getCompoWarWeightBucket(resolvedWeight);
    if (!resolvedWeightBucket) {
      excludedFillers.push({
        playerTag,
        playerName,
        resolvedWeight,
        resolvedWeightBucket: null,
        currentClanTag,
        currentClanName,
        reasonCodes: ["missing_bucket"],
      });
      continue;
    }

    normalizedCandidates.push({
      playerTag,
      playerName,
      resolvedWeight,
      resolvedWeightBucket,
      currentClanTag,
      currentClanName,
    });
  }

  const sourceStateByTag = buildSourceStateMap(trackedStates);
  const usedPlayerTags = new Set<string>();
  let sequence = 1;

  while (
    usedPlayerTags.size < normalizedCandidates.length &&
    destinationPlanOrder.some((plan) => plan.remainingSlots > 0)
  ) {
    let selectedPlan: CompoFillDestinationPlan | null = null;
    let selectedCandidate: NormalizedCandidate | null = null;
    let selectedSourceTag: string | null = null;
    let selectedSourceName: string | null = null;
    let selectedMatchedBucket: CompoWarWeightBucket | null = null;
    let selectedSourceKind: CompoFillSourceKind = "untracked";

    for (const plan of destinationPlanOrder) {
      if (plan.remainingSlots <= 0) {
        continue;
      }

      const destinationState = trackedStates.find((clan) => clan.clanTag === plan.clanTag);
      if (!destinationState) {
        continue;
      }

      const selection = selectBestCandidateForDestination({
        destination: destinationState,
        candidates: normalizedCandidates,
        sourceStateByTag,
        usedPlayerTags,
      });
      if (!selection) {
        continue;
      }

      selectedPlan = plan;
      selectedCandidate = selection.candidate;
      selectedSourceTag = selection.sourceClanTag;
      selectedSourceName = selection.sourceClanName;
      selectedMatchedBucket = selection.matchedBucket;
      selectedSourceKind = selection.sourceKind;
      break;
    }

    if (!selectedPlan || !selectedCandidate) {
      break;
    }

    const destinationState = trackedStates.find((clan) => clan.clanTag === selectedPlan.clanTag);
    if (!destinationState) {
      break;
    }

    const sourceState =
      selectedSourceTag && sourceStateByTag.has(selectedSourceTag)
        ? sourceStateByTag.get(selectedSourceTag) ?? null
        : null;

    const move = buildMoveForSelection({
      sequence,
      destination: destinationState,
      sourceClanTag: selectedSourceTag,
      sourceClanName: selectedSourceName,
      sourceMemberCountBefore: sourceState ? sourceState.memberCount : null,
      sourceBucketCountsBefore: sourceState
        ? cloneBucketCounts(sourceState.currentBucketCounts)
        : null,
      candidate: selectedCandidate,
      matchedBucket: selectedMatchedBucket,
    });
    move.filler.sourceKind = selectedSourceKind;
    selectedPlan.plannedMoves.push(move);
    usedPlayerTags.add(selectedCandidate.playerTag);

    destinationState.memberCount += 1;
    if (selectedMatchedBucket) {
      destinationState.currentBucketCounts[selectedMatchedBucket] += 1;
    }
    selectedPlan.remainingSlots = getMemberDeficit({
      memberCount: destinationState.memberCount,
      targetMemberCount: destinationState.targetMemberCount,
    });

    if (sourceState) {
      sourceState.memberCount -= 1;
      sourceState.currentBucketCounts[selectedCandidate.resolvedWeightBucket] -= 1;
    }

    move.destinationMemberCountAfter = destinationState.memberCount;
    move.destinationBucketCountsAfter = cloneBucketCounts(destinationState.currentBucketCounts);
    if (sourceState) {
      move.sourceMemberCountAfter = sourceState.memberCount;
      move.sourceBucketCountsAfter = cloneBucketCounts(sourceState.currentBucketCounts);
    }

    sequence += 1;
  }

  const unusedAvailableFillers: CompoFillAvailableFiller[] = [];
  const unavailableFillers: CompoFillUnavailableFiller[] = [];

  for (const candidate of normalizedCandidates) {
    if (usedPlayerTags.has(candidate.playerTag)) {
      continue;
    }

    const availability = isCandidateAvailableNow(candidate, sourceStateByTag);
    if (availability.available) {
      unusedAvailableFillers.push(buildAvailableFiller(candidate, availability));
      continue;
    }

    unavailableFillers.push({
      ...buildBaseFiller(candidate),
      sourceClanTag: availability.sourceClanTag,
      sourceClanName: availability.sourceClanName,
      reasonCodes: availability.reasonCodes,
    });
  }

  const remainingUnfilledClanSlots: CompoFillRemainingSlot[] = destinationPlanOrder
    .filter((plan) => plan.remainingSlots > 0)
    .map((plan) => ({
      clanTag: plan.clanTag,
      clanName: plan.clanName,
      shortName: plan.shortName,
      remainingSlots: plan.remainingSlots,
      currentMemberCount: plan.initialMemberCount + plan.plannedMoves.length,
      targetMemberCount: plan.targetMemberCount,
    }));

  return {
    destinationPlans: destinationPlanOrder,
    unavailableFillers,
    excludedFillers,
    unusedAvailableFillers,
    remainingUnfilledClanSlots,
  };
}

export const buildCompoFillPlanForTest = buildCompoFillPlan;
export const getLargestBucketDeficitForTest = getLargestBucketDeficit;
