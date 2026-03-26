import { describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => ({
  Prisma: { sql: (...args: unknown[]) => args },
}));

vi.mock("../src/prisma", () => ({
  prisma: {},
}));

import {
  formatClanTag,
  getRecruitmentCooldownDurationMs,
  normalizeClanTag,
  parseImageUrlsCsv,
  parseRecruitmentPlatform,
  toImageUrlsCsv,
} from "../src/services/RecruitmentService";

describe("recruitment service helpers", () => {
  it("normalizes and formats clan tags consistently", () => {
    expect(normalizeClanTag(" #ab12c ")).toBe("AB12C");
    expect(formatClanTag("ab12c")).toBe("#AB12C");
  });

  it("parses only supported recruitment platforms", () => {
    expect(parseRecruitmentPlatform(" Discord ")).toBe("discord");
    expect(parseRecruitmentPlatform("reddit")).toBe("reddit");
    expect(parseRecruitmentPlatform("BAND")).toBe("band");
    expect(parseRecruitmentPlatform("telegram")).toBeNull();
  });

  it("returns the correct cooldown durations per platform", () => {
    expect(getRecruitmentCooldownDurationMs("discord")).toBe(24 * 60 * 60 * 1000);
    expect(getRecruitmentCooldownDurationMs("band")).toBe(12 * 60 * 60 * 1000);
    expect(getRecruitmentCooldownDurationMs("reddit")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("parses image csv values with trimming, dedupe, and blank removal", () => {
    expect(
      parseImageUrlsCsv(
        " https://img1.example/a.png, https://img2.example/b.png , https://img1.example/a.png,   "
      )
    ).toEqual([
      "https://img1.example/a.png",
      "https://img2.example/b.png",
    ]);
    expect(parseImageUrlsCsv("   ")).toEqual([]);
  });

  it("joins image urls back into the stored csv format", () => {
    expect(
      toImageUrlsCsv(["https://img1.example/a.png", "https://img2.example/b.png"])
    ).toBe("https://img1.example/a.png, https://img2.example/b.png");
  });
});
