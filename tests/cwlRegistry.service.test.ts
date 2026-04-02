import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  addCwlClanTagsForSeason,
  hydrateMissingCwlClanNamesForSeason,
} from "../src/services/CwlRegistryService";

describe("CwlRegistryService helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T00:00:00.000Z"));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.createMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlTrackedClan.updateMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("creates new CWL rows with null names when clan lookups are unavailable", async () => {
    prismaMock.cwlTrackedClan.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tag: "#PYLQ0289" }, { tag: "#QGRJ2222" }]);

    const result = await addCwlClanTagsForSeason({
      rawTags: "[#PYLQ0289,#QGRJ2222]",
      season: "2026-03",
    });

    expect(prismaMock.cwlTrackedClan.createMany).toHaveBeenCalledWith({
      data: [
        { season: "2026-03", tag: "#PYLQ0289", name: null },
        { season: "2026-03", tag: "#QGRJ2222", name: null },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      season: "2026-03",
      added: ["#PYLQ0289", "#QGRJ2222"],
      alreadyExisting: [],
      invalid: [],
      duplicateInRequest: [],
    });
  });

  it("keeps result buckets correct for existing, invalid, and duplicate tags", async () => {
    prismaMock.cwlTrackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#QGRJ2222" }])
      .mockResolvedValueOnce([{ tag: "#PYLQ0289" }, { tag: "#QGRJ2222" }]);

    const result = await addCwlClanTagsForSeason({
      rawTags: "[#PYLQ0289,QGRJ2222,BADTAG,#PYLQ0289]",
      season: "2026-03",
    });

    expect(result.added).toEqual(["#PYLQ0289"]);
    expect(result.alreadyExisting).toEqual(["#QGRJ2222"]);
    expect(result.invalid).toEqual(["BADTAG"]);
    expect(result.duplicateInRequest).toEqual(["#PYLQ0289"]);
  });

  it("hydrates missing clan names only when lookups succeed and skips failures", async () => {
    prismaMock.cwlTrackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#PYLQ0289" }, { tag: "#QGRJ2222" }])
      .mockResolvedValueOnce([{ tag: "#PYLQ0289" }, { tag: "#QGRJ2222" }]);
    const cocService = {
      getClan: vi.fn(async (tag: string) => {
        if (tag === "#PYLQ0289") {
          return { name: "CWL Alpha" };
        }
        throw new Error("boom");
      }),
    };

    await hydrateMissingCwlClanNamesForSeason({
      rawTags: "[#PYLQ0289,#QGRJ2222]",
      season: "2026-03",
      cocService: cocService as any,
    });

    expect(prismaMock.cwlTrackedClan.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.cwlTrackedClan.updateMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        tag: "#PYLQ0289",
        OR: [{ name: null }, { name: "" }],
      },
      data: {
        name: "CWL Alpha",
      },
    });

    const infoLogs = (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => String(call[0] ?? ""),
    );
    expect(infoLogs.some((line) => line.includes("stage=cwl_tags_name_hydration_started"))).toBe(
      true,
    );
    expect(
      infoLogs.some((line) => line.includes("stage=cwl_tags_name_lookup")),
    ).toBe(true);
    expect(
      infoLogs.some((line) => line.includes("stage=cwl_tags_name_hydration_completed")),
    ).toBe(true);
  });

  it("does not throw when clan-name hydration lookups fail or time out", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([{ tag: "#PYLQ0289" }]);
    const cocService = {
      getClan: vi.fn().mockImplementation(
        () => new Promise(() => {
          /* intentionally unresolved */
        }),
      ),
    };

    const promise = hydrateMissingCwlClanNamesForSeason({
      rawTags: "[#PYLQ0289]",
      season: "2026-03",
      cocService: cocService as any,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(prismaMock.cwlTrackedClan.updateMany).not.toHaveBeenCalled();
    const errorLogs = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => String(call[0] ?? ""),
    );
    expect(errorLogs.some((line) => line.includes("stage=cwl_tags_name_lookup"))).toBe(true);
  });
});
