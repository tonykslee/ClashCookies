import { prisma } from "../prisma";

export type ClanHealthSnapshot = {
  clanTag: string;
  clanName: string;
  warMetrics: {
    windowSize: number;
    endedWarSampleSize: number;
    fwaMatchCount: number;
    winCount: number;
  };
  inactiveWars: {
    windowSize: number;
    warsAvailable: number;
    warsSampled: number;
    inactivePlayerCount: number;
  };
  inactiveDays: {
    thresholdDays: number;
    staleHours: number;
    observedMemberCount: number;
    inactivePlayerCount: number;
  };
  missingLinks: {
    observedMemberCount: number;
    linkedMemberCount: number;
    missingMemberCount: number;
  };
  telemetry: {
    warRows: number;
    participationRows: number;
    activityRows: number;
    linkRows: number;
    durationMs: number;
  };
};

type WarHistoryMetricRow = {
  matchType: string | null;
  actualOutcome: string | null;
};

type ParticipationMetricRow = {
  playerTag: string;
  missedBoth: boolean;
};

type ActivityMetricRow = {
  tag: string;
  lastSeenAt: Date;
};

const DEFAULT_WAR_WINDOW_SIZE = 30;
const DEFAULT_INACTIVE_WAR_WINDOW_SIZE = 3;
const DEFAULT_INACTIVE_DAYS_THRESHOLD = 7;
const DEFAULT_INACTIVE_STALE_HOURS = 6;

/** Purpose: normalize clan tags into canonical uppercase + leading-# format. */
function normalizeClanTag(input: string): string {
  const raw = String(input ?? "").trim().toUpperCase().replace(/^#/, "");
  return raw ? `#${raw}` : "";
}

/** Purpose: derive ended-war rate metrics from the most recent history window. */
function computeWarMetrics(rows: WarHistoryMetricRow[], windowSize: number) {
  const endedWarSampleSize = rows.length;
  const fwaMatchCount = rows.filter((row) => String(row.matchType ?? "").toUpperCase() === "FWA").length;
  const winCount = rows.filter((row) => String(row.actualOutcome ?? "").toUpperCase() === "WIN").length;
  return { windowSize, endedWarSampleSize, fwaMatchCount, winCount };
}

/** Purpose: count players with at least one missed-both war in the selected recent window. */
function computeInactiveWarsPlayerCount(rows: ParticipationMetricRow[]): number {
  const missedByPlayer = new Map<string, boolean>();
  for (const row of rows) {
    const tag = String(row.playerTag ?? "").trim().toUpperCase();
    if (!tag) continue;
    if (row.missedBoth) missedByPlayer.set(tag, true);
    else if (!missedByPlayer.has(tag)) missedByPlayer.set(tag, false);
  }
  let total = 0;
  for (const missed of missedByPlayer.values()) {
    if (missed) total += 1;
  }
  return total;
}

/** Purpose: compute inactivity and link counts from observed member rows and linked tags. */
function computeActivityAndLinkMetrics(input: {
  rows: ActivityMetricRow[];
  linkedTags: Set<string>;
  inactiveCutoff: Date;
  thresholdDays: number;
  staleHours: number;
}) {
  const uniqueRowsByTag = new Map<string, ActivityMetricRow>();
  for (const row of input.rows) {
    const normalizedTag = String(row.tag ?? "").trim().toUpperCase();
    if (!normalizedTag) continue;
    uniqueRowsByTag.set(normalizedTag, row);
  }

  let inactivePlayerCount = 0;
  let linkedMemberCount = 0;
  for (const [tag, row] of uniqueRowsByTag.entries()) {
    if (row.lastSeenAt.getTime() < input.inactiveCutoff.getTime()) inactivePlayerCount += 1;
    if (input.linkedTags.has(tag)) linkedMemberCount += 1;
  }

  const observedMemberCount = uniqueRowsByTag.size;
  const missingMemberCount = Math.max(0, observedMemberCount - linkedMemberCount);
  return {
    inactiveDays: {
      thresholdDays: input.thresholdDays,
      staleHours: input.staleHours,
      observedMemberCount,
      inactivePlayerCount,
    },
    missingLinks: {
      observedMemberCount,
      linkedMemberCount,
      missingMemberCount,
    },
  };
}

export const computeWarMetricsForTest = computeWarMetrics;
export const computeInactiveWarsPlayerCountForTest = computeInactiveWarsPlayerCount;
export const computeActivityAndLinkMetricsForTest = computeActivityAndLinkMetrics;

export class ClanHealthSnapshotService {
  /** Purpose: load a single-clan leadership snapshot from persisted DB state only. */
  async getSnapshot(input: {
    guildId: string;
    clanTag: string;
    warWindowSize?: number;
    inactiveWarWindowSize?: number;
    inactiveDaysThreshold?: number;
    inactiveStaleHours?: number;
  }): Promise<ClanHealthSnapshot | null> {
    const startedAtMs = Date.now();
    const warWindowSize = Math.max(1, Math.trunc(input.warWindowSize ?? DEFAULT_WAR_WINDOW_SIZE));
    const inactiveWarWindowSize = Math.max(
      1,
      Math.trunc(input.inactiveWarWindowSize ?? DEFAULT_INACTIVE_WAR_WINDOW_SIZE)
    );
    const inactiveDaysThreshold = Math.max(
      1,
      Math.trunc(input.inactiveDaysThreshold ?? DEFAULT_INACTIVE_DAYS_THRESHOLD)
    );
    const inactiveStaleHours = Math.max(
      1,
      Math.trunc(input.inactiveStaleHours ?? Number(process.env.INACTIVE_STALE_HOURS ?? DEFAULT_INACTIVE_STALE_HOURS))
    );

    const normalizedTag = normalizeClanTag(input.clanTag);
    if (!normalizedTag) return null;

    const trackedClan = await prisma.trackedClan.findFirst({
      where: { tag: { equals: normalizedTag, mode: "insensitive" } },
      select: { tag: true, name: true },
    });
    if (!trackedClan) return null;

    const canonicalClanTag = normalizeClanTag(trackedClan.tag);
    const canonicalClanName = String(trackedClan.name ?? "").trim() || canonicalClanTag;
    const staleCutoff = new Date(Date.now() - inactiveStaleHours * 60 * 60 * 1000);
    const inactiveCutoff = new Date(Date.now() - inactiveDaysThreshold * 24 * 60 * 60 * 1000);

    const [warRows, distinctFwaWars, activityRows] = await Promise.all([
      prisma.clanWarHistory.findMany({
        where: {
          clanTag: canonicalClanTag,
          warEndTime: { not: null },
        },
        orderBy: [{ warEndTime: "desc" }, { warStartTime: "desc" }],
        take: warWindowSize,
        select: { matchType: true, actualOutcome: true },
      }),
      prisma.clanWarParticipation.findMany({
        where: {
          guildId: input.guildId,
          clanTag: canonicalClanTag,
          matchType: "FWA",
        },
        select: { warId: true, warStartTime: true },
        orderBy: [{ warStartTime: "desc" }, { createdAt: "desc" }],
        distinct: ["warId"],
      }),
      prisma.playerActivity.findMany({
        where: {
          guildId: input.guildId,
          clanTag: canonicalClanTag,
          updatedAt: { gte: staleCutoff },
        },
        select: { tag: true, lastSeenAt: true },
      }),
    ]);

    const selectedWarIds = distinctFwaWars
      .slice(0, inactiveWarWindowSize)
      .map((row) => String(row.warId ?? "").trim())
      .filter((warId) => warId.length > 0);

    const [participationRows, linkedRows] = await Promise.all([
      selectedWarIds.length > 0
        ? prisma.clanWarParticipation.findMany({
            where: {
              guildId: input.guildId,
              clanTag: canonicalClanTag,
              warId: { in: selectedWarIds },
            },
            select: { playerTag: true, missedBoth: true },
          })
        : Promise.resolve([] as ParticipationMetricRow[]),
      activityRows.length > 0
        ? prisma.playerLink.findMany({
            where: {
              playerTag: { in: activityRows.map((row) => row.tag) },
              discordUserId: { not: null },
            },
            select: { playerTag: true },
          })
        : Promise.resolve([] as Array<{ playerTag: string }>),
    ]);

    const linkedTags = new Set(
      linkedRows
        .map((row) => String(row.playerTag ?? "").trim().toUpperCase())
        .filter((tag) => tag.length > 0)
    );
    const activityAndLinks = computeActivityAndLinkMetrics({
      rows: activityRows,
      linkedTags,
      inactiveCutoff,
      thresholdDays: inactiveDaysThreshold,
      staleHours: inactiveStaleHours,
    });
    const warMetrics = computeWarMetrics(warRows, warWindowSize);
    const inactivePlayerCount = computeInactiveWarsPlayerCount(participationRows);
    const durationMs = Date.now() - startedAtMs;

    console.info(
      `[clan-health] guild=${input.guildId} clan=${canonicalClanTag} war_rows=${warRows.length} participation_rows=${participationRows.length} activity_rows=${activityRows.length} link_rows=${linkedRows.length} duration_ms=${durationMs}`
    );

    return {
      clanTag: canonicalClanTag,
      clanName: canonicalClanName,
      warMetrics,
      inactiveWars: {
        windowSize: inactiveWarWindowSize,
        warsAvailable: distinctFwaWars.length,
        warsSampled: selectedWarIds.length,
        inactivePlayerCount,
      },
      inactiveDays: activityAndLinks.inactiveDays,
      missingLinks: activityAndLinks.missingLinks,
      telemetry: {
        warRows: warRows.length,
        participationRows: participationRows.length,
        activityRows: activityRows.length,
        linkRows: linkedRows.length,
        durationMs,
      },
    };
  }
}
