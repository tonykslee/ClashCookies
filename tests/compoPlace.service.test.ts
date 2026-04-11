import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import * as SheetRefreshService from "../src/services/SheetRefreshService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
  heatMapRef: {
    findMany: vi.fn(),
  },
  weightInputDeferment: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildBucketDeltaByHeaderForTest,
  CompoPlaceService,
  resolvePlacementWeightForTest,
} from "../src/services/CompoPlaceService";

function makeTrackedClan(tag: string, name: string) {
  return {
    tag,
    name,
  };
}

function makeHeatMapRef(input?: Partial<{
  weightMinInclusive: number;
  weightMaxInclusive: number;
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11Count: number;
  th10OrLowerCount: number;
}>) {
  return {
    weightMinInclusive: input?.weightMinInclusive ?? 0,
    weightMaxInclusive: input?.weightMaxInclusive ?? 9_999_999,
    th18Count: input?.th18Count ?? 19,
    th17Count: input?.th17Count ?? 11,
    th16Count: input?.th16Count ?? 7,
    th15Count: input?.th15Count ?? 6,
    th14Count: input?.th14Count ?? 4,
    th13Count: input?.th13Count ?? 2,
    th12Count: input?.th12Count ?? 1,
    th11Count: input?.th11Count ?? 0,
    th10OrLowerCount: input?.th10OrLowerCount ?? 0,
    sourceVersion: "test",
    refreshedAt: new Date("2026-04-10T16:00:00.000Z"),
  };
}

function bucketWeight(bucket: string): number {
  if (bucket === "TH18") return 175000;
  if (bucket === "TH17") return 165000;
  if (bucket === "TH16") return 155000;
  if (bucket === "TH15") return 145000;
  if (bucket === "TH14") return 135000;
  if (bucket === "TH13") return 125000;
  if (bucket === "TH12") return 115000;
  if (bucket === "TH11") return 100000;
  if (bucket === "TH10") return 80000;
  if (bucket === "TH9") return 65000;
  return 55000;
}

function validPlayerTag(index: number): string {
  const digits = ["0", "2", "8", "9"];
  let value = Math.max(0, Math.trunc(index));
  let suffix = "";
  do {
    suffix = digits[value % 4] + suffix;
    value = Math.floor(value / 4);
  } while (value > 0);
  return `#P${suffix.padStart(6, "0")}`;
}

function makeCurrentMembers(input: {
  clanTag: string;
  counts: Partial<
    Record<
      "TH18" | "TH17" | "TH16" | "TH15" | "TH14" | "TH13" | "TH12" | "TH11" | "TH10" | "TH9" | "TH8_OR_LOWER",
      number
    >
  >;
  startIndex?: number;
  sourceSyncedAt?: Date;
  townHall?: number;
}) {
  const sourceSyncedAt = input.sourceSyncedAt ?? new Date("2026-04-10T16:30:00.000Z");
  const rows: Array<{
    clanTag: string;
    playerTag: string;
    weight: number;
    sourceSyncedAt: Date;
    townHall: number;
  }> = [];
  let index = input.startIndex ?? 1;
  for (const [bucket, count] of Object.entries(input.counts)) {
    for (let current = 0; current < (count ?? 0); current += 1) {
      rows.push({
        clanTag: input.clanTag,
        playerTag: validPlayerTag(index),
        weight: bucketWeight(bucket),
        sourceSyncedAt,
        townHall: input.townHall ?? 18,
      });
      index += 1;
    }
  }
  return rows;
}

function makeZeroWeightMember(input: {
  clanTag: string;
  playerTag: string;
  sourceSyncedAt?: Date;
  townHall?: number;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    weight: 0,
    sourceSyncedAt: input.sourceSyncedAt ?? new Date("2026-04-10T16:30:00.000Z"),
    townHall: input.townHall ?? 18,
  };
}

function makeWarFallback(input: {
  clanTag: string;
  playerTag: string;
  effectiveWeight: number;
  updatedAt?: Date;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    effectiveWeight: input.effectiveWeight,
    updatedAt: input.updatedAt ?? new Date("2026-04-10T16:45:00.000Z"),
  };
}

function makeOpenDeferment(input: {
  scopeKey: string;
  playerTag: string;
  deferredWeight: number;
  createdAt?: Date;
}) {
  return {
    scopeKey: input.scopeKey,
    playerTag: input.playerTag,
    deferredWeight: input.deferredWeight,
    createdAt: input.createdAt ?? new Date("2026-04-10T16:40:00.000Z"),
  };
}

describe("CompoPlaceService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockReset();
    prismaMock.heatMapRef.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();
  });

  it("reads ACTUAL placement suggestions from persisted tracked clans, current members, and HeatMapRef without sheet services", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
      makeTrackedClan("#BBB222", "Bravo Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      ...makeCurrentMembers({
        clanTag: "#AAA111",
        counts: { TH18: 19, TH17: 11, TH16: 7, TH15: 4, TH14: 4, TH13: 2, TH12: 1, TH11: 2 },
      }),
      ...makeCurrentMembers({
        clanTag: "#BBB222",
        counts: { TH18: 17, TH17: 11, TH16: 7, TH15: 5, TH14: 4, TH13: 2, TH12: 1, TH11: 1 },
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);
    const getCompoLinkedSheetSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "getCompoLinkedSheet",
    );
    const readCompoLinkedValuesSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "readCompoLinkedValues",
    );

    const result = await new CompoPlaceService().readPlace(145000, "TH15", "guild-1");

    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();
    expect(result.trackedClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.eligibleClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.candidateCount).toBe(2);
    expect(result.recommendedCount).toBe(1);
    expect(result.vacancyCount).toBe(1);
    expect(result.compositionCount).toBe(2);

    const embed = result.embeds[0]?.toJSON();
    expect(embed?.description).toContain("Weight: **145,000**");
    expect(embed?.description).toContain("Bucket: **TH15**");
    expect(embed?.description).toContain("RAW Data last refreshed:");
    expect(embed?.fields?.find((field) => field.name === "Recommended")?.value).toContain(
      "Bravo Clan - needs 1 TH15",
    );
    expect(embed?.fields?.find((field) => field.name === "Vacancy")?.value).toContain(
      "Bravo Clan - 48/50",
    );
    const compositionValue =
      embed?.fields?.find((field) => field.name === "Composition")?.value ?? "";
    expect(compositionValue).toContain("Alpha Clan - -2");
    expect(compositionValue).toContain("Bravo Clan - -1");
    expect(compositionValue.indexOf("Alpha Clan - -2")).toBeLessThan(
      compositionValue.indexOf("Bravo Clan - -1"),
    );
  });

  it("uses member weight, then deferred weight, then WAR effective weight, and ignores unresolved zero-weight rows", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        playerTag: "#P000002",
        weight: 145000,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
        townHall: 18,
      },
      makeZeroWeightMember({ clanTag: "#AAA111", playerTag: "#P000008" }),
      makeZeroWeightMember({ clanTag: "#AAA111", playerTag: "#P000009" }),
      makeZeroWeightMember({ clanTag: "#AAA111", playerTag: "#P000020" }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([
      makeOpenDeferment({
        scopeKey: "guild:guild-1|clan:AAA111",
        playerTag: "#P000008",
        deferredWeight: 166000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      makeWarFallback({
        clanTag: "#AAA111",
        playerTag: "#P000009",
        effectiveWeight: 155000,
      }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        th18Count: 0,
        th17Count: 1,
        th16Count: 1,
        th15Count: 2,
      }),
    ]);

    const result = await new CompoPlaceService().readPlace(145000, "TH15", "guild-1");

    expect(result.candidateCount).toBe(1);
    expect(result.compositionCount).toBe(1);
    const embed = result.embeds[0]?.toJSON();
    expect(embed?.fields?.find((field) => field.name === "Composition")?.value).toContain(
      "Alpha Clan - -1",
    );
    expect(resolvePlacementWeightForTest({
      memberWeight: 145000,
      deferredWeight: 166000,
      sameClanWarWeight: 155000,
      anyWarWeight: 170000,
    })).toBe(145000);
    expect(resolvePlacementWeightForTest({
      memberWeight: 0,
      deferredWeight: 166000,
      sameClanWarWeight: 155000,
      anyWarWeight: 170000,
    })).toBe(166000);
    expect(resolvePlacementWeightForTest({
      memberWeight: 0,
      deferredWeight: null,
      sameClanWarWeight: 155000,
      anyWarWeight: 170000,
    })).toBe(155000);
    expect(resolvePlacementWeightForTest({
      memberWeight: 0,
      deferredWeight: null,
      sameClanWarWeight: null,
      anyWarWeight: null,
    })).toBeNull();
  });

  it("derives placement buckets from resolved weights and collapses TH13-and-lower display deltas", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        playerTag: "#P000002",
        weight: 119000,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
        townHall: 18,
      },
      {
        clanTag: "#AAA111",
        playerTag: "#P000008",
        weight: 80000,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
        townHall: 18,
      },
      {
        clanTag: "#AAA111",
        playerTag: "#P000009",
        weight: 65000,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
        townHall: 18,
      },
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        th18Count: 0,
        th17Count: 0,
        th16Count: 0,
        th15Count: 0,
        th14Count: 0,
        th13Count: 2,
        th12Count: 2,
        th11Count: 2,
        th10OrLowerCount: 0,
      }),
    ]);

    const result = await new CompoPlaceService().readPlace(100000, "<=TH13", "guild-1");

    expect(result.candidateCount).toBe(1);
    const embed = result.embeds[0]?.toJSON();
    expect(embed?.fields?.find((field) => field.name === "Composition")?.value).toContain(
      "Alpha Clan - -3",
    );
    expect(
      buildBucketDeltaByHeaderForTest(makeHeatMapRef({
        th13Count: 2,
        th12Count: 2,
        th11Count: 2,
      }), {
        TH18: 0,
        TH17: 0,
        TH16: 0,
        TH15: 0,
        TH14: 0,
        "<=TH13": 3,
      })["<=th13-delta"],
    ).toBe(-3);
  });

  it("returns honest text when tracked clans lack eligible persisted ACTUAL placement data", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
      makeTrackedClan("#BBB222", "Bravo Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeZeroWeightMember({ clanTag: "#AAA111", playerTag: "#P000002" }),
      makeZeroWeightMember({ clanTag: "#BBB222", playerTag: "#P000008" }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(145000, "TH15", "guild-1");

    expect(result.trackedClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.eligibleClanTags).toEqual([]);
    expect(result.candidateCount).toBe(0);
    expect(result.embeds).toEqual([]);
    expect(result.content).toContain(
      "No eligible placement data found in persisted ACTUAL current-member state.",
    );
  });

  it("refreshes by rereading the persisted snapshot only and does not trigger sheet refresh", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
      makeCurrentMembers({
        clanTag: "#AAA111",
        counts: { TH15: 50 },
      }),
    );
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);
    const triggerSharedSheetRefreshSpy = vi.spyOn(
      SheetRefreshService,
      "triggerSharedSheetRefresh",
    );

    await new CompoPlaceService().refreshPlace(145000, "TH15", "guild-1");

    expect(triggerSharedSheetRefreshSpy).not.toHaveBeenCalled();
  });
});
