import { describe, expect, it } from "vitest";
import { classifyTelemetryError } from "../src/services/telemetry/errorTaxonomy";

describe("telemetry error taxonomy", () => {
  it("classifies timeout errors", () => {
    const classified = classifyTelemetryError({
      code: "ECONNABORTED",
      message: "Request timeout",
    });
    expect(classified.category).toBe("timeout");
    expect(classified.timeout).toBe(true);
  });

  it("classifies permission errors", () => {
    const classified = classifyTelemetryError({
      code: 50013,
      message: "Missing Permissions",
    });
    expect(classified.category).toBe("permission");
    expect(classified.code).toBe("50013");
  });

  it("classifies upstream http errors", () => {
    const classified = classifyTelemetryError({
      response: { status: 503 },
    });
    expect(classified.category).toBe("upstream_api");
    expect(classified.code).toBe("HTTP_503");
  });

  it("defaults unknown errors to internal", () => {
    const classified = classifyTelemetryError(new Error("boom"));
    expect(classified.category).toBe("internal");
  });

  it("classifies missing CoC queue context explicitly", () => {
    const classified = classifyTelemetryError(new Error("COC_QUEUE_CONTEXT_MISSING:getClan"));
    expect(classified.category).toBe("internal");
    expect(classified.code).toBe("COC_QUEUE_CONTEXT_MISSING");
  });
});
