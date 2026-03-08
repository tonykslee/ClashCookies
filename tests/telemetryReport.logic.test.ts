import { describe, expect, it } from "vitest";
import {
  estimatePercentileFromBuckets,
  parseTelemetryPeriod,
} from "../src/services/telemetry/report";

describe("telemetry report helpers", () => {
  it("parses known report periods with fallback", () => {
    expect(parseTelemetryPeriod("24h")).toBe("24h");
    expect(parseTelemetryPeriod("7d")).toBe("7d");
    expect(parseTelemetryPeriod("30d")).toBe("30d");
    expect(parseTelemetryPeriod("bad")).toBe("24h");
  });

  it("estimates percentile from histogram buckets", () => {
    const p95 = estimatePercentileFromBuckets({
      lt250: 10,
      lt1000: 30,
      lt3000: 40,
      lt10000: 20,
      gte10000: 0,
      percentile: 0.95,
    });
    expect(p95).toBeGreaterThanOrEqual(3000);
    expect(p95).toBeLessThanOrEqual(10000);
  });
});
