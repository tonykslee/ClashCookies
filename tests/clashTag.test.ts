import { describe, expect, it } from "vitest";
import {
  normalizeClashTagBare,
  normalizeClashTagBareInput,
  normalizeClashTagInput,
  normalizeClashTagWithHash,
} from "../src/helper/clashTag";
import {
  normalizeClanTag,
  normalizePlayerTag,
} from "../src/services/PlayerLinkService";
import {
  normalizeTag,
  normalizeTagBare,
} from "../src/services/war-events/core";

describe("Clash tag normalization", () => {
  it("accepts O as 0 in shared helper input canonicalization", () => {
    expect(normalizeClashTagInput("POYLGQ")).toBe("#P0YLGQ");
    expect(normalizeClashTagInput("#poylgq")).toBe("#P0YLGQ");
    expect(normalizeClashTagBareInput("POYLGQ")).toBe("P0YLGQ");
  });

  it("normalizes player and clan tags through the central services", () => {
    expect(normalizePlayerTag("POYLGQ")).toBe("#P0YLGQ");
    expect(normalizePlayerTag("#poylgq")).toBe("#P0YLGQ");
    expect(normalizeClanTag("POYLGQ")).toBe("#P0YLGQ");
    expect(normalizeClanTag("#poylgq")).toBe("#P0YLGQ");
  });

  it("normalizes war-event tags in both canonical and bare forms", () => {
    expect(normalizeTag("POYLGQ")).toBe("#P0YLGQ");
    expect(normalizeTagBare("POYLGQ")).toBe("P0YLGQ");
    expect(normalizeClashTagWithHash("POYLGQ")).toBe("#P0YLGQ");
    expect(normalizeClashTagBare("POYLGQ")).toBe("P0YLGQ");
  });

  it("keeps invalid tags invalid after O-to-0 conversion", () => {
    expect(normalizePlayerTag("ABCX123")).toBe("");
    expect(normalizeClanTag("ABCX123")).toBe("");
    expect(normalizeClashTagBare("ABCX123")).toBe("");
  });
});
