import { afterEach, describe, expect, it } from "vitest";
import {
  FwaFeedSchedulerService,
  toIntWithFallbackForTest,
} from "../src/services/fwa-feeds/FwaFeedSchedulerService";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("FwaFeedSchedulerService env integer parsing", () => {
  it("uses fallback for undefined/empty integer env values", () => {
    expect(toIntWithFallbackForTest(undefined, 6)).toBe(6);
    expect(toIntWithFallbackForTest("", 6)).toBe(6);
    expect(toIntWithFallbackForTest("   ", 6)).toBe(6);
    expect(toIntWithFallbackForTest("invalid", 6)).toBe(6);
    expect(toIntWithFallbackForTest("0", 6)).toBe(0);
  });

  it("keeps WAR_MEMBERS chunk default when env is empty instead of degrading to 1", () => {
    process.env.FWA_WAR_MEMBERS_SWEEP_CHUNK_SIZE = "";
    process.env.FWA_FEED_MAX_CONCURRENCY = "";

    const scheduler = new FwaFeedSchedulerService() as unknown as {
      config: { warMembersSweepChunkSize: number; maxConcurrency: number };
    };

    expect(scheduler.config.warMembersSweepChunkSize).toBe(6);
    expect(scheduler.config.maxConcurrency).toBe(4);
  });
});
