import { beforeEach, describe, expect, it, vi } from "vitest";

const rosterWeightServiceMock = vi.hoisted(() => ({
  resolveRosterCurrentWeightRecords: vi.fn(),
}));

vi.mock("../src/services/RosterWeightService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/RosterWeightService")>(
    "../src/services/RosterWeightService",
  );
  return {
    ...actual,
    resolveRosterCurrentWeightRecords: rosterWeightServiceMock.resolveRosterCurrentWeightRecords,
  };
});

import { loadRosterSignupMinimumWeightLookup } from "../src/services/RosterSignupWeightService";

describe("RosterSignupWeightService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rosterWeightServiceMock.resolveRosterCurrentWeightRecords.mockResolvedValue(new Map());
  });

  it("marks a deferment-winning roster weight eligible and forwards roster scope", async () => {
    rosterWeightServiceMock.resolveRosterCurrentWeightRecords.mockResolvedValueOnce(
      new Map([
        [
          "#PL22CGC0",
          {
            playerTag: "#PL22CGC0",
            weight: 178000,
            weightSource: "WeightInputDeferment",
            weightMeasuredAt: new Date("2026-06-10T10:04:42.664Z"),
            trophies: null,
          },
        ],
      ]),
    );

    const result = await loadRosterSignupMinimumWeightLookup({
      playerTags: ["#pl22cgc0"],
      minimumWeight: 170000,
      guildId: "1324040917602013261",
      clanTag: "#2JCJYGRCY",
    });

    expect(rosterWeightServiceMock.resolveRosterCurrentWeightRecords).toHaveBeenCalledWith({
      playerTags: ["#PL22CGC0"],
      guildId: "1324040917602013261",
      clanTag: "#2JCJYGRCY",
    });
    expect(result.get("#PL22CGC0")).toEqual({
      playerTag: "#PL22CGC0",
      weight: 178000,
      weightSource: "WeightInputDeferment",
      weightMeasuredAt: new Date("2026-06-10T10:04:42.664Z"),
      trophies: null,
      minimumWeight: 170000,
      status: "eligible",
    });
  });

  it("keeps a lower resolved weight below the minimum even when scope is provided", async () => {
    rosterWeightServiceMock.resolveRosterCurrentWeightRecords.mockResolvedValueOnce(
      new Map([
        [
          "#PQL0289",
          {
            playerTag: "#PQL0289",
            weight: 164000,
            weightSource: "FWA",
            weightMeasuredAt: new Date("2026-06-04T12:44:51.860Z"),
            trophies: null,
          },
        ],
      ]),
    );

    const result = await loadRosterSignupMinimumWeightLookup({
      playerTags: ["#PQL0289"],
      minimumWeight: 170000,
      guildId: "1324040917602013261",
      clanTag: "#2JCJYGRCY",
    });

    expect(result.get("#PQL0289")?.status).toBe("below_minimum");
  });
});
