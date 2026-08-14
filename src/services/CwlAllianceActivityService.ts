import { prisma } from "../prisma";
import { normalizeClashTagWithHash } from "../helper/clashTag";

export type CwlAllianceActivityInput = {
  season: string;
  guildId?: string | null;
};

export type CwlAllianceActivitySourceWar = {
  warId: number;
  clanTag: string;
  clanName: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  matchType: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
};

export type CwlAllianceActivityPrePlayer = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
  homeFwaClanTag: string;
};

export type CwlAllianceActivityParticipant = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
  cwlClanTag: string;
  daysParticipated: number;
};

export type CwlAllianceActivityBothPlayer = CwlAllianceActivityPrePlayer &
  Pick<CwlAllianceActivityParticipant, "cwlClanTag" | "daysParticipated">;

export type CwlAllianceActivityPostPlayer = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
  postCwlFwaClanTag: string;
};

export type CwlAllianceActivityResult = {
  season: string;
  cwlWindow: {
    startsAt: Date | null;
    endsAt: Date | null;
    timingCoverageComplete: boolean;
    missingTimingDetails: string[];
  };
  coverage: {
    cwlClanCount: number;
    resolvedEventCount: number;
    unresolvedCwlClans: Array<{
      clanTag: string;
      clanName: string | null;
      reason: string;
    }>;
    preFwaClansExpected: number;
    preFwaClansCovered: number;
    postCoverageComplete: boolean;
    coveredPostClanCount: number;
    expectedPostClanCount: number;
    duplicateReconciliations: number;
  };
  totals: {
    preFwaCount: number;
    cwlParticipantCount: number;
    bothCount: number;
    fwaOnlyCount: number;
    cwlOnlyCount: number;
  };
  percentages: {
    cwlParticipantsOfPreFwa: number | null;
    bothOfPreFwa: number | null;
    fwaOnlyOfPreFwa: number | null;
    cwlOnlyOfCwl: number | null;
  };
  participationDayHistogram: Record<string, number>;
  unexpectedParticipationDays: Record<string, number>;
  preCwlClans: Array<{
    clanTag: string;
    clanName: string | null;
    coverageAvailable: boolean;
    unavailableReason: string | null;
    sourcePreCwlWar: CwlAllianceActivitySourceWar | null;
    preCwlRosterCount: number;
    sourcePreCwlRosterCount: number;
    cwlParticipantCount: number;
    fwaOnlyCount: number;
    bothCount: number;
    returnedAfterCwlCount: number | null;
    retentionRate: number | null;
    sourcePostCwlWar: CwlAllianceActivitySourceWar | null;
  }>;
  players: {
    preFwa: CwlAllianceActivityPrePlayer[];
    cwl: CwlAllianceActivityParticipant[];
    both: CwlAllianceActivityBothPlayer[];
    fwaOnly: CwlAllianceActivityPrePlayer[];
    cwlOnly: CwlAllianceActivityParticipant[];
  };
  movementSummary: Array<{
    homeFwaClanTag: string;
    cwlClanTag: string;
    accountCount: number;
  }>;
  postCwlRetention: {
    available: boolean;
    returnedAfterCwl: CwlAllianceActivityPrePlayer[];
    notReturnedAfterCwl: CwlAllianceActivityPrePlayer[];
    newPostCwlFwa: CwlAllianceActivityPostPlayer[];
    retentionRate: number | null;
  };
};

type ActivityDb = {
  trackedClan: { findMany: (args?: any) => Promise<any[]> };
  cwlTrackedClan: { findMany: (args?: any) => Promise<any[]> };
  cwlEventClan: { findMany: (args?: any) => Promise<any[]> };
  currentCwlRound: { findMany: (args?: any) => Promise<any[]> };
  currentCwlPrepSnapshot: { findMany: (args?: any) => Promise<any[]> };
  cwlRoundHistory: { findMany: (args?: any) => Promise<any[]> };
  cwlPlayerClanSeason: { findMany: (args?: any) => Promise<any[]> };
  clanWarHistory: { findMany: (args?: any) => Promise<any[]> };
  clanWarParticipation: { findMany: (args?: any) => Promise<any[]> };
};

const activityDb = prisma as unknown as ActivityDb;

/** Purpose: build a deterministic, read-only alliance CWL activity result from persisted owners. */
export class CwlAllianceActivityService {
  constructor(private readonly db: ActivityDb = activityDb) {}

  async getActivity(input: CwlAllianceActivityInput): Promise<CwlAllianceActivityResult> {
    const startedAtMs = Date.now();
    const season = normalizeSeason(input.season);
    const guildId = String(input.guildId ?? "").trim() || null;
    const trackedCwlClans = await this.db.cwlTrackedClan.findMany({
      where: { season },
      orderBy: [{ tag: "asc" }, { id: "asc" }],
      select: { tag: true, name: true },
    });
    const cwlClans = normalizeTrackedCwlClans(trackedCwlClans);
    const eventResolution = await resolveHistoricalEvents({
      db: this.db,
      season,
      cwlClans,
    });
    const cwlWindow = await resolveCwlWindow({
      db: this.db,
      eventInstanceIds: eventResolution.eventInstanceIds,
    });
    const trackedFwaClans = normalizeTrackedFwaClans(
      await this.db.trackedClan.findMany({
        orderBy: [{ tag: "asc" }, { id: "asc" }],
        select: { tag: true, name: true },
      }),
    );

    const preHistoryRows = cwlWindow.startsAt
      ? await this.db.clanWarHistory.findMany({
          where: {
            clanTag: { in: trackedFwaClans.map((clan) => clan.clanTag) },
            matchType: "FWA",
            warEndTime: { not: null, lte: cwlWindow.startsAt },
          },
          orderBy: [{ warEndTime: "desc" }, { warStartTime: "desc" }, { warId: "desc" }],
        })
      : [];
    const preWarSelections = selectPreCwlWars(trackedFwaClans, preHistoryRows);
    const preParticipationRows = await loadParticipationRows({
      db: this.db,
      warIds: preWarSelections
        .map((selection) => selection.war?.warId)
        .filter((warId): warId is number => Number.isInteger(warId)),
      guildId,
    });
    const preCwl = buildPreCwlCohort({
      trackedFwaClans,
      selections: preWarSelections,
      participationRows: preParticipationRows,
      startsAt: cwlWindow.startsAt,
    });

    const cwlRows = eventResolution.eventInstanceIds.length > 0
      ? await this.db.cwlPlayerClanSeason.findMany({
          where: {
            eventInstanceId: { in: eventResolution.eventInstanceIds },
            daysParticipated: { gt: 0 },
          },
          orderBy: [{ playerTag: "asc" }, { eventInstanceId: "asc" }, { cwlClanTag: "asc" }],
          select: {
            eventInstanceId: true,
            playerTag: true,
            playerName: true,
            townHall: true,
            cwlClanTag: true,
            daysParticipated: true,
          },
        })
      : [];
    const cwl = buildCwlParticipantCohort(cwlRows);
    const categories = buildCategories(preCwl.players, cwl.players);

    const post = cwlWindow.endsAt
      ? await buildPostCwlRetention({
          db: this.db,
          trackedFwaClans,
          preCwl,
          endsAt: cwlWindow.endsAt,
          guildId,
        })
      : emptyPostCwlRetention(preCwl.coveredClanCount);

    const result: CwlAllianceActivityResult = {
      season,
      cwlWindow,
      coverage: {
        cwlClanCount: cwlClans.length,
        resolvedEventCount: eventResolution.eventInstanceIds.length,
        unresolvedCwlClans: eventResolution.unresolvedCwlClans,
        preFwaClansExpected: trackedFwaClans.length,
        preFwaClansCovered: preCwl.coveredClanCount,
        postCoverageComplete: post.postCoverageComplete,
        coveredPostClanCount: post.coveredPostClanCount,
        expectedPostClanCount: post.expectedPostClanCount,
        duplicateReconciliations:
          preCwl.duplicateReconciliations + cwl.duplicateReconciliations + post.duplicateReconciliations,
      },
      totals: {
        preFwaCount: categories.preFwa.length,
        cwlParticipantCount: categories.cwl.length,
        bothCount: categories.both.length,
        fwaOnlyCount: categories.fwaOnly.length,
        cwlOnlyCount: categories.cwlOnly.length,
      },
      percentages: {
        cwlParticipantsOfPreFwa: percentage(categories.both.length, categories.preFwa.length),
        bothOfPreFwa: percentage(categories.both.length, categories.preFwa.length),
        fwaOnlyOfPreFwa: percentage(categories.fwaOnly.length, categories.preFwa.length),
        cwlOnlyOfCwl: percentage(categories.cwlOnly.length, categories.cwl.length),
      },
      participationDayHistogram: cwl.histogram,
      unexpectedParticipationDays: cwl.unexpectedDays,
      preCwlClans: buildPreCwlClanSummaries({
        trackedFwaClans,
        preCwl,
        cwlPlayers: cwl.players,
        bothPlayers: categories.both,
        fwaOnlyPlayers: categories.fwaOnly,
        postByClan: post.byClan,
      }),
      players: {
        preFwa: categories.preFwa,
        cwl: categories.cwl,
        both: categories.both,
        fwaOnly: categories.fwaOnly,
        cwlOnly: categories.cwlOnly,
      },
      movementSummary: buildMovementSummary(categories.both),
      postCwlRetention: {
        available: post.available,
        returnedAfterCwl: post.returnedAfterCwl,
        notReturnedAfterCwl: post.notReturnedAfterCwl,
        newPostCwlFwa: post.newPostCwlFwa,
        retentionRate: post.retentionRate,
      },
    };

    console.info(
      `[cwl-alliance-activity] event=activity_summary season=${season} cwl_clans=${cwlClans.length} resolved_events=${eventResolution.eventInstanceIds.length} pre_fwa_clans_covered=${preCwl.coveredClanCount} pre_fwa_accounts=${result.totals.preFwaCount} cwl_participants=${result.totals.cwlParticipantCount} both=${result.totals.bothCount} fwa_only=${result.totals.fwaOnlyCount} cwl_only=${result.totals.cwlOnlyCount} post_fwa_clans_covered=${post.coveredPostClanCount} duplicate_reconciliations=${result.coverage.duplicateReconciliations} duration_ms=${Date.now() - startedAtMs}`,
    );
    return result;
  }
}

export const cwlAllianceActivityService = new CwlAllianceActivityService();

type NormalizedClan = { clanTag: string; clanName: string | null };
type HistoricalEventResolution = {
  eventInstanceIds: string[];
  unresolvedCwlClans: Array<{ clanTag: string; clanName: string | null; reason: string }>;
};

/** Purpose: normalize the season-scoped CWL registry into stable clan order. */
function normalizeTrackedCwlClans(rows: any[]): NormalizedClan[] {
  const byTag = new Map<string, NormalizedClan>();
  for (const row of rows) {
    const clanTag = normalizeClashTagWithHash(row?.tag);
    if (!clanTag || byTag.has(clanTag)) continue;
    byTag.set(clanTag, { clanTag, clanName: normalizeNullableName(row?.name) });
  }
  return [...byTag.values()].sort(compareClanTags);
}

/** Purpose: normalize the current tracked FWA registry into stable clan order. */
function normalizeTrackedFwaClans(rows: any[]): NormalizedClan[] {
  const byTag = new Map<string, NormalizedClan>();
  for (const row of rows) {
    const clanTag = normalizeClashTagWithHash(row?.tag);
    if (!clanTag || byTag.has(clanTag)) continue;
    byTag.set(clanTag, { clanTag, clanName: normalizeNullableName(row?.name) });
  }
  return [...byTag.values()].sort(compareClanTags);
}

/** Purpose: resolve the latest persisted event for each requested historical CWL clan. */
async function resolveHistoricalEvents(input: {
  db: ActivityDb;
  season: string;
  cwlClans: NormalizedClan[];
}): Promise<HistoricalEventResolution> {
  if (input.cwlClans.length <= 0) {
    return { eventInstanceIds: [], unresolvedCwlClans: [] };
  }
  const rows = await input.db.cwlEventClan.findMany({
    where: {
      season: input.season,
      clanTag: { in: input.cwlClans.map((clan) => clan.clanTag) },
    },
    select: {
      id: true,
      eventInstanceId: true,
      clanTag: true,
      firstObservedAt: true,
      lastObservedAt: true,
      eventInstance: {
        select: {
          id: true,
          season: true,
          firstObservedAt: true,
          lastObservedAt: true,
        },
      },
    },
  });
  const rowsByClan = new Map<string, any[]>();
  for (const row of rows) {
    const clanTag = normalizeClashTagWithHash(row?.clanTag);
    if (!clanTag || row?.eventInstance?.season !== input.season) continue;
    const candidates = rowsByClan.get(clanTag) ?? [];
    candidates.push(row);
    rowsByClan.set(clanTag, candidates);
  }
  const selectedEventIds = new Set<string>();
  const unresolvedCwlClans: HistoricalEventResolution["unresolvedCwlClans"] = [];
  for (const clan of input.cwlClans) {
    const candidates = rowsByClan.get(clan.clanTag) ?? [];
    candidates.sort(compareHistoricalEventRows);
    const selected = candidates[0];
    if (!selected?.eventInstanceId) {
      unresolvedCwlClans.push({
        clanTag: clan.clanTag,
        clanName: clan.clanName,
        reason: "NO_HISTORICAL_EVENT",
      });
      continue;
    }
    selectedEventIds.add(String(selected.eventInstanceId));
  }
  return {
    eventInstanceIds: [...selectedEventIds].sort((a, b) => a.localeCompare(b)),
    unresolvedCwlClans,
  };
}

/** Purpose: order historical event candidates by persisted observation recency and stable IDs. */
function compareHistoricalEventRows(a: any, b: any): number {
  const byClanLastObserved = compareDatesDesc(a?.lastObservedAt, b?.lastObservedAt);
  if (byClanLastObserved !== 0) return byClanLastObserved;
  const byEventLastObserved = compareDatesDesc(
    a?.eventInstance?.lastObservedAt,
    b?.eventInstance?.lastObservedAt,
  );
  if (byEventLastObserved !== 0) return byEventLastObserved;
  const byClanFirstObserved = compareDatesDesc(a?.firstObservedAt, b?.firstObservedAt);
  if (byClanFirstObserved !== 0) return byClanFirstObserved;
  const byEventFirstObserved = compareDatesDesc(
    a?.eventInstance?.firstObservedAt,
    b?.eventInstance?.firstObservedAt,
  );
  if (byEventFirstObserved !== 0) return byEventFirstObserved;
  return String(b?.eventInstanceId ?? b?.id ?? "").localeCompare(
    String(a?.eventInstanceId ?? a?.id ?? ""),
  );
}

type CwlWindow = CwlAllianceActivityResult["cwlWindow"];

/** Purpose: derive the CWL window from Round 1 and ended Round 7 owners without inventing ongoing end times. */
async function resolveCwlWindow(input: {
  db: ActivityDb;
  eventInstanceIds: string[];
}): Promise<CwlWindow> {
  if (input.eventInstanceIds.length <= 0) {
    return {
      startsAt: null,
      endsAt: null,
      timingCoverageComplete: false,
      missingTimingDetails: ["NO_RESOLVED_EVENTS"],
    };
  }
  const where = { eventInstanceId: { in: input.eventInstanceIds } };
  const [currentRows, prepRows, historyRows] = await Promise.all([
    input.db.currentCwlRound.findMany({ where }),
    input.db.currentCwlPrepSnapshot.findMany({ where }),
    input.db.cwlRoundHistory.findMany({ where }),
  ]);
  const allRows = [...currentRows, ...prepRows, ...historyRows];
  const rowsByEvent = new Map<string, any[]>();
  for (const row of allRows) {
    const eventInstanceId = String(row?.eventInstanceId ?? "");
    if (!eventInstanceId) continue;
    const rows = rowsByEvent.get(eventInstanceId) ?? [];
    rows.push(row);
    rowsByEvent.set(eventInstanceId, rows);
  }
  const starts: Date[] = [];
  const ends: Date[] = [];
  const missingTimingDetails: string[] = [];
  for (const eventInstanceId of input.eventInstanceIds) {
    const rows = rowsByEvent.get(eventInstanceId) ?? [];
    const roundOneRows = rows.filter((row) => Number(row?.roundDay) === 1);
    const startCandidates = roundOneRows
      .map((row) => asDate(row?.preparationStartTime) ?? asDate(row?.startTime))
      .filter((value): value is Date => Boolean(value));
    const finalEndedRows = rows.filter(
      (row) => Number(row?.roundDay) === 7 && isEndedCwlRoundState(row?.roundState),
    );
    const endCandidates = finalEndedRows
      .map((row) => asDate(row?.endTime))
      .filter((value): value is Date => Boolean(value));
    if (startCandidates.length <= 0) {
      missingTimingDetails.push(`${eventInstanceId}:START_ROUND_1`);
    } else {
      starts.push(minDate(startCandidates));
    }
    if (endCandidates.length <= 0) {
      missingTimingDetails.push(`${eventInstanceId}:FINAL_END_ROUND_7`);
    } else {
      ends.push(maxDate(endCandidates));
    }
  }
  const startCoverageComplete = !missingTimingDetails.some((detail) => detail.endsWith(":START_ROUND_1"));
  const complete = missingTimingDetails.length === 0;
  return {
    startsAt: startCoverageComplete && starts.length > 0 ? minDate(starts) : null,
    endsAt: complete && ends.length > 0 ? maxDate(ends) : null,
    timingCoverageComplete: complete,
    missingTimingDetails,
  };
}

/** Purpose: recognize the persisted ended-round state used by CWL history ownership. */
function isEndedCwlRoundState(value: unknown): boolean {
  return String(value ?? "").toLowerCase().includes("warended");
}

type HistoryWar = CwlAllianceActivitySourceWar & { warId: number };
type PreWarSelection = { clan: NormalizedClan; war: HistoryWar | null };

/** Purpose: select each clan's latest completed FWA war before the resolved CWL start. */
function selectPreCwlWars(clans: NormalizedClan[], rows: any[]): PreWarSelection[] {
  const rowsByClan = new Map<string, HistoryWar[]>();
  for (const row of rows) {
    const clanTag = normalizeClashTagWithHash(row?.clanTag);
    const warEndTime = asDate(row?.warEndTime);
    const warStartTime = asDate(row?.warStartTime);
    const warId = Number(row?.warId);
    if (!clanTag || !warEndTime || !warStartTime || !Number.isInteger(warId)) continue;
    const historyWar = toSourceWar(row, clanTag, warId);
    const candidates = rowsByClan.get(clanTag) ?? [];
    candidates.push(historyWar);
    rowsByClan.set(clanTag, candidates);
  }
  return clans.map((clan) => {
    const candidates = rowsByClan.get(clan.clanTag) ?? [];
    candidates.sort(comparePreWars);
    return { clan, war: candidates[0] ?? null };
  });
}

/** Purpose: order pre-CWL war candidates by the requested latest-ended-war rule. */
function comparePreWars(a: HistoryWar, b: HistoryWar): number {
  const byEnd = compareDatesDesc(a.warEndTime, b.warEndTime);
  if (byEnd !== 0) return byEnd;
  const byStart = compareDatesDesc(a.warStartTime, b.warStartTime);
  if (byStart !== 0) return byStart;
  return b.warId - a.warId;
}

/** Purpose: load exact historical-war participation rows in one read-only batch. */
async function loadParticipationRows(input: {
  db: ActivityDb;
  warIds: number[];
  guildId: string | null;
}): Promise<any[]> {
  const warIds = [...new Set(input.warIds)].map(String);
  if (warIds.length <= 0) return [];
  return input.db.clanWarParticipation.findMany({
    where: {
      warId: { in: warIds },
      ...(input.guildId ? { guildId: input.guildId } : {}),
    },
  });
}

type PreCwlBuild = {
  players: CwlAllianceActivityPrePlayer[];
  coveredClanCount: number;
  coveredClanTags: Set<string>;
  duplicateReconciliations: number;
  byClan: Map<string, CwlAllianceActivityPrePlayer[]>;
  clanData: Map<string, PreCwlClanData>;
};

type PreCwlClanData = {
  sourceWar: HistoryWar | null;
  coverageAvailable: boolean;
  unavailableReason: string | null;
  sourceRosterCount: number;
};

/** Purpose: build the deduplicated historical pre-CWL cohort and preserve source-war home clans. */
function buildPreCwlCohort(input: {
  trackedFwaClans: NormalizedClan[];
  selections: PreWarSelection[];
  participationRows: any[];
  startsAt: Date | null;
}): PreCwlBuild {
  const participationByWar = new Map<string, any[]>();
  for (const row of input.participationRows) {
    const warId = String(row?.warId ?? "");
    if (!warId) continue;
    const rows = participationByWar.get(warId) ?? [];
    rows.push(row);
    participationByWar.set(warId, rows);
  }
  const candidatesByPlayer = new Map<string, Array<CwlAllianceActivityPrePlayer & { sourceWar: HistoryWar }>>();
  const byClan = new Map<string, CwlAllianceActivityPrePlayer[]>();
  const clanData = new Map<string, PreCwlClanData>();
  const coveredClanTags = new Set<string>();
  let coveredClanCount = 0;
  for (const selection of input.selections) {
    const sourceWar = selection.war;
    const participationRows = sourceWar
      ? dedupeParticipationRows(participationByWar.get(String(sourceWar.warId)) ?? [], selection.clan.clanTag)
      : [];
    const available = Boolean(input.startsAt && sourceWar && participationRows.length > 0);
    if (available) {
      coveredClanCount += 1;
      coveredClanTags.add(selection.clan.clanTag);
    }
    clanData.set(selection.clan.clanTag, {
      sourceWar,
      coverageAvailable: available,
      unavailableReason: available
        ? null
        : input.startsAt
          ? "NO_USABLE_PRE_CWL_FWA_WAR_OR_PARTICIPATION"
          : "CWL_START_TIME_UNAVAILABLE",
      sourceRosterCount: participationRows.length,
    });
    for (const row of participationRows) {
      const playerTag = normalizeClashTagWithHash(row?.playerTag);
      if (!playerTag || !sourceWar) continue;
      const candidate = {
        playerTag,
        playerName: normalizeNullableName(row?.playerName),
        townHall: toNullableInt(row?.townHall),
        homeFwaClanTag: selection.clan.clanTag,
        sourceWar,
      };
      const candidates = candidatesByPlayer.get(playerTag) ?? [];
      candidates.push(candidate);
      candidatesByPlayer.set(playerTag, candidates);
    }
  }
  let duplicateReconciliations = 0;
  const players: CwlAllianceActivityPrePlayer[] = [];
  for (const candidates of candidatesByPlayer.values()) {
    candidates.sort(comparePrePlayerCandidates);
    duplicateReconciliations += Math.max(0, candidates.length - 1);
    const selected = candidates[0];
    const player = stripSourceWar(selected);
    players.push(player);
    const clanPlayers = byClan.get(player.homeFwaClanTag) ?? [];
    clanPlayers.push(player);
    byClan.set(player.homeFwaClanTag, clanPlayers);
  }
  players.sort(comparePlayers);
  for (const clanPlayers of byClan.values()) clanPlayers.sort(comparePlayers);
  return { players, coveredClanCount, coveredClanTags, duplicateReconciliations, byClan, clanData };
}

/** Purpose: deduplicate exact-war participation by normalized player tag. */
function dedupeParticipationRows(rows: any[], clanTag: string): any[] {
  const byPlayer = new Map<string, any>();
  for (const row of rows) {
    const rowClanTag = normalizeClashTagWithHash(row?.clanTag);
    const playerTag = normalizeClashTagWithHash(row?.playerTag);
    if (rowClanTag !== clanTag || !playerTag || byPlayer.has(playerTag)) continue;
    byPlayer.set(playerTag, row);
  }
  return [...byPlayer.values()].sort((a, b) =>
    normalizeClashTagWithHash(a?.playerTag).localeCompare(normalizeClashTagWithHash(b?.playerTag)),
  );
}

/** Purpose: prefer later historical source-war evidence when reconciling duplicate pre-CWL players. */
function comparePrePlayerCandidates(
  a: CwlAllianceActivityPrePlayer & { sourceWar: HistoryWar },
  b: CwlAllianceActivityPrePlayer & { sourceWar: HistoryWar },
): number {
  const byEnd = compareDatesDesc(a.sourceWar.warEndTime, b.sourceWar.warEndTime);
  if (byEnd !== 0) return byEnd;
  const byStart = compareDatesDesc(a.sourceWar.warStartTime, b.sourceWar.warStartTime);
  if (byStart !== 0) return byStart;
  const byClan = a.homeFwaClanTag.localeCompare(b.homeFwaClanTag);
  if (byClan !== 0) return byClan;
  return b.sourceWar.warId - a.sourceWar.warId;
}

/** Purpose: remove internal source-war metadata from a public pre-CWL player row. */
function stripSourceWar(
  player: CwlAllianceActivityPrePlayer & { sourceWar: HistoryWar },
): CwlAllianceActivityPrePlayer {
  return {
    playerTag: player.playerTag,
    playerName: player.playerName,
    townHall: player.townHall,
    homeFwaClanTag: player.homeFwaClanTag,
  };
}

type CwlBuild = {
  players: CwlAllianceActivityParticipant[];
  duplicateReconciliations: number;
  histogram: Record<string, number>;
  unexpectedDays: Record<string, number>;
};

/** Purpose: build the actual CWL participant cohort from positive days-participated evidence only. */
function buildCwlParticipantCohort(rows: any[]): CwlBuild {
  const byPlayer = new Map<string, any[]>();
  for (const row of rows) {
    const playerTag = normalizeClashTagWithHash(row?.playerTag);
    const daysParticipated = toNullableInt(row?.daysParticipated);
    if (!playerTag || !daysParticipated || daysParticipated <= 0) continue;
    const candidates = byPlayer.get(playerTag) ?? [];
    candidates.push({ ...row, playerTag, daysParticipated });
    byPlayer.set(playerTag, candidates);
  }
  const players: CwlAllianceActivityParticipant[] = [];
  let duplicateReconciliations = 0;
  const histogram: Record<string, number> = {};
  for (let day = 1; day <= 7; day += 1) histogram[String(day)] = 0;
  const unexpectedDays: Record<string, number> = {};
  for (const candidates of byPlayer.values()) {
    candidates.sort(compareCwlParticipantCandidates);
    duplicateReconciliations += Math.max(0, candidates.length - 1);
    const selected = candidates[0];
    const player: CwlAllianceActivityParticipant = {
      playerTag: selected.playerTag,
      playerName: normalizeNullableName(selected.playerName),
      townHall: toNullableInt(selected.townHall),
      cwlClanTag: normalizeClashTagWithHash(selected.cwlClanTag) || String(selected.cwlClanTag ?? ""),
      daysParticipated: selected.daysParticipated,
    };
    players.push(player);
    const dayKey = String(player.daysParticipated);
    if (player.daysParticipated >= 1 && player.daysParticipated <= 7) {
      histogram[dayKey] += 1;
    } else {
      unexpectedDays[dayKey] = (unexpectedDays[dayKey] ?? 0) + 1;
    }
  }
  players.sort(comparePlayers);
  return { players, duplicateReconciliations, histogram, unexpectedDays };
}

/** Purpose: prefer the strongest deterministic CWL evidence without counting duplicate rows twice. */
function compareCwlParticipantCandidates(a: any, b: any): number {
  const byDays = Number(b.daysParticipated) - Number(a.daysParticipated);
  if (byDays !== 0) return byDays;
  const byClan = normalizeClashTagWithHash(a?.cwlClanTag).localeCompare(
    normalizeClashTagWithHash(b?.cwlClanTag),
  );
  if (byClan !== 0) return byClan;
  return String(a?.eventInstanceId ?? "").localeCompare(String(b?.eventInstanceId ?? ""));
}

type Categories = {
  preFwa: CwlAllianceActivityPrePlayer[];
  cwl: CwlAllianceActivityParticipant[];
  both: CwlAllianceActivityBothPlayer[];
  fwaOnly: CwlAllianceActivityPrePlayer[];
  cwlOnly: CwlAllianceActivityParticipant[];
};

/** Purpose: derive intersection and difference cohorts from normalized historical player sets. */
function buildCategories(
  preFwa: CwlAllianceActivityPrePlayer[],
  cwl: CwlAllianceActivityParticipant[],
): Categories {
  const preByTag = new Map(preFwa.map((player) => [player.playerTag, player]));
  const cwlByTag = new Map(cwl.map((player) => [player.playerTag, player]));
  const both: CwlAllianceActivityBothPlayer[] = [];
  const fwaOnly: CwlAllianceActivityPrePlayer[] = [];
  const cwlOnly: CwlAllianceActivityParticipant[] = [];
  for (const player of preFwa) {
    const cwlPlayer = cwlByTag.get(player.playerTag);
    if (cwlPlayer) {
      both.push({
        ...player,
        cwlClanTag: cwlPlayer.cwlClanTag,
        daysParticipated: cwlPlayer.daysParticipated,
      });
    } else {
      fwaOnly.push(player);
    }
  }
  for (const player of cwl) {
    if (!preByTag.has(player.playerTag)) cwlOnly.push(player);
  }
  both.sort(comparePlayers);
  fwaOnly.sort(comparePlayers);
  cwlOnly.sort(comparePlayers);
  return { preFwa, cwl, both, fwaOnly, cwlOnly };
}

type PostCwlClanData = {
  sourceWar: HistoryWar | null;
  coverageAvailable: boolean;
  returnedAfterCwlCount: number;
  retentionRate: number | null;
};

type PostBuild = {
  available: boolean;
  postCoverageComplete: boolean;
  coveredPostClanCount: number;
  expectedPostClanCount: number;
  returnedAfterCwl: CwlAllianceActivityPrePlayer[];
  notReturnedAfterCwl: CwlAllianceActivityPrePlayer[];
  newPostCwlFwa: CwlAllianceActivityPostPlayer[];
  retentionRate: number | null;
  duplicateReconciliations: number;
  byClan: Map<string, PostCwlClanData>;
};

/** Purpose: derive post-CWL return cohorts only when each pre-CWL clan has usable historical coverage. */
async function buildPostCwlRetention(input: {
  db: ActivityDb;
  trackedFwaClans: NormalizedClan[];
  preCwl: PreCwlBuild;
  endsAt: Date;
  guildId: string | null;
}): Promise<PostBuild> {
  const historyRows = await input.db.clanWarHistory.findMany({
    where: {
      clanTag: { in: input.trackedFwaClans.map((clan) => clan.clanTag) },
      matchType: "FWA",
      warStartTime: { gte: input.endsAt },
    },
    orderBy: [{ warStartTime: "asc" }, { warEndTime: "asc" }, { warId: "asc" }],
  });
  const rowsByClan = new Map<string, HistoryWar[]>();
  for (const row of historyRows) {
    const clanTag = normalizeClashTagWithHash(row?.clanTag);
    const warStartTime = asDate(row?.warStartTime);
    const warId = Number(row?.warId);
    if (!clanTag || !warStartTime || !Number.isInteger(warId)) continue;
    const candidates = rowsByClan.get(clanTag) ?? [];
    candidates.push(toSourceWar(row, clanTag, warId));
    rowsByClan.set(clanTag, candidates);
  }
  const selections = input.trackedFwaClans.map((clan) => {
    const candidates = rowsByClan.get(clan.clanTag) ?? [];
    candidates.sort(comparePostWars);
    return { clan, war: candidates[0] ?? null };
  });
  const participationRows = await loadParticipationRows({
    db: input.db,
    warIds: selections.map((selection) => selection.war?.warId).filter((warId): warId is number => Number.isInteger(warId)),
    guildId: input.guildId,
  });
  const participationByWar = new Map<string, any[]>();
  for (const row of participationRows) {
    const warId = String(row?.warId ?? "");
    if (!warId) continue;
    const rows = participationByWar.get(warId) ?? [];
    rows.push(row);
    participationByWar.set(warId, rows);
  }
  const candidatesByPlayer = new Map<string, Array<CwlAllianceActivityPostPlayer & { sourceWar: HistoryWar }>>();
  const byClan = new Map<string, PostCwlClanData>();
  const preCoveredClanTags = input.preCwl.coveredClanTags;
  let coveredPostClanCount = 0;
  for (const selection of selections) {
    const rows = selection.war
      ? dedupeParticipationRows(participationByWar.get(String(selection.war.warId)) ?? [], selection.clan.clanTag)
      : [];
    const coverageAvailable = Boolean(selection.war && rows.length > 0);
    if (coverageAvailable && preCoveredClanTags.has(selection.clan.clanTag)) {
      coveredPostClanCount += 1;
    }
    for (const row of rows) {
      const playerTag = normalizeClashTagWithHash(row?.playerTag);
      if (!playerTag || !selection.war) continue;
      const candidate = {
        playerTag,
        playerName: normalizeNullableName(row?.playerName),
        townHall: toNullableInt(row?.townHall),
        postCwlFwaClanTag: selection.clan.clanTag,
        sourceWar: selection.war,
      };
      const candidates = candidatesByPlayer.get(playerTag) ?? [];
      candidates.push(candidate);
      candidatesByPlayer.set(playerTag, candidates);
    }
    byClan.set(selection.clan.clanTag, {
      sourceWar: selection.war,
      coverageAvailable,
      returnedAfterCwlCount: 0,
      retentionRate: null,
    });
  }
  let duplicateReconciliations = 0;
  const postPlayers: CwlAllianceActivityPostPlayer[] = [];
  for (const candidates of candidatesByPlayer.values()) {
    candidates.sort(comparePostPlayerCandidates);
    duplicateReconciliations += Math.max(0, candidates.length - 1);
    const selected = candidates[0];
    postPlayers.push(stripPostSourceWar(selected));
  }
  postPlayers.sort(comparePlayers);
  const postByTag = new Map(postPlayers.map((player) => [player.playerTag, player]));
  const returnedAfterCwl = input.preCwl.players.filter((player) => postByTag.has(player.playerTag));
  const notReturnedAfterCwl = input.preCwl.players.filter((player) => !postByTag.has(player.playerTag));
  const preTags = new Set(input.preCwl.players.map((player) => player.playerTag));
  const newPostCwlFwa = postPlayers.filter((player) => !preTags.has(player.playerTag));
  for (const [clanTag, clanPlayers] of input.preCwl.byClan) {
    const data = byClan.get(clanTag);
    if (!data) continue;
    const returned = clanPlayers.filter((player) => postByTag.has(player.playerTag)).length;
    data.returnedAfterCwlCount = returned;
    data.retentionRate = data.coverageAvailable ? percentage(returned, clanPlayers.length) : null;
  }
  const expectedPostClanCount = input.preCwl.coveredClanCount;
  const postCoverageComplete =
    expectedPostClanCount > 0 &&
    [...preCoveredClanTags].every((clanTag) => byClan.get(clanTag)?.coverageAvailable === true);
  return {
    available: true,
    postCoverageComplete,
    coveredPostClanCount,
    expectedPostClanCount,
    returnedAfterCwl,
    notReturnedAfterCwl,
    newPostCwlFwa,
    retentionRate: postCoverageComplete
      ? percentage(returnedAfterCwl.length, input.preCwl.players.length)
      : null,
    duplicateReconciliations,
    byClan,
  };
}

/** Purpose: return a deterministic empty retention result for ongoing or untimed CWL seasons. */
function emptyPostCwlRetention(expectedPostClanCount: number): PostBuild {
  return {
    available: false,
    postCoverageComplete: false,
    coveredPostClanCount: 0,
    expectedPostClanCount,
    returnedAfterCwl: [],
    notReturnedAfterCwl: [],
    newPostCwlFwa: [],
    retentionRate: null,
    duplicateReconciliations: 0,
    byClan: new Map(),
  };
}

/** Purpose: order post-CWL war candidates by earliest qualifying historical war. */
function comparePostWars(a: HistoryWar, b: HistoryWar): number {
  const byStart = compareDatesAsc(a.warStartTime, b.warStartTime);
  if (byStart !== 0) return byStart;
  const byEnd = compareNullableDatesAsc(a.warEndTime, b.warEndTime);
  if (byEnd !== 0) return byEnd;
  return a.warId - b.warId;
}

/** Purpose: apply the same later-source attribution rule to duplicate post-CWL players. */
function comparePostPlayerCandidates(
  a: CwlAllianceActivityPostPlayer & { sourceWar: HistoryWar },
  b: CwlAllianceActivityPostPlayer & { sourceWar: HistoryWar },
): number {
  const byEnd = compareNullableDatesDesc(a.sourceWar.warEndTime, b.sourceWar.warEndTime);
  if (byEnd !== 0) return byEnd;
  const byStart = compareDatesDesc(a.sourceWar.warStartTime, b.sourceWar.warStartTime);
  if (byStart !== 0) return byStart;
  return a.postCwlFwaClanTag.localeCompare(b.postCwlFwaClanTag);
}

/** Purpose: remove internal source-war metadata from a public post-CWL player row. */
function stripPostSourceWar(
  player: CwlAllianceActivityPostPlayer & { sourceWar: HistoryWar },
): CwlAllianceActivityPostPlayer {
  return {
    playerTag: player.playerTag,
    playerName: player.playerName,
    townHall: player.townHall,
    postCwlFwaClanTag: player.postCwlFwaClanTag,
  };
}

/** Purpose: build per-home-clan analytics while preserving source war and post coverage metadata. */
function buildPreCwlClanSummaries(input: {
  trackedFwaClans: NormalizedClan[];
  preCwl: PreCwlBuild;
  cwlPlayers: CwlAllianceActivityParticipant[];
  bothPlayers: CwlAllianceActivityBothPlayer[];
  fwaOnlyPlayers: CwlAllianceActivityPrePlayer[];
  postByClan: PostBuild["byClan"];
}): CwlAllianceActivityResult["preCwlClans"] {
  const cwlByTag = new Set(input.cwlPlayers.map((player) => player.playerTag));
  const bothByTag = new Set(input.bothPlayers.map((player) => player.playerTag));
  const fwaOnlyByTag = new Set(input.fwaOnlyPlayers.map((player) => player.playerTag));
  return input.trackedFwaClans.map((clan) => {
    const data = input.preCwl.clanData.get(clan.clanTag) ?? {
      sourceWar: null,
      coverageAvailable: false,
      unavailableReason: "NO_PRE_CWL_DATA",
      sourceRosterCount: 0,
    };
    const clanPlayers = input.preCwl.byClan.get(clan.clanTag) ?? [];
    const post = input.postByClan.get(clan.clanTag);
    const postCoverageForPreCohort = Boolean(data.coverageAvailable && post?.coverageAvailable);
    return {
      clanTag: clan.clanTag,
      clanName: clan.clanName,
      coverageAvailable: data.coverageAvailable,
      unavailableReason: data.unavailableReason,
      sourcePreCwlWar: data.sourceWar,
      preCwlRosterCount: clanPlayers.length,
      sourcePreCwlRosterCount: data.sourceRosterCount,
      cwlParticipantCount: clanPlayers.filter((player) => cwlByTag.has(player.playerTag)).length,
      fwaOnlyCount: clanPlayers.filter((player) => fwaOnlyByTag.has(player.playerTag)).length,
      bothCount: clanPlayers.filter((player) => bothByTag.has(player.playerTag)).length,
      returnedAfterCwlCount: postCoverageForPreCohort ? post!.returnedAfterCwlCount : null,
      retentionRate: postCoverageForPreCohort ? post!.retentionRate : null,
      sourcePostCwlWar: post?.sourceWar ?? null,
    };
  });
}

/** Purpose: aggregate BOTH-player movement from historical FWA home clan to CWL clan. */
function buildMovementSummary(
  bothPlayers: CwlAllianceActivityBothPlayer[],
): CwlAllianceActivityResult["movementSummary"] {
  const counts = new Map<string, number>();
  for (const player of bothPlayers) {
    const key = `${player.homeFwaClanTag}\u0000${player.cwlClanTag}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, accountCount]) => {
      const [homeFwaClanTag, cwlClanTag] = key.split("\u0000");
      return { homeFwaClanTag, cwlClanTag, accountCount };
    })
    .sort((a, b) =>
      a.homeFwaClanTag.localeCompare(b.homeFwaClanTag) || a.cwlClanTag.localeCompare(b.cwlClanTag),
    );
}

/** Purpose: convert a count over a non-empty denominator into a bounded percentage. */
function percentage(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

/** Purpose: canonicalize and validate a requested CWL season key. */
function normalizeSeason(input: string): string {
  const season = String(input ?? "").trim();
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(season)) return season;
  throw new Error(`Invalid CWL season; expected YYYY-MM, received ${season || "empty"}`);
}

/** Purpose: convert persisted war history into the service's stable source metadata shape. */
function toSourceWar(row: any, clanTag: string, warId: number): HistoryWar {
  return {
    warId,
    clanTag,
    clanName: normalizeNullableName(row?.clanName),
    opponentTag: normalizeNullableTag(row?.opponentTag),
    opponentName: normalizeNullableName(row?.opponentName),
    matchType: row?.matchType == null ? null : String(row.matchType),
    warStartTime: asDate(row?.warStartTime) as Date,
    warEndTime: asDate(row?.warEndTime),
  };
}

/** Purpose: compare result clans by canonical tag for stable report ordering. */
function compareClanTags(a: NormalizedClan, b: NormalizedClan): number {
  return a.clanTag.localeCompare(b.clanTag);
}

/** Purpose: compare player-shaped result rows by canonical player tag. */
function comparePlayers(a: { playerTag: string }, b: { playerTag: string }): number {
  return a.playerTag.localeCompare(b.playerTag);
}

/** Purpose: parse nullable persisted names without manufacturing empty display values. */
function normalizeNullableName(value: unknown): string | null {
  const name = String(value ?? "").trim();
  return name || null;
}

/** Purpose: normalize nullable persisted tags while preserving null for malformed values. */
function normalizeNullableTag(value: unknown): string | null {
  return normalizeClashTagWithHash(String(value ?? "")) || null;
}

/** Purpose: parse finite persisted integer fields without accepting invalid numeric evidence. */
function toNullableInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** Purpose: parse a persisted date-like value into a valid Date or null. */
function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value == null || value === "") return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Purpose: compare nullable dates descending with null values ordered last. */
function compareNullableDatesDesc(a: Date | null, b: Date | null): number {
  if (a && b) return compareDatesDesc(a, b);
  if (a) return -1;
  if (b) return 1;
  return 0;
}

/** Purpose: compare nullable dates ascending with null values ordered last. */
function compareNullableDatesAsc(a: Date | null, b: Date | null): number {
  if (a && b) return compareDatesAsc(a, b);
  if (a) return -1;
  if (b) return 1;
  return 0;
}

/** Purpose: compare non-null dates descending. */
function compareDatesDesc(a: unknown, b: unknown): number {
  const left = asDate(a)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const right = asDate(b)?.getTime() ?? Number.NEGATIVE_INFINITY;
  return right - left;
}

/** Purpose: compare non-null dates ascending. */
function compareDatesAsc(a: unknown, b: unknown): number {
  const left = asDate(a)?.getTime() ?? Number.POSITIVE_INFINITY;
  const right = asDate(b)?.getTime() ?? Number.POSITIVE_INFINITY;
  return left - right;
}

/** Purpose: return the earliest valid date in a non-empty list. */
function minDate(values: Date[]): Date {
  return new Date(Math.min(...values.map((value) => value.getTime())));
}

/** Purpose: return the latest valid date in a non-empty list. */
function maxDate(values: Date[]): Date {
  return new Date(Math.max(...values.map((value) => value.getTime())));
}
