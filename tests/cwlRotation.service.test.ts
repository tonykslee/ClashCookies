import { beforeEach, describe, expect, it, vi } from "vitest";

const txMock = vi.hoisted(() => ({
  cwlRotationPlan: {
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
  },
  cwlRotationPlan: {
    findFirst: vi.fn(),
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

    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP" });
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValue(null);
    prismaMock.cwlRotationPlan.findMany.mockResolvedValue([]);
    prismaMock.cwlRotationPlanDay.findMany.mockResolvedValue([]);
    txMock.cwlRotationPlan.updateMany.mockResolvedValue({ count: 0 });
    txMock.cwlRotationPlan.create.mockResolvedValue({ id: "plan-1" });
    txMock.cwlRotationPlanDay.create
      .mockResolvedValueOnce({ id: 101 })
      .mockResolvedValueOnce({ id: 102 })
      .mockResolvedValueOnce({ id: 103 });
    txMock.cwlRotationPlanMember.createMany.mockResolvedValue({ count: 0 });
  });

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
      version: 1,
      lineupSize: 3,
    });
    expect(result.outcome === "created" ? result.warnings[0] : "").toContain(
      "Could not reach 5 planned CWL days",
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
});
