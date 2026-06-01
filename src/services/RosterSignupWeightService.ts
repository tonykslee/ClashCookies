import { normalizePlayerTag } from "./PlayerLinkService";
import {
  resolveRosterCurrentWeightRecords,
  type ResolvedRosterCurrentWeightRecord,
  type RosterWeightSource,
} from "./RosterWeightService";

export type RosterSignupWeightGateStatus = "eligible" | "below_minimum" | "unavailable";

export type RosterSignupWeightGateRecord = ResolvedRosterCurrentWeightRecord & {
  minimumWeight: number;
  status: RosterSignupWeightGateStatus;
};

function normalizeRosterMinimumWeight(input: number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function loadRosterSignupMinimumWeightLookup(input: {
  playerTags: string[];
  minimumWeight: number | null | undefined;
}): Promise<Map<string, RosterSignupWeightGateRecord>> {
  const minimumWeight = normalizeRosterMinimumWeight(input.minimumWeight);
  const normalizedTags = [...new Set((input.playerTags ?? []).map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  if (normalizedTags.length <= 0 || minimumWeight === null) {
    return new Map();
  }

  const resolvedWeights = await resolveRosterCurrentWeightRecords({
    playerTags: normalizedTags,
  });
  const result = new Map<string, RosterSignupWeightGateRecord>();
  for (const playerTag of normalizedTags) {
    const weightRecord = resolvedWeights.get(playerTag) ?? {
      playerTag,
      weight: null,
      weightSource: "Unknown" as RosterWeightSource,
      weightMeasuredAt: null,
      trophies: null,
    };
    const status: RosterSignupWeightGateStatus =
      weightRecord.weight === null
        ? "unavailable"
        : weightRecord.weight < minimumWeight
          ? "below_minimum"
          : "eligible";
    result.set(playerTag, {
      ...weightRecord,
      minimumWeight,
      status,
    });
  }

  return result;
}

export function formatRosterSignupWeightGateDescription(record: {
  weight: number | null;
  status: RosterSignupWeightGateStatus;
}): string {
  if (record.status === "eligible") {
    return "available";
  }
  if (record.status === "below_minimum") {
    return "⚠️ below minimum weight";
  }
  if (record.weight === null) {
    return "⚠️ weight unavailable";
  }
  return "⚠️ below minimum weight";
}
