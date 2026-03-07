import { describe, expect, it } from "vitest";
import { inferMatchTypeFromPointsSnapshotsForTest } from "../src/commands/Fwa";

describe("fwa match inference from points snapshots", () => {
  it("infers MM when opponent points are unavailable", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: null, activeFwa: null }
    );

    expect(inferred).toBe("MM");
  });

  it("infers BL when opponent points exist but Active FWA is NO", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: 1234, activeFwa: false }
    );

    expect(inferred).toBe("BL");
  });

  it("infers FWA when opponent points exist and FWA state is not negative", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: 1234, activeFwa: null }
    );

    expect(inferred).toBe("FWA");
  });
});

