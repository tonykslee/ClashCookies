import { prisma } from "../prisma";
import { buildHeatMapRefRebuildRows, type HeatMapRefBandDefinition } from "../helper/heatMapRefRebuild";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";
import type { BlacklistClanRow } from "./BlacklistClanService";
import { blacklistClanService } from "./BlacklistClanService";

const BLACKLIST_SAMPLE_BAND: HeatMapRefBandDefinition = {
  weightMinInclusive: 0,
  weightMaxInclusive: 25_000_000,
};

export type BlacklistMatchSampleQuality = "full" | "partial";
export type BlacklistMatchSampleConfidence = "high" | "medium" | "low";

export type BlacklistMatchSampleRebuildResult = {
  status: "success" | "noop" | "skipped";
  reason: string | null;
  activeBlacklistCount: number;
  fwaClanCount: number;
  candidateWarCount: number;
  qualifyingSampleCount: number;
  skippedCandidateCount: number;
  addedCount: number;
  updatedCount: number;
  summaryLines: string[];
};

type HistoricalWarRow = {
  warId: number;
  clanTag: string;
  clanName: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
};

type ParticipationRow = {
  warId: string;
  clanTag: string;
  playerTag: string;
  townHall: number | null;
};

type SampleCandidate = {
  sourceClanTag: string;
  sourceClanName: string | null;
  opponentBlacklistTag: string;
  opponentBlacklistName: string | null;
  warId: string;
  warStartTime: Date;
  warEndTime: Date | null;
  rosterSize: number;
  totalRosterWeight: number;
  missingWeightCount: number;
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11PlusCount: number;
  sampleQuality: BlacklistMatchSampleQuality;
  confidence: BlacklistMatchSampleConfidence;
};

type InjectedBlacklistClanReader = {
  listBlacklistClans(input?: { active?: boolean }): Promise<BlacklistClanRow[]>;
};

function normalizeText(input: string | null | undefined): string | null {
  const value = String(input ?? "").replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : null;
}

function buildSummaryLines(input: {
  activeBlacklistCount: number;
  fwaClanCount: number;
  candidateWarCount: number;
  qualifyingSampleCount: number;
  skippedCandidateCount: number;
  addedCount: number;
  updatedCount: number;
  status: BlacklistMatchSampleRebuildResult["status"];
  reason: string | null;
}): string[] {
  const lines = [
    `active blacklist clans: ${input.activeBlacklistCount}`,
    `known FWA clans: ${input.fwaClanCount}`,
    `candidate wars: ${input.candidateWarCount}`,
    `qualifying samples: ${input.qualifyingSampleCount}`,
    `skipped candidates: ${input.skippedCandidateCount}`,
    `samples added: ${input.addedCount}`,
    `samples updated: ${input.updatedCount}`,
    `result: ${input.status}`,
  ];
  if (input.reason) {
    lines.push(`reason: ${input.reason}`);
  }
  return lines;
}

function buildSourceRostersFromParticipationRows(input: {
  war: HistoricalWarRow;
  participationRows: readonly ParticipationRow[];
  weightByPlayerTag: ReadonlyMap<string, number | null>;
}): Array<{
  clanTag: string;
  members: Array<{
    clanTag: string;
    playerTag: string;
    position: number;
    townHall: number | null;
    weight: number | null;
    sourceSyncedAt: Date;
  }>;
}> {
  const deduped = new Map<
    string,
    {
      playerTag: string;
      townHall: number | null;
      weight: number | null;
    }
  >();
  for (const row of input.participationRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    const current = deduped.get(playerTag);
    const weight = input.weightByPlayerTag.get(playerTag) ?? null;
    const next = {
      playerTag,
      townHall: Number.isFinite(row.townHall ?? NaN) ? Math.trunc(row.townHall ?? 0) : null,
      weight,
    };
    if (!current) {
      deduped.set(playerTag, next);
      continue;
    }
    const nextTownHall = next.townHall ?? current.townHall;
    const nextWeight = next.weight ?? current.weight;
    deduped.set(playerTag, {
      playerTag,
      townHall: nextTownHall,
      weight: nextWeight,
    });
  }

  const sorted = [...deduped.values()].sort((left, right) => {
    const leftWeight = left.weight ?? -1;
    const rightWeight = right.weight ?? -1;
    if (leftWeight !== rightWeight) return rightWeight - leftWeight;
    const leftTownHall = left.townHall ?? -1;
    const rightTownHall = right.townHall ?? -1;
    if (leftTownHall !== rightTownHall) return rightTownHall - leftTownHall;
    return left.playerTag.localeCompare(right.playerTag);
  });

  const rosterMembers = sorted.map((row, index) => ({
    clanTag: input.war.clanTag,
    playerTag: row.playerTag,
    position: index + 1,
    townHall: row.townHall,
    weight: row.weight,
    sourceSyncedAt: input.war.warStartTime,
  }));

  return [
    {
      clanTag: input.war.clanTag,
      members: rosterMembers,
    },
  ];
}

function buildSampleCandidate(input: {
  war: HistoricalWarRow;
  participationRows: readonly ParticipationRow[];
  weightByPlayerTag: ReadonlyMap<string, number | null>;
  sourceClanNameByTag: ReadonlyMap<string, string | null>;
  blacklistNameByTag: ReadonlyMap<string, string | null>;
  now: Date;
}): SampleCandidate | null {
  const rosters = buildSourceRostersFromParticipationRows({
    war: input.war,
    participationRows: input.participationRows,
    weightByPlayerTag: input.weightByPlayerTag,
  });
  if (rosters[0]?.members.length !== 50) {
    return null;
  }

  const rebuildResult = buildHeatMapRefRebuildRows({
    sourceRosters: rosters,
    seedBands: [BLACKLIST_SAMPLE_BAND],
    seedRowsByBandKey: new Map<string, never>(),
    now: input.now,
  });
  const roster = rebuildResult.qualifyingRosters[0] ?? null;
  if (!roster) return null;

  const counts = roster.bucketCounts;
  return {
    sourceClanTag: normalizeClanTag(input.war.clanTag),
    sourceClanName:
      normalizeText(input.war.clanName) ??
      input.sourceClanNameByTag.get(normalizeClanTag(input.war.clanTag)) ??
      null,
    opponentBlacklistTag: normalizeClanTag(String(input.war.opponentTag ?? "")),
    opponentBlacklistName:
      input.blacklistNameByTag.get(normalizeClanTag(String(input.war.opponentTag ?? ""))) ??
      normalizeText(input.war.opponentName) ??
      null,
    warId: String(input.war.warId),
    warStartTime: input.war.warStartTime,
    warEndTime: input.war.warEndTime,
    rosterSize: roster.rosterSize,
    totalRosterWeight: roster.totalEffectiveWeight,
    missingWeightCount: roster.missingWeightCount,
    th18Count: counts.th18Count,
    th17Count: counts.th17Count,
    th16Count: counts.th16Count,
    th15Count: counts.th15Count,
    th14Count: counts.th14Count,
    th13Count: counts.th13Count,
    th12Count: counts.th12Count,
    th11PlusCount: counts.th11Count + counts.th10OrLowerCount,
    sampleQuality: roster.missingWeightCount === 0 ? "full" : "partial",
    confidence:
      roster.missingWeightCount === 0
        ? "high"
        : roster.missingWeightCount <= 5
          ? "medium"
          : "low",
  };
}

/** Purpose: rebuild blacklist matchup samples from persisted war history and catalog rows only. */
export class BlacklistMatchSampleService {
  constructor(
    private readonly input?: {
      blacklistClans?: InjectedBlacklistClanReader;
    },
  ) {}

  async rebuildBlacklistMatchSamples(input?: {
    now?: Date;
  }): Promise<BlacklistMatchSampleRebuildResult> {
    const now = input?.now ?? new Date();
    const blacklistReader = this.input?.blacklistClans ?? blacklistClanService;
    const [activeBlacklistRows, fwaClanRows] = await Promise.all([
      blacklistReader.listBlacklistClans({ active: true }),
      prisma.fwaClanCatalog.findMany({
        orderBy: { clanTag: "asc" },
        select: { clanTag: true, name: true },
      }),
    ]);

    const activeBlacklistByTag = new Map(
      activeBlacklistRows
        .map((row) => [normalizeClanTag(row.clanTag), normalizeText(row.clanName)] as const)
        .filter((entry): entry is readonly [string, string | null] => Boolean(entry[0])),
    );
    const activeBlacklistTags = [...activeBlacklistByTag.keys()];
    const fwaClanByTag = new Map(
      fwaClanRows
        .map((row) => [normalizeClanTag(row.clanTag), normalizeText(row.name)] as const)
        .filter((entry): entry is readonly [string, string | null] => Boolean(entry[0])),
    );
    const fwaClanTags = [...fwaClanByTag.keys()];

    if (activeBlacklistTags.length === 0) {
      return {
        status: "skipped",
        reason: "no active blacklist clans are registered",
        activeBlacklistCount: 0,
        fwaClanCount: fwaClanTags.length,
        candidateWarCount: 0,
        qualifyingSampleCount: 0,
        skippedCandidateCount: 0,
        addedCount: 0,
        updatedCount: 0,
        summaryLines: buildSummaryLines({
          activeBlacklistCount: 0,
          fwaClanCount: fwaClanTags.length,
          candidateWarCount: 0,
          qualifyingSampleCount: 0,
          skippedCandidateCount: 0,
          addedCount: 0,
          updatedCount: 0,
          status: "skipped",
          reason: "no active blacklist clans are registered",
        }),
      };
    }

    if (fwaClanTags.length === 0) {
      return {
        status: "skipped",
        reason: "no persisted FWA clans are configured",
        activeBlacklistCount: activeBlacklistTags.length,
        fwaClanCount: 0,
        candidateWarCount: 0,
        qualifyingSampleCount: 0,
        skippedCandidateCount: 0,
        addedCount: 0,
        updatedCount: 0,
        summaryLines: buildSummaryLines({
          activeBlacklistCount: activeBlacklistTags.length,
          fwaClanCount: 0,
          candidateWarCount: 0,
          qualifyingSampleCount: 0,
          skippedCandidateCount: 0,
          addedCount: 0,
          updatedCount: 0,
          status: "skipped",
          reason: "no persisted FWA clans are configured",
        }),
      };
    }

    const candidateWars = await prisma.clanWarHistory.findMany({
      where: {
        clanTag: { in: fwaClanTags },
        opponentTag: { in: activeBlacklistTags },
      },
      orderBy: [{ warStartTime: "asc" }, { clanTag: "asc" }, { opponentTag: "asc" }],
      select: {
        warId: true,
        clanTag: true,
        clanName: true,
        opponentTag: true,
        opponentName: true,
        warStartTime: true,
        warEndTime: true,
      },
    });

    if (candidateWars.length === 0) {
      return {
        status: "noop",
        reason: "no historical wars matched the active blacklist registry",
        activeBlacklistCount: activeBlacklistTags.length,
        fwaClanCount: fwaClanTags.length,
        candidateWarCount: 0,
        qualifyingSampleCount: 0,
        skippedCandidateCount: 0,
        addedCount: 0,
        updatedCount: 0,
        summaryLines: buildSummaryLines({
          activeBlacklistCount: activeBlacklistTags.length,
          fwaClanCount: fwaClanTags.length,
          candidateWarCount: 0,
          qualifyingSampleCount: 0,
          skippedCandidateCount: 0,
          addedCount: 0,
          updatedCount: 0,
          status: "noop",
          reason: "no historical wars matched the active blacklist registry",
        }),
      };
    }

    const warIds = [...new Set(candidateWars.map((row) => String(row.warId)))];
    const participationRows = await prisma.clanWarParticipation.findMany({
      where: {
        warId: { in: warIds },
        clanTag: { in: fwaClanTags },
      },
      orderBy: [
        { warId: "asc" },
        { clanTag: "asc" },
        { playerTag: "asc" },
      ],
      select: {
        warId: true,
        clanTag: true,
        playerTag: true,
        townHall: true,
      },
    });
    const playerTags = [...new Set(participationRows.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean))];
    const fwaPlayerRows =
      playerTags.length > 0
        ? await prisma.fwaPlayerCatalog.findMany({
            where: { playerTag: { in: playerTags } },
            select: { playerTag: true, latestKnownWeight: true },
          })
        : [];
    const weightByPlayerTag = new Map(
      fwaPlayerRows.map((row) => [
        normalizePlayerTag(row.playerTag),
        Number.isFinite(row.latestKnownWeight ?? NaN)
          ? Math.trunc(row.latestKnownWeight ?? 0)
          : null,
      ]),
    );

    const participationByWarKey = new Map<string, ParticipationRow[]>();
    for (const row of participationRows) {
      const clanTag = normalizeClanTag(row.clanTag);
      const warKey = `${clanTag}|${String(row.warId).trim()}`;
      const current = participationByWarKey.get(warKey) ?? [];
      current.push({
        warId: String(row.warId).trim(),
        clanTag,
        playerTag: row.playerTag,
        townHall: row.townHall ?? null,
      });
      participationByWarKey.set(warKey, current);
    }

    const existingSamples = await prisma.blacklistMatchSample.findMany({
      where: {
        sourceClanTag: { in: fwaClanTags },
        opponentBlacklistTag: { in: activeBlacklistTags },
        warId: { in: warIds },
      },
      select: {
        sourceClanTag: true,
        opponentBlacklistTag: true,
        warId: true,
      },
    });
    const existingKeySet = new Set(
      existingSamples.map((row) => `${normalizeClanTag(row.sourceClanTag)}|${normalizeClanTag(row.opponentBlacklistTag)}|${String(row.warId)}`),
    );

    let qualifyingSampleCount = 0;
    let skippedCandidateCount = 0;
    let addedCount = 0;
    let updatedCount = 0;

    for (const war of candidateWars) {
      const sourceClanTag = normalizeClanTag(war.clanTag);
      const opponentBlacklistTag = normalizeClanTag(String(war.opponentTag ?? ""));
      const warKey = `${sourceClanTag}|${String(war.warId)}`;
      const rosterRows = participationByWarKey.get(warKey) ?? [];
      const sample = buildSampleCandidate({
        war: {
          warId: war.warId,
          clanTag: sourceClanTag,
          clanName: war.clanName ?? fwaClanByTag.get(sourceClanTag) ?? null,
          opponentTag: opponentBlacklistTag,
          opponentName: war.opponentName ?? activeBlacklistByTag.get(opponentBlacklistTag) ?? null,
          warStartTime: war.warStartTime,
          warEndTime: war.warEndTime,
        },
        participationRows: rosterRows,
        weightByPlayerTag,
        sourceClanNameByTag: fwaClanByTag,
        blacklistNameByTag: activeBlacklistByTag,
        now,
      });

      if (!sample) {
        skippedCandidateCount += 1;
        continue;
      }

      qualifyingSampleCount += 1;
      const sampleKey = `${sample.sourceClanTag}|${sample.opponentBlacklistTag}|${sample.warId}`;
      const existedBefore = existingKeySet.has(sampleKey);
      await prisma.blacklistMatchSample.upsert({
        where: {
          sourceClanTag_opponentBlacklistTag_warId: {
            sourceClanTag: sample.sourceClanTag,
            opponentBlacklistTag: sample.opponentBlacklistTag,
            warId: sample.warId,
          },
        },
        update: {
          sourceClanName: sample.sourceClanName,
          opponentBlacklistName: sample.opponentBlacklistName,
          warStartTime: sample.warStartTime,
          warEndTime: sample.warEndTime,
          rosterSize: sample.rosterSize,
          totalRosterWeight: sample.totalRosterWeight,
          missingWeightCount: sample.missingWeightCount,
          th18Count: sample.th18Count,
          th17Count: sample.th17Count,
          th16Count: sample.th16Count,
          th15Count: sample.th15Count,
          th14Count: sample.th14Count,
          th13Count: sample.th13Count,
          th12Count: sample.th12Count,
          th11PlusCount: sample.th11PlusCount,
          sampleQuality: sample.sampleQuality,
          confidence: sample.confidence,
        },
        create: {
          sourceClanTag: sample.sourceClanTag,
          sourceClanName: sample.sourceClanName,
          opponentBlacklistTag: sample.opponentBlacklistTag,
          opponentBlacklistName: sample.opponentBlacklistName,
          warId: sample.warId,
          warStartTime: sample.warStartTime,
          warEndTime: sample.warEndTime,
          rosterSize: sample.rosterSize,
          totalRosterWeight: sample.totalRosterWeight,
          missingWeightCount: sample.missingWeightCount,
          th18Count: sample.th18Count,
          th17Count: sample.th17Count,
          th16Count: sample.th16Count,
          th15Count: sample.th15Count,
          th14Count: sample.th14Count,
          th13Count: sample.th13Count,
          th12Count: sample.th12Count,
          th11PlusCount: sample.th11PlusCount,
          sampleQuality: sample.sampleQuality,
          confidence: sample.confidence,
        },
      });
      if (existedBefore) {
        updatedCount += 1;
      } else {
        addedCount += 1;
        existingKeySet.add(sampleKey);
      }
    }

    const status: BlacklistMatchSampleRebuildResult["status"] =
      qualifyingSampleCount > 0 ? "success" : "noop";
    const reason =
      qualifyingSampleCount > 0
        ? null
        : "no eligible war rosters qualified for sampling";

    return {
      status,
      reason,
      activeBlacklistCount: activeBlacklistTags.length,
      fwaClanCount: fwaClanTags.length,
      candidateWarCount: candidateWars.length,
      qualifyingSampleCount,
      skippedCandidateCount,
      addedCount,
      updatedCount,
      summaryLines: buildSummaryLines({
        activeBlacklistCount: activeBlacklistTags.length,
        fwaClanCount: fwaClanTags.length,
        candidateWarCount: candidateWars.length,
        qualifyingSampleCount,
        skippedCandidateCount,
        addedCount,
        updatedCount,
        status,
        reason,
      }),
    };
  }
}

export const blacklistMatchSampleService = new BlacklistMatchSampleService();
