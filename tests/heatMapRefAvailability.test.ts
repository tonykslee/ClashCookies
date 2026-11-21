import { describe, expect, it, vi } from "vitest";
import {
  HEAT_MAP_REF_REFERENCE_INTEGRITY_KEY,
  parseHeatMapRefReferenceAvailability,
  readHeatMapRefReferenceAvailability,
} from "../src/helper/heatMapRefAvailability";
import { computeHeatMapRefContentHash } from "../src/helper/heatMapRefRebuild";

const rows = [
  {
    weightMinInclusive: 0,
    weightMaxInclusive: 9_999_999,
    th18Count: 3,
    th17Count: 6,
    th16Count: 7,
    th15Count: 9,
    th14Count: 9,
    th13Count: 8,
    th12Count: 5,
    th11Count: 2,
    th10OrLowerCount: 0,
    contributingClanCount: 1,
  },
];

function validatedRecord() {
  return JSON.stringify({
    version: 1,
    status: "validated",
    blockReasonCode: null,
    reason: null,
    validatedAtIso: "2026-11-21T00:00:00.000Z",
    updatedAtIso: "2026-11-21T00:00:00.000Z",
    contentHash: computeHeatMapRefContentHash(rows),
  });
}

describe("HeatMapRef reference availability", () => {
  it("accepts only versioned validated provenance matched to the actual rows", async () => {
    const settings = {
      get: vi.fn(async (key: string) => {
        expect(key).toBe(HEAT_MAP_REF_REFERENCE_INTEGRITY_KEY);
        return validatedRecord();
      }),
    };

    const availability = await readHeatMapRefReferenceAvailability({
      settings,
      heatMapRefs: rows,
    });

    expect(availability.status).toBe("validated");
  });

  it("rejects a valid-looking record when the current rows do not match its hash", async () => {
    const availability = await readHeatMapRefReferenceAvailability({
      settings: { get: vi.fn(async () => validatedRecord()) },
      heatMapRefs: [{ ...rows[0], th18Count: 4 }],
    });

    expect(availability.status).toBe("unknown");
    expect(availability.warning).toContain("does not match");
  });

  it.each([
    ["missing version", { status: "validated" }],
    ["invalid timestamp", { version: 1, status: "validated", validatedAtIso: "yesterday" }],
    ["invalid hash", { version: 1, status: "validated", validatedAtIso: "2026-11-21T00:00:00.000Z", updatedAtIso: "2026-11-21T00:00:00.000Z", contentHash: "not-sha256", blockReasonCode: null, reason: null }],
    ["incomplete JSON", { version: 1, status: "validated", validatedAtIso: "2026-11-21T00:00:00.000Z", updatedAtIso: "2026-11-21T00:00:00.000Z", contentHash: null, blockReasonCode: null, reason: null }],
  ])("returns UNKNOWN for %s provenance", (_label, record) => {
    expect(parseHeatMapRefReferenceAvailability(JSON.stringify(record)).status).toBe("unknown");
  });

  it("maps pending and missing provenance to UNKNOWN while preserving blocked records", () => {
    expect(parseHeatMapRefReferenceAvailability(JSON.stringify({
      version: 1,
      status: "pending",
      blockReasonCode: null,
      reason: "validation is in progress",
      validatedAtIso: null,
      updatedAtIso: "2026-11-21T00:00:00.000Z",
      contentHash: null,
    })).status).toBe("unknown");
    expect(parseHeatMapRefReferenceAvailability(null).status).toBe("unknown");
    expect(parseHeatMapRefReferenceAvailability(JSON.stringify({
      version: 1,
      status: "blocked",
      blockReasonCode: "th19_integrity",
      reason: "TH19 evidence",
      validatedAtIso: null,
      updatedAtIso: "2026-11-21T00:00:00.000Z",
      contentHash: null,
    })).status).toBe("retained_unverified");
  });
});
