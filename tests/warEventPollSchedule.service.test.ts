import { describe, expect, it } from "vitest";
import {
  getDefaultWarEventPollIntervalMinutes,
  resolveWarEventPollIntervalMsFromEnv,
} from "../src/services/WarEventPollScheduleService";

describe("WarEventPollScheduleService", () => {
  it("defaults to a safer 15 minute war-event poll cadence", () => {
    expect(getDefaultWarEventPollIntervalMinutes()).toBe(15);
    expect(resolveWarEventPollIntervalMsFromEnv({} as NodeJS.ProcessEnv)).toBe(
      15 * 60 * 1000,
    );
  });

  it("respects an explicit poll interval override when provided", () => {
    expect(
      resolveWarEventPollIntervalMsFromEnv({
        WAR_EVENT_LOG_POLL_INTERVAL_MINUTES: "20",
      } as NodeJS.ProcessEnv),
    ).toBe(20 * 60 * 1000);
  });

  it("falls back to the safer default when the env value is invalid", () => {
    expect(
      resolveWarEventPollIntervalMsFromEnv({
        WAR_EVENT_LOG_POLL_INTERVAL_MINUTES: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(15 * 60 * 1000);
  });

  it("does not change ownership based on mirror polling mode", () => {
    expect(
      resolveWarEventPollIntervalMsFromEnv({
        POLLING_MODE: "mirror",
      } as NodeJS.ProcessEnv),
    ).toBe(15 * 60 * 1000);
  });
});
