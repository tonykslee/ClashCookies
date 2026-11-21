import { describe, expect, it, vi } from "vitest";
import {
  buildLegacyHeatMapRefBucketTargets,
  LEGACY_HEAT_MAP_REF_BUCKET_IDS,
  resolveHeatMapRefReference,
  validateLegacyHeatMapRefTargetsForTest,
} from "../src/helper/heatMapRefResolver";
import { computeHeatMapRefContentHash } from "../src/helper/heatMapRefRebuild";

const parent = {
  weightMinInclusive: 0,
  weightMaxInclusive: 100,
  th18Count: 3,
  th17Count: 6,
  th16Count: 7,
  th15Count: 9,
  th14Count: 9,
  th13Count: 8,
  th12Count: 5,
  th11Count: 2,
  th10OrLowerCount: 0,
  contributingClanCount: 2,
  sourceVersion: "historical-test",
  refreshedAt: new Date("2026-11-21T00:00:00.000Z"),
};

function validatedSettings() {
  return {
    get: vi.fn(async () => JSON.stringify({
      version: 1,
      status: "validated",
      blockReasonCode: null,
      reason: null,
      validatedAtIso: "2026-11-21T00:00:00.000Z",
      updatedAtIso: "2026-11-21T00:00:00.000Z",
      contentHash: computeHeatMapRefContentHash([parent]),
    })),
  };
}

function makeClient(targets: unknown[]) {
  return {
    heatMapRef: {
      findMany: vi.fn(async () => [parent]),
    },
    heatMapRefBucketTarget: {
      findMany: vi.fn(async () => targets),
    },
  } as never;
}

function makeParentOnlyClient() {
  return {
    heatMapRef: {
      findMany: vi.fn(async () => [parent]),
    },
  } as never;
}

describe("HeatMapRef normalized reference resolver", () => {
  it("round-trips exact legacy values, including zero and non-50 totals", () => {
    const targets = buildLegacyHeatMapRefBucketTargets([parent]);
    expect(targets).toHaveLength(9);
    expect(targets.find((row) => row.bucketId === "TH10_OR_LOWER")?.targetCount).toBe(0);
    expect(targets.reduce((sum, row) => sum + row.targetCount, 0)).toBe(49);
    expect(validateLegacyHeatMapRefTargetsForTest([parent], targets)).toEqual({
      ok: true,
      supportedBucketIds: LEGACY_HEAT_MAP_REF_BUCKET_IDS,
    });
  });

  it("treats an absent TH19 target as unsupported and never invents zero", () => {
    const targets = buildLegacyHeatMapRefBucketTargets([parent]);
    expect(targets.some((row) => row.bucketId === "TH19")).toBe(false);
    const result = validateLegacyHeatMapRefTargetsForTest([parent], targets);
    expect(result.ok).toBe(true);
  });

  it("fails closed when the normalized delegate is missing", async () => {
    const result = await resolveHeatMapRefReference({
      client: makeParentOnlyClient(),
      settings: validatedSettings(),
    });
    expect(result.normalizedState).toBe("unavailable");
    expect(result.availability.status).toBe("unknown");
    expect(result.supportedBucketIds).toEqual([]);
    expect(result.heatMapRefs).toEqual([parent]);
    expect(result.availability.warning).toContain("child-table reader is missing");
  });

  it("preserves factual parents but fails closed when the child query rejects", async () => {
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      heatMapRef: {
        findMany: vi.fn(async () => [parent]),
      },
      heatMapRefBucketTarget: {
        findMany: vi.fn(async () => {
          throw new Error("child database unavailable");
        }),
      },
    } as never;
    const result = await resolveHeatMapRefReference({
      client,
      settings: validatedSettings(),
    });
    expect(result.normalizedState).toBe("unavailable");
    expect(result.availability.status).toBe("unknown");
    expect(result.supportedBucketIds).toEqual([]);
    expect(result.heatMapRefs).toEqual([parent]);
    expect(result.availability.warning).toContain("factual composition observations remain available");
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining("code=child_query_failed"),
    );
    expect(warningSpy.mock.calls.flat().join(" ")).not.toContain("child database unavailable");
    warningSpy.mockRestore();
  });

  it.each([
    ["missing", (targets: any[]) => targets.slice(1)],
    ["extra", (targets: any[]) => [...targets, { ...targets[0], bucketId: "TH19" }]],
    ["tampered", (targets: any[]) => targets.map((row) => row.bucketId === "TH18" ? { ...row, targetCount: 4 } : row)],
    ["missing status", (targets: any[]) => targets.map((row) => row.bucketId === "TH18" ? { ...row, status: "MISSING", targetCount: null } : row)],
    ["invalid identifier", (targets: any[]) => targets.map((row) => row.bucketId === "TH18" ? { ...row, bucketId: "" } : row)],
    ["duplicate", (targets: any[]) => [...targets, { ...targets[0] }]],
    ["invalid count", (targets: any[]) => targets.map((row) => row.bucketId === "TH18" ? { ...row, targetCount: -1 } : row)],
  ])("returns UNKNOWN for %s normalized evidence", async (_label, mutate) => {
    const targets = buildLegacyHeatMapRefBucketTargets([parent]);
    const result = await resolveHeatMapRefReference({
      client: makeClient(mutate(targets)),
      settings: validatedSettings(),
    });
    expect(result.availability.status).toBe("unknown");
    expect(result.supportedBucketIds).toEqual([]);
    expect(result.heatMapRefs).toEqual([parent]);
  });

  it("accepts verified normalized legacy evidence without changing the parent projection", async () => {
    const targets = buildLegacyHeatMapRefBucketTargets([parent]);
    const result = await resolveHeatMapRefReference({
      client: makeClient(targets),
      settings: validatedSettings(),
    });
    expect(result.normalizedState).toBe("verified");
    expect(result.availability.status).toBe("validated");
    expect(result.supportedBucketIds).toEqual(LEGACY_HEAT_MAP_REF_BUCKET_IDS);
    expect(result.heatMapRefs).toEqual([parent]);
  });

  it("keeps legacy hash compatibility independent of normalized row ordering", async () => {
    const targets = buildLegacyHeatMapRefBucketTargets([parent]).reverse();
    const result = await resolveHeatMapRefReference({
      client: makeClient(targets),
      settings: validatedSettings(),
    });
    expect(result.availability.status).toBe("validated");
  });
});
