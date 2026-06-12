import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  roster: {
    findUnique: vi.fn(),
  },
  rosterSignup: {
    findFirst: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  externalPlayerWeightCurrent: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

const playerCurrentServiceMock = vi.hoisted(() => ({
  listPlayerCurrentByTags: vi.fn(),
}));

const defermentServiceMock = vi.hoisted(() => ({
  listOpenDeferredWeightRowsByClanAndPlayerTags: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/WeightInputDefermentService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/WeightInputDefermentService")>(
    "../src/services/WeightInputDefermentService",
  );
  return {
    ...actual,
    listOpenDeferredWeightRowsByClanAndPlayerTags:
      defermentServiceMock.listOpenDeferredWeightRowsByClanAndPlayerTags,
  };
});

vi.mock("../src/services/PlayerCurrentService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/PlayerCurrentService")>(
    "../src/services/PlayerCurrentService",
  );
  return {
    ...actual,
    playerCurrentService: playerCurrentServiceMock,
  };
});

import {
  formatRosterWeightAge,
  parseRosterManageWeightInput,
  resolveRosterCurrentWeightRecords,
  rosterWeightService,
} from "../src/services/RosterWeightService";

describe("RosterWeightService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.roster.findUnique.mockResolvedValue({ id: "roster-1" });
    prismaMock.rosterSignup.findFirst.mockResolvedValue({ playerTag: "#PQL0289" });
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.upsert.mockResolvedValue({} as never);
    prismaMock.externalPlayerWeightCurrent.deleteMany.mockResolvedValue({ count: 0 });
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(new Map());
    defermentServiceMock.listOpenDeferredWeightRowsByClanAndPlayerTags.mockResolvedValue(new Map());
  });

  it("parses accepted manual weight formats", () => {
    expect(parseRosterManageWeightInput("145000")).toBe(145000);
    expect(parseRosterManageWeightInput("145,000")).toBe(145000);
    expect(parseRosterManageWeightInput("145k")).toBe(145000);
    expect(parseRosterManageWeightInput("0")).toBe(0);
  });

  it("rejects non-zero values that do not end in 000", () => {
    expect(parseRosterManageWeightInput("145")).toBeNull();
    expect(parseRosterManageWeightInput("145,500")).toBeNull();
    expect(parseRosterManageWeightInput("145.5k")).toBeNull();
    expect(parseRosterManageWeightInput("-1")).toBeNull();
  });

  it("deletes the manual weight row when the modal input is zero", async () => {
    const result = await rosterWeightService.setManualWeightForRoster({
      rosterId: "roster-1",
      playerTag: "#pql0289",
      weight: 0,
      updatedByUserId: "user-1",
    });

    expect(result).toEqual({
      outcome: "deleted",
      rosterId: "roster-1",
      playerTag: "#PQL0289",
    });
    expect(prismaMock.externalPlayerWeightCurrent.deleteMany).toHaveBeenCalledWith({
      where: { playerTag: "#PQL0289" },
    });
  });

  it("upserts the manual weight row with audit fields and measurement time", async () => {
    const result = await rosterWeightService.setManualWeightForRoster({
      rosterId: "roster-1",
      playerTag: "#PQL0289",
      weight: 145000,
      updatedByUserId: "user-1",
    });

    expect(result.outcome).toBe("saved");
    expect(result.rosterId).toBe("roster-1");
    expect(result.playerTag).toBe("#PQL0289");
    expect(result.weight).toBe(145000);
    expect(result.measuredAt).toBeInstanceOf(Date);
    expect(prismaMock.externalPlayerWeightCurrent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerTag: "#PQL0289" },
        create: expect.objectContaining({
          playerTag: "#PQL0289",
          weight: 145000,
          source: "ROSTER_MANAGE",
          createdByUserId: "user-1",
          updatedByUserId: "user-1",
        }),
        update: expect.objectContaining({
          weight: 145000,
          source: "ROSTER_MANAGE",
          updatedByUserId: "user-1",
        }),
      }),
    );
  });

  it("resolves FWA current weights before manual fallback and exposes weight age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    try {
      prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
        {
          playerTag: "#PQL0289",
          latestKnownWeight: 145000,
          lastSyncedAt: new Date("2026-04-22T10:00:00.000Z"),
        },
      ]);
      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
        {
          playerTag: "#QGRJ2222",
          trophies: 5400,
        },
      ]);
      prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([
        {
          playerTag: "#QGRJ2222",
          weight: 150000,
          measuredAt: new Date("2026-04-21T08:00:00.000Z"),
        },
      ]);

      const resolved = await resolveRosterCurrentWeightRecords({
        playerTags: ["#PQL0289", "#QGRJ2222", "#PQL0288"],
      });

      expect(resolved.get("#PQL0289")).toEqual({
        playerTag: "#PQL0289",
        weight: 145000,
        weightSource: "FWA",
        weightMeasuredAt: new Date("2026-04-22T10:00:00.000Z"),
        trophies: null,
      });
      expect(resolved.get("#QGRJ2222")).toEqual({
        playerTag: "#QGRJ2222",
        weight: 150000,
        weightSource: "Manual",
        weightMeasuredAt: new Date("2026-04-21T08:00:00.000Z"),
        trophies: 5400,
      });
      expect(resolved.get("#PQL0288")).toEqual({
        playerTag: "#PQL0288",
        weight: null,
        weightSource: "Unknown",
        weightMeasuredAt: null,
        trophies: null,
      });
      expect(formatRosterWeightAge(new Date("2026-04-21T09:00:00.000Z"))).toBe("1d 3h");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the higher of FWA and deferment weights and preserves the deferment timestamp", async () => {
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PL22CGC0",
        latestKnownWeight: 164000,
        lastSyncedAt: new Date("2026-06-04T12:44:51.860Z"),
      },
    ]);
    defermentServiceMock.listOpenDeferredWeightRowsByClanAndPlayerTags.mockResolvedValue(
      new Map([
        [
          "#2JCJYGRCY",
          new Map([
            [
              "#PL22CGC0",
              {
                deferredWeight: 178000,
                createdAt: new Date("2026-06-10T10:04:42.664Z"),
              },
            ],
          ]),
        ],
      ]),
    );

    const resolved = await resolveRosterCurrentWeightRecords({
      playerTags: ["#PL22CGC0"],
      guildId: "1324040917602013261",
      clanTag: "#2JCJYGRCY",
    });

    expect(resolved.get("#PL22CGC0")).toEqual({
      playerTag: "#PL22CGC0",
      weight: 178000,
      weightSource: "WeightInputDeferment",
      weightMeasuredAt: new Date("2026-06-10T10:04:42.664Z"),
      trophies: null,
    });
  });

  it("prefers the higher of FWA and manual weights and keeps FWA on ties", async () => {
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        latestKnownWeight: 145000,
        lastSyncedAt: new Date("2026-04-22T10:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        latestKnownWeight: 150000,
        lastSyncedAt: new Date("2026-04-22T11:00:00.000Z"),
      },
      {
        playerTag: "#LQ9P8R2",
        latestKnownWeight: 150000,
        lastSyncedAt: new Date("2026-04-22T11:30:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        trophies: 5100,
      },
      {
        playerTag: "#QGRJ2222",
        trophies: 5400,
      },
      {
        playerTag: "#LQ9P8R2",
        trophies: 5600,
      },
      {
        playerTag: "#PQL0288",
        trophies: 4800,
      },
    ]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        weight: 150000,
        measuredAt: new Date("2026-04-21T08:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        weight: 145000,
        measuredAt: new Date("2026-04-21T09:00:00.000Z"),
      },
      {
        playerTag: "#LQ9P8R2",
        weight: 150000,
        measuredAt: new Date("2026-04-21T10:00:00.000Z"),
      },
    ]);

    const resolved = await resolveRosterCurrentWeightRecords({
      playerTags: ["#PQL0289", "#QGRJ2222", "#LQ9P8R2", "#PQL0288"],
    });

    expect(resolved.get("#PQL0289")).toEqual({
      playerTag: "#PQL0289",
      weight: 150000,
      weightSource: "Manual",
      weightMeasuredAt: new Date("2026-04-21T08:00:00.000Z"),
      trophies: 5100,
    });
    expect(resolved.get("#QGRJ2222")).toEqual({
      playerTag: "#QGRJ2222",
      weight: 150000,
      weightSource: "FWA",
      weightMeasuredAt: new Date("2026-04-22T11:00:00.000Z"),
      trophies: 5400,
    });
    expect(resolved.get("#LQ9P8R2")).toEqual({
      playerTag: "#LQ9P8R2",
      weight: 150000,
      weightSource: "FWA",
      weightMeasuredAt: new Date("2026-04-22T11:30:00.000Z"),
      trophies: 5600,
    });
    expect(resolved.get("#PQL0288")).toEqual({
      playerTag: "#PQL0288",
      weight: null,
      weightSource: "Unknown",
      weightMeasuredAt: null,
      trophies: 4800,
    });
  });

  it("keeps FWA on a tie with deferment", async () => {
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        latestKnownWeight: 150000,
        lastSyncedAt: new Date("2026-04-22T10:00:00.000Z"),
      },
    ]);
    defermentServiceMock.listOpenDeferredWeightRowsByClanAndPlayerTags.mockResolvedValue(
      new Map([
        [
          "#2QG2C08UP",
          new Map([
            [
              "#PQL0289",
              {
                deferredWeight: 150000,
                createdAt: new Date("2026-04-21T08:00:00.000Z"),
              },
            ],
          ]),
        ],
      ]),
    );

    const resolved = await resolveRosterCurrentWeightRecords({
      playerTags: ["#PQL0289"],
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
    });

    expect(resolved.get("#PQL0289")).toEqual({
      playerTag: "#PQL0289",
      weight: 150000,
      weightSource: "FWA",
      weightMeasuredAt: new Date("2026-04-22T10:00:00.000Z"),
      trophies: null,
    });
  });

  it("falls back to PlayerCurrent shared current weight when FWA and manual sources are missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    try {
      prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
        {
          playerTag: "#QGRJ2222",
          trophies: 5400,
        },
      ]);
      prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([]);
      playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(
        new Map([
          [
            "#QGRJ2222",
            {
              playerTag: "#QGRJ2222",
              currentWeight: 160000,
              currentWeightMeasuredAt: new Date("2026-04-21T08:00:00.000Z"),
            },
          ],
        ]),
      );

      const resolved = await resolveRosterCurrentWeightRecords({
        playerTags: ["#QGRJ2222"],
      });

      expect(resolved.get("#QGRJ2222")).toEqual({
        playerTag: "#QGRJ2222",
        weight: 160000,
        weightSource: "PlayerCurrent",
        weightMeasuredAt: new Date("2026-04-21T08:00:00.000Z"),
        trophies: 5400,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
