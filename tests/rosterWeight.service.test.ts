import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  roster: {
    findUnique: vi.fn(),
  },
  rosterSignup: {
    findFirst: vi.fn(),
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

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.upsert.mockResolvedValue({} as never);
    prismaMock.externalPlayerWeightCurrent.deleteMany.mockResolvedValue({ count: 0 });
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
      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
        {
          playerTag: "#PQL0289",
          weight: 145000,
          trophies: 5200,
          sourceSyncedAt: new Date("2026-04-22T10:00:00.000Z"),
        },
        {
          playerTag: "#QGRJ2222",
          weight: null,
          trophies: 5400,
          sourceSyncedAt: new Date("2026-04-22T08:00:00.000Z"),
        },
      ]);
      prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([
        {
          playerTag: "#PQL0289",
          weight: 160000,
          measuredAt: new Date("2026-04-21T09:00:00.000Z"),
        },
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
        trophies: 5200,
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
});
