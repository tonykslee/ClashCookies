import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KnownBlacklistEvidenceService,
  type KnownBlacklistEvidenceDb,
} from "../src/services/KnownBlacklistEvidenceService";

const prismaMock = vi.hoisted(() => ({
  blacklistClan: { findMany: vi.fn() },
  fwaClanWarLogCurrent: { findMany: vi.fn() },
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

function feedRow(
  opponentTag: string,
  opponentInfo: string | null,
  endTime: string,
  sourceSyncedAt = endTime,
) {
  return {
    opponentTag,
    opponentInfo,
    endTime: new Date(endTime),
    sourceSyncedAt: new Date(sourceSyncedAt),
  };
}

describe("KnownBlacklistEvidenceService", () => {
  let service: KnownBlacklistEvidenceService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new KnownBlacklistEvidenceService(
      prismaMock as unknown as KnownBlacklistEvidenceDb,
    );
    prismaMock.blacklistClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([]);
  });

  it("returns no evidence and performs no queries when candidates are invalid or empty", async () => {
    expect(await service.resolve(["", "not-a-tag", "###", "  "])).toEqual(new Map());
    expect(prismaMock.blacklistClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.fwaClanWarLogCurrent.findMany).not.toHaveBeenCalled();
  });

  it("normalizes and deduplicates candidates before one registry and one feed query", async () => {
    const result = await service.resolve(["lcyq", "#LCYQ", " #lcyq "]);

    expect(result).toEqual(new Map());
    expect(prismaMock.blacklistClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanWarLogCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.blacklistClan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clanTag: { in: ["#LCYQ"] } } }),
    );
    expect(prismaMock.fwaClanWarLogCurrent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          opponentTag: expect.objectContaining({ in: ["#LCYQ"] }),
        }),
      }),
    );
  });

  it("prefers active registry evidence and uses case-insensitive FWA war-log evidence", async () => {
    prismaMock.blacklistClan.findMany.mockResolvedValue([
      { clanTag: "#LCYQ", active: true },
      { clanTag: "#PYLQ", active: false },
    ]);
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      feedRow("lcyq", "bLaCkLiStEd", "2026-05-20T12:00:00.000Z"),
      feedRow("#PYLQ", "BLACKLISTED", "2026-05-20T12:00:00.000Z"),
      feedRow("#QGRJ", "FWA", "2026-05-20T12:00:00.000Z"),
    ]);

    const result = await service.resolve(["#LCYQ", "#PYLQ", "#QGRJ"]);

    expect(result).toEqual(new Map([
      ["#LCYQ", "known_blacklist_registry"],
    ]));
  });

  it("allows feed evidence for a tag absent from the registry", async () => {
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      feedRow("#LCYQ", " blacklisted ", "2026-05-20T12:00:00.000Z"),
    ]);

    await expect(service.resolve(["#LCYQ"])).resolves.toEqual(new Map([
      ["#LCYQ", "known_blacklist_fwa_war_log"],
    ]));
  });

  it.each([
    [
      "older Blacklisted plus newer FWA",
      [
        feedRow("#LCYQ", "Blacklisted", "2026-05-20T12:00:00.000Z"),
        feedRow("#LCYQ", "FWA", "2026-05-21T12:00:00.000Z"),
      ],
      false,
    ],
    [
      "older FWA plus newer Blacklisted",
      [
        feedRow("#LCYQ", "FWA", "2026-05-20T12:00:00.000Z"),
        feedRow("#LCYQ", "bLaCkLiStEd", "2026-05-21T12:00:00.000Z"),
      ],
      true,
    ],
    [
      "newer Friendly",
      [
        feedRow("#LCYQ", "Blacklisted", "2026-05-20T12:00:00.000Z"),
        feedRow("#LCYQ", "Friendly", "2026-05-21T12:00:00.000Z"),
      ],
      false,
    ],
    [
      "newer Unknown",
      [
        feedRow("#LCYQ", "Blacklisted", "2026-05-20T12:00:00.000Z"),
        feedRow("#LCYQ", "Unknown", "2026-05-21T12:00:00.000Z"),
      ],
      false,
    ],
    [
      "newer null classification",
      [
        feedRow("#LCYQ", "Blacklisted", "2026-05-20T12:00:00.000Z"),
        feedRow("#LCYQ", null, "2026-05-21T12:00:00.000Z"),
      ],
      false,
    ],
  ] as const)("uses the latest feed classification for %s", async (_label, rows, expected) => {
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue(rows);

    const result = await service.resolve(["#LCYQ"]);

    expect(result.has("#LCYQ")).toBe(expected);
  });

  it("lets the latest source timestamp break an end-time tie", async () => {
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      feedRow(
        "#LCYQ",
        "Blacklisted",
        "2026-05-21T12:00:00.000Z",
        "2026-05-21T12:00:00.000Z",
      ),
      feedRow(
        "#LCYQ",
        "FWA",
        "2026-05-21T12:00:00.000Z",
        "2026-05-21T13:00:00.000Z",
      ),
    ]);

    await expect(service.resolve(["#LCYQ"])).resolves.toEqual(new Map());
  });
});
