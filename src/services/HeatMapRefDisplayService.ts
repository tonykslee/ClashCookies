import type { HeatMapRef } from "@prisma/client";
import { prisma } from "../prisma";
import { normalizeFwaTag } from "./fwa-feeds/normalize";
import {
  buildHeatMapRefRebuildRows,
  getHeatMapRefSeedRowCountsByBandKey,
  type HeatMapRefBandDefinition,
  type HeatMapRefBucketCounts,
  type HeatMapRefRebuildSourceRoster,
} from "../helper/heatMapRefRebuild";
import {
  buildHeatMapRefCopyText,
  buildHeatMapRefDisplayRows,
} from "../helper/heatMapRefDisplay";
import { getHeatMapRefBandKey } from "../helper/compoHeatMap";

type HeatMapRefSourceMember = {
  clanTag: string;
  playerTag: string;
  position: number | null;
  townHall: number | null;
  weight: number | null;
  sourceSyncedAt: Date;
};

type HeatMapRefMatchStatsRow = {
  clanTag: string;
  matchRate: number;
  evaluatedWarCount: number;
};

function buildSourceRosters(members: readonly HeatMapRefSourceMember[]): HeatMapRefRebuildSourceRoster[] {
  const byClanTag = new Map<string, HeatMapRefRebuildSourceRoster>();
  for (const member of members) {
    const clanTag = normalizeFwaTag(member.clanTag);
    if (!clanTag) continue;
    const current = byClanTag.get(clanTag) ?? {
      clanTag,
      members: [],
    };
    current.members.push({
      clanTag,
      playerTag: member.playerTag,
      position: member.position,
      townHall: member.townHall,
      weight: member.weight,
      sourceSyncedAt: member.sourceSyncedAt,
    });
    byClanTag.set(clanTag, current);
  }
  return [...byClanTag.values()].sort((left, right) => left.clanTag.localeCompare(right.clanTag));
}

function buildSeedRowsByBandKey(heatMapRefs: readonly HeatMapRef[]): ReadonlyMap<string, HeatMapRefBucketCounts> {
  return getHeatMapRefSeedRowCountsByBandKey(
    heatMapRefs.map((row) => ({
      weightMinInclusive: row.weightMinInclusive,
      weightMaxInclusive: row.weightMaxInclusive,
    })),
    heatMapRefs.map((row) => ({
      th18Count: row.th18Count,
      th17Count: row.th17Count,
      th16Count: row.th16Count,
      th15Count: row.th15Count,
      th14Count: row.th14Count,
      th13Count: row.th13Count,
      th12Count: row.th12Count,
      th11Count: row.th11Count,
      th10OrLowerCount: row.th10OrLowerCount,
    })),
  );
}

function formatMatchPercent(matchRate: number, evaluatedWarCount: number): string {
  if (!Number.isFinite(matchRate) || evaluatedWarCount <= 0) {
    return "0%";
  }
  return `${(matchRate * 100).toFixed(2)}%`;
}

/** Purpose: build the copyable HeatMapRef table display from persisted current-state rows. */
export class HeatMapRefDisplayService {
  /** Purpose: compute display rows and copy text without mutating HeatMapRef state. */
  async readHeatMapRefDisplayTable(): Promise<{
    rows: string[][];
    copyText: string;
  }> {
    const heatMapRefs = await prisma.heatMapRef.findMany({
      orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
    });
    return this.buildDisplayData(heatMapRefs);
  }

  private async buildDisplayData(heatMapRefs: readonly HeatMapRef[]): Promise<{
    rows: string[][];
    copyText: string;
  }> {
    if (heatMapRefs.length === 0) {
      return {
        rows: buildHeatMapRefDisplayRows({ heatMapRefs }),
        copyText: buildHeatMapRefCopyText({ heatMapRefs }),
      };
    }

    const clanTagRows = await prisma.fwaClanCatalog.findMany({
      orderBy: { clanTag: "asc" },
      select: { clanTag: true },
    });
    const clanTags = [...new Set(clanTagRows.map((row) => normalizeFwaTag(row.clanTag)).filter(Boolean))];
    const members = clanTags.length > 0
      ? await prisma.fwaWarMemberCurrent.findMany({
          where: { clanTag: { in: clanTags } },
          orderBy: [{ clanTag: "asc" }, { position: "asc" }, { playerTag: "asc" }],
          select: {
            clanTag: true,
            playerTag: true,
            position: true,
            townHall: true,
            weight: true,
            sourceSyncedAt: true,
          },
        })
      : [];

    const sourceRosters = buildSourceRosters(members);
    const seedBands: HeatMapRefBandDefinition[] = heatMapRefs.map((row) => ({
      weightMinInclusive: row.weightMinInclusive,
      weightMaxInclusive: row.weightMaxInclusive,
    }));
    const seedRowsByBandKey = buildSeedRowsByBandKey(heatMapRefs);
    const rebuilt = buildHeatMapRefRebuildRows({
      sourceRosters,
      seedBands,
      seedRowsByBandKey,
      now: new Date(),
    });

    const contributingTagsByBandKey = new Map<string, string[]>();
    for (const roster of rebuilt.qualifyingRosters) {
      const key = getHeatMapRefBandKey(roster.band);
      const current = contributingTagsByBandKey.get(key) ?? [];
      current.push(normalizeFwaTag(roster.clanTag));
      contributingTagsByBandKey.set(key, current);
    }
    for (const [key, tags] of contributingTagsByBandKey.entries()) {
      const uniqueSorted = [...new Set(tags.filter(Boolean))].sort((left, right) => left.localeCompare(right));
      contributingTagsByBandKey.set(key, uniqueSorted);
    }

    const contributingTags = [...new Set([...contributingTagsByBandKey.values()].flat())];
    const statsRows = contributingTags.length > 0
      ? await prisma.fwaClanMatchStatsCurrent.findMany({
          where: { clanTag: { in: contributingTags } },
          orderBy: { clanTag: "asc" },
          select: {
            clanTag: true,
            matchRate: true,
            evaluatedWarCount: true,
          },
        })
      : [];
    const statsByClanTag = new Map<string, HeatMapRefMatchStatsRow>(
      statsRows.map((row) => [
        normalizeFwaTag(row.clanTag),
        {
          clanTag: normalizeFwaTag(row.clanTag),
          matchRate: row.matchRate,
          evaluatedWarCount: row.evaluatedWarCount,
        },
      ]),
    );

    const matchPercentByBandKey = this.buildMatchPercentByBandKeyFromStats({
      heatMapRefs,
      contributingTagsByBandKey,
      statsByClanTag,
    });

    return {
      rows: buildHeatMapRefDisplayRows({
        heatMapRefs,
        matchPercentByBandKey,
      }),
      copyText: buildHeatMapRefCopyText({
        heatMapRefs,
        matchPercentByBandKey,
      }),
    };
  }

  private buildMatchPercentByBandKeyFromStats(input: {
    heatMapRefs: readonly HeatMapRef[];
    contributingTagsByBandKey: ReadonlyMap<string, string[]>;
    statsByClanTag: ReadonlyMap<string, HeatMapRefMatchStatsRow>;
  }): ReadonlyMap<string, string> {
    const matchPercentByBandKey = new Map<string, string>();
    for (const heatMapRef of input.heatMapRefs) {
      const bandKey = getHeatMapRefBandKey(heatMapRef);
      const contributors = input.contributingTagsByBandKey.get(bandKey) ?? [];
      let weightedSum = 0;
      let denominator = 0;
      for (const clanTag of contributors) {
        const stats = input.statsByClanTag.get(clanTag);
        if (!stats || stats.evaluatedWarCount <= 0) {
          continue;
        }
        weightedSum += stats.matchRate * stats.evaluatedWarCount;
        denominator += stats.evaluatedWarCount;
      }
      matchPercentByBandKey.set(
        bandKey,
        denominator > 0 ? formatMatchPercent(weightedSum / denominator, denominator) : "0%",
      );
    }
    return matchPercentByBandKey;
  }
}
