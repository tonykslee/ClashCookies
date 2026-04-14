import { prisma } from "../../prisma";
import { formatError } from "../../helper/formatError";
import { normalizeFwaTag, normalizeText } from "./normalize";

type SourceWarLogRow = {
  clanTag: string;
  opponentInfo: string | null;
};

type ClanMatchStatsRow = {
  clanTag: string;
  fwaWarCount: number;
  blacklistedWarCount: number;
  friendlyWarCount: number;
  unknownWarCount: number;
  successWarCount: number;
  evaluatedWarCount: number;
  matchRate: number;
  lastComputedAt: Date;
};

type OpponentInfoClassification = "FWA" | "BLACKLISTED" | "FRIENDLY" | "UNKNOWN" | "IGNORED";

type ClanMatchStatsAccumulator = {
  clanTag: string;
  fwaWarCount: number;
  blacklistedWarCount: number;
  friendlyWarCount: number;
  unknownWarCount: number;
  evaluatedWarCount: number;
  lastComputedAt: Date;
};

function classifyOpponentInfo(input: string | null | undefined): OpponentInfoClassification {
  const normalized = normalizeText(input)?.toLowerCase();
  if (!normalized) return "IGNORED";
  if (normalized === "fwa") return "FWA";
  if (normalized === "blacklisted") return "BLACKLISTED";
  if (normalized === "friendly") return "FRIENDLY";
  if (normalized === "unknown") return "UNKNOWN";
  return "IGNORED";
}

function createAccumulator(clanTag: string, now: Date): ClanMatchStatsAccumulator {
  return {
    clanTag,
    fwaWarCount: 0,
    blacklistedWarCount: 0,
    friendlyWarCount: 0,
    unknownWarCount: 0,
    evaluatedWarCount: 0,
    lastComputedAt: now,
  };
}

function finalizeAccumulator(input: ClanMatchStatsAccumulator): ClanMatchStatsRow {
  const successWarCount =
    input.fwaWarCount + input.blacklistedWarCount + input.friendlyWarCount;
  const evaluatedWarCount = input.evaluatedWarCount;
  return {
    clanTag: input.clanTag,
    fwaWarCount: input.fwaWarCount,
    blacklistedWarCount: input.blacklistedWarCount,
    friendlyWarCount: input.friendlyWarCount,
    unknownWarCount: input.unknownWarCount,
    successWarCount,
    evaluatedWarCount,
    matchRate: evaluatedWarCount === 0 ? 0 : successWarCount / evaluatedWarCount,
    lastComputedAt: input.lastComputedAt,
  };
}

/** Purpose: derive one deterministic clan-match snapshot from the current clan-war log rows. */
export function buildFwaClanMatchStatsCurrentRowsForTest(
  rows: readonly SourceWarLogRow[],
  now: Date = new Date(),
): ClanMatchStatsRow[] {
  const byClanTag = new Map<string, ClanMatchStatsAccumulator>();
  for (const row of rows) {
    const clanTag = normalizeFwaTag(row.clanTag);
    if (!clanTag) continue;
    const existing = byClanTag.get(clanTag);
    const accumulator = existing ?? createAccumulator(clanTag, now);
    if (!existing) {
      byClanTag.set(clanTag, accumulator);
    }
    const classification = classifyOpponentInfo(row.opponentInfo);
    if (classification === "IGNORED") continue;
    accumulator.evaluatedWarCount += 1;
    if (classification === "FWA") {
      accumulator.fwaWarCount += 1;
    } else if (classification === "BLACKLISTED") {
      accumulator.blacklistedWarCount += 1;
    } else if (classification === "FRIENDLY") {
      accumulator.friendlyWarCount += 1;
    } else if (classification === "UNKNOWN") {
      accumulator.unknownWarCount += 1;
    }
  }

  return [...byClanTag.values()]
    .sort((a, b) => a.clanTag.localeCompare(b.clanTag))
    .map((row) => finalizeAccumulator(row));
}

/** Purpose: rebuild the derived clan-match analytics snapshot from persisted clan-war log rows. */
export class FwaClanMatchStatsCurrentSyncService {
  /** Purpose: recompute all clan-match stats as a recreatable current-state snapshot. */
  async rebuildCurrentStats(options?: { now?: Date }): Promise<{
    clanCount: number;
    sourceRowCount: number;
    evaluatedWarCount: number;
  }> {
    const now = options?.now ?? new Date();
    const startedAt = Date.now();
    try {
      const sourceRows = await prisma.fwaClanWarLogCurrent.findMany({
        orderBy: [{ clanTag: "asc" }, { endTime: "asc" }, { opponentTag: "asc" }],
        select: {
          clanTag: true,
          opponentInfo: true,
        },
      });
      const derivedRows = buildFwaClanMatchStatsCurrentRowsForTest(sourceRows, now);
      const evaluatedWarCount = derivedRows.reduce(
        (sum, row) => sum + row.evaluatedWarCount,
        0,
      );

      await prisma.$transaction(async (tx) => {
        await tx.fwaClanMatchStatsCurrent.deleteMany({});
        if (derivedRows.length > 0) {
          await tx.fwaClanMatchStatsCurrent.createMany({
            data: derivedRows,
          });
        }
      });

      console.info(
        `[fwa-feed] job=clan_match_stats_current clans=${derivedRows.length} source_rows=${sourceRows.length} evaluated=${evaluatedWarCount} duration_ms=${Date.now() - startedAt}`,
      );
      return {
        clanCount: derivedRows.length,
        sourceRowCount: sourceRows.length,
        evaluatedWarCount,
      };
    } catch (error) {
      console.error(
        `[fwa-feed] job=clan_match_stats_current failed error=${formatError(error)}`,
      );
      throw error;
    }
  }
}
