import { describe, expect, it } from "vitest";
import { buildWarMailNextRefreshLabelForTest } from "../src/commands/Fwa";
import { buildNotifyNextRefreshLabelForTest } from "../src/services/WarEventLogService";

describe("20-minute refresh loop labels", () => {
  it("war-mail label advances with time", () => {
    expect(buildWarMailNextRefreshLabelForTest(20 * 60 * 1000, 0)).toBe(
      "Next refresh <t:1200:R>"
    );
    expect(buildWarMailNextRefreshLabelForTest(20 * 60 * 1000, 60_000)).toBe(
      "Next refresh <t:1260:R>"
    );
  });

  it("notify label advances with time", () => {
    expect(buildNotifyNextRefreshLabelForTest(20 * 60 * 1000, 0)).toBe(
      "Next refresh <t:1200:R>"
    );
    expect(buildNotifyNextRefreshLabelForTest(20 * 60 * 1000, 60_000)).toBe(
      "Next refresh <t:1260:R>"
    );
  });
});
