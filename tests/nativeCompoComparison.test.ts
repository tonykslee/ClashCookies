import { describe, expect, it } from "vitest";
import {
  calculateNativeCompoComparison,
  NATIVE_COMPO_COMPARISON_BUCKETS,
} from "../src/helper/nativeCompoComparison";

const native = {
  status: "CURRENT" as const,
  generationId: "generation-1",
  profileVersion: "native-reference-v2",
  policyVersion: "native-provisional-v1",
  sampleThreshold: 5,
  bands: [{ weightMinInclusive: 0, weightMaxInclusive: 10_000_000 }],
  targets: NATIVE_COMPO_COMPARISON_BUCKETS.map((bucketId) => ({
    bandOrdinal: 0,
    bucketId,
    status: "SUPPORTED" as const,
    targetCount: bucketId === "TH19" ? 5 : bucketId === "TH18" ? 10 : bucketId === "TH17" ? 10 : bucketId === "TH16" ? 8 : bucketId === "TH15" ? 5 : bucketId === "TH14" ? 4 : bucketId === "TH13" ? 3 : bucketId === "TH12" ? 2 : bucketId === "TH11" ? 2 : 1,
  })),
};

describe("native provisional composition comparison", () => {
  it("renders supported per-clan deltas including TH19", () => {
    const result = calculateNativeCompoComparison({
      native,
      totalWeight: 8_650_000,
      sourceCounts: { TH19: 7, TH18: 8, TH17: 10, TH16: 8, TH15: 5, TH14: 4, TH13: 3, TH12: 2, TH11: 2, TH10: 1, TH9: 0, TH8_OR_LOWER: 0 },
    });
    expect(result.status).toBe("SUPPORTED");
    expect(result.deltaByBucket.TH19).toBe(2);
    expect(result.score).not.toBeNull();
  });

  it("keeps unsupported bands and incomplete targets UNKNOWN", () => {
    const outOfBand = calculateNativeCompoComparison({
      native,
      totalWeight: 20_000_000,
      sourceCounts: { TH19: 50 },
    });
    expect(outOfBand.status).toBe("UNKNOWN");
    expect(outOfBand.deltaByBucket.TH19).toBeNull();

    const incomplete = calculateNativeCompoComparison({
      native: { ...native, targets: native.targets.map((target) => target.bucketId === "TH19" ? { ...target, status: "UNKNOWN" as const, targetCount: null } : target) },
      totalWeight: 8_650_000,
      sourceCounts: { TH19: 50 },
    });
    expect(incomplete.status).toBe("UNKNOWN");
    expect(incomplete.deltaByBucket.TH19).toBeNull();
  });
});
