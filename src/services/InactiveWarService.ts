import { prisma } from "../prisma";

type TrackedClanRow = {
  tag: string;
  name: string | null;
};

type ClanWarHistoryRow = {
  warId: number;
  clanTag: string;
  clanName: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
};

type ClanWarParticipationRow = {
  clanTag: string;
  playerTag: string;
  playerName: string | null;
  warId: string;
  missedBoth: boolean;
  trueStars: number;
  attackDelayMinutes: number | null;
  attackWindowMissed: boolean | null;
  warStartTime: Date;
  createdAt: Date;
};

export type InactiveWarRow = {
  clanTag: string;
  playerTag: string;
  playerName: string;
  missedWars: number;
  participationWars: number;
  totalTrueStars: number;
  avgAttackDelay: number | null;
  lateAttacks: number;
  warsAvailable: number;
};

export type InactiveWarSummary = {
  results: InactiveWarRow[];
  trackedTags: string[];
  trackedNameByTag: Map<string, string>;
  warnings: string[];
};

function normalizeClanTagInput(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function normalizePlayerName(playerName: string | null | undefined, playerTag: string): string {
  const trimmed = String(playerName ?? "").trim();
  return trimmed || playerTag;
}

function buildTrackedNameMap(trackedClans: TrackedClanRow[]): Map<string, string> {
  return new Map(
    trackedClans.map((clan) => {
      const clanTag = normalizeClanTagInput(clan.tag);
      return [clanTag, String(clan.name ?? "").trim() || clanTag] as const;
    })
  );
}

function buildRecentEndedWarSelection(input: {
  trackedClans: TrackedClanRow[];
  historyRows: ClanWarHistoryRow[];
  wars: number;
}): Map<
  string,
  {
    clanTag: string;
    clanName: string;
    warsAvailable: number;
    selectedWarIds: string[];
  }
> {
  const trackedNameByTag = buildTrackedNameMap(input.trackedClans);
  const selectionByClan = new Map<
    string,
    {
      clanTag: string;
      clanName: string;
      warsAvailable: number;
      selectedWarIds: string[];
    }
  >();

  for (const clan of input.trackedClans) {
    const clanTag = normalizeClanTagInput(clan.tag);
    if (!clanTag) continue;
    selectionByClan.set(clanTag, {
      clanTag,
      clanName: trackedNameByTag.get(clanTag) ?? clanTag,
      warsAvailable: 0,
      selectedWarIds: [],
    });
  }

  const sortedHistoryRows = [...input.historyRows].sort((a, b) => {
    const clanA = normalizeClanTagInput(a.clanTag);
    const clanB = normalizeClanTagInput(b.clanTag);
    if (clanA !== clanB) return clanA.localeCompare(clanB);
    const endA = a.warEndTime?.getTime() ?? 0;
    const endB = b.warEndTime?.getTime() ?? 0;
    if (endA !== endB) return endB - endA;
    const startA = a.warStartTime?.getTime() ?? 0;
    const startB = b.warStartTime?.getTime() ?? 0;
    if (startA !== startB) return startB - startA;
    return b.warId - a.warId;
  });

  for (const row of sortedHistoryRows) {
    const clanTag = normalizeClanTagInput(row.clanTag);
    const selection = selectionByClan.get(clanTag);
    if (!selection) continue;
    selection.warsAvailable += 1;
    if (selection.selectedWarIds.length < input.wars) {
      selection.selectedWarIds.push(String(row.warId));
    }
    const resolvedClanName = String(row.clanName ?? "").trim();
    if (resolvedClanName && selection.clanName === clanTag) {
      selection.clanName = resolvedClanName;
    }
  }

  return selectionByClan;
}

function aggregateInactiveWarRows(input: {
  selectionByClan: Map<
    string,
    {
      clanTag: string;
      clanName: string;
      warsAvailable: number;
      selectedWarIds: string[];
    }
  >;
  participationRows: ClanWarParticipationRow[];
}): InactiveWarRow[] {
  const rowsByKey = new Map<
    string,
    {
      clanTag: string;
      playerTag: string;
      playerName: string;
      missedWars: number;
      participationWars: number;
      totalTrueStars: number;
      avgAttackDelaySum: number;
      avgAttackDelayCount: number;
      lateAttacks: number;
      warsAvailable: number;
    }
  >();

  for (const row of input.participationRows) {
    const clanTag = normalizeClanTagInput(row.clanTag);
    const clanSelection = input.selectionByClan.get(clanTag);
    if (!clanSelection) continue;

    const playerTag = normalizeClanTagInput(row.playerTag);
    if (!playerTag) continue;

    const key = `${clanTag}:${playerTag}`;
    const existing = rowsByKey.get(key) ?? {
      clanTag,
      playerTag,
      playerName: normalizePlayerName(row.playerName, playerTag),
      missedWars: 0,
      participationWars: 0,
      totalTrueStars: 0,
      avgAttackDelaySum: 0,
      avgAttackDelayCount: 0,
      lateAttacks: 0,
      warsAvailable: clanSelection.warsAvailable,
    };

    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, existing);
    }

    if (existing.playerName === existing.playerTag) {
      const resolvedPlayerName = normalizePlayerName(row.playerName, playerTag);
      if (resolvedPlayerName) existing.playerName = resolvedPlayerName;
    }

    existing.participationWars += 1;
    if (row.missedBoth) existing.missedWars += 1;
    existing.totalTrueStars += Number(row.trueStars ?? 0);

    const attackDelayMinutes = row.attackDelayMinutes;
    if (attackDelayMinutes !== null && Number.isFinite(Number(attackDelayMinutes))) {
      existing.avgAttackDelaySum += Number(attackDelayMinutes);
      existing.avgAttackDelayCount += 1;
    }

    if (row.attackWindowMissed === true) {
      existing.lateAttacks += 1;
    }
  }

  return [...rowsByKey.values()]
    .filter((row) => row.participationWars > 0 && row.missedWars === row.participationWars)
    .map((row) => ({
      clanTag: row.clanTag,
      playerTag: row.playerTag,
      playerName: row.playerName,
      missedWars: row.missedWars,
      participationWars: row.participationWars,
      totalTrueStars: row.totalTrueStars,
      avgAttackDelay:
        row.avgAttackDelayCount > 0 ? row.avgAttackDelaySum / row.avgAttackDelayCount : null,
      lateAttacks: row.lateAttacks,
      warsAvailable: row.warsAvailable,
    }));
}

export class InactiveWarService {
  async listInactiveWarPlayers(input: {
    guildId: string;
    wars: number;
  }): Promise<InactiveWarSummary> {
    const trackedClans = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true, name: true },
    });
    const trackedTags = trackedClans.map((clan) => normalizeClanTagInput(clan.tag));
    const trackedNameByTag = buildTrackedNameMap(trackedClans);
    if (trackedTags.length === 0) {
      return { results: [], trackedTags, trackedNameByTag, warnings: [] };
    }

    const historyRows = await prisma.clanWarHistory.findMany({
      where: {
        clanTag: { in: trackedTags },
        warEndTime: { not: null },
        matchType: "FWA",
      },
      orderBy: [
        { clanTag: "asc" },
        { warEndTime: "desc" },
        { warStartTime: "desc" },
        { warId: "desc" },
      ],
      select: {
        warId: true,
        clanTag: true,
        clanName: true,
        warStartTime: true,
        warEndTime: true,
      },
    });
    const selectionByClan = buildRecentEndedWarSelection({
      trackedClans,
      historyRows,
      wars: input.wars,
    });
    const selectedWarIds = [
      ...new Set(
        [...selectionByClan.values()].flatMap((entry) => entry.selectedWarIds)
      ),
    ];

    const participationRows = selectedWarIds.length > 0
      ? await prisma.clanWarParticipation.findMany({
          where: {
            guildId: input.guildId,
            clanTag: { in: trackedTags },
            warId: { in: selectedWarIds },
            matchType: "FWA",
          },
          orderBy: [
            { clanTag: "asc" },
            { playerTag: "asc" },
            { warStartTime: "desc" },
            { createdAt: "desc" },
          ],
          select: {
            clanTag: true,
            playerTag: true,
            playerName: true,
            warId: true,
            missedBoth: true,
            trueStars: true,
            attackDelayMinutes: true,
            attackWindowMissed: true,
            warStartTime: true,
            createdAt: true,
          },
        })
      : [];

    const results = aggregateInactiveWarRows({
      selectionByClan,
      participationRows,
    });
    const warnings = trackedTags
      .map((clanTag) => {
        const selection = selectionByClan.get(clanTag);
        const warsAvailable = selection?.warsAvailable ?? 0;
        return warsAvailable < input.wars
          ? `${trackedNameByTag.get(clanTag) ?? clanTag}: only ${warsAvailable}/${input.wars} ended FWA wars tracked`
          : null;
      })
      .filter((value): value is string => value !== null);

    return { results, trackedTags, trackedNameByTag, warnings };
  }
}

export const buildRecentEndedWarSelectionForTest = buildRecentEndedWarSelection;
export const aggregateInactiveWarRowsForTest = aggregateInactiveWarRows;
