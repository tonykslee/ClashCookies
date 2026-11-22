import {
  type CompoWarBucketCounts,
} from "../helper/compoWarBucketCounts";
import {
  getCompoWarWeightBucket,
  type CompoWarWeightBucket,
} from "../helper/compoWarWeightBuckets";
import {
  getCompoCalculationBucket,
  LEGACY_COMPO_CALCULATION_PROFILE,
  type CompoCalculationProfile,
} from "../helper/compoCalculationProfile";

export type CompoFillTrackedClanState = {
  clanTag: string;
  clanName: string;
  shortName?: string | null;
  memberCount: number;
  currentBucketCounts: Partial<Record<CompoWarWeightBucket, number>>;
  /** Target counts are null when the selected reference is not validated for this clan. */
  targetBucketCounts: Partial<Record<CompoWarWeightBucket, number>> | null;
  targetEvidence: "validated" | "unavailable";
  targetEvidenceReason?:
    | "reference_unavailable"
    | "no_selected_reference"
    | "th19_integrity"
    | "actual_roster_incomplete"
    | "actual_roster_inconsistent";
  /** Deprecated v1 compatibility input; target support is profile-derived. */
  targetSupportsTh19?: boolean;
  /** When supplied, this is the authoritative per-account ACTUAL evidence for source removal. */
  memberEvidence?: readonly CompoFillMemberEvidence[];
};

export type CompoFillMemberEvidence = {
  playerTag: string;
  resolvedWeight: number | null;
  resolvedWeightBucket: CompoWarWeightBucket | null;
};

export type CompoFillCandidate = {
  playerTag: string;
  playerName: string;
  resolvedWeight: number | null;
  resolvedWeightBucket?: CompoWarWeightBucket | null;
  currentClanTag?: string | null;
  currentClanName?: string | null;
  clanState: "known" | "no_clan" | "unknown";
};

export type CompoFillReasonCode =
  | "missing_weight"
  | "missing_bucket"
  | "source_member_count_below_target"
  | "source_bucket_deficit"
  | "source_context_unavailable"
  | "source_target_evidence_unavailable"
  | "source_bucket_evidence_mismatch"
  | "self_transfer"
  | "source_membership_unknown"
  | "source_membership_inconsistent";

type CompoFillSourceKind = "untracked" | "tracked_surplus";

export type CompoFillBaseFiller = {
  playerTag: string;
  playerName: string;
  resolvedWeight: number;
  resolvedWeightBucket: CompoWarWeightBucket;
  currentClanTag: string | null;
  currentClanName: string | null;
  clanState: "known" | "no_clan" | "unknown";
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
  clanState: "known" | "no_clan" | "unknown";
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
  targetEvidence: "validated" | "unavailable";
  memberEvidenceByTag: Map<string, CompoFillMemberEvidence> | null;
  targetMemberCount: number;
};

type NormalizedCandidate = {
  playerTag: string;
  playerName: string;
  resolvedWeight: number;
  resolvedWeightBucket: CompoWarWeightBucket;
  currentClanTag: string | null;
  currentClanName: string | null;
  clanState: "known" | "no_clan" | "unknown";
};

const COMPO_FILL_BUCKET_ORDER: CompoWarWeightBucket[] = LEGACY_COMPO_CALCULATION_PROFILE.buckets.flatMap(
  (bucket) => bucket.sourceBucketIds,
) as CompoWarWeightBucket[];

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
  const result: CompoWarBucketCounts = {
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
  const th19 = normalizeInteger(counts?.TH19);
  if (th19 > 0) result.TH19 = th19;
  return result;
}

function sumBucketCounts(counts: CompoWarBucketCounts): number {
  return COMPO_FILL_BUCKET_ORDER.reduce((sum, bucket) => sum + (counts[bucket] ?? 0), 0);
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
    const deficit = (target[bucket] ?? 0) - (current[bucket] ?? 0);
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
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    return null;
  }
  return value >= 0 ? value : null;
}

function normalizeIdentity(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/^#+/, "").toUpperCase();
}

function safeCount(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function setBucketCount(
  counts: CompoWarBucketCounts,
  bucket: CompoWarWeightBucket,
  value: number,
): void {
  counts[bucket] = safeCount(value);
}

function buildSourceStateMap(clans: readonly MutableClanState[]): Map<string, MutableClanState> {
  return new Map(clans.map((clan) => [normalizeIdentity(clan.clanTag), clan] as const));
}

function isCandidateAvailableNow(
  candidate: NormalizedCandidate,
  sourceStateByTag: Map<string, MutableClanState>,
  knownTrackedClanTags?: ReadonlySet<string>,
  destinationClanTag?: string,
  profile: CompoCalculationProfile = LEGACY_COMPO_CALCULATION_PROFILE,
): {
  available: boolean;
  sourceClanTag: string | null;
  sourceClanName: string | null;
  sourceKind: CompoFillSourceKind;
  reasonCodes: CompoFillReasonCode[];
} {
  const sourceClanTag = candidate.currentClanTag;

  if (candidate.clanState === "unknown") {
    return {
      available: false,
      sourceClanTag,
      sourceClanName: candidate.currentClanName,
      sourceKind: "untracked",
      reasonCodes: ["source_membership_unknown"],
    };
  }

  if (candidate.clanState === "known" && !sourceClanTag) {
    return {
      available: false,
      sourceClanTag,
      sourceClanName: candidate.currentClanName,
      sourceKind: "untracked",
      reasonCodes: ["source_membership_inconsistent"],
    };
  }

  const sourceClan = sourceClanTag
    ? sourceStateByTag.get(normalizeIdentity(sourceClanTag)) ?? null
    : null;

  if (!sourceClan) {
    if (sourceClanTag && knownTrackedClanTags?.has(normalizeIdentity(sourceClanTag))) {
      return {
        available: false,
        sourceClanTag,
        sourceClanName: candidate.currentClanName,
        sourceKind: "tracked_surplus",
        reasonCodes: ["source_context_unavailable"],
      };
    }
    return {
      available: true,
      sourceClanTag,
      sourceClanName: candidate.currentClanName,
      sourceKind: "untracked",
      reasonCodes: [],
    };
  }

  const reasonCodes: CompoFillReasonCode[] = [];
  if (destinationClanTag && normalizeIdentity(sourceClan.clanTag) === normalizeIdentity(destinationClanTag)) {
    reasonCodes.push("self_transfer");
  }
  if (sourceClan.targetEvidence !== "validated") {
    reasonCodes.push("source_target_evidence_unavailable");
  }
  if (!getCompoCalculationBucket(profile, candidate.resolvedWeightBucket)) {
    if (!reasonCodes.includes("source_target_evidence_unavailable")) {
      reasonCodes.push("source_target_evidence_unavailable");
    }
  }
  if (sourceClan.memberEvidenceByTag) {
    const evidence = sourceClan.memberEvidenceByTag.get(normalizeIdentity(candidate.playerTag));
    if (
      !evidence ||
      evidence.resolvedWeight !== candidate.resolvedWeight ||
      evidence.resolvedWeightBucket !== candidate.resolvedWeightBucket
    ) {
      reasonCodes.push("source_bucket_evidence_mismatch");
    }
  }
  const memberCountAfter = sourceClan.memberCount - 1;
  const targetMemberCount = sourceClan.targetMemberCount;
  if (memberCountAfter < targetMemberCount) {
    reasonCodes.push("source_member_count_below_target");
  }

  const bucketCountAfter = (sourceClan.currentBucketCounts[candidate.resolvedWeightBucket] ?? 0) - 1;
  const targetBucketCount = sourceClan.targetBucketCounts[candidate.resolvedWeightBucket] ?? 0;
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
  knownTrackedClanTags: ReadonlySet<string>;
  usedPlayerTags: Set<string>;
  profile: CompoCalculationProfile;
}): {
  candidate: NormalizedCandidate;
  sourceClanTag: string | null;
  sourceClanName: string | null;
  sourceKind: CompoFillSourceKind;
  matchedBucket: CompoWarWeightBucket | null;
} | null {
  const availableCandidates = input.candidates.filter((candidate) => {
    if (input.usedPlayerTags.has(normalizeIdentity(candidate.playerTag))) {
      return false;
    }
    if (!getCompoCalculationBucket(input.profile, candidate.resolvedWeightBucket)) {
      return false;
    }
    return isCandidateAvailableNow(
      candidate,
      input.sourceStateByTag,
      input.knownTrackedClanTags,
      input.destination.clanTag,
      input.profile,
    ).available;
  });

  if (availableCandidates.length === 0) {
    return null;
  }

  const bucketDeficits = COMPO_FILL_BUCKET_ORDER
    .map((bucket) => ({
      bucket,
      deficit:
        (input.destination.targetBucketCounts[bucket] ?? 0) -
        (input.destination.currentBucketCounts[bucket] ?? 0),
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
      const leftSource = isCandidateAvailableNow(
        left,
        input.sourceStateByTag,
        input.knownTrackedClanTags,
        input.destination.clanTag,
        input.profile,
      );
      const rightSource = isCandidateAvailableNow(
        right,
        input.sourceStateByTag,
        input.knownTrackedClanTags,
        input.destination.clanTag,
        input.profile,
      );
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
    const source = isCandidateAvailableNow(
      selected,
      input.sourceStateByTag,
      input.knownTrackedClanTags,
      input.destination.clanTag,
      input.profile,
    );
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
    clanState: candidate.clanState,
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
    clanState: candidate.clanState,
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
  trackedClanTags?: readonly string[];
  profile?: CompoCalculationProfile;
}): CompoFillPlanResult {
  const profile = input.profile ?? LEGACY_COMPO_CALCULATION_PROFILE;
  const trackedStates: MutableClanState[] = input.trackedClans.map((clan) => {
    const currentBucketCounts = cloneBucketCounts(clan.currentBucketCounts);
    const targetBucketCounts = cloneBucketCounts(clan.targetBucketCounts);
    const memberEvidenceByTag = clan.memberEvidence
      ? new Map(
          clan.memberEvidence
            .map((member) => [normalizeIdentity(member.playerTag), member] as const)
            .filter(([tag]) => Boolean(tag)),
        )
      : null;
    return {
      clanTag: String(clan.clanTag ?? "").trim(),
      clanName: String(clan.clanName ?? "").trim(),
      shortName: trimToNull(clan.shortName),
      memberCount: normalizeInteger(clan.memberCount),
      currentBucketCounts,
      targetBucketCounts,
      targetEvidence: clan.targetEvidence,
      memberEvidenceByTag,
      targetMemberCount:
        clan.targetEvidence === "validated" ? sumBucketCounts(targetBucketCounts) : 0,
    };
  });
  const knownTrackedClanTags = new Set(
    (input.trackedClanTags ?? trackedStates.map((clan) => clan.clanTag)).map(normalizeIdentity),
  );

  const destinationPlanOrder: CompoFillDestinationPlan[] = [];

  for (const clan of trackedStates) {
    const remainingSlots = getMemberDeficit({
      memberCount: clan.memberCount,
      targetMemberCount: clan.targetMemberCount,
    });
    if (clan.targetEvidence !== "validated" || remainingSlots <= 0) {
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
    const clanState = candidate.clanState;

    if (resolvedWeight === null) {
      excludedFillers.push({
        playerTag,
        playerName,
        resolvedWeight: null,
        resolvedWeightBucket: null,
        currentClanTag,
        currentClanName,
        clanState,
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
        clanState,
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
      clanState,
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
        knownTrackedClanTags,
        usedPlayerTags,
        profile,
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
      selectedSourceTag && sourceStateByTag.has(normalizeIdentity(selectedSourceTag))
        ? sourceStateByTag.get(normalizeIdentity(selectedSourceTag)) ?? null
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
    usedPlayerTags.add(normalizeIdentity(selectedCandidate.playerTag));

    destinationState.memberCount = safeCount(destinationState.memberCount + 1);
    setBucketCount(
      destinationState.currentBucketCounts,
      selectedCandidate.resolvedWeightBucket,
      safeCount(destinationState.currentBucketCounts[selectedCandidate.resolvedWeightBucket]) + 1,
    );
    selectedPlan.remainingSlots = getMemberDeficit({
      memberCount: destinationState.memberCount,
      targetMemberCount: destinationState.targetMemberCount,
    });

    if (sourceState) {
      sourceState.memberCount = Math.max(0, safeCount(sourceState.memberCount) - 1);
      setBucketCount(
        sourceState.currentBucketCounts,
        selectedCandidate.resolvedWeightBucket,
        Math.max(
          0,
          safeCount(sourceState.currentBucketCounts[selectedCandidate.resolvedWeightBucket]) - 1,
        ),
      );
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
    if (usedPlayerTags.has(normalizeIdentity(candidate.playerTag))) {
      continue;
    }

    const availability = isCandidateAvailableNow(
      candidate,
      sourceStateByTag,
      knownTrackedClanTags,
      undefined,
      profile,
    );
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

  const remainingUnfilledClanSlots: CompoFillRemainingSlot[] = [
    ...destinationPlanOrder
      .filter((plan) => plan.remainingSlots > 0)
      .map((plan) => ({
        clanTag: plan.clanTag,
        clanName: plan.clanName,
        shortName: plan.shortName,
        remainingSlots: plan.remainingSlots,
        currentMemberCount: plan.initialMemberCount + plan.plannedMoves.length,
        targetMemberCount: plan.targetMemberCount,
      })),
    ...trackedStates
      .filter((clan) => clan.targetEvidence !== "validated")
      .map((clan) => ({
        clanTag: clan.clanTag,
        clanName: clan.clanName,
        shortName: clan.shortName,
        remainingSlots: Math.max(0, 50 - safeCount(clan.memberCount)),
        currentMemberCount: safeCount(clan.memberCount),
        // This is the factual clan capacity, not a fabricated composition target.
        targetMemberCount: 50,
      })),
  ];

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
