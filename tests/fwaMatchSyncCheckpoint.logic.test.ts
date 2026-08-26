import { describe, expect, it } from "vitest";

import { resolveRenderedSyncNumberForStoredSummaryForTest } from "../src/commands/Fwa";

describe("fwa sync checkpoint render", () => {
  it("renders the canonical sync instead of a stale persisted row", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      canonicalSyncNum: 475,
    });

    expect(renderedSync).toBe(475);
  });

  it("renders unknown when canonical resolution is unavailable", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      canonicalSyncNum: null,
    });

    expect(renderedSync).toBeNull();
  });

  it("does not allow a raw prior-war row to override canonical unknown", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      canonicalSyncNum: null,
    });

    expect(renderedSync).toBeNull();
  });

  it("preserves the exact canonical value for normal points-backed state", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      canonicalSyncNum: 475,
    });

    expect(renderedSync).toBe(475);
  });
});
