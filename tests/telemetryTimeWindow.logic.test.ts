import { describe, expect, it } from "vitest";
import {
  getPreviousCompletedWindow,
  isValidIanaTimeZone,
  normalizeCadenceHours,
} from "../src/services/telemetry/timeWindow";

describe("telemetry time-window helpers", () => {
  it("normalizes cadence bounds", () => {
    expect(normalizeCadenceHours(0)).toBe(1);
    expect(normalizeCadenceHours(24)).toBe(24);
    expect(normalizeCadenceHours(10000)).toBe(24 * 30);
  });

  it("validates IANA timezone strings", () => {
    expect(isValidIanaTimeZone("UTC")).toBe(true);
    expect(isValidIanaTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidIanaTimeZone("Bad/Timezone")).toBe(false);
  });

  it("builds previous completed windows in UTC order", () => {
    const now = new Date("2026-03-08T18:45:00.000Z");
    const window = getPreviousCompletedWindow(now, 6, "UTC");
    expect(window.start.getTime()).toBeLessThan(window.end.getTime());
    expect(window.end.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});
