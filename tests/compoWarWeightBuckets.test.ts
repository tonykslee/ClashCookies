import { describe, expect, it } from "vitest";
import {
  buildCompoWarBucketCounts,
  collapseCompoWarBucketCountsForDisplay,
} from "../src/helper/compoWarBucketCounts";
import {
  getCompoWarDisplayBucket,
  getCompoWarWeightBucket,
} from "../src/helper/compoWarWeightBuckets";

describe("shared WAR composition weight bands", () => {
  it("classifies both inclusive TH19 endpoints and preserves TH18", () => {
    expect(getCompoWarWeightBucket(181000)).toBe("TH19");
    expect(getCompoWarWeightBucket(190000)).toBe("TH19");
    expect(getCompoWarWeightBucket(180000)).toBe("TH18");
    expect(getCompoWarWeightBucket(171000)).toBe("TH18");
    expect(getCompoWarWeightBucket(170000)).toBe("TH17");
  });

  it("rejects gaps, malformed numbers, non-integers, and out-of-range weights", () => {
    for (const value of [180500, 170500, 190001, -1, 181000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getCompoWarWeightBucket(value)).toBeNull();
    }
    expect(getCompoWarWeightBucket(null)).toBeNull();
    expect(getCompoWarDisplayBucket(181000)).toBe("TH19");
    expect(getCompoWarDisplayBucket(180500)).toBeNull();
  });

  it("keeps mixed TH18 and TH19 counts explicit without creating a TH19 target", () => {
    const counts = buildCompoWarBucketCounts([
      { effectiveWeight: 181000 },
      { effectiveWeight: 190000 },
      { effectiveWeight: 180000 },
    ]);

    expect(counts).toMatchObject({ TH19: 2, TH18: 1 });
    expect(collapseCompoWarBucketCountsForDisplay(counts!)).toMatchObject({
      TH19: 2,
      TH18: 1,
    });
  });
});
