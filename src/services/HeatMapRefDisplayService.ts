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
import {
  type HeatMapRefHistoricalReferenceAvailability,
  type HeatMapRefReferenceAvailability,
} from "../helper/heatMapRefAvailability";
import { resolveHeatMapRefReference } from "../helper/heatMapRefResolver";

export type HeatMapRefDisplayReferenceStatus =
  | "validated"
  | "historical"
  | "blocked"
  | "unavailable";

export type HeatMapRefDisplayReferenceState = {
  status: HeatMapRefDisplayReferenceStatus;
  sourceVersion: string | null;
  notice: string;
};

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

type HeatMapRefBandMatchRateStats = {
  matchRate: number | null;
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

function readUniformSourceVersion(heatMapRefs: readonly HeatMapRef[]): string | null {
  const versions = [...new Set(
    heatMapRefs
      .map((row) => row.sourceVersion?.trim() ?? "")
      .filter(Boolean),
  )];
  return versions.length === 1 ? versions[0]! : null;
}

function buildReferenceState(input: {
  heatMapRefs: readonly HeatMapRef[];
  availability: HeatMapRefReferenceAvailability;
  historicalAvailability: HeatMapRefHistoricalReferenceAvailability;
}): HeatMapRefDisplayReferenceState {
  if (input.availability.status === "validated") {
    const sourceVersion = readUniformSourceVersion(input.heatMapRefs);
    return {
      status: "validated",
      sourceVersion,
      notice: `Reference: validated current${sourceVersion ? ` · version ${sourceVersion}` : " · version unavailable"}.`,
    };
  }

  if (input.historicalAvailability.status === "verified") {
    const currentState = input.availability.status === "retained_unverified"
      ? `current validation blocked (${input.availability.blockReasonCode ?? "bounded_reason_unavailable"})`
      : "current validation unavailable";
    return {
      status: "historical",
      sourceVersion: input.historicalAvailability.sourceVersion,
      notice: `Reference: verified historical legacy-v1 baseline · version ${input.historicalAvailability.sourceVersion ?? "unavailable"} · informational only · ${currentState}.`,
    };
  }

  if (input.availability.status === "retained_unverified") {
    const sourceVersion = readUniformSourceVersion(input.heatMapRefs);
    return {
      status: "blocked",
      sourceVersion,
      notice: `Reference: blocked · retained version ${sourceVersion ?? "unavailable"} (unverified) · current validation unavailable (${input.availability.blockReasonCode ?? "bounded_reason_unavailable"}); retained rows are informational only.`,
    };
  }

  const sourceVersion = readUniformSourceVersion(input.heatMapRefs);
  const warning = input.availability.warning ?? "current validation unavailable";
  const boundedWarning = warning.includes("in progress")
    ? "validation pending"
    : warning.includes("malformed")
      ? "validation provenance malformed or unavailable"
      : warning.includes("could not be read")
        ? "validation provenance could not be read"
        : "validation provenance unavailable";
  return {
    status: "unavailable",
    sourceVersion,
    notice: `Reference: unavailable · retained version ${sourceVersion ?? "unavailable"} (unverified) · ${boundedWarning}; retained rows are informational only.`,
  };
}

/** Purpose: build the copyable HeatMapRef table display from persisted current-state rows. */
export class HeatMapRefDisplayService {
  /** Purpose: compute display rows and copy text without mutating HeatMapRef state. */
  async readHeatMapRefDisplayTable(input?: { guildId?: string | null }): Promise<{
    rows: string[][];
    copyText: string;
    availability: HeatMapRefReferenceAvailability;
    historicalAvailability: HeatMapRefHistoricalReferenceAvailability;
    referenceState: HeatMapRefDisplayReferenceState;
  }> {
    const reference = await resolveHeatMapRefReference({ guildId: input?.guildId });
    const referenceState = buildReferenceState({
      heatMapRefs: reference.heatMapRefs,
      availability: reference.availability,
      historicalAvailability: reference.historicalAvailability,
    });
    const [display, availability] = await Promise.all([
      this.buildDisplayData(reference.heatMapRefs),
      Promise.resolve(reference.availability),
    ]);
    return {
      ...display,
      availability,
      historicalAvailability: reference.historicalAvailability,
      referenceState,
    };
  }

  async readHeatMapRefBandMatchRates(input?: {
    heatMapRefs?: readonly HeatMapRef[];
  }): Promise<ReadonlyMap<string, number | null>> {
    const heatMapRefs =
      input?.heatMapRefs ??
      (await prisma.heatMapRef.findMany({
        orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
      }));
    const statsByBandKey = await this.buildMatchRateStatsByBandKey(heatMapRefs);
    return new Map([...statsByBandKey.entries()].map(([bandKey, stats]) => [bandKey, stats.matchRate]));
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

    const matchRateStatsByBandKey = await this.buildMatchRateStatsByBandKey(heatMapRefs);
    const matchPercentByBandKey = new Map<string, string>(
      [...matchRateStatsByBandKey.entries()].map(([bandKey, stats]) => [
        bandKey,
        formatMatchPercent(stats.matchRate ?? 0, stats.evaluatedWarCount),
      ]),
    );

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

  private async buildMatchRateStatsByBandKey(
    heatMapRefs: readonly HeatMapRef[],
  ): Promise<ReadonlyMap<string, HeatMapRefBandMatchRateStats>> {
    if (heatMapRefs.length === 0) {
      return new Map();
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

    const matchRateByBandKey = new Map<string, HeatMapRefBandMatchRateStats>();
    for (const heatMapRef of heatMapRefs) {
      const bandKey = getHeatMapRefBandKey(heatMapRef);
      const contributors = contributingTagsByBandKey.get(bandKey) ?? [];
      let weightedSum = 0;
      let denominator = 0;
      for (const clanTag of contributors) {
        const stats = statsByClanTag.get(clanTag);
        if (!stats || stats.evaluatedWarCount <= 0) {
          continue;
        }
        weightedSum += stats.matchRate * stats.evaluatedWarCount;
        denominator += stats.evaluatedWarCount;
      }
      matchRateByBandKey.set(
        bandKey,
        denominator > 0
          ? { matchRate: weightedSum / denominator, evaluatedWarCount: denominator }
          : { matchRate: null, evaluatedWarCount: 0 },
      );
    }
    return matchRateByBandKey;
  }
}
