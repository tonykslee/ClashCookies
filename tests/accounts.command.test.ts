import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as PlayerLinkService from "../src/services/PlayerLinkService";

const prismaMock = vi.hoisted(() => ({
  playerCurrent: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  playerLink: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  externalPlayerWeightCurrent: {
    findMany: vi.fn(),
  },
  weightInputDeferment: {
    findMany: vi.fn(),
  },
}));

const cocQueueMock = vi.hoisted(() => {
  const state = { active: false };
  const defaultImpl = async (_context: unknown, run: () => Promise<unknown>) => {
    state.active = true;
    try {
      return await run();
    } finally {
      state.active = false;
    }
  };
  return {
    state,
    defaultImpl,
    runWithCoCQueueContext: vi.fn(defaultImpl),
  };
});

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CoCQueueContext", () => ({
  runWithCoCQueueContext: cocQueueMock.runWithCoCQueueContext,
}));

import { Accounts } from "../src/commands/Accounts";

function makeInteraction(input?: {
  visibility?: string | null;
  tag?: string | null;
  discordUserId?: string | null;
}) {
  const collectorHandlers: Record<string, any> = {};
  const collector = {
    on: vi.fn((event: string, handler: any) => {
      collectorHandlers[event] = handler;
      return collector;
    }),
  };
  return {
    guildId: "123456789012345678",
    id: "777777777777777777",
    user: { id: "111111111111111111" },
    options: {
      getString: vi.fn((name: string) => {
        if (name === "visibility") return input?.visibility ?? null;
        if (name === "tag") return input?.tag ?? null;
        return null;
      }),
      getUser: vi.fn((name: string) => {
        if (name === "discord-id" && input?.discordUserId) {
          return { id: input.discordUserId };
        }
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({
      createMessageComponentCollector: vi.fn(() => collector),
    }),
    __collector: collector,
    __collectorHandlers: collectorHandlers,
  };
}

function makeButtonInteraction(customId: string) {
  return {
    customId,
    user: { id: "111111111111111111" },
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAutocompleteInteraction(
  value: string,
  focusedName = "tag",
) {
  return {
    options: {
      getFocused: vi.fn(() => ({ name: focusedName, value })),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCocService(playersByTag: Record<string, any> = {}) {
  return {
    playersByTag,
    getPlayerRaw: vi.fn(async function (this: { playersByTag?: Record<string, any> }, tag: string) {
      return this.playersByTag?.[tag] ?? null;
    }),
  };
}

function makePlayerCurrentRow(overrides: Record<string, any> = {}) {
  return {
    playerTag: "#PYLQ0289",
    playerName: "Current Alpha",
    townHall: 16,
    currentClanTag: "#PQL0289",
    currentClanName: "Current Clan",
    trophies: 6000,
    builderTrophies: 4000,
    warStars: 100,
    expLevel: 200,
    role: "leader",
    leagueName: "Legend League",
    currentWeight: null,
    currentWeightSource: null,
    currentWeightMeasuredAt: null,
    achievementsJson: null,
    lastSeenAt: new Date("2026-04-20T00:00:00.000Z"),
    lastFetchedAt: new Date("2026-04-20T00:00:00.000Z"),
    lastSource: "accounts-refresh",
    createdAt: new Date("2026-04-20T00:00:00.000Z"),
    updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    ...overrides,
  };
}

function makeBulkAccountRows(input: {
  tagPrefix: string;
  namePrefix: string;
  clanTag: string;
  clanName: string;
  count: number;
  discordUserId?: string | null;
  startIndex?: number;
}) {
  const links: Array<{
    playerTag: string;
    playerName: string;
    discordUserId: string | null;
    discordUsername: string | null;
    linkSource: string;
    verificationStatus: string;
    verificationMethod: string | null;
    verifiedAt: Date | null;
    verifiedByDiscordUserId: string | null;
    lastVerifiedAt: Date | null;
    verificationFailureReason: string | null;
    importBatchKey: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const playerCurrents: Array<Record<string, any>> = [];
  const startIndex = input.startIndex ?? 1;
  for (let index = 0; index < input.count; index += 1) {
    const value = startIndex + index;
    const suffix = String(value).padStart(3, "0");
    const playerTag = `#${input.tagPrefix}${suffix}`;
    const playerName = `${input.namePrefix} ${suffix}`;
    links.push({
      playerTag,
      playerName,
      discordUserId: input.discordUserId ?? null,
      discordUsername: `${input.namePrefix.replace(/\s+/g, "")}User`,
      linkSource: "ADMIN_CREATE",
      verificationStatus: "VERIFIED",
      verificationMethod: "ADMIN_OVERRIDE",
      verifiedAt: new Date("2026-03-01T00:00:00.000Z"),
      verifiedByDiscordUserId: null,
      lastVerifiedAt: new Date("2026-03-02T00:00:00.000Z"),
      verificationFailureReason: null,
      importBatchKey: null,
      createdAt: new Date(`2026-03-${String((value % 27) + 1).padStart(2, "0")}T00:00:00.000Z`),
      updatedAt: new Date(`2026-03-${String((value % 27) + 1).padStart(2, "0")}T00:00:00.000Z`),
    });
    playerCurrents.push(
      makePlayerCurrentRow({
        playerTag,
        playerName,
        townHall: 15,
        currentClanTag: input.clanTag,
        currentClanName: input.clanName,
        role: "member",
        currentWeight: null,
        lastSource: "accounts-refresh",
      }),
    );
  }

  return { links, playerCurrents };
}

function getEmbedDescription(interaction: any): string {
  const payload = [...interaction.editReply.mock.calls].reverse().find(
    (call: unknown[]) => call[0] && typeof call[0] === "object" && Array.isArray(call[0].embeds)
  )?.[0] as any;
  return readEmbedDescription(payload?.embeds?.[0]);
}

function readEmbedDescription(embed: any): string {
  return String(
    embed?.description ??
      embed?.data?.description ??
      embed?.toJSON?.().description ??
      "",
  );
}

describe("/accounts command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cocQueueMock.state.active = false;
    cocQueueMock.runWithCoCQueueContext.mockImplementation(cocQueueMock.defaultImpl);

    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.upsert.mockResolvedValue({} as never);
    prismaMock.playerLink.findUnique.mockResolvedValue(null);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.playerLink.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
  });

  it("registers discord-id as a native User option without autocomplete", () => {
    const discordIdOption = Accounts.options?.find((option) => option.name === "discord-id");

    expect(discordIdOption?.type).toBe(ApplicationCommandOptionType.User);
    expect(discordIdOption?.autocomplete).toBeUndefined();
  });

  it("renders tracked clan headings as alias hyperlinks and keeps rows under that clan", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        townHall: 16,
        currentClanTag: "#PQL0289",
        currentClanName: "Stored Clan",
        role: "member",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#PYLQ0289", name: "Activity Alpha", clanTag: "#PQL0289", clanName: "Stored Clan" },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Stored Clan", shortName: "SC" },
    ]);
    const cocService = makeCocService({
      "#PYLQ0289": {
        name: "Live Alpha",
        clan: { tag: "#PQL0289", name: "Stored Clan" },
        role: "member",
      },
    });
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    const description = getEmbedDescription(interaction);
    expect(description).toContain(
      "**[Stored Clan](https://link.clashofclans.com/en?action=OpenClanProfile&tag=PQL0289)**",
    );
    expect(description).toContain(
      "TH16 [Linked Alpha](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=PYLQ0289>) `#PYLQ0289` - —",
    );
  });

  it("falls back to playerActivity.name when playerName is missing", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#QGRJ2222",
        playerName: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#QGRJ2222",
        name: "Activity Bravo",
        clanTag: "#PQL0289",
        clanName: "Clan One",
      },
    ]);
    const cocService = makeCocService({
      "#QGRJ2222": {
        name: "Live Bravo",
        clan: { tag: "#PQL0289", name: "Clan One" },
        role: "member",
      },
    });
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(getEmbedDescription(interaction)).toContain(
      "TH? [Activity Bravo](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=QGRJ2222>) `#QGRJ2222` - —",
    );
  });

  it("renders Unknown Clan when neither PlayerCurrent nor PlayerActivity has clan data", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#CUV9082",
        playerName: "",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    const cocService = makeCocService({
      "#CUV9082": null,
    });
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(getEmbedDescription(interaction)).toContain("**Unknown Clan**");
    expect(getEmbedDescription(interaction)).toContain(
      "TH? [#CUV9082](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=CUV9082>) `#CUV9082` - —",
    );
  });

  it("renders Unknown Clan when PlayerCurrent only has catalog hydration data", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#CUV9082",
        playerName: "",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#CUV9082",
        playerName: "Catalog Alpha",
        currentClanTag: null,
        currentClanName: null,
        lastSource: "fwa_player_catalog",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    const description = getEmbedDescription(interaction);
    expect(description).toContain("**Unknown Clan**");
    expect(description).toContain("Catalog Alpha");
  });

  it("renders No Clan when PlayerCurrent confirms the player is clanless", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#CUV9082",
        playerName: "",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#CUV9082",
        playerName: "Clanless Current",
        currentClanTag: null,
        currentClanName: null,
        lastSource: "accounts-refresh",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    expect(getEmbedDescription(interaction)).toContain("**No Clan**");
    expect(getEmbedDescription(interaction)).toContain("Clanless Current");
  });

  it("groups untracked clans under their current clan heading and renders co-leader crowns", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        townHall: 16,
        currentClanTag: "#UNTRK1",
        currentClanName: "Untracked Clan",
        role: "leader",
      }),
      makePlayerCurrentRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 16,
        currentClanTag: "#UNTRK1",
        currentClanName: "Untracked Clan",
        role: "coleader",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    const description = getEmbedDescription(interaction);
    expect(description).toContain(
      "**[Untracked Clan](https://link.clashofclans.com/en?action=OpenClanProfile&tag=UNTRK1)**",
    );
    expect(description).toContain(
      "TH16 [Alpha](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=PYLQ0289>) :crown: `#PYLQ0289` - —",
    );
    expect(description).toContain(
      "TH16 [Bravo](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=QGRJ2222>) :crown: `#QGRJ2222` - —",
    );
  });

  it("shows tracked FWA clans before non-tracked clans and uses FWA weight precedence", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Tracked One",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Free One",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
      {
        playerTag: "#LQ9P8R2",
        playerName: "Weight Missing",
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#PYLQ0289",
        playerName: "Tracked One",
        townHall: 17,
        currentClanTag: "#TRK0289",
        currentClanName: "Tracked FWA Clan",
        role: "leader",
      }),
      makePlayerCurrentRow({
        playerTag: "#QGRJ2222",
        playerName: "Free One",
        townHall: 18,
        currentClanTag: "#FREE0289",
        currentClanName: "Free Clan",
        role: "member",
      }),
      makePlayerCurrentRow({
        playerTag: "#LQ9P8R2",
        playerName: "Weight Missing",
        townHall: 16,
        currentClanTag: "#FREE0289",
        currentClanName: "Free Clan",
        role: null,
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#TRK0289", name: "Tracked FWA Clan", shortName: "TRACK" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#TRK0289",
        townHall: 17,
        weight: 210000,
        sourceSyncedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#FREE0289",
        townHall: 18,
        weight: null,
        sourceSyncedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
      {
        playerTag: "#LQ9P8R2",
        clanTag: "#FREE0289",
        townHall: 16,
        weight: null,
        sourceSyncedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        latestTownHall: 17,
        latestKnownWeight: 145000,
      },
      {
        playerTag: "#QGRJ2222",
        latestTownHall: 18,
        latestKnownWeight: 145000,
      },
      {
        playerTag: "#LQ9P8R2",
        latestTownHall: 16,
        latestKnownWeight: null,
      },
    ]);
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    const description = getEmbedDescription(interaction);
    const trackedHeadingIndex = description.indexOf("Tracked FWA Clan");
    const freeHeadingIndex = description.indexOf("Free Clan");
    expect(trackedHeadingIndex).toBeGreaterThanOrEqual(0);
    expect(freeHeadingIndex).toBeGreaterThan(trackedHeadingIndex);
    expect(description).toContain(
      "TH17 [Tracked One](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=PYLQ0289>) :crown: `#PYLQ0289` - 210k",
    );
    expect(description).toContain(
      "TH18 [Free One](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=QGRJ2222>) `#QGRJ2222` - 145k",
    );
    expect(description).toContain(
      "TH16 [Weight Missing](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=LQ9P8R2>) `#LQ9P8R2` - —",
    );
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledWith({
      where: { playerTag: { in: ["#PYLQ0289", "#QGRJ2222", "#LQ9P8R2"] } },
      select: {
        clanTag: true,
        playerTag: true,
        sourceSyncedAt: true,
        townHall: true,
        weight: true,
      },
    });
    expect(prismaMock.fwaPlayerCatalog.findMany).toHaveBeenCalledWith({
      where: { playerTag: { in: ["#PYLQ0289", "#QGRJ2222", "#LQ9P8R2"] } },
      select: {
        latestKnownWeight: true,
        latestTownHall: true,
        playerTag: true,
      },
    });
  });

  it("falls back to PlayerCurrent, external manual weights, and open deferments in order", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", playerName: "Alpha One", discordUserId: "111111111111111111", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", playerName: "Alpha Two", discordUserId: "111111111111111111", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#LQ9P8R2", playerName: "Alpha Three", discordUserId: "111111111111111111", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#JQ00020", playerName: "Alpha Four", discordUserId: "111111111111111111", createdAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha One",
        townHall: 15,
        currentClanTag: "#FREE0289",
        currentClanName: "Free Clan",
        currentWeight: 155000,
      }),
      makePlayerCurrentRow({
        playerTag: "#QGRJ2222",
        playerName: "Alpha Two",
        townHall: 15,
        currentClanTag: "#FREE0289",
        currentClanName: "Free Clan",
        currentWeight: 156000,
      }),
      makePlayerCurrentRow({
        playerTag: "#LQ9P8R2",
        playerName: "Alpha Three",
        townHall: 15,
        currentClanTag: "#FREE0289",
        currentClanName: "Free Clan",
        currentWeight: null,
      }),
      makePlayerCurrentRow({
        playerTag: "#JQ00020",
        playerName: "Alpha Four",
        townHall: 15,
        currentClanTag: null,
        currentClanName: null,
        currentWeight: null,
        lastSource: "accounts-refresh",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        weight: 165000,
        measuredAt: new Date("2026-04-01T00:00:00.000Z"),
        source: "manual",
      },
      {
        playerTag: "#QGRJ2222",
        weight: 166000,
        measuredAt: new Date("2026-04-01T00:00:00.000Z"),
        source: "manual",
      },
      {
        playerTag: "#LQ9P8R2",
        weight: 167000,
        measuredAt: new Date("2026-04-01T00:00:00.000Z"),
        source: "manual",
      },
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([
      {
        scopeKey: "guild:123456789012345678|clan:FREE0289",
        playerTag: "#PYLQ0289",
        deferredWeight: 175000,
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
      {
        scopeKey: "guild:123456789012345678|clan:FREE0289",
        playerTag: "#QGRJ2222",
        deferredWeight: 176000,
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
      {
        scopeKey: "guild:123456789012345678|clan:FREE0289",
        playerTag: "#LQ9P8R2",
        deferredWeight: 177000,
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
      {
        scopeKey: "guild:123456789012345678",
        playerTag: "#LQ9P8R2",
        deferredWeight: 178000,
        createdAt: new Date("2026-04-03T00:00:00.000Z"),
      },
      {
        scopeKey: "guild:123456789012345678",
        playerTag: "#JQ00020",
        deferredWeight: 179000,
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ]);
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    const description = getEmbedDescription(interaction);
    expect(description).toContain(
      "TH15 [Alpha One](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=PYLQ0289>) :crown: `#PYLQ0289` - 155k",
    );
    expect(description).toContain(
      "TH15 [Alpha Two](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=QGRJ2222>) :crown: `#QGRJ2222` - 156k",
    );
    expect(description).toContain(
      "TH15 [Alpha Three](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=LQ9P8R2>) :crown: `#LQ9P8R2` - 167k",
    );
    expect(description).toContain(
      "TH15 [Alpha Four](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=JQ00020>) :crown: `#JQ00020` - 179k",
    );
    expect(prismaMock.externalPlayerWeightCurrent.findMany).toHaveBeenCalledWith({
      where: { playerTag: { in: ["#PYLQ0289", "#QGRJ2222", "#LQ9P8R2", "#JQ00020"] } },
      select: {
        measuredAt: true,
        playerTag: true,
        source: true,
        weight: true,
      },
    });
    expect(prismaMock.weightInputDeferment.findMany).toHaveBeenCalledWith({
      where: {
        guildId: "123456789012345678",
        playerTag: { in: ["#PYLQ0289", "#QGRJ2222", "#LQ9P8R2", "#JQ00020"] },
        scopeKey: {
          in: [
            "guild:123456789012345678|clan:FREE0289",
            "guild:123456789012345678",
          ],
        },
        status: "open",
      },
      select: {
        createdAt: true,
        deferredWeight: true,
        playerTag: true,
        scopeKey: true,
      },
      orderBy: [{ createdAt: "desc" }],
    });
  });

  it("renders more than 18 accounts on one page when the description fits", async () => {
    const { links, playerCurrents } = makeBulkAccountRows({
      tagPrefix: "FIT",
      namePrefix: "Fit Player",
      clanTag: "#FIT001",
      clanName: "Fit Clan",
      count: 20,
      discordUserId: "111111111111111111",
    });
    prismaMock.playerLink.findMany.mockResolvedValue(links);
    prismaMock.playerCurrent.findMany.mockResolvedValue(playerCurrents);
    prismaMock.playerActivity.findMany.mockResolvedValue(
      links.map((link) => ({
        tag: link.playerTag,
        name: link.playerName,
        clanTag: "#FIT001",
        clanName: "Fit Clan",
      })),
    );
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#FIT001", name: "Fit Clan", shortName: "FIT" },
    ]);
    const listPlayerLinksSpy = vi.spyOn(PlayerLinkService, "listPlayerLinksForDiscordUser").mockResolvedValue(
      links.map((link) => ({
        playerTag: link.playerTag,
        linkedAt: link.createdAt,
        linkedName: link.playerName,
      })),
    );
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    const description = getEmbedDescription(interaction);
    expect(description).toContain("Fit Clan");
    expect((description.match(/OpenPlayerProfile/g) ?? []).length).toBe(20);
    expect(description.length).toBeLessThanOrEqual(4096);
    listPlayerLinksSpy.mockRestore();
  });

  it("keeps clan blocks together across description-length pages and preserves the active page on refresh", async () => {
    const firstClan = makeBulkAccountRows({
      tagPrefix: "AAA",
      namePrefix: "Alpha",
      clanTag: "#AAA001",
      clanName: "Alpha Clan",
      count: 100,
      discordUserId: "222222222222222222",
    });
    const secondClan = makeBulkAccountRows({
      tagPrefix: "BBB",
      namePrefix: "Bravo",
      clanTag: "#BBB001",
      clanName: "Bravo Clan",
      count: 100,
      discordUserId: "222222222222222222",
    });
    prismaMock.playerLink.findMany.mockResolvedValue([...firstClan.links, ...secondClan.links]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      ...firstClan.playerCurrents,
      ...secondClan.playerCurrents,
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      ...firstClan.links.map((link) => ({
        tag: link.playerTag,
        name: link.playerName,
        clanTag: "#AAA001",
        clanName: "Alpha Clan",
      })),
      ...secondClan.links.map((link) => ({
        tag: link.playerTag,
        name: link.playerName,
        clanTag: "#BBB001",
        clanName: "Bravo Clan",
      })),
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA001", name: "Alpha Clan", shortName: "ALPHA" },
      { tag: "#BBB001", name: "Bravo Clan", shortName: "BRAVO" },
    ]);
    const listPlayerLinksSpy = vi.spyOn(PlayerLinkService, "listPlayerLinksForDiscordUser").mockResolvedValue(
      [...firstClan.links, ...secondClan.links].map((link) => ({
        playerTag: link.playerTag,
        linkedAt: link.createdAt,
        linkedName: link.playerName,
      })),
    );
    const interaction = makeInteraction({
      discordUserId: "222222222222222222",
    });

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    const firstPageDescription = getEmbedDescription(interaction);
    expect(firstPageDescription.startsWith("Linked Discord: <@222222222222222222>\n\n")).toBe(true);
    expect(firstPageDescription).toContain("Alpha Clan");
    expect(firstPageDescription).not.toContain("Bravo Clan");
    expect((firstPageDescription.match(/OpenPlayerProfile/g) ?? []).length).toBeGreaterThan(18);
    expect(firstPageDescription.length).toBeLessThanOrEqual(4096);

    const collect = interaction.__collectorHandlers.collect;
    expect(collect).toBeTypeOf("function");
    const nextButton = makeButtonInteraction("accounts:777777777777777777:next");
    await collect(nextButton);
    const nextPayload = nextButton.update.mock.calls[0][0] as any;
    const nextDescription = readEmbedDescription(nextPayload.embeds[0]);
    expect(nextDescription).toContain("Bravo Clan");
    expect(nextDescription).not.toContain("Alpha Clan");
    expect(nextDescription.length).toBeLessThanOrEqual(4096);

    const refreshButton = makeButtonInteraction("accounts:777777777777777777:refresh");
    await collect(refreshButton);
    const refreshPayload = refreshButton.update.mock.calls[0][0] as any;
    const refreshDescription = readEmbedDescription(refreshPayload.embeds[0]);
    expect(refreshDescription).toContain("Bravo Clan");
    expect(refreshDescription).not.toContain("Alpha Clan");
    expect(refreshDescription.length).toBeLessThanOrEqual(4096);
    expect(getEmbedDescription(interaction)).toContain("Bravo Clan");
    listPlayerLinksSpy.mockRestore();
  });

  it("adds a refresh button that reruns clan resolution and disables itself while refreshing", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        discordUserId: "111111111111111111",
      },
    ]);
    prismaMock.playerCurrent.findMany
      .mockResolvedValueOnce([
        makePlayerCurrentRow({
          playerTag: "#PYLQ0289",
          playerName: "Linked Alpha",
          currentClanTag: "#PQL0289",
          currentClanName: "Old Clan",
        }),
      ])
      .mockResolvedValueOnce([
        makePlayerCurrentRow({
          playerTag: "#PYLQ0289",
          playerName: "Linked Alpha",
          currentClanTag: "#PQL0289",
          currentClanName: "Old Clan",
        }),
      ])
      .mockResolvedValueOnce([
        makePlayerCurrentRow({
          playerTag: "#PYLQ0289",
          playerName: "Linked Alpha",
          currentClanTag: "#GRJ0289",
          currentClanName: "New Clan",
          lastSource: "accounts-refresh",
        }),
      ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    const cocService = makeCocService({
      "#PYLQ0289": {
        name: "Linked Alpha",
        clan: { tag: "#PQL0289", name: "Old Clan" },
        role: "member",
      },
    });
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    const initialPayload = interaction.editReply.mock.calls[0][0] as any;
    const initialControls = initialPayload.components[0].toJSON().components;
    expect(initialControls.map((button: any) => button.label)).toContain("Refresh");

    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#PYLQ0289", name: "Linked Alpha", clanTag: "#GRJ0289", clanName: "New Clan" },
    ]);
    cocService.playersByTag["#PYLQ0289"] = {
      name: "Linked Alpha",
      clan: { tag: "#GRJ0289", name: "New Clan" },
      role: "member",
    };

    const refreshHandler = interaction.__collectorHandlers.collect;
    expect(refreshHandler).toBeTypeOf("function");
    const refreshButton = makeButtonInteraction("accounts:777777777777777777:refresh");
    await refreshHandler(refreshButton);

    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "accounts:list:refresh",
      }),
      expect.any(Function),
    );

    const refreshingPayload = refreshButton.update.mock.calls[0]?.[0] as any;
    const refreshingLabels = refreshingPayload.components[0].toJSON().components.map(
      (button: any) => button.label,
    );
    expect(refreshingLabels).toContain("Refreshing...");

    const refreshedDescription = getEmbedDescription(interaction);
    expect(refreshedDescription).toContain(
      "**[New Clan](https://link.clashofclans.com/en?action=OpenClanProfile&tag=GRJ0289)**",
    );
    expect(prismaMock.playerCurrent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerTag: "#PYLQ0289" },
        update: expect.objectContaining({
          currentClanTag: "#GRJ0289",
          currentClanName: "New Clan",
          lastSource: "accounts-refresh",
        }),
      }),
    );
  });

  it("calls refresh getPlayerRaw with the service binding", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        currentClanTag: "#PQL0289",
        currentClanName: "Old Clan",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn(async function (this: any, tag: string) {
        expect(this).toBe(cocService);
        expect(tag).toBe("#PYLQ0289");
        expect(cocQueueMock.state.active).toBe(true);
        return {
          name: "Linked Alpha",
          clan: { tag: "#GRJ0289", name: "New Clan" },
          role: "member",
        };
      }),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    const refreshHandler = interaction.__collectorHandlers.collect;
    expect(refreshHandler).toBeTypeOf("function");
    const refreshButton = makeButtonInteraction("accounts:777777777777777777:refresh");
    await refreshHandler(refreshButton);

    expect(cocService.getPlayerRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.playerCurrent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerTag: "#PYLQ0289" },
        update: expect.objectContaining({
          currentClanTag: "#GRJ0289",
          currentClanName: "New Clan",
          lastSource: "accounts-refresh",
        }),
      }),
    );
  });

  it("logs refresh fetch failures without aborting the refresh flow", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        currentClanTag: "#PQL0289",
        currentClanName: "Old Clan",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn(async function (this: any) {
        expect(cocQueueMock.state.active).toBe(true);
        throw new Error("COC_QUEUE_CONTEXT_MISSING:getPlayerRaw");
      }),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    const refreshHandler = interaction.__collectorHandlers.collect;
    expect(refreshHandler).toBeTypeOf("function");
    const refreshButton = makeButtonInteraction("accounts:777777777777777777:refresh");
    await refreshHandler(refreshButton);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("command=/accounts source=accounts:list:refresh stage=fetch"),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("tag=#PYLQ0289"),
    );
    expect(prismaMock.playerCurrent.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerTag: "#PYLQ0289" },
        update: expect.objectContaining({
          currentClanTag: "#GRJ0289",
        }),
      }),
    );
    consoleErrorSpy.mockRestore();
  });

  it("uses the selected Discord user id when discord-id is provided", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    const interaction = makeInteraction({
      discordUserId: "222222222222222222",
    });

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    expect(prismaMock.playerLink.findMany).toHaveBeenCalledWith({
      where: { discordUserId: "222222222222222222" },
      orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
      select: {
        playerTag: true,
        discordUserId: true,
        discordUsername: true,
        playerName: true,
        linkSource: true,
        verificationStatus: true,
        verificationMethod: true,
        verifiedAt: true,
        verifiedByDiscordUserId: true,
        lastVerifiedAt: true,
        verificationFailureReason: true,
        importBatchKey: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it("renders improved PlayerCurrent data when tag lookup resolves a linked Discord user", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "222222222222222222",
    });
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#PYLQ0289",
        playerName: "Current Alpha",
        currentClanTag: "#PQL0289",
        currentClanName: "Current Clan",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const interaction = makeInteraction({ tag: "#PYLQ0289" });

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    const description = getEmbedDescription(interaction);
    expect(description.startsWith("Linked Discord: <@222222222222222222>\n")).toBe(true);
    expect(description).toContain("Current Alpha");
    expect(description).toContain(
      "**[Current Clan](https://link.clashofclans.com/en?action=OpenClanProfile&tag=PQL0289)**",
    );
  });

  it("normalizes O to 0 when looking up a player tag through /accounts tag", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "222222222222222222",
    });
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#P0YLGQ",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#P0YLGQ",
        playerName: "Linked Alpha",
        currentClanTag: "#PQL0289",
        currentClanName: "Current Clan",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const interaction = makeInteraction({ tag: "POYLGQ" });

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    expect(prismaMock.playerLink.findUnique).toHaveBeenCalledWith({
      where: { playerTag: "#P0YLGQ" },
      select: { discordUserId: true },
    });
    const description = getEmbedDescription(interaction);
    expect(description).toContain("Linked Alpha");
    expect(description).toContain("#P0YLGQ");
    expect(description).not.toContain("POYLGQ");
  });

  it("defaults to the caller's Discord account when discord-id is omitted", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Self",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    expect(prismaMock.playerLink.findMany).toHaveBeenCalledWith({
      where: { discordUserId: "111111111111111111" },
      orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
      select: {
        playerTag: true,
        discordUserId: true,
        discordUsername: true,
        playerName: true,
        linkSource: true,
        verificationStatus: true,
        verificationMethod: true,
        verifiedAt: true,
        verifiedByDiscordUserId: true,
        lastVerifiedAt: true,
        verificationFailureReason: true,
        importBatchKey: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it("renders improved PlayerCurrent data when /accounts discord-id is used", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({
        playerTag: "#PYLQ0289",
        playerName: "Discord Alpha",
        currentClanTag: "#GRJ0289",
        currentClanName: "Discord Clan",
      }),
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const interaction = makeInteraction({
      discordUserId: "222222222222222222",
    });

    await Accounts.run({} as any, interaction as any, makeCocService() as any);

    const description = getEmbedDescription(interaction);
    expect(description.startsWith("Linked Discord: <@222222222222222222>\n")).toBe(true);
    expect(description).toContain("Discord Alpha");
    expect(description).toContain(
      "**[Discord Clan](https://link.clashofclans.com/en?action=OpenClanProfile&tag=GRJ0289)**",
    );
  });

  it("autocompletes player tags from PlayerLink and ignores tracked clans", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#ABC123",
        playerName: "Alpha",
        discordUserId: null,
      },
      {
        playerTag: "#ABC123",
        playerName: "Alpha Prime",
        discordUserId: "111111111111111111",
      },
      {
        playerTag: "#ABC999",
        playerName: "Beta",
        discordUserId: "222222222222222222",
      },
    ]);
    const interaction = makeAutocompleteInteraction("abc");

    await Accounts.autocomplete(interaction as any);

    expect(prismaMock.playerLink.findMany).toHaveBeenCalledWith({
      select: {
        discordUserId: true,
        playerName: true,
        playerTag: true,
      },
    });
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha Prime (#ABC123)", value: "#ABC123" },
      { name: "Beta (#ABC999)", value: "#ABC999" },
    ]);
  });

  it("matches by partial linked name and falls back to the bare tag label", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#QGRJ2222",
        playerName: "Bravo Player",
        discordUserId: "111111111111111111",
      },
      {
        playerTag: "#LQ9P8R2",
        playerName: null,
        discordUserId: "222222222222222222",
      },
    ]);
    const interaction = makeAutocompleteInteraction("brav");

    await Accounts.autocomplete(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Bravo Player (#QGRJ2222)", value: "#QGRJ2222" },
    ]);

    const emptyQueryInteraction = makeAutocompleteInteraction("");
    await Accounts.autocomplete(emptyQueryInteraction as any);

    expect(emptyQueryInteraction.respond).toHaveBeenCalledWith([
      { name: "Bravo Player (#QGRJ2222)", value: "#QGRJ2222" },
      { name: "#LQ9P8R2", value: "#LQ9P8R2" },
    ]);
  });

  it("caps autocomplete results at 25", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        playerTag: `#PYLQ0${String(index).padStart(3, "0")}`,
        playerName: `Player ${String(index).padStart(2, "0")}`,
        discordUserId: "111111111111111111",
      })),
    );
    const interaction = makeAutocompleteInteraction("");

    await Accounts.autocomplete(interaction as any);

    expect((interaction.respond as any).mock.calls[0][0]).toHaveLength(25);
  });

  it("does not autocomplete discord-id anymore", async () => {
    const interaction = makeAutocompleteInteraction("", "discord-id");

    await Accounts.autocomplete(interaction as any);

    expect(prismaMock.playerLink.findMany).not.toHaveBeenCalled();
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it("uses PlayerActivity clan name in output when local clan context is complete", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Delta",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#PYLQ0289", name: "Activity Delta", clanTag: "#PQL0289", clanName: "Saved Clan Name" },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Saved Clan Name", shortName: "SAVED" },
    ]);
    const cocService = makeCocService({
      "#PYLQ0289": {
        name: "Live Delta",
        clan: { tag: "#PQL0289", name: "Saved Clan Name" },
        role: "member",
      },
    });
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(getEmbedDescription(interaction)).toContain(
      "**[Saved Clan Name](https://link.clashofclans.com/en?action=OpenClanProfile&tag=PQL0289)**",
    );
  });

  it("uses tracked clan fallback name when playerActivity.clanTag exists but clanName is missing", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#QGRJ2222",
        playerName: "Linked Echo",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#QGRJ2222", name: "Activity Echo", clanTag: "#2QG2C08UP", clanName: null },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Tracked Clan Name", shortName: null },
    ]);
    const cocService = makeCocService({
      "#QGRJ2222": {
        name: "Live Echo",
        clan: { tag: "#2QG2C08UP", name: "Tracked Clan Name" },
        role: "member",
      },
    });
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(getEmbedDescription(interaction)).toContain(
      "**[Tracked Clan Name](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP)**",
    );
  });
});
