import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  trackedClanRep: {
    findMany: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
}));

const cocQueueMock = vi.hoisted(() => ({
  runWithCoCQueueContext: vi.fn(async (_context: unknown, run: () => Promise<unknown>) => run()),
}));

const playerCurrentServiceMock = vi.hoisted(() => ({
  listPlayerCurrentByTags: vi.fn(),
}));

const accountDisplayServiceMock = vi.hoisted(() => ({
  buildAccountDisplayRows: vi.fn(),
  buildAccountDisplayRowText: vi.fn(),
  resolveTownHallEmojiMap: vi.fn(),
}));

const trackedClanRepServiceMock = vi.hoisted(() => ({
  listTrackedClanRepDisplayRowsForClanTags: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CoCQueueContext", () => ({
  runWithCoCQueueContext: cocQueueMock.runWithCoCQueueContext,
}));

vi.mock("../src/services/PlayerCurrentService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/PlayerCurrentService")>(
    "../src/services/PlayerCurrentService",
  );
  return {
    ...actual,
    playerCurrentService: playerCurrentServiceMock,
  };
});

vi.mock("../src/services/fwa-feeds/FwaClanMembersSyncService", () => ({
  FwaClanMembersSyncService: vi.fn().mockImplementation(() => ({
    refreshCurrentClanMembersForClanTags: vi.fn(),
  })),
}));

vi.mock("../src/services/AccountDisplayService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/AccountDisplayService")>(
    "../src/services/AccountDisplayService",
  );
  return {
    ...actual,
    buildAccountDisplayRows: accountDisplayServiceMock.buildAccountDisplayRows,
    buildAccountDisplayRowText: accountDisplayServiceMock.buildAccountDisplayRowText,
    resolveTownHallEmojiMap: accountDisplayServiceMock.resolveTownHallEmojiMap,
  };
});

vi.mock("../src/services/TrackedClanRepService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/TrackedClanRepService")>(
    "../src/services/TrackedClanRepService",
  );
  return {
    ...actual,
    listTrackedClanRepDisplayRowsForClanTags:
      trackedClanRepServiceMock.listTrackedClanRepDisplayRowsForClanTags,
  };
});

import { TrackedClan } from "../src/commands/TrackedClan";

type RepInteractionInput = {
  group?: "rep" | null;
  subcommand: "add" | "remove";
  clan?: string | null;
  player?: string | null;
  focusedName?: "clan" | "player" | "tag";
  focusedValue?: string;
};

function makeRepInteraction(input: RepInteractionInput) {
  const interaction: any = {
    id: "tracked-clan-rep-itx",
    commandName: "clan",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "111111111111111111" },
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    fetchReply: vi.fn(),
    respond: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(input.group ?? null),
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string, required?: boolean) => {
        if (name === "clan") return input.clan ?? null;
        if (name === "player") return input.player ?? null;
        if (name === "tag") return input.clan ?? null;
        return required ? null : null;
      }),
      getFocused: vi.fn().mockReturnValue({
        name: input.focusedName ?? "clan",
        value: input.focusedValue ?? "",
      }),
    },
  };
  return interaction as any;
}

describe("/clan rep commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([]);
    prismaMock.trackedClanRep.create.mockResolvedValue({});
    prismaMock.trackedClanRep.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(new Map());
    accountDisplayServiceMock.buildAccountDisplayRows.mockResolvedValue([]);
    accountDisplayServiceMock.buildAccountDisplayRowText.mockImplementation((row: any) =>
      `${row.tag} ${row.name}`,
    );
    accountDisplayServiceMock.resolveTownHallEmojiMap.mockResolvedValue(new Map());
    trackedClanRepServiceMock.listTrackedClanRepDisplayRowsForClanTags.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds a rep assignment with linked feedback", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.playerLink.findMany.mockResolvedValueOnce([
      {
        playerTag: "#PYLQ0289",
        playerName: null,
        discordUserId: "222222222222222222",
      },
    ]);
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValueOnce(
      new Map([
        [
          "#PYLQ0289",
          {
            playerTag: "#PYLQ0289",
            playerName: "Current Alpha",
          },
        ],
      ]),
    );
    prismaMock.trackedClanRep.create.mockResolvedValueOnce({});
    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      clan: "#2QG2C08UP",
      player: "#PYLQ0289",
    });
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(prismaMock.trackedClanRep.create).toHaveBeenCalledWith({
      data: {
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
      },
    });
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Rep assignment added.",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Clan: Alpha Clan (#2QG2C08UP)",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Player: Current Alpha (#PYLQ0289)",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Discord: <@222222222222222222>",
    );
  });

  it("adds a rep assignment from a persisted Discord-linked row even when the player name is null", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.playerLink.findMany.mockResolvedValueOnce([
      {
        playerTag: "#PYLQ0289",
        playerName: null,
        discordUserId: "222222222222222222",
      },
    ]);
    prismaMock.trackedClanRep.create.mockResolvedValueOnce({});
    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      clan: "#2QG2C08UP",
      player: "#PYLQ0289",
    });
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Rep assignment added.",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Player: #PYLQ0289",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Discord: <@222222222222222222>",
    );
  });

  it("reports already existing rep assignments without replacing other rows", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValueOnce(
      new Map([
        [
          "#PYLQ0289",
          {
            playerTag: "#PYLQ0289",
            playerName: "Current Alpha",
          },
        ],
      ]),
    );
    prismaMock.trackedClanRep.create.mockRejectedValueOnce({ code: "P2002" });
    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      clan: "2QG2C08UP",
      player: "PYLQ0289",
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(prismaMock.trackedClanRep.createMany).not.toHaveBeenCalled();
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Rep assignment already existed.",
    );
  });

  it("removes a rep assignment without calling CoC", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.trackedClanRep.deleteMany.mockResolvedValueOnce({ count: 1 });
    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "remove",
      clan: "2QG2C08UP",
      player: "PYLQ0289",
    });
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(prismaMock.trackedClanRep.deleteMany).toHaveBeenCalledWith({
      where: { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
    });
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Rep assignment removed.",
    );
  });

  it("keeps rep removal authoritative when identity enrichment fails after a successful delete", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.trackedClanRep.deleteMany.mockResolvedValueOnce({ count: 1 });
    playerCurrentServiceMock.listPlayerCurrentByTags.mockRejectedValueOnce(new Error("identity boom"));
    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "remove",
      clan: "#2QG2C08UP",
      player: "#PYLQ0289",
    });
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(prismaMock.trackedClanRep.deleteMany).toHaveBeenCalledTimes(1);
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Rep assignment removed.",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Player: #PYLQ0289",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Discord: Not linked to Discord",
    );
  });

  it("reports absent rep assignments", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.trackedClanRep.deleteMany.mockResolvedValueOnce({ count: 0 });
    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "remove",
      clan: "#2QG2C08UP",
      player: "#PYLQ0289",
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Rep assignment was not assigned.",
    );
  });

  it("keeps not-found rep removals authoritative when identity enrichment fails", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.trackedClanRep.deleteMany.mockResolvedValueOnce({ count: 0 });
    playerCurrentServiceMock.listPlayerCurrentByTags.mockRejectedValueOnce(new Error("identity boom"));
    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "remove",
      clan: "#2QG2C08UP",
      player: "#PYLQ0289",
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(prismaMock.trackedClanRep.deleteMany).toHaveBeenCalledTimes(1);
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Rep assignment was not assigned.",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Player: #PYLQ0289",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Discord: Not linked to Discord",
    );
  });

  it("rejects invalid tags before touching persistence", async () => {
    const invalidClan = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      clan: "not-a-clan",
      player: "#PYLQ0289",
    });
    const invalidPlayer = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      clan: "#2QG2C08UP",
      player: "bad-player",
    });

    await TrackedClan.run({} as any, invalidClan as any, {} as any);
    await TrackedClan.run({} as any, invalidPlayer as any, {} as any);

    expect(String(invalidClan.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Invalid clan tag format",
    );
    expect(String(invalidPlayer.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Invalid player tag format",
    );
    expect(prismaMock.trackedClanRep.create).not.toHaveBeenCalled();
    expect(prismaMock.trackedClanRep.deleteMany).not.toHaveBeenCalled();
  });

  it("reports missing tracked clans", async () => {
    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      clan: "#2QG2C08UP",
      player: "#PYLQ0289",
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Tracked clan #2QG2C08UP was not found.",
    );
  });

  it("looks up missing add identities through the live CoC queue and rejects not-found players", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValueOnce(null),
    };
    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      clan: "#2QG2C08UP",
      player: "#PYLQ0289",
    });

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalled();
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#PYLQ0289", { suppressTelemetry: false });
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "live CoC lookup did not find that player",
    );
    expect(prismaMock.trackedClanRep.create).not.toHaveBeenCalled();
  });

  it("autocompletes clan and player fields by subcommand group", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      { tag: "#2QG2C08UP", name: "Alpha Clan" },
      { tag: "#PYLQ0289", name: "Beta Clan" },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
      { clanTag: "#2QG2C08UP", playerTag: "#2RVGJYLC0" },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValueOnce([
      { playerTag: "#PYLQ0289", playerName: "Linked Alpha", discordUserId: "222222222222222222" },
      { playerTag: "#2RVGJYLC0", playerName: null, discordUserId: null },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([
      { playerTag: "#PYLQ0289", playerName: "Current Alpha" },
      { playerTag: "#2RVGJYLC0", playerName: "Current Bravo" },
    ]);
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValueOnce(
      new Map([
        ["#PYLQ0289", { playerTag: "#PYLQ0289", playerName: "Current Alpha" }],
        ["#2RVGJYLC0", { playerTag: "#2RVGJYLC0", playerName: "Current Bravo" }],
      ]),
    );

    const clanInteraction = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      focusedName: "clan",
      focusedValue: "alpha",
    });
    const playerAddInteraction = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      focusedName: "player",
      focusedValue: "alpha",
    });
    const playerRemoveInteraction = makeRepInteraction({
      group: "rep",
      subcommand: "remove",
      clan: "#2QG2C08UP",
      focusedName: "player",
      focusedValue: "alpha",
    });
    const missingClanInteraction = makeRepInteraction({
      group: "rep",
      subcommand: "remove",
      focusedName: "player",
      focusedValue: "alpha",
    });

    await TrackedClan.autocomplete?.(clanInteraction as any);
    await TrackedClan.autocomplete?.(playerAddInteraction as any);
    await TrackedClan.autocomplete?.(playerRemoveInteraction as any);
    await TrackedClan.autocomplete?.(missingClanInteraction as any);

    expect(clanInteraction.respond).toHaveBeenCalled();
    expect(String(clanInteraction.respond.mock.calls[0]?.[0]?.[0]?.value ?? "")).toBe("#2QG2C08UP");
    expect(String(playerAddInteraction.respond.mock.calls[0]?.[0]?.[0]?.value ?? "")).toBe(
      "#PYLQ0289",
    );
    expect(String(playerRemoveInteraction.respond.mock.calls[0]?.[0]?.[0]?.name ?? "")).toContain(
      "Current Alpha (#PYLQ0289)",
    );
    expect(missingClanInteraction.respond).toHaveBeenCalledWith([]);
  });

  it("matches leading-hash and short partial tag autocomplete queries", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      { tag: "#2Q0G2C08UP", name: "Alpha Clan" },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([
      { clanTag: "#2Q0G2C08UP", playerTag: "#2Q0G2C08UP" },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValueOnce([
      { playerTag: "#2Q0G2C08UP", playerName: null, discordUserId: "222222222222222222" },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([
      { playerTag: "#2Q0G2C08UP", playerName: "Current Zero" },
    ]);
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValueOnce(
      new Map([
        [
          "#2Q0G2C08UP",
          {
            playerTag: "#2Q0G2C08UP",
            playerName: "Current Zero",
          },
        ],
      ]),
    );

    const clanInteraction = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      focusedName: "clan",
      focusedValue: "#2qo",
    });
    const addPlayerInteraction = makeRepInteraction({
      group: "rep",
      subcommand: "add",
      focusedName: "player",
      focusedValue: "#2qo",
    });
    const removePlayerInteraction = makeRepInteraction({
      group: "rep",
      subcommand: "remove",
      clan: "#2Q0G2C08UP",
      focusedName: "player",
      focusedValue: "#2qo",
    });

    await TrackedClan.autocomplete?.(clanInteraction as any);
    await TrackedClan.autocomplete?.(addPlayerInteraction as any);
    await TrackedClan.autocomplete?.(removePlayerInteraction as any);

    expect(String(clanInteraction.respond.mock.calls[0]?.[0]?.[0]?.value ?? "")).toBe("#2Q0G2C08UP");
    expect(String(addPlayerInteraction.respond.mock.calls[0]?.[0]?.[0]?.value ?? "")).toBe(
      "#2Q0G2C08UP",
    );
    expect(String(removePlayerInteraction.respond.mock.calls[0]?.[0]?.[0]?.value ?? "")).toBe(
      "#2Q0G2C08UP",
    );
  });

  it("lists tracked clan rep assignments grouped by clan and keeps empty clans visible", async () => {
    trackedClanRepServiceMock.listTrackedClanRepDisplayRowsForClanTags.mockResolvedValueOnce([
      {
        clanTag: "#ALPHA001",
        clanName: "Alpha Clan",
        trackedClanSortOrder: 0,
        repPlayerTags: ["#PYLQ0289", "#QGRJ2222"],
      },
      {
        clanTag: "#BETA001",
        clanName: "Beta Clan",
        trackedClanSortOrder: 1,
        repPlayerTags: [],
      },
    ]);
    accountDisplayServiceMock.buildAccountDisplayRows.mockResolvedValueOnce([
      {
        tag: "#PYLQ0289",
        name: "Alpha One",
        townHall: 16,
        weight: 210000,
        weightSource: "FwaClanMemberCurrent",
        clanTag: "#ALPHA001",
        clanName: "Alpha Clan",
        clanRole: "leader",
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 0,
      },
      {
        tag: "#QGRJ2222",
        name: "Alpha Two",
        townHall: 15,
        weight: 175000,
        weightSource: "WeightInputDeferment",
        clanTag: "#ALPHA001",
        clanName: "Alpha Clan",
        clanRole: null,
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 0,
      },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValueOnce([]);

    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "list",
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(trackedClanRepServiceMock.listTrackedClanRepDisplayRowsForClanTags).toHaveBeenCalledWith(
      null,
    );
    expect(accountDisplayServiceMock.buildAccountDisplayRows).toHaveBeenCalledWith({
      guildId: "guild-1",
      linkedNameByTag: new Map(),
      tags: ["#PYLQ0289", "#QGRJ2222"],
    });

    const payload = interaction.editReply.mock.calls[0]?.[0] ?? {};
    const embed = payload.embeds?.[0]?.toJSON?.() ?? payload.embeds?.[0];
    expect(String(embed?.description ?? "")).toContain("Alpha Clan");
    expect(String(embed?.description ?? "")).toContain("#PYLQ0289 Alpha One");
    expect(String(embed?.description ?? "")).toContain("#QGRJ2222 Alpha Two");
    expect(String(embed?.description ?? "")).toContain("Beta Clan");
    expect(String(embed?.description ?? "")).toContain("No reps configured.");
  });

  it("paginates long rep lists and keeps previous/next controls attached", async () => {
    trackedClanRepServiceMock.listTrackedClanRepDisplayRowsForClanTags.mockResolvedValueOnce([
      {
        clanTag: "#ALPHA001",
        clanName: "Alpha Clan",
        trackedClanSortOrder: 0,
        repPlayerTags: ["#PYLQ0289"],
      },
      {
        clanTag: "#BETA001",
        clanName: "Beta Clan",
        trackedClanSortOrder: 1,
        repPlayerTags: ["#QGRJ2222"],
      },
    ]);
    accountDisplayServiceMock.buildAccountDisplayRows.mockResolvedValueOnce([
      {
        tag: "#PYLQ0289",
        name: "Alpha One",
        townHall: 16,
        weight: 210000,
        weightSource: "FwaClanMemberCurrent",
        clanTag: "#ALPHA001",
        clanName: "Alpha Clan",
        clanRole: "leader",
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 0,
      },
      {
        tag: "#QGRJ2222",
        name: "Beta One",
        townHall: 15,
        weight: 175000,
        weightSource: "WeightInputDeferment",
        clanTag: "#BETA001",
        clanName: "Beta Clan",
        clanRole: null,
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 1,
      },
    ]);
    accountDisplayServiceMock.buildAccountDisplayRowText.mockImplementation((row: any) =>
      `${row.tag} ${"x".repeat(2500)}`,
    );
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    const collector = { on: vi.fn() };

    const interaction = makeRepInteraction({
      group: "rep",
      subcommand: "list",
    });
    interaction.fetchReply.mockResolvedValueOnce({
      createMessageComponentCollector: vi.fn().mockReturnValue(collector),
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] ?? {};
    expect(payload.components).toHaveLength(1);
    const embed = payload.embeds?.[0]?.toJSON?.() ?? payload.embeds?.[0];
    expect(String(embed?.footer?.text ?? "")).toContain("Page 1/2");
  });
});
