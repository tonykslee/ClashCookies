import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listTrackedClanRepTagsForClanTags,
  parseTrackedClanRepTagsInput,
  replaceTrackedClanRepsForClan,
} from "../src/services/TrackedClanRepService";

const prismaMock = vi.hoisted(() => ({
  trackedClanRep: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("TrackedClanRepService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClanRep.findMany.mockResolvedValue([]);
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
});
