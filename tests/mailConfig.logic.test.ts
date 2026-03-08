import { describe, expect, it } from "vitest";
import { MATCH_MAIL_CONFIG_DEFAULT, parseMatchMailConfig } from "../src/commands/fwa/mailConfig";

describe("mail config parsing", () => {
  it("includes new war-identity defaults when config is missing", () => {
    const parsed = parseMatchMailConfig(null);
    expect(parsed).toEqual(MATCH_MAIL_CONFIG_DEFAULT);
  });

  it("normalizes war identity fields from persisted payload", () => {
    const parsed = parseMatchMailConfig({
      version: 1,
      data: {
        lastWarId: "12345",
        lastOpponentTag: "#abC123",
      },
    } as never);

    expect(parsed.lastWarId).toBe("12345");
    expect(parsed.lastOpponentTag).toBe("ABC123");
  });
});
