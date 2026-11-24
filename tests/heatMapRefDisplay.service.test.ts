import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeatMapRefDisplayService } from "../src/services/HeatMapRefDisplayService";
import { buildNativeReferenceDisplayForTest, buildNativeReferenceNoticeForTest } from "../src/services/HeatMapRefDisplayService";
import { NativeHeatMapReferencePublicationService } from "../src/services/NativeHeatMapReferencePublicationService";
import { installLegacyHeatMapRefBucketTargetMock } from "./heatMapRefTestHelpers";
import { computeHeatMapRefContentHash } from "../src/helper/heatMapRefRebuild";
import { HEAT_MAP_REF_SEED_ROWS } from "../src/services/HeatMapRefSeedData";

const prismaMock = vi.hoisted(() => ({
  heatMapRef: {
    findMany: vi.fn(),
  },
  heatMapRefBucketTarget: {
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
  $queryRaw: vi.fn(),
  nativeHeatMapReferenceHead: undefined as unknown,
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
    prismaMock.nativeHeatMapReferenceHead = undefined;
    installLegacyHeatMapRefBucketTargetMock(prismaMock);
    prismaMock.$queryRaw.mockResolvedValue([]);
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
      ["Band", "TH19", "TH18", "TH17", "TH16", "TH15", "TH14", "TH13", "TH12", "TH11+", "Match%", "Clans"],
      ["0 - 9,999,999", "—", "0", "0", "0", "0", "0", "0", "0", "3", "31.25%", "2"],
    ]);
    expect(result.copyText).toBe(
      "WeightMin,WeightMax,TH19,TH18,TH17,TH16,TH15,TH14,TH13,TH12,TH11+,Match%,# Clans\n" +
        "0,9999999,—,0,0,0,0,0,0,0,3,31.25%,2",
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

    expect(result.referenceState.status).toBe("unavailable");
    expect(result.rows[1]).toEqual([
      "0 - 9,999,999",
      "—",
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
    expect(result.copyText.split("\n")[1]?.split(",").slice(2, 12)).toEqual([
      "—",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0%",
    ]);
    expect(result.copyText.startsWith("WeightMin,WeightMax,")).toBe(true);
  });

  it("labels the current reference state and keeps supported zeroes distinct from unavailable TH19", async () => {
    const refs = [makeHeatMapRef({
      th18Count: 0,
      th11Count: 0,
      th10OrLowerCount: 0,
      contributingClanCount: 3,
    })];
    prismaMock.heatMapRef.findMany.mockResolvedValue(refs);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([
      {
        value: JSON.stringify({
          version: 1,
          status: "validated",
          blockReasonCode: null,
          reason: null,
          validatedAtIso: "2026-04-12T00:00:00.000Z",
          updatedAtIso: "2026-04-12T00:00:00.000Z",
          contentHash: computeHeatMapRefContentHash(refs),
        }),
      },
    ]);

    const result = await new HeatMapRefDisplayService().readHeatMapRefDisplayTable();

    expect(result.referenceState).toEqual({
      status: "validated",
      sourceVersion: null,
      notice: "Reference: validated current · version unavailable.",
    });
    expect(result.rows[1]?.slice(1, 10)).toEqual(["—", "0", "0", "0", "0", "0", "0", "0", "0"]);
    expect(result.copyText).toContain("TH19,TH18");
    expect(result.copyText).toContain("—,0,0,0,0,0,0,0,0");
  });

  it("labels an independently verified historical baseline as informational", async () => {
    prismaMock.heatMapRef.findMany.mockResolvedValue([...HEAT_MAP_REF_SEED_ROWS]);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([]);

    const result = await new HeatMapRefDisplayService().readHeatMapRefDisplayTable();

    expect(result.referenceState).toEqual({
      status: "historical",
      sourceVersion: "bootstrap-2026-08-21",
      notice: "Reference: verified historical legacy-v1 baseline · version bootstrap-2026-08-21 · informational only · current validation unavailable.",
    });
    expect(result.rows[0]).toContain("TH19");
    expect(result.rows[1]?.[1]).toBe("—");
    expect(result.copyText.length).toBeLessThan(2000);
  });

  it("labels blocked current provenance without exposing the stored reason text", async () => {
    const refs = [makeHeatMapRef()];
    prismaMock.heatMapRef.findMany.mockResolvedValue(refs);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([
      {
        value: JSON.stringify({
          version: 1,
          status: "blocked",
          blockReasonCode: "th19_integrity",
          reason: "private operator detail that must not be rendered",
          validatedAtIso: null,
          updatedAtIso: "2026-04-12T00:00:00.000Z",
          contentHash: null,
        }),
      },
    ]);

    const result = await new HeatMapRefDisplayService().readHeatMapRefDisplayTable();

    expect(result.referenceState.status).toBe("blocked");
    expect(result.referenceState.notice).toContain("th19_integrity");
    expect(result.referenceState.notice).not.toContain("private operator detail");
  });

  it("renders one compact native table with truthful unknowns, zeroes, clans, and copy parity", async () => {
    prismaMock.nativeHeatMapReferenceHead = {};
    vi.spyOn(NativeHeatMapReferencePublicationService.prototype, "readCurrent").mockResolvedValue({
      status: "CURRENT",
      informationalOnly: true,
      reason: null,
      generationId: "cmwuba01p0001104anu6a4d6u",
      fenceToken: 1n,
      profileVersion: "native-reference-v2",
      policyVersion: "native-provisional-v1",
      sampleThreshold: 5,
      evaluationAt: new Date("2026-11-23T00:00:00.000Z"),
      createdAt: new Date("2026-11-23T00:00:00.000Z"),
      bands: [
        { weightMinInclusive: 7_300_001, weightMaxInclusive: 7_400_000 },
        { weightMinInclusive: 7_400_001, weightMaxInclusive: 7_500_000 },
      ],
      targets: [
        ...Array.from({ length: 10 }, (_, index) => ({
          bandOrdinal: 0,
          bucketId: ["TH19", "TH18", "TH17", "TH16", "TH15", "TH14", "TH13", "TH12", "TH11", "TH10_OR_LOWER"][index]!,
          status: index === 0 ? "UNKNOWN" as const : "SUPPORTED" as const,
          targetCount: index === 0 ? null : index === 1 ? 0 : 1,
          qualifyingClanCount: 5,
          sampleCount: 5,
          reasonCode: index === 0 ? "insufficient_source" : null,
        })),
        ...Array.from({ length: 10 }, (_, index) => ({
          bandOrdinal: 1,
          bucketId: ["TH19", "TH18", "TH17", "TH16", "TH15", "TH14", "TH13", "TH12", "TH11", "TH10_OR_LOWER"][index]!,
          status: "SUPPORTED" as const,
          targetCount: index === 0 ? 0 : index === 1 ? 1 : 0,
          qualifyingClanCount: 5,
          sampleCount: 5,
          reasonCode: null,
        })),
      ],
    });
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([]);

    const result = await new HeatMapRefDisplayService().readHeatMapRefDisplayTable();

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toEqual([
      "Band", "TH19", "TH18", "TH17", "TH16", "TH15", "TH14", "TH13", "TH12", "TH11", "TH10 or lower", "Clans",
    ]);
    expect(result.rows[1]?.[0]).toBe("7,300,001 - 7,400,000");
    expect(result.rows[1]?.slice(1)).toEqual(["?", "0", "1", "1", "1", "1", "1", "1", "1", "1", "5"]);
    expect(result.rows.flat().join(" ")).not.toContain("Match%");
    expect(result.copyText).toContain("WeightMin,WeightMax,TH19,TH18");
    expect(result.copyText).toContain("7300001,7400000,?,0,1,1,1,1,1,1,1,1,5");
    expect(result.copyText).not.toContain("legacy");
    expect(result.referenceState.notice).toContain("generation cmwuba01p0001104anu6a4d6u");
    expect(result.referenceState.notice).toContain("supported bands 1/2");

    const direct = buildNativeReferenceDisplayForTest((await new NativeHeatMapReferencePublicationService(prismaMock as never).readCurrent()) as never);
    expect(direct.rows).toEqual(result.rows);
    expect(buildNativeReferenceNoticeForTest((await new NativeHeatMapReferencePublicationService(prismaMock as never).readCurrent()) as never)).toContain("fence");
  });
});
