import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  raidRosterMember: {
    findMany: vi.fn(),
    createMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
}));

const todoSnapshotServiceMock = vi.hoisted(() => ({
  listSnapshotsByPlayerTags: vi.fn(),
  refreshSnapshotsForPlayerTags: vi.fn(),
}));

const playerCurrentServiceMock = vi.hoisted(() => ({
  listPlayerCurrentByTags: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/TodoSnapshotService", () => ({
  todoSnapshotService: todoSnapshotServiceMock,
}));

vi.mock("../src/services/PlayerCurrentService", () => ({
  playerCurrentService: playerCurrentServiceMock,
}));

import {
  addRaidRosterMembersForGuild,
  buildRaidRosterStatusEmbeds,
  buildRaidRosterStatusLine,
  parseRaidRosterPlayerTagsInput,
  listRaidRosterStatusRowsForGuild,
} from "../src/services/RaidRosterService";
import { getCachedTownHallEmojiMap, renderTownHallIcon } from "../src/helper/townHallEmoji";

describe("RaidRosterService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.raidRosterMember.findMany.mockResolvedValue([]);
    prismaMock.raidRosterMember.createMany.mockResolvedValue({ count: 0 });
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValue([]);
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockResolvedValue({ playerCount: 0, updatedCount: 0 });
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(new Map());
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

  it("loads roster status rows from snapshots, current player data, links, and activity fallbacks", async () => {
    prismaMock.raidRosterMember.findMany.mockResolvedValueOnce([
      { playerTag: "#2RVGJYLC0" },
      { playerTag: "#2QG2C08UP" },
      { playerTag: "#2QG2C08UQ" },
      { playerTag: "#2QG2C08UR" },
    ]);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValueOnce([
      {
        playerTag: "#2RVGJYLC0",
        playerName: "Snapshot Alpha",
        townHall: 15,
        raidAttacksUsed: 7,
      },
    ]);
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValueOnce(
      new Map([
        [
          "#2QG2C08UP",
          {
            playerTag: "#2QG2C08UP",
            playerName: "Current Bravo",
            townHall: 14,
          },
        ],
      ]),
    );
    prismaMock.playerLink.findMany.mockResolvedValueOnce([
      { playerTag: "#2QG2C08UP", discordUserId: "123456789012345678" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValueOnce([
      { tag: "#2QG2C08UQ", name: "Activity Charlie" },
    ]);

    const rows = await listRaidRosterStatusRowsForGuild({ guildId: "guild-1" });

    expect(todoSnapshotServiceMock.listSnapshotsByPlayerTags).toHaveBeenCalledWith({
      playerTags: ["#2RVGJYLC0", "#2QG2C08UP", "#2QG2C08UQ", "#2QG2C08UR"],
    });
    expect(playerCurrentServiceMock.listPlayerCurrentByTags).toHaveBeenCalledWith([
      "#2RVGJYLC0",
      "#2QG2C08UP",
      "#2QG2C08UQ",
      "#2QG2C08UR",
    ]);
    expect(rows).toEqual([
      {
        playerTag: "#2RVGJYLC0",
        playerName: "Snapshot Alpha",
        townHall: 15,
        discordUserId: null,
        completedRaidAttacks: 6,
      },
      {
        playerTag: "#2QG2C08UP",
        playerName: "Current Bravo",
        townHall: 14,
        discordUserId: "123456789012345678",
        completedRaidAttacks: 0,
      },
      {
        playerTag: "#2QG2C08UQ",
        playerName: "Activity Charlie",
        townHall: null,
        discordUserId: null,
        completedRaidAttacks: 0,
      },
      {
        playerTag: "#2QG2C08UR",
        playerName: "#2QG2C08UR",
        townHall: null,
        discordUserId: null,
        completedRaidAttacks: 0,
      },
    ]);
  });

  it("refreshes todo snapshots before building roster status rows", async () => {
    prismaMock.raidRosterMember.findMany.mockResolvedValueOnce([
      { playerTag: "#2RVGJYLC0" },
    ]);
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockResolvedValueOnce({
      playerCount: 1,
      updatedCount: 1,
    });
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValueOnce([
      {
        playerTag: "#2RVGJYLC0",
        playerName: "Live Alpha",
        townHall: 16,
        raidAttacksUsed: 6,
      },
    ]);
    const cocService = { getPlayerRaw: vi.fn() };

    const rows = await listRaidRosterStatusRowsForGuild({
      guildId: "guild-1",
      cocService: cocService as any,
    });

    expect(todoSnapshotServiceMock.refreshSnapshotsForPlayerTags).toHaveBeenCalledWith({
      playerTags: ["#2RVGJYLC0"],
      cocService,
    });
    expect(todoSnapshotServiceMock.listSnapshotsByPlayerTags).toHaveBeenCalledWith({
      playerTags: ["#2RVGJYLC0"],
    });
    expect(rows).toEqual([
      {
        playerTag: "#2RVGJYLC0",
        playerName: "Live Alpha",
        townHall: 16,
        discordUserId: null,
        completedRaidAttacks: 6,
      },
    ]);
  });

  it("renders best-effort roster status rows when snapshot refresh fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    prismaMock.raidRosterMember.findMany.mockResolvedValueOnce([
      { playerTag: "#2RVGJYLC0" },
    ]);
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockRejectedValueOnce(new Error("upstream down"));
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValueOnce([
      {
        playerTag: "#2RVGJYLC0",
        playerName: "Saved Alpha",
        townHall: 15,
        raidAttacksUsed: 2,
      },
    ]);

    const rows = await listRaidRosterStatusRowsForGuild({
      guildId: "guild-1",
      cocService: {} as any,
    });

    expect(rows[0]).toMatchObject({
      playerName: "Saved Alpha",
      townHall: 15,
      completedRaidAttacks: 2,
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("status_snapshot_refresh_failed"));
    warnSpy.mockRestore();
  });

  it("renders raid roster status lines and paginates large outputs", () => {
    const emojiMap = getCachedTownHallEmojiMap();
    const line = buildRaidRosterStatusLine({
      playerTag: "#2RVGJYLC0",
      playerName: "Snapshot Alpha",
      townHall: 15,
      discordUserId: "123456789012345678",
      completedRaidAttacks: 6,
    }, emojiMap);

    expect(line).toContain(renderTownHallIcon(15, emojiMap));
    expect(line).toContain("[Snapshot Alpha](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=2RVGJYLC0>)");
    expect(line).toContain("`#2RVGJYLC0`");
    expect(line).toContain("<@123456789012345678>");
    expect(line).toContain("6/6");
    expect(
      buildRaidRosterStatusLine({
        playerTag: "#2QG2C08UR",
        playerName: "#2QG2C08UR",
        townHall: null,
        discordUserId: null,
        completedRaidAttacks: 0,
      }, emojiMap),
    ).toContain(renderTownHallIcon(null, emojiMap));

    const embeds = buildRaidRosterStatusEmbeds(
      Array.from({ length: 80 }, (_value, index) => ({
        playerTag: ["#2RVGJYLC0", "#2QG2C08UP", "#2QG2C08UQ", "#2QG2C08UR"][index % 4],
        playerName: `Player ${index + 1}`,
        townHall: 15,
        discordUserId: null,
        completedRaidAttacks: index % 7,
      })),
      emojiMap,
    );

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds[0]?.toJSON().title).toContain("RAIDS Roster Status");
    expect(embeds[0]?.toJSON().description).toContain("Player 1");
    expect(embeds.at(-1)?.toJSON().footer?.text).toContain("Page");
  });
});
