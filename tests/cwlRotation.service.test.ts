import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";
import { rosterService } from "../src/services/RosterService";

const txMock = vi.hoisted(() => ({
  cwlRotationPlan: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  cwlRotationPlanDay: {
    create: vi.fn(),
  },
  cwlRotationPlanMember: {
    createMany: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  cwlEventClan: {
    findMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    findMany: vi.fn(),
  },
  currentCwlRound: {
    findUnique: vi.fn(),
  },
  cwlRoundMemberCurrent: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  cwlRoundHistory: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  currentCwlPrepSnapshot: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  cwlRotationPlan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  roster: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  cwlRotationPlanDay: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { cwlRotationService } from "../src/services/CwlRotationService";
import { cwlStateService } from "../src/services/CwlStateService";

describe("CwlRotationService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP", name: "CWL Alpha" });
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlEventClan.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        eventInstanceId: "event-current",
        eventInstance: {
          id: "event-current",
          season: "2026-04",
          anchorWarTag: "#Y2CQ",
          firstObservedAt: new Date("2026-04-01T00:00:00.000Z"),
          lastObservedAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      },
    ]);
    prismaMock.cwlEventClan.findMany.mockImplementation(async (args: any) => {
      const clanTags = Array.isArray(args?.where?.clanTag?.in) ? args.where.clanTag.in : [];
      return clanTags.map((clanTag: string) => ({
        clanTag,
        eventInstanceId: "event-current",
        eventInstance: {
          id: "event-current",
          season: "2026-04",
          anchorWarTag: "#Y2CQ",
          firstObservedAt: new Date("2026-04-01T00:00:00.000Z"),
          lastObservedAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      }));
    });
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findUnique.mockResolvedValue(null);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findUnique.mockResolvedValue(null);
    prismaMock.cwlRoundHistory.findMany.mockResolvedValue([]);
    prismaMock.currentCwlPrepSnapshot.findUnique.mockResolvedValue(null);
    prismaMock.currentCwlPrepSnapshot.findMany.mockResolvedValue([]);
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValue(null);
    prismaMock.cwlRotationPlan.findMany.mockResolvedValue([]);
    prismaMock.cwlRotationPlan.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRotationPlanDay.findMany.mockResolvedValue([]);
    txMock.cwlRotationPlan.findFirst.mockImplementation((...args: any[]) =>
      prismaMock.cwlRotationPlan.findFirst(...args),
    );
    txMock.cwlRotationPlan.updateMany.mockResolvedValue({ count: 0 });
    txMock.cwlRotationPlan.create.mockResolvedValue({ id: "plan-1" });
    txMock.cwlRotationPlanDay.create.mockImplementation(async (args: any) => ({
      id: 100 + Number(args?.data?.roundDay ?? 0),
    }));
    txMock.cwlRotationPlanMember.createMany.mockResolvedValue({ count: 0 });
    vi.spyOn(cwlStateService, "getCurrentPreparationSnapshotForClan").mockResolvedValue(null);
  });

  function setupManualCreateRosterFixture(options?: {
    excludeTagsRaw?: string | null;
    rosterCount?: number;
    roundState?: "preparation" | "inWar";
    roundDay?: number;
  }) {
    const rosterCount = options?.rosterCount ?? 20;
    const observedRosterRows = Array.from({ length: rosterCount }, (_value, index) => {
      const digits = index
        .toString(4)
        .padStart(4, "0")
        .split("")
        .map((char) => ["0", "2", "8", "9"][Number(char)])
        .join("");
      const playerTag = `#PYLQ${digits}`;
      return {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag,
        playerName: `Observed ${index + 1}`,
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: index % 3,
        currentRound: null,
      };
    });
    const roundMembers = observedRosterRows.slice(0, 15).map((row, index) => ({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      playerTag: row.playerTag,
      roundDay: options?.roundDay ?? 3,
      playerName: row.playerName,
      mapPosition: index + 1,
      townHall: row.townHall,
      attacksUsed: 0,
      attacksAvailable: 1,
      stars: 0,
      destruction: 0,
      subbedIn: true,
      subbedOut: false,
    }));

    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: options?.roundDay ?? 3,
      roundState: options?.roundState ?? "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-03T12:00:00.000Z"),
      startTime: new Date("2026-04-04T12:00:00.000Z"),
      endTime: new Date("2026-04-05T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: roundMembers,
    });
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue(observedRosterRows);
    return { observedRosterRows, roundMembers };
  }

  function mockRotationPlanHistory(
    rows: Array<{
      clanTag: string;
      season: string;
      version: number;
      isActive: boolean;
      updatedAt?: Date;
      id?: string;
    }>,
  ) {
    prismaMock.cwlRotationPlan.findFirst.mockImplementation(async ({ where }: any) => {
      const filtered = rows
        .filter((row) => {
          if (where?.clanTag && row.clanTag !== where.clanTag) return false;
          if (where?.season && row.season !== where.season) return false;
          if (typeof where?.isActive === "boolean" && row.isActive !== where.isActive) return false;
          return true;
        })
        .sort((left, right) => right.version - left.version);
      return filtered[0] ?? null;
    });
  }

  it("creates a versioned current-season plan and warns when 5-day coverage is impossible", async () => {
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 5,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-05T12:00:00.000Z"),
      startTime: new Date("2026-04-06T12:00:00.000Z"),
      endTime: new Date("2026-04-07T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-05T00:00:00.000Z"),
      members: [
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#PYLQ0289",
          roundDay: 5,
          playerName: "Alpha",
          mapPosition: 1,
          townHall: 16,
          attacksUsed: 0,
          attacksAvailable: 0,
          stars: 0,
          destruction: 0,
          subbedIn: true,
          subbedOut: false,
        },
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#QGRJ2222",
          roundDay: 5,
          playerName: "Bravo",
          mapPosition: 2,
          townHall: 15,
          attacksUsed: 0,
          attacksAvailable: 0,
          stars: 0,
          destruction: 0,
          subbedIn: true,
          subbedOut: false,
        },
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#CUV9082",
          roundDay: 5,
          playerName: "Charlie",
          mapPosition: 3,
          townHall: 15,
          attacksUsed: 0,
          attacksAvailable: 0,
          stars: 0,
          destruction: 0,
          subbedIn: true,
          subbedOut: false,
        },
      ],
    });
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#CUV9082",
        playerName: "Charlie",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#LQ9P8R2",
        playerName: "Delta",
        townHall: 14,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
    ]);

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
    });

    expect(result.outcome).toBe("created");
    expect(result).toMatchObject({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      version: 1,
      lineupSize: 3,
      playersIncludedCount: 4,
      excludedPlayers: [],
    });
    expect(result.outcome === "created" ? result.warnings.join(" | ") : "").toContain(
      "Could not reach 5 planned CWL days",
    );
    expect(result.outcome === "created" ? result.warnings.join(" | ") : "").not.toContain(
      "Not in current CWL",
    );
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clanTag: "#2QG2C08UP",
          season: "2026-04",
          version: 1,
          rosterSize: 3,
          generatedFromRoundDay: 5,
        }),
      }),
    );
    expect(txMock.cwlRotationPlanDay.create).toHaveBeenCalledTimes(3);
    expect(txMock.cwlRotationPlanMember.createMany).toHaveBeenCalledTimes(3);
    expect(txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data.map((row: any) => row.playerTag)).toEqual([
      "#PYLQ0289",
      "#QGRJ2222",
      "#CUV9082",
    ]);
  });

  it("uses the selected 15-player lineup size when creating a current-season plan", async () => {
    const rosterRows = Array.from({ length: 30 }, (_value, index) => {
      const digits = index
        .toString(4)
        .padStart(4, "0")
        .split("")
        .map((char) => ["0", "2", "8", "9"][Number(char)])
        .join("");
      return {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: `#PYLQ${digits}`,
        playerName: `Player ${index + 1}`,
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: index % 5,
        currentRound: null,
      };
    });
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 1,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 30,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-01T12:00:00.000Z"),
      startTime: new Date("2026-04-02T12:00:00.000Z"),
      endTime: new Date("2026-04-03T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-01T00:00:00.000Z"),
      members: rosterRows.map((row, index) => ({
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: row.playerTag,
        roundDay: 1,
        playerName: row.playerName,
        mapPosition: index + 1,
        townHall: 16,
        attacksUsed: 0,
        attacksAvailable: 0,
        stars: 0,
        destruction: 0,
        subbedIn: true,
        subbedOut: false,
      })),
    });
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue(rosterRows);

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 15,
    });

    expect(result).toMatchObject({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      version: 1,
      lineupSize: 15,
    });
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rosterSize: 15,
        }),
      }),
    );
    expect(txMock.cwlRotationPlanDay.create).toHaveBeenCalledTimes(7);
    expect(txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data).toHaveLength(15);
  });

  it("creates a current-season 11-player plan when size 11 is selected", async () => {
    const { observedRosterRows } = setupManualCreateRosterFixture({ rosterCount: 11 });

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
    });

    expect(result).toMatchObject({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      version: 1,
      lineupSize: 11,
      playersIncludedCount: 11,
    });
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rosterSize: 11,
        }),
      }),
    );
    expect(txMock.cwlRotationPlanDay.create).toHaveBeenCalledTimes(5);
    expect(
      txMock.cwlRotationPlanDay.create.mock.calls.every(
        ([call]) => call?.data?.lineupSize === 11,
      ),
    ).toBe(true);
    expect(txMock.cwlRotationPlanMember.createMany).toHaveBeenCalledTimes(5);
    expect(
      txMock.cwlRotationPlanMember.createMany.mock.calls.every(
        ([call]) => {
          const rows = Array.isArray(call?.data) ? call.data : [];
          return rows.length === 11 && new Set(rows.map((row: any) => row.playerTag)).size === 11;
        },
      ),
    ).toBe(true);
    expect(observedRosterRows).toHaveLength(11);
  });

  it("dedupes normalized season-roster rows and repeated excludes in manual 11-player creation", async () => {
    const { observedRosterRows } = setupManualCreateRosterFixture({ rosterCount: 13 });
    observedRosterRows[1].playerTag = observedRosterRows[0].playerTag.toLowerCase();
    observedRosterRows[1].playerName = "Alpha Duplicate";
    const excludedTag = observedRosterRows[2].playerTag;

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
      excludeTagsRaw: `${excludedTag} ${excludedTag}`,
    });

    expect(result).toMatchObject({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      version: 1,
      lineupSize: 11,
      playersIncludedCount: 11,
    });
    expect(result.outcome === "created" ? result.excludedPlayers.map((row) => row.playerTag) : []).toEqual([
      excludedTag,
    ]);
    expect(txMock.cwlRotationPlanDay.create).toHaveBeenCalledTimes(5);
    expect(
      txMock.cwlRotationPlanDay.create.mock.calls.every(([call]) => call?.data?.lineupSize === 11),
    ).toBe(true);
    expect(txMock.cwlRotationPlanMember.createMany).toHaveBeenCalledTimes(5);
    expect(
      txMock.cwlRotationPlanMember.createMany.mock.calls.every(([call]) => {
        const rows = Array.isArray(call?.data) ? call.data : [];
        return rows.length === 11 && new Set(rows.map((row: any) => row.playerTag)).size === 11;
      }),
    ).toBe(true);
    expect(
      txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data.map((row: any) => row.playerTag),
    ).not.toContain(observedRosterRows[1].playerTag);
  });

  it("advances from inactive history to version 2 instead of restarting at 1", async () => {
    mockRotationPlanHistory([
      {
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 1,
        isActive: false,
        id: "plan-1",
      },
    ]);
    setupManualCreateRosterFixture({ rosterCount: 11 });

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
    });

    expect(result).toMatchObject({
      outcome: "created",
      version: 2,
    });
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 2,
        }),
      }),
    );
  });

  it("uses max persisted history instead of the active row when overwriting an existing plan", async () => {
    mockRotationPlanHistory([
      {
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 2,
        isActive: true,
        id: "plan-active",
      },
      {
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 7,
        isActive: false,
        id: "plan-historical",
      },
    ]);
    setupManualCreateRosterFixture({ rosterCount: 11 });

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
      overwrite: true,
    });

    expect(result).toMatchObject({
      outcome: "created",
      version: 8,
    });
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 8,
        }),
      }),
    );
  });

  it("preserves the max persisted version across manual, roster-backed, and imported rotation creation", async () => {
    mockRotationPlanHistory([
      {
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 10,
        isActive: false,
        id: "plan-10",
      },
    ]);

    const manualRoster = setupManualCreateRosterFixture({ rosterCount: 11 });
    const manualResult = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
    });
    expect(manualResult).toMatchObject({ outcome: "created", version: 11 });
    expect(manualRoster.observedRosterRows).toHaveLength(11);

    vi.clearAllMocks();
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP", name: "CWL Alpha" });
    prismaMock.cwlRotationPlan.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.isActive) {
        return null;
      }
      return {
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 10,
        isActive: false,
      };
    });
    txMock.cwlRotationPlan.findFirst.mockImplementation((...args: any[]) =>
      prismaMock.cwlRotationPlan.findFirst(...args),
    );
    txMock.cwlRotationPlan.create.mockResolvedValue({ id: "plan-roster" });
    txMock.cwlRotationPlanDay.create.mockImplementation(async (args: any) => ({
      id: 200 + Number(args?.data?.roundDay ?? 0),
    }));
    txMock.cwlRotationPlanMember.createMany.mockResolvedValue({ count: 0 });
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue(
      Array.from({ length: 11 }, (_value, index) => {
        const digits = index
          .toString(4)
          .padStart(4, "0")
          .split("")
          .map((char) => ["0", "2", "8", "9"][Number(char)])
          .join("");
        return {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: `#PYLQ${digits}`,
          playerName: `Roster Player ${index + 1}`,
          townHall: 16,
          linkedDiscordUserId: null,
          linkedDiscordUsername: null,
          daysParticipated: 0,
          currentRound: null,
        };
      }),
    );
    vi.spyOn(rosterService, "getRosterView").mockResolvedValue({
      roster: {
        id: "roster-allocator",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "Allocator roster",
        clanTag: "#2QG2C08UP",
        startsAt: null,
        endsAt: null,
        timezone: "UTC",
        displayTimezone: "UTC",
        maxMembers: 11,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: null,
      groups: [
        {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      ],
      signups: Array.from({ length: 11 }, (_value, index) => {
        const digits = index
          .toString(4)
          .padStart(4, "0")
          .split("")
          .map((char) => ["0", "2", "8", "9"][Number(char)])
          .join("");
        return {
          id: `signup-${index + 1}`,
          rosterId: "roster-allocator",
          groupId: "group-confirmed",
          playerTag: `#PYLQ${digits}`,
          playerName: `Roster Player ${index + 1}`,
          discordUserId: `${index + 1}`.padStart(18, "1"),
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          weight: 100_000 - index,
          weightSource: "Manual",
          weightMeasuredAt: new Date("2026-04-20T01:00:00.000Z"),
          townHall: 16,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: null,
            sortOrder: 0,
          },
        };
      }),
      totalSignupCount: 11,
    } as any);

    const rosterResult = await cwlRotationService.createPlanFromRoster({
      clanTag: "#2QG2C08UP",
      rosterId: "roster-allocator",
      guildId: "guild-1",
      season: "2026-04",
    });
    expect(rosterResult).toMatchObject({ outcome: "created", version: 11 });

    vi.clearAllMocks();
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP", name: "CWL Alpha" });
    prismaMock.cwlRotationPlan.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.isActive) {
        return null;
      }
      return {
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 10,
        isActive: false,
      };
    });
    txMock.cwlRotationPlan.findFirst.mockImplementation((...args: any[]) =>
      prismaMock.cwlRotationPlan.findFirst(...args),
    );
    txMock.cwlRotationPlan.create.mockResolvedValue({ id: "plan-import" });
    txMock.cwlRotationPlanDay.create.mockImplementation(async (args: any) => ({
      id: 300 + Number(args?.data?.roundDay ?? 0),
    }));
    txMock.cwlRotationPlanMember.createMany.mockResolvedValue({ count: 0 });

    const importedResult = await cwlRotationService.persistImportedPlan({
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Rotation",
      sourceTabName: "Day 1",
      season: "2026-04",
      rosterRows: Array.from({ length: 11 }, (_value, index) => {
        const digits = index
          .toString(4)
          .padStart(4, "0")
          .split("")
          .map((char) => ["0", "2", "8", "9"][Number(char)])
          .join("");
        return {
          playerTag: `#PYLQ${digits}`,
          playerName: `Imported Player ${index + 1}`,
        };
      }),
      days: [
        {
          roundDay: 1,
          lineupSize: 11,
          locked: false,
          rows: Array.from({ length: 11 }, (_value, index) => {
            const digits = index
              .toString(4)
              .padStart(4, "0")
              .split("")
              .map((char) => ["0", "2", "8", "9"][Number(char)])
              .join("");
            return {
              playerTag: `#PYLQ${digits}`,
              playerName: `Imported Player ${index + 1}`,
              subbedOut: false,
              assignmentOrder: index,
            };
          }),
          activeMembers: Array.from({ length: 11 }, (_value, index) => {
            const digits = index
              .toString(4)
              .padStart(4, "0")
              .split("")
              .map((char) => ["0", "2", "8", "9"][Number(char)])
              .join("");
            return {
              playerTag: `#PYLQ${digits}`,
              playerName: `Imported Player ${index + 1}`,
              assignmentOrder: index,
            };
          }),
        },
      ],
    });
    expect(importedResult).toMatchObject({ outcome: "created", version: 11 });
  });

  it("blocks a non-overwrite create when the transaction sees an active plan after a stale outside precheck", async () => {
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValueOnce(null);
    txMock.cwlRotationPlan.findFirst.mockResolvedValueOnce({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 1,
      isActive: true,
    } as any);
    setupManualCreateRosterFixture({ rosterCount: 11 });

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
    });

    expect(result).toEqual({
      outcome: "blocked_existing",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      existingVersion: 1,
    });
    expect(txMock.cwlRotationPlan.create).not.toHaveBeenCalled();
    expect(txMock.cwlRotationPlan.updateMany).not.toHaveBeenCalled();
  });

  it("retries a version collision and then blocks once the retried transaction sees the active plan", async () => {
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValueOnce(null);
    txMock.cwlRotationPlan.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ version: 1 } as any)
      .mockResolvedValueOnce({
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 1,
        isActive: true,
      } as any);
    setupManualCreateRosterFixture({ rosterCount: 11 });
    txMock.cwlRotationPlan.create.mockRejectedValueOnce({ code: "P2002" } as any);

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
    });

    expect(result).toEqual({
      outcome: "blocked_existing",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      existingVersion: 1,
    });
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledTimes(1);
  });

  it("replaces an active plan that appears after the outside precheck when overwrite is authorized", async () => {
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValueOnce(null);
    txMock.cwlRotationPlan.findFirst.mockResolvedValueOnce({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 1,
      isActive: true,
    } as any);
    txMock.cwlRotationPlan.findFirst.mockResolvedValueOnce({ version: 7 } as any);
    setupManualCreateRosterFixture({ rosterCount: 11 });
    txMock.cwlRotationPlan.create.mockResolvedValueOnce({ id: "plan-8" });
    txMock.cwlRotationPlan.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
      overwrite: true,
    });

    expect(result).toMatchObject({
      outcome: "created",
      version: 8,
    });
    expect(txMock.cwlRotationPlan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clanTag: "#2QG2C08UP",
          eventInstanceId: "event-current",
          season: "2026-04",
          isActive: true,
        }),
        data: { isActive: false },
      }),
    );
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 8,
          isActive: true,
        }),
      }),
    );
  });

  it("retries a transient version collision instead of surfacing P2002", async () => {
    mockRotationPlanHistory([]);
    setupManualCreateRosterFixture({ rosterCount: 11 });
    txMock.cwlRotationPlan.create.mockRejectedValueOnce({ code: "P2002" } as any);

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
    });

    expect(result).toMatchObject({
      outcome: "created",
      version: 1,
    });
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid current-season lineup sizes before persistence", async () => {
    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 12 as any,
    });

    expect(result).toEqual({
      outcome: "invalid_size",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      requestedLineupSize: 12,
    });
    expect(prismaMock.cwlTrackedClan.findFirst).not.toHaveBeenCalled();
    expect(txMock.cwlRotationPlan.create).not.toHaveBeenCalled();
  });

  it("rejects current-season 11-player plans when fewer than 11 players remain", async () => {
    setupManualCreateRosterFixture({ rosterCount: 10 });

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
    });

    expect(result).toEqual({
      outcome: "not_enough_players",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      lineupSize: 11,
      availablePlayers: 10,
      diagnostics: {
        sourceMode: "manual_observed_season_roster",
        observedSeasonRosterCount: 10,
        correspondingSignupRosterCount: null,
        currentRoundMemberCount: 10,
        excludedCount: 0,
        eligibleAfterExclusionsCount: 10,
      },
    });
    expect(txMock.cwlRotationPlan.create).not.toHaveBeenCalled();
  });

  it("rejects excludes that are not part of the observed season roster", async () => {
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 1,
      roundState: "preparation",
      opponentTag: null,
      opponentName: null,
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: null,
      startTime: null,
      endTime: null,
      sourceUpdatedAt: new Date("2026-04-01T00:00:00.000Z"),
      members: [],
    });
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 1,
        currentRound: null,
      },
    ]);

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      excludeTagsRaw: "#Q2V8P9L2",
    });

    expect(result).toEqual({
      outcome: "invalid_excludes",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      invalidTags: ["#Q2V8P9L2"],
    });
  });

  it.each([
    ["comma", (rows: Array<{ playerTag: string }>) => `${rows[0].playerTag},${rows[1].playerTag}`],
    ["space", (rows: Array<{ playerTag: string }>) => `${rows[0].playerTag} ${rows[1].playerTag}`],
    ["comma-space", (rows: Array<{ playerTag: string }>) => `${rows[0].playerTag}, ${rows[1].playerTag}`],
    ["hash-space", (rows: Array<{ playerTag: string }>) => `${rows[0].playerTag} ${rows[1].playerTag}`],
    ["newline", (rows: Array<{ playerTag: string }>) => `${rows[0].playerTag},\n${rows[1].playerTag}`],
  ])("parses whitespace/comma exclude tags from %s", async (_label, buildRaw) => {
    const { observedRosterRows } = setupManualCreateRosterFixture();
    const expectedTags = [observedRosterRows[0].playerTag, observedRosterRows[1].playerTag];
    const excludeTagsRaw = buildRaw(observedRosterRows);

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 15,
      excludeTagsRaw,
    });

    expect(result.outcome).toBe("created");
    expect(result.outcome === "created" ? result.excludedPlayers.map((row) => row.playerTag) : []).toEqual(
      expectedTags,
    );
    expect(result.outcome === "created" ? result.playersIncludedCount : 0).toBe(18);
  });

  it("de-dupes repeated exclude tags", async () => {
    const { observedRosterRows } = setupManualCreateRosterFixture();
    const repeatedTag = observedRosterRows[0].playerTag;

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 15,
      excludeTagsRaw: `${repeatedTag} ${repeatedTag}`,
    });

    expect(result.outcome).toBe("created");
    expect(result.outcome === "created" ? result.excludedPlayers.map((row) => row.playerTag) : []).toEqual([
      repeatedTag,
    ]);
  });

  it("returns invalid exclude input when a non-empty token cannot be parsed as a player tag", async () => {
    setupManualCreateRosterFixture();

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 15,
      excludeTagsRaw: "G98QLYCJY-G8CUUYCYG",
    });

    expect(result).toEqual({
      outcome: "invalid_exclude_input",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      invalidTokens: ["G98QLYCJY-G8CUUYCYG"],
    });
  });

  it("creates manual plans from the full observed season roster and ignores Day 1 lineup membership for eligibility", async () => {
    const observedRosterRows = Array.from({ length: 37 }, (_value, index) => {
      const digits = index
        .toString(4)
        .padStart(4, "0")
        .split("")
        .map((char) => ["0", "2", "8", "9"][Number(char)])
        .join("");
      const playerTag = `#PYLQ${digits}`;
      return {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag,
        playerName: `Observed ${index + 1}`,
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: index % 3,
        currentRound: null,
      };
    });
    const currentRoundMembers = observedRosterRows.slice(0, 27).map((row, index) => ({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      playerTag: row.playerTag,
      roundDay: 3,
      playerName: row.playerName,
      mapPosition: index + 1,
      townHall: row.townHall,
      attacksUsed: 0,
      attacksAvailable: 1,
      stars: 0,
      destruction: 0,
      subbedIn: true,
      subbedOut: false,
    }));
    const excludeTags = observedRosterRows.slice(31).map((row) => row.playerTag);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 3,
      roundState: "inWar",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-03T12:00:00.000Z"),
      startTime: new Date("2026-04-04T12:00:00.000Z"),
      endTime: new Date("2026-04-05T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: currentRoundMembers,
    });
    vi.spyOn(cwlStateService, "getCurrentPreparationSnapshotForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 4,
      roundState: "preparation",
      opponentTag: "#OPP2",
      opponentName: "Opponent Two",
      preparationStartTime: new Date("2026-04-04T12:00:00.000Z"),
      startTime: new Date("2026-04-05T12:00:00.000Z"),
      endTime: new Date("2026-04-06T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: [],
    });
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue(observedRosterRows);

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 30,
      excludeTagsRaw: excludeTags.join(","),
    });

    expect(result).toMatchObject({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      lineupSize: 30,
      playersIncludedCount: 31,
    });
    expect(result.outcome === "created" ? result.warnings.join(" | ") : "").not.toContain(
      "Not in current CWL",
    );
    expect(result.outcome === "created" ? result.excludedPlayers.map((row) => row.playerTag) : []).toEqual(
      excludeTags,
    );
    expect(result.outcome === "created" ? result.excludedPlayers.map((row) => row.playerName) : []).toEqual(
      excludeTags.map((tag) => observedRosterRows.find((row) => row.playerTag === tag)?.playerName ?? null),
    );
    const createdMetadata = txMock.cwlRotationPlan.create.mock.calls[0]?.[0]?.data?.metadata as any;
    expect(createdMetadata?.rosterRows).toHaveLength(31);
    expect(txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data).toHaveLength(30);
  });

  it("creates roster-backed plans from confirmed CWL signups using weight priority and missing TH warnings", async () => {
    vi.spyOn(rosterService, "getRosterView").mockResolvedValue({
      roster: {
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha roster",
        clanTag: "#2QG2C08UP",
        startsAt: null,
        endsAt: null,
        timezone: "UTC",
        displayTimezone: "UTC",
        maxMembers: 3,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: null,
      groups: [
        {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      ],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PYLQ0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          weight: 120_000,
          weightSource: "Manual",
          weightMeasuredAt: new Date("2026-04-20T01:00:00.000Z"),
          townHall: 16,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: null,
            sortOrder: 0,
          },
        },
        {
          id: "signup-2",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "222222222222222222",
          signedUpAt: new Date("2026-04-20T00:05:00.000Z"),
          createdAt: new Date("2026-04-20T00:05:00.000Z"),
          updatedAt: new Date("2026-04-20T00:05:00.000Z"),
          weight: 90_000,
          weightSource: "FWA",
          weightMeasuredAt: new Date("2026-04-20T01:05:00.000Z"),
          townHall: null,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: null,
            sortOrder: 0,
          },
        },
        {
          id: "signup-3",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#CUV9082",
          playerName: "Charlie",
          discordUserId: "333333333333333333",
          signedUpAt: new Date("2026-04-20T00:10:00.000Z"),
          createdAt: new Date("2026-04-20T00:10:00.000Z"),
          updatedAt: new Date("2026-04-20T00:10:00.000Z"),
          weight: null,
          weightSource: "Unknown",
          weightMeasuredAt: null,
          townHall: 15,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: null,
            sortOrder: 0,
          },
        },
        {
          id: "signup-4",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#LQ9P8R2",
          playerName: "Delta",
          discordUserId: "444444444444444444",
          signedUpAt: new Date("2026-04-20T00:15:00.000Z"),
          createdAt: new Date("2026-04-20T00:15:00.000Z"),
          updatedAt: new Date("2026-04-20T00:15:00.000Z"),
          weight: 80_000,
          weightSource: "Manual",
          weightMeasuredAt: new Date("2026-04-20T01:15:00.000Z"),
          townHall: 14,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: null,
            sortOrder: 0,
          },
        },
      ],
      totalSignupCount: 4,
    } as any);
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 3,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 1,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#CUV9082",
        playerName: "Charlie",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#LQ9P8R2",
        playerName: "Delta",
        townHall: 14,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
    ]);
    const result = await cwlRotationService.createPlanFromRoster({
      clanTag: "#2QG2C08UP",
      rosterId: "roster-1",
      guildId: "guild-1",
      season: "2026-04",
    });

    expect(result).toMatchObject({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      rosterId: "roster-1",
      rosterTitle: "CWL Alpha roster",
      rosterPostedMessageUrl: null,
      lineupSize: 3,
      playersIncludedCount: 4,
      excludedPlayers: [],
      sourceLabel: "CWL roster - CWL Alpha roster",
    });
    expect(result.outcome === "created" ? result.warnings.join(" | ") : "").toContain(
      "Missing Town Hall data for confirmed roster players",
    );
    expect(result.outcome === "created" ? result.warnings.join(" | ") : "").not.toContain(
      "Skipped confirmed roster players not observed in current CWL",
    );
    expect(cwlStateService.getCurrentPreparationSnapshotForClan).not.toHaveBeenCalled();
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clanTag: "#2QG2C08UP",
          season: "2026-04",
          version: 1,
          rosterSize: 3,
          generatedFromRoundDay: null,
          warningSummary: expect.stringContaining("Missing Town Hall data for confirmed roster players"),
          metadata: expect.objectContaining({
            source: "CWL roster - CWL Alpha roster",
            rosterId: "roster-1",
            rosterTitle: "CWL Alpha roster",
            rosterClanTag: "#2QG2C08UP",
            confirmedRosterSize: 4,
            lineupSize: 3,
          }),
        }),
      }),
    );
    expect(txMock.cwlRotationPlanDay.create).toHaveBeenCalledTimes(7);
    expect(txMock.cwlRotationPlanMember.createMany).toHaveBeenCalledTimes(7);
    expect(txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data.map((row: any) => row.playerTag)).toEqual([
      "#PYLQ0289",
      "#QGRJ2222",
      "#LQ9P8R2",
    ]);
    expect(txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data.map((row: any) => row.playerName)).toEqual([
      "Alpha",
      "Bravo",
      "Delta",
    ]);
  });

  it("creates roster-backed plans from the full observed season roster and skips non-CWL signups without using Day 1 lineup membership", async () => {
    const observedRosterRows = Array.from({ length: 37 }, (_value, index) => {
      const digits = index
        .toString(4)
        .padStart(4, "0")
        .split("")
        .map((char) => ["0", "2", "8", "9"][Number(char)])
        .join("");
      const playerTag = `#PYLQ${digits}`;
      return {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag,
        playerName: `Observed ${index + 1}`,
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: index % 4,
        currentRound: null,
      };
    });
    const confirmedSignups = [
      ...observedRosterRows.slice(0, 31).map((row, index) => ({
        id: `signup-${index + 1}`,
        rosterId: "roster-1",
        groupId: "group-confirmed",
        playerTag: row.playerTag,
        playerName: row.playerName,
        discordUserId: `${index + 1}`.padStart(18, "1"),
        signedUpAt: new Date(`2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`),
        createdAt: new Date(`2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`),
        updatedAt: new Date(`2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`),
        weight: null,
        weightSource: "Unknown",
        weightMeasuredAt: null,
        townHall: 16,
        discordDisplayName: null,
        discordUsername: null,
        clanTag: null,
        clanName: null,
        group: {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      })),
      ...Array.from({ length: 9 }, (_value, index) => {
        const digits = (index + 37)
          .toString(4)
          .padStart(4, "0")
          .split("")
          .map((char) => ["0", "2", "8", "9"][Number(char)])
          .join("");
        const playerTag = `#PYLQ${digits}`;
        return {
          id: `signup-missing-${index + 1}`,
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag,
          playerName: `Missing ${index + 1}`,
          discordUserId: `${index + 41}`.padStart(18, "2"),
          signedUpAt: new Date(`2026-04-20T01:${String(index).padStart(2, "0")}:00.000Z`),
          createdAt: new Date(`2026-04-20T01:${String(index).padStart(2, "0")}:00.000Z`),
          updatedAt: new Date(`2026-04-20T01:${String(index).padStart(2, "0")}:00.000Z`),
          weight: null,
          weightSource: "Unknown",
          weightMeasuredAt: null,
          townHall: 16,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: null,
            sortOrder: 0,
          },
        };
      }),
    ];
    const currentRoundSpy = vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue(null as any);
    vi.spyOn(rosterService, "getRosterView").mockResolvedValue({
      roster: {
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha roster",
        clanTag: "#2QG2C08UP",
        startsAt: null,
        endsAt: null,
        timezone: "UTC",
        displayTimezone: "UTC",
        maxMembers: 30,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: null,
      groups: [
        {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      ],
      signups: confirmedSignups,
      totalSignupCount: confirmedSignups.length,
    } as any);
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue(observedRosterRows);

    const result = await cwlRotationService.createPlanFromRoster({
      clanTag: "#2QG2C08UP",
      rosterId: "roster-1",
      guildId: "guild-1",
      season: "2026-04",
      lineupSize: 30,
    });

    expect(result).toMatchObject({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      rosterId: "roster-1",
      rosterTitle: "CWL Alpha roster",
      rosterPostedMessageUrl: null,
      lineupSize: 30,
      playersIncludedCount: 31,
    });
    expect(result.outcome === "created" ? result.warnings.join(" | ") : "").toContain(
      "Skipped confirmed roster players not observed in current CWL",
    );
    expect(result.outcome === "created" ? result.excludedPlayers : []).toHaveLength(9);
    expect(result.outcome === "created" ? result.excludedPlayers.map((row) => row.playerTag) : []).toEqual(
      confirmedSignups.slice(31).map((signup) => signup.playerTag),
    );
    expect(result.outcome === "created" ? result.excludedPlayers.map((row) => row.playerName) : []).toEqual(
      confirmedSignups.slice(31).map((signup) => signup.playerName),
    );
    expect(currentRoundSpy).not.toHaveBeenCalled();
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rosterSize: 30,
          metadata: expect.objectContaining({
            confirmedRosterSize: 31,
            lineupSize: 30,
          }),
        }),
      }),
    );
    expect(txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data).toHaveLength(30);
  });

  it("creates roster-backed 11-player plans when size 11 is selected", async () => {
    const rosterRows = Array.from({ length: 11 }, (_value, index) => {
      const digits = index
        .toString(4)
        .padStart(4, "0")
        .split("")
        .map((char) => ["0", "2", "8", "9"][Number(char)])
        .join("");
      return {
        playerTag: `#PYLQ${digits}`,
        playerName: `Player ${index + 1}`,
      };
    });
    vi.spyOn(rosterService, "getRosterView").mockResolvedValue({
      roster: {
        id: "roster-11",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha roster",
        clanTag: "#2QG2C08UP",
        startsAt: null,
        endsAt: null,
        timezone: "UTC",
        displayTimezone: "UTC",
        maxMembers: 11,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: null,
      groups: [
        {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      ],
      signups: rosterRows.map((row, index) => ({
        id: `signup-${index + 1}`,
        rosterId: "roster-11",
        groupId: "group-confirmed",
        playerTag: row.playerTag,
        playerName: row.playerName,
        discordUserId: `${index + 1}`.padStart(18, "1"),
        signedUpAt: new Date(`2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`),
        createdAt: new Date(`2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`),
        updatedAt: new Date(`2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`),
        weight: null,
        weightSource: "Unknown",
        weightMeasuredAt: null,
        townHall: 15,
        discordDisplayName: null,
        discordUsername: null,
        clanTag: null,
        clanName: null,
        group: {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      })),
      totalSignupCount: rosterRows.length,
    } as any);
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue(
      rosterRows.map((row) => ({
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: row.playerTag,
        playerName: row.playerName,
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      })),
    );

    const result = await cwlRotationService.createPlanFromRoster({
      clanTag: "#2QG2C08UP",
      rosterId: "roster-11",
      guildId: "guild-1",
      season: "2026-04",
      lineupSize: 11,
    });

    expect(result).toMatchObject({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      rosterId: "roster-11",
      rosterTitle: "CWL Alpha roster",
      lineupSize: 11,
      playersIncludedCount: 11,
    });
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rosterSize: 11,
          metadata: expect.objectContaining({
            confirmedRosterSize: 11,
            lineupSize: 11,
          }),
        }),
      }),
    );
    expect(txMock.cwlRotationPlanDay.create).toHaveBeenCalledTimes(7);
    expect(
      txMock.cwlRotationPlanDay.create.mock.calls.every(
        ([call]) => call?.data?.lineupSize === 11,
      ),
    ).toBe(true);
    expect(txMock.cwlRotationPlanMember.createMany).toHaveBeenCalledTimes(7);
    expect(
      txMock.cwlRotationPlanMember.createMany.mock.calls.every(
        ([call]) => {
          const rows = Array.isArray(call?.data) ? call.data : [];
          return rows.length === 11 && new Set(rows.map((row: any) => row.playerTag)).size === 11;
        },
      ),
    ).toBe(true);
  });

  it("creates roster-backed 30-player plans when size 30 is selected", async () => {
    const rosterRows = Array.from({ length: 30 }, (_value, index) => {
      const digits = index
        .toString(4)
        .padStart(4, "0")
        .split("")
        .map((char) => ["0", "2", "8", "9"][Number(char)])
        .join("");
      return {
        playerTag: `#PYLQ${digits}`,
        playerName: `Player ${index + 1}`,
      };
    });
    vi.spyOn(rosterService, "getRosterView").mockResolvedValue({
      roster: {
        id: "roster-30",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha roster",
        clanTag: "#2QG2C08UP",
        startsAt: null,
        endsAt: null,
        timezone: "UTC",
        displayTimezone: "UTC",
        maxMembers: 30,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: null,
      groups: [
        {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      ],
      signups: rosterRows.map((row, index) => ({
        id: `signup-${index + 1}`,
        rosterId: "roster-30",
        groupId: "group-confirmed",
        playerTag: row.playerTag,
        playerName: row.playerName,
        discordUserId: "111111111111111111",
        signedUpAt: new Date(`2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`),
        createdAt: new Date(`2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`),
        updatedAt: new Date(`2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`),
        weight: null,
        weightSource: "Unknown",
        weightMeasuredAt: null,
        townHall: 16,
        discordDisplayName: null,
        discordUsername: null,
        clanTag: null,
        clanName: null,
        group: {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      })),
      totalSignupCount: 30,
    } as any);
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue(
      rosterRows.map((row, index) => ({
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: row.playerTag,
        playerName: row.playerName,
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: index % 5,
        currentRound: null,
      })),
    );
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 1,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 30,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-20T12:00:00.000Z"),
      startTime: new Date("2026-04-21T12:00:00.000Z"),
      endTime: new Date("2026-04-22T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-20T00:00:00.000Z"),
      members: rosterRows.map((row, index) => ({
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: row.playerTag,
        roundDay: 1,
        playerName: row.playerName,
        mapPosition: index + 1,
        townHall: 16,
        attacksUsed: 0,
        attacksAvailable: 0,
        stars: 0,
        destruction: 0,
        subbedIn: true,
        subbedOut: false,
      })),
    });

    const result = await cwlRotationService.createPlanFromRoster({
      clanTag: "#2QG2C08UP",
      rosterId: "roster-30",
      guildId: "guild-1",
      season: "2026-04",
      lineupSize: 30,
    });

    expect(result).toMatchObject({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      rosterId: "roster-30",
      rosterTitle: "CWL Alpha roster",
      rosterPostedMessageUrl: null,
      lineupSize: 30,
      playersIncludedCount: 30,
      excludedPlayers: [],
    });
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rosterSize: 30,
          metadata: expect.objectContaining({
            lineupSize: 30,
          }),
        }),
      }),
    );
    expect(txMock.cwlRotationPlanDay.create).toHaveBeenCalledTimes(7);
    expect(txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data).toHaveLength(30);
  });

  it("falls back to the current tracked clan name when export metadata lacks a clan name", async () => {
    prismaMock.cwlRotationPlan.findMany.mockResolvedValue([
      {
        id: "plan-1",
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 4,
        isActive: true,
        rosterSize: 2,
        generatedFromRoundDay: null,
        excludedPlayerTags: [],
        warningSummary: null,
        metadata: {
          source: "sheet-import",
          rosterTitle: "Masters 1 [A] | 175k+ WW",
          rosterShortName: "M1 [A]",
        },
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      } as any,
    ]);
    prismaMock.cwlRotationPlanDay.findMany.mockResolvedValue([
      {
        id: 1,
        planId: "plan-1",
        roundDay: 1,
        lineupSize: 2,
        locked: false,
        metadata: {},
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        members: [
          {
            id: 11,
            planDayId: 1,
            playerTag: "#PYLQ0289",
            playerName: "Alpha",
            assignmentOrder: 0,
            manualOverride: false,
            createdAt: new Date("2026-04-20T00:00:00.000Z"),
            updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          } as any,
          {
            id: 12,
            planDayId: 1,
            playerTag: "#QGRJ2222",
            playerName: "Bravo",
            assignmentOrder: 1,
            manualOverride: false,
            createdAt: new Date("2026-04-20T00:00:00.000Z"),
            updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          } as any,
        ],
      } as any,
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP", name: "Rising Thrones" } as any]);
    prismaMock.currentCwlPrepSnapshot.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findMany.mockResolvedValue([]);

    const exports = await cwlRotationService.listActivePlanExports({ season: "2026-04" });

    expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalledWith({
      where: {
        season: "2026-04",
        tag: { in: ["#2QG2C08UP"] },
      },
      select: { tag: true, name: true },
      orderBy: [{ tag: "asc" }],
    });
    expect(exports).toHaveLength(1);
    expect(exports[0]).toEqual(
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        clanName: "Rising Thrones",
        clanDisplayName: "Rising Thrones",
        rosterTitle: "Masters 1 [A] | 175k+ WW",
        rosterShortName: "M1 [A]",
      }),
    );
  });

  it("falls back safely when no matching CWL roster can be resolved for export plans", async () => {
    prismaMock.cwlRotationPlan.findMany.mockResolvedValue([
      {
        id: "plan-manual-2",
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 4,
        isActive: true,
        rosterSize: 2,
        generatedFromRoundDay: null,
        excludedPlayerTags: [],
        warningSummary: null,
        metadata: {
          source: "manual",
        },
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      } as any,
    ]);
    prismaMock.cwlRotationPlanDay.findMany.mockResolvedValue([
      {
        id: 1,
        planId: "plan-manual-2",
        roundDay: 1,
        lineupSize: 2,
        locked: false,
        metadata: {},
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        members: [],
      } as any,
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP", name: "Rising Thrones" } as any]);
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.currentCwlPrepSnapshot.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findMany.mockResolvedValue([]);

    const exports = await cwlRotationService.listActivePlanExports({ season: "2026-04" });

    expect(exports).toHaveLength(1);
    expect(exports[0]).toEqual(
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        clanName: "Rising Thrones",
        clanDisplayName: "Rising Thrones",
        rosterTitle: null,
        rosterShortName: null,
        sourceLabel: "manual",
      }),
    );
  });

  it("returns only currently tracked active plans in exports and ignores stale active clans", async () => {
    const trackedPlan = {
      id: "plan-tracked",
      eventInstanceId: "event-current",
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 4,
      isActive: true,
      rosterSize: 2,
      generatedFromRoundDay: null,
      excludedPlayerTags: [],
      warningSummary: null,
      metadata: {
        source: "manual",
      },
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any;
    const stalePlan = {
      id: "plan-stale",
      eventInstanceId: "event-stale",
      clanTag: "#9GLGQCCU",
      season: "2026-04",
      version: 5,
      isActive: true,
      rosterSize: 2,
      generatedFromRoundDay: null,
      excludedPlayerTags: [],
      warningSummary: null,
      metadata: {
        source: "manual",
      },
      createdAt: new Date("2026-04-21T00:00:00.000Z"),
      updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    } as any;
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Rising Thrones" } as any,
    ]);
    prismaMock.cwlRotationPlan.findMany.mockImplementation(async ({ where }: any) => {
      const requestedScopes = new Set<string>(
        ((where?.OR ?? []) as Array<{ clanTag: string; eventInstanceId: string }>).map(
          (scope) => `${scope.eventInstanceId}:${scope.clanTag}`,
        ),
      );
      return [trackedPlan, stalePlan].filter((plan) => requestedScopes.has(`${plan.eventInstanceId}:${plan.clanTag}`));
    });
    prismaMock.cwlRotationPlanDay.findMany.mockResolvedValue([]);
    prismaMock.currentCwlPrepSnapshot.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findMany.mockResolvedValue([]);

    const exports = await cwlRotationService.listActivePlanExports({ season: "2026-04" });

    expect(prismaMock.cwlRotationPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          season: "2026-04",
          isActive: true,
          OR: [{ clanTag: "#2QG2C08UP", eventInstanceId: "event-current" }],
        }),
      }),
    );
    expect(exports).toHaveLength(1);
    expect(exports[0]?.clanTag).toBe("#2QG2C08UP");
  });

  it("intersects explicit export clan tags with the currently tracked CWL clans", async () => {
    const trackedPlan = {
      id: "plan-tracked",
      eventInstanceId: "event-current",
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 4,
      isActive: true,
      rosterSize: 2,
      generatedFromRoundDay: null,
      excludedPlayerTags: [],
      warningSummary: null,
      metadata: {
        source: "manual",
      },
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any;
    const stalePlan = {
      id: "plan-stale",
      eventInstanceId: "event-stale",
      clanTag: "#9GLGQCCU",
      season: "2026-04",
      version: 5,
      isActive: true,
      rosterSize: 2,
      generatedFromRoundDay: null,
      excludedPlayerTags: [],
      warningSummary: null,
      metadata: {
        source: "manual",
      },
      createdAt: new Date("2026-04-21T00:00:00.000Z"),
      updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    } as any;
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Rising Thrones" } as any,
    ]);
    prismaMock.cwlRotationPlan.findMany.mockImplementation(async ({ where }: any) => {
      const requestedScopes = new Set<string>(
        ((where?.OR ?? []) as Array<{ clanTag: string; eventInstanceId: string }>).map(
          (scope) => `${scope.eventInstanceId}:${scope.clanTag}`,
        ),
      );
      return [trackedPlan, stalePlan].filter((plan) => requestedScopes.has(`${plan.eventInstanceId}:${plan.clanTag}`));
    });
    prismaMock.cwlRotationPlanDay.findMany.mockResolvedValue([]);
    prismaMock.currentCwlPrepSnapshot.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findMany.mockResolvedValue([]);

    const exports = await cwlRotationService.listActivePlanExports({
      season: "2026-04",
      clanTags: ["#9GLGQCCU", "#2QG2C08UP"],
    });

    expect(prismaMock.cwlRotationPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          season: "2026-04",
          isActive: true,
          OR: [{ clanTag: "#2QG2C08UP", eventInstanceId: "event-current" }],
        }),
      }),
    );
    expect(exports).toHaveLength(1);
    expect(exports[0]?.clanTag).toBe("#2QG2C08UP");
  });

  it("ignores a previous same-month event plan when the current event has no active plan", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Rising Thrones" } as any,
    ]);
    prismaMock.cwlEventClan.findMany.mockImplementation(async () => [
      {
        clanTag: "#2QG2C08UP",
        eventInstanceId: "event-b",
        eventInstance: {
          id: "event-b",
          season: "2026-04",
          anchorWarTag: "#WAR-B",
          firstObservedAt: new Date("2026-04-15T00:00:00.000Z"),
          lastObservedAt: new Date("2026-04-15T00:00:00.000Z"),
        },
      },
    ]);
    const eventAPlan = {
      id: "plan-event-a",
      eventInstanceId: "event-a",
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 1,
      isActive: true,
    };
    prismaMock.cwlRotationPlan.findMany.mockImplementation(async ({ where }: any) => {
      const requestedScopes = new Set<string>(
        ((where?.OR ?? []) as Array<{ clanTag: string; eventInstanceId: string }>).map(
          (scope) => `${scope.eventInstanceId}:${scope.clanTag}`,
        ),
      );
      return [eventAPlan].filter((plan) => requestedScopes.has(`${plan.eventInstanceId}:${plan.clanTag}`));
    });

    const exports = await cwlRotationService.listActivePlanExports({ season: "2026-04" });

    expect(exports).toEqual([]);
    expect(prismaMock.cwlRotationPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ clanTag: "#2QG2C08UP", eventInstanceId: "event-b" }],
        }),
      }),
    );
  });

  it("starts current event plan versions at one even when a previous same-month event has a plan", async () => {
    prismaMock.cwlEventClan.findMany.mockImplementation(async () => [
      {
        clanTag: "#2QG2C08UP",
        eventInstanceId: "event-b",
        eventInstance: {
          id: "event-b",
          season: "2026-04",
          anchorWarTag: "#WAR-B",
          firstObservedAt: new Date("2026-04-15T00:00:00.000Z"),
          lastObservedAt: new Date("2026-04-15T00:00:00.000Z"),
        },
      },
    ]);
    prismaMock.cwlRotationPlan.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.eventInstanceId === "event-b") return null;
      return { id: "plan-event-a", eventInstanceId: "event-a", clanTag: "#2QG2C08UP", version: 1 };
    });
    txMock.cwlRotationPlan.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.eventInstanceId === "event-b") return null;
      return { id: "plan-event-a", eventInstanceId: "event-a", clanTag: "#2QG2C08UP", version: 1 };
    });
    setupManualCreateRosterFixture({ rosterCount: 11 });
    txMock.cwlRotationPlan.create.mockResolvedValueOnce({ id: "plan-event-b" });

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      lineupSize: 11,
    });

    expect(result).toMatchObject({ outcome: "created", version: 1 });
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventInstanceId: "event-b",
          version: 1,
        }),
      }),
    );
  });

  it("deactivates the active CWL rotation plan without deleting history rows", async () => {
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValue({
      id: "plan-1",
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 7,
      isActive: true,
      metadata: {
        clanName: "CWL Alpha",
      },
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any);
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "CWL Alpha",
    } as any);

    const result = await cwlRotationService.deleteActivePlan({
      clanTag: "#2qg2c08up",
      season: "2026-04",
    });

    expect(result).toEqual({
      outcome: "deleted",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      version: 7,
    });
    expect(prismaMock.cwlRotationPlan.updateMany).toHaveBeenCalledWith({
      where: {
        eventInstanceId: "event-current",
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });
  });

  it("returns not_found when deleting a clan with no active CWL rotation", async () => {
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValue(null);

    const result = await cwlRotationService.deleteActivePlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
    });

    expect(result).toEqual({
      outcome: "not_found",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
    });
    expect(prismaMock.cwlRotationPlan.updateMany).not.toHaveBeenCalled();
  });

  it("returns an empty overview without downstream work when no CWL clans are tracked", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);

    const refreshSpy = vi
      .spyOn(FwaClanMembersSyncService.prototype, "refreshCurrentClanMembersForClanTags")
      .mockResolvedValue({
        clanCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        failedClans: [],
      });
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue(null);
    vi.spyOn(cwlRotationService, "getPreferredDisplayDay").mockResolvedValue(null as any);
    vi.spyOn(cwlRotationService, "validatePlanDay").mockResolvedValue(null);

    const overview = await cwlRotationService.listOverview({
      season: "2026-04",
      refreshLeadershipMembers: true,
    });

    expect(overview).toEqual([]);
    expect(prismaMock.cwlRotationPlan.findMany).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(cwlStateService.getCurrentRoundForClan).not.toHaveBeenCalled();
    expect(cwlRotationService.getPreferredDisplayDay).not.toHaveBeenCalled();
    expect(cwlRotationService.validatePlanDay).not.toHaveBeenCalled();
  });

  it("dedupes duplicate confirmed roster tags before creating a roster-backed plan", async () => {
    vi.spyOn(rosterService, "getRosterView").mockResolvedValue({
      roster: {
        id: "roster-2",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha roster",
        clanTag: "#2QG2C08UP",
        startsAt: null,
        endsAt: null,
        timezone: "UTC",
        displayTimezone: "UTC",
        maxMembers: 2,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: null,
      groups: [
        {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      ],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-2",
          groupId: "group-confirmed",
          playerTag: "#PYLQ0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          weight: 100_000,
          weightSource: "Manual",
          weightMeasuredAt: new Date("2026-04-20T01:00:00.000Z"),
          townHall: 16,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: null,
            sortOrder: 0,
          },
        },
        {
          id: "signup-2",
          rosterId: "roster-2",
          groupId: "group-confirmed",
          playerTag: "#PYLQ0289",
          playerName: "Alpha Prime",
          discordUserId: "222222222222222222",
          signedUpAt: new Date("2026-04-20T00:05:00.000Z"),
          createdAt: new Date("2026-04-20T00:05:00.000Z"),
          updatedAt: new Date("2026-04-20T00:05:00.000Z"),
          weight: 150_000,
          weightSource: "FWA",
          weightMeasuredAt: new Date("2026-04-20T01:05:00.000Z"),
          townHall: 17,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: null,
            sortOrder: 0,
          },
        },
        {
          id: "signup-3",
          rosterId: "roster-2",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "333333333333333333",
          signedUpAt: new Date("2026-04-20T00:10:00.000Z"),
          createdAt: new Date("2026-04-20T00:10:00.000Z"),
          updatedAt: new Date("2026-04-20T00:10:00.000Z"),
          weight: null,
          weightSource: "Unknown",
          weightMeasuredAt: null,
          townHall: 15,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: null,
            sortOrder: 0,
          },
        },
      ],
      totalSignupCount: 3,
    } as any);
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 1,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 1,
        currentRound: null,
      },
    ]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 1,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-20T12:00:00.000Z"),
      startTime: new Date("2026-04-21T12:00:00.000Z"),
      endTime: new Date("2026-04-22T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-20T00:00:00.000Z"),
      members: [
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#PYLQ0289",
          roundDay: 1,
          playerName: "Alpha Prime",
          mapPosition: 1,
          townHall: 17,
          attacksUsed: 0,
          attacksAvailable: 0,
          stars: 0,
          destruction: 0,
          subbedIn: true,
          subbedOut: false,
        },
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#QGRJ2222",
          roundDay: 1,
          playerName: "Bravo",
          mapPosition: 2,
          townHall: 15,
          attacksUsed: 0,
          attacksAvailable: 0,
          stars: 0,
          destruction: 0,
          subbedIn: true,
          subbedOut: false,
        },
      ],
    });

    const result = await cwlRotationService.createPlanFromRoster({
      clanTag: "#2QG2C08UP",
      rosterId: "roster-2",
      guildId: "guild-1",
      season: "2026-04",
    });

    expect(result.outcome).toBe("created");
    expect(txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data.map((row: any) => row.playerTag)).toEqual([
      "#PYLQ0289",
      "#QGRJ2222",
    ]);
    expect(txMock.cwlRotationPlanMember.createMany.mock.calls[0]?.[0]?.data.map((row: any) => row.playerName)).toEqual([
      "Alpha Prime",
      "Bravo",
    ]);
  });

  it("filters overview to tracked clans before leadership refresh, state lookups, and validation", async () => {
    const trackedPlan = {
      id: "plan-tracked",
      eventInstanceId: "event-current",
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 6,
      isActive: true,
      metadata: {
        source: "manual",
        clanName: "Rising Thrones",
      },
    } as any;
    const stalePlan = {
      id: "plan-stale",
      eventInstanceId: "event-stale",
      clanTag: "#9GLGQCCU",
      season: "2026-04",
      version: 2,
      isActive: true,
      metadata: {
        source: "manual",
        clanName: "Old Clan",
      },
    } as any;
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Rising Thrones" } as any,
    ]);
    prismaMock.cwlRotationPlan.findMany.mockImplementation(async ({ where }: any) => {
      const requestedScopes = new Set<string>(
        ((where?.OR ?? []) as Array<{ clanTag: string; eventInstanceId: string }>).map(
          (scope) => `${scope.eventInstanceId}:${scope.clanTag}`,
        ),
      );
      return [trackedPlan, stalePlan].filter((plan) => requestedScopes.has(`${plan.eventInstanceId}:${plan.clanTag}`));
    });
    const refreshSpy = vi
      .spyOn(FwaClanMembersSyncService.prototype, "refreshCurrentClanMembersForClanTags")
      .mockResolvedValue({
        clanCount: 1,
        rowCount: 1,
        changedRowCount: 1,
        failedClans: [],
      });
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#AAA",
        playerName: "Alpha",
        role: "leader",
      },
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#BBB",
        playerName: "Bravo",
        role: "coLeader",
      },
    ]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockImplementation(async ({ clanTag }) => {
      if (clanTag !== "#2QG2C08UP") {
        throw new Error(`unexpected current round lookup for ${clanTag}`);
      }
      return {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Thrones",
        roundDay: 2,
        roundState: "preparation",
        opponentTag: "#OPP1",
        opponentName: "Opponent One",
        teamSize: 15,
        attacksPerMember: 1,
        preparationStartTime: new Date("2026-04-03T12:00:00.000Z"),
        startTime: new Date("2026-04-03T12:00:00.000Z"),
        endTime: new Date("2026-04-04T12:00:00.000Z"),
        sourceUpdatedAt: new Date("2026-04-03T00:00:00.000Z"),
        members: [],
      };
    });
    vi.spyOn(cwlRotationService, "getPreferredDisplayDay").mockImplementation(async ({ clanTag }) => {
      if (clanTag !== "#2QG2C08UP") {
        throw new Error(`unexpected preferred day lookup for ${clanTag}`);
      }
      return 2;
    });
    vi.spyOn(cwlRotationService, "validatePlanDay").mockImplementation(async ({ clanTag }) => {
      if (clanTag !== "#2QG2C08UP") {
        throw new Error(`unexpected validation lookup for ${clanTag}`);
      }
      return {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        roundDay: 2,
        plannedPlayerTags: ["#AAA"],
        plannedPlayerNames: ["Alpha"],
        actualPlayerTags: ["#AAA"],
        actualPlayerNames: ["Alpha"],
        missingExpectedPlayerTags: [],
        extraActualPlayerTags: [],
        complete: true,
        actualAvailable: true,
        currentState: "preparation",
      };
    });

    const overview = await cwlRotationService.listOverview({
      season: "2026-04",
      refreshLeadershipMembers: true,
    });

    expect(prismaMock.cwlRotationPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          season: "2026-04",
          isActive: true,
          OR: [{ clanTag: "#2QG2C08UP", eventInstanceId: "event-current" }],
        }),
      }),
    );
    expect(refreshSpy).toHaveBeenCalledWith(["#2QG2C08UP"]);
    expect(overview).toEqual([
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        clanName: "Rising Thrones",
        roundDay: 2,
        status: "complete",
      }),
    ]);
    expect(cwlStateService.getCurrentRoundForClan).toHaveBeenCalledTimes(1);
    expect(cwlRotationService.getPreferredDisplayDay).toHaveBeenCalledTimes(1);
    expect(cwlRotationService.validatePlanDay).toHaveBeenCalledTimes(1);
  });

  it("returns null for an untracked clan drilldown even when an active plan row exists", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Rising Thrones" } as any,
    ]);
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValue({
      id: "plan-stale",
      clanTag: "#9GLGQCCU",
      season: "2026-04",
      version: 4,
      isActive: true,
      warningSummary: null,
      excludedPlayerTags: [],
      metadata: {},
    } as any);

    const view = await cwlRotationService.getActivePlanView({
      season: "2026-04",
      clanTag: "#9GLGQCCU",
    });

    expect(view).toBeNull();
    expect(prismaMock.cwlRotationPlan.findFirst).not.toHaveBeenCalled();
  });

  it("rejects roster-backed create when the confirmed group has no usable signups", async () => {
    vi.spyOn(rosterService, "getRosterView").mockResolvedValue({
      roster: {
        id: "roster-3",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha roster",
        clanTag: "#2QG2C08UP",
        startsAt: null,
        endsAt: null,
        timezone: "UTC",
        displayTimezone: "UTC",
        maxMembers: 2,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: null,
      groups: [
        {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: null,
          sortOrder: 0,
        },
      ],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-3",
          groupId: "group-substitute",
          playerTag: "#PYLQ0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          weight: 100_000,
          weightSource: "Manual",
          weightMeasuredAt: new Date("2026-04-20T01:00:00.000Z"),
          townHall: 16,
          discordDisplayName: null,
          discordUsername: null,
          clanTag: null,
          clanName: null,
          group: {
            id: "group-substitute",
            key: "substitute",
            name: "Substitute",
            description: null,
            sortOrder: 1,
          },
        },
      ],
      totalSignupCount: 1,
    } as any);

    const result = await cwlRotationService.createPlanFromRoster({
      clanTag: "#2QG2C08UP",
      rosterId: "roster-3",
      guildId: "guild-1",
      season: "2026-04",
    });

    expect(result).toEqual({
      outcome: "no_confirmed_players",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      rosterId: "roster-3",
      rosterTitle: "CWL Alpha roster",
    });
    expect(txMock.cwlRotationPlan.create).not.toHaveBeenCalled();
  });

  it("validates mismatches when the actual lineup differs from the planned lineup", async () => {
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValue({
      id: "plan-1",
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 2,
      isActive: true,
    });
    prismaMock.cwlRotationPlanDay.findMany.mockResolvedValue([
      {
        roundDay: 3,
        lineupSize: 2,
        members: [
          { playerTag: "#PYLQ0289", playerName: "Alpha", assignmentOrder: 0 },
          { playerTag: "#QGRJ2222", playerName: "Bravo", assignmentOrder: 1 },
        ],
      },
    ]);
    vi.spyOn(cwlStateService, "getActualLineupForDay").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 3,
      roundState: "inWar",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      phaseEndsAt: new Date("2026-04-03T12:00:00.000Z"),
      members: [
        {
          playerTag: "#PYLQ0289",
          playerName: "Alpha",
          mapPosition: 1,
          townHall: 16,
          attacksUsed: 1,
          attacksAvailable: 1,
          subbedIn: true,
          subbedOut: false,
        },
        {
          playerTag: "#CUV9082",
          playerName: "Charlie",
          mapPosition: 2,
          townHall: 15,
          attacksUsed: 0,
          attacksAvailable: 1,
          subbedIn: true,
          subbedOut: false,
        },
      ],
    });

    const result = await cwlRotationService.validatePlanDay({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      roundDay: 3,
    });

    expect(result).toMatchObject({
      complete: false,
      actualAvailable: true,
      missingExpectedPlayerTags: ["#QGRJ2222"],
      extraActualPlayerTags: ["#CUV9082"],
      currentState: "inWar",
    });
  });

  it("validates the next-day preparation lineup against the planned roster", async () => {
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValue({
      id: "plan-1",
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 2,
      isActive: true,
    });
    prismaMock.cwlRotationPlanDay.findMany.mockResolvedValue([
      {
        roundDay: 4,
        lineupSize: 2,
        members: [
          { playerTag: "#PYLQ0289", playerName: "Alpha", assignmentOrder: 0 },
          { playerTag: "#QGRJ2222", playerName: "Bravo", assignmentOrder: 1 },
        ],
      },
    ]);
    vi.spyOn(cwlStateService, "getActualLineupForDay").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 4,
      roundState: "preparation",
      opponentTag: "#OPP2",
      opponentName: "Opponent Two",
      phaseEndsAt: new Date("2026-04-04T12:00:00.000Z"),
      members: [
        {
          playerTag: "#PYLQ0289",
          playerName: "Alpha",
          mapPosition: 1,
          townHall: 16,
          attacksUsed: 0,
          attacksAvailable: 0,
          subbedIn: true,
          subbedOut: false,
        },
        {
          playerTag: "#CUV9082",
          playerName: "Charlie",
          mapPosition: 2,
          townHall: 15,
          attacksUsed: 0,
          attacksAvailable: 0,
          subbedIn: true,
          subbedOut: false,
        },
      ],
    });

    const result = await cwlRotationService.validatePlanDay({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      roundDay: 4,
    });

    expect(result).toMatchObject({
      complete: false,
      actualAvailable: true,
      missingExpectedPlayerTags: ["#QGRJ2222"],
      extraActualPlayerTags: ["#CUV9082"],
      currentState: "preparation",
    });
  });

  it("includes leadership names and battle-day timestamps in overview entries", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Rising Thrones" } as any,
    ]);
    prismaMock.cwlRotationPlan.findMany.mockResolvedValue([
      {
        id: "plan-1",
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 2,
        isActive: true,
      },
    ]);
    const refreshSpy = vi
      .spyOn(FwaClanMembersSyncService.prototype, "refreshCurrentClanMembersForClanTags")
      .mockResolvedValue({
        clanCount: 1,
        rowCount: 3,
        changedRowCount: 3,
        failedClans: [],
      });
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#AAA",
        playerName: "Alpha",
        role: "leader",
      },
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#BBB",
        playerName: "Charlie",
        role: "coLeader",
      },
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#CCC",
        playerName: "Bravo",
        role: "coLeader",
      },
    ]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 2,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-03T12:00:00.000Z"),
      startTime: new Date("2026-04-03T12:00:00.000Z"),
      endTime: new Date("2026-04-04T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-03T00:00:00.000Z"),
      members: [],
    });
    vi.spyOn(cwlRotationService, "getPreferredDisplayDay").mockResolvedValue(2);
    vi.spyOn(cwlStateService, "getBattleDayStartForClanDay").mockResolvedValue(
      new Date("2026-04-03T12:00:00.000Z"),
    );
    vi.spyOn(cwlRotationService, "validatePlanDay").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      roundDay: 2,
      plannedPlayerTags: ["#AAA"],
      plannedPlayerNames: ["Alpha"],
      actualPlayerTags: ["#AAA"],
      actualPlayerNames: ["Alpha"],
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      complete: true,
      actualAvailable: true,
      currentState: "preparation",
    });

    const overview = await cwlRotationService.listOverview({
      season: "2026-04",
      refreshLeadershipMembers: true,
    });
    expect(refreshSpy).toHaveBeenCalledWith(["#2QG2C08UP"]);
    expect(overview).toEqual([
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        roundDay: 2,
        battleDayStartAt: new Date("2026-04-03T12:00:00.000Z"),
        leaderNames: ["Alpha", "Bravo", "Charlie"],
        status: "complete",
      }),
    ]);
  });

  it("falls back to unknown leadership names when targeted refresh fails", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Rising Thrones" } as any,
    ]);
    prismaMock.cwlRotationPlan.findMany.mockResolvedValue([
      {
        id: "plan-1",
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 2,
        isActive: true,
      },
    ]);
    vi.spyOn(FwaClanMembersSyncService.prototype, "refreshCurrentClanMembersForClanTags").mockResolvedValue({
      clanCount: 1,
      rowCount: 0,
      changedRowCount: 0,
      failedClans: ["#2QG2C08UP"],
    });
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#AAA",
        playerName: "Alpha",
        role: "leader",
      },
    ]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 2,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-03T12:00:00.000Z"),
      startTime: new Date("2026-04-03T12:00:00.000Z"),
      endTime: new Date("2026-04-04T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-03T00:00:00.000Z"),
      members: [],
    });
    vi.spyOn(cwlRotationService, "getPreferredDisplayDay").mockResolvedValue(2);
    vi.spyOn(cwlStateService, "getBattleDayStartForClanDay").mockResolvedValue(
      new Date("2026-04-03T12:00:00.000Z"),
    );
    vi.spyOn(cwlRotationService, "validatePlanDay").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      roundDay: 2,
      plannedPlayerTags: ["#AAA"],
      plannedPlayerNames: ["Alpha"],
      actualPlayerTags: ["#AAA"],
      actualPlayerNames: ["Alpha"],
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      complete: true,
      actualAvailable: true,
      currentState: "preparation",
    });

    const overview = await cwlRotationService.listOverview({
      season: "2026-04",
      refreshLeadershipMembers: true,
    });
    expect(overview).toEqual([
      expect.objectContaining({
        leaderNames: [],
      }),
    ]);
  });

  it("returns clan-scoped leadership names from persisted current clan members", async () => {
    vi.spyOn(FwaClanMembersSyncService.prototype, "refreshCurrentClanMembersForClanTags").mockResolvedValue({
      clanCount: 1,
      rowCount: 3,
      changedRowCount: 0,
      failedClans: [],
    });
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#AAA",
        playerName: "elle ♡ duck",
        role: "leader",
      },
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#BBB",
        playerName: "sim-fill-void-3",
        role: "coleader",
      },
      {
        clanTag: "#9GLGQCCU",
        playerTag: "#CCC",
        playerName: "Other Clan Leader",
        role: "leader",
      },
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#DDD",
        playerName: "DuskComet",
        role: "coleader",
      },
    ]);

    const leaderNames = await cwlRotationService.listClanLeadershipNames({
      clanTag: "#2QG2C08UP",
      refreshLeadershipMembers: true,
    });

    expect(leaderNames).toEqual(["elle ♡ duck", "DuskComet", "sim-fill-void-3"]);
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledWith({
      where: {
        clanTag: { in: ["#2QG2C08UP"] },
        role: { not: null },
      },
      select: {
        clanTag: true,
        playerTag: true,
        playerName: true,
        role: true,
      },
      orderBy: [
        { clanTag: "asc" },
        { role: "asc" },
        { playerName: "asc" },
        { playerTag: "asc" },
      ],
    });
    expect(FwaClanMembersSyncService.prototype.refreshCurrentClanMembersForClanTags).toHaveBeenCalledWith([
      "#2QG2C08UP",
    ]);
  });

  it("allows create during overlap, uses the battle lineup as the seed, and locks the battle day", async () => {
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 3,
      roundState: "inWar",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-03T12:00:00.000Z"),
      startTime: new Date("2026-04-04T12:00:00.000Z"),
      endTime: new Date("2026-04-05T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: [
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#PYLQ0289",
          roundDay: 3,
          playerName: "Alpha",
          mapPosition: 1,
          townHall: 16,
          attacksUsed: 1,
          attacksAvailable: 1,
          stars: 3,
          destruction: 100,
          subbedIn: true,
          subbedOut: false,
        },
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#QGRJ2222",
          roundDay: 3,
          playerName: "Bravo",
          mapPosition: 2,
          townHall: 15,
          attacksUsed: 0,
          attacksAvailable: 1,
          stars: 0,
          destruction: 0,
          subbedIn: true,
          subbedOut: false,
        },
      ],
    });
    vi.spyOn(cwlStateService, "getCurrentPreparationSnapshotForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 4,
      roundState: "preparation",
      opponentTag: "#OPP2",
      opponentName: "Opponent Two",
      preparationStartTime: new Date("2026-04-04T12:00:00.000Z"),
      startTime: new Date("2026-04-05T12:00:00.000Z"),
      endTime: new Date("2026-04-06T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: [],
    });
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 3,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 1,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#CUV9082",
        playerName: "Charlie",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
    ]);

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
    });

    expect(result.outcome).toBe("created");
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          generatedFromRoundDay: 3,
          metadata: expect.objectContaining({
            createdFromRoundState: "inWar",
            hasOverlapPreparation: true,
            currentLineupTags: ["#PYLQ0289", "#QGRJ2222"],
          }),
        }),
      }),
    );
    expect(txMock.cwlRotationPlanDay.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          roundDay: 3,
          locked: true,
        }),
      }),
    );
  });

  it("persists live CWL source positions from the current lineup map order", async () => {
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 2,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-04-02T12:00:00.000Z"),
      startTime: new Date("2026-04-03T12:00:00.000Z"),
      endTime: new Date("2026-04-04T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-02T00:00:00.000Z"),
      members: [
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#PYLQ0289",
          roundDay: 2,
          playerName: "Alpha",
          mapPosition: 10,
          townHall: 16,
          attacksUsed: 0,
          attacksAvailable: 0,
          stars: 0,
          destruction: 0,
          subbedIn: true,
          subbedOut: false,
        },
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#QGRJ2222",
          roundDay: 2,
          playerName: "Bravo",
          mapPosition: 20,
          townHall: 15,
          attacksUsed: 0,
          attacksAvailable: 0,
          stars: 0,
          destruction: 0,
          subbedIn: true,
          subbedOut: false,
        },
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          playerTag: "#CUV9082",
          roundDay: 2,
          playerName: "Charlie",
          mapPosition: 30,
          townHall: 15,
          attacksUsed: 0,
          attacksAvailable: 0,
          stars: 0,
          destruction: 0,
          subbedIn: true,
          subbedOut: false,
        },
      ],
    });
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#CUV9082",
        playerName: "Charlie",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
    ]);

    const result = await cwlRotationService.createPlan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
    });

    expect(result.outcome).toBe("created");
    expect(txMock.cwlRotationPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            rosterRows: [
              expect.objectContaining({
                playerTag: "#PYLQ0289",
                sourcePosition: 10,
              }),
              expect.objectContaining({
                playerTag: "#QGRJ2222",
                sourcePosition: 20,
              }),
              expect.objectContaining({
                playerTag: "#CUV9082",
                sourcePosition: 30,
              }),
            ],
          }),
        }),
      }),
    );
  });

  it("prefers the prep snapshot day in overview during overlap", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Rising Thrones" } as any,
    ]);
    prismaMock.cwlRotationPlan.findMany.mockResolvedValue([
      {
        id: "plan-1",
        clanTag: "#2QG2C08UP",
        season: "2026-04",
        version: 2,
        isActive: true,
      },
    ]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 3,
      roundState: "inWar",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: null,
      startTime: new Date("2026-04-03T12:00:00.000Z"),
      endTime: new Date("2026-04-04T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-03T00:00:00.000Z"),
      members: [],
    });
    vi.spyOn(cwlStateService, "getCurrentPreparationSnapshotForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 4,
      roundState: "preparation",
      opponentTag: "#OPP2",
      opponentName: "Opponent Two",
      preparationStartTime: null,
      startTime: new Date("2026-04-04T12:00:00.000Z"),
      endTime: new Date("2026-04-05T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-04T00:00:00.000Z"),
      members: [],
    });
    vi.spyOn(cwlRotationService, "validatePlanDay").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      roundDay: 4,
      plannedPlayerTags: ["#PYLQ0289"],
      plannedPlayerNames: ["Alpha"],
      actualPlayerTags: ["#PYLQ0289"],
      actualPlayerNames: ["Alpha"],
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      complete: true,
      actualAvailable: true,
      currentState: "preparation",
    });

    const overview = await cwlRotationService.listOverview({ season: "2026-04" });

    expect(overview).toEqual([
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        roundDay: 4,
        status: "complete",
      }),
    ]);
    expect(cwlRotationService.validatePlanDay).toHaveBeenCalledWith({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      roundDay: 4,
    });
  });

  it("shows subbed-out members when a create-backed schedule includes them elsewhere and they were not excluded", () => {
    const visibleRows = cwlRotationService.getVisibleRotationShowDayRows({
      excludedPlayerTags: ["#CUV02898"],
      days: [
        {
          rows: [
            { playerTag: "#PYLQ0289", playerName: "Active One", subbedOut: false, assignmentOrder: 0 },
            { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: true, assignmentOrder: 1 },
            { playerTag: "#CUV02898", playerName: "Excluded", subbedOut: true, assignmentOrder: 2 },
            { playerTag: "#JQJQ2222", playerName: "Never", subbedOut: true, assignmentOrder: 3 },
          ],
        },
        {
          rows: [
            { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: false, assignmentOrder: 0 },
            { playerTag: "#PYLQ0289", playerName: "Active One", subbedOut: false, assignmentOrder: 1 },
          ],
        },
      ],
      day: {
        rows: [
          { playerTag: "#PYLQ0289", playerName: "Active One", subbedOut: false, assignmentOrder: 0 },
          { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: true, assignmentOrder: 1 },
          { playerTag: "#CUV02898", playerName: "Excluded", subbedOut: true, assignmentOrder: 2 },
          { playerTag: "#JQJQ2222", playerName: "Never", subbedOut: true, assignmentOrder: 3 },
        ],
      },
    });

    expect(visibleRows).toEqual([
      { playerTag: "#PYLQ0289", playerName: "Active One", subbedOut: false, assignmentOrder: 0 },
      { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: true, assignmentOrder: 1 },
    ]);
  });

  it("shows imported subbed-out members only when they are scheduled in somewhere in the effective plan", () => {
    const visibleRows = cwlRotationService.getVisibleRotationShowDayRows({
      excludedPlayerTags: [],
      days: [
        {
          rows: [
            { playerTag: "#PYLQ0289", playerName: "Active One", subbedOut: false, assignmentOrder: 0 },
            { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: true, assignmentOrder: 1 },
            { playerTag: "#JQJQ2222", playerName: "Never", subbedOut: true, assignmentOrder: 2 },
          ],
        },
        {
          rows: [
            { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: false, assignmentOrder: 0 },
          ],
        },
      ],
      day: {
        rows: [
          { playerTag: "#PYLQ0289", playerName: "Active One", subbedOut: false, assignmentOrder: 0 },
          { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: true, assignmentOrder: 1 },
          { playerTag: "#JQJQ2222", playerName: "Never", subbedOut: true, assignmentOrder: 2 },
        ],
      },
    });

    expect(visibleRows).toEqual([
      { playerTag: "#PYLQ0289", playerName: "Active One", subbedOut: false, assignmentOrder: 0 },
      { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: true, assignmentOrder: 1 },
    ]);
  });
});
