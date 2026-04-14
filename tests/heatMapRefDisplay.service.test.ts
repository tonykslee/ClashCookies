import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeatMapRefDisplayService } from "../src/services/HeatMapRefDisplayService";

const prismaMock = vi.hoisted(() => ({
  heatMapRef: {
    findMany: vi.fn(),
  },
  fwaClanCatalog: {
    findMany: vi.fn(),
  },
  fwaWarMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaClanMatchStatsCurrent: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

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
  contributingClanCount: number;
}>): {
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
  contributingClanCount: number;
} {
  return {
    weightMinInclusive: input?.weightMinInclusive ?? 0,
    weightMaxInclusive: input?.weightMaxInclusive ?? 9_999_999,
    th18Count: input?.th18Count ?? 0,
    th17Count: input?.th17Count ?? 0,
    th16Count: input?.th16Count ?? 0,
    th15Count: input?.th15Count ?? 0,
    th14Count: input?.th14Count ?? 0,
    th13Count: input?.th13Count ?? 0,
    th12Count: input?.th12Count ?? 0,
    th11Count: input?.th11Count ?? 0,
    th10OrLowerCount: input?.th10OrLowerCount ?? 0,
    contributingClanCount: input?.contributingClanCount ?? 0,
  };
}

function makeMember(input: {
  clanTag: string;
  playerTag: string;
  position: number;
  weight: number;
}): {
  clanTag: string;
  playerTag: string;
  position: number;
  townHall: number;
  weight: number;
  sourceSyncedAt: Date;
} {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    position: input.position,
    townHall: 16,
    weight: input.weight,
    sourceSyncedAt: new Date("2026-04-14T18:00:00.000Z"),
  };
}

function makeRosterMembers(clanTag: string, weight: number): ReturnType<typeof makeMember>[] {
  return Array.from({ length: 50 }, (_, index) =>
    makeMember({
      clanTag,
      playerTag: `${clanTag}-${String(index + 1).padStart(2, "0")}`,
      position: index + 1,
      weight,
    }),
  );
}

describe("HeatMapRefDisplayService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes band match% as a weighted average by evaluatedWarCount", async () => {
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef({ th11Count: 1, th10OrLowerCount: 2, contributingClanCount: 2 })]);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([{ clanTag: "#AAA111" }, { clanTag: "#BBB222" }]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      ...makeRosterMembers("#AAA111", 100_000),
      ...makeRosterMembers("#BBB222", 100_000),
    ]);
    prismaMock.fwaClanMatchStatsCurrent.findMany.mockResolvedValue([
      { clanTag: "#AAA111", matchRate: 0.5, evaluatedWarCount: 10 },
      { clanTag: "#BBB222", matchRate: 0.25, evaluatedWarCount: 30 },
    ]);

    const service = new HeatMapRefDisplayService();
    const result = await service.readHeatMapRefDisplayTable();

    expect(prismaMock.fwaClanMatchStatsCurrent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clanTag: {
            in: expect.arrayContaining(["#AAA111", "#BBB222"]),
          },
        },
      }),
    );
    expect(result.rows).toEqual([
      ["Band", "TH18", "TH17", "TH16", "TH15", "TH14", "TH13", "TH12", "TH11+", "Match%", "Clans"],
      ["0 - 9,999,999", "0", "0", "0", "0", "0", "0", "0", "3", "31.25%", "2"],
    ]);
    expect(result.copyText).toBe(
      "WeightMin,WeightMax,TH18,TH17,TH16,TH15,TH14,TH13,TH12,TH11+,Match%,# Clans\n" +
        "0,9999999,0,0,0,0,0,0,0,3,31.25%,2",
    );
  });

  it("renders 0% when stats are missing or evaluate to zero", async () => {
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef({ th11Count: 0, th10OrLowerCount: 0, contributingClanCount: 2 })]);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([{ clanTag: "#AAA111" }, { clanTag: "#BBB222" }]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      ...makeRosterMembers("#AAA111", 100_000),
      ...makeRosterMembers("#BBB222", 100_000),
    ]);
    prismaMock.fwaClanMatchStatsCurrent.findMany.mockResolvedValue([
      { clanTag: "#AAA111", matchRate: 0.9, evaluatedWarCount: 0 },
    ]);

    const service = new HeatMapRefDisplayService();
    const result = await service.readHeatMapRefDisplayTable();

    expect(result.rows[1]).toEqual([
      "0 - 9,999,999",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0%",
      "2",
    ]);
    expect(result.copyText).toContain("0%,2");
    expect(result.copyText.startsWith("WeightMin,WeightMax,")).toBe(true);
  });
});
