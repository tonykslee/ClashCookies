import {
  type CompoActualStateClanContext,
} from "../services/CompoActualStateService";
import {
  type CompoWarBucketCounts,
} from "./compoWarBucketCounts";
import { getCompoWarWeightBucket } from "./compoWarWeightBuckets";

export type CompoActualRosterEvidenceStatus =
  | "complete"
  | "actual_roster_incomplete"
  | "actual_roster_inconsistent";

function sumBucketCounts(counts: CompoWarBucketCounts): number {
  return Object.values(counts).reduce((sum, count) => {
    return sum + (Number.isFinite(count) && count >= 0 ? count : 0);
  }, 0);
}

/**
 * Assess only persisted ACTUAL roster evidence. This intentionally does not
 * decide whether a reference is safe to use; callers own that separate gate.
 */
export function assessCompoActualRosterEvidence(input: {
  clan: CompoActualStateClanContext;
}): CompoActualRosterEvidenceStatus {
  const { base, members } = input.clan;
  const memberCount = base.memberCount;
  const bucketCountTotal = sumBucketCounts(base.bucketCounts);
  const memberTags = members.map((member) => String(member.playerTag ?? "").trim().toUpperCase());
  const hasDuplicateOrMissingMemberTags =
    memberTags.some((tag) => !tag) || new Set(memberTags).size !== memberTags.length;
  const memberCountIsCoherent =
    Number.isInteger(memberCount) &&
    memberCount >= 0 &&
    members.length === memberCount &&
    bucketCountTotal === memberCount &&
    !hasDuplicateOrMissingMemberTags;

  // An absent persisted roster is not proof that the clan is empty. Keep the
  // factual row, but do not authorize target-derived work or 50 vacancies.
  if (memberCount === 0 && members.length === 0 && base.memberCountEvidence !== "observed") {
    return "actual_roster_incomplete";
  }
  if (base.rosterCoverage && base.rosterCoverage !== "complete") {
    return "actual_roster_incomplete";
  }

  const bucketCountsMatchMembers = members.reduce<CompoWarBucketCounts | null>(
    (counts, member) => {
      const bucket = getCompoWarWeightBucket(member.resolvedWeight);
      if (
        !counts ||
        !bucket ||
        member.resolvedBucket !== bucket ||
        member.resolvedWeightSource === null ||
        // PlayerCurrent and WAR fallbacks are lower-confidence evidence; they
        // cannot authorize target-derived placement or replacement advice.
        member.resolvedWeightSource === "current" ||
        member.resolvedWeightSource === "war"
      ) {
        return null;
      }
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      return counts;
    }, {
      TH18: 0,
      TH17: 0,
      TH16: 0,
      TH15: 0,
      TH14: 0,
      TH13: 0,
      TH12: 0,
      TH11: 0,
      TH10: 0,
      TH9: 0,
      TH8_OR_LOWER: 0,
    },
  );

  if (!memberCountIsCoherent) {
    return members.length < memberCount || base.unresolvedWeightCount > 0
      ? "actual_roster_incomplete"
      : "actual_roster_inconsistent";
  }
  if (
    base.unresolvedWeightCount > 0 ||
    !bucketCountsMatchMembers ||
    Object.entries(base.bucketCounts).some(([bucket, count]) => {
      return count !== (bucketCountsMatchMembers[bucket as keyof CompoWarBucketCounts] ?? 0);
    })
  ) {
    return "actual_roster_incomplete";
  }
  return "complete";
}

export function hasCompoActualRosterCountEvidence(
  clan: CompoActualStateClanContext,
): boolean {
  // The sync-state-backed coverage gate is authoritative in production. The
  // legacy memberCountEvidence fallback keeps pure P1 fixtures compatible;
  // runtime contexts always populate rosterCoverage from CLAN_MEMBERS state.
  return clan.base.rosterCoverage
    ? clan.base.rosterCoverage === "complete"
    : clan.base.memberCountEvidence === "observed";
}
