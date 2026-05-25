import { beforeEach, describe, expect, it, vi } from "vitest";

const inactiveWarServiceMock = vi.hoisted(() => ({
  listInactiveWarPlayers: vi.fn(),
}));

const playerLinkServiceMock = vi.hoisted(() => ({
  listPlayerLinksForClanMembers: vi.fn(),
}));

const emojiResolverServiceMock = vi.hoisted(() => ({
  fetchApplicationEmojiInventory: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  playerActivity: {
    aggregate: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/InactiveWarService", async () => {
  const actual = await vi.importActual("../src/services/InactiveWarService");
  return {
    ...actual,
    InactiveWarService: class {
      listInactiveWarPlayers = inactiveWarServiceMock.listInactiveWarPlayers;
    },
  };
});

vi.mock("../src/services/PlayerLinkService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/PlayerLinkService")>(
    "../src/services/PlayerLinkService",
  );
  return {
    ...actual,
    listPlayerLinksForClanMembers: playerLinkServiceMock.listPlayerLinksForClanMembers,
  };
});

vi.mock("../src/services/emoji/EmojiResolverService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/emoji/EmojiResolverService")>(
    "../src/services/emoji/EmojiResolverService",
  );
  return {
    ...actual,
    emojiResolverService: emojiResolverServiceMock,
  };
});

import { Inactive } from "../src/commands/Inactive";

function makeInteraction(values: {
  days?: number | null;
  wars?: number | null;
  consecutive?: boolean | null;
  inClan?: boolean | null;
  clan?: string | null;
}) {
  const collectorHandlers: Record<string, (btn: any) => Promise<void> | void> = {};
  const collector = {
    on: vi.fn((event: string, handler: (btn: any) => Promise<void> | void) => {
      collectorHandlers[event] = handler;
      return collector;
    }),
  };
  const replyMessage = {
    createMessageComponentCollector: vi.fn(() => collector),
  };
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(replyMessage);
  return {
    id: "inactive-interaction-1",
    guildId: "guild-1",
    user: { id: "user-1" },
    deferReply,
    editReply,
    replyMessage,
    collector,
    collectorHandlers,
    options: {
      getInteger: vi.fn((name: string) => {
        if (name === "wars") return values.wars ?? null;
        if (name === "days") return values.days ?? null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "consecutive") return values.consecutive ?? null;
        if (name === "in-clan") return values.inClan ?? null;
        return null;
      }),
      getString: vi.fn((name: string) => {
        if (name === "clan") return values.clan ?? null;
        return null;
      }),
    },
  };
}

function makeCurrentMemberRow(input: {
  clanTag: string;
  playerTag: string;
  playerName: string;
  townHall: number | null;
  weight?: number | null;
  sourceSyncedAt?: Date;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    playerName: input.playerName,
    townHall: input.townHall,
    weight: input.weight ?? null,
    sourceSyncedAt: input.sourceSyncedAt ?? new Date(),
  };
}

function makeCollectorButton(customId: string) {
  return {
    customId,
    user: { id: "user-1" },
    update: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/inactive command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    emojiResolverServiceMock.fetchApplicationEmojiInventory.mockResolvedValue({
      ok: true,
      snapshot: {
        exactByName: new Map([
          ["th16", { rendered: "<:th16:116>" }],
          ["th17", { rendered: "<:th17:117>" }],
          ["th18", { rendered: "<:th18:118>" }],
        ]),
        lowercaseByName: new Map([
          ["th16", { rendered: "<:th16:116>" }],
          ["th17", { rendered: "<:th17:117>" }],
          ["th18", { rendered: "<:th18:118>" }],
        ]),
      },
    });
  });

  it("passes clanTag to the inactive war service for wars mode", async () => {
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      trackedBadgeByTag: new Map([["AAA111", "<:badge:1>"]]),
      warnings: [],
      diagnosticNote: null,
    });

    const interaction = makeInteraction({ wars: 3, clan: "#AAA111" });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(inactiveWarServiceMock.listInactiveWarPlayers).toHaveBeenCalledWith({
      guildId: "guild-1",
      wars: 3,
      clanTag: "#AAA111",
    });
  });

  it("passes consecutive:true through to the inactive war service", async () => {
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      trackedBadgeByTag: new Map([["AAA111", "<:badge:1>"]]),
      warnings: [],
      diagnosticNote: null,
    });

    const interaction = makeInteraction({ wars: 3, consecutive: true });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(inactiveWarServiceMock.listInactiveWarPlayers).toHaveBeenCalledWith({
      guildId: "guild-1",
      wars: 3,
      clanTag: undefined,
      consecutive: true,
    });
  });

  it("shows only current in-clan members by default in wars mode", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 18,
      }),
    ]);
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [
        {
          clanTag: "AAA111",
          playerTag: "A1",
          playerName: "Alpha One",
          townHall: 18,
          missedWars: 3,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "WIN", emoji: "ðŸŸ¢" },
          ],
        },
        {
          clanTag: "AAA111",
          playerTag: "A2",
          playerName: "Alpha Two",
          townHall: 17,
          missedWars: 3,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "WIN", emoji: "ðŸŸ¢" },
          ],
        },
      ],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      trackedBadgeByTag: new Map([["AAA111", "<:badge:1>"]]),
      warnings: [],
      diagnosticNote: null,
    });

    const interaction = makeInteraction({ wars: 3 });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("Alpha One `#A1`");
    expect(embed.description).not.toContain("Alpha Two `#A2`");
  });

  it("composes consecutive:true with in-clan:false in wars mode", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 18,
      }),
    ]);
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [
        {
          clanTag: "AAA111",
          playerTag: "A1",
          playerName: "Alpha One",
          townHall: 18,
          missedWars: 3,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "WIN", emoji: "ðŸŸ¢" },
          ],
        },
        {
          clanTag: "AAA111",
          playerTag: "A2",
          playerName: "Alpha Two",
          townHall: 17,
          missedWars: 3,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "WIN", emoji: "ðŸŸ¢" },
          ],
        },
      ],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      trackedBadgeByTag: new Map([["AAA111", "<:badge:1>"]]),
      warnings: [],
      diagnosticNote: null,
    });

    const interaction = makeInteraction({ wars: 3, consecutive: true, inClan: false });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(inactiveWarServiceMock.listInactiveWarPlayers).toHaveBeenCalledWith({
      guildId: "guild-1",
      wars: 3,
      clanTag: undefined,
      consecutive: true,
    });
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("Alpha Two `#A2`");
    expect(embed.description).not.toContain("Alpha One `#A1`");
  });

  it("scopes days mode to the selected clan", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 17,
      }),
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A2",
        playerName: "Alpha Two",
        townHall: 16,
      }),
    ]);
    prismaMock.playerActivity.aggregate.mockResolvedValue({
      _max: { updatedAt: new Date() },
      _count: { tag: 2 },
    });
    prismaMock.playerActivity.count.mockResolvedValue(2);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#A1",
        name: "Alpha One",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
      {
        tag: "#A2",
        name: "Alpha Two",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    ]);
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      { playerTag: "#A1", discordUserId: "111111111111111111" },
    ]);

    const interaction = makeInteraction({ days: 7, clan: "#AAA111" });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("<:badge:1> Alpha (2)");
    expect(embed.description).toContain("- <:th17:117> Alpha One `#A1` <@111111111111111111> - 8d");
    expect(embed.description).toContain("- <:th16:116> Alpha Two `#A2`");
    expect(emojiResolverServiceMock.fetchApplicationEmojiInventory).toHaveBeenCalledTimes(1);
    expect(embed.description).not.toContain("Beta");
  });

  it("shows the display toggle on single-page days results and flips to weights", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 17,
        weight: null,
      }),
    ]);
    prismaMock.playerActivity.aggregate.mockResolvedValue({
      _max: { updatedAt: new Date() },
      _count: { tag: 1 },
    });
    prismaMock.playerActivity.count.mockResolvedValue(1);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#A1",
        name: "Alpha One",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([]);

    const interaction = makeInteraction({ days: 7, clan: "#AAA111" });

    await Inactive.run({} as any, interaction as any, {} as any);

    expect(interaction.replyMessage.createMessageComponentCollector).toHaveBeenCalledTimes(1);
    const initialPayload = interaction.editReply.mock.calls.at(0)?.[0];
    const initialEmbed = initialPayload.embeds[0].toJSON();
    expect(initialEmbed.description).toContain("`#A1`");
    expect(initialEmbed.description).not.toContain("145k");
    const initialButtons = initialPayload.components[0].components.map((button: any) => button.toJSON());
    expect(initialButtons.map((button: any) => button.label)).toEqual([
      "Show weights",
      "Prev",
      "Next",
    ]);
    expect(initialButtons[1].disabled).toBe(true);
    expect(initialButtons[2].disabled).toBe(true);

    const toggleButton = makeCollectorButton(`inactive:${interaction.id}:toggle`);
    await interaction.collectorHandlers.collect(toggleButton);
    expect(toggleButton.update).toHaveBeenCalledTimes(1);
    const togglePayload = toggleButton.update.mock.calls[0]?.[0];
    const toggleEmbed = togglePayload.embeds[0].toJSON();
    expect(toggleEmbed.description).toContain("`—`");
    expect(toggleEmbed.description).not.toContain("`#A1`");
    const toggleButtons = togglePayload.components[0].components.map((button: any) => button.toJSON());
    expect(toggleButtons.map((button: any) => button.label)).toEqual([
      "Show tags",
      "Prev",
      "Next",
    ]);
    expect(toggleButtons[1].disabled).toBe(true);
    expect(toggleButtons[2].disabled).toBe(true);

    const toggleBackButton = makeCollectorButton(`inactive:${interaction.id}:toggle`);
    await interaction.collectorHandlers.collect(toggleBackButton);
    expect(toggleBackButton.update).toHaveBeenCalledTimes(1);
    const toggleBackPayload = toggleBackButton.update.mock.calls[0]?.[0];
    const toggleBackEmbed = toggleBackPayload.embeds[0].toJSON();
    expect(toggleBackEmbed.description).toContain("`#A1`");
    expect(toggleBackEmbed.description).not.toContain("`—`");
  });

  it("filters days mode to former clan members when in-clan:false", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 17,
      }),
    ]);
    prismaMock.playerActivity.aggregate.mockResolvedValue({
      _max: { updatedAt: new Date() },
      _count: { tag: 2 },
    });
    prismaMock.playerActivity.count.mockResolvedValue(2);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#A1",
        name: "Alpha One",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
      {
        tag: "#A2",
        name: "Alpha Two",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    ]);
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([]);

    const interaction = makeInteraction({ days: 7, inClan: false });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("- ❔ Alpha Two `#A2`");
    expect(embed.description).not.toContain("Alpha One `#A1`");
  });

  it("scopes combined mode to the selected clan", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 17,
      }),
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A2",
        playerName: "Alpha Two",
        townHall: 16,
      }),
    ]);
    prismaMock.playerActivity.aggregate.mockResolvedValue({
      _max: { updatedAt: new Date() },
      _count: { tag: 2 },
    });
    prismaMock.playerActivity.count.mockResolvedValue(2);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#A1",
        name: "Alpha One",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
      {
        tag: "#A2",
        name: "Alpha Two",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    ]);

    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [
        {
          clanTag: "AAA111",
          playerTag: "A1",
          playerName: "Alpha One",
          townHall: 18,
          missedWars: 3,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "WIN", emoji: "🟢" },
            { warId: "502", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "LOSE", emoji: "🔴" },
            { warId: "501", warStartTime: null, warEndTime: null, matchType: "BL", outcome: null, emoji: "⚫" },
          ],
        },
      ],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      trackedBadgeByTag: new Map([["AAA111", "<:badge:1>"]]),
      warnings: [],
      diagnosticNote: null,
    });
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      { playerTag: "#A1", discordUserId: "111111111111111111" },
    ]);

    const interaction = makeInteraction({ days: 7, wars: 3, clan: "#AAA111" });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(inactiveWarServiceMock.listInactiveWarPlayers).toHaveBeenCalledWith({
      guildId: "guild-1",
      wars: 3,
      clanTag: "#AAA111",
    });
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("Alpha");
    expect(embed.description).toContain("`#A1`");
    expect(embed.description).toContain("<@111111111111111111>");
    expect(embed.description).toContain("🟢");
    expect(embed.description).not.toContain("Beta");
  });

  it("toggles between tag and weight display while keeping pagination controls working", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);

    const playerRows = Array.from({ length: 25 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      return {
        tag: `#A${suffix}`,
        name: `Alpha Player ${suffix}`,
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - (8 + index) * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      };
    });

    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
      playerRows.map((row, index) =>
        makeCurrentMemberRow({
          clanTag: row.clanTag,
          playerTag: row.tag,
          playerName: row.name,
          townHall: 18 - (index % 3),
          weight: index === 0 ? 145000 : null,
        }),
      ),
    );
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      { playerTag: "#A02", latestKnownWeight: 150000, lastSyncedAt: new Date() },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      { playerTag: "#A03", currentWeight: 160000, updatedAt: new Date() },
    ]);
    prismaMock.playerActivity.aggregate.mockResolvedValue({
      _max: { updatedAt: new Date() },
      _count: { tag: playerRows.length },
    });
    prismaMock.playerActivity.count.mockResolvedValue(playerRows.length);
    prismaMock.playerActivity.findMany.mockResolvedValue(playerRows);
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([]);

    const interaction = makeInteraction({ days: 7, clan: "#AAA111" });

    await Inactive.run({} as any, interaction as any, {} as any);

    expect(interaction.replyMessage.createMessageComponentCollector).toHaveBeenCalledTimes(1);
    const initialPayload = interaction.editReply.mock.calls.at(0)?.[0];
    const initialEmbed = initialPayload.embeds[0].toJSON();
    expect(initialEmbed.description).toContain("`#A01`");
    expect(initialPayload.components[0].components.map((button: any) => button.toJSON().label)).toEqual([
      "Show weights",
      "Prev",
      "Next",
    ]);

    const toggleButton = makeCollectorButton(`inactive:${interaction.id}:toggle`);
    await interaction.collectorHandlers.collect(toggleButton);
    expect(toggleButton.update).toHaveBeenCalledTimes(1);
    const togglePayload = toggleButton.update.mock.calls[0]?.[0];
    const toggleEmbed = togglePayload.embeds[0].toJSON();
    expect(toggleEmbed.description).toContain("145k");
    expect(toggleEmbed.description).toContain("150k");
    expect(toggleEmbed.description).toContain("160k");
    expect(toggleEmbed.description).toContain("`—`");
    expect(togglePayload.components[0].components.map((button: any) => button.toJSON().label)).toEqual([
      "Show tags",
      "Prev",
      "Next",
    ]);

    const nextButton = makeCollectorButton(`inactive:${interaction.id}:next`);
    await interaction.collectorHandlers.collect(nextButton);
    expect(nextButton.update).toHaveBeenCalledTimes(1);
    const nextPayload = nextButton.update.mock.calls[0]?.[0];
    const nextEmbed = nextPayload.embeds[0].toJSON();
    expect(nextEmbed.footer?.text).toContain("Page 2/2");
    expect(nextEmbed.description).toContain("`—`");

    const toggleBackButton = makeCollectorButton(`inactive:${interaction.id}:toggle`);
    await interaction.collectorHandlers.collect(toggleBackButton);
    expect(toggleBackButton.update).toHaveBeenCalledTimes(1);
    const toggleBackPayload = toggleBackButton.update.mock.calls[0]?.[0];
    const toggleBackEmbed = toggleBackPayload.embeds[0].toJSON();
    expect(toggleBackEmbed.description).toContain("`#A01`");
    expect(toggleBackEmbed.description).not.toContain("145k");
  });

  it("renders grouped wars output with linked Discord users, ratios, and missed-war emojis", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
      { tag: "#BBB222", name: "Beta", clanBadge: "<:badge:2>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 18,
      }),
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A2",
        playerName: "Alpha Two",
        townHall: 17,
      }),
      makeCurrentMemberRow({
        clanTag: "#BBB222",
        playerTag: "#B1",
        playerName: "Beta One",
        townHall: 16,
      }),
    ]);
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [
        {
          clanTag: "AAA111",
          playerTag: "A1",
          playerName: "Alpha One",
          townHall: 18,
          missedWars: 3,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: 47.5,
          lateAttacks: 1,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "WIN", emoji: "🟢" },
            { warId: "502", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "LOSE", emoji: "🔴" },
            { warId: "501", warStartTime: null, warEndTime: null, matchType: "BL", outcome: null, emoji: "⚫" },
          ],
        },
        {
          clanTag: "AAA111",
          playerTag: "A2",
          playerName: "Alpha Two",
          townHall: 17,
          missedWars: 2,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: 12,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "MM", outcome: null, emoji: "⚪" },
            { warId: "502", warStartTime: null, warEndTime: null, matchType: "UNKNOWN", outcome: null, emoji: "🔘" },
          ],
        },
        {
          clanTag: "BBB222",
          playerTag: "B1",
          playerName: "Beta One",
          townHall: 16,
          missedWars: 1,
          participationWars: 2,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 2,
          missedWarStates: [
            { warId: "402", warStartTime: null, warEndTime: null, matchType: "MM", outcome: null, emoji: "⚪" },
          ],
        },
      ],
      trackedTags: ["AAA111", "BBB222"],
      trackedNameByTag: new Map([
        ["AAA111", "Alpha"],
        ["BBB222", "Beta"],
      ]),
      trackedBadgeByTag: new Map([
        ["AAA111", "<:badge:1>"],
        ["BBB222", "<:badge:2>"],
      ]),
      warnings: [],
      diagnosticNote: null,
    });

    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      { playerTag: "#A1", discordUserId: "111111111111111111" },
      { playerTag: "#B1", discordUserId: "222222222222222222" },
    ]);

    const interaction = makeInteraction({ wars: 3, clan: "#AAA111" });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(playerLinkServiceMock.listPlayerLinksForClanMembers).toHaveBeenCalledWith({
      memberTagsInOrder: ["#A1", "#A2", "#B1"],
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
      }),
    );
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toContain("Missed Both Attacks - Last 3 War(s) (3)");
    expect(embed.description).toContain("<:badge:1> Alpha (2)");
    expect(embed.description).toContain("<:th18:118> Alpha One `#A1` <@111111111111111111>");
    expect(embed.description).toContain("\u{1F7E2} \u{1F534} \u26AB");
    expect(embed.description).toContain("- 2 wars missed");
    expect(embed.description).toContain("<:th17:117> Alpha Two `#A2`");
    expect(embed.description).toContain("2/3 wars missed");
    expect(embed.description).toContain("\u26AA \u{1F518}");
    expect(embed.description).toContain("Beta (1)");
    expect(embed.description).toContain("Beta One `#B1` <@222222222222222222>");
    expect(embed.description).toContain("1/2 wars missed");
    expect(emojiResolverServiceMock.fetchApplicationEmojiInventory).toHaveBeenCalledTimes(1);
    expect(embed.description).not.toContain("true stars");
    expect(embed.description).not.toContain("avg delay");
    expect(embed.description).not.toContain("late attacks");
    expect(embed.description).not.toContain("3/3 wars missed");
  });
  it("renders days mode rows with backticked tags and Discord mentions", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 17,
      }),
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A2",
        playerName: "Alpha Two",
        townHall: 16,
      }),
    ]);
    prismaMock.playerActivity.aggregate.mockResolvedValue({
      _max: { updatedAt: new Date() },
      _count: { tag: 2 },
    });
    prismaMock.playerActivity.count.mockResolvedValue(2);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#A1",
        name: "Alpha One",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
      {
        tag: "#A2",
        name: "Alpha Two",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    ]);
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      { playerTag: "#A1", discordUserId: "111111111111111111" },
    ]);

    const interaction = makeInteraction({ days: 7 });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("- <:th17:117> Alpha One `#A1` <@111111111111111111> - 8d");
    expect(embed.description).toContain("- <:th16:116> Alpha Two `#A2`");
    expect(emojiResolverServiceMock.fetchApplicationEmojiInventory).toHaveBeenCalledTimes(1);
  });

  it("accepts consecutive:true in days mode and preserves the persisted inactivity rows", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 17,
      }),
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A2",
        playerName: "Alpha Two",
        townHall: 16,
      }),
    ]);
    prismaMock.playerActivity.aggregate.mockResolvedValue({
      _max: { updatedAt: new Date() },
      _count: { tag: 2 },
    });
    prismaMock.playerActivity.count.mockResolvedValue(2);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#A1",
        name: "Alpha One",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
      {
        tag: "#A2",
        name: "Alpha Two",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    ]);
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      { playerTag: "#A1", discordUserId: "111111111111111111" },
    ]);

    const interaction = makeInteraction({ days: 7, consecutive: true });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("- <:th17:117> Alpha One `#A1` <@111111111111111111> - 8d");
    expect(embed.description).toContain("- <:th16:116> Alpha Two `#A2`");
  });

  it("renders days mode rows from current-member town hall fields", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A1",
        playerName: "Alpha One",
        townHall: 17,
      }),
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A2",
        playerName: "Alpha Two",
        townHall: 16,
      }),
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#A3",
        playerName: "Alpha Three",
        townHall: null,
      }),
    ]);
    prismaMock.playerActivity.aggregate.mockResolvedValue({
      _max: { updatedAt: new Date() },
      _count: { tag: 3 },
    });
    prismaMock.playerActivity.count.mockResolvedValue(3);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#A1",
        name: "Alpha One",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
      {
        tag: "#A2",
        name: "Alpha Two",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
      {
        tag: "#A3",
        name: "Alpha Three",
        clanTag: "#AAA111",
        lastSeenAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    ]);
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([]);

    const interaction = makeInteraction({ days: 7 });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("- <:th17:117> Alpha One `#A1`");
    expect(embed.description).toContain("- <:th16:116> Alpha Two `#A2`");
    expect(embed.description).toContain("\u2754 Alpha Three `#A3`");
    expect(emojiResolverServiceMock.fetchApplicationEmojiInventory).toHaveBeenCalledTimes(1);
  });

  it("shows ratios for other missed-war count combinations", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", clanBadge: "<:badge:1>" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#C1",
        playerName: "Charlie One",
        townHall: 17,
      }),
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#C2",
        playerName: "Charlie Two",
        townHall: 16,
      }),
      makeCurrentMemberRow({
        clanTag: "#AAA111",
        playerTag: "#C3",
        playerName: "Charlie Three",
        townHall: 15,
      }),
    ]);
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [
        {
          clanTag: "AAA111",
          playerTag: "C1",
          playerName: "Charlie One",
          missedWars: 2,
          participationWars: 2,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 2,
          missedWarStates: [
            { warId: "502", warStartTime: null, warEndTime: null, matchType: "BL", outcome: null, emoji: "⚫" },
            { warId: "501", warStartTime: null, warEndTime: null, matchType: "MM", outcome: null, emoji: "⚪" },
          ],
        },
        {
          clanTag: "AAA111",
          playerTag: "C2",
          playerName: "Charlie Two",
          missedWars: 1,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "UNKNOWN", outcome: null, emoji: "🔘" },
          ],
        },
        {
          clanTag: "AAA111",
          playerTag: "C3",
          playerName: "Charlie Three",
          missedWars: 1,
          participationWars: 1,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 1,
          missedWarStates: [
            { warId: "504", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "LOSE", emoji: "🔴" },
          ],
        },
      ],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      trackedBadgeByTag: new Map([["AAA111", "<:badge:1>"]]),
      warnings: [],
      diagnosticNote: null,
    });
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([]);

    const interaction = makeInteraction({ wars: 3 });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("2/2 wars missed");
    expect(embed.description).toContain("1/3 wars missed");
    expect(embed.description).toContain("1/1 wars missed");
  });

  it("includes the scoped diagnostic note when the selected clan has no wars results", async () => {
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      trackedBadgeByTag: new Map([["AAA111", "<:badge:1>"]]),
      warnings: [],
      diagnosticNote: "Diagnostic: ended wars found yes (3), participation rows found yes (6).",
    });

    const interaction = makeInteraction({ wars: 3, clan: "#AAA111" });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining(
        "No players found in Alpha who missed both attacks in at least one of the last 3 ended tracked war(s).",
      ),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("Diagnostic: ended wars found yes (3), participation rows found yes (6)."),
    );
  });
});

