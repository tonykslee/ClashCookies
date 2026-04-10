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

import {
  CompoWarStateService,
  findHeatMapRefForWeightForTest,
} from "../src/services/CompoWarStateService";

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
    totalRawWeight: input.totalEffectiveWeight ?? 8_100_000,
    totalEffectiveWeight:
      input.totalEffectiveWeight === undefined ? 8_100_000 : input.totalEffectiveWeight,
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

function makeHeatMapRef(input?: {
  weightMinInclusive?: number;
  weightMaxInclusive?: number;
  th18Count?: number;
  th17Count?: number;
  th16Count?: number;
  th15Count?: number;
  th14Count?: number;
  th13Count?: number;
  th12Count?: number;
  th11Count?: number;
  th10OrLowerCount?: number;
}) {
  return {
    weightMinInclusive: input?.weightMinInclusive ?? 8_000_001,
    weightMaxInclusive: input?.weightMaxInclusive ?? 8_100_000,
    th18Count: input?.th18Count ?? 19,
    th17Count: input?.th17Count ?? 11,
    th16Count: input?.th16Count ?? 7,
    th15Count: input?.th15Count ?? 6,
    th14Count: input?.th14Count ?? 4,
    th13Count: input?.th13Count ?? 2,
    th12Count: input?.th12Count ?? 1,
    th11Count: input?.th11Count ?? 0,
    th10OrLowerCount: input?.th10OrLowerCount ?? 0,
    sourceVersion: "bootstrap-2026-03-17",
    refreshedAt: new Date("2026-03-17T00:00:00.000Z"),
  };
}

describe("CompoWarStateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds DB-backed mode:war rows with corrected HeatMapRef band targets", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha Clan-war" }]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeParent({
        clanTag: "#AAA111",
        clanName: "Alpha Clan-war",
        totalEffectiveWeight: 8_100_000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      ...Array.from({ length: 19 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: index + 1, townHall: 18 }),
      ),
      ...Array.from({ length: 11 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: 20 + index, townHall: 17 }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: 31 + index, townHall: 16 }),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: 38 + index, townHall: 15 }),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: 44 + index, townHall: 14 }),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        makeMember({ clanTag: "#AAA111", position: 48 + index, townHall: 13 }),
      ),
      makeMember({ clanTag: "#AAA111", position: 50, townHall: 12 }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoWarStateService({ runTracked: vi.fn() } as any).readState();

    expect(result.renderableClanTags).toEqual(["#AAA111"]);
    expect(result.trackedClanTags).toEqual(["#AAA111"]);
    expect(result.stateRows).toEqual([
      ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
      ["Alpha Clan", "8,100,000", "0", "50", "0", "0", "0", "0", "0", "0"],
    ]);
    expect(result.contentLines[0]).toBe("Mode Displayed: **WAR**");
    expect(result.contentLines[1]).toContain("Persisted WAR data last refreshed");
  });

  it("resolves corrected HeatMapRef bands at representative totals and boundaries", () => {
    const refs = [
      makeHeatMapRef({
        weightMinInclusive: 7_300_001,
        weightMaxInclusive: 7_400_000,
      }),
      makeHeatMapRef({
        weightMinInclusive: 7_400_001,
        weightMaxInclusive: 7_500_000,
      }),
      makeHeatMapRef({
        weightMinInclusive: 7_600_001,
        weightMaxInclusive: 7_700_000,
        th18Count: 10,
        th17Count: 9,
      }),
      makeHeatMapRef({
        weightMinInclusive: 8_000_001,
        weightMaxInclusive: 8_100_000,
      }),
      makeHeatMapRef({
        weightMinInclusive: 8_110_000,
        weightMaxInclusive: 9_999_999,
        th18Count: 22,
        th17Count: 11,
      }),
    ];

    expect(findHeatMapRefForWeightForTest(refs, 7_429_000)).toMatchObject({
      weightMinInclusive: 7_400_001,
      weightMaxInclusive: 7_500_000,
    });
    expect(findHeatMapRefForWeightForTest(refs, 7_659_000)).toMatchObject({
      weightMinInclusive: 7_600_001,
      weightMaxInclusive: 7_700_000,
    });
    expect(findHeatMapRefForWeightForTest(refs, 8_100_000)).toMatchObject({
      weightMinInclusive: 8_000_001,
      weightMaxInclusive: 8_100_000,
    });
    expect(findHeatMapRefForWeightForTest(refs, 8_110_000)).toMatchObject({
      weightMinInclusive: 8_110_000,
      weightMaxInclusive: 9_999_999,
    });
  });

  it("returns honest no-renderable output when roster size is below 50", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha Clan" }]);
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
        totalEffectiveWeight: 8_100_001,
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
      .mockResolvedValueOnce([makeParent({ clanTag: "#AAA111", clanName: "Alpha Clan" })])
      .mockResolvedValueOnce([makeParent({ clanTag: "#AAA111", clanName: "Alpha Clan" })]);
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
