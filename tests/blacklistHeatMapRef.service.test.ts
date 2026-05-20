import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlacklistHeatmapRefService } from "../src/services/BlacklistHeatmapRefService";

type BlacklistMatchSampleRow = {
  sourceClanTag: string;
  opponentBlacklistTag: string;
  totalRosterWeight: number;
  missingWeightCount: number;
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11PlusCount: number;
  sampleQuality: string;
  confidence: string;
};

type BlacklistHeatmapRefRow = {
  weightMinInclusive: number;
  weightMaxInclusive: number;
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11PlusCount: number;
  sampleCount: number;
  uniqueSourceClanCount: number;
  uniqueOpponentCount: number;
  totalMissingWeightCount: number;
  confidenceLabel: string;
  confidenceScore: number;
  generatedAt: Date;
};

const sampleRows: BlacklistMatchSampleRow[] = [];
const profileRows: BlacklistHeatmapRefRow[] = [];

const prismaMock = vi.hoisted(() => ({
  blacklistMatchSample: {
    findMany: vi.fn(),
  },
  blacklistHeatMapRef: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function makeCounts(input: {
  th18?: number;
  th17?: number;
  th16?: number;
  th15?: number;
  th14?: number;
  th13?: number;
  th12?: number;
  th11Plus?: number;
}): Pick<
  BlacklistMatchSampleRow,
  | "th18Count"
  | "th17Count"
  | "th16Count"
  | "th15Count"
  | "th14Count"
  | "th13Count"
  | "th12Count"
  | "th11PlusCount"
> {
  return {
    th18Count: input.th18 ?? 0,
    th17Count: input.th17 ?? 0,
    th16Count: input.th16 ?? 0,
    th15Count: input.th15 ?? 0,
    th14Count: input.th14 ?? 0,
    th13Count: input.th13 ?? 0,
    th12Count: input.th12 ?? 0,
    th11PlusCount: input.th11Plus ?? 0,
  };
}

function makeSampleRow(input: {
  sourceClanTag: string;
  opponentBlacklistTag: string;
  totalRosterWeight: number;
  missingWeightCount: number;
  counts: ReturnType<typeof makeCounts>;
  sampleQuality: "full" | "partial";
  confidence: "high" | "medium" | "low";
}): BlacklistMatchSampleRow {
  return {
    sourceClanTag: input.sourceClanTag,
    opponentBlacklistTag: input.opponentBlacklistTag,
    totalRosterWeight: input.totalRosterWeight,
    missingWeightCount: input.missingWeightCount,
    ...input.counts,
    sampleQuality: input.sampleQuality,
    confidence: input.confidence,
  };
}

describe("BlacklistHeatmapRefService", () => {
  const service = new BlacklistHeatmapRefService();
  const now = new Date("2026-05-20T14:00:00.000Z");

  beforeEach(() => {
    sampleRows.splice(0, sampleRows.length);
    profileRows.splice(0, profileRows.length);
    vi.clearAllMocks();

    prismaMock.blacklistMatchSample.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      const confidenceFilter = where?.confidence?.in;
      return sampleRows.filter((row) =>
        !Array.isArray(confidenceFilter) || confidenceFilter.includes(row.confidence),
      );
    });
    prismaMock.blacklistHeatMapRef.findMany.mockImplementation(async () =>
      profileRows.map((row) => ({ ...row })),
    );
    prismaMock.blacklistHeatMapRef.upsert.mockImplementation(async (args: any) => {
      const key = args.where.weightMinInclusive_weightMaxInclusive;
      const existing = profileRows.find(
        (row) =>
          row.weightMinInclusive === key.weightMinInclusive &&
          row.weightMaxInclusive === key.weightMaxInclusive,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const created: BlacklistHeatmapRefRow = {
        ...args.create,
      };
      profileRows.push(created);
      return created;
    });
    prismaMock.blacklistHeatMapRef.delete.mockImplementation(async (args: any) => {
      const key = args.where.weightMinInclusive_weightMaxInclusive;
      const index = profileRows.findIndex(
        (row) =>
          row.weightMinInclusive === key.weightMinInclusive &&
          row.weightMaxInclusive === key.weightMaxInclusive,
      );
      if (index >= 0) {
        profileRows.splice(index, 1);
      }
      return null;
    });
  });

  it("groups usable samples into 100k bands and normalizes averaged counts to 50", async () => {
    sampleRows.push(
      makeSampleRow({
        sourceClanTag: "#PYLQ0288",
        opponentBlacklistTag: "#PYLQ0289",
        totalRosterWeight: 6_450_001,
        missingWeightCount: 0,
        counts: makeCounts({ th18: 50 }),
        sampleQuality: "full",
        confidence: "high",
      }),
      makeSampleRow({
        sourceClanTag: "#QGRJ2228",
        opponentBlacklistTag: "#QGRJ2222",
        totalRosterWeight: 6_460_001,
        missingWeightCount: 2,
        counts: makeCounts({ th17: 50 }),
        sampleQuality: "partial",
        confidence: "medium",
      }),
      makeSampleRow({
        sourceClanTag: "#PYLQ0288",
        opponentBlacklistTag: "#QGRJ2228",
        totalRosterWeight: 6_470_001,
        missingWeightCount: 4,
        counts: makeCounts({ th16: 50 }),
        sampleQuality: "partial",
        confidence: "medium",
      }),
      makeSampleRow({
        sourceClanTag: "#PYLQ0288",
        opponentBlacklistTag: "#QGRJ2222",
        totalRosterWeight: 7_120_001,
        missingWeightCount: 4,
        counts: makeCounts({ th14: 50 }),
        sampleQuality: "partial",
        confidence: "medium",
      }),
    );

    const result = await service.rebuildBlacklistHeatmapRef({ now });

    expect(result.status).toBe("success");
    expect(result.usableSampleCount).toBe(4);
    expect(result.bandCount).toBe(2);
    expect(result.addedCount).toBe(2);
    expect(result.updatedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(profileRows).toHaveLength(2);

    const bandA = profileRows.find((row) => row.weightMinInclusive === 6_400_000);
    expect(bandA).toBeTruthy();
    expect(bandA).toMatchObject({
      weightMaxInclusive: 6_499_999,
      sampleCount: 3,
      uniqueSourceClanCount: 2,
      uniqueOpponentCount: 3,
      totalMissingWeightCount: 6,
      confidenceLabel: "high",
      confidenceScore: expect.any(Number),
      generatedAt: now,
    });
    expect(
      (bandA?.th18Count ?? 0) +
        (bandA?.th17Count ?? 0) +
        (bandA?.th16Count ?? 0) +
        (bandA?.th15Count ?? 0) +
        (bandA?.th14Count ?? 0) +
        (bandA?.th13Count ?? 0) +
        (bandA?.th12Count ?? 0) +
        (bandA?.th11PlusCount ?? 0),
    ).toBe(50);
    expect((bandA?.th18Count ?? 0) + (bandA?.th17Count ?? 0) + (bandA?.th16Count ?? 0)).toBe(50);

    const bandB = profileRows.find((row) => row.weightMinInclusive === 7_100_000);
    expect(bandB).toBeTruthy();
    expect(bandB).toMatchObject({
      weightMaxInclusive: 7_199_999,
      sampleCount: 1,
      uniqueSourceClanCount: 1,
      uniqueOpponentCount: 1,
      totalMissingWeightCount: 4,
      confidenceLabel: "low",
      confidenceScore: expect.any(Number),
      generatedAt: now,
    });
    expect(
      (bandB?.th18Count ?? 0) +
        (bandB?.th17Count ?? 0) +
        (bandB?.th16Count ?? 0) +
        (bandB?.th15Count ?? 0) +
        (bandB?.th14Count ?? 0) +
        (bandB?.th13Count ?? 0) +
        (bandB?.th12Count ?? 0) +
        (bandB?.th11PlusCount ?? 0),
    ).toBe(50);
    expect(bandB?.th14Count).toBe(50);
  });

  it("rebuilds idempotently without duplicating rows", async () => {
    sampleRows.push(
      makeSampleRow({
        sourceClanTag: "#PYLQ0288",
        opponentBlacklistTag: "#PYLQ0289",
        totalRosterWeight: 6_450_001,
        missingWeightCount: 0,
        counts: makeCounts({ th18: 50 }),
        sampleQuality: "full",
        confidence: "high",
      }),
      makeSampleRow({
        sourceClanTag: "#QGRJ2228",
        opponentBlacklistTag: "#QGRJ2222",
        totalRosterWeight: 6_460_001,
        missingWeightCount: 2,
        counts: makeCounts({ th17: 50 }),
        sampleQuality: "partial",
        confidence: "medium",
      }),
    );

    const first = await service.rebuildBlacklistHeatmapRef({ now });
    const second = await service.rebuildBlacklistHeatmapRef({
      now: new Date("2026-05-20T15:00:00.000Z"),
    });

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(profileRows).toHaveLength(1);
    expect(second.addedCount).toBe(0);
    expect(second.updatedCount).toBe(1);
    expect(second.removedCount).toBe(0);
  });

  it("skips low-confidence samples consistently and clears stale profile rows", async () => {
    sampleRows.push(
      makeSampleRow({
        sourceClanTag: "#PYLQ0288",
        opponentBlacklistTag: "#PYLQ0289",
        totalRosterWeight: 6_450_001,
        missingWeightCount: 12,
        counts: makeCounts({ th18: 50 }),
        sampleQuality: "partial",
        confidence: "low",
      }),
    );
    profileRows.push({
      weightMinInclusive: 6_400_000,
      weightMaxInclusive: 6_499_999,
      th18Count: 50,
      th17Count: 0,
      th16Count: 0,
      th15Count: 0,
      th14Count: 0,
      th13Count: 0,
      th12Count: 0,
      th11PlusCount: 0,
      sampleCount: 1,
      uniqueSourceClanCount: 1,
      uniqueOpponentCount: 1,
      totalMissingWeightCount: 12,
      confidenceLabel: "low",
      confidenceScore: 10,
      generatedAt: now,
    });

    const result = await service.rebuildBlacklistHeatmapRef({ now });

    expect(result.status).toBe("skipped");
    expect(result.bandCount).toBe(0);
    expect(result.usableSampleCount).toBe(0);
    expect(result.removedCount).toBe(1);
    expect(profileRows).toHaveLength(0);
  });
});
