import { describe, expect, it } from "vitest";
import { selectNewestQualityEvidence } from "../src/scripts/diagnoseFwaWarMembersObservations";

describe("FWA WarMembers observation diagnostic", () => {
  it("selects the newest 20 quality revisions with deterministic tie ordering", () => {
    const revisions = Array.from({ length: 25 }, (_, index) => ({
      id: `evidence-${String(index + 1).padStart(2, "0")}`,
      firstObservedAt: new Date(Date.UTC(2026, 10, 23, 12, index)),
    }));

    const selected = selectNewestQualityEvidence(revisions);

    expect(selected).toHaveLength(20);
    expect(selected[0].id).toBe("evidence-25");
    expect(selected[19].id).toBe("evidence-06");
    expect(selected).not.toContainEqual(revisions[0]);
  });
});
