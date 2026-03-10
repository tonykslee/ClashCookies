import { describe, expect, it } from "vitest";
import { normalizeCompoClanDisplayName } from "../src/helper/compoDisplay";

describe("normalizeCompoClanDisplayName", () => {
  it("removes one trailing -actual suffix for display", () => {
    expect(normalizeCompoClanDisplayName("Dark Empire-actual")).toBe("Dark Empire");
    expect(normalizeCompoClanDisplayName("Dark Empire -actual")).toBe("Dark Empire");
  });

  it("keeps names unchanged when -actual is not a trailing suffix", () => {
    expect(normalizeCompoClanDisplayName("Actual Warriors")).toBe("Actual Warriors");
    expect(normalizeCompoClanDisplayName("Dark Empire-actual-alpha")).toBe("Dark Empire-actual-alpha");
    expect(normalizeCompoClanDisplayName("Dark Empire-Actual")).toBe("Dark Empire-Actual");
  });

  it("does not replace non-trailing occurrences and only strips the final suffix", () => {
    expect(normalizeCompoClanDisplayName("Dark-actual Empire-actual")).toBe("Dark-actual Empire");
    expect(normalizeCompoClanDisplayName("Dark Empire-actual-actual")).toBe("Dark Empire-actual");
  });
});
