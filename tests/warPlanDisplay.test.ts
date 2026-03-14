import { describe, expect, it } from "vitest";
import {
  buildComplianceWarPlanText,
  sanitizeWarPlanForEmbed,
} from "../src/services/warPlanDisplay";

describe("warPlanDisplay", () => {
  it("normalizes heading-style prefixes and keeps line order", () => {
    const text = [
      "# Title",
      "Line 1",
      "  ## Subtitle",
      "",
      "  - Keep this",
      "   ### Internal Header",
      "Line 2",
    ].join("\n");

    expect(sanitizeWarPlanForEmbed(text)?.split("\n")).toEqual([
      "Title",
      "Line 1",
      "  Subtitle",
      "",
      "  - Keep this",
      "   Internal Header",
      "Line 2",
    ]);
  });

  it("returns fallback when compliance warplan loses all content after removing the first line", () => {
    expect(buildComplianceWarPlanText("# Title")).toBe("No warplan details");
  });

  it("removes only the first line for compliance output", () => {
    const text = ["# Header", "Line 1", "Line 2"].join("\n");
    expect(buildComplianceWarPlanText(text)).toBe("Line 1\nLine 2");
  });
});
