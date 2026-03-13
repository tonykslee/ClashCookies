import { afterEach, describe, expect, it, vi } from "vitest";

describe("fetch telemetry persistence guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../src/prisma");
    vi.doUnmock("../src/services/telemetry/ingest");
  });

  it("skips apiUsage writes when Prisma is not initialized", async () => {
    const upsert = vi.fn();
    const recordFetchEventTelemetry = vi.fn();

    vi.doMock("../src/prisma", () => ({
      prisma: {
        apiUsage: { upsert },
      },
      hasInitializedPrismaClient: () => false,
    }));
    vi.doMock("../src/services/telemetry/ingest", () => ({
      TelemetryIngestService: {
        getInstance: () => ({
          recordFetchEventTelemetry,
        }),
      },
    }));

    const { recordFetchEvent } = await import("../src/helper/fetchTelemetry");
    recordFetchEvent({
      namespace: "fwastats_weight",
      operation: "weight_age_fetch",
      source: "api",
    });

    expect(upsert).not.toHaveBeenCalled();
    expect(recordFetchEventTelemetry).toHaveBeenCalledTimes(1);
  });

  it("disables apiUsage persistence after synchronous Prisma write failure", async () => {
    const upsert = vi.fn(() => {
      throw new Error("sync failure");
    });
    const recordFetchEventTelemetry = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.doMock("../src/prisma", () => ({
      prisma: {
        apiUsage: { upsert },
      },
      hasInitializedPrismaClient: () => true,
    }));
    vi.doMock("../src/services/telemetry/ingest", () => ({
      TelemetryIngestService: {
        getInstance: () => ({
          recordFetchEventTelemetry,
        }),
      },
    }));

    const { recordFetchEvent } = await import("../src/helper/fetchTelemetry");
    recordFetchEvent({
      namespace: "fwastats_weight",
      operation: "weight_age_fetch",
      source: "api",
    });
    recordFetchEvent({
      namespace: "fwastats_weight",
      operation: "weight_age_fetch",
      source: "api",
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(recordFetchEventTelemetry).toHaveBeenCalledTimes(2);
  });
});
