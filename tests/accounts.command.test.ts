import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
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
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Accounts } from "../src/commands/Accounts";

function makeInteraction(input?: {
  visibility?: string | null;
  tag?: string | null;
  discordId?: string | null;
}) {
  return {
    guildId: "123456789012345678",
    id: "777777777777777777",
    user: { id: "111111111111111111" },
    options: {
      getString: vi.fn((name: string) => {
        if (name === "visibility") return input?.visibility ?? null;
        if (name === "tag") return input?.tag ?? null;
        if (name === "discord-id") return input?.discordId ?? null;
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({
      createMessageComponentCollector: vi.fn(),
    }),
  };
}

function makeAutocompleteInteraction(
  value: string,
  focusedName = "tag",
  input?: {
    cachedUsernames?: Record<string, string>;
    memberDisplayNames?: Record<string, string>;
    memberUsernames?: Record<string, string>;
  },
) {
  const cachedUsernames = input?.cachedUsernames ?? {};
  const memberDisplayNames = input?.memberDisplayNames ?? {};
  const memberUsernames = input?.memberUsernames ?? {};
  const memberIds = new Set([
    ...Object.keys(memberDisplayNames),
    ...Object.keys(memberUsernames),
  ]);
  return {
    client: {
      users: {
        cache: new Map(
          Object.entries(cachedUsernames).map(([id, username]) => [
            id,
            { username },
          ]),
        ),
      },
    },
    guild: {
      members: {
        cache: new Map(
          [...memberIds].map((id) => [
            id,
            {
              displayName: memberDisplayNames[id] ?? "",
              user: { username: memberUsernames[id] ?? cachedUsernames[id] ?? "" },
            },
          ]),
        ),
      },
    },
    options: {
      getFocused: vi.fn(() => ({ name: focusedName, value })),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCocService(playersByTag: Record<string, any> = {}) {
  return {
    getPlayerRaw: vi.fn(async (tag: string) => playersByTag[tag] ?? null),
  };
}

function getEmbedDescription(interaction: any): string {
  const payload = interaction.editReply.mock.calls.find(
    (call: unknown[]) => call[0] && typeof call[0] === "object" && Array.isArray(call[0].embeds)
  )?.[0] as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

describe("/accounts command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.playerLink.findUnique.mockResolvedValue(null);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.playerLink.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
  });

  it("renders tracked clan headings as alias hyperlinks and keeps rows under that clan", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
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
      "**[SC](https://link.clashofclans.com/en?action=OpenClanProfile&tag=PQL0289)**",
    );
    expect(description).toContain("- Linked Alpha `#PYLQ0289`");
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

    expect(getEmbedDescription(interaction)).toContain("- Activity Bravo `#QGRJ2222`");
  });

  it("falls back to raw tag when neither local name source exists", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#CUV9082",
        playerName: "",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const cocService = makeCocService({
      "#CUV9082": null,
    });
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(getEmbedDescription(interaction)).toContain("**No Clan**");
    expect(getEmbedDescription(interaction)).toContain("- #CUV9082 `#CUV9082`");
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
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#PYLQ0289", name: "Alpha", clanTag: "#UNTRK1", clanName: "Untracked Clan" },
      { tag: "#QGRJ2222", name: "Bravo", clanTag: "#UNTRK1", clanName: "Untracked Clan" },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    const cocService = makeCocService({
      "#PYLQ0289": {
        name: "Alpha",
        clan: { tag: "#UNTRK1", name: "Untracked Clan" },
        role: "coLeader",
      },
      "#QGRJ2222": {
        name: "Bravo",
        clan: { tag: "#UNTRK1", name: "Untracked Clan" },
        role: "member",
      },
    });
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    const description = getEmbedDescription(interaction);
    expect(description).toContain(
      "**[Untracked Clan](https://link.clashofclans.com/en?action=OpenClanProfile&tag=UNTRK1)**",
    );
    expect(description).toContain(":crown: Alpha `#PYLQ0289`");
    expect(description).toContain("- Bravo `#QGRJ2222`");
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

  it("autocompletes discord IDs with rendered display names and raw values", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        discordUserId: "111111111111111111",
        discordUsername: "persisted_alpha",
      },
      {
        discordUserId: "222222222222222222",
        discordUsername: null,
      },
    ]);
    const interaction = makeAutocompleteInteraction("", "discord-id", {
      memberDisplayNames: {
        "111111111111111111": "Rendered Alpha",
      },
    });

    await Accounts.autocomplete(interaction as any);

    expect(prismaMock.playerLink.findMany).toHaveBeenCalledWith({
      select: {
        discordUserId: true,
        discordUsername: true,
      },
    });
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Rendered Alpha", value: "111111111111111111" },
      { name: "222222222222222222", value: "222222222222222222" },
    ]);
  });

  it("falls back to @username when the display name is unavailable", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        discordUserId: "333333333333333333",
        discordUsername: null,
      },
    ]);
    const interaction = makeAutocompleteInteraction("", "discord-id", {
      cachedUsernames: {
        "333333333333333333": "UsernameOnly",
      },
    });

    await Accounts.autocomplete(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "@UsernameOnly", value: "333333333333333333" },
    ]);
  });

  it("falls back to raw Discord IDs when neither display name nor username is available", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        discordUserId: "444444444444444444",
        discordUsername: null,
      },
    ]);
    const interaction = makeAutocompleteInteraction("", "discord-id");

    await Accounts.autocomplete(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "444444444444444444", value: "444444444444444444" },
    ]);
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
      "**[SAVED](https://link.clashofclans.com/en?action=OpenClanProfile&tag=PQL0289)**",
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
