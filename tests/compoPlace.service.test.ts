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

import { CompoPlaceService } from "../src/services/CompoPlaceService";

function makeParent(input: {
  clanTag: string;
  clanName: string;
  rosterSize?: number;
  totalEffectiveWeight?: number | null;
  hasUnresolvedWeights?: boolean;
}) {
  return {
    clanTag: input.clanTag,
    clanName: input.clanName,
    opponentTag: null,
    opponentName: null,
    rosterSize: input.rosterSize ?? 50,
    totalRawWeight:
      input.totalEffectiveWeight === undefined ? 8_100_000 : input.totalEffectiveWeight,
    totalEffectiveWeight:
      input.totalEffectiveWeight === undefined ? 8_100_000 : input.totalEffectiveWeight,
    hasUnresolvedWeights: input.hasUnresolvedWeights ?? false,
    observedAt: new Date("2026-04-10T17:00:00.000Z"),
    sourceUpdatedAt: new Date("2026-04-10T16:00:00.000Z"),
    createdAt: new Date("2026-04-10T15:00:00.000Z"),
    updatedAt: new Date("2026-04-10T17:00:00.000Z"),
  };
}

function makeMembers(input: {
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
}) {
  let position = 1;
  const makeMember = (effectiveWeight: number) => ({
    clanTag: input.clanTag,
    position: position++,
    playerTag: `#P${input.clanTag.replace(/[^A-Z0-9]/g, "")}${position}`,
    playerName: `Player ${position}`,
    townHall: 18,
    rawWeight: effectiveWeight,
    effectiveWeight,
    effectiveWeightStatus: "RAW" as const,
    opponentTag: null,
    opponentName: null,
    createdAt: new Date("2026-04-10T15:00:00.000Z"),
    updatedAt: new Date("2026-04-10T17:00:00.000Z"),
  });

  return [
    ...Array.from({ length: input.counts.th18 ?? 0 }, () => makeMember(175000)),
    ...Array.from({ length: input.counts.th17 ?? 0 }, () => makeMember(165000)),
    ...Array.from({ length: input.counts.th16 ?? 0 }, () => makeMember(155000)),
    ...Array.from({ length: input.counts.th15 ?? 0 }, () => makeMember(145000)),
    ...Array.from({ length: input.counts.th14 ?? 0 }, () => makeMember(135000)),
    ...Array.from({ length: input.counts.th13 ?? 0 }, () => makeMember(125000)),
    ...Array.from({ length: input.counts.th12 ?? 0 }, () => makeMember(119000)),
    ...Array.from({ length: input.counts.th11 ?? 0 }, () => makeMember(100000)),
    ...Array.from({ length: input.counts.th10 ?? 0 }, () => makeMember(80000)),
    ...Array.from({ length: input.counts.th9 ?? 0 }, () => makeMember(65000)),
    ...Array.from({ length: input.counts.th8OrLower ?? 0 }, () => makeMember(55000)),
  ];
}

function makeHeatMapRef() {
  return {
    weightMinInclusive: 8_000_001,
    weightMaxInclusive: 8_100_000,
    th18Count: 19,
    th17Count: 11,
    th16Count: 7,
    th15Count: 6,
    th14Count: 4,
    th13Count: 2,
    th12Count: 1,
    th11Count: 0,
    th10OrLowerCount: 0,
    sourceVersion: "bootstrap-2026-03-17",
    refreshedAt: new Date("2026-03-17T00:00:00.000Z"),
  };
}

describe("CompoPlaceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses eligible tracked WAR snapshots only and ranks composition gaps from persisted effective-weight buckets", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha Clan" },
      { tag: "#BBB222", name: "Bravo Clan" },
      { tag: "#CCC333", name: "Charlie Clan" },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeParent({ clanTag: "#AAA111", clanName: "Alpha Clan-war" }),
      makeParent({ clanTag: "#BBB222", clanName: "Bravo Clan-war" }),
      makeParent({
        clanTag: "#CCC333",
        clanName: "Charlie Clan-war",
        hasUnresolvedWeights: true,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      ...makeMembers({
        clanTag: "#AAA111",
        counts: {
          th18: 19,
          th17: 11,
          th16: 7,
          th15: 4,
          th14: 4,
          th13: 2,
          th12: 1,
          th11: 1,
          th10: 1,
        },
      }),
      ...makeMembers({
        clanTag: "#BBB222",
        counts: {
          th18: 19,
          th17: 11,
          th16: 7,
          th15: 5,
          th14: 4,
          th13: 2,
          th12: 1,
          th11: 1,
        },
      }),
      ...makeMembers({
        clanTag: "#CCC333",
        counts: {
          th18: 19,
          th17: 11,
          th16: 7,
          th15: 6,
          th14: 4,
          th13: 2,
          th12: 1,
        },
      }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(145000, "TH15");

    expect(result.trackedClanTags).toEqual(["#AAA111", "#BBB222", "#CCC333"]);
    expect(result.eligibleClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.candidateCount).toBe(2);
    expect(result.recommendedCount).toBe(0);
    expect(result.vacancyCount).toBe(0);
    expect(result.compositionCount).toBe(2);
    expect(result.content).toBe("");

    const embed = result.embeds[0]?.toJSON();
    expect(embed?.fields?.find((field) => field.name === "Recommended")?.value).toBe(
      "None",
    );
    expect(embed?.fields?.find((field) => field.name === "Vacancy")?.value).toBe(
      "None",
    );
    const compositionValue =
      embed?.fields?.find((field) => field.name === "Composition")?.value ?? "";
    expect(compositionValue).toContain("Alpha Clan");
    expect(compositionValue).toContain("Bravo Clan");
    expect(compositionValue.indexOf("Alpha Clan")).toBeLessThan(
      compositionValue.indexOf("Bravo Clan"),
    );
  });

  it("returns honest text when no eligible tracked WAR snapshots exist", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha Clan" },
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeParent({
        clanTag: "#AAA111",
        clanName: "Alpha Clan-war",
        rosterSize: 49,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue(
      makeMembers({
        clanTag: "#AAA111",
        counts: {
          th18: 19,
          th17: 11,
          th16: 7,
          th15: 5,
          th14: 4,
          th13: 2,
          th12: 1,
        },
      }).slice(0, 49),
    );
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(145000, "TH15");

    expect(result.embeds).toEqual([]);
    expect(result.content).toContain("Mode Displayed: **PLACE**");
    expect(result.content).toContain(
      "No eligible DB-backed WAR roster snapshots are currently available for placement suggestions.",
    );
    expect(result.content).toContain("Skipped ineligible clans:");
    expect(result.eligibleClanTags).toEqual([]);
  });

  it("refreshes tracked-clan war-roster feed state only before rereading from DB", async () => {
    const feedOps = {
      runTracked: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CompoPlaceService(feedOps);
    vi.spyOn(service, "readPlace")
      .mockResolvedValueOnce({
        content: "",
        embeds: [],
        trackedClanTags: ["#AAA111", "#BBB222"],
        eligibleClanTags: ["#AAA111"],
        candidateCount: 1,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 1,
      })
      .mockResolvedValueOnce({
        content: "",
        embeds: [],
        trackedClanTags: ["#AAA111", "#BBB222"],
        eligibleClanTags: ["#AAA111"],
        candidateCount: 1,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 1,
      });

    await service.refreshPlace(145000, "TH15");

    expect(feedOps.runTracked).toHaveBeenCalledTimes(2);
    expect(feedOps.runTracked).toHaveBeenCalledWith("war-roster", "#AAA111");
    expect(feedOps.runTracked).toHaveBeenCalledWith("war-roster", "#BBB222");
  });
});
