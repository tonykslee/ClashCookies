import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
  heatMapRef: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { CompoWarStateService } from "../src/services/CompoWarStateService";

function makeParent(input: {
  clanTag: string;
  clanName: string;
  rosterSize?: number;
  totalEffectiveWeight?: number | null;
  hasUnresolvedWeights?: boolean;
  sourceUpdatedAt?: Date | null;
  observedAt?: Date;
}) {
  return {
    clanTag: input.clanTag,
    clanName: input.clanName,
    opponentTag: null,
    opponentName: null,
    rosterSize: input.rosterSize ?? 50,
    totalRawWeight: 7_000_000,
    totalEffectiveWeight:
      input.totalEffectiveWeight === undefined ? 7_000_000 : input.totalEffectiveWeight,
    hasUnresolvedWeights: input.hasUnresolvedWeights ?? false,
    observedAt: input.observedAt ?? new Date("2026-04-10T17:00:00.000Z"),
    sourceUpdatedAt:
      input.sourceUpdatedAt === undefined
        ? new Date("2026-04-10T16:00:00.000Z")
        : input.sourceUpdatedAt,
    createdAt: new Date("2026-04-10T15:00:00.000Z"),
    updatedAt: new Date("2026-04-10T17:00:00.000Z"),
  };
}

function makeMember(input: {
  clanTag: string;
  position: number;
  townHall: number;
  rawWeight?: number;
}) {
  return {
    clanTag: input.clanTag,
    position: input.position,
    playerTag: `#P${input.position}`,
    playerName: `Player ${input.position}`,
    townHall: input.townHall,
    rawWeight: input.rawWeight ?? 140000,
    effectiveWeight: input.rawWeight === 0 ? 145000 : input.rawWeight ?? 140000,
    effectiveWeightStatus: input.rawWeight === 0 ? "FILLED_FROM_LOWER_BLOCK" : "RAW",
    opponentTag: null,
    opponentName: null,
    createdAt: new Date("2026-04-10T15:00:00.000Z"),
    updatedAt: new Date("2026-04-10T17:00:00.000Z"),
  };
}

function makeHeatMapRef() {
  return {
    weightMinInclusive: 6_900_000,
    weightMaxInclusive: 7_100_000,
    th18Count: 1,
    th17Count: 2,
    th16Count: 3,
    th15Count: 4,
    th14Count: 5,
    th13Count: 6,
    th12Count: 7,
    th11Count: 8,
    th10OrLowerCount: 14,
    sourceVersion: "seed",
    refreshedAt: new Date("2026-04-10T00:00:00.000Z"),
  };
}

describe("CompoWarStateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds DB-backed mode:war rows with TH deltas from persisted roster + HeatMapRef", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha Clan-war" },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeParent({ clanTag: "#AAA111", clanName: "Alpha Clan-war" }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", position: 1, townHall: 18 }),
      makeMember({ clanTag: "#AAA111", position: 2, townHall: 17 }),
      makeMember({ clanTag: "#AAA111", position: 3, townHall: 17 }),
      makeMember({ clanTag: "#AAA111", position: 4, townHall: 16 }),
      makeMember({ clanTag: "#AAA111", position: 5, townHall: 16 }),
      makeMember({ clanTag: "#AAA111", position: 6, townHall: 16 }),
      makeMember({ clanTag: "#AAA111", position: 7, townHall: 15 }),
      makeMember({ clanTag: "#AAA111", position: 8, townHall: 15 }),
      makeMember({ clanTag: "#AAA111", position: 9, townHall: 15 }),
      makeMember({ clanTag: "#AAA111", position: 10, townHall: 15 }),
      makeMember({ clanTag: "#AAA111", position: 11, townHall: 14 }),
      makeMember({ clanTag: "#AAA111", position: 12, townHall: 14 }),
      makeMember({ clanTag: "#AAA111", position: 13, townHall: 14 }),
      makeMember({ clanTag: "#AAA111", position: 14, townHall: 14 }),
      makeMember({ clanTag: "#AAA111", position: 15, townHall: 14 }),
      ...Array.from({ length: 6 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: 16 + index, townHall: 13 }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: 22 + index, townHall: 12 }),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: 29 + index, townHall: 11 }),
      ),
      ...Array.from({ length: 14 }, (_, index) =>
        makeMember({
          clanTag: "#AAA111",
          position: 37 + index,
          townHall: 10,
          rawWeight: index === 0 ? 0 : 135000,
        }),
      ),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoWarStateService({ runTracked: vi.fn() } as any).readState();

    expect(result.renderableClanTags).toEqual(["#AAA111"]);
    expect(result.trackedClanTags).toEqual(["#AAA111"]);
    expect(result.stateRows).toEqual([
      ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
      ["Alpha Clan", "7,000,000", "1", "50", "0", "0", "0", "0", "0", "0"],
    ]);
    expect(result.contentLines[0]).toBe("Mode Displayed: **WAR**");
    expect(result.contentLines[1]).toContain("Persisted WAR data last refreshed");
  });

  it("returns honest no-renderable output when roster size is below 50", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha Clan" },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeParent({ clanTag: "#AAA111", clanName: "Alpha Clan", rosterSize: 45 }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue(
      Array.from({ length: 45 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: index + 1, townHall: 14 }),
      ),
    );
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoWarStateService({ runTracked: vi.fn() } as any).readState();

    expect(result.stateRows).toBeNull();
    expect(result.trackedClanTags).toEqual(["#AAA111"]);
    expect(result.contentLines.join("\n")).toContain("roster size 45/50");
    expect(result.contentLines.join("\n")).toContain(
      "No DB-backed WAR roster snapshots are currently renderable.",
    );
  });

  it("rejects unresolved or missing-band snapshots instead of rendering bad data", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha Clan" },
      { tag: "#BBB222", name: "Bravo Clan" },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeParent({
        clanTag: "#AAA111",
        clanName: "Alpha Clan",
        hasUnresolvedWeights: true,
      }),
      makeParent({
        clanTag: "#BBB222",
        clanName: "Bravo Clan",
        totalEffectiveWeight: 8_500_001,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      ...Array.from({ length: 50 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: index + 1, townHall: 14 }),
      ),
      ...Array.from({ length: 50 }, (_, index) =>
        makeMember({ clanTag: "#BBB222", position: index + 1, townHall: 14 }),
      ),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoWarStateService({ runTracked: vi.fn() } as any).readState();

    expect(result.stateRows).toBeNull();
    expect(result.trackedClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.contentLines.join("\n")).toContain("Alpha Clan (unresolved effective weights)");
    expect(result.contentLines.join("\n")).toContain("Bravo Clan (missing HeatMapRef band)");
  });

  it("refreshes only tracked-clan war-roster scopes through the feed-backed path", async () => {
    const runTracked = vi.fn().mockResolvedValue({});
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha Clan" },
      { tag: "#BBB222", name: "Bravo Clan" },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany
      .mockResolvedValueOnce([
        makeParent({ clanTag: "#AAA111", clanName: "Alpha Clan" }),
      ])
      .mockResolvedValueOnce([
        makeParent({ clanTag: "#AAA111", clanName: "Alpha Clan" }),
      ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany
      .mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, index) =>
          makeMember({ clanTag: "#AAA111", position: index + 1, townHall: 14 }),
        ),
      )
      .mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, index) =>
          makeMember({ clanTag: "#AAA111", position: index + 1, townHall: 14 }),
        ),
      );
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    await new CompoWarStateService({ runTracked } as any).refreshState();

    expect(runTracked).toHaveBeenCalledTimes(2);
    expect(runTracked).toHaveBeenCalledWith("war-roster", "#AAA111");
    expect(runTracked).toHaveBeenCalledWith("war-roster", "#BBB222");
  });
});
