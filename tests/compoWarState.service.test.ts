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
  getCompoWarWeightBucketForTest,
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
  effectiveWeight?: number | null;
}) {
  const rawWeight = input.rawWeight ?? 140000;
  const effectiveWeight =
    input.effectiveWeight === undefined
      ? rawWeight === 0
        ? 145000
        : rawWeight
      : input.effectiveWeight;
  return {
    clanTag: input.clanTag,
    position: input.position,
    playerTag: `#P${input.position}`,
    playerName: `Player ${input.position}`,
    townHall: input.townHall,
    rawWeight,
    effectiveWeight,
    effectiveWeightStatus: rawWeight === 0 ? "FILLED_FROM_LOWER_BLOCK" : "RAW",
    opponentTag: null,
    opponentName: null,
    createdAt: new Date("2026-04-10T15:00:00.000Z"),
    updatedAt: new Date("2026-04-10T17:00:00.000Z"),
  };
}

function makeWeightedMembers(input: {
  clanTag: string;
  counts: {
    th18?: number;
    th17?: number;
    th16?: number;
    th15?: number;
    th14?: number;
    th13?: number;
    th12?: number;
    th11?: number;
    th10?: number;
    th9?: number;
    th8OrLower?: number;
  };
  townHall?: number;
  startPosition?: number;
}) {
  let position = input.startPosition ?? 1;
  const townHall = input.townHall ?? 18;
  const members = [
    ...Array.from({ length: input.counts.th18 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 175000,
        effectiveWeight: 175000,
      }),
    ),
    ...Array.from({ length: input.counts.th17 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 165000,
        effectiveWeight: 165000,
      }),
    ),
    ...Array.from({ length: input.counts.th16 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 155000,
        effectiveWeight: 155000,
      }),
    ),
    ...Array.from({ length: input.counts.th15 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 145000,
        effectiveWeight: 145000,
      }),
    ),
    ...Array.from({ length: input.counts.th14 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 135000,
        effectiveWeight: 135000,
      }),
    ),
    ...Array.from({ length: input.counts.th13 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 125000,
        effectiveWeight: 125000,
      }),
    ),
    ...Array.from({ length: input.counts.th12 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 119000,
        effectiveWeight: 119000,
      }),
    ),
    ...Array.from({ length: input.counts.th11 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 100000,
        effectiveWeight: 100000,
      }),
    ),
    ...Array.from({ length: input.counts.th10 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 80000,
        effectiveWeight: 80000,
      }),
    ),
    ...Array.from({ length: input.counts.th9 ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 65000,
        effectiveWeight: 65000,
      }),
    ),
    ...Array.from({ length: input.counts.th8OrLower ?? 0 }, () =>
      makeMember({
        clanTag: input.clanTag,
        position: position++,
        townHall,
        rawWeight: 55000,
        effectiveWeight: 55000,
      }),
    ),
  ];
  return members;
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

  it("classifies effective-weight boundaries into the expected WAR compo buckets", () => {
    expect(getCompoWarWeightBucketForTest(180000)).toBe("TH18");
    expect(getCompoWarWeightBucketForTest(170000)).toBe("TH17");
    expect(getCompoWarWeightBucketForTest(160000)).toBe("TH16");
    expect(getCompoWarWeightBucketForTest(150000)).toBe("TH15");
    expect(getCompoWarWeightBucketForTest(140000)).toBe("TH14");
    expect(getCompoWarWeightBucketForTest(130000)).toBe("TH13");
    expect(getCompoWarWeightBucketForTest(120000)).toBe("TH12");
    expect(getCompoWarWeightBucketForTest(110000)).toBe("TH11");
    expect(getCompoWarWeightBucketForTest(90000)).toBe("TH10");
    expect(getCompoWarWeightBucketForTest(70000)).toBe("TH9");
    expect(getCompoWarWeightBucketForTest(55000)).toBe("TH8_OR_LOWER");
  });

  it("classifies representative interior effective weights into the expected WAR compo buckets", () => {
    expect(getCompoWarWeightBucketForTest(175000)).toBe("TH18");
    expect(getCompoWarWeightBucketForTest(165000)).toBe("TH17");
    expect(getCompoWarWeightBucketForTest(145000)).toBe("TH15");
    expect(getCompoWarWeightBucketForTest(119000)).toBe("TH12");
    expect(getCompoWarWeightBucketForTest(100000)).toBe("TH11");
    expect(getCompoWarWeightBucketForTest(80000)).toBe("TH10");
    expect(getCompoWarWeightBucketForTest(65000)).toBe("TH9");
    expect(getCompoWarWeightBucketForTest(1000)).toBe("TH8_OR_LOWER");
  });

  it("builds DB-backed mode:war rows from effective-weight buckets with corrected HeatMapRef band targets", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha Clan-war" }]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeParent({
        clanTag: "#AAA111",
        clanName: "Alpha Clan-war",
        totalEffectiveWeight: 8_100_000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      ...makeWeightedMembers({
        clanTag: "#AAA111",
        counts: { th18: 19, th17: 11, th16: 7, th15: 6, th14: 4, th13: 2, th12: 1 },
      }),
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

  it("derives WAR deltas from effective-weight buckets instead of literal town halls", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha Clan-war" }]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeParent({
        clanTag: "#AAA111",
        clanName: "Alpha Clan-war",
        totalEffectiveWeight: 8_100_000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      ...makeWeightedMembers({
        clanTag: "#AAA111",
        townHall: 18,
        counts: { th18: 19, th17: 11, th16: 7, th15: 6, th14: 4, th13: 2, th12: 1 },
      }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoWarStateService({ runTracked: vi.fn() } as any).readState();

    expect(result.stateRows).toEqual([
      ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
      ["Alpha Clan", "8,100,000", "0", "50", "0", "0", "0", "0", "0", "0"],
    ]);
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
      makeWeightedMembers({
        clanTag: "#AAA111",
        counts: { th14: 45 },
      }),
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
      ...makeWeightedMembers({
        clanTag: "#AAA111",
        counts: { th14: 50 },
      }),
      ...makeWeightedMembers({
        clanTag: "#BBB222",
        counts: { th14: 50 },
      }),
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
      .mockResolvedValueOnce(makeWeightedMembers({ clanTag: "#AAA111", counts: { th14: 50 } }))
      .mockResolvedValueOnce(makeWeightedMembers({ clanTag: "#AAA111", counts: { th14: 50 } }));
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    await new CompoWarStateService({ runTracked } as any).refreshState();

    expect(runTracked).toHaveBeenCalledTimes(2);
    expect(runTracked).toHaveBeenCalledWith("war-roster", "#AAA111");
    expect(runTracked).toHaveBeenCalledWith("war-roster", "#BBB222");
  });

  it("collapses TH13-and-lower display deltas from lower effective-weight buckets", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha Clan-war" }]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeParent({
        clanTag: "#AAA111",
        clanName: "Alpha Clan-war",
        totalEffectiveWeight: 8_100_000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      ...makeWeightedMembers({
        clanTag: "#AAA111",
        counts: { th18: 19, th17: 11, th16: 7, th15: 6, th14: 4, th11: 1, th10: 1, th9: 1 },
      }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoWarStateService({ runTracked: vi.fn() } as any).readState();

    expect(result.stateRows).toEqual([
      ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
      ["Alpha Clan", "8,100,000", "0", "50", "0", "0", "0", "0", "0", "0"],
    ]);
  });
});
