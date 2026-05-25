import { prisma } from "../prisma";
import { resolveFwaMatchStateEmoji } from "./FwaMatchStateEmojiService";

type TrackedClanRow = {
  tag: string;
  name: string | null;
  clanBadge: string | null;
};

type ClanWarHistoryRow = {
  warId: number;
  clanTag: string;
  clanName: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
  matchType: string | null;
  actualOutcome: string | null;
};

type ClanWarParticipationRow = {
  clanTag: string;
  playerTag: string;
  townHall: number | null;
  playerName: string | null;
  warId: string;
  missedBoth: boolean;
  trueStars: number;
  attackDelayMinutes: number | null;
  attackWindowMissed: boolean | null;
  warStartTime: Date;
  createdAt: Date;
};

export type InactiveWarMissedState = {
  warId: string;
  warStartTime: Date | null;
  warEndTime: Date | null;
  matchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null;
  outcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  emoji: string;
};

export type InactiveWarRow = {
  clanTag: string;
  playerTag: string;
  playerName: string;
  townHall: number | null;
  missedWars: number;
  participationWars: number;
  totalTrueStars: number;
  avgAttackDelay: number | null;
  lateAttacks: number;
  warsAvailable: number;
  missedWarStates: InactiveWarMissedState[];
};

export type InactiveWarSummary = {
  results: InactiveWarRow[];
  trackedTags: string[];
  trackedNameByTag: Map<string, string>;
  trackedBadgeByTag: Map<string, string | null>;
  warnings: string[];
  diagnosticNote: string | null;
};

export type InactiveWarMetricRow = Pick<
  InactiveWarRow,
  | "clanTag"
  | "playerTag"
  | "playerName"
  | "townHall"
  | "missedWars"
  | "participationWars"
  | "totalTrueStars"
  | "avgAttackDelay"
  | "lateAttacks"
  | "warsAvailable"
  | "missedWarStates"
>;

export type InactiveWarMetricMap = Map<string, InactiveWarMetricRow>;

function normalizeClanTagInput(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function normalizePlayerTagInput(input: string): string {
  return normalizeClanTagInput(input);
}

function buildClanTagQueryValues(trackedTags: string[]): string[] {
  return [...new Set(trackedTags.flatMap((tag) => [tag, `#${tag}`]))];
}

function buildPlayerTagQueryValues(playerTags: string[]): string[] {
  return [...new Set(playerTags.flatMap((tag) => [tag, `#${tag}`]))];
}

function normalizePositiveInteger(input: unknown): number | null {
  const numeric = Number(input);
  if (!Number.isFinite(numeric)) return null;
  const normalized = Math.trunc(numeric);
  return normalized > 0 ? normalized : null;
}

function normalizeInactiveWarMatchType(
  input: string | null | undefined,
): "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null {
  const normalized = String(input ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (
    normalized === "FWA" ||
    normalized === "BL" ||
    normalized === "MM" ||
    normalized === "SKIP"
  ) {
    return normalized;
  }
  return "UNKNOWN";
}

function normalizeInactiveWarOutcome(
  input: string | null | undefined,
): "WIN" | "LOSE" | "UNKNOWN" | null {
  const normalized = String(input ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === "WIN" || normalized === "LOSE") return normalized;
  return "UNKNOWN";
}

function normalizePlayerName(playerName: string | null | undefined, playerTag: string): string {
  const trimmed = String(playerName ?? "").trim();
  return trimmed || playerTag;
}

function buildTrackedNameMap(trackedClans: TrackedClanRow[]): Map<string, string> {
  const trackedNameByTag = new Map<string, string>();
  for (const clan of trackedClans) {
    const clanTag = normalizeClanTagInput(clan.tag);
    if (!clanTag) continue;
    const clanName = String(clan.name ?? "").trim() || clanTag;
    trackedNameByTag.set(clanTag, clanName);
    trackedNameByTag.set(`#${clanTag}`, clanName);
  }
  return trackedNameByTag;
}

function buildTrackedBadgeMap(trackedClans: TrackedClanRow[]): Map<string, string | null> {
  const trackedBadgeByTag = new Map<string, string | null>();
  for (const clan of trackedClans) {
    const clanTag = normalizeClanTagInput(clan.tag);
    if (!clanTag) continue;
    const clanBadge = String(clan.clanBadge ?? "").trim();
    trackedBadgeByTag.set(clanTag, clanBadge.length > 0 ? clanBadge : null);
    trackedBadgeByTag.set(`#${clanTag}`, clanBadge.length > 0 ? clanBadge : null);
  }
  return trackedBadgeByTag;
}

function buildTrackedTagList(trackedClans: TrackedClanRow[]): string[] {
  const trackedTags: string[] = [];
  const seenTags = new Set<string>();
  for (const clan of trackedClans) {
    const clanTag = normalizeClanTagInput(clan.tag);
    if (!clanTag || seenTags.has(clanTag)) continue;
    seenTags.add(clanTag);
    trackedTags.push(clanTag);
  }
  return trackedTags;
}

function buildInactiveWarDiagnosticNote(input: {
  endedWarCount: number;
  participationRowCount: number;
}): string {
  return `Diagnostic: ended wars found ${input.endedWarCount > 0 ? "yes" : "no"} (${input.endedWarCount}), participation rows found ${input.participationRowCount > 0 ? "yes" : "no"} (${input.participationRowCount}).`;
}

function buildInactiveWarFilterMismatchDiagnosticNote(clanTag: string): string {
  return `Diagnostic: clan filter ${clanTag} matched no tracked clan.`;
}

function compareTownHallFallbackRows(
  a: {
    sameClan: boolean;
    warEndTime: Date | null;
    warStartTime: Date | null;
    createdAt: Date | null;
  },
  b: {
    sameClan: boolean;
    warEndTime: Date | null;
    warStartTime: Date | null;
    createdAt: Date | null;
  },
): number {
  if (a.sameClan !== b.sameClan) {
    return a.sameClan ? 1 : -1;
  }

  const endA = a.warEndTime?.getTime() ?? 0;
  const endB = b.warEndTime?.getTime() ?? 0;
  if (endA !== endB) return endB - endA;

  const startA = a.warStartTime?.getTime() ?? 0;
  const startB = b.warStartTime?.getTime() ?? 0;
  if (startA !== startB) return startB - startA;

  const createdA = a.createdAt?.getTime() ?? 0;
  const createdB = b.createdAt?.getTime() ?? 0;
  if (createdA !== createdB) return createdB - createdA;

  return 0;
}

function buildInactiveWarMissedState(row: ClanWarHistoryRow): InactiveWarMissedState {
  const matchType = normalizeInactiveWarMatchType(row.matchType);
  const outcome = normalizeInactiveWarOutcome(row.actualOutcome);
  return {
    warId: String(row.warId),
    warStartTime: row.warStartTime ?? null,
    warEndTime: row.warEndTime ?? null,
    matchType,
    outcome,
    emoji: resolveFwaMatchStateEmoji({
      matchType,
      outcome,
    }),
  };
}

function compareInactiveWarMissedStates(
  a: InactiveWarMissedState,
  b: InactiveWarMissedState,
): number {
  const endA = a.warEndTime?.getTime() ?? 0;
  const endB = b.warEndTime?.getTime() ?? 0;
  if (endA !== endB) return endB - endA;

  const startA = a.warStartTime?.getTime() ?? 0;
  const startB = b.warStartTime?.getTime() ?? 0;
  if (startA !== startB) return startB - startA;

  const warIdA = Number(a.warId);
  const warIdB = Number(b.warId);
  if (Number.isFinite(warIdA) && Number.isFinite(warIdB) && warIdA !== warIdB) {
    return warIdB - warIdA;
  }
  return b.warId.localeCompare(a.warId);
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
    selectedWarCount: number;
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
      selectedWarCount: number;
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
      selectedWarCount: 0,
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
    selection.selectedWarCount = selection.selectedWarIds.length;
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
      selectedWarCount: number;
    }
  >;
  historyByWarId: Map<string, ClanWarHistoryRow>;
  participationRows: ClanWarParticipationRow[];
  consecutive?: boolean;
}): InactiveWarRow[] {
  const rowsByKey = new Map<
    string,
    {
      clanTag: string;
      playerTag: string;
      playerName: string;
      townHall: number | null;
      missedWars: number;
      participationWars: number;
      requiredWars: number;
      totalTrueStars: number;
      avgAttackDelaySum: number;
      avgAttackDelayCount: number;
      lateAttacks: number;
      warsAvailable: number;
      missedWarStates: InactiveWarMissedState[];
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
      townHall: row.townHall ?? null,
      missedWars: 0,
      participationWars: 0,
      requiredWars: clanSelection.selectedWarCount,
      totalTrueStars: 0,
      avgAttackDelaySum: 0,
      avgAttackDelayCount: 0,
      lateAttacks: 0,
      warsAvailable: clanSelection.warsAvailable,
      missedWarStates: [] as InactiveWarMissedState[],
    };

    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, existing);
    }

    if (existing.playerName === existing.playerTag) {
      const resolvedPlayerName = normalizePlayerName(row.playerName, playerTag);
      if (resolvedPlayerName) existing.playerName = resolvedPlayerName;
    }
    if (existing.townHall === null && row.townHall !== null && row.townHall !== undefined) {
      existing.townHall = row.townHall;
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

    if (row.missedBoth) {
      const historyRow = input.historyByWarId.get(String(row.warId));
      existing.missedWarStates.push(
        historyRow
          ? buildInactiveWarMissedState(historyRow)
          : {
              warId: String(row.warId),
              warStartTime: row.warStartTime ?? null,
              warEndTime: null,
              matchType: null,
              outcome: null,
              emoji: resolveFwaMatchStateEmoji({ matchType: null, outcome: null }),
            },
      );
    }
  }

  return [...rowsByKey.values()]
    .filter((row) => {
      if (row.participationWars <= 0 || row.missedWars <= 0) return false;
      if (!input.consecutive) return true;
      return (
        row.requiredWars > 0 &&
        row.participationWars === row.requiredWars &&
        row.missedWars === row.requiredWars
      );
    })
    .map((row) => ({
      clanTag: row.clanTag,
      playerTag: row.playerTag,
      playerName: row.playerName,
      townHall: row.townHall,
      missedWars: row.missedWars,
      participationWars: row.participationWars,
      totalTrueStars: row.totalTrueStars,
      avgAttackDelay:
        row.avgAttackDelayCount > 0 ? row.avgAttackDelaySum / row.avgAttackDelayCount : null,
      lateAttacks: row.lateAttacks,
      warsAvailable: row.warsAvailable,
      missedWarStates: [...row.missedWarStates].sort(compareInactiveWarMissedStates),
    }));
}

async function loadInactiveWarTownHallFallbacks(input: {
  guildId: string;
  trackedClanTags: string[];
  selectedWarIds: string[];
  missingRows: Array<{
    clanTag: string;
    playerTag: string;
  }>;
}): Promise<Map<string, number>> {
  const fallbackTownHallByPlayerTag = new Map<string, number>();
  const missingByPlayerTag = new Map<string, Set<string>>();
  const missingPlayerTags: string[] = [];
  for (const row of input.missingRows) {
    const playerTag = normalizePlayerTagInput(row.playerTag);
    const clanTag = normalizeClanTagInput(row.clanTag);
    if (!playerTag || !clanTag) continue;
    const existing = missingByPlayerTag.get(playerTag) ?? new Set<string>();
    if (!missingByPlayerTag.has(playerTag)) {
      missingByPlayerTag.set(playerTag, existing);
      missingPlayerTags.push(playerTag);
    }
    existing.add(clanTag);
  }

  if (missingPlayerTags.length === 0) {
    return fallbackTownHallByPlayerTag;
  }

  const playerTagQueryValues = buildPlayerTagQueryValues(missingPlayerTags);
  const trackedClanTagValues = buildClanTagQueryValues(input.trackedClanTags);
  const selectedWarIds = [...new Set(input.selectedWarIds.map((warId) => String(warId).trim()).filter(Boolean))];

  if (selectedWarIds.length > 0) {
    const historicalRows = await prisma.clanWarParticipation.findMany({
      where: {
        guildId: input.guildId,
        playerTag: { in: playerTagQueryValues },
        clanTag: { in: trackedClanTagValues },
        warId: { notIn: selectedWarIds },
        townHall: { not: null },
      },
      orderBy: [
        { playerTag: "asc" },
        { clanTag: "asc" },
        { warEndTime: "desc" },
        { warStartTime: "desc" },
        { createdAt: "desc" },
      ],
      select: {
        playerTag: true,
        clanTag: true,
        townHall: true,
        warEndTime: true,
        warStartTime: true,
        createdAt: true,
      },
    });

    const historicalBestByPlayerTag = new Map<
      string,
      {
        townHall: number;
        sameClan: boolean;
        warEndTime: Date | null;
        warStartTime: Date | null;
        createdAt: Date | null;
      }
    >();
    for (const row of historicalRows as Array<{
      playerTag: string;
      clanTag: string;
      townHall: number | null;
      warEndTime: Date | null;
      warStartTime: Date | null;
      createdAt: Date | null;
    }>) {
      const playerTag = normalizePlayerTagInput(row.playerTag);
      const clanTag = normalizeClanTagInput(row.clanTag);
      const townHall = row.townHall;
      if (!playerTag || townHall === null || townHall === undefined) continue;
      const missingClanTags = missingByPlayerTag.get(playerTag);
      if (!missingClanTags) continue;
      const candidate = {
        townHall,
        sameClan: missingClanTags.has(clanTag),
        warEndTime: row.warEndTime ?? null,
        warStartTime: row.warStartTime ?? null,
        createdAt: row.createdAt ?? null,
      };
      const existing = historicalBestByPlayerTag.get(playerTag) ?? null;
      if (!existing || compareTownHallFallbackRows(candidate, existing) > 0) {
        historicalBestByPlayerTag.set(playerTag, candidate);
      }
    }
    for (const [playerTag, candidate] of historicalBestByPlayerTag.entries()) {
      fallbackTownHallByPlayerTag.set(playerTag, candidate.townHall);
    }
  }

  const unresolvedPlayerTags = missingPlayerTags.filter((playerTag) => !fallbackTownHallByPlayerTag.has(playerTag));
  if (unresolvedPlayerTags.length === 0) {
    return fallbackTownHallByPlayerTag;
  }

  const unresolvedPlayerTagQueryValues = buildPlayerTagQueryValues(unresolvedPlayerTags);
  const playerCurrentRows = await prisma.playerCurrent.findMany({
    where: {
      playerTag: { in: unresolvedPlayerTagQueryValues },
      townHall: { not: null },
    },
    select: {
      playerTag: true,
      townHall: true,
    },
  });
  for (const row of playerCurrentRows as Array<{ playerTag: string; townHall: number | null }>) {
    const playerTag = normalizePlayerTagInput(row.playerTag);
    const townHall = row.townHall;
    if (!playerTag || townHall === null || townHall === undefined) continue;
    if (!fallbackTownHallByPlayerTag.has(playerTag)) {
      fallbackTownHallByPlayerTag.set(playerTag, townHall);
    }
  }

  const unresolvedAfterPlayerCurrent = unresolvedPlayerTags.filter(
    (playerTag) => !fallbackTownHallByPlayerTag.has(playerTag),
  );
  if (unresolvedAfterPlayerCurrent.length === 0) {
    return fallbackTownHallByPlayerTag;
  }

  const unresolvedAfterPlayerCurrentQueryValues = buildPlayerTagQueryValues(unresolvedAfterPlayerCurrent);
  const fwaClanMemberRows = await prisma.fwaClanMemberCurrent.findMany({
    where: {
      playerTag: { in: unresolvedAfterPlayerCurrentQueryValues },
      clanTag: { in: trackedClanTagValues },
      townHall: { not: null },
    },
    select: {
      playerTag: true,
      townHall: true,
    },
  });
  for (const row of fwaClanMemberRows as Array<{ playerTag: string; townHall: number | null }>) {
    const playerTag = normalizePlayerTagInput(row.playerTag);
    const townHall = row.townHall;
    if (!playerTag || townHall === null || townHall === undefined) continue;
    if (!fallbackTownHallByPlayerTag.has(playerTag)) {
      fallbackTownHallByPlayerTag.set(playerTag, townHall);
    }
  }

  const unresolvedAfterFwaMembers = unresolvedAfterPlayerCurrent.filter(
    (playerTag) => !fallbackTownHallByPlayerTag.has(playerTag),
  );
  if (unresolvedAfterFwaMembers.length === 0) {
    return fallbackTownHallByPlayerTag;
  }

  const unresolvedAfterFwaMembersQueryValues = buildPlayerTagQueryValues(unresolvedAfterFwaMembers);
  const fwaPlayerCatalogRows = await prisma.fwaPlayerCatalog.findMany({
    where: {
      playerTag: { in: unresolvedAfterFwaMembersQueryValues },
      latestTownHall: { not: null },
    },
    select: {
      playerTag: true,
      latestTownHall: true,
    },
  });
  for (const row of fwaPlayerCatalogRows as Array<{ playerTag: string; latestTownHall: number | null }>) {
    const playerTag = normalizePlayerTagInput(row.playerTag);
    const townHall = normalizePositiveInteger(row.latestTownHall);
    if (!playerTag || townHall === null) continue;
    if (!fallbackTownHallByPlayerTag.has(playerTag)) {
      fallbackTownHallByPlayerTag.set(playerTag, townHall);
    }
  }

  const unresolvedAfterCatalog = unresolvedAfterFwaMembers.filter(
    (playerTag) => !fallbackTownHallByPlayerTag.has(playerTag),
  );
  if (unresolvedAfterCatalog.length === 0) {
    return fallbackTownHallByPlayerTag;
  }

  const unresolvedAfterCatalogQueryValues = buildPlayerTagQueryValues(unresolvedAfterCatalog);
  const rosterMemberRows = await prisma.fwaTrackedClanWarRosterMemberCurrent.findMany({
    where: {
      playerTag: { in: unresolvedAfterCatalogQueryValues },
      clanTag: { in: trackedClanTagValues },
    },
    select: {
      playerTag: true,
      townHall: true,
    },
  });
  for (const row of rosterMemberRows as Array<{ playerTag: string; townHall: number | null }>) {
    const playerTag = normalizePlayerTagInput(row.playerTag);
    const townHall = row.townHall;
    if (!playerTag || townHall === null || townHall === undefined) continue;
    if (!fallbackTownHallByPlayerTag.has(playerTag)) {
      fallbackTownHallByPlayerTag.set(playerTag, townHall);
    }
  }

  return fallbackTownHallByPlayerTag;
}

export class InactiveWarService {
  async listInactiveWarPlayers(input: {
    guildId: string;
    wars: number;
    clanTag?: string | null;
    consecutive?: boolean;
  }): Promise<InactiveWarSummary> {
    const trackedClans = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true, name: true, clanBadge: true },
    });
    const normalizedClanFilter = normalizeClanTagInput(input.clanTag ?? "");
    const selectedTrackedClans = normalizedClanFilter
      ? trackedClans.filter(
          (clan) => normalizeClanTagInput(clan.tag) === normalizedClanFilter,
        )
      : trackedClans;
    const trackedTags = buildTrackedTagList(selectedTrackedClans);
    const trackedNameByTag = buildTrackedNameMap(selectedTrackedClans);
    const trackedBadgeByTag = buildTrackedBadgeMap(selectedTrackedClans);
    if (normalizedClanFilter && trackedTags.length === 0) {
      return {
        results: [],
        trackedTags,
        trackedNameByTag,
        trackedBadgeByTag,
        warnings: [
          buildInactiveWarFilterMismatchDiagnosticNote(
            `#${normalizedClanFilter}`,
          ),
        ],
        diagnosticNote: buildInactiveWarFilterMismatchDiagnosticNote(
          `#${normalizedClanFilter}`,
        ),
      };
    }
    if (trackedTags.length === 0) {
      return {
        results: [],
        trackedTags,
        trackedNameByTag,
        trackedBadgeByTag,
        warnings: [],
        diagnosticNote: null,
      };
    }
    const trackedClanTagValues = buildClanTagQueryValues(trackedTags);

    const historyRows = await prisma.clanWarHistory.findMany({
      where: {
        clanTag: { in: trackedClanTagValues },
        warEndTime: { not: null },
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
        matchType: true,
        actualOutcome: true,
      },
    });
    const selectionByClan = buildRecentEndedWarSelection({
      trackedClans: selectedTrackedClans,
      historyRows,
      wars: input.wars,
    });
    const historyByWarId = new Map(historyRows.map((row) => [String(row.warId), row]));
    const selectedWarIds = [
      ...new Set(
        [...selectionByClan.values()].flatMap((entry) => entry.selectedWarIds)
      ),
    ];

    const participationRows = selectedWarIds.length > 0
      ? await prisma.clanWarParticipation.findMany({
          where: {
            guildId: input.guildId,
            clanTag: { in: trackedClanTagValues },
            warId: { in: selectedWarIds },
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
            townHall: true,
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
      historyByWarId,
      participationRows,
      consecutive: input.consecutive === true,
    });
    const missingTownHallRows = results
      .filter((row) => row.townHall === null)
      .map((row) => ({ clanTag: row.clanTag, playerTag: row.playerTag }));
    if (missingTownHallRows.length > 0) {
      const fallbackTownHallByPlayerTag = await loadInactiveWarTownHallFallbacks({
        guildId: input.guildId,
        trackedClanTags: trackedTags,
        selectedWarIds,
        missingRows: missingTownHallRows,
      });
      for (const row of results) {
        if (row.townHall !== null) continue;
        const fallbackTownHall = fallbackTownHallByPlayerTag.get(row.playerTag) ?? null;
        if (fallbackTownHall !== null) {
          row.townHall = fallbackTownHall;
        }
      }
    }
    const diagnosticNote =
      results.length === 0
        ? buildInactiveWarDiagnosticNote({
            endedWarCount: historyRows.length,
            participationRowCount: participationRows.length,
          })
        : null;
    const warnings = trackedTags
      .map((clanTag) => {
        const selection = selectionByClan.get(clanTag);
        const warsAvailable = selection?.warsAvailable ?? 0;
        return warsAvailable < input.wars
          ? `${trackedNameByTag.get(clanTag) ?? clanTag}: only ${warsAvailable}/${input.wars} ended tracked wars available`
          : null;
      })
      .filter((value): value is string => value !== null);

    return { results, trackedTags, trackedNameByTag, trackedBadgeByTag, warnings, diagnosticNote };
  }

  async buildInactiveWarMetricByPlayerTag(input: {
    guildId: string;
    wars: number;
    clanTag?: string | null;
    consecutive?: boolean;
  }): Promise<{
    metricsByPlayerTag: InactiveWarMetricMap;
    summary: InactiveWarSummary;
  }> {
    const summary = await this.listInactiveWarPlayers(input);
    const metricsByPlayerTag = new Map<string, InactiveWarMetricRow>();
    for (const row of summary.results) {
      const normalizedPlayerTag = normalizePlayerTagInput(row.playerTag);
      if (!normalizedPlayerTag) continue;
      metricsByPlayerTag.set(`#${normalizedPlayerTag}`, row);
    }
    return { metricsByPlayerTag, summary };
  }
}

export const buildRecentEndedWarSelectionForTest = buildRecentEndedWarSelection;
export const aggregateInactiveWarRowsForTest = aggregateInactiveWarRows;
export const buildInactiveWarMetricByPlayerTagForTest = (
  service: InactiveWarService,
  input: {
    guildId: string;
    wars: number;
    clanTag?: string | null;
  },
) => service.buildInactiveWarMetricByPlayerTag(input);
