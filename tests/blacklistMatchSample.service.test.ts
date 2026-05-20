import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlacklistClanRow } from "../src/services/BlacklistClanService";
import { BlacklistMatchSampleService } from "../src/services/BlacklistMatchSampleService";

type BlacklistMatchSampleRow = {
  sourceClanTag: string;
  sourceClanName: string | null;
  opponentBlacklistTag: string;
  opponentBlacklistName: string | null;
  warId: string;
  warStartTime: Date;
  warEndTime: Date | null;
  rosterSize: number;
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
  createdAt: Date;
  updatedAt: Date;
};

const sampleRows: BlacklistMatchSampleRow[] = [];
const warHistoryRows: Array<{
  warId: number;
  clanTag: string;
  clanName: string | null;
  opponentTag: string;
  opponentName: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
}> = [];

const prismaMock = vi.hoisted(() => ({
  clanWarHistory: {
    findMany: vi.fn(),
  },
  clanWarParticipation: {
    findMany: vi.fn(),
  },
  fwaClanCatalog: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
    blacklistMatchSample: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  }));

function makeWeightBucketWeights(): number[] {
  return [
    ...Array.from({ length: 5 }, () => 175_000),
    ...Array.from({ length: 5 }, () => 165_000),
    ...Array.from({ length: 5 }, () => 155_000),
    ...Array.from({ length: 5 }, () => 145_000),
    ...Array.from({ length: 5 }, () => 135_000),
    ...Array.from({ length: 5 }, () => 125_000),
    ...Array.from({ length: 5 }, () => 115_000),
    ...Array.from({ length: 10 }, () => 100_000),
    ...Array.from({ length: 5 }, () => 80_000),
  ];
}

function makeValidPlayerTag(index: number): string {
  const digits = ["0", "2", "8", "9"];
  let value = index;
  const parts: string[] = [];
  do {
    parts.unshift(digits[value % digits.length]!);
    value = Math.floor(value / digits.length);
  } while (value > 0);
  return `#P000${parts.join("")}`;
}

function makeRosterRows(input: {
  warId: string;
  clanTag: string;
  weights: number[];
}): Array<{ warId: string; clanTag: string; playerTag: string; townHall: number | null }> {
  return input.weights.map((weight, index) => ({
    warId: input.warId,
    clanTag: input.clanTag,
    playerTag: makeValidPlayerTag(index + 1),
    townHall:
      weight >= 171_000
        ? 18
        : weight >= 161_000
          ? 17
          : weight >= 151_000
            ? 16
            : weight >= 141_000
              ? 15
              : weight >= 131_000
                ? 14
                : weight >= 121_000
                  ? 13
                  : weight >= 111_000
                    ? 12
                    : weight >= 91_000
                      ? 11
                      : 10,
  }));
}

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("BlacklistMatchSampleService", () => {
  const now = new Date("2026-05-20T12:00:00.000Z");
  const bucketWeights = makeWeightBucketWeights();
  const bucketWeightByTag = new Map(
    bucketWeights.map((weight, index) => [
      makeValidPlayerTag(index + 1),
      weight,
    ]),
  );
  const totalRosterWeight = bucketWeights.reduce((sum, weight) => sum + weight, 0);
  const blacklistClans: BlacklistClanRow[] = [
    {
      clanTag: "#PYLQ0289",
      clanName: "Blacklist One",
      sourceLabel: "manual-import",
      active: true,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      clanTag: "#QGRJ2222",
      clanName: "Blacklist Two",
      sourceLabel: "manual-import",
      active: false,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ];
  const service = new BlacklistMatchSampleService({
    blacklistClans: {
      listBlacklistClans: vi.fn(async (input?: { active?: boolean }) =>
        input?.active === true ? blacklistClans.filter((row) => row.active) : [...blacklistClans],
      ),
    },
  });

  beforeEach(() => {
    sampleRows.splice(0, sampleRows.length);
    warHistoryRows.splice(0, warHistoryRows.length);
    vi.clearAllMocks();

    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([
      { clanTag: "#PYLQ0288", name: "FWA One" },
      { clanTag: "#QGRJ2228", name: "FWA Two" },
    ]);
    warHistoryRows.push(
      {
        warId: 101,
        clanTag: "#PYLQ0288",
        clanName: "FWA One",
        opponentTag: "#PYLQ0289",
        opponentName: "Blacklist One",
        warStartTime: new Date("2026-05-10T00:00:00.000Z"),
        warEndTime: new Date("2026-05-10T03:00:00.000Z"),
      },
      {
        warId: 102,
        clanTag: "#PYLQ0288",
        clanName: "FWA One",
        opponentTag: "#QGRJ2222",
        opponentName: "Blacklist Two",
        warStartTime: new Date("2026-05-11T00:00:00.000Z"),
        warEndTime: new Date("2026-05-11T03:00:00.000Z"),
      },
    );
    prismaMock.clanWarHistory.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      const clanFilter = where?.clanTag?.in;
      const opponentFilter = where?.opponentTag?.in;
      return warHistoryRows.filter((row) => {
        const clanOk = !Array.isArray(clanFilter) || clanFilter.includes(row.clanTag);
        const opponentOk =
          !Array.isArray(opponentFilter) || opponentFilter.includes(row.opponentTag);
        return clanOk && opponentOk;
      });
    });
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      ...makeRosterRows({
        warId: "101",
        clanTag: "#PYLQ0288",
        weights: bucketWeights,
      }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockImplementation(async (args: any) => {
      const tags = new Set<string>(args?.where?.playerTag?.in ?? []);
      return [...tags].map((playerTag) => ({
        playerTag,
        latestKnownWeight: bucketWeightByTag.get(playerTag) ?? null,
      }));
    });
    prismaMock.blacklistMatchSample.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      const sourceClanTagFilter = where?.sourceClanTag?.in;
      const opponentBlacklistTagFilter = where?.opponentBlacklistTag?.in;
      const warIdFilter = where?.warId?.in;
      return sampleRows.filter((row) => {
        const sourceOk =
          !Array.isArray(sourceClanTagFilter) || sourceClanTagFilter.includes(row.sourceClanTag);
        const opponentOk =
          !Array.isArray(opponentBlacklistTagFilter) ||
          opponentBlacklistTagFilter.includes(row.opponentBlacklistTag);
        const warOk = !Array.isArray(warIdFilter) || warIdFilter.includes(row.warId);
        return sourceOk && opponentOk && warOk;
      });
    });
    prismaMock.blacklistMatchSample.upsert.mockImplementation(async (args: any) => {
      const key = {
        sourceClanTag: args.where.sourceClanTag_opponentBlacklistTag_warId.sourceClanTag,
        opponentBlacklistTag:
          args.where.sourceClanTag_opponentBlacklistTag_warId.opponentBlacklistTag,
        warId: args.where.sourceClanTag_opponentBlacklistTag_warId.warId,
      };
      const existing = sampleRows.find(
        (row) =>
          row.sourceClanTag === key.sourceClanTag &&
          row.opponentBlacklistTag === key.opponentBlacklistTag &&
          row.warId === key.warId,
      );
      const now = new Date("2026-05-20T13:00:00.000Z");
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: now });
        return existing;
      }
      const created: BlacklistMatchSampleRow = {
        sourceClanTag: args.create.sourceClanTag,
        sourceClanName: args.create.sourceClanName ?? null,
        opponentBlacklistTag: args.create.opponentBlacklistTag,
        opponentBlacklistName: args.create.opponentBlacklistName ?? null,
        warId: args.create.warId,
        warStartTime: args.create.warStartTime,
        warEndTime: args.create.warEndTime ?? null,
        rosterSize: args.create.rosterSize,
        totalRosterWeight: args.create.totalRosterWeight,
        missingWeightCount: args.create.missingWeightCount,
        th18Count: args.create.th18Count,
        th17Count: args.create.th17Count,
        th16Count: args.create.th16Count,
        th15Count: args.create.th15Count,
        th14Count: args.create.th14Count,
        th13Count: args.create.th13Count,
        th12Count: args.create.th12Count,
        th11PlusCount: args.create.th11PlusCount,
        sampleQuality: args.create.sampleQuality,
        confidence: args.create.confidence,
        createdAt: now,
        updatedAt: now,
      };
      sampleRows.push(created);
      return created;
    });
  });

  it("creates samples for active blacklist opponents and ignores inactive ones", async () => {
    const result = await service.rebuildBlacklistMatchSamples({ now });

    expect(result.status).toBe("success");
    expect(result.activeBlacklistCount).toBe(1);
    expect(result.fwaClanCount).toBe(2);
    expect(result.candidateWarCount).toBe(1);
    expect(result.qualifyingSampleCount).toBe(1);
    expect(result.skippedCandidateCount).toBe(0);
    expect(result.addedCount).toBe(1);
    expect(result.updatedCount).toBe(0);
    expect(sampleRows).toHaveLength(1);
    expect(sampleRows[0]).toMatchObject({
      sourceClanTag: "#PYLQ0288",
      opponentBlacklistTag: "#PYLQ0289",
      warId: "101",
      rosterSize: 50,
      missingWeightCount: 0,
      th18Count: 5,
      th17Count: 5,
      th16Count: 5,
      th15Count: 5,
      th14Count: 5,
      th13Count: 5,
      th12Count: 5,
      th11PlusCount: 15,
      sampleQuality: "full",
      confidence: "high",
    });
    expect(sampleRows[0]?.totalRosterWeight).toBe(totalRosterWeight);
  });

  it("rebuilds idempotently without duplicating rows", async () => {
    await service.rebuildBlacklistMatchSamples({ now });
    const second = await service.rebuildBlacklistMatchSamples({ now: new Date("2026-05-20T13:30:00.000Z") });

    expect(second.status).toBe("success");
    expect(sampleRows).toHaveLength(1);
    expect(second.addedCount).toBe(0);
    expect(second.updatedCount).toBe(1);
  });

  it("skips low-quality or incomplete rosters consistently", async () => {
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      {
        warId: 201,
        clanTag: "#PYLQ0288",
        clanName: "FWA One",
        opponentTag: "#PYLQ0289",
        opponentName: "Blacklist One",
        warStartTime: new Date("2026-05-12T00:00:00.000Z"),
        warEndTime: new Date("2026-05-12T03:00:00.000Z"),
      },
      {
        warId: 202,
        clanTag: "#PYLQ0288",
        clanName: "FWA One",
        opponentTag: "#PYLQ0289",
        opponentName: "Blacklist One",
        warStartTime: new Date("2026-05-13T00:00:00.000Z"),
        warEndTime: new Date("2026-05-13T03:00:00.000Z"),
      },
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      ...makeRosterRows({
        warId: "201",
        clanTag: "#PYLQ0288",
        weights: bucketWeights,
      }).slice(0, 49),
      ...makeRosterRows({
        warId: "202",
        clanTag: "#PYLQ0288",
        weights: bucketWeights,
      }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockImplementation(async (args: any) => {
      const tags = [...new Set<string>(args?.where?.playerTag?.in ?? [])];
      return tags.slice(0, 39).map((playerTag, index) => ({
        playerTag,
        latestKnownWeight: bucketWeights[index] ?? null,
      }));
    });

    const result = await service.rebuildBlacklistMatchSamples({ now });

    expect(result.status).toBe("noop");
    expect(result.qualifyingSampleCount).toBe(0);
    expect(result.skippedCandidateCount).toBe(2);
    expect(sampleRows).toHaveLength(0);
  });
});
