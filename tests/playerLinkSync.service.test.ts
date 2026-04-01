import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { PlayerLinkSyncService } from "../src/services/PlayerLinkSyncService";

vi.mock("axios");

const mockedAxios = vi.mocked(axios, true);

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function makeTsv(rows: string[]): string {
  return rows.join("\n");
}

describe("PlayerLinkSyncService ClashPerk sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.playerLink.create.mockReset();
    prismaMock.playerLink.update.mockReset();
  });

  it("creates a new row with playerName from Name", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: makeTsv([
        "Name\tUsername\tID\tTag",
        "  Player One  \t  discord-user  \t111111111111111111\tpyl0289",
      ]),
    } as never);
    prismaMock.playerLink.findMany.mockResolvedValueOnce([]);

    const service = new PlayerLinkSyncService();
    const result = await service.syncFromPublicGoogleSheet(
      "https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0",
    );

    expect(prismaMock.playerLink.create).toHaveBeenCalledWith({
      data: {
        playerTag: "#PYL0289",
        discordUserId: "111111111111111111",
        discordUsername: "discord-user",
        playerName: "Player One",
      },
    });
    expect(result).toMatchObject({
      totalRowCount: 1,
      eligibleRowCount: 1,
      insertedCount: 1,
      updatedCount: 0,
      unchangedCount: 0,
      duplicateTagCount: 0,
      missingRequiredCount: 0,
      invalidTagCount: 0,
      invalidDiscordUserIdCount: 0,
    });
  });

  it("updates an existing row when only playerName differs", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: makeTsv([
        "Name\tUsername\tID\tTag",
        "  New Name  \t discord-user \t111111111111111111\tpyl0289",
      ]),
    } as never);
    prismaMock.playerLink.findMany.mockResolvedValueOnce([
      {
        playerTag: "#PYL0289",
        discordUserId: "111111111111111111",
        discordUsername: "discord-user",
        playerName: "Old Name",
      },
    ]);
    prismaMock.playerLink.update.mockResolvedValueOnce(undefined);

    const service = new PlayerLinkSyncService();
    const result = await service.syncFromPublicGoogleSheet(
      "https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0",
    );

    expect(prismaMock.playerLink.update).toHaveBeenCalledWith({
      where: { playerTag: "#PYL0289" },
      data: {
        discordUserId: "111111111111111111",
        discordUsername: "discord-user",
        playerName: "New Name",
      },
    });
    expect(result.updatedCount).toBe(1);
    expect(result.unchangedCount).toBe(0);
  });

  it("does not clear an existing playerName when sheet Name is blank", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: makeTsv([
        "Name\tUsername\tID\tTag",
        "   \t discord-user \t111111111111111111\tpyl0289",
      ]),
    } as never);
    prismaMock.playerLink.findMany.mockResolvedValueOnce([
      {
        playerTag: "#PYL0289",
        discordUserId: "111111111111111111",
        discordUsername: "discord-user",
        playerName: "Old Name",
      },
    ]);

    const service = new PlayerLinkSyncService();
    const result = await service.syncFromPublicGoogleSheet(
      "https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0",
    );

    expect(prismaMock.playerLink.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      insertedCount: 0,
      updatedCount: 0,
      unchangedCount: 1,
    });
  });

  it("still skips rows missing Tag, ID, or Username", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: makeTsv([
        "Name\tUsername\tID\tTag",
        "Player One\tdiscord-user\t111111111111111111\tpyl0289",
        "Player Two\t\t111111111111111112\tqgrj2222",
        "Player Three\tdiscord-user\t\tqgrj3333",
        "Player Four\tdiscord-user\t111111111111111114\t",
      ]),
    } as never);
    prismaMock.playerLink.findMany.mockResolvedValueOnce([]);

    const service = new PlayerLinkSyncService();
    const result = await service.syncFromPublicGoogleSheet(
      "https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0",
    );

    expect(prismaMock.playerLink.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      totalRowCount: 4,
      eligibleRowCount: 1,
      insertedCount: 1,
      updatedCount: 0,
      unchangedCount: 0,
      duplicateTagCount: 0,
      missingRequiredCount: 3,
      invalidTagCount: 0,
      invalidDiscordUserIdCount: 0,
    });
  });

  it("keeps duplicate tag handling unchanged", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: makeTsv([
        "Name\tUsername\tID\tTag",
        "Player One\tdiscord-user\t111111111111111111\tpyl0289",
        "Player Two\tdiscord-user\t111111111111111112\tpyl0289",
      ]),
    } as never);
    prismaMock.playerLink.findMany.mockResolvedValueOnce([]);

    const service = new PlayerLinkSyncService();
    const result = await service.syncFromPublicGoogleSheet(
      "https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0",
    );

    expect(prismaMock.playerLink.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      totalRowCount: 2,
      eligibleRowCount: 1,
      duplicateTagCount: 1,
      insertedCount: 1,
      updatedCount: 0,
      unchangedCount: 0,
    });
  });
});
