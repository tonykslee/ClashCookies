import { describe, expect, it } from "vitest";
import {
  WAR_MAIL_COLOR_BL,
  WAR_MAIL_COLOR_FALLBACK,
  WAR_MAIL_COLOR_FWA_LOSE,
  WAR_MAIL_COLOR_FWA_WIN,
  WAR_MAIL_COLOR_MM,
  resolveWarMailEmbedColor,
} from "../src/commands/fwa/mailEmbedColor";

describe("war mail embed color mapping", () => {
  it("maps BL to black", () => {
    expect(resolveWarMailEmbedColor({ matchType: "BL", expectedOutcome: null })).toBe(
      WAR_MAIL_COLOR_BL
    );
  });

  it("maps MM to white", () => {
    expect(resolveWarMailEmbedColor({ matchType: "MM", expectedOutcome: null })).toBe(
      WAR_MAIL_COLOR_MM
    );
  });

  it("maps FWA WIN to green", () => {
    expect(resolveWarMailEmbedColor({ matchType: "FWA", expectedOutcome: "WIN" })).toBe(
      WAR_MAIL_COLOR_FWA_WIN
    );
  });

  it("maps FWA LOSE to red", () => {
    expect(resolveWarMailEmbedColor({ matchType: "FWA", expectedOutcome: "LOSE" })).toBe(
      WAR_MAIL_COLOR_FWA_LOSE
    );
  });

  it("uses fallback for unresolved states", () => {
    expect(resolveWarMailEmbedColor({ matchType: "FWA", expectedOutcome: "UNKNOWN" })).toBe(
      WAR_MAIL_COLOR_FALLBACK
    );
    expect(resolveWarMailEmbedColor({ matchType: "UNKNOWN", expectedOutcome: null })).toBe(
      WAR_MAIL_COLOR_FALLBACK
    );
  });
});

describe("war mail embed color downstream refresh behavior", () => {
  it("changes color when expected outcome flips on same FWA match", () => {
    const before = resolveWarMailEmbedColor({ matchType: "FWA", expectedOutcome: "WIN" });
    const after = resolveWarMailEmbedColor({ matchType: "FWA", expectedOutcome: "LOSE" });

    expect(before).toBe(WAR_MAIL_COLOR_FWA_WIN);
    expect(after).toBe(WAR_MAIL_COLOR_FWA_LOSE);
    expect(after).not.toBe(before);
  });

  it("changes color when match type changes on refresh", () => {
    const before = resolveWarMailEmbedColor({ matchType: "FWA", expectedOutcome: "WIN" });
    const after = resolveWarMailEmbedColor({ matchType: "BL", expectedOutcome: null });

    expect(before).toBe(WAR_MAIL_COLOR_FWA_WIN);
    expect(after).toBe(WAR_MAIL_COLOR_BL);
    expect(after).not.toBe(before);
  });
});
