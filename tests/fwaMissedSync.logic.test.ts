import { describe, expect, it } from "vitest";
import { isMissedSyncClanForTest } from "../src/commands/Fwa";

describe("isMissedSyncClanForTest", () => {
  const baseline = Date.UTC(2026, 2, 1, 8, 0, 0);
  const twoHoursMs = 2 * 60 * 60 * 1000;

  it("returns false when baseline is unknown", () => {
    expect(
      isMissedSyncClanForTest({
        baselineWarStartMs: null,
        clanWarState: "notInWar",
        clanWarStartMs: null,
        nowMs: baseline + twoHoursMs + 1,
      })
    ).toBe(false);
  });

  it("marks notInWar clan as missed sync after 2h from baseline", () => {
    expect(
      isMissedSyncClanForTest({
        baselineWarStartMs: baseline,
        clanWarState: "notInWar",
        clanWarStartMs: null,
        nowMs: baseline + twoHoursMs + 1,
      })
    ).toBe(true);
  });

  it("marks late-started clan as missed sync when start is >2h after baseline", () => {
    expect(
      isMissedSyncClanForTest({
        baselineWarStartMs: baseline,
        clanWarState: "preparation",
        clanWarStartMs: baseline + twoHoursMs + 60 * 1000,
        nowMs: baseline + twoHoursMs + 60 * 1000,
      })
    ).toBe(true);
  });

  it("does not mark clan as missed sync when start is within 2h window", () => {
    expect(
      isMissedSyncClanForTest({
        baselineWarStartMs: baseline,
        clanWarState: "inWar",
        clanWarStartMs: baseline + twoHoursMs - 1,
        nowMs: baseline + twoHoursMs + 1,
      })
    ).toBe(false);
  });
});
