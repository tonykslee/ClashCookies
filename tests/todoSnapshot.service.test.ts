import { beforeEach, describe, expect, it, vi } from "vitest";
import { CwlFetchCycleCache } from "../src/services/CwlFetchCycleCache";

let cwlSeasonMappingRows: Array<{
  eventInstanceId: string;
  playerTag: string;
  cwlClanTag: string;
}> = [];

const txMock = vi.hoisted(() => ({
  cwlEventInstance: {
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  },
  cwlEventWarTag: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  cwlEventClan: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  todoPlayerSnapshot: {
    upsert: vi.fn(),
  },
  cwlPlayerClanSeason: {
    upsert: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
  },
  todoPlayerSnapshot: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
    upsert: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaWarMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  warAttacks: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  raidTrackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
  cwlEventClan: {
    findMany: vi.fn(),
  },
  currentCwlRound: {
    findMany: vi.fn(),
  },
  cwlRoundMemberCurrent: {
    findMany: vi.fn(),
  },
  cwlRoundMemberHistory: {
    findMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  todoUserUsage: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  botSetting: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
}));

const cocRequestQueueMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CoCRequestQueueService", () => ({
  cocRequestQueueService: cocRequestQueueMock,
}));

import {
  resolveClanGamesWindowForTest,
  resolveRaidWeekendWindowForTest,
  resolveWarEventLinkedPlayerRefreshPlanForTest,
  resetTodoSnapshotServiceForTest,
  todoSnapshotService,
} from "../src/services/TodoSnapshotService";
import { resolveCurrentCwlSeasonKey } from "../src/services/CwlRegistryService";

function buildSnapshotRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    playerTag: "#PYLQ0289",
    playerName: "Alpha",
    clanTag: "#PQL0289",
    clanName: "Clan One",
    warClanTag: null,
    warClanName: null,
    warPosition: null,
    warSourceUpdatedAt: null,
    clanMembershipObservedAt: null,
    raidClanTag: null,
    raidClanName: null,
    cwlClanTag: null,
    cwlClanName: null,
    warActive: false,
    warAttacksUsed: 0,
    warAttacksMax: 2,
    warPhase: null,
    warEndsAt: null,
    cwlActive: false,
    cwlAttacksUsed: 0,
    cwlAttacksMax: 1,
    cwlPhase: null,
    cwlEndsAt: null,
    raidActive: false,
    raidAttacksUsed: 0,
    raidAttacksMax: 6,
    raidEndsAt: null,
    raidSourceUpdatedAt: null,
    gamesActive: false,
    gamesPoints: null,
    gamesTarget: null,
    gamesChampionTotal: null,
    gamesSeasonBaseline: null,
    gamesCycleKey: null,
    gamesEndsAt: null,
    lastUpdatedAt: new Date("2026-03-26T00:00:00.000Z"),
    updatedAt: new Date("2026-03-26T00:00:00.000Z"),
    ...overrides,
  };
}

const VALID_PLAYER_TAG_ALPHABET = "PYLQGRJCUV0289";

function buildValidPlayerTag(index: number): string {
  const normalizedIndex = Math.max(0, Math.trunc(index));
  const low = VALID_PLAYER_TAG_ALPHABET[normalizedIndex % VALID_PLAYER_TAG_ALPHABET.length];
  const high =
    VALID_PLAYER_TAG_ALPHABET[
      Math.floor(normalizedIndex / VALID_PLAYER_TAG_ALPHABET.length) %
        VALID_PLAYER_TAG_ALPHABET.length
  ];
  return `#PQ${high}${low}`;
}

function getTodoSnapshotUpsertUpdateForPlayer(playerTag: string): Record<string, unknown> {
  const call = prismaMock.todoPlayerSnapshot.upsert.mock.calls.find(
    ([arg]) => String((arg as { where?: { playerTag?: unknown } })?.where?.playerTag ?? "") === playerTag,
  );
  if (!call) {
    throw new Error(`Expected todoPlayerSnapshot.upsert call for ${playerTag}`);
  }
  return ((call[0] as { update?: Record<string, unknown> }).update ?? {}) as Record<string, unknown>;
}

function buildTrackedWarRows(input: {
  clanTag: string;
  count: number;
  sourceSyncedAt: Date;
  missingDerivedIndex?: number | null;
}): {
  clanMemberRows: Array<{
    playerTag: string;
    clanTag: string;
    playerName: string;
    sourceSyncedAt: Date;
  }>;
  warMemberRows: Array<{
    playerTag: string;
    clanTag: string;
    playerName: string;
    townHall: number;
    position: number;
    attacks: number;
    sourceSyncedAt: Date;
  }>;
  rosterMemberRows: Array<{
    clanTag: string;
    playerTag: string;
    position: number;
    playerName: string;
    townHall: number;
  }>;
} {
  const clanMemberRows = Array.from({ length: input.count }, (_, index) => {
    const playerTag = buildValidPlayerTag(index);
    return {
      playerTag,
      clanTag: input.clanTag,
      playerName: `Player ${index + 1}`,
      sourceSyncedAt: input.sourceSyncedAt,
    };
  });

  const warMemberRows = clanMemberRows.map((row, index) => ({
    playerTag: row.playerTag,
    clanTag: row.clanTag,
    playerName: row.playerName,
    townHall: 15 - (index % 5),
    position: index + 1,
    attacks: (index % 2) + 1,
    sourceSyncedAt: input.sourceSyncedAt,
  }));

  const rosterMemberRows = warMemberRows
    .filter((_, index) => index !== input.missingDerivedIndex)
    .map((row) => ({
      clanTag: row.clanTag,
      playerTag: row.playerTag,
      position: row.position,
      playerName: row.playerName,
      townHall: row.townHall,
    }));

  return {
    clanMemberRows,
    warMemberRows,
    rosterMemberRows,
  };
}

function makeRaidSeason(
  members: Array<{ tag: string; attacks: number }> = [],
): {
  startTime: string;
  endTime: string;
  members: Array<{ tag: string; attacks: number }>;
} {
  return {
    startTime: "20260327T070000.000Z",
    endTime: "20260330T070000.000Z",
    members,
  };
}

function normalizeClanTagForTest(input: string): string {
  const value = String(input ?? "").trim().toUpperCase();
  if (!value) return "";
  return value.startsWith("#") ? value : `#${value}`;
}

function buildCurrentCwlEventRowForTest(input: {
  clanTag: string;
  eventInstanceId: string;
  season: string;
}) {
  const timestamp = new Date("2026-03-26T00:00:00.000Z");
  return {
    clanTag: normalizeClanTagForTest(input.clanTag),
    eventInstanceId: input.eventInstanceId,
    eventInstance: {
      id: input.eventInstanceId,
      season: input.season,
      anchorWarTag: "#Y2CQ",
      firstObservedAt: timestamp,
      lastObservedAt: timestamp,
    },
  };
}

function mockTrackedClanFindManyByWhere(rows: Array<{ tag: string; name: string | null }>) {
  return vi.fn(async (args?: { where?: { tag?: { in?: string[] } } }) => {
    const requestedTags = new Set(
      Array.isArray(args?.where?.tag?.in)
        ? args.where.tag.in.map((tag) => normalizeClanTagForTest(tag))
        : [],
    );
    return rows.filter((row) => {
      if (requestedTags.size <= 0) return true;
      return requestedTags.has(normalizeClanTagForTest(row.tag));
    });
  });
}

describe("TodoSnapshotService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTodoSnapshotServiceForTest();
    cwlSeasonMappingRows = [];
    prismaMock.cwlEventClan.findMany.mockResolvedValue([]);

    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.todoPlayerSnapshot.upsert.mockResolvedValue(undefined);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#PQL0289",
        playerName: "Bravo",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        attacks: 1,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#PQL0289",
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#PQL0289" },
      { clanTag: "#2QG2C08UP" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        position: 1,
        playerName: "Alpha",
        townHall: 15,
      },
      {
        clanTag: "#PQL0289",
        playerTag: "#QGRJ2222",
        position: 2,
        playerName: "Bravo",
        townHall: 14,
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    txMock.cwlEventInstance.create.mockResolvedValue({
      id: "event-current",
      anchorWarTag: "#2QG2C08UP",
    });
    txMock.cwlEventInstance.update.mockResolvedValue({
      id: "event-current",
      anchorWarTag: "#2QG2C08UP",
    });
    txMock.cwlEventInstance.findUnique.mockResolvedValue({
      id: "event-current",
      anchorWarTag: "#2QG2C08UP",
    });
    txMock.cwlEventWarTag.findMany.mockResolvedValue([]);
    txMock.cwlEventWarTag.updateMany.mockResolvedValue({ count: 0 });
    txMock.cwlEventWarTag.create.mockResolvedValue(undefined);
    txMock.cwlEventClan.findMany.mockResolvedValue([]);
    txMock.cwlEventClan.updateMany.mockResolvedValue({ count: 0 });
    txMock.cwlEventClan.upsert.mockResolvedValue(undefined);
    prismaMock.cwlPlayerClanSeason.findMany.mockImplementation(async (args: any) => {
      const requestedEventIds = new Set(
        Array.isArray(args?.where?.eventInstanceId?.in)
          ? args.where.eventInstanceId.in.map((value: string) => String(value ?? "").trim())
          : [],
      );
      const requestedPlayerTags = new Set(
        Array.isArray(args?.where?.playerTag?.in)
          ? args.where.playerTag.in.map((value: string) => String(value ?? "").trim().toUpperCase())
          : [],
      );
      return cwlSeasonMappingRows.filter((row) => {
        const rowPlayerTag = String(row.playerTag ?? "").trim().toUpperCase();
        if (requestedEventIds.size > 0 && !requestedEventIds.has(String(row.eventInstanceId ?? "").trim())) {
          return false;
        }
        if (requestedPlayerTags.size > 0 && !requestedPlayerTags.has(rowPlayerTag)) {
          return false;
        }
        return true;
      });
    });
    prismaMock.cwlPlayerClanSeason.upsert.mockImplementation(async (args: any) => {
      const playerTag = String(args?.create?.playerTag ?? args?.update?.playerTag ?? "");
      const cwlClanTag = String(args?.create?.cwlClanTag ?? args?.update?.cwlClanTag ?? "");
      const eventInstanceId = String(args?.create?.eventInstanceId ?? args?.update?.eventInstanceId ?? "");
      if (!playerTag || !cwlClanTag || !eventInstanceId) return undefined;
      cwlSeasonMappingRows = cwlSeasonMappingRows.filter(
        (row) => row.playerTag !== playerTag || row.eventInstanceId !== eventInstanceId,
      );
      cwlSeasonMappingRows.push({ eventInstanceId, playerTag, cwlClanTag });
      return undefined;
    });
    txMock.cwlPlayerClanSeason.upsert.mockImplementation(async (args: any) => {
      const playerTag = String(args?.create?.playerTag ?? args?.update?.playerTag ?? "");
      const cwlClanTag = String(args?.create?.cwlClanTag ?? args?.update?.cwlClanTag ?? "");
      const eventInstanceId = String(args?.create?.eventInstanceId ?? args?.update?.eventInstanceId ?? "");
      if (!playerTag || !cwlClanTag || !eventInstanceId) return undefined;
      cwlSeasonMappingRows = cwlSeasonMappingRows.filter(
        (row) => row.playerTag !== playerTag || row.eventInstanceId !== eventInstanceId,
      );
      cwlSeasonMappingRows.push({ eventInstanceId, playerTag, cwlClanTag });
      return undefined;
    });
    prismaMock.todoUserUsage.findMany.mockResolvedValue([]);
    prismaMock.todoUserUsage.findUnique.mockResolvedValue(null);
    prismaMock.todoUserUsage.upsert.mockResolvedValue(undefined);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    prismaMock.botSetting.upsert.mockResolvedValue(undefined);
    cocRequestQueueMock.getStatus.mockReturnValue({
      queueDepth: 0,
      interactiveQueueDepth: 0,
      backgroundQueueDepth: 0,
      inFlight: 0,
      penaltyMs: 0,
      spacingMs: 120,
      degraded: false,
      lastInteractiveWaitMs: 0,
      lastBackgroundWaitMs: 0,
      backgroundSkippedCount: 0,
      interactiveDispatchedCount: 0,
      backgroundDispatchedCount: 0,
    });
  });

  it("spreads large player refresh sets into bounded chunks over the poll window", () => {
    expect(
      resolveWarEventLinkedPlayerRefreshPlanForTest({
        candidateCount: 60,
        dedupedCount: 60,
        pacingMs: 15 * 60 * 1000,
      }),
    ).toEqual({
      candidateCount: 60,
      dedupedCount: 60,
      chunkSize: 25,
      chunkCount: 3,
      chunkDelayMs: 300_000,
    });
  });

  it("reads persisted CWL round state once per clan when refreshing multiple player tags", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlEventClan.findMany.mockResolvedValue([
      buildCurrentCwlEventRowForTest({
        clanTag: "#PQL0289",
        eventInstanceId: "event-current",
        season: "2026-03",
      }),
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        roundState: "preparation",
        startTime: new Date("2026-03-30T12:00:00.000Z"),
        endTime: new Date("2026-03-31T12:00:00.000Z"),
      },
    ]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        attacksUsed: 0,
        attacksAvailable: 0,
        subbedIn: true,
      },
      {
        season: "2026-03",
        clanTag: "#PQL0289",
        playerTag: "#QGRJ2222",
        attacksUsed: 0,
        attacksAvailable: 0,
        subbedIn: true,
      },
    ]);
    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.playerCount).toBe(2);
    expect(result.updatedCount).toBe(2);
    expect(prismaMock.currentCwlRound.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.cwlRoundMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledTimes(2);
  });

  it("skips live non-tracked CWL hydration unless explicitly enabled", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#NONT" },
      }),
      getClanWarLeagueGroup: vi.fn(),
      getClanWarLeagueWar: vi.fn(),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getClanWarLeagueGroup).not.toHaveBeenCalled();
    expect(cocService.getClanWarLeagueWar).not.toHaveBeenCalled();
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cwlClanTag: null,
          cwlClanName: null,
          cwlActive: false,
          cwlAttacksUsed: 0,
          cwlAttacksMax: 0,
        }),
      }),
    );
  });

  it("persists live town hall even when the fetched player has no clan tag", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#298CG8UJG",
        townHall: null,
        clanTag: null,
        clanName: null,
        cwlClanTag: null,
        cwlClanName: null,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#298CG8UJG",
        townHallLevel: 15,
      }),
    };

    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#298CG8UJG"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.playerCount).toBe(1);
    expect(result.updatedCount).toBe(1);
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#298CG8UJG", {
      suppressTelemetry: true,
    });
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          townHall: 15,
          clanTag: null,
          clanName: null,
        }),
      }),
    );
  });

  it("hydrates one live non-tracked CWL clan once and fans out the snapshot to multiple linked players", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#QGRJ",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#QGRJ",
        playerName: "Bravo",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (tag: string) => ({
        tag,
        clan: { tag: "#QGRJ" },
      })),
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        season: "2026-03",
        state: "preparation",
        clans: [{ tag: "#QGRJ", name: "Nontracked Clan" }],
        rounds: [{ warTags: ["#2QG2C08UP"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        attacksPerMember: 1,
        startTime: "20260330T120000.000Z",
        endTime: "20260331T120000.000Z",
        clan: {
          tag: "#QGRJ",
          name: "Nontracked Clan",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              townhallLevel: 15,
              attacks: [],
            },
            {
              tag: "#QGRJ2222",
              name: "Bravo",
              townhallLevel: 14,
              attacks: [],
            },
          ],
        },
        opponent: { tag: "#OPP", name: "Opponent", members: [] },
      }),
    };

    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: cocService as any,
      includeNonTrackedCwlRefresh: true,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.playerCount).toBe(2);
    expect(result.updatedCount).toBe(2);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalled();
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalled();
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cwlClanTag: "#QGRJ",
          cwlClanName: "Nontracked Clan",
          cwlActive: true,
          cwlPhase: "preparation",
          cwlEndsAt: new Date("2026-03-30T12:00:00.000Z"),
          cwlAttacksUsed: 0,
          cwlAttacksMax: 0,
        }),
      }),
    );
  });

  it("reuses one CWL cache instance across seasonal mapping and live non-tracked CWL refreshes in the same cycle", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2CJYQ0U82", name: "Infinity Meow" },
        townHallLevel: 16,
      }),
      getClanWarLeagueGroup: vi.fn().mockImplementation(async (clanTag: string) => {
        if (clanTag !== "#2CJYQ0U82") {
          return null;
        }
        return {
          season: "2026-04",
          state: "preparation",
          clans: [{ tag: "#2CJYQ0U82", name: "Infinity Meow" }],
          rounds: [{ warTags: ["#2QG2C08UP"] }],
        };
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        attacksPerMember: 1,
        startTime: "20260403T120000.000Z",
        endTime: "20260404T120000.000Z",
        clan: {
          tag: "#2CJYQ0U82",
          name: "Infinity Meow",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              townhallLevel: 16,
              attacks: [],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent One",
          members: [],
        },
      }),
    };
    const cwlFetchCycleCache = new CwlFetchCycleCache(cocService as any);

    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      cwlFetchCycleCache,
      includeNonTrackedCwlRefresh: true,
      nowMs: Date.UTC(2026, 3, 8, 17, 0, 0, 0),
    });

    expect(result.playerCount).toBe(1);
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#PYLQ0289", expect.any(Object));
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledTimes(1);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledWith("#2CJYQ0U82");
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalledTimes(1);
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalledWith("#2QG2C08UP");
    expect(cwlFetchCycleCache.getStats()).toMatchObject({
      groupMissCount: 1,
      groupHitCount: 1,
      warMissCount: 1,
      warHitCount: 1,
      cachedGroupCount: 1,
      cachedWarCount: 1,
    });
  });

  it("prefers the live clan over a pinned war clan when explicit non-tracked CWL refresh is enabled", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#QGRJ",
        clanName: "Old War Clan",
        warActive: true,
        raidActive: false,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#QGRJ",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2CJYQ0U82", name: "Infinity Meow" },
        townHallLevel: 16,
      }),
      getClanWarLeagueGroup: vi.fn().mockImplementation(async (clanTag: string) => {
        if (clanTag !== "#2CJYQ0U82") {
          return null;
        }
        return {
          season: "2026-04",
          state: "preparation",
          clans: [{ tag: "#2CJYQ0U82", name: "Infinity Meow" }],
          rounds: [{ warTags: ["#2QG2C08UP"] }],
        };
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        attacksPerMember: 1,
        startTime: "20260403T120000.000Z",
        endTime: "20260404T120000.000Z",
        clan: {
          tag: "#2CJYQ0U82",
          name: "Infinity Meow",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              townhallLevel: 16,
              attacks: [],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent One",
          members: [],
        },
      }),
    };

    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      includeNonTrackedCwlRefresh: true,
      nowMs: Date.UTC(2026, 3, 8, 17, 0, 0, 0),
    });

    expect(result.playerCount).toBe(1);
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#PYLQ0289", expect.any(Object));
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledWith("#2CJYQ0U82");
    expect(cocService.getClanWarLeagueGroup).not.toHaveBeenCalledWith("#QGRJ");
    expect(txMock.cwlPlayerClanSeason.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          season: "2026-04",
          playerTag: "#PYLQ0289",
          cwlClanTag: "#2CJYQ0U82",
          playerName: "Alpha",
          townHall: 16,
        }),
      }),
    );
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          townHall: 16,
          cwlClanTag: "#2CJYQ0U82",
          cwlClanName: "Infinity Meow",
          cwlActive: true,
          cwlPhase: "preparation",
        }),
      }),
    );
  });

  it("falls back to the pinned clan when live clan discovery is unavailable", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlEventClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#QGRJ",
        clanName: "Old War Clan",
        cwlClanTag: "#QGRJ",
        cwlClanName: "Old War Clan",
        warActive: true,
        raidActive: false,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#QGRJ",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: null,
      }),
      getClanWarLeagueGroup: vi.fn().mockImplementation(async (clanTag: string) => {
        if (clanTag !== "#QGRJ") {
          return null;
        }
        return {
          season: "2026-04",
          state: "preparation",
          clans: [{ tag: "#QGRJ", name: "Old War Clan" }],
          rounds: [{ warTags: ["#2QG2C08UP"] }],
        };
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        attacksPerMember: 1,
        startTime: "20260403T120000.000Z",
        endTime: "20260404T120000.000Z",
        clan: {
          tag: "#QGRJ",
          name: "Old War Clan",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              townhallLevel: 16,
              attacks: [],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent One",
          members: [],
        },
      }),
    };

    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      includeNonTrackedCwlRefresh: true,
      nowMs: Date.UTC(2026, 3, 8, 17, 0, 0, 0),
    });

    expect(result.playerCount).toBe(1);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledTimes(1);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledWith("#QGRJ");
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalledTimes(1);
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalledWith("#2QG2C08UP");
    expect(txMock.cwlPlayerClanSeason.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          season: "2026-04",
          playerTag: "#PYLQ0289",
          cwlClanTag: "#QGRJ",
          playerName: "Alpha",
          townHall: 16,
        }),
      }),
    );
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cwlClanTag: "#QGRJ",
          cwlClanName: "Old War Clan",
          cwlActive: true,
          cwlPhase: "preparation",
          cwlEndsAt: new Date("2026-04-03T12:00:00.000Z"),
          cwlAttacksUsed: 0,
          cwlAttacksMax: 0,
        }),
      }),
    );
  });

  it("clears a pinned non-tracked CWL clan when its current live event does not contain the player", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlEventClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#QGRJ",
        clanName: "Old War Clan",
        cwlClanTag: "#QGRJ",
        cwlClanName: "Old War Clan",
        cwlActive: true,
        cwlPhase: "battle day",
        cwlEndsAt: new Date("2026-04-03T12:00:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: null,
      }),
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        season: "2026-04",
        state: "preparation",
        clans: [{ tag: "#QGRJ", name: "Old War Clan" }],
        rounds: [{ warTags: ["#2QG2C08UP"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "inWar",
        attacksPerMember: 1,
        startTime: "20260403T120000.000Z",
        endTime: "20260404T120000.000Z",
        clan: {
          tag: "#QGRJ",
          name: "Old War Clan",
          members: [
            {
              tag: "#QGRJ2222",
              name: "Bravo",
              townhallLevel: 15,
              attacks: [],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent One",
          members: [],
        },
      }),
    };

    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      includeNonTrackedCwlRefresh: true,
      nowMs: Date.UTC(2026, 3, 8, 17, 0, 0, 0),
    });

    expect(result.playerCount).toBe(1);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledWith("#QGRJ");
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalledWith("#2QG2C08UP");
    expect(txMock.cwlPlayerClanSeason.upsert).not.toHaveBeenCalled();
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cwlClanTag: null,
          cwlClanName: null,
          cwlActive: false,
          cwlPhase: null,
          cwlEndsAt: null,
          cwlAttacksUsed: 0,
          cwlAttacksMax: 0,
        }),
      }),
    );
  });

  it("uses a persisted seasonal CWL clan mapping even after the linked player has returned to a different current clan", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#NEWCLAN",
        clanName: "New Clan",
        cwlClanTag: "#QGRJ",
        cwlClanName: "Nontracked Clan",
      }),
    ]);
    prismaMock.cwlEventClan.findMany.mockResolvedValue([
      buildCurrentCwlEventRowForTest({
        clanTag: "#QGRJ",
        eventInstanceId: "event-current",
        season: "2026-03",
      }),
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        eventInstanceId: "event-current",
        season: "2026-03",
        clanTag: "#QGRJ",
        playerTag: "#PYLQ0289",
        attacksUsed: 0,
        attacksAvailable: 1,
        subbedIn: true,
      },
    ]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([
      {
        eventInstanceId: "event-current",
        season: "2026-03",
        clanTag: "#QGRJ",
        clanName: "Nontracked Clan",
        roundState: "preparation",
        startTime: new Date("2026-03-30T12:00:00.000Z"),
        endTime: new Date("2026-03-31T12:00:00.000Z"),
      },
    ]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([
      {
        eventInstanceId: "event-current",
        playerTag: "#PYLQ0289",
        cwlClanTag: "#QGRJ",
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#NEWCLAN",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#NEWCLAN" },
      }),
      getClanWarLeagueGroup: vi.fn().mockImplementation(async (clanTag: string) => {
        if (clanTag !== "#QGRJ") {
          return null;
        }
        return {
          season: "2026-03",
          state: "preparation",
          clans: [{ tag: "#QGRJ", name: "Nontracked Clan" }],
          rounds: [{ warTags: ["#2QG2C08UP"] }],
        };
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        attacksPerMember: 1,
        startTime: "20260330T120000.000Z",
        endTime: "20260331T120000.000Z",
        clan: {
          tag: "#QGRJ",
          name: "Nontracked Clan",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              townhallLevel: 15,
              attacks: [],
            },
          ],
        },
        opponent: { tag: "#OPP", name: "Opponent", members: [] },
      }),
    };

    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      includeNonTrackedCwlRefresh: true,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.playerCount).toBe(1);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledWith("#QGRJ");
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cwlClanTag: "#QGRJ",
          cwlClanName: "Nontracked Clan",
          cwlActive: true,
          cwlPhase: "preparation",
        }),
      }),
    );
  });

  it("prefers a live active non-tracked CWL round over a later preparation round", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (tag: string) => ({
        tag,
        clan: { tag: "#QGRJ" },
      })),
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        season: "2026-03",
        state: "preparation",
        clans: [{ tag: "#QGRJ", name: "Nontracked Clan" }],
        rounds: [{ warTags: ["#2QG2C08UP"] }, { warTags: ["#PYLQ0289"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockImplementation(async (warTag: string) => {
        if (warTag === "#PYLQ0289") {
          return {
            state: "preparation",
            attacksPerMember: 1,
            startTime: "20260330T120000.000Z",
            endTime: "20260331T120000.000Z",
            clan: {
              tag: "#QGRJ",
              name: "Nontracked Clan",
              members: [
                {
                  tag: "#PYLQ0289",
                  name: "Alpha",
                  townhallLevel: 15,
                  attacks: [],
                },
              ],
            },
            opponent: { tag: "#OPP", name: "Opponent", members: [] },
          };
        }
        return {
          state: "inWar",
          attacksPerMember: 1,
          startTime: "20260329T120000.000Z",
          endTime: "20260330T120000.000Z",
          clan: {
            tag: "#QGRJ",
            name: "Nontracked Clan",
            members: [
              {
                tag: "#PYLQ0289",
                name: "Alpha",
                townhallLevel: 15,
                attacks: [{ stars: 2, destructionPercentage: 100 }],
              },
            ],
          },
          opponent: { tag: "#OPP", name: "Opponent", members: [] },
        };
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      includeNonTrackedCwlRefresh: true,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getClanWarLeagueWar).toHaveBeenCalled();
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cwlClanTag: "#QGRJ",
          cwlClanName: "Nontracked Clan",
          cwlPhase: "battle day",
          cwlEndsAt: new Date("2026-03-30T12:00:00.000Z"),
          cwlAttacksUsed: 1,
          cwlAttacksMax: 1,
        }),
      }),
    );
  });

  it("deduplicates duplicate player tags before chunked live clan refresh", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (tag: string) => ({
        tag,
        clan: { tag: "#QGRJ" },
      })),
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        season: "2026-03",
        state: "preparation",
        clans: [{ tag: "#QGRJ", name: "Nontracked Clan" }],
        rounds: [{ warTags: ["#2QG2C08UP"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        attacksPerMember: 1,
        startTime: "20260330T120000.000Z",
        endTime: "20260331T120000.000Z",
        clan: {
          tag: "#QGRJ",
          name: "Nontracked Clan",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              townhallLevel: 15,
              attacks: [],
            },
            {
              tag: "#QGRJ2222",
              name: "Bravo",
              townhallLevel: 14,
              attacks: [],
            },
          ],
        },
        opponent: { tag: "#OPP", name: "Opponent", members: [] },
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#PYLQ0289", "#QGRJ2222"],
      cocService: cocService as any,
      includeNonTrackedCwlRefresh: true,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getPlayerRaw).toHaveBeenCalledTimes(2);
  });

  it("reuses observed live player current state and skips duplicate live fetches", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (tag: string) => ({
        tag,
        clan: { tag: tag === "#QGRJ2222" ? "#MISS" : "#HIT" },
        townHallLevel: tag === "#QGRJ2222" ? 14 : 16,
      })),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: cocService as any,
      observedLivePlayerCurrent: [
        {
          playerTag: "#PYLQ0289",
          clanTag: "#2QG2C08UP",
          clanName: " Observed   Clan ",
          townHall: 16,
        },
      ],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getPlayerRaw).toHaveBeenCalledTimes(1);
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#QGRJ2222", {
      suppressTelemetry: true,
    });
    const liveUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(liveUpdate.clanTag).toBe("#2QG2C08UP");
  });

  it("clears both clan tag and clan name when observed live current reports no clan", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (tag: string) => ({
        tag,
        clan: { tag: "#2RYGLU2UY", name: "Wrong Clan" },
        townHallLevel: 14,
      })),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: cocService as any,
      observedLivePlayerCurrent: [
        {
          playerTag: "#PYLQ0289",
          clanTag: null,
          clanName: "  should be cleared  ",
          townHall: 16,
        },
      ],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getPlayerRaw).toHaveBeenCalledTimes(1);
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#QGRJ2222", {
      suppressTelemetry: true,
    });
    const liveUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(liveUpdate.clanTag).toBeNull();
    expect(liveUpdate.clanName).toBeNull();
  });

  it("persists the observed live clan name when the observed player is refreshed without live fetching", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      observedLivePlayerCurrent: [
        {
          playerTag: "#PYLQ0289",
          clanTag: "#2QG2C08UP",
          clanName: " Observed   Clan ",
          townHall: 16,
        },
      ],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    const liveUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(liveUpdate.clanTag).toBe("#2QG2C08UP");
    expect(liveUpdate.clanName).toBe("Observed Clan");
  });

  it("reuses observed live player current state through activated todo refresh without refetching the player", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        clanName: "Tracked Clan",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Tracked Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
      cadence: "tracked",
      cocService: cocService as any,
      observedLivePlayerCurrent: [
        {
          playerTag: "#PYLQ0289",
          clanTag: "#2QG2C08UP",
          clanName: "  Observed   Clan  ",
          townHall: 16,
        },
      ],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.selectedPlayerCount).toBe(1);
    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    const liveUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(liveUpdate.clanTag).toBe("#2QG2C08UP");
    expect(liveUpdate.clanName).toBe("Observed Clan");
  });

  it("reuses observed live no-clan state through activated todo refresh without refetching the player", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        clanName: "Tracked Clan",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Tracked Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
      cadence: "tracked",
      cocService: cocService as any,
      observedLivePlayerCurrent: [
        {
          playerTag: "#PYLQ0289",
          clanTag: null,
          clanName: "  should be cleared  ",
          townHall: 16,
        },
      ],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    const liveUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(liveUpdate.clanTag).toBeNull();
    expect(liveUpdate.clanName).toBeNull();
  });

  it("keeps an active WAR snapshot in tracked cadence when the current membership moved to an untracked clan", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#2QG2C08UP",
        clanName: "Moved Clan",
        warActive: true,
        warClanTag: "#PQL0289",
        warClanName: "Tracked Clan",
        warPosition: 8,
        warPhase: "battle day",
        warSourceUpdatedAt: new Date("2026-03-26T00:00:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Tracked Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2QG2C08UP", name: "Moved Clan" },
        townHallLevel: 15,
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260325T070000.000Z",
          endTime: "20260328T070000.000Z",
          members: [],
        },
      ]),
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "inWar",
        attacksPerMember: 2,
        startTime: "20260325T120000.000Z",
        endTime: "20260326T120000.000Z",
        clan: {
          tag: "#PQL0289",
          name: "Tracked Clan",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              townhallLevel: 15,
              mapPosition: 8,
              attacks: [{ order: 1 }],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent",
          members: [],
        },
      }),
    };

    const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
      cadence: "tracked",
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.trackedPlayerCount).toBe(1);
    expect(result.nonTrackedPlayerCount).toBe(0);
    expect(cocService.getCurrentWar).toHaveBeenCalledWith("#PQL0289");
    const warUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(warUpdate.clanTag).toBe("#2QG2C08UP");
    expect(warUpdate.clanName).toBe("Moved Clan");
    expect(warUpdate.warClanTag).toBe("#PQL0289");
    expect(warUpdate.warClanName).toBe("Tracked Clan");
    expect(warUpdate.warActive).toBe(true);
    expect(warUpdate.warPosition).toBe(8);
  });

  it("treats an active RAID snapshot in a tracked clan as tracked cadence", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        raidActive: true,
        raidClanTag: "#PQL0289",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-29T11:59:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Raid Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(0);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#PYLQ0289"],
          includeNonTrackedCwlRefresh: false,
        }),
      );
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("treats an active RAID snapshot in a raid-tracked clan as tracked cadence", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        raidActive: true,
        raidClanTag: "#QGRJ",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([
      { clanTag: "#QGRJ", name: "Raid Clan" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(0);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#PYLQ0289"],
          includeNonTrackedCwlRefresh: false,
        }),
      );
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("keeps an active RAID snapshot tracked even when current membership points to an untracked clan", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        raidActive: true,
        raidClanTag: "#PQL0289",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Raid Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(0);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#PYLQ0289"],
        }),
      );
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("keeps a legacy active RAID row on tracked cadence when raidClanTag is missing", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        raidActive: true,
        raidClanTag: null,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Raid Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Alpha" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([makeRaidSeason([
        { tag: "#PYLQ0289", attacks: 5 },
      ])]),
    };
    const refreshSpy = vi.spyOn(
      todoSnapshotService as any,
      "refreshSnapshotsForPlayerTagsInternal",
    );

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        cocService: cocService as any,
        nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
      });
      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(0);
      expect(result.selectedPlayerCount).toBe(1);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#PYLQ0289"],
        }),
      );
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("does not use a leftover raidClanTag when the raid snapshot is inactive", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        raidActive: false,
        raidClanTag: "#PQL0289",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-29T11:59:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQGRJ", name: "Tracked C" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Current B" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async (clanTag: string) => {
        const normalizedClanTag = normalizeClanTagForTest(clanTag);
        if (normalizedClanTag === "#2RYGLU2UY") {
          return [makeRaidSeason([])];
        }
        if (normalizedClanTag === "#PQGRJ") {
          return [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 5 }])];
        }
        return [makeRaidSeason([])];
      }),
    };
    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    const raidCallTags = cocService.getClanCapitalRaidSeasons.mock.calls.map(([clanTag]) =>
      normalizeClanTagForTest(String(clanTag)),
    );
    expect(raidCallTags).toHaveLength(2);
    expect(new Set(raidCallTags)).toEqual(new Set(["#2RYGLU2UY", "#PQGRJ"]));
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#2RYGLU2UY", 2);
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#PQGRJ", 2);
    expect(cocService.getClanCapitalRaidSeasons).not.toHaveBeenCalledWith("#PQL0289", 2);
    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      raidActive: true,
      raidClanTag: "#PQGRJ",
      raidClanName: "Tracked C",
      raidAttacksUsed: 5,
    });
  });

  it("queries RaidTrackedClan once during activated refresh even when the preload is empty", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        raidActive: true,
        raidClanTag: "#PQGRJ",
        raidClanName: "Tracked C",
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-29T11:59:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQGRJ", name: "Tracked C" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Current B" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([makeRaidSeason([])]),
    };

    await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
      cadence: "tracked",
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(prismaMock.raidTrackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
  });

  it("reuses supplied regular tracked rows during activated refresh without querying TrackedClan again internally", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        raidActive: true,
        raidClanTag: "#PQGRJ",
        raidClanName: "Tracked C",
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-29T11:59:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQGRJ", name: "Tracked C" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Current B" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([makeRaidSeason([])]),
    };

    await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
      cadence: "tracked",
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
  });

  it("loads full tracked rows once during active raid discovery and reuses them for both discovery and scoped lookup", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        raidActive: false,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2RYGLU2UY", name: "Current B" },
      { tag: "#PQGRJ", name: "Tracked C" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Current B" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async (clanTag: string) => {
        if (normalizeClanTagForTest(clanTag) === "#2RYGLU2UY") {
          return [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 1 }])];
        }
        if (normalizeClanTagForTest(clanTag) === "#PQGRJ") {
          return [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 2 }])];
        }
        return [makeRaidSeason([])];
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#2RYGLU2UY", 2);
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#PQGRJ", 2);
  });

  it("excludes an active RAID player from observe-cadence selection", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        raidActive: true,
        raidClanTag: "#PQL0289",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Raid Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const refreshSpy = vi.spyOn(
      todoSnapshotService as any,
      "refreshSnapshotsForPlayerTagsInternal",
    );

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "observe",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(0);
      expect(result.selectedPlayerCount).toBe(0);
      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("reports the active RAID context count in refresh telemetry", async () => {
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
      { discordUserId: "111111111111111111", playerTag: "#QGRJ2222" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        raidActive: true,
        raidClanTag: "#PQL0289",
      }),
      buildSnapshotRow({
        playerTag: "#QGRJ2222",
        clanTag: "#2RYGLU2UY",
        raidActive: true,
        raidClanTag: "#QGRJ",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2RYGLU2UY",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#PQL0289",
        playerName: "Bravo",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Raid Clan A" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([
      { clanTag: "#QGRJ", name: "Raid Clan B" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 2, updatedCount: 2 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.trackedPlayerCount).toBe(2);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#PYLQ0289", "#QGRJ2222"],
        }),
      );
      expect(
        consoleInfoSpy.mock.calls.some(([message]) =>
          String(message).includes("snapshot_raid_context_count=2"),
        ),
      ).toBe(true);
    } finally {
      refreshSpy.mockRestore();
      consoleInfoSpy.mockRestore();
    }
  });

  it("preserves existing live fetch behavior when no observed map is provided", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (tag: string) => ({
        tag,
        clan: { tag: "#MISS" },
        townHallLevel: 14,
      })),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getPlayerRaw).toHaveBeenCalledTimes(2);
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#PYLQ0289", {
      suppressTelemetry: true,
    });
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#QGRJ2222", {
      suppressTelemetry: true,
    });
  });

  it("prefers live player responses first, then fresh PlayerCurrent, then fresh FWA membership", async () => {
    const staleAt = new Date("2026-02-01T00:00:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Stale Alpha",
        currentClanTag: "#2RYGLU2UY",
        currentClanName: "Stale Clan",
        lastFetchedAt: staleAt,
        updatedAt: staleAt,
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Stale Bravo",
        currentClanTag: null,
        currentClanName: null,
        lastFetchedAt: staleAt,
        updatedAt: staleAt,
      },
      {
        playerTag: "#UCUC2222",
        playerName: "Fresh Charlie",
        currentClanTag: "#PQL0289J",
        currentClanName: "Current Clan",
        lastFetchedAt: new Date("2026-03-26T00:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289J",
        playerName: "Fresh Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#PQL0289",
        playerName: "Fresh Bravo",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#UCUC2222",
        clanTag: "#2QG2C08UP",
        playerName: "Fresh Charlie",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (playerTag: string) => {
        if (playerTag === "#PYLQ0289") {
          return null;
        }
        if (playerTag === "#QGRJ2222") {
          return null;
        }
        return null;
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222", "#UCUC2222"],
      cocService: cocService as any,
      observedLivePlayerCurrent: [
        {
          playerTag: "#PYLQ0289",
          clanTag: "#2QG2C08UP",
          townHall: 16,
        },
      ],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    const liveUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(liveUpdate.clanTag).toBe("#2QG2C08UP");
    expect(liveUpdate.clanMembershipObservedAt).toEqual(new Date("2026-03-26T00:00:00.000Z"));

    const fwaUpdate = getTodoSnapshotUpsertUpdateForPlayer("#QGRJ2222");
    expect(fwaUpdate.clanTag).toBe("#PQL0289");
    expect(fwaUpdate.clanMembershipObservedAt).toEqual(new Date("2026-03-26T00:00:00.000Z"));
    expect(cocService.getPlayerRaw).toHaveBeenCalledTimes(2);
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#QGRJ2222", {
      suppressTelemetry: true,
    });
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#UCUC2222", {
      suppressTelemetry: true,
    });

    const currentUpdate = getTodoSnapshotUpsertUpdateForPlayer("#UCUC2222");
    expect(currentUpdate.clanTag).toBe("#PQL0289J");
    expect(currentUpdate.clanMembershipObservedAt).toEqual(new Date("2026-03-26T00:00:00.000Z"));
  });

  it("preserves degraded existing membership timestamps and keeps unrelated snapshot rebuilds from inventing membership", async () => {
    const observedAt = new Date("2026-03-20T08:30:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Existing Alpha",
        clanTag: "#2QVGPQP0U",
        clanName: "Old Clan",
        clanMembershipObservedAt: observedAt,
        warActive: true,
        warPhase: "battle day",
        gamesActive: true,
        gamesPoints: 123,
      }),
      buildSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Existing Bravo",
        clanTag: null,
        clanName: null,
        clanMembershipObservedAt: null,
        warActive: true,
        warPhase: "battle day",
        gamesActive: true,
        gamesPoints: 456,
      }),
      buildSnapshotRow({
        playerTag: "#VUVU2222",
        playerName: "Existing Charlie",
        clanTag: "#2QVGPQP0U",
        clanName: "Old Clan",
        clanMembershipObservedAt: observedAt,
        warActive: true,
        warPhase: "battle day",
        gamesActive: true,
        gamesPoints: 789,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (playerTag: string) => {
        if (playerTag === "#VUVU2222") {
          return {
            tag: "#VUVU2222",
            clan: { tag: "#2QG2C08UP", name: "New Clan" },
            townHallLevel: 15,
          };
        }
        return null;
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222", "#VUVU2222"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    const degradedUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(degradedUpdate.clanTag).toBe("#2QVGPQP0U");
    expect(degradedUpdate.clanName).toBe("Old Clan");
    expect(degradedUpdate.clanMembershipObservedAt).toBe(observedAt);

    const clearedUpdate = getTodoSnapshotUpsertUpdateForPlayer("#QGRJ2222");
    expect(clearedUpdate.clanTag).toBeNull();
    expect(clearedUpdate.clanName).toBeNull();
    expect(clearedUpdate.clanMembershipObservedAt).toBeNull();
    expect(clearedUpdate.gamesPoints).toBe(0);

    const movedUpdate = getTodoSnapshotUpsertUpdateForPlayer("#VUVU2222");
    expect(movedUpdate.clanTag).toBe("#2QG2C08UP");
    expect(movedUpdate.clanName).toBe("New Clan");
    expect(movedUpdate.clanMembershipObservedAt).toEqual(new Date("2026-03-26T00:00:00.000Z"));
  });

  it("uses a preloaded live current-war payload when the current membership points at a different clan", async () => {
    const currentWarStartTime = new Date("2026-03-25T12:00:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#2RYGLU2UY",
        clanName: "Other Clan",
        clanMembershipObservedAt: new Date("2026-03-20T08:30:00.000Z"),
        warClanTag: "#2QG2C08UP",
        warClanName: "Live Clan",
        warPosition: 8,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        currentClanTag: "#2RYGLU2UY",
        currentClanName: "Other Clan",
        lastFetchedAt: new Date("2026-03-26T00:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#2QG2C08UP" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        state: "inWar",
        startTime: currentWarStartTime,
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Live Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue(null),
      getCurrentWar: vi.fn().mockResolvedValue(null),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      preloadedCurrentWarSnapshotsByClanTag: new Map([
        [
          "#2QG2C08UP",
          {
            state: "inWar",
            attacksPerMember: 2,
            startTime: "20260325T120000.000Z",
            endTime: "20260326T120000.000Z",
            clan: {
              tag: "#2QG2C08UP",
              name: "Live Clan",
              members: [
                {
                  tag: "#PYLQ0289",
                  name: "Live Alpha",
                  townhallLevel: 15,
                  mapPosition: 8,
                  attacks: [{ order: 1 }],
                },
              ],
            },
            opponent: {
              tag: "#OPP",
              name: "Opponent",
              members: [],
            },
          } as any,
        ],
      ]),
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    const warUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(warUpdate.clanTag).toBe("#2RYGLU2UY");
    expect(warUpdate.clanName).toBe("Other Clan");
    expect(warUpdate.warClanTag).toBe("#2QG2C08UP");
    expect(warUpdate.warClanName).toBe("Live Clan");
    expect(warUpdate.warPosition).toBe(8);
    expect(warUpdate.warActive).toBe(true);
    expect(warUpdate.warPhase).toBe("battle day");
    expect(warUpdate.warEndsAt).toEqual(new Date("2026-03-26T12:00:00.000Z"));
    expect(warUpdate.warSourceUpdatedAt).toEqual(expect.any(Date));
  });

  it("preserves a legacy active-war clan hint when warClanTag is missing and the player has moved elsewhere", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#2QVGPQP0U",
        clanName: "Old Clan",
        warActive: true,
        warClanTag: null,
        warClanName: null,
        warPosition: 8,
        warPhase: "battle day",
        warSourceUpdatedAt: new Date("2026-03-25T12:00:00.000Z"),
        clanMembershipObservedAt: new Date("2026-03-20T08:30:00.000Z"),
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#2QVGPQP0U" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Old Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "New Clan" },
        townHallLevel: 15,
      }),
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "inWar",
        attacksPerMember: 2,
        startTime: "20260325T120000.000Z",
        endTime: "20260326T120000.000Z",
        clan: {
          tag: "#2QVGPQP0U",
          name: "Old Clan",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              townhallLevel: 15,
              mapPosition: 8,
              attacks: [{ order: 1 }],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent",
          members: [],
        },
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      preloadedCurrentWarSnapshotsByClanTag: new Map([
        [
          "#2QVGPQP0U",
          {
            state: "inWar",
            attacksPerMember: 2,
            startTime: "20260325T120000.000Z",
            endTime: "20260326T120000.000Z",
            clan: {
              tag: "#2QVGPQP0U",
              name: "Old Clan",
              members: [
                {
                  tag: "#PYLQ0289",
                  name: "Alpha",
                  townhallLevel: 15,
                  mapPosition: 8,
                  attacks: [{ order: 1 }],
                },
              ],
            },
            opponent: {
              tag: "#OPP",
              name: "Opponent",
              members: [],
            },
          } as any,
        ],
      ]),
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#2RYGLU2UY",
          clanName: "New Clan",
          warClanTag: "#2QVGPQP0U",
          warClanName: "Old Clan",
          warPosition: 8,
          warActive: true,
        }),
      }),
    );
  });

  it("corrects a stale Rocky Road WAR owner to TheWiseCowboys when live lineup proves the player belongs there", async () => {
    const rockyRoadClanTag = "#2RYGLU2UY";
    const twcClanTag = "#29PCQGUV0";
    const playerTag = "#PYLQ0289";
    const currentWarStartTime = new Date("2026-03-25T12:00:00.000Z");

    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag,
        playerName: "Party Blizzard",
        clanTag: twcClanTag,
        clanName: "TheWiseCowboys",
        warActive: true,
        warClanTag: rockyRoadClanTag,
        warClanName: "Rocky Road",
        warPosition: 18,
        warAttacksUsed: 1,
        warSourceUpdatedAt: new Date("2026-03-25T12:00:00.000Z"),
        clanMembershipObservedAt: new Date("2026-03-20T08:30:00.000Z"),
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      {
        playerTag,
        playerName: "Party Blizzard",
        currentClanTag: twcClanTag,
        currentClanName: "TheWiseCowboys",
        lastFetchedAt: new Date("2026-03-26T00:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag,
        clanTag: twcClanTag,
        playerName: "Party Blizzard",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: rockyRoadClanTag },
      { clanTag: twcClanTag },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: rockyRoadClanTag,
        playerTag,
        position: 18,
        playerName: "Party Blizzard",
        townHall: 15,
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: rockyRoadClanTag,
        warId: 1001,
        state: "inWar",
        startTime: currentWarStartTime,
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: twcClanTag,
        warId: 1002,
        state: "inWar",
        startTime: currentWarStartTime,
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:01:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: rockyRoadClanTag, name: "Rocky Road" },
      { tag: twcClanTag, name: "TheWiseCowboys" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue(null),
      getCurrentWar: vi.fn().mockResolvedValue(null),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: [playerTag],
      cocService: cocService as any,
      preloadedCurrentWarSnapshotsByClanTag: new Map([
        [
          rockyRoadClanTag,
          {
            state: "inWar",
            attacksPerMember: 2,
            startTime: "20260325T120000.000Z",
            endTime: "20260326T120000.000Z",
            clan: {
              tag: rockyRoadClanTag,
              name: "Rocky Road",
              members: [
                {
                  tag: playerTag,
                  name: "Party Blizzard",
                  townhallLevel: 15,
                  mapPosition: 18,
                  attacks: [{ order: 1 }],
                },
              ],
            },
            opponent: {
              tag: "#OPP",
              name: "Opponent",
              members: [],
            },
          } as any,
        ],
        [
          twcClanTag,
          {
            state: "inWar",
            attacksPerMember: 2,
            startTime: "20260325T120000.000Z",
            endTime: "20260326T120000.000Z",
            clan: {
              tag: twcClanTag,
              name: "TheWiseCowboys",
              members: [
                {
                  tag: playerTag,
                  name: "Party Blizzard",
                  townhallLevel: 15,
                  mapPosition: 8,
                  attacks: [{ order: 1 }, { order: 2 }],
                },
              ],
            },
            opponent: {
              tag: "#OPP",
              name: "Opponent",
              members: [],
            },
          } as any,
        ],
      ]),
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: twcClanTag,
          clanName: "TheWiseCowboys",
          clanMembershipObservedAt: new Date("2026-03-26T00:00:00.000Z"),
          warClanTag: twcClanTag,
          warClanName: "TheWiseCowboys",
          warActive: true,
          warPosition: 8,
          warAttacksUsed: 2,
          warSourceUpdatedAt: expect.any(Date),
        }),
      }),
    );
    expect(prismaMock.todoPlayerSnapshot.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          warClanTag: rockyRoadClanTag,
        }),
      }),
    );
  });

  it("keeps a derived tracked-war candidate active when live verification is unavailable", async () => {
    const clanTag = "#2QVGPQP0U";
    const playerTag = "#PYLQ0289";
    const currentWarStartTime = new Date("2026-03-25T12:00:00.000Z");

    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag,
        playerName: "Alpha",
        clanTag,
        clanName: "Clan Two",
        warActive: true,
        warClanTag: clanTag,
        warClanName: "Clan Two",
        warPosition: 8,
        warAttacksUsed: 1,
        warSourceUpdatedAt: new Date("2026-03-25T12:00:00.000Z"),
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      {
        playerTag,
        playerName: "Alpha",
        currentClanTag: clanTag,
        currentClanName: "Clan Two",
        lastFetchedAt: new Date("2026-03-26T00:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag,
        clanTag,
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag,
        playerTag,
        position: 8,
        playerName: "Alpha",
        townHall: 15,
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag,
        warStartTime: currentWarStartTime,
        playerTag,
        playerPosition: 8,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 7,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:05:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag,
        warId: 1001,
        state: "inWar",
        startTime: currentWarStartTime,
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: clanTag, name: "Clan Two" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: [playerTag],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag,
          clanName: "Clan Two",
          warClanTag: clanTag,
          warClanName: "Clan Two",
          warActive: true,
          warPosition: 8,
          warAttacksUsed: 1,
        }),
      }),
    );
  });

  it("resolves the same WAR owner when persisted candidate order is reversed but live evidence is unchanged", async () => {
    const rockyRoadClanTag = "#2RYGLU2UY";
    const twcClanTag = "#29PCQGUV0";
    const playerTag = "#PYLQ0289";
    const currentWarStartTime = new Date("2026-03-25T12:00:00.000Z");

    async function runScenario(reversed: boolean): Promise<Record<string, unknown>> {
      resetTodoSnapshotServiceForTest();
      vi.clearAllMocks();
      prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
        buildSnapshotRow({
          playerTag,
          playerName: "Party Blizzard",
          clanTag: twcClanTag,
          clanName: "TheWiseCowboys",
          warActive: true,
          warClanTag: rockyRoadClanTag,
          warClanName: "Rocky Road",
          warPosition: 18,
          warAttacksUsed: 1,
          warSourceUpdatedAt: new Date("2026-03-25T12:00:00.000Z"),
          clanMembershipObservedAt: new Date("2026-03-20T08:30:00.000Z"),
        }),
      ]);
      prismaMock.playerCurrent.findMany.mockResolvedValue([
        {
          playerTag,
          playerName: "Party Blizzard",
          currentClanTag: twcClanTag,
          currentClanName: "TheWiseCowboys",
          lastFetchedAt: new Date("2026-03-26T00:00:00.000Z"),
          updatedAt: new Date("2026-03-26T00:00:00.000Z"),
        },
      ]);
      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
        {
          playerTag,
          clanTag: twcClanTag,
          playerName: "Party Blizzard",
          sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
        },
      ]);
      prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
      prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue(
        reversed
          ? [{ clanTag: twcClanTag }, { clanTag: rockyRoadClanTag }]
          : [{ clanTag: rockyRoadClanTag }, { clanTag: twcClanTag }],
      );
      prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
        {
          clanTag: rockyRoadClanTag,
          playerTag,
          position: 18,
          playerName: "Party Blizzard",
          townHall: 15,
        },
      ]);
      prismaMock.currentWar.findMany.mockResolvedValue(
        reversed
          ? [
              {
                clanTag: twcClanTag,
                warId: 1002,
                state: "inWar",
                startTime: currentWarStartTime,
                endTime: new Date("2026-03-26T12:00:00.000Z"),
                updatedAt: new Date("2026-03-26T00:01:00.000Z"),
              },
              {
                clanTag: rockyRoadClanTag,
                warId: 1001,
                state: "inWar",
                startTime: currentWarStartTime,
                endTime: new Date("2026-03-26T12:00:00.000Z"),
                updatedAt: new Date("2026-03-26T00:00:00.000Z"),
              },
            ]
          : [
              {
                clanTag: rockyRoadClanTag,
                warId: 1001,
                state: "inWar",
                startTime: currentWarStartTime,
                endTime: new Date("2026-03-26T12:00:00.000Z"),
                updatedAt: new Date("2026-03-26T00:00:00.000Z"),
              },
              {
                clanTag: twcClanTag,
                warId: 1002,
                state: "inWar",
                startTime: currentWarStartTime,
                endTime: new Date("2026-03-26T12:00:00.000Z"),
                updatedAt: new Date("2026-03-26T00:01:00.000Z"),
              },
            ],
      );
      prismaMock.trackedClan.findMany.mockResolvedValue(
        reversed
          ? [
              { tag: twcClanTag, name: "TheWiseCowboys" },
              { tag: rockyRoadClanTag, name: "Rocky Road" },
            ]
          : [
              { tag: rockyRoadClanTag, name: "Rocky Road" },
              { tag: twcClanTag, name: "TheWiseCowboys" },
            ],
      );
      prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
      prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
      prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
      prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
      prismaMock.botSetting.findMany.mockResolvedValue([]);
      const cocService = {
        getPlayerRaw: vi.fn().mockResolvedValue(null),
        getCurrentWar: vi.fn().mockResolvedValue(null),
      };

      await todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags: [playerTag],
        cocService: cocService as any,
        preloadedCurrentWarSnapshotsByClanTag: new Map([
          [
            rockyRoadClanTag,
            {
              state: "inWar",
              attacksPerMember: 2,
              startTime: "20260325T120000.000Z",
              endTime: "20260326T120000.000Z",
              clan: {
                tag: rockyRoadClanTag,
                name: "Rocky Road",
                members: [
                  {
                    tag: playerTag,
                    name: "Party Blizzard",
                    townhallLevel: 15,
                    mapPosition: 18,
                    attacks: [{ order: 1 }],
                  },
                ],
              },
              opponent: {
                tag: "#OPP",
                name: "Opponent",
                members: [],
              },
            } as any,
          ],
          [
            twcClanTag,
            {
              state: "inWar",
              attacksPerMember: 2,
              startTime: "20260325T120000.000Z",
              endTime: "20260326T120000.000Z",
              clan: {
                tag: twcClanTag,
                name: "TheWiseCowboys",
                members: [
                  {
                    tag: playerTag,
                    name: "Party Blizzard",
                    townhallLevel: 15,
                    mapPosition: 8,
                    attacks: [{ order: 1 }, { order: 2 }],
                  },
                ],
              },
              opponent: {
                tag: "#OPP",
                name: "Opponent",
                members: [],
              },
            } as any,
          ],
        ]),
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      const warUpdate = getTodoSnapshotUpsertUpdateForPlayer(playerTag);
      expect(cocService.getCurrentWar).not.toHaveBeenCalled();
      return warUpdate;
    }

    const first = await runScenario(false);
    const second = await runScenario(true);

    expect(first.warClanTag).toBe(twcClanTag);
    expect(second.warClanTag).toBe(twcClanTag);
    expect(first.warPosition).toBe(8);
    expect(second.warPosition).toBe(8);
    expect(first.warAttacksUsed).toBe(2);
    expect(second.warAttacksUsed).toBe(2);
  });

  it("excludes users who have never used /todo from background todo refreshes", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
      { discordUserId: "222222222222222222", playerTag: "#QGRJ2222" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([]);
    const refreshSpy = vi.spyOn(todoSnapshotService, "refreshSnapshotsForPlayerTags");

    const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
      cadence: "tracked",
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.activatedUserCount).toBe(0);
    expect(result.selectedPlayerCount).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("refreshes tracked-cadence players from persisted clan-member evidence when a snapshot clanTag is stale", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
      { discordUserId: "111111111111111111", playerTag: "#QGRJ2222" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#OLDCLAN",
      }),
      buildSnapshotRow({
        playerTag: "#QGRJ2222",
        clanTag: "#NONT",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#NONT",
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Clan Two" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.activatedUserCount).toBe(1);
      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(1);
      expect(result.selectedPlayerCount).toBe(1);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#PYLQ0289"],
          includeNonTrackedCwlRefresh: false,
        }),
      );
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("hydrates raid-tracked clan names during snapshot refresh", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#QGRJ",
        clanName: null,
        raidActive: false,
        raidAttacksUsed: 0,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([
      { clanTag: "#QGRJ", name: "Raid Clan" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#QGRJ" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [{ tag: "#PYLQ0289", attacks: 3 }],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#QGRJ", 2);
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#QGRJ",
          clanName: "Raid Clan",
          raidActive: true,
          raidAttacksUsed: 3,
        }),
      }),
    );
  });

  it("falls back to tracked raid clans when current clan returns zero raid attacks", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#G2RG9JCRL",
        clanTag: "#2RYGLU2UY",
        clanName: "Tracked FWA",
        raidActive: false,
        raidAttacksUsed: 0,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#G2RG9JCRL",
        clanTag: "#2RYGLU2UY",
        playerName: "Gamma",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2RYGLU2UY", name: "Tracked FWA" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([
      { clanTag: "#QGRJ", name: "Raid Clan" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#G2RG9JCRL",
        clan: { tag: "#2RYGLU2UY" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async (clanTag: string) => {
        if (normalizeClanTagForTest(clanTag) === "#QGRJ") {
          return [
            {
              startTime: "20260327T070000.000Z",
              endTime: "20260330T070000.000Z",
              members: [{ tag: "#G2RG9JCRL", attacks: 1 }],
            },
          ];
        }
        return [
          {
            startTime: "20260327T070000.000Z",
            endTime: "20260330T070000.000Z",
            members: [],
          },
        ];
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#G2RG9JCRL"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 27, 12, 0, 0, 0),
    });
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          raidActive: true,
          raidAttacksUsed: 1,
        }),
      }),
    );
  });

  it("refreshes observe-cadence players with tracked evidence excluded from the refresh set", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
      { discordUserId: "111111111111111111", playerTag: "#QGRJ2222" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#OLDCLAN",
      }),
      buildSnapshotRow({
        playerTag: "#QGRJ2222",
        clanTag: "#NONT",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#NONT",
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Clan Two" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "observe",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.activatedUserCount).toBe(1);
      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(1);
      expect(result.selectedPlayerCount).toBe(1);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#QGRJ2222"],
          includeNonTrackedCwlRefresh: true,
        }),
      );
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("includes players from tracked active-war roster rows when the snapshot row is missing", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        playerTag: "#PYLQ0289",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "inWar",
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Clan Two" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(0);
      expect(result.selectedPlayerCount).toBe(1);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#PYLQ0289"],
        }),
      );
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("includes players from tracked active-war member rows when the snapshot row is missing", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "inWar",
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Clan Two" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(0);
      expect(result.selectedPlayerCount).toBe(1);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#PYLQ0289"],
        }),
      );
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("does not classify war-member evidence as tracked when the clan's current war is inactive", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "finished",
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Clan Two" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.trackedPlayerCount).toBe(0);
      expect(result.nonTrackedPlayerCount).toBe(1);
      expect(result.selectedPlayerCount).toBe(0);
      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("ignores snapshot CWL clan tags from previous seasons when selecting tracked refresh candidates", async () => {
    const nowMs = Date.UTC(2026, 2, 26, 0, 0, 0, 0);
    const currentCwlSeason = resolveCurrentCwlSeasonKey(nowMs);
    const previousCwlSeason = resolveCurrentCwlSeasonKey(Date.UTC(2026, 1, 26, 0, 0, 0, 0));

    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#NONT",
        cwlClanTag: "#2QG2C08UP",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.season === currentCwlSeason) {
        return [];
      }
      return [{ tag: "#2QG2C08UP", name: `Old CWL ${previousCwlSeason}` }];
    });
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs,
      });

      expect(result.activatedUserCount).toBe(1);
      expect(result.trackedPlayerCount).toBe(0);
      expect(result.nonTrackedPlayerCount).toBe(1);
      expect(result.selectedPlayerCount).toBe(0);
      expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { season: currentCwlSeason },
          select: { tag: true },
        }),
      );
      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("classifies snapshot CWL clan tags from the current season as tracked refresh candidates", async () => {
    const nowMs = Date.UTC(2026, 2, 26, 0, 0, 0, 0);
    const currentCwlSeason = resolveCurrentCwlSeasonKey(nowMs);

    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.todoUserUsage.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111" },
    ]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#NONT",
        cwlClanTag: "#2QG2C08UP",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.season === currentCwlSeason) {
        return [{ tag: "#2QG2C08UP" }];
      }
      return [];
    });
    const refreshSpy = vi
      .spyOn(todoSnapshotService as any, "refreshSnapshotsForPlayerTagsInternal")
      .mockResolvedValue({ playerCount: 1, updatedCount: 1 });

    try {
      const result = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
        cadence: "tracked",
        nowMs,
      });

      expect(result.activatedUserCount).toBe(1);
      expect(result.trackedPlayerCount).toBe(1);
      expect(result.nonTrackedPlayerCount).toBe(0);
      expect(result.selectedPlayerCount).toBe(1);
      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          playerTags: ["#PYLQ0289"],
          includeNonTrackedCwlRefresh: false,
        }),
      );
      expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { season: currentCwlSeason },
          select: { tag: true },
        }),
      );
    } finally {
      refreshSpy.mockRestore();
    }
  });

  it("sources active raid attacks from live clan raid members even for untracked clans", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        warActive: false,
        raidActive: false,
        raidAttacksUsed: 0,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#P2YLC8R0" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [{ tag: "#PYLQ0289", attacks: 6 }],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 27, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#P2YLC8R0", 2);
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#P2YLC8R0",
          raidActive: true,
          raidAttacksUsed: 6,
        }),
      }),
    );
  });

  it("queries regular tracked clans during active raid discovery even when they are not raid-tracked", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        raidActive: false,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockImplementation(
      mockTrackedClanFindManyByWhere([{ tag: "#PQL0289", name: "Tracked Raid Clan" }]),
    );
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Moved Clan" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async (clanTag: string) => {
        if (normalizeClanTagForTest(clanTag) === "#2RYGLU2UY") {
          return [makeRaidSeason([])];
        }
        if (normalizeClanTagForTest(clanTag) === "#PQL0289") {
          return [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 4 }])];
        }
        return [makeRaidSeason([])];
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#2RYGLU2UY", 2);
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#PQL0289", 2);
    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      raidActive: true,
      raidClanTag: "#PQL0289",
      raidClanName: "Tracked Raid Clan",
      raidAttacksUsed: 4,
    });
  });

  it("prefers persisted active raid context over a conflicting current-membership clan", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Raid Clan A",
        raidAttacksUsed: 4,
        raidAttacksMax: 6,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockImplementation(
      mockTrackedClanFindManyByWhere([
        { tag: "#PQL0289", name: "Raid Clan A" },
        { tag: "#2RYGLU2UY", name: "Raid Clan B" },
      ]),
    );
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Moved Clan" },
        townHallLevel: 15,
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async (clanTag: string) => {
        if (normalizeClanTagForTest(clanTag) === "#PQL0289") {
          return [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 4 }])];
        }
        if (normalizeClanTagForTest(clanTag) === "#2RYGLU2UY") {
          return [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 1 }])];
        }
        return [makeRaidSeason([])];
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenNthCalledWith(1, "#PQL0289", 2);
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenNthCalledWith(2, "#2RYGLU2UY", 2);
    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      clanTag: "#2RYGLU2UY",
      raidActive: true,
      raidClanTag: "#PQL0289",
      raidClanName: "Raid Clan A",
      raidAttacksUsed: 4,
    });
  });

  it("retains a persisted active RAID clan name even when tracked discovery omits that tag", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Raid Clan A",
        raidAttacksUsed: 3,
        raidAttacksMax: 6,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2RYGLU2UY", name: "Raid Clan B" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Raid Clan B" },
        townHallLevel: 15,
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async (clanTag: string) => {
        if (normalizeClanTagForTest(clanTag) === "#PQL0289") {
          return [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 3 }])];
        }
        if (normalizeClanTagForTest(clanTag) === "#2RYGLU2UY") {
          return [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 1 }])];
        }
        return [makeRaidSeason([])];
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      clanTag: "#2RYGLU2UY",
      raidActive: true,
      raidClanTag: "#PQL0289",
      raidClanName: "Raid Clan A",
      raidAttacksUsed: 3,
    });
  });

  it("fetches a legacy active raid clan from clanTag when raidClanTag is missing", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        raidActive: true,
        raidClanTag: null,
        raidClanName: "Raid Clan A",
        raidAttacksUsed: 5,
        raidAttacksMax: 6,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockImplementation(
      mockTrackedClanFindManyByWhere([
        { tag: "#PQL0289", name: "Raid Clan A" },
        { tag: "#2RYGLU2UY", name: "Moved Clan" },
      ]),
    );
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Moved Clan" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async (clanTag: string) => {
        if (normalizeClanTagForTest(clanTag) === "#PQL0289") {
          return [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 5 }])];
        }
        return [makeRaidSeason([])];
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#PQL0289", 2);
    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      clanTag: "#2RYGLU2UY",
      raidActive: true,
      raidClanTag: "#PQL0289",
      raidClanName: "Raid Clan A",
      raidAttacksUsed: 5,
    });
  });

  it("deduplicates repeated raid clans across current membership, tracked clans, raid-tracked clans, and persisted hints", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        raidActive: true,
        raidClanTag: "#PQL0289",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Raid Clan A" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([
      { clanTag: "#PQL0289", name: "Raid Clan A" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289", name: "Raid Clan A" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue(
        [makeRaidSeason([{ tag: "#PYLQ0289", attacks: 4 }])],
      ),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledTimes(1);
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#PQL0289", 2);
  });

  it("preserves raid state when a persisted active raid candidate fails and no match is found", async () => {
    const preservedRaidEndsAt = new Date("2026-03-30T07:00:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Raid Clan A",
        raidAttacksUsed: 4,
        raidAttacksMax: 6,
        raidEndsAt: preservedRaidEndsAt,
        raidSourceUpdatedAt: new Date("2026-03-28T12:00:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2RYGLU2UY", name: "Current Clan" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Current Clan" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async (clanTag: string) => {
        if (normalizeClanTagForTest(clanTag) === "#PQL0289") {
          throw new Error("raid fetch failed");
        }
        return [makeRaidSeason([])];
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      clanTag: "#2RYGLU2UY",
      raidActive: true,
      raidClanTag: "#PQL0289",
      raidClanName: "Raid Clan A",
      raidAttacksUsed: 4,
      raidAttacksMax: 6,
      raidEndsAt: preservedRaidEndsAt,
    });
  });

  it("authoritatively clears raid state when all candidate clans fetch successfully and the player is absent", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Raid Clan A",
        raidAttacksUsed: 5,
        raidAttacksMax: 6,
        raidEndsAt: new Date("2026-03-30T07:00:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2RYGLU2UY", name: "Current Clan" },
      { tag: "#PQL0289", name: "Raid Clan A" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2RYGLU2UY", name: "Current Clan" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async () => [makeRaidSeason([])]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledTimes(2);
    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      raidActive: false,
      raidClanTag: null,
      raidClanName: null,
      raidAttacksUsed: 0,
      raidAttacksMax: 6,
      raidEndsAt: null,
    });
  });

  it("preserves the active raid clan context when a linked account moves clans", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        raidActive: true,
        raidAttacksUsed: 4,
        raidEndsAt: new Date("2026-03-29T07:00:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289J",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-27T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289J" },
        townHallLevel: 15,
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [{ tag: "#PYLQ0289", attacks: 6 }],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 27, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#PQL0289J", 2);
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289J",
          raidActive: true,
          raidAttacksUsed: 6,
        }),
      }),
    );
  });

  it("fetches raid-season data once per clan and fans out attacks across same-clan linked players", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (tag: string) => ({
        tag,
        clan: { tag: "#P2YLC8R0" },
      })),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [
            { tag: "#PYLQ0289", attacks: 4 },
            { tag: "#QGRJ2222", attacks: 2 },
          ],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 27, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledTimes(1);
    const upsertByTag = new Map(
      prismaMock.todoPlayerSnapshot.upsert.mock.calls.map((call: any[]) => [
        call?.[0]?.where?.playerTag,
        call?.[0]?.update?.raidAttacksUsed,
      ]),
    );
    expect(upsertByTag.get("#PYLQ0289")).toBe(4);
    expect(upsertByTag.get("#QGRJ2222")).toBe(2);
  });

  it("clears raid fields when player is absent from live raid member list", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        raidActive: true,
        raidAttacksUsed: 5,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#P2YLC8R0" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [{ tag: "#QGRJ2222", attacks: 6 }],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 27, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          raidActive: false,
          raidClanTag: null,
          raidClanName: null,
          raidAttacksUsed: 0,
          raidEndsAt: null,
        }),
      }),
    );
  });

  it("resolves raid weekend windows across the Friday UTC start and Monday UTC end", () => {
    const beforeStart = resolveRaidWeekendWindowForTest(
      Date.UTC(2026, 2, 27, 6, 59, 59, 999),
    );
    const atStart = resolveRaidWeekendWindowForTest(
      Date.UTC(2026, 2, 27, 7, 0, 0, 0),
    );
    const midWeekend = resolveRaidWeekendWindowForTest(
      Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    );
    const beforeEnd = resolveRaidWeekendWindowForTest(
      Date.UTC(2026, 2, 30, 6, 59, 59, 999),
    );
    const atEnd = resolveRaidWeekendWindowForTest(
      Date.UTC(2026, 2, 30, 7, 0, 0, 0),
    );
    const afterEnd = resolveRaidWeekendWindowForTest(
      Date.UTC(2026, 2, 30, 7, 0, 0, 1),
    );

    expect(beforeStart.active).toBe(false);
    expect(beforeStart.startMs).toBe(Date.UTC(2026, 2, 27, 7, 0, 0, 0));
    expect(beforeStart.endMs).toBe(Date.UTC(2026, 2, 30, 7, 0, 0, 0));

    expect(atStart.active).toBe(true);
    expect(atStart.startMs).toBe(Date.UTC(2026, 2, 27, 7, 0, 0, 0));
    expect(atStart.endMs).toBe(Date.UTC(2026, 2, 30, 7, 0, 0, 0));

    expect(midWeekend.active).toBe(true);
    expect(midWeekend.startMs).toBe(Date.UTC(2026, 2, 27, 7, 0, 0, 0));
    expect(midWeekend.endMs).toBe(Date.UTC(2026, 2, 30, 7, 0, 0, 0));

    expect(beforeEnd.active).toBe(true);
    expect(beforeEnd.startMs).toBe(Date.UTC(2026, 2, 27, 7, 0, 0, 0));
    expect(beforeEnd.endMs).toBe(Date.UTC(2026, 2, 30, 7, 0, 0, 0));

    expect(atEnd.active).toBe(false);
    expect(atEnd.startMs).toBe(Date.UTC(2026, 3, 3, 7, 0, 0, 0));
    expect(atEnd.endMs).toBe(Date.UTC(2026, 3, 6, 7, 0, 0, 0));

    expect(afterEnd.active).toBe(false);
    expect(afterEnd.startMs).toBe(Date.UTC(2026, 3, 3, 7, 0, 0, 0));
    expect(afterEnd.endMs).toBe(Date.UTC(2026, 3, 6, 7, 0, 0, 0));
  });

  it("writes raidActive=true for snapshots refreshed during an active raid weekend and false outside it", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        raidActive: false,
        raidAttacksUsed: 0,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [{ tag: "#PYLQ0289", attacks: 3 }],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          raidActive: true,
          raidAttacksUsed: 3,
          raidClanTag: "#PQL0289",
          raidClanName: "Clan One",
          raidSourceUpdatedAt: new Date("2026-03-29T12:00:00.000Z"),
          lastUpdatedAt: new Date("2026-03-29T12:00:00.000Z"),
        }),
      }),
    );
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#PQL0289", 2);

    prismaMock.todoPlayerSnapshot.upsert.mockClear();
    (cocService.getClanCapitalRaidSeasons as ReturnType<typeof vi.fn>).mockClear();

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 3, 2, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          raidActive: false,
          raidAttacksUsed: 0,
          raidClanTag: null,
          raidClanName: null,
          raidEndsAt: null,
          raidSourceUpdatedAt: new Date("2026-04-02T12:00:00.000Z"),
          lastUpdatedAt: new Date("2026-04-02T12:00:00.000Z"),
        }),
      }),
    );
    expect(cocService.getClanCapitalRaidSeasons).not.toHaveBeenCalled();
  });

  it("preserves every raid field when the raid source is unavailable", async () => {
    const raidEndsAt = new Date("2026-03-30T07:00:00.000Z");
    const preservedLastUpdatedAt = new Date("2026-03-24T09:15:00.000Z");
    const preservedUpdatedAt = new Date("2026-03-25T09:15:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Clan One",
        raidAttacksUsed: 4,
        raidAttacksMax: 6,
        raidEndsAt,
        raidSourceUpdatedAt: null,
        lastUpdatedAt: preservedLastUpdatedAt,
        updatedAt: preservedUpdatedAt,
      }),
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      raidActive: true,
      raidClanTag: "#PQL0289",
      raidClanName: "Clan One",
      raidAttacksUsed: 4,
      raidAttacksMax: 6,
      raidEndsAt,
      raidSourceUpdatedAt: preservedLastUpdatedAt,
      lastUpdatedAt: new Date("2026-03-29T12:00:00.000Z"),
    });
  });

  it("preserves every raid field when raid clan fetch fails", async () => {
    const raidEndsAt = new Date("2026-03-30T07:00:00.000Z");
    const preservedLastUpdatedAt = new Date("2026-03-24T09:15:00.000Z");
    const preservedUpdatedAt = new Date("2026-03-25T09:15:00.000Z");
    const preservedRaidSourceUpdatedAt = new Date("2026-03-23T09:15:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Clan One",
        raidAttacksUsed: 4,
        raidAttacksMax: 6,
        raidEndsAt,
        raidSourceUpdatedAt: preservedRaidSourceUpdatedAt,
        lastUpdatedAt: preservedLastUpdatedAt,
        updatedAt: preservedUpdatedAt,
      }),
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289", name: "Clan One" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockRejectedValue(new Error("raid fetch failed")),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#PQL0289", 2);
    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      raidActive: true,
      raidClanTag: "#PQL0289",
      raidClanName: "Clan One",
      raidAttacksUsed: 4,
      raidAttacksMax: 6,
      raidEndsAt,
      raidSourceUpdatedAt: preservedRaidSourceUpdatedAt,
      lastUpdatedAt: new Date("2026-03-29T12:00:00.000Z"),
    });
  });

  it("clears raid fields when authoritative observation finds no applicable raid context", async () => {
    const refreshedAt = new Date("2026-03-29T12:00:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Clan One",
        raidAttacksUsed: 5,
        raidAttacksMax: 6,
        raidEndsAt: new Date("2026-03-30T07:00:00.000Z"),
        lastUpdatedAt: new Date("2026-03-24T09:15:00.000Z"),
        updatedAt: new Date("2026-03-25T09:15:00.000Z"),
      }),
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289", name: "Clan One" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [{ tag: "#QGRJ2222", attacks: 6 }],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#PQL0289", 2);
    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      raidActive: false,
      raidClanTag: null,
      raidClanName: null,
      raidAttacksUsed: 0,
      raidAttacksMax: 6,
      raidEndsAt: null,
      raidSourceUpdatedAt: refreshedAt,
      lastUpdatedAt: refreshedAt,
    });
  });

  it("clears expired raid state when the raid source is unavailable for a previous weekend", async () => {
    const refreshedAt = new Date("2026-03-29T12:00:00.000Z");
    const previousRaidEndsAt = new Date("2026-03-23T07:00:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Clan One",
        raidAttacksUsed: 4,
        raidAttacksMax: 6,
        raidEndsAt: previousRaidEndsAt,
        raidSourceUpdatedAt: new Date("2026-03-22T09:15:00.000Z"),
        lastUpdatedAt: new Date("2026-03-22T09:15:00.000Z"),
        updatedAt: new Date("2026-03-22T09:15:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: refreshedAt.getTime(),
    });

    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      raidActive: false,
      raidClanTag: null,
      raidClanName: null,
      raidAttacksUsed: 0,
      raidAttacksMax: 6,
      raidEndsAt: null,
      raidSourceUpdatedAt: refreshedAt,
      lastUpdatedAt: refreshedAt,
    });
  });

  it("clears expired raid state when a raid clan fetch fails for a previous weekend", async () => {
    const refreshedAt = new Date("2026-03-29T12:00:00.000Z");
    const previousRaidEndsAt = new Date("2026-03-23T07:00:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Clan One",
        raidAttacksUsed: 4,
        raidAttacksMax: 6,
        raidEndsAt: previousRaidEndsAt,
        raidSourceUpdatedAt: new Date("2026-03-22T09:15:00.000Z"),
        lastUpdatedAt: new Date("2026-03-22T09:15:00.000Z"),
        updatedAt: new Date("2026-03-22T09:15:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289", name: "Clan One" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockRejectedValue(new Error("raid fetch failed")),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: refreshedAt.getTime(),
    });

    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      raidActive: false,
      raidClanTag: null,
      raidClanName: null,
      raidAttacksUsed: 0,
      raidAttacksMax: 6,
      raidEndsAt: null,
      raidSourceUpdatedAt: refreshedAt,
      lastUpdatedAt: refreshedAt,
    });
  });

  it("preserves active raid progress during unrelated snapshot refresh without raid source access", async () => {
    const raidEndsAt = new Date("2026-03-30T07:00:00.000Z");
    const preservedLastUpdatedAt = new Date("2026-03-24T09:15:00.000Z");
    const preservedRaidSourceUpdatedAt = new Date("2026-03-23T09:15:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        raidActive: true,
        raidClanTag: "#PQL0289",
        raidClanName: "Clan One",
        raidAttacksUsed: 4,
        raidAttacksMax: 6,
        raidEndsAt,
        raidSourceUpdatedAt: preservedRaidSourceUpdatedAt,
        lastUpdatedAt: preservedLastUpdatedAt,
        updatedAt: new Date("2026-03-25T09:15:00.000Z"),
      }),
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
      observedLivePlayerCurrent: [
        {
          playerTag: "#PYLQ0289",
          clanTag: "#2QG2C08UP",
          clanName: "Moved Clan",
          townHall: 15,
        },
      ],
    });

    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      clanTag: "#2QG2C08UP",
      clanName: "Moved Clan",
      raidActive: true,
      raidClanTag: "#PQL0289",
      raidClanName: "Clan One",
      raidAttacksUsed: 4,
      raidAttacksMax: 6,
      raidEndsAt,
      raidSourceUpdatedAt: preservedRaidSourceUpdatedAt,
      lastUpdatedAt: new Date("2026-03-29T12:00:00.000Z"),
    });
  });

  it("writes raid context and attack count from a successful raid observation", async () => {
    const refreshedAt = new Date("2026-03-29T12:00:00.000Z");
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        raidActive: false,
        raidAttacksUsed: 0,
        raidClanTag: null,
        raidClanName: null,
        raidEndsAt: null,
        raidSourceUpdatedAt: null,
        lastUpdatedAt: new Date("2026-03-24T09:15:00.000Z"),
        updatedAt: new Date("2026-03-25T09:15:00.000Z"),
      }),
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289", name: "Clan One" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [{ tag: "#PYLQ0289", attacks: 6 }],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289")).toMatchObject({
      raidActive: true,
      raidClanTag: "#PQL0289",
      raidClanName: "Clan One",
      raidAttacksUsed: 6,
      raidAttacksMax: 6,
      raidEndsAt: new Date("2026-03-30T07:00:00.000Z"),
      raidSourceUpdatedAt: refreshedAt,
      lastUpdatedAt: refreshedAt,
    });
  });

  it("preserves the raid clan context from fallback raid-season membership when current membership moved elsewhere", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#2QG2C08UP",
        clanName: "Moved Clan",
        raidActive: false,
        raidAttacksUsed: 0,
        raidClanTag: null,
        raidClanName: null,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-27T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([
      { clanTag: "#PQL0289", name: "Clan A" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2QG2C08UP", name: "Moved Clan" },
        townHallLevel: 15,
      }),
      getClanCapitalRaidSeasons: vi.fn().mockImplementation(async (clanTag: string) => {
        if (normalizeClanTagForTest(clanTag) === "#PQL0289") {
          return [
            {
              startTime: "20260327T070000.000Z",
              endTime: "20260330T070000.000Z",
              members: [{ tag: "#PYLQ0289", attacks: 5 }],
            },
          ];
        }
        return [
          {
            startTime: "20260327T070000.000Z",
            endTime: "20260330T070000.000Z",
            members: [],
          },
        ];
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    const raidUpdate = getTodoSnapshotUpsertUpdateForPlayer("#PYLQ0289");
    expect(raidUpdate.clanTag).toBe("#2QG2C08UP");
    expect(raidUpdate.clanName).toBe("Moved Clan");
    expect(raidUpdate.raidActive).toBe(true);
    expect(raidUpdate.raidClanTag).toBe("#PQL0289");
    expect(raidUpdate.raidClanName).toBe("Clan A");
    expect(raidUpdate.raidAttacksUsed).toBe(5);
  });

  it("preserves the active war clan context when a linked account moves clans", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warActive: true,
        warAttacksUsed: 1,
        warPhase: "battle day",
        warEndsAt: new Date("2026-03-31T12:00:00.000Z"),
        raidActive: false,
        raidAttacksUsed: 0,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289J",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-27T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        attacks: 1,
        sourceSyncedAt: new Date("2026-03-27T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-27T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 7,
        stars: 2,
        attackSeenAt: new Date("2026-03-27T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289J" },
        townHallLevel: 15,
      }),
      getClanCapitalRaidSeasons: vi.fn(),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289J",
          warClanTag: "#PQL0289",
          warActive: true,
          warAttacksUsed: 1,
        }),
      }),
    );
  });

  it("resolves CWL context from seasonal CWL registry mapping instead of home clan tag", async () => {
    prismaMock.cwlEventClan.findMany.mockResolvedValue([
      buildCurrentCwlEventRowForTest({
        clanTag: "#2QG2C08UP",
        eventInstanceId: "event-current",
        season: "2026-03",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Home Clan" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "CWL Clan" },
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Clan",
        roundState: "inWar",
        startTime: new Date("2026-03-29T12:00:00.000Z"),
        endTime: new Date("2026-03-30T12:00:00.000Z"),
      },
    ]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        attacksUsed: 1,
        attacksAvailable: 1,
        subbedIn: true,
      },
    ]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([
      {
        eventInstanceId: "event-current",
        playerTag: "#PYLQ0289",
        cwlClanTag: "#2QG2C08UP",
      },
    ]);
    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289",
          clanName: "Home Clan",
          cwlClanTag: "#2QG2C08UP",
          cwlClanName: "CWL Clan",
          cwlAttacksUsed: 1,
        }),
      }),
    );
  });

  it("persists battle-day CWL attack counts from corrected current-round owner rows", async () => {
    prismaMock.cwlEventClan.findMany.mockResolvedValue([
      buildCurrentCwlEventRowForTest({
        clanTag: "#2QG2C08UP",
        eventInstanceId: "event-current",
        season: "2026-03",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Home Clan" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "CWL Clan" },
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Clan",
        roundState: "inWar",
        startTime: new Date("2026-03-29T12:00:00.000Z"),
        endTime: new Date("2026-03-30T12:00:00.000Z"),
      },
    ]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        attacksUsed: 1,
        attacksAvailable: 1,
        subbedIn: true,
      },
    ]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([
      {
        eventInstanceId: "event-current",
        playerTag: "#PYLQ0289",
        cwlClanTag: "#2QG2C08UP",
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cwlPhase: "battle day",
          cwlAttacksUsed: 1,
          cwlAttacksMax: 1,
        }),
      }),
    );
  });

  it("writes zero war attacks during preparation even when member attack state is non-zero", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        position: 8,
        playerName: "Alpha",
        townHall: 15,
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        position: 8,
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "preparation",
        startTime: new Date("2026-03-26T12:00:00.000Z"),
        endTime: new Date("2026-03-27T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289" },
        townHallLevel: 15,
      }),
    } as any;

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289",
          clanName: "Clan One",
          warActive: true,
          warPhase: "preparation",
          warAttacksUsed: 0,
          warEndsAt: new Date("2026-03-26T12:00:00.000Z"),
          warSourceUpdatedAt: new Date("2026-03-26T00:00:00.000Z"),
        }),
      }),
    );
  });

  it("derives tracked inWar attacks from WarAttacks instead of stale feed attack counters", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        position: 8,
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        state: "inWar",
        startTime: new Date("2026-03-26T12:00:00.000Z"),
        endTime: new Date("2026-03-27T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-26T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 1,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-26T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 8,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:10:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289",
          warActive: true,
          warPhase: "battle day",
          warAttacksUsed: 1,
          warEndsAt: new Date("2026-03-27T12:00:00.000Z"),
          warSourceUpdatedAt: new Date("2026-03-26T00:00:00.000Z"),
        }),
      }),
    );
  });

  it("does not leak stale previous-war feed attacks into tracked current-war snapshots", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        position: 8,
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 2002,
        state: "inWar",
        startTime: new Date("2026-03-28T12:00:00.000Z"),
        endTime: new Date("2026-03-29T12:00:00.000Z"),
        updatedAt: new Date("2026-03-28T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-26T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 2,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 28, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          warActive: true,
          warPhase: "battle day",
          warAttacksUsed: 0,
        }),
      }),
    );
  });

  it("uses raw FwaWarMemberCurrent fallback when no derived roster member row exists", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cocService = {
      getCurrentWar: vi.fn(),
    };
    try {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        position: 8,
        attacks: 1,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289",
          warActive: true,
          warPhase: "battle day",
          warAttacksUsed: 1,
        }),
      }),
    );
    expect(
      consoleWarnSpy.mock.calls.some(
        ([message]) =>
          String(message).includes("event=tracked_war_roster_drift") &&
          String(message).includes("clanTag=#PQL0289") &&
          String(message).includes("rawMemberCount=1") &&
          String(message).includes("derivedMemberCount=0") &&
          String(message).includes("missingDerivedMemberCount=1") &&
          String(message).includes("rosterCurrentExists=true") &&
          String(message).includes("currentWarState=inWar"),
        ),
    ).toBe(true);
    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("uses raw FwaWarMemberCurrent fallback when the active tracked roster is missing one linked player", async () => {
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cocService = {
      getCurrentWar: vi.fn(),
    };
    try {
      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
        {
          playerTag: "#PYLQ0289",
          clanTag: "#2QVGPQP0U",
          playerName: "Live Alpha",
          sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
        },
      ]);
      prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
        { clanTag: "#2QVGPQP0U" },
      ]);
      prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
      prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
        {
          playerTag: "#PYLQ0289",
          clanTag: "#2QVGPQP0U",
          playerName: "Fallback Alpha",
          townHall: 16,
          position: 7,
          attacks: 1,
          sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
        },
      ]);
      prismaMock.currentWar.findMany.mockResolvedValue([
        {
          clanTag: "#2QVGPQP0U",
          state: "inWar",
          startTime: new Date("2026-03-25T12:00:00.000Z"),
          endTime: new Date("2026-03-26T12:00:00.000Z"),
          updatedAt: new Date("2026-03-26T00:00:00.000Z"),
        },
      ]);
      prismaMock.trackedClan.findMany.mockResolvedValue([
        { tag: "#2QVGPQP0U", name: "Clan Two" },
      ]);
      prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

      await todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags: ["#PYLQ0289"],
        cocService: cocService as any,
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            clanTag: "#2QVGPQP0U",
            playerName: "Fallback Alpha",
            townHall: 16,
            warActive: true,
            warPhase: "battle day",
            warAttacksUsed: 1,
          }),
        }),
      );
      expect(
        consoleInfoSpy.mock.calls.some(
          ([message]) =>
            String(message).includes("event=tracked_war_roster_member_fallback_used") &&
            String(message).includes("clan_count=1") &&
            String(message).includes("player_count=1"),
        ),
      ).toBe(true);
      expect(
        consoleWarnSpy.mock.calls.some(
          ([message]) =>
            String(message).includes("event=tracked_war_roster_drift") &&
            String(message).includes("clanTag=#2QVGPQP0U") &&
            String(message).includes("rawMemberCount=1") &&
            String(message).includes("derivedMemberCount=0") &&
            String(message).includes("missingDerivedMemberCount=1") &&
            String(message).includes("rosterCurrentExists=true") &&
            String(message).includes("currentWarState=inWar"),
        ),
      ).toBe(true);
      expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    } finally {
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    }
  });

  it("uses live current-war roster fallback for tracked active wars when FWAStats roster rows are missing", async () => {
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const observedAt = new Date("2026-03-26T00:01:23.000Z");
    vi.setSystemTime(observedAt);
    const cocService = {
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "inWar",
        attacksPerMember: 2,
        startTime: "20260325T120000.000Z",
        endTime: "20260326T120000.000Z",
        clan: {
          tag: "#2QVGPQP0U",
          name: "Clan Two",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Live Alpha",
              townhallLevel: 16,
              mapPosition: 3,
              attacks: [{ order: 1 }],
            },
            {
              tag: "#QGRJ2222",
              name: "Live Bravo",
              townhallLevel: 15,
              mapPosition: 4,
              attacks: [{ order: 1 }, { order: 2 }],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent",
          members: [],
        },
      }),
    };
    try {
      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
        {
          playerTag: "#PYLQ0289",
          clanTag: "#2QVGPQP0U",
          playerName: "Linked Alpha",
          sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
        },
        {
          playerTag: "#QGRJ2222",
          clanTag: "#2QVGPQP0U",
          playerName: "Linked Bravo",
          sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
        },
      ]);
      prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
        {
          playerTag: "#PYLQ0289",
          clanTag: "#ZOMBIE",
          playerName: "Stale Alpha",
          townHall: 13,
          position: 9,
          attacks: 1,
          sourceSyncedAt: new Date("2026-03-25T00:00:00.000Z"),
        },
      ]);
      prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
        { clanTag: "#2QVGPQP0U" },
      ]);
      prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
      prismaMock.currentWar.findMany.mockResolvedValue([
        {
          clanTag: "#2QVGPQP0U",
          state: "inWar",
          startTime: new Date("2026-03-25T12:00:00.000Z"),
          endTime: new Date("2026-03-26T12:00:00.000Z"),
          updatedAt: new Date("2026-03-26T00:00:00.000Z"),
        },
      ]);
      prismaMock.trackedClan.findMany.mockResolvedValue([
        { tag: "#2QVGPQP0U", name: "Clan Two" },
      ]);
      prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

      const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags: ["#PYLQ0289", "#QGRJ2222"],
        cocService: cocService as any,
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(result.playerCount).toBe(2);
      expect(result.updatedCount).toBe(2);
      expect(cocService.getCurrentWar).toHaveBeenCalledTimes(1);
      expect(cocService.getCurrentWar).toHaveBeenCalledWith("#2QVGPQP0U");
      expect(
        consoleInfoSpy.mock.calls.some(
          ([message]) =>
            String(message).includes("event=todo_live_current_war_roster_fallback_used") &&
            String(message).includes("clanTag=#2QVGPQP0U") &&
            String(message).includes("currentWarState=inWar") &&
            String(message).includes("linkedCandidateCount=2") &&
            String(message).includes("matchedRosterCount=2") &&
            String(message).includes("missingRosterCount=0") &&
            String(message).includes("source=live_current_war"),
        ),
      ).toBe(true);
      expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { playerTag: "#PYLQ0289" },
          update: expect.objectContaining({
            clanTag: "#2QVGPQP0U",
            playerName: "Live Alpha",
            townHall: 16,
            warActive: true,
            warAttacksUsed: 1,
            warAttacksMax: 2,
            warPhase: "battle day",
            warEndsAt: new Date("2026-03-26T12:00:00.000Z"),
            warSourceUpdatedAt: observedAt,
          }),
        }),
      );
      expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { playerTag: "#QGRJ2222" },
          update: expect.objectContaining({
            clanTag: "#2QVGPQP0U",
            playerName: "Live Bravo",
            townHall: 15,
            warActive: true,
            warAttacksUsed: 2,
            warAttacksMax: 2,
            warPhase: "battle day",
            warEndsAt: new Date("2026-03-26T12:00:00.000Z"),
            warSourceUpdatedAt: observedAt,
          }),
        }),
      );
    } finally {
      consoleInfoSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("bounds live current-war fallback fetch concurrency across multiple candidate clans", async () => {
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clanTags = ["#2QVGPQP0U", "#2QG2C08UP", "#2RYGLU2UY", "#PQL0289"];
    const playerTags = clanTags.map((_, index) => buildValidPlayerTag(index));
    const playerTagByClanTag = new Map(
      clanTags.map((clanTag, index) => [clanTag, playerTags[index]] as const),
    );
    const pendingCalls: Array<{
      clanTag: string;
      resolve: (value: unknown) => void;
    }> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const makeWar = (clanTag: string) => ({
      state: "inWar",
      attacksPerMember: 2,
      startTime: "20260325T120000.000Z",
      endTime: "20260326T120000.000Z",
      clan: {
        tag: clanTag,
        name: `Clan ${clanTag}`,
        members: [
          {
            tag: playerTagByClanTag.get(clanTag) ?? "#PYLQ0289",
            name: `Live ${clanTag}`,
            townhallLevel: 16,
            mapPosition: 1,
            attacks: [{ order: 1 }],
          },
        ],
      },
      opponent: {
        tag: "#OPP",
        name: "Opponent",
        members: [],
      },
    });

    const cocService = {
      getCurrentWar: vi.fn().mockImplementation((clanTag: string) => {
        return new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pendingCalls.push({
            clanTag,
            resolve: (value: unknown) => resolve(value),
          });
        });
      }),
    };

    const flush = async (): Promise<void> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    const waitForCallCount = async (expectedCount: number): Promise<void> => {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        if (cocService.getCurrentWar.mock.calls.length >= expectedCount) return;
        await flush();
      }
      throw new Error(
        `Expected ${expectedCount} getCurrentWar calls, saw ${cocService.getCurrentWar.mock.calls.length}`,
      );
    };

    const releaseOne = (): void => {
      const next = pendingCalls.shift();
      if (!next) {
        throw new Error("Expected a pending getCurrentWar call to release");
      }
      inFlight -= 1;
      next.resolve(makeWar(next.clanTag));
    };

    try {
      prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue(
        clanTags.map((clanTag, index) =>
          buildSnapshotRow({
            playerTag: playerTags[index],
            clanTag,
          }),
        ),
      );
      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
      prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
      prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue(
        clanTags.map((clanTag) => ({ clanTag })),
      );
      prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
      prismaMock.currentWar.findMany.mockResolvedValue(
        clanTags.map((clanTag, index) => ({
          clanTag,
          state: "inWar",
          warId: index + 1,
          startTime: new Date("2026-03-25T12:00:00.000Z"),
          endTime: new Date("2026-03-26T12:00:00.000Z"),
          updatedAt: new Date("2026-03-26T00:00:00.000Z"),
        })),
      );
      prismaMock.trackedClan.findMany.mockResolvedValue(
        clanTags.map((tag) => ({ tag, name: `Clan ${tag}` })),
      );
      prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

      const refreshPromise = todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags,
        cocService: cocService as any,
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      await waitForCallCount(3);
      expect(maxInFlight).toBe(3);
      expect(cocService.getCurrentWar).toHaveBeenCalledTimes(3);

      releaseOne();
      await waitForCallCount(4);
      expect(maxInFlight).toBe(3);
      expect(cocService.getCurrentWar).toHaveBeenCalledTimes(4);
      expect(
        cocService.getCurrentWar.mock.calls.map(([clanTag]) => clanTag).sort(),
      ).toEqual([...clanTags].sort());

      while (pendingCalls.length > 0) {
        releaseOne();
      }

      await refreshPromise;
    } finally {
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    }
  });

  it("keeps snapshots inactive when the live current-war roster does not contain the linked player", async () => {
    const cocService = {
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "inWar",
        attacksPerMember: 2,
        startTime: "20260325T120000.000Z",
        endTime: "20260326T120000.000Z",
        clan: {
          tag: "#2QVGPQP0U",
          name: "Clan Two",
          members: [
            {
              tag: "#OTHER",
              name: "Other Player",
              townhallLevel: 16,
              mapPosition: 1,
              attacks: [{ order: 1 }],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent",
          members: [],
        },
      }),
    };
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
        playerName: "Linked Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#2QVGPQP0U" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Clan Two" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getCurrentWar).toHaveBeenCalledTimes(1);
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#2QVGPQP0U",
          warActive: false,
          warAttacksUsed: 0,
          warPhase: null,
          warEndsAt: null,
        }),
      }),
    );
  });

  it("reuses a preloaded current-war snapshot and skips the duplicate live fetch", async () => {
    const cocService = {
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "inWar",
        attacksPerMember: 2,
        startTime: "20260325T120000.000Z",
        endTime: "20260326T120000.000Z",
        clan: {
          tag: "#2QVGPQP0U",
          name: "Clan Two",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Preloaded Alpha",
              townhallLevel: 15,
              mapPosition: 1,
              attacks: [{ order: 1 }],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent",
          members: [],
        },
      }),
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2QVGPQP0U" },
      }),
      getClanWarLeagueGroup: vi.fn(),
    };
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
        playerName: "Linked Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#2QVGPQP0U" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Clan Two" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      preloadedCurrentWarSnapshotsByClanTag: new Map([
        [
          "#2QVGPQP0U",
          {
            state: "inWar",
            attacksPerMember: 2,
            startTime: "20260325T120000.000Z",
            endTime: "20260326T120000.000Z",
            clan: {
              tag: "#2QVGPQP0U",
              name: "Clan Two",
              members: [
                {
                  tag: "#PYLQ0289",
                  name: "Preloaded Alpha",
                  townhallLevel: 15,
                  mapPosition: 1,
                  attacks: [{ order: 1 }],
                },
              ],
            },
            opponent: {
              tag: "#OPP",
              name: "Opponent",
              members: [],
            },
          } as any,
        ],
      ]),
    });

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
  });

  it("reuses a preloaded null current-war snapshot and skips the duplicate live fetch", async () => {
    const cocService = {
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "inWar",
        attacksPerMember: 2,
        startTime: "20260325T120000.000Z",
        endTime: "20260326T120000.000Z",
        clan: {
          tag: "#2QVGPQP0U",
          name: "Clan Two",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Preloaded Alpha",
              townhallLevel: 15,
              mapPosition: 1,
              attacks: [{ order: 1 }],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent",
          members: [],
        },
      }),
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#2QVGPQP0U" },
      }),
      getClanWarLeagueGroup: vi.fn(),
    };
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
        playerName: "Linked Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#2QVGPQP0U" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Clan Two" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      preloadedCurrentWarSnapshotsByClanTag: new Map([["#2QVGPQP0U", null]]),
    });

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
  });

  it("prefers the derived tracked-war roster member row over live current-war fallback data", async () => {
    const cocService = {
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "inWar",
        attacksPerMember: 2,
        startTime: "20260325T120000.000Z",
        endTime: "20260326T120000.000Z",
        clan: {
          tag: "#PQL0289",
          name: "Clan One",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Live Alpha",
              townhallLevel: 16,
              mapPosition: 3,
              attacks: [{ order: 1 }],
            },
          ],
        },
        opponent: {
          tag: "#OPP",
          name: "Opponent",
          members: [],
        },
      }),
    };
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Derived Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#PQL0289" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        position: 8,
        playerName: "Derived Alpha",
        townHall: 14,
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        state: "inWar",
        startTime: new Date("2026-03-26T12:00:00.000Z"),
        endTime: new Date("2026-03-27T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-26T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 2,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 7,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:05:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289",
          playerName: "Derived Alpha",
          townHall: 14,
          warActive: true,
          warAttacksUsed: 2,
        }),
      }),
    );
  });

  it("does not use live current-war fallback for active wars on non-tracked clans", async () => {
    const cocService = {
      getCurrentWar: vi.fn(),
    };
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
        playerName: "Live Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#2QVGPQP0U",
          warClanTag: null,
          warActive: false,
          warPosition: null,
        }),
      }),
    );
  });

  it("does not attempt live current-war fallback when no cocService is provided", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
        playerName: "Linked Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#2QVGPQP0U" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QVGPQP0U", name: "Clan Two" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await expect(
      todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags: ["#PYLQ0289"],
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      }),
    ).resolves.toEqual({ playerCount: 1, updatedCount: 1 });
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#2QVGPQP0U",
          warActive: false,
        }),
      }),
    );
  });

  it("warns once when a tracked active war clan has raw WarMembers rows but one derived roster member is missing", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const clanTag = "#2QVGPQP0U";
      const sourceSyncedAt = new Date("2026-03-26T00:00:00.000Z");
      const trackedWarRows = buildTrackedWarRows({
        clanTag,
        count: 50,
        sourceSyncedAt,
        missingDerivedIndex: 49,
      });

      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(trackedWarRows.clanMemberRows);
      prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
        { clanTag },
      ]);
      prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue(
        trackedWarRows.rosterMemberRows,
      );
      prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue(trackedWarRows.warMemberRows);
      prismaMock.currentWar.findMany.mockResolvedValue([
        {
          clanTag,
          state: "inWar",
          startTime: new Date("2026-03-25T12:00:00.000Z"),
          endTime: new Date("2026-03-26T12:00:00.000Z"),
          updatedAt: sourceSyncedAt,
        },
      ]);
      prismaMock.trackedClan.findMany.mockResolvedValue([
        { tag: clanTag, name: "Clan Drift" },
      ]);
      prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

      await todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags: trackedWarRows.clanMemberRows.map((row) => row.playerTag),
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleWarnSpy.mock.calls[0]?.[0] ?? "")).toContain(
        "event=tracked_war_roster_drift",
      );
      expect(String(consoleWarnSpy.mock.calls[0]?.[0] ?? "")).toContain(
        `clanTag=${clanTag}`,
      );
      expect(String(consoleWarnSpy.mock.calls[0]?.[0] ?? "")).toContain(
        "rawMemberCount=50",
      );
      expect(String(consoleWarnSpy.mock.calls[0]?.[0] ?? "")).toContain(
        "derivedMemberCount=49",
      );
      expect(String(consoleWarnSpy.mock.calls[0]?.[0] ?? "")).toContain(
        "missingDerivedMemberCount=1",
      );
      expect(String(consoleWarnSpy.mock.calls[0]?.[0] ?? "")).toContain(
        "rosterCurrentExists=true",
      );
      expect(String(consoleWarnSpy.mock.calls[0]?.[0] ?? "")).toContain(
        "currentWarState=inWar",
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("does not warn when the derived tracked-war roster matches the raw WarMembers rows", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const clanTag = "#2QVGPQP0U";
      const sourceSyncedAt = new Date("2026-03-26T00:00:00.000Z");
      const trackedWarRows = buildTrackedWarRows({
        clanTag,
        count: 50,
        sourceSyncedAt,
      });

      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(trackedWarRows.clanMemberRows);
      prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
        { clanTag },
      ]);
      prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue(
        trackedWarRows.rosterMemberRows,
      );
      prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue(trackedWarRows.warMemberRows);
      prismaMock.currentWar.findMany.mockResolvedValue([
        {
          clanTag,
          state: "inWar",
          startTime: new Date("2026-03-25T12:00:00.000Z"),
          endTime: new Date("2026-03-26T12:00:00.000Z"),
          updatedAt: sourceSyncedAt,
        },
      ]);
      prismaMock.trackedClan.findMany.mockResolvedValue([
        { tag: clanTag, name: "Clan Drift" },
      ]);
      prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

      await todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags: trackedWarRows.clanMemberRows.map((row) => row.playerTag),
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("does not warn when the current war is inactive even if raw WarMembers rows differ", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const clanTag = "#2QVGPQP0U";
      const sourceSyncedAt = new Date("2026-03-26T00:00:00.000Z");
      const trackedWarRows = buildTrackedWarRows({
        clanTag,
        count: 2,
        sourceSyncedAt,
        missingDerivedIndex: 1,
      });

      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(trackedWarRows.clanMemberRows);
      prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
        { clanTag },
      ]);
      prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue(
        trackedWarRows.rosterMemberRows,
      );
      prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue(trackedWarRows.warMemberRows);
      prismaMock.currentWar.findMany.mockResolvedValue([
        {
          clanTag,
          state: "finished",
          startTime: new Date("2026-03-25T12:00:00.000Z"),
          endTime: new Date("2026-03-26T12:00:00.000Z"),
          updatedAt: sourceSyncedAt,
        },
      ]);
      prismaMock.trackedClan.findMany.mockResolvedValue([
        { tag: clanTag, name: "Clan Drift" },
      ]);
      prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

      await todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags: trackedWarRows.clanMemberRows.map((row) => row.playerTag),
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("does not warn when the clan is not tracked even if an active war and drifted roster exist", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const clanTag = "#2QVGPQP0U";
      const sourceSyncedAt = new Date("2026-03-26T00:00:00.000Z");
      const trackedWarRows = buildTrackedWarRows({
        clanTag,
        count: 2,
        sourceSyncedAt,
        missingDerivedIndex: 1,
      });

      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(trackedWarRows.clanMemberRows);
      prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
        { clanTag },
      ]);
      prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue(
        trackedWarRows.rosterMemberRows,
      );
      prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue(trackedWarRows.warMemberRows);
      prismaMock.currentWar.findMany.mockResolvedValue([
        {
          clanTag,
          state: "inWar",
          startTime: new Date("2026-03-25T12:00:00.000Z"),
          endTime: new Date("2026-03-26T12:00:00.000Z"),
          updatedAt: sourceSyncedAt,
        },
      ]);
      prismaMock.trackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

      await todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags: trackedWarRows.clanMemberRows.map((row) => row.playerTag),
        nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
      });

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("keeps the derived tracked-war roster member row ahead of newer raw FwaWarMemberCurrent fallback data", async () => {
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#PQL0289" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        position: 8,
        playerName: "Derived Alpha",
        townHall: 14,
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Fallback Alpha",
        townHall: 16,
        position: 1,
        attacks: 1,
        sourceSyncedAt: new Date("2026-03-27T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        state: "inWar",
        startTime: new Date("2026-03-26T12:00:00.000Z"),
        endTime: new Date("2026-03-27T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-26T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 2,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 7,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:05:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289",
          playerName: "Derived Alpha",
          townHall: 14,
          warActive: true,
          warAttacksUsed: 2,
        }),
      }),
    );
  });

  it("does not use raw FwaWarMemberCurrent fallback for active wars on non-tracked clans", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
        playerName: "Live Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#2QVGPQP0U" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#2QVGPQP0U",
        playerName: "Fallback Alpha",
        townHall: 16,
        position: 7,
        attacks: 1,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QVGPQP0U",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#2QVGPQP0U",
          playerName: "Live Alpha",
          warActive: false,
          warAttacksUsed: 0,
        }),
      }),
    );
  });

  it("does not let a stale inactive FwaWarMemberCurrent row rewrite clan context when no active war exists", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        position: 8,
        attacks: 1,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "finished",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#NEWCLAN" },
        townHallLevel: 15,
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: null,
          warActive: false,
        }),
      }),
    );
  });

  it("prefers the active tracked-war fallback row over a newer inactive row for the same player", async () => {
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#NEWCLAN",
        position: 1,
        attacks: 0,
        sourceSyncedAt: new Date("2026-03-27T00:00:00.000Z"),
      },
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        position: 8,
        attacks: 1,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#NEWCLAN",
        state: "notInWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289" },
        townHallLevel: 15,
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289",
          warActive: true,
          warPhase: "battle day",
        }),
      }),
    );
  });

  it("uses tracked roster town hall when live, member, and catalog values are missing", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      { clanTag: "#PQL0289" },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        position: 8,
        playerName: "Alpha",
        townHall: 13,
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#PQL0289" },
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          townHall: 13,
          warActive: true,
        }),
      }),
    );
  });

  it("derives active Clan Games points from stored signal totals and cycle baseline", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 0,
        gamesTarget: 4000,
        gamesChampionTotal: 12000,
        gamesSeasonBaseline: 12000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 13450 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 1450,
          gamesTarget: 4000,
          gamesChampionTotal: 13450,
          gamesSeasonBaseline: 12000,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("initializes active-cycle baseline when missing and writes zero points for first observation", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 20000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 0,
          gamesTarget: 4000,
          gamesChampionTotal: 20000,
          gamesSeasonBaseline: 20000,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("derives active-cycle points from initialized baseline on later observations", async () => {
    prismaMock.todoPlayerSnapshot.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        buildSnapshotRow({
          gamesActive: true,
          gamesPoints: 0,
          gamesTarget: 4000,
          gamesChampionTotal: 20000,
          gamesSeasonBaseline: 20000,
          gamesCycleKey: "1774166400000",
          gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        }),
      ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany
      .mockResolvedValueOnce([
        {
          key: "player_signal_state:#PYLQ0289",
          value: JSON.stringify({ counters: { gamesChampion: 20000 } }),
        },
      ])
      .mockResolvedValueOnce([
        {
          key: "player_signal_state:#PYLQ0289",
          value: JSON.stringify({ counters: { gamesChampion: 20350 } }),
        },
      ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });
    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 5, 0, 0),
    });

    const firstSnapshotCall = prismaMock.todoPlayerSnapshot.upsert.mock.calls[0]?.[0];
    const secondSnapshotCall = prismaMock.todoPlayerSnapshot.upsert.mock.calls[1]?.[0];
    expect(firstSnapshotCall?.update.gamesPoints).toBe(0);
    expect(secondSnapshotCall?.update.gamesPoints).toBe(350);
    expect(secondSnapshotCall?.update.gamesSeasonBaseline).toBe(20000);
    expect(secondSnapshotCall?.update.gamesChampionTotal).toBe(20350);
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("resets baseline when observed total drops below stored baseline without inflating points", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 0,
        gamesTarget: 4000,
        gamesChampionTotal: 12000,
        gamesSeasonBaseline: 12000,
        gamesCycleKey: "1774166400000",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 11900 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 0,
          gamesTarget: 4000,
          gamesChampionTotal: 11900,
          gamesSeasonBaseline: 11900,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("caps derived active-cycle points at the completion target only after baseline subtraction", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 0,
        gamesTarget: 4000,
        gamesChampionTotal: 15000,
        gamesSeasonBaseline: 15000,
        gamesCycleKey: "1774166400000",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 19050 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 4000,
          gamesTarget: 4000,
          gamesChampionTotal: 19050,
          gamesSeasonBaseline: 15000,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("resets games cycle baseline on cycle rollover using current observed total", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: false,
        gamesPoints: 900,
        gamesTarget: null,
        gamesChampionTotal: 13000,
        gamesSeasonBaseline: 12100,
        gamesCycleKey: "1771747200000",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 13150 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 0,
          gamesTarget: 4000,
          gamesChampionTotal: 13150,
          gamesSeasonBaseline: 13150,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("stores upcoming-cycle baseline and clears games points/target when games is not active", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 999,
        gamesTarget: 4000,
        gamesChampionTotal: 14999,
        gamesSeasonBaseline: 14000,
        gamesCycleKey: "1771747200000",
        gamesEndsAt: new Date("2026-02-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-02-28T08:00:00.000Z"),
        updatedAt: new Date("2026-02-28T08:00:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 15000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 10, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: false,
          gamesPoints: null,
          gamesTarget: null,
          gamesChampionTotal: 15000,
          gamesSeasonBaseline: 15000,
          gamesCycleKey: "1774166400000",
          gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("keeps latest-season points through reward collection for the ended cycle", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 1300,
        gamesTarget: 4000,
        gamesChampionTotal: 14999,
        gamesSeasonBaseline: 14000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-03-28T08:05:00.000Z"),
        updatedAt: new Date("2026-03-28T08:05:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 15000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: false,
          gamesPoints: 1000,
          gamesTarget: 4000,
          gamesChampionTotal: 15000,
          gamesSeasonBaseline: 14000,
          gamesCycleKey: "1774166400000",
          gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        }),
      }),
    );
  });

  it("keeps latest-season points through the extended reward claim window after April 1", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: false,
        gamesPoints: 1000,
        gamesTarget: 4000,
        gamesChampionTotal: 15000,
        gamesSeasonBaseline: 14000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-04-01T11:55:00.000Z"),
        updatedAt: new Date("2026-04-01T11:55:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-04-01T12:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 15000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 3, 1, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: false,
          gamesPoints: 1000,
          gamesTarget: 4000,
          gamesChampionTotal: 15000,
          gamesSeasonBaseline: 14000,
          gamesCycleKey: "1774166400000",
          gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        }),
      }),
    );
  });

  it("clears latest-season games points once reward collection fully ends", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: false,
        gamesPoints: 1000,
        gamesTarget: 4000,
        gamesChampionTotal: 15000,
        gamesSeasonBaseline: 14000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-04-04T07:55:00.000Z"),
        updatedAt: new Date("2026-04-04T07:55:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-04-04T09:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 15000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 3, 4, 9, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: false,
          gamesPoints: null,
          gamesTarget: null,
          gamesChampionTotal: 15000,
          gamesSeasonBaseline: 15000,
          gamesCycleKey: "1776844800000",
          gamesEndsAt: new Date("2026-04-28T08:00:00.000Z"),
        }),
      }),
    );
  });

  it("switches Clan Games windows at the exact earning and reward-claim cutoffs", () => {
    const beforeEarningCutoff = resolveClanGamesWindowForTest(
      Date.UTC(2026, 2, 28, 7, 59, 59, 999),
    );
    const atEarningCutoff = resolveClanGamesWindowForTest(
      Date.UTC(2026, 2, 28, 8, 0, 0, 0),
    );
    const beforeClaimCutoff = resolveClanGamesWindowForTest(
      Date.UTC(2026, 3, 4, 7, 59, 59, 999),
    );
    const atClaimCutoff = resolveClanGamesWindowForTest(
      Date.UTC(2026, 3, 4, 8, 0, 0, 0),
    );

    expect(beforeEarningCutoff.active).toBe(true);
    expect(beforeEarningCutoff.rewardCollectionActive).toBe(false);

    expect(atEarningCutoff.active).toBe(false);
    expect(atEarningCutoff.rewardCollectionActive).toBe(true);
    expect(atEarningCutoff.rewardCollectionEndsMs).toBe(
      Date.UTC(2026, 3, 4, 8, 0, 0, 0),
    );

    expect(beforeClaimCutoff.active).toBe(false);
    expect(beforeClaimCutoff.rewardCollectionActive).toBe(true);

    expect(atClaimCutoff.active).toBe(false);
    expect(atClaimCutoff.rewardCollectionActive).toBe(false);
  });
});

