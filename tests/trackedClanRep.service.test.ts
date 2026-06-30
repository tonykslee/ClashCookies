import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTrackedClanRepForClan,
  listTrackedClanRepBadgesForPlayerTags,
  listTrackedClanRepDisplayRowsForClanTags,
  listTrackedClanRepTagsForClanTags,
  parseTrackedClanRepTagsInput,
  removeTrackedClanRepForClan,
  replaceTrackedClanRepsForClan,
} from "../src/services/TrackedClanRepService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  trackedClanRep: {
    findMany: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("TrackedClanRepService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([]);
    prismaMock.trackedClanRep.create.mockResolvedValue({});
    prismaMock.trackedClanRep.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("parses array-style, comma-separated, and space-separated rep tags with duplicate de-dupe", () => {
    expect(parseTrackedClanRepTagsInput("[#2RVGJYLC0,#PYLQ0289 #2RVGJYLC0]")).toEqual({
      validTags: ["#2RVGJYLC0", "#PYLQ0289"],
      invalidTags: [],
      duplicateTagsInRequest: ["#2RVGJYLC0"],
    });
  });

  it("reports invalid rep tags and preserves explicit clear-all input", () => {
    expect(parseTrackedClanRepTagsInput("BADTAG, #2RVGJYLC0")).toEqual({
      validTags: ["#2RVGJYLC0"],
      invalidTags: ["BADTAG"],
      duplicateTagsInRequest: [],
    });
    expect(parseTrackedClanRepTagsInput("[]")).toEqual({
      validTags: [],
      invalidTags: [],
      duplicateTagsInRequest: [],
    });
  });

  it("replaces stored rep rows with normalized deduped tags", async () => {
    const trackedClanRep = {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    };

    const saved = await replaceTrackedClanRepsForClan(
      { trackedClanRep } as any,
      {
        clanTag: "2QG2C08UP",
        playerTags: ["#2RVGJYLC0", "PYLQ0289", "#2RVGJYLC0"],
      },
    );

    expect(saved).toEqual(["#2RVGJYLC0", "#PYLQ0289"]);
    expect(trackedClanRep.deleteMany).toHaveBeenCalledWith({
      where: { clanTag: "#2QG2C08UP" },
    });
    expect(trackedClanRep.createMany).toHaveBeenCalledWith({
      data: [
        { clanTag: "#2QG2C08UP", playerTag: "#2RVGJYLC0" },
        { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
      ],
    });
  });

  it("creates one rep row with normalized tags and does not replace other rows", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });

    const result = await addTrackedClanRepForClan(prismaMock as any, {
      clanTag: "2qg2c08up",
      playerTag: "pylq0289",
    });

    expect(result).toEqual({
      outcome: "created",
      clanTag: "#2QG2C08UP",
      clanName: "Alpha Clan",
      playerTag: "#PYLQ0289",
    });
    expect(prismaMock.trackedClanRep.create).toHaveBeenCalledWith({
      data: {
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
      },
    });
    expect(prismaMock.trackedClanRep.createMany).not.toHaveBeenCalled();
  });

  it("reports already_exists when the unique key conflicts", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.trackedClanRep.create.mockRejectedValueOnce({ code: "P2002" });

    const result = await addTrackedClanRepForClan(prismaMock as any, {
      clanTag: "#2QG2C08UP",
      playerTag: "#PYLQ0289",
    });

    expect(result).toEqual({
      outcome: "already_exists",
      clanTag: "#2QG2C08UP",
      clanName: "Alpha Clan",
      playerTag: "#PYLQ0289",
    });
    expect(prismaMock.trackedClanRep.createMany).not.toHaveBeenCalled();
  });

  it("reports clan_not_found when the selected tracked clan is missing", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce(null);

    const result = await addTrackedClanRepForClan(prismaMock as any, {
      clanTag: "2QG2C08UP",
      playerTag: "PYLQ0289",
    });

    expect(result).toEqual({
      outcome: "clan_not_found",
      clanTag: "#2QG2C08UP",
      clanName: null,
      playerTag: "#PYLQ0289",
    });
    expect(prismaMock.trackedClanRep.create).not.toHaveBeenCalled();
    expect(prismaMock.trackedClanRep.createMany).not.toHaveBeenCalled();
  });

  it("removes one rep row without touching other reps", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.trackedClanRep.deleteMany.mockResolvedValueOnce({ count: 1 });

    const result = await removeTrackedClanRepForClan(prismaMock as any, {
      clanTag: "2qg2c08up",
      playerTag: "pylq0289",
    });

    expect(result).toEqual({
      outcome: "removed",
      clanTag: "#2QG2C08UP",
      clanName: "Alpha Clan",
      playerTag: "#PYLQ0289",
    });
    expect(prismaMock.trackedClanRep.deleteMany).toHaveBeenCalledWith({
      where: { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
    });
    expect(prismaMock.trackedClanRep.createMany).not.toHaveBeenCalled();
  });

  it("reports not_found when the one-row removal target is absent", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.trackedClanRep.deleteMany.mockResolvedValueOnce({ count: 0 });

    const result = await removeTrackedClanRepForClan(prismaMock as any, {
      clanTag: "#2QG2C08UP",
      playerTag: "#PYLQ0289",
    });

    expect(result).toEqual({
      outcome: "not_found",
      clanTag: "#2QG2C08UP",
      clanName: "Alpha Clan",
      playerTag: "#PYLQ0289",
    });
  });

  it("reports clan_not_found when removal targets a missing tracked clan", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce(null);

    const result = await removeTrackedClanRepForClan(prismaMock as any, {
      clanTag: "2QG2C08UP",
      playerTag: "PYLQ0289",
    });

    expect(result).toEqual({
      outcome: "clan_not_found",
      clanTag: "#2QG2C08UP",
      clanName: null,
      playerTag: "#PYLQ0289",
    });
    expect(prismaMock.trackedClanRep.deleteMany).not.toHaveBeenCalled();
  });

  it("bulk-loads rep rows by clan tag for detailed FWA rendering", async () => {
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", playerTag: "#2RVGJYLC0" },
      { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
      { clanTag: "#PYLQ0289", playerTag: "#G2R9RQLJQ" },
    ]);

    const rows = await listTrackedClanRepTagsForClanTags([
      "#2QG2C08UP",
      "#PYLQ0289",
      "#2QG2C08UP",
    ]);

    expect(rows.get("#2QG2C08UP")).toEqual(["#2RVGJYLC0", "#PYLQ0289"]);
    expect(rows.get("#PYLQ0289")).toEqual(["#G2R9RQLJQ"]);
    expect(prismaMock.trackedClanRep.findMany).toHaveBeenCalledWith({
      where: { clanTag: { in: ["#2QG2C08UP", "#PYLQ0289"] } },
      orderBy: [{ clanTag: "asc" }, { playerTag: "asc" }],
      select: { clanTag: true, playerTag: true },
    });
  });

  it("bulk-loads rendered rep badges by player tag with deterministic clan ordering and dedupe", async () => {
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([
      {
        clanTag: "#BETA001",
        playerTag: "#PYLQ0289",
        clan: {
          tag: "#BETA001",
          clanBadge: " <:badge-b:2> ",
          createdAt: new Date("2026-03-02T00:00:00.000Z"),
          mailConfig: { displayOrder: 2 },
        },
      },
      {
        clanTag: "#ALPHA001",
        playerTag: "#PYLQ0289",
        clan: {
          tag: "#ALPHA001",
          clanBadge: "<:badge-a:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
      {
        clanTag: "#ALPHA001",
        playerTag: "#QGRJ2222",
        clan: {
          tag: "#ALPHA001",
          clanBadge: "<:badge-a:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
      {
        clanTag: "#GAMMA001",
        playerTag: "#QGRJ2222",
        clan: {
          tag: "#GAMMA001",
          clanBadge: " ",
          createdAt: new Date("2026-03-03T00:00:00.000Z"),
          mailConfig: null,
        },
      },
      {
        clanTag: "#DELTA001",
        playerTag: "#QGRJ2222",
        clan: {
          tag: "#DELTA001",
          clanBadge: "<:badge-d:4>",
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
          mailConfig: null,
        },
      },
      {
        clanTag: "#BETA001",
        playerTag: "#QGRJ2222",
        clan: {
          tag: "#BETA001",
          clanBadge: "<:badge-b:2>",
          createdAt: new Date("2026-03-02T00:00:00.000Z"),
          mailConfig: { displayOrder: 2 },
        },
      },
    ]);

    const badges = await listTrackedClanRepBadgesForPlayerTags([
      "#qgrj2222",
      "#pylq0289",
      "#pylq0289",
      "bad-tag",
    ]);

    expect(badges.get("#PYLQ0289")).toEqual(["<:badge-a:1>", "<:badge-b:2>"]);
    expect(badges.get("#QGRJ2222")).toEqual(["<:badge-a:1>", "<:badge-b:2>", "<:badge-d:4>"]);
    expect(prismaMock.trackedClanRep.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClanRep.findMany).toHaveBeenCalledWith({
      where: { playerTag: { in: ["#QGRJ2222", "#PYLQ0289"] } },
      select: {
        clanTag: true,
        playerTag: true,
        clan: {
          select: {
            tag: true,
            clanBadge: true,
            createdAt: true,
            mailConfig: true,
          },
        },
      },
    });
  });

  it("bulk-loads tracked clan rep display rows in deterministic clan order and keeps empty clans", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: " Alpha Clan ",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        tag: "#2RVGJYLC0",
        name: "Beta Clan",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
      { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
      { clanTag: "#2RVGJYLC0", playerTag: "#QGRJ2222" },
    ]);

    const rows = await listTrackedClanRepDisplayRowsForClanTags(["#2rvgjylc0", "2qg2c08up", "bad-tag"]);

    expect(rows).toEqual([
      {
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        trackedClanSortOrder: 0,
        repPlayerTags: ["#PYLQ0289"],
      },
      {
        clanTag: "#2RVGJYLC0",
        clanName: "Beta Clan",
        trackedClanSortOrder: 1,
        repPlayerTags: ["#QGRJ2222"],
      },
    ]);
    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      where: { tag: { in: ["#2RVGJYLC0", "#2QG2C08UP"] } },
      select: { tag: true, name: true, createdAt: true },
    });
    expect(prismaMock.trackedClanRep.findMany).toHaveBeenCalledWith({
      where: { clanTag: { in: ["#2QG2C08UP", "#2RVGJYLC0"] } },
      orderBy: [{ clanTag: "asc" }, { playerTag: "asc" }],
      select: { clanTag: true, playerTag: true },
    });
  });

  it("returns all tracked clans even when some have no rep rows", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        tag: "#2RVGJYLC0",
        name: "Beta Clan",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([
      { clanTag: "#2RVGJYLC0", playerTag: "#PYLQ0289" },
    ]);

    const rows = await listTrackedClanRepDisplayRowsForClanTags(null);

    expect(rows).toEqual([
      {
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        trackedClanSortOrder: 0,
        repPlayerTags: [],
      },
      {
        clanTag: "#2RVGJYLC0",
        clanName: "Beta Clan",
        trackedClanSortOrder: 1,
        repPlayerTags: ["#PYLQ0289"],
      },
    ]);
  });
});
