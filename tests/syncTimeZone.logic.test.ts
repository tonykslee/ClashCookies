import { describe, expect, it } from "vitest";
import { normalizeSyncTimeZone } from "../src/services/syncTimeZone";

describe("sync time zone normalization", () => {
  it("accepts canonical IANA region timezones", () => {
    expect(normalizeSyncTimeZone("America/New_York")).toBe("America/New_York");
    expect(normalizeSyncTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(normalizeSyncTimeZone("UTC")).toBe("UTC");
  });

  it("normalizes supported US aliases to canonical region timezones", () => {
    expect(normalizeSyncTimeZone(" EST ")).toBe("America/New_York");
    expect(normalizeSyncTimeZone("EDT")).toBe("America/New_York");
    expect(normalizeSyncTimeZone("PST")).toBe("America/Los_Angeles");
    expect(normalizeSyncTimeZone("pdt")).toBe("America/Los_Angeles");
    expect(normalizeSyncTimeZone("CT")).toBe("America/Chicago");
  });

  it("canonicalizes alternate IANA aliases to region timezones", () => {
    expect(normalizeSyncTimeZone("US/Eastern")).toBe("America/New_York");
    expect(normalizeSyncTimeZone("US/Pacific")).toBe("America/Los_Angeles");
  });

  it("rejects fixed-offset and invalid timezone identifiers", () => {
    expect(normalizeSyncTimeZone("Etc/GMT+5")).toBeNull();
    expect(normalizeSyncTimeZone("Bad/Timezone")).toBeNull();
    expect(normalizeSyncTimeZone("")).toBeNull();
  });
});
