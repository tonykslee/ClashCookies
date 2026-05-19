import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  raidRosterMember: {
    findMany: vi.fn(),
    createMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  addRaidRosterMembersForGuild,
  parseRaidRosterPlayerTagsInput,
} from "../src/services/RaidRosterService";

describe("RaidRosterService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.raidRosterMember.findMany.mockResolvedValue([]);
    prismaMock.raidRosterMember.createMany.mockResolvedValue({ count: 0 });
  });

  it("normalizes mixed player tag input and reports invalid and duplicate tags", () => {
    expect(
      parseRaidRosterPlayerTagsInput("[#2RVGJYLC0, 2RVGJYLC0, BADTAG, #2QG2C08UP]"),
    ).toEqual({
      validTags: ["#2RVGJYLC0", "#2QG2C08UP"],
      invalidTags: ["BADTAG"],
      duplicateTagsInRequest: ["#2RVGJYLC0"],
    });
  });

  it("adds new roster members, preserves createdByDiscordUserId, and reports request duplicates", async () => {
    prismaMock.raidRosterMember.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { playerTag: "#2RVGJYLC0" },
        { playerTag: "#2QG2C08UP" },
      ]);

    const result = await addRaidRosterMembersForGuild({
      guildId: "guild-1",
      rawTags: "#2RVGJYLC0, 2QG2C08UP #2RVGJYLC0 BADTAG",
      createdByDiscordUserId: "user-1",
    });

    expect(prismaMock.raidRosterMember.createMany).toHaveBeenCalledWith({
      data: [
        { guildId: "guild-1", playerTag: "#2RVGJYLC0", createdByDiscordUserId: "user-1" },
        { guildId: "guild-1", playerTag: "#2QG2C08UP", createdByDiscordUserId: "user-1" },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      added: ["#2RVGJYLC0", "#2QG2C08UP"],
      alreadyOnRoster: ["#2RVGJYLC0"],
      invalidTags: ["BADTAG"],
      duplicateInRequest: ["#2RVGJYLC0"],
    });
  });

  it("reports existing roster entries without inserting duplicates", async () => {
    prismaMock.raidRosterMember.findMany
      .mockResolvedValueOnce([{ playerTag: "#2RVGJYLC0" }])
      .mockResolvedValueOnce([
        { playerTag: "#2RVGJYLC0" },
        { playerTag: "#2QG2C08UP" },
      ]);

    const result = await addRaidRosterMembersForGuild({
      guildId: "guild-1",
      rawTags: "#2RVGJYLC0 #2QG2C08UP",
    });

    expect(prismaMock.raidRosterMember.createMany).toHaveBeenCalledWith({
      data: [{ guildId: "guild-1", playerTag: "#2QG2C08UP", createdByDiscordUserId: null }],
      skipDuplicates: true,
    });
    expect(result.added).toEqual(["#2QG2C08UP"]);
    expect(result.alreadyOnRoster).toEqual(["#2RVGJYLC0"]);
    expect(result.invalidTags).toEqual([]);
  });
});
