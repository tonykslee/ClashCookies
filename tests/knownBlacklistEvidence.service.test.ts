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
      { opponentTag: "lcyq", opponentInfo: "bLaCkLiStEd" },
      { opponentTag: "#PYLQ", opponentInfo: "BLACKLISTED" },
      { opponentTag: "#QGRJ", opponentInfo: "FWA" },
    ]);

    const result = await service.resolve(["#LCYQ", "#PYLQ", "#QGRJ"]);

    expect(result).toEqual(new Map([
      ["#LCYQ", "known_blacklist_registry"],
    ]));
  });

  it("allows feed evidence for a tag absent from the registry", async () => {
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      { opponentTag: "#LCYQ", opponentInfo: " blacklisted " },
    ]);

    await expect(service.resolve(["#LCYQ"])).resolves.toEqual(new Map([
      ["#LCYQ", "known_blacklist_fwa_war_log"],
    ]));
  });
});
