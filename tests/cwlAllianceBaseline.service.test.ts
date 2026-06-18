import { beforeEach, describe, expect, it, vi } from "vitest";

type TestPlayerLinkRow = {
  playerTag: string;
  discordUserId: string;
};

type TestTrackedClanRow = {
  id: number;
  tag: string;
  name: string | null;
};

type TestCurrentWarRow = {
  guildId: string;
  clanTag: string;
  warId: number | null;
  matchType: string | null;
  state: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  clanName: string | null;
  prepStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
};

type TestRosterMemberRow = {
  position: number;
  playerTag: string;
  playerName: string;
  townHall: number | null;
};

type TestRosterRow = {
  clanTag: string;
  clanName: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  rosterSize: number;
  observedAt: Date;
  sourceUpdatedAt: Date | null;
  members: TestRosterMemberRow[];
};

type TestHistoryRow = {
  warId: number;
  clanTag: string;
  clanName: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  matchType: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
  updatedAt: Date;
};

type TestParticipationRow = {
  guildId: string;
  warId: string;
  clanTag: string;
  playerTag: string;
  playerName: string | null;
  playerPosition: number | null;
  townHall: number | null;
  attacksUsed: number;
};

type TestBaselineMemberRow = {
  id: string;
  baselineId: string;
  baselineClanId: string;
  playerTag: string;
  playerName: string;
  townHall: number | null;
  position: number | null;
  linkedDiscordUserId: string | null;
  createdAt: Date;
};

type TestBaselineClanRow = {
  id: string;
  baselineId: string;
  clanTag: string;
  clanName: string | null;
  captureStatus: "CAPTURED" | "UNAVAILABLE";
  sourceType: "CURRENT_FWA_WAR" | "LATEST_FWA_WAR" | null;
  sourceWarId: number | null;
  sourceWarStartTime: Date | null;
  sourceWarEndTime: Date | null;
  sourceOpponentTag: string | null;
  sourceObservedAt: Date | null;
  rosterSize: number;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type TestBaselineRow = {
  id: string;
  guildId: string;
  season: string;
  capturedAt: Date;
  capturedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  clans: TestBaselineClanRow[];
  members: TestBaselineMemberRow[];
};

type TestState = {
  trackedClans: TestTrackedClanRow[];
  currentWars: TestCurrentWarRow[];
  rosters: TestRosterRow[];
  histories: TestHistoryRow[];
  participations: TestParticipationRow[];
  playerLinks: TestPlayerLinkRow[];
  baselines: TestBaselineRow[];
  baselineClans: TestBaselineClanRow[];
  baselineMembers: TestBaselineMemberRow[];
};

function cloneRosters(rows: TestRosterRow[]): TestRosterRow[] {
  return rows.map((row) => ({
    ...row,
    members: row.members.map((member) => ({ ...member })),
  }));
}

function cloneBaseline(row: TestBaselineRow): TestBaselineRow {
  return {
    ...row,
    clans: row.clans.map((clan) => ({ ...clan })),
    members: row.members.map((member) => ({ ...member })),
  };
}

function makeState(): TestState {
  return {
    trackedClans: [],
    currentWars: [],
    rosters: [],
    histories: [],
    participations: [],
    playerLinks: [],
    baselines: [],
    baselineClans: [],
    baselineMembers: [],
  };
}

let state = makeState();

function inList(value: unknown, list: unknown[] | undefined): boolean {
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.some((item) => item === value);
}

const txMock = vi.hoisted(() => ({
  cwlAllianceSeasonBaseline: {
    upsert: vi.fn(),
  },
  cwlAllianceSeasonBaselineClan: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  cwlAllianceSeasonBaselineMember: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterCurrent: {
    findMany: vi.fn(),
  },
  clanWarHistory: {
    findMany: vi.fn(),
  },
  clanWarParticipation: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  cwlAllianceSeasonBaseline: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) =>
    callback(txMock),
  ),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  CwlAllianceBaselineDuplicatePlayerTagError,
  CwlAllianceBaselineService,
} from "../src/services/CwlAllianceBaselineService";

function resetState(): void {
  state = makeState();

  prismaMock.trackedClan.findMany.mockImplementation(async () => [...state.trackedClans]);
  prismaMock.currentWar.findMany.mockImplementation(async (args: any) => {
    const guildId = args?.where?.guildId;
    const clanTags = args?.where?.clanTag?.in;
    return state.currentWars.filter(
      (row) =>
        (guildId === undefined || row.guildId === guildId) &&
        inList(row.clanTag, clanTags),
    );
  });
  prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockImplementation(async () =>
    cloneRosters(state.rosters),
  );
  prismaMock.clanWarHistory.findMany.mockImplementation(async (args: any) => {
    const clanTags = args?.where?.clanTag?.in;
    const matchType = args?.where?.matchType;
    return [...state.histories]
      .filter(
        (row) => inList(row.clanTag, clanTags) && (matchType === undefined || row.matchType === matchType),
      )
      .sort((left, right) => {
        const clanDelta = String(left.clanTag).localeCompare(String(right.clanTag));
        if (clanDelta !== 0) return clanDelta;
        const endDelta =
          (right.warEndTime?.getTime() ?? Number.MIN_SAFE_INTEGER) -
          (left.warEndTime?.getTime() ?? Number.MIN_SAFE_INTEGER);
        if (endDelta !== 0) return endDelta;
        const startDelta =
          (right.warStartTime?.getTime() ?? Number.MIN_SAFE_INTEGER) -
          (left.warStartTime?.getTime() ?? Number.MIN_SAFE_INTEGER);
        if (startDelta !== 0) return startDelta;
        return (right.updatedAt?.getTime() ?? 0) - (left.updatedAt?.getTime() ?? 0);
      });
  });
  prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) => {
    const guildId = args?.where?.guildId;
    const clanTags = args?.where?.clanTag?.in;
    const warIds = args?.where?.warId?.in;
    return [...state.participations]
      .filter(
        (row) =>
          (guildId === undefined || row.guildId === guildId) &&
          inList(row.clanTag, clanTags) &&
          inList(row.warId, warIds),
      )
      .sort((left, right) => {
        const warDelta = String(left.warId).localeCompare(String(right.warId));
        if (warDelta !== 0) return warDelta;
        const leftPos = Number.isFinite(Number(left.playerPosition))
          ? Number(left.playerPosition)
          : Number.MAX_SAFE_INTEGER;
        const rightPos = Number.isFinite(Number(right.playerPosition))
          ? Number(right.playerPosition)
          : Number.MAX_SAFE_INTEGER;
        if (leftPos !== rightPos) return leftPos - rightPos;
        return String(left.playerTag).localeCompare(String(right.playerTag));
      });
  });
  prismaMock.playerLink.findMany.mockImplementation(async (args: any) => {
    const tags = args?.where?.playerTag?.in;
    return state.playerLinks.filter((row) => inList(row.playerTag, tags));
  });
  prismaMock.cwlAllianceSeasonBaseline.findUnique.mockImplementation(async (args: any) => {
    const where = args?.where?.guildId_season;
    const baseline = state.baselines.find(
      (row) => row.guildId === where?.guildId && row.season === where?.season,
    );
    return baseline ? cloneBaseline(baseline) : null;
  });

  txMock.cwlAllianceSeasonBaseline.upsert.mockImplementation(async ({ create, update }: any) => {
    const existing = state.baselines.find(
      (row) => row.guildId === create.guildId && row.season === create.season,
    );
    if (existing) {
      existing.capturedAt = update.capturedAt ?? existing.capturedAt;
      existing.capturedByUserId = update.capturedByUserId ?? existing.capturedByUserId;
      existing.updatedAt = new Date("2026-06-18T12:00:00.000Z");
      return cloneBaseline(existing);
    }
    const baseline: TestBaselineRow = {
      id: create.id,
      guildId: create.guildId,
      season: create.season,
      capturedAt: create.capturedAt,
      capturedByUserId: create.capturedByUserId ?? null,
      createdAt: new Date("2026-06-18T12:00:00.000Z"),
      updatedAt: new Date("2026-06-18T12:00:00.000Z"),
      clans: [],
      members: [],
    };
    state.baselines.push(baseline);
    return cloneBaseline(baseline);
  });
  txMock.cwlAllianceSeasonBaselineClan.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = state.baselineClans.length;
    state.baselineClans = state.baselineClans.filter(
      (row) => row.baselineId !== where?.baselineId,
    );
    return { count: before - state.baselineClans.length };
  });
  txMock.cwlAllianceSeasonBaselineClan.createMany.mockImplementation(async ({ data }: any) => {
    state.baselineClans.push(...data.map((row: TestBaselineClanRow) => ({ ...row })));
    return { count: data.length };
  });
  txMock.cwlAllianceSeasonBaselineMember.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = state.baselineMembers.length;
    state.baselineMembers = state.baselineMembers.filter(
      (row) => row.baselineId !== where?.baselineId,
    );
    return { count: before - state.baselineMembers.length };
  });
  txMock.cwlAllianceSeasonBaselineMember.createMany.mockImplementation(async ({ data }: any) => {
    state.baselineMembers.push(...data.map((row: TestBaselineMemberRow) => ({ ...row })));
    return { count: data.length };
  });
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(txMock));
}

function makeService() {
  return new CwlAllianceBaselineService({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
}

function makeTrackedClan(tag: string, name: string): TestTrackedClanRow {
  return { id: state.trackedClans.length + 1, tag, name };
}

function makeCurrentWar(input: Partial<TestCurrentWarRow> & { clanTag: string }): TestCurrentWarRow {
  return {
    guildId: "guild-1",
    clanTag: input.clanTag,
    warId: 101,
    matchType: "FWA",
    state: "inWar",
    opponentTag: "#V222",
    opponentName: "Opponent",
    clanName: "Tracked Clan",
    prepStartTime: new Date("2026-06-18T00:00:00.000Z"),
    startTime: new Date("2026-06-18T01:00:00.000Z"),
    endTime: null,
    ...input,
  };
}

function makeRoster(input: Partial<TestRosterRow> & { clanTag: string; members: TestRosterMemberRow[] }): TestRosterRow {
  return {
    clanTag: input.clanTag,
    clanName: "Tracked Clan",
    opponentTag: "#V222",
    opponentName: "Opponent",
    rosterSize: input.members.length,
    observedAt: new Date("2026-06-18T01:05:00.000Z"),
    sourceUpdatedAt: new Date("2026-06-18T01:05:30.000Z"),
    ...input,
  };
}

function makeHistory(input: Partial<TestHistoryRow> & { clanTag: string; warId: number }): TestHistoryRow {
  return {
    warId: input.warId,
    clanTag: input.clanTag,
    clanName: "Tracked Clan",
    opponentTag: "#V222",
    opponentName: "Opponent",
    matchType: "FWA",
    warStartTime: new Date("2026-06-12T00:00:00.000Z"),
    warEndTime: new Date("2026-06-12T01:00:00.000Z"),
    updatedAt: new Date("2026-06-12T01:05:00.000Z"),
    ...input,
  };
}

function makeParticipation(
  clanTag: string,
  warId: number,
  rows: Array<{
    playerTag: string;
    playerName: string;
    playerPosition: number | null;
    townHall: number | null;
    attacksUsed: number;
  }>,
): TestParticipationRow[] {
  return rows.map((row) => ({
    guildId: "guild-1",
    warId: String(warId),
    clanTag,
    playerTag: row.playerTag,
    playerName: row.playerName,
    playerPosition: row.playerPosition,
    townHall: row.townHall,
    attacksUsed: row.attacksUsed,
  }));
}

function makeCompleteParticipationRows(
  clanTag: string,
  warId: number,
  options?: {
    attacksUsed?: (position: number) => number;
    playerTagPrefix?: string;
    playerNamePrefix?: string;
    townHall?: (position: number) => number | null;
  },
): TestParticipationRow[] {
  const validTagChars = ["P", "Y", "L", "Q", "G", "R", "J", "C", "U", "V", "0", "2", "8", "9"];
  return Array.from({ length: 50 }, (_, index) => {
    const position = index + 1;
    const tagIndex = index;
    const high = Math.floor(tagIndex / validTagChars.length);
    const low = tagIndex % validTagChars.length;
    return {
      guildId: "guild-1",
      warId: String(warId),
      clanTag,
      playerTag:
        `${options?.playerTagPrefix ?? "#Q"}0${validTagChars[high]}${validTagChars[low]}`,
      playerName: `${options?.playerNamePrefix ?? "Player"} ${position}`,
      playerPosition: position,
      townHall: options?.townHall?.(position) ?? 16,
      attacksUsed: options?.attacksUsed?.(position) ?? 2,
    };
  });
}

describe("CwlAllianceBaselineService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("captures a current FWA roster, trims identifiers, and freezes player links", async () => {
    state.trackedClans = [makeTrackedClan("#P028", "Tracked Clan")];
    state.currentWars = [makeCurrentWar({ clanTag: "#P028" })];
    state.rosters = [
      makeRoster({
        clanTag: "#P028",
        members: [
          { position: 1, playerTag: "#Q028", playerName: "Player One", townHall: 16 },
          { position: 2, playerTag: "#Q029", playerName: "Player Two", townHall: 15 },
        ],
      }),
    ];
    state.playerLinks = [
      { playerTag: "#Q028", discordUserId: "123456789012345678" },
      { playerTag: "#Q029", discordUserId: "223456789012345678" },
    ];

    const service = makeService();
    const result = await service.captureAllianceSeasonBaseline({
      guildId: "  guild-1  ",
      season: " 2026-06 ",
      replaceExisting: false,
      capturedByUserId: " 123456789012345678 ",
    });

    expect(result.guildId).toBe("guild-1");
    expect(result.season).toBe("2026-06");
    expect(result.reusedExistingBaseline).toBe(false);
    expect(result.capturedClanCount).toBe(1);
    expect(result.unavailableClanCount).toBe(0);
    expect(result.currentWarSourceCount).toBe(1);
    expect(result.latestWarFallbackCount).toBe(0);
    expect(result.memberAccountCount).toBe(2);
    expect(result.linkedAccountCount).toBe(2);
    expect(result.coverageSummaries[0]).toMatchObject({
      clanTag: "#P028",
      captureStatus: "CAPTURED",
      sourceType: "CURRENT_FWA_WAR",
      sourceWarId: 101,
      rosterSize: 2,
      failureReason: null,
    });
    expect(state.baselineMembers.map((row) => [row.playerTag, row.linkedDiscordUserId])).toEqual([
      ["#Q028", "123456789012345678"],
      ["#Q029", "223456789012345678"],
    ]);
    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.currentWar.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaTrackedClanWarRosterCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanWarHistory.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanWarParticipation.findMany).toHaveBeenCalledTimes(0);
    expect(prismaMock.playerLink.findMany).toHaveBeenCalledTimes(1);
  });

  it("falls back to historical capture when the current war roster opponent tag is missing", async () => {
    state.trackedClans = [makeTrackedClan("#P028", "Fallback Clan")];
    state.currentWars = [
      makeCurrentWar({ clanTag: "#P028", opponentTag: null, warId: 203 }),
    ];
    state.rosters = [
      makeRoster({
        clanTag: "#P028",
        members: [{ position: 1, playerTag: "#Q028", playerName: "Ignored", townHall: 15 }],
      }),
    ];
    state.histories = [makeHistory({ clanTag: "#P028", warId: 202 })];
    state.participations = makeCompleteParticipationRows("#P028", 202, {
      attacksUsed: (position) => (position === 1 ? 0 : 2),
    });

    const result = await makeService().captureAllianceSeasonBaseline({
      guildId: "guild-1",
      season: "2026-06",
    });

    expect(result.coverageSummaries[0]).toMatchObject({
      captureStatus: "CAPTURED",
      sourceType: "LATEST_FWA_WAR",
      sourceWarId: 202,
      rosterSize: 50,
      failureReason: null,
    });
    expect(result.currentWarSourceCount).toBe(0);
    expect(result.latestWarFallbackCount).toBe(1);
    expect(result.memberAccountCount).toBe(50);
    expect(state.baselineMembers).toHaveLength(50);
    expect(state.baselineMembers[0]?.playerTag).toBe("#Q0PP");
  });

  it("rejects a current MM war and falls back to the latest canonical FWA history", async () => {
    state.trackedClans = [makeTrackedClan("#P029", "Fallback Clan")];
    state.currentWars = [
      makeCurrentWar({ clanTag: "#P029", matchType: "MM", state: "inWar", warId: 202 }),
    ];
    state.rosters = [
      makeRoster({
        clanTag: "#P029",
        members: [{ position: 1, playerTag: "#Q029", playerName: "Ignored", townHall: 15 }],
      }),
    ];
    state.histories = [makeHistory({ clanTag: "#P029", warId: 201 })];
    state.participations = makeCompleteParticipationRows("#P029", 201);

    const service = makeService();
    const result = await service.captureAllianceSeasonBaseline({
      guildId: "guild-1",
      season: "2026-06",
    });

    expect(result.coverageSummaries[0]).toMatchObject({
      captureStatus: "CAPTURED",
      sourceType: "LATEST_FWA_WAR",
      sourceWarId: 201,
    });
    expect(result.currentWarSourceCount).toBe(0);
    expect(result.latestWarFallbackCount).toBe(1);
  });

  it("rejects incomplete historical rosters with all-null positions", async () => {
    state.trackedClans = [makeTrackedClan("#P082", "History Clan")];
    state.histories = [makeHistory({ clanTag: "#P082", warId: 300 })];
    state.participations = makeCompleteParticipationRows("#P082", 300, {
      attacksUsed: () => 0,
    }).map((row) => ({
      ...row,
      playerPosition: null,
    }));

    const result = await makeService().captureAllianceSeasonBaseline({
      guildId: "guild-1",
      season: "2026-06",
    });

    expect(result.unavailableClanCount).toBe(1);
    expect(result.currentWarSourceCount).toBe(0);
    expect(result.latestWarFallbackCount).toBe(0);
    expect(result.coverageSummaries[0]).toMatchObject({
      captureStatus: "UNAVAILABLE",
      failureReason: "LATEST_FWA_WAR_ROSTER_MISSING_POSITIONS",
    });
  });

  it("accepts a complete 50-member historical roster and keeps zero-attack members", async () => {
    state.trackedClans = [makeTrackedClan("#P082", "History Clan")];
    state.histories = [
      makeHistory({
        clanTag: "#P082",
        warId: 301,
        matchType: "BL",
        warEndTime: new Date("2026-06-16T02:00:00.000Z"),
        updatedAt: new Date("2026-06-16T02:05:00.000Z"),
      }),
      makeHistory({
        clanTag: "#P082",
        warId: 300,
        matchType: "FWA",
        warEndTime: new Date("2026-06-15T02:00:00.000Z"),
        updatedAt: new Date("2026-06-15T02:05:00.000Z"),
      }),
    ];
    state.participations = makeCompleteParticipationRows("#P082", 300, {
      attacksUsed: (position) => (position % 2 === 0 ? 0 : 2),
    });

    const result = await makeService().captureAllianceSeasonBaseline({
      guildId: "guild-1",
      season: "2026-06",
    });

    expect(result.coverageSummaries[0]).toMatchObject({
      sourceType: "LATEST_FWA_WAR",
      sourceWarId: 300,
      rosterSize: 50,
    });
    expect(result.memberAccountCount).toBe(50);
    expect(state.baselineMembers).toHaveLength(50);
    expect(state.baselineMembers[0]?.playerTag).toBe("#Q0PP");
  });

  it("marks unavailable clans explicitly without blocking other clans", async () => {
    state.trackedClans = [
      makeTrackedClan("#P089", "Healthy Clan"),
      makeTrackedClan("#P222", "Missing Clan"),
    ];
    state.currentWars = [makeCurrentWar({ clanTag: "#P089", warId: 401 })];
    state.rosters = [
      makeRoster({
        clanTag: "#P089",
        members: [{ position: 1, playerTag: "#Q229", playerName: "Only One", townHall: 16 }],
      }),
    ];

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new CwlAllianceBaselineService(logger);
    const result = await service.captureAllianceSeasonBaseline({
      guildId: "guild-1",
      season: "2026-06",
    });

    expect(result.capturedClanCount).toBe(1);
    expect(result.unavailableClanCount).toBe(1);
    expect(result.coverageSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clanTag: "#P089",
          captureStatus: "CAPTURED",
        }),
        expect.objectContaining({
          clanTag: "#P222",
          captureStatus: "UNAVAILABLE",
          failureReason: expect.any(String),
        }),
      ]),
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it("reuses a frozen baseline when replaceExisting is false", async () => {
    state.baselines = [
      {
        id: "baseline-reuse",
        guildId: "guild-1",
        season: "2026-06",
        capturedAt: new Date("2026-06-01T00:00:00.000Z"),
        capturedByUserId: "123456789012345678",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        clans: [
          {
            id: "baseline-clan-reuse",
            baselineId: "baseline-reuse",
            clanTag: "#P028",
            clanName: "Alpha",
            captureStatus: "CAPTURED",
            sourceType: "CURRENT_FWA_WAR",
            sourceWarId: 101,
            sourceWarStartTime: new Date("2026-06-18T01:00:00.000Z"),
            sourceWarEndTime: null,
            sourceOpponentTag: "#V222",
            sourceObservedAt: new Date("2026-06-18T01:05:30.000Z"),
            rosterSize: 1,
            failureReason: null,
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            members: [],
            updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          },
        ],
        members: [
          {
            id: "baseline-member-reuse",
            baselineId: "baseline-reuse",
            baselineClanId: "baseline-clan-reuse",
            playerTag: "#Q028",
            playerName: "Alpha",
            townHall: 16,
            position: 1,
            linkedDiscordUserId: "123456789012345678",
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
          },
        ],
      },
    ];

    const service = makeService();
    const result = await service.captureAllianceSeasonBaseline({
      guildId: "guild-1",
      season: "2026-06",
      replaceExisting: false,
    });

    expect(result.reusedExistingBaseline).toBe(true);
    expect(result.baselineId).toBe("baseline-reuse");
    expect(txMock.cwlAllianceSeasonBaseline.upsert).not.toHaveBeenCalled();
    expect(state.baselines[0]?.members).toHaveLength(1);
  });

  it("replaces an existing baseline atomically when replaceExisting is true", async () => {
    state.baselines = [
      {
        id: "baseline-replace",
        guildId: "guild-1",
        season: "2026-06",
        capturedAt: new Date("2026-06-01T00:00:00.000Z"),
        capturedByUserId: "123456789012345678",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        clans: [],
        members: [],
      },
    ];
    state.baselineClans = [
      {
        id: "old-clan",
        baselineId: "baseline-replace",
        clanTag: "#P228",
        clanName: "Old Clan",
        captureStatus: "CAPTURED",
        sourceType: "CURRENT_FWA_WAR",
        sourceWarId: 1,
        sourceWarStartTime: null,
        sourceWarEndTime: null,
        sourceOpponentTag: null,
        sourceObservedAt: null,
        rosterSize: 1,
        failureReason: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        members: [],
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ];
    state.baselineMembers = [
      {
        id: "old-member",
        baselineId: "baseline-replace",
        baselineClanId: "old-clan",
        playerTag: "#Q282",
        playerName: "Old Player",
        townHall: 16,
        position: 1,
        linkedDiscordUserId: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ];
    state.trackedClans = [makeTrackedClan("#P229", "Replacement Clan")];
    state.currentWars = [makeCurrentWar({ clanTag: "#P229", warId: 501 })];
    state.rosters = [
      makeRoster({
        clanTag: "#P229",
        members: [{ position: 1, playerTag: "#Q289", playerName: "New Player", townHall: 15 }],
      }),
    ];

    const result = await makeService().captureAllianceSeasonBaseline({
      guildId: "guild-1",
      season: "2026-06",
      replaceExisting: true,
    });

    expect(result.reusedExistingBaseline).toBe(false);
    expect(result.capturedClanCount).toBe(1);
    expect(state.baselineClans.map((row) => row.clanTag)).toEqual(["#P229"]);
    expect(state.baselineMembers.map((row) => row.playerTag)).toEqual(["#Q289"]);
    expect(txMock.cwlAllianceSeasonBaselineClan.deleteMany).toHaveBeenCalledWith({
      where: { baselineId: "baseline-replace" },
    });
    expect(txMock.cwlAllianceSeasonBaselineMember.deleteMany).toHaveBeenCalledWith({
      where: { baselineId: "baseline-replace" },
    });
  });

  it("rejects duplicate player tags across clans before mutating an existing baseline", async () => {
    state.baselines = [
      {
        id: "baseline-duplicate",
        guildId: "guild-1",
        season: "2026-06",
        capturedAt: new Date("2026-06-01T00:00:00.000Z"),
        capturedByUserId: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        clans: [],
        members: [],
      },
    ];
    state.trackedClans = [
      makeTrackedClan("#P282", "First Clan"),
      makeTrackedClan("#P289", "Second Clan"),
    ];
    state.currentWars = [
      makeCurrentWar({ clanTag: "#P282", warId: 601 }),
      makeCurrentWar({ clanTag: "#P289", warId: 602 }),
    ];
    state.rosters = [
      makeRoster({
        clanTag: "#P282",
        members: [{ position: 1, playerTag: "#Q922", playerName: "Dup One", townHall: 16 }],
      }),
      makeRoster({
        clanTag: "#P289",
        members: [{ position: 1, playerTag: "#q922", playerName: "Dup Two", townHall: 15 }],
      }),
    ];

    const service = makeService();
    await expect(
      service.captureAllianceSeasonBaseline({
        guildId: "guild-1",
        season: "2026-06",
        replaceExisting: true,
      }),
    ).rejects.toBeInstanceOf(CwlAllianceBaselineDuplicatePlayerTagError);
    expect(txMock.cwlAllianceSeasonBaseline.upsert).not.toHaveBeenCalled();
    expect(state.baselineMembers).toEqual([]);
    expect(state.baselineClans).toEqual([]);
  });
});
