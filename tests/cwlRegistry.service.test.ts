import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    deleteMany: vi.fn(),
  },
  cwlRotationPlan: {
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(async (arg: any) => {
    if (typeof arg === "function") {
      return arg(txMock);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return arg;
  }),
}));

const txMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    deleteMany: vi.fn(),
  },
  cwlRotationPlan: {
    updateMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  addCwlClanTagsForSeason,
  ensureAndHydrateCwlTrackedClanMetadataForSeason,
  hydrateMissingCwlClanNamesForSeason,
  removeTrackedClanTagFromRegistries,
  refreshCwlTrackedClanMetadataForSeason,
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
    prismaMock.cwlTrackedClan.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlPlayerClanSeason.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlRotationPlan.updateMany.mockResolvedValue({ count: 0 });
    txMock.cwlTrackedClan.findFirst.mockResolvedValue(null);
    txMock.cwlTrackedClan.deleteMany.mockResolvedValue({ count: 0 });
    txMock.cwlPlayerClanSeason.deleteMany.mockResolvedValue({ count: 0 });
    txMock.cwlRotationPlan.updateMany.mockResolvedValue({ count: 0 });
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
        { season: "2026-03", tag: "#PYLQ0289", name: null, leagueLabel: null },
        { season: "2026-03", tag: "#QGRJ2222", name: null, leagueLabel: null },
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
          return { name: "CWL Alpha", warLeague: { name: "Champion League II" } };
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
        OR: [{ name: null }, { name: "" }, { leagueLabel: null }, { leagueLabel: "" }],
      },
      data: {
        name: "CWL Alpha",
        leagueLabel: "Champion League II",
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

  it("ensures tracked CWL rows and hydrates clan name and league label in one pass", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      { tag: "#PYLQ0289" },
      { tag: "#QGRJ2222" },
    ]);
    prismaMock.cwlTrackedClan.updateMany.mockResolvedValue({ count: 1 });
    const cocService = {
      getClan: vi.fn(async (tag: string) => ({
        name: tag === "#PYLQ0289" ? "CWL Alpha" : "CWL Beta",
        warLeague: { name: tag === "#PYLQ0289" ? "Champion League II" : "Champion League I" },
      })),
    };

    const result = await ensureAndHydrateCwlTrackedClanMetadataForSeason({
      clanTags: ["#PYLQ0289", "#QGRJ2222"],
      season: "2026-03",
      cocService: cocService as any,
    });

    expect(prismaMock.cwlTrackedClan.createMany).toHaveBeenCalledWith({
      data: [
        { season: "2026-03", tag: "#PYLQ0289", name: null, leagueLabel: null },
        { season: "2026-03", tag: "#QGRJ2222", name: null, leagueLabel: null },
      ],
      skipDuplicates: true,
    });
    expect(cocService.getClan).toHaveBeenCalledWith("#PYLQ0289");
    expect(cocService.getClan).toHaveBeenCalledWith("#QGRJ2222");
    expect(prismaMock.cwlTrackedClan.updateMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        tag: "#PYLQ0289",
        OR: [{ name: null }, { name: "" }, { leagueLabel: null }, { leagueLabel: "" }],
      },
      data: {
        name: "CWL Alpha",
        leagueLabel: "Champion League II",
      },
    });
    expect(prismaMock.cwlTrackedClan.updateMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        tag: "#QGRJ2222",
        OR: [{ name: null }, { name: "" }, { leagueLabel: null }, { leagueLabel: "" }],
      },
      data: {
        name: "CWL Beta",
        leagueLabel: "Champion League I",
      },
    });
    expect(result).toEqual({
      season: "2026-03",
      requestedCount: 2,
      ensuredCount: 0,
      hydratedCount: 2,
      skippedCount: 0,
    });
  });

  it("force refreshes CWL tracked clan metadata even when current values are already populated", async () => {
    prismaMock.cwlTrackedClan.createMany.mockResolvedValue({ count: 1 });
    prismaMock.cwlTrackedClan.updateMany.mockResolvedValue({ count: 1 });
    const cocService = {
      getClan: vi.fn(async () => ({
        name: "CWL Alpha",
        warLeague: { name: "Champion League I" },
      })),
    };

    const result = await refreshCwlTrackedClanMetadataForSeason({
      clanTags: ["#PYLQ0289"],
      season: "2026-03",
      cocService: cocService as any,
    });

    expect(prismaMock.cwlTrackedClan.createMany).toHaveBeenCalledWith({
      data: [{ season: "2026-03", tag: "#PYLQ0289", name: null, leagueLabel: null }],
      skipDuplicates: true,
    });
    expect(cocService.getClan).toHaveBeenCalledWith("#PYLQ0289");
    expect(prismaMock.cwlTrackedClan.updateMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        tag: "#PYLQ0289",
      },
      data: {
        name: "CWL Alpha",
        leagueLabel: "Champion League I",
      },
    });
    expect(result).toEqual({
      season: "2026-03",
      requestedCount: 1,
      ensuredCount: 1,
      hydratedCount: 1,
      skippedCount: 0,
    });
  });

  it("deactivates current-season active CWL rotation plans when a tracked clan is removed", async () => {
    txMock.cwlTrackedClan.findFirst.mockResolvedValue({ id: "tracked-1" } as any);
    txMock.cwlTrackedClan.deleteMany.mockResolvedValue({ count: 1 });
    txMock.cwlPlayerClanSeason.deleteMany.mockResolvedValue({ count: 2 });
    txMock.cwlRotationPlan.updateMany.mockResolvedValue({ count: 3 });

    const result = await removeTrackedClanTagFromRegistries({
      tag: "#2QG2C08UP",
      type: "CWL",
      season: "2026-03",
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.cwlTrackedClan.findFirst).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        tag: "#2QG2C08UP",
      },
      select: { id: true },
    });
    expect(txMock.cwlTrackedClan.deleteMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        tag: "#2QG2C08UP",
      },
    });
    expect(txMock.cwlPlayerClanSeason.deleteMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        cwlClanTag: "#2QG2C08UP",
      },
    });
    expect(txMock.cwlRotationPlan.updateMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        clanTag: "#2QG2C08UP",
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });
    expect(result).toEqual({
      outcome: "removed",
      tag: "#2QG2C08UP",
      removedFrom: "CWL",
      season: "2026-03",
      removedCount: 3,
    });
  });

  it("keeps inactive and other-season CWL rotation plans untouched when a tracked clan is removed", async () => {
    txMock.cwlTrackedClan.findFirst.mockResolvedValue({ id: "tracked-1" } as any);
    txMock.cwlTrackedClan.deleteMany.mockResolvedValue({ count: 1 });
    txMock.cwlPlayerClanSeason.deleteMany.mockResolvedValue({ count: 0 });
    txMock.cwlRotationPlan.updateMany.mockResolvedValue({ count: 1 });

    await removeTrackedClanTagFromRegistries({
      tag: "#2QG2C08UP",
      type: "CWL",
      season: "2026-03",
    });

    expect(txMock.cwlRotationPlan.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.cwlRotationPlan.updateMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        clanTag: "#2QG2C08UP",
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });
  });
});
