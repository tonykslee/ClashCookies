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

function makeAutocompleteInteraction(value: string) {
  return {
    options: {
      getFocused: vi.fn(() => ({ name: "tag", value })),
    },
    respond: vi.fn().mockResolvedValue(undefined),
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

  it("uses PlayerLink.playerName first when present and keeps render DB-only", async () => {
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
    const cocService = {
      getPlayerRaw: vi.fn(),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(getEmbedDescription(interaction)).toContain("- Linked Alpha `#PYLQ0289`");
    expect(prismaMock.playerLink.updateMany).not.toHaveBeenCalled();
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
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        name: "Live Bravo",
        clan: { tag: "#PQL0289", name: "Clan One" },
      }),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(getEmbedDescription(interaction)).toContain("- Activity Bravo `#QGRJ2222`");
    expect(prismaMock.playerLink.updateMany).not.toHaveBeenCalled();
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
    const cocService = {
      getPlayerRaw: vi.fn().mockRejectedValue(new Error("coc unavailable")),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(getEmbedDescription(interaction)).toContain("- #CUV9082 `#CUV9082`");
    expect(prismaMock.playerLink.updateMany).not.toHaveBeenCalled();
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
    const cocService = {
      getPlayerRaw: vi.fn(),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(getEmbedDescription(interaction)).toContain("**Saved Clan Name (#PQL0289)**");
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
      { tag: "#2QG2C08UP", name: "Tracked Clan Name" },
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockRejectedValue(new Error("coc unavailable")),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(getEmbedDescription(interaction)).toContain("**Tracked Clan Name (#2QG2C08UP)**");
  });
});
