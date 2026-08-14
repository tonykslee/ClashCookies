import { normalizeClashTagWithHash } from "../helper/clashTag";
import type { CoCService } from "./CoCService";
import type { AllianceClanRosterObservation } from "./AllianceClanMembershipIntervalService";

const normalizeClanTag = normalizeClashTagWithHash;
const normalizePlayerTag = normalizeClashTagWithHash;

export type CwlOnlyRosterObservationResult = {
  rosters: AllianceClanRosterObservation[];
  attemptedFetches: number;
  failedClanTags: string[];
};

/** Purpose: collect only the lightweight CWL-only roster facts needed by interval history. */
export async function observeCwlOnlyClanRosters(input: {
  cwlClanTags: string[];
  alreadyObservedClanTags: string[];
  cocService: Pick<CoCService, "getClan">;
}): Promise<CwlOnlyRosterObservationResult> {
  const alreadyObserved = new Set(
    input.alreadyObservedClanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean),
  );
  const cwlOnlyTags = [...new Set(
    input.cwlClanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean),
  )].filter((tag) => !alreadyObserved.has(tag));
  const rosters: AllianceClanRosterObservation[] = [];
  const failedClanTags: string[] = [];

  for (const clanTag of cwlOnlyTags) {
    try {
      const clan = await input.cocService.getClan(clanTag);
      rosters.push({
        clanTag: normalizeClanTag(String(clan?.tag ?? clanTag)) || clanTag,
        playerTags: (Array.isArray(clan?.members) ? clan.members : [])
          .map((member: any) => normalizePlayerTag(String(member?.tag ?? "")))
          .filter(Boolean),
      });
    } catch (error) {
      failedClanTags.push(clanTag);
      console.warn(
        `[alliance-membership-history] cwl_only_clan_fetch_failed clan_tag=${clanTag} error=${formatError(error)}`,
      );
    }
  }

  return {
    rosters,
    attemptedFetches: cwlOnlyTags.length,
    failedClanTags,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
