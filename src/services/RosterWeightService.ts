import { prisma } from "../prisma";
import { playerCurrentService } from "./PlayerCurrentService";
import {
  formatPendingAge,
  listOpenDeferredWeightRowsByClanAndPlayerTags,
} from "./WeightInputDefermentService";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";
import { resolveEffectivePlayerWeight } from "../helper/effectiveWeightResolution";

export const ROSTER_MANAGE_WEIGHT_SOURCE = "ROSTER_MANAGE" as const;

export type RosterWeightSource =
  | "FWA"
  | "Manual"
  | "WeightInputDeferment"
  | "PlayerCurrent"
  | "Unknown";

export type ResolvedRosterCurrentWeightRecord = {
  playerTag: string;
  weight: number | null;
  weightSource: RosterWeightSource;
  weightMeasuredAt: Date | null;
  trophies: number | null;
};

export type SetRosterManualWeightResult =
  | {
      outcome: "saved";
      rosterId: string;
      playerTag: string;
      weight: number;
      measuredAt: Date;
    }
  | {
      outcome: "deleted";
      rosterId: string;
      playerTag: string;
    }
  | {
      outcome: "roster_not_found";
      rosterId: string;
    }
  | {
      outcome: "player_not_on_roster";
      rosterId: string;
      playerTag: string;
    };

function normalizeRosterWeightValue(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const parsed = Math.trunc(Number(input));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** Purpose: parse roster-manage weight input in the accepted 145000 / 145,000 / 145k style. */
export function parseRosterManageWeightInput(input: string): number | null {
  const trimmed = String(input ?? "").trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "0") return 0;

  const compact = trimmed.replace(/,/g, "");
  const kMatch = compact.match(/^(\d+(?:\.\d+)?)k$/);
  if (kMatch) {
    const base = Number(kMatch[1]);
    if (!Number.isFinite(base) || base <= 0) return null;
    const value = Math.trunc(base * 1000);
    return value > 0 && value % 1000 === 0 ? value : null;
  }

  if (!/^\d+$/.test(compact)) return null;
  const value = Number(compact);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value === 0) return 0;
  return value % 1000 === 0 ? Math.trunc(value) : null;
}

/** Purpose: render deterministic weight-age text from the resolved source timestamp. */
export function formatRosterWeightAge(measuredAt: Date | null | undefined, now: Date = new Date()): string | null {
  if (!measuredAt) return null;
  return formatPendingAge(measuredAt, now);
}

/** Purpose: resolve persisted current weights for roster render and validation consumers. */
export async function resolveRosterCurrentWeightRecords(input: {
  playerTags: string[];
  guildId?: string | null;
  clanTag?: string | null;
}): Promise<Map<string, ResolvedRosterCurrentWeightRecord>> {
  const normalizedTags = [...new Set((input.playerTags ?? []).map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  const result = new Map<string, ResolvedRosterCurrentWeightRecord>();
  for (const playerTag of normalizedTags) {
    result.set(playerTag, {
      playerTag,
      weight: null,
      weightSource: "Unknown",
      weightMeasuredAt: null,
      trophies: null,
    });
  }
  if (normalizedTags.length <= 0) {
    return result;
  }

  const normalizedGuildId = String(input.guildId ?? "").trim();
  const normalizedClanTag = normalizeClanTag(input.clanTag ?? "") || null;
  const [catalogRows, trophiesRows, manualRows, playerCurrentRows, deferredRowsByClanAndPlayerTag] = await Promise.all([
    prisma.fwaPlayerCatalog.findMany({
      where: { playerTag: { in: normalizedTags } },
      select: {
        playerTag: true,
        latestKnownWeight: true,
        lastSyncedAt: true,
      },
    }),
    prisma.fwaClanMemberCurrent.findMany({
      where: { playerTag: { in: normalizedTags } },
      orderBy: [{ playerTag: "asc" }, { sourceSyncedAt: "desc" }, { clanTag: "asc" }],
      select: {
        playerTag: true,
        trophies: true,
      },
    }),
    prisma.externalPlayerWeightCurrent.findMany({
      where: { playerTag: { in: normalizedTags } },
      select: {
        playerTag: true,
        weight: true,
        measuredAt: true,
      },
    }),
    playerCurrentService.listPlayerCurrentByTags(normalizedTags),
    normalizedGuildId
      ? listOpenDeferredWeightRowsByClanAndPlayerTags({
          guildId: normalizedGuildId,
          clanPlayerTags: [
            {
              clanTag: normalizedClanTag,
              playerTags: normalizedTags,
            },
          ],
        })
      : Promise.resolve(new Map<string, Map<string, { deferredWeight: number; createdAt: Date }>>()),
  ]);

  const latestFwaByTag = new Map<string, { weight: number | null; measuredAt: Date }>();
  for (const row of catalogRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag || latestFwaByTag.has(playerTag)) continue;
    latestFwaByTag.set(playerTag, {
      weight: normalizeRosterWeightValue(row.latestKnownWeight),
      measuredAt: row.lastSyncedAt,
    });
  }

  const trophiesByTag = new Map<string, number | null>();
  for (const row of trophiesRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag || trophiesByTag.has(playerTag)) continue;
    trophiesByTag.set(playerTag, normalizeRosterWeightValue(row.trophies));
  }

  const manualByTag = new Map<string, { weight: number; measuredAt: Date }>();
  for (const row of manualRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const weight = normalizeRosterWeightValue(row.weight);
    if (!playerTag || weight === null || manualByTag.has(playerTag)) continue;
    manualByTag.set(playerTag, {
      weight,
      measuredAt: row.measuredAt,
    });
  }

  const playerCurrentByTag = new Map<string, { weight: number | null; measuredAt: Date | null }>();
  for (const [playerTag, row] of playerCurrentRows) {
    if (!playerTag || playerCurrentByTag.has(playerTag)) continue;
    const weight = normalizeRosterWeightValue(row.currentWeight);
    if (weight === null || weight <= 0) continue;
    playerCurrentByTag.set(playerTag, {
      weight,
      measuredAt: row.currentWeightMeasuredAt ?? null,
    });
  }

  const clanKey = normalizedClanTag ?? "";
  const deferredRowsByPlayerTag = deferredRowsByClanAndPlayerTag.get(clanKey) ?? new Map();

  for (const playerTag of normalizedTags) {
    const fwa = latestFwaByTag.get(playerTag) ?? null;
    const manual = manualByTag.get(playerTag) ?? null;
    const deferredRow = deferredRowsByPlayerTag.get(playerTag) ?? null;
    const playerCurrent = playerCurrentByTag.get(playerTag) ?? null;
    const resolved = resolveEffectivePlayerWeight({
      primaryCandidates: [{ source: "FWA", weight: fwa?.weight ?? null }],
      overrideCandidates: [
        { source: "Manual", weight: manual?.weight ?? null },
        { source: "WeightInputDeferment", weight: deferredRow?.deferredWeight ?? null },
      ],
      fallbackCandidates: [{ source: "PlayerCurrent", weight: playerCurrent?.weight ?? null }],
    });
    if (resolved.resolvedWeight !== null) {
      result.set(playerTag, {
        playerTag,
        weight: resolved.resolvedWeight,
        weightSource: resolved.resolvedWeightSource ?? "Unknown",
        weightMeasuredAt:
          resolved.resolvedWeightSource === "FWA"
            ? fwa?.measuredAt ?? null
            : resolved.resolvedWeightSource === "Manual"
              ? manual?.measuredAt ?? null
              : resolved.resolvedWeightSource === "WeightInputDeferment"
                ? deferredRow?.createdAt ?? null
              : resolved.resolvedWeightSource === "PlayerCurrent"
                ? playerCurrent?.measuredAt ?? null
                : null,
        trophies: trophiesByTag.get(playerTag) ?? null,
      });
      continue;
    }
    result.set(playerTag, {
      playerTag,
      weight: null,
      weightSource: "Unknown",
      weightMeasuredAt: null,
      trophies: trophiesByTag.get(playerTag) ?? null,
    });
  }

  return result;
}

export class RosterWeightService {
  async setManualWeightForRoster(input: {
    rosterId: string;
    playerTag: string;
    weight: number;
    updatedByUserId?: string | null;
  }): Promise<SetRosterManualWeightResult> {
    const rosterId = String(input.rosterId ?? "").trim();
    const normalizedPlayerTag = normalizePlayerTag(input.playerTag);
    if (!rosterId || !normalizedPlayerTag) {
      return {
        outcome: "player_not_on_roster",
        rosterId,
        playerTag: normalizedPlayerTag || String(input.playerTag ?? "").trim(),
      };
    }

    const roster = await prisma.roster.findUnique({
      where: { id: rosterId },
      select: { id: true },
    });
    if (!roster) {
      return { outcome: "roster_not_found", rosterId };
    }

    const signup = await prisma.rosterSignup.findFirst({
      where: {
        rosterId: roster.id,
        playerTag: normalizedPlayerTag,
      },
      select: {
        playerTag: true,
      },
    });
    if (!signup) {
      return {
        outcome: "player_not_on_roster",
        rosterId: roster.id,
        playerTag: normalizedPlayerTag,
      };
    }

    const normalizedWeight = Math.trunc(Number(input.weight));
    if (!Number.isFinite(normalizedWeight) || normalizedWeight < 0) {
      return {
        outcome: "player_not_on_roster",
        rosterId: roster.id,
        playerTag: normalizedPlayerTag,
      };
    }

    if (normalizedWeight === 0) {
      await prisma.externalPlayerWeightCurrent.deleteMany({
        where: {
          playerTag: normalizedPlayerTag,
        },
      });
      return {
        outcome: "deleted",
        rosterId: roster.id,
        playerTag: normalizedPlayerTag,
      };
    }

    const measuredAt = new Date();
    await prisma.externalPlayerWeightCurrent.upsert({
      where: {
        playerTag: normalizedPlayerTag,
      },
      create: {
        playerTag: normalizedPlayerTag,
        weight: normalizedWeight,
        source: ROSTER_MANAGE_WEIGHT_SOURCE,
        measuredAt,
        createdByUserId: String(input.updatedByUserId ?? "").trim() || null,
        updatedByUserId: String(input.updatedByUserId ?? "").trim() || null,
      },
      update: {
        weight: normalizedWeight,
        source: ROSTER_MANAGE_WEIGHT_SOURCE,
        measuredAt,
        updatedByUserId: String(input.updatedByUserId ?? "").trim() || null,
      },
    });

    return {
      outcome: "saved",
      rosterId: roster.id,
      playerTag: normalizedPlayerTag,
      weight: normalizedWeight,
      measuredAt,
    };
  }
}

export const rosterWeightService = new RosterWeightService();
