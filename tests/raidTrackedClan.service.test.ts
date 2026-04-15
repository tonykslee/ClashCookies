import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  raidTrackedClan: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildRaidTrackedClanListLines,
  getRaidTrackedClanJoinTypeEmoji,
  listRaidTrackedClansForDisplay,
  parseRaidTrackedClanTagsInput,
  upsertRaidTrackedClansForTags,
} from "../src/services/RaidTrackedClanService";

describe("RaidTrackedClanService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.createMany.mockResolvedValue({ count: 0 });
    prismaMock.raidTrackedClan.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
  });

  it("normalizes and dedupes raid tags from mixed free-form input", () => {
    expect(parseRaidTrackedClanTagsInput("[#2RVGJYLC0, 2RVGJYLC0, BADTAG, #2QG2C08UP]")).toEqual({
      validTags: ["2RVGJYLC0", "2QG2C08UP"],
      invalidTags: ["BADTAG"],
      duplicateTagsInRequest: ["2RVGJYLC0"],
    });
  });

  it("creates a single raid tag with null upgrades when no manual upgrades are provided", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([]);
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ type: "open" }),
    };

    const result = await upsertRaidTrackedClansForTags({
      rawTags: "[#2RVGJYLC0]",
      cocService: cocService as any,
    });

    expect(prismaMock.raidTrackedClan.createMany).toHaveBeenCalledWith({
      data: [{ clanTag: "2RVGJYLC0", upgrades: null, joinType: null }],
      skipDuplicates: true,
    });
    expect(result.added).toEqual(["#2RVGJYLC0"]);
    expect(result.updated).toEqual([]);
    expect(result.alreadyExisting).toEqual([]);
    expect(prismaMock.raidTrackedClan.updateMany).toHaveBeenCalledWith({
      where: { clanTag: "2RVGJYLC0" },
      data: { joinType: "open" },
    });
  });

  it("updates a single raid tag with upgrades and keeps joinType refresh best-effort", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([{ clanTag: "2RVGJYLC0" }]);
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ type: "inviteOnly" }),
    };

    const result = await upsertRaidTrackedClansForTags({
      rawTags: "#2RVGJYLC0",
      upgrades: 3331,
      cocService: cocService as any,
    });

    expect(prismaMock.raidTrackedClan.updateMany).toHaveBeenCalledWith({
      where: { clanTag: { in: ["2RVGJYLC0"] } },
      data: { upgrades: 3331 },
    });
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(["#2RVGJYLC0"]);
    expect(result.alreadyExisting).toEqual([]);
    expect(prismaMock.raidTrackedClan.updateMany).toHaveBeenCalledWith({
      where: { clanTag: "2RVGJYLC0" },
      data: { joinType: "inviteOnly" },
    });
  });

  it("keeps existing upgrades when a raid tag is updated without upgrades", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([{ clanTag: "2RVGJYLC0" }]);
    const cocService = {
      getClan: vi.fn().mockRejectedValue(new Error("nope")),
    };

    const result = await upsertRaidTrackedClansForTags({
      rawTags: "#2RVGJYLC0",
      cocService: cocService as any,
    });

    expect(prismaMock.raidTrackedClan.createMany).not.toHaveBeenCalled();
    expect(prismaMock.raidTrackedClan.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { upgrades: expect.anything() },
      }),
    );
    expect(result.alreadyExisting).toEqual(["#2RVGJYLC0"]);
    expect(result.updated).toEqual([]);
  });

  it("renders join-status emoji and hyperlinks using persisted names when available", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2RVGJYLC0",
        upgrades: 3331,
        joinType: "open",
        createdAt: new Date("2026-04-15T00:00:00.000Z"),
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      { tag: "#2RVGJYLC0", name: "Vanilla" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([]);

    const rows = await listRaidTrackedClansForDisplay();
    const lines = buildRaidTrackedClanListLines(rows);

    expect(rows).toEqual([
      {
        clanTag: "2RVGJYLC0",
        clanName: "Vanilla",
        upgrades: 3331,
        joinType: "open",
        createdAt: new Date("2026-04-15T00:00:00.000Z"),
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);
    expect(lines[0]).toBe(
      "## 🟢 [Vanilla | 3331](<https://link.clashofclans.com/en?action=OpenClanProfile&tag=2RVGJYLC0>) `2RVGJYLC0`",
    );
    expect(getRaidTrackedClanJoinTypeEmoji("inviteOnly")).toBe("🟡");
    expect(getRaidTrackedClanJoinTypeEmoji("closed")).toBe("🔴");
    expect(getRaidTrackedClanJoinTypeEmoji(null)).toBe("⚪");
  });
});
