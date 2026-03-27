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

  it("uses PlayerLink.playerName first when present and avoids live fetch for that row", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#PYLQ0289", name: "Activity Alpha", clanTag: "#PQL0289" },
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

  it("fetches live name and backfills PlayerLink.playerName when missing", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#QGRJ2222",
        playerName: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        name: "Live Bravo",
        clan: { tag: "#PQL0289", name: "Clan One" },
      }),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);
    await Promise.resolve();

    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#QGRJ2222");
    expect(getEmbedDescription(interaction)).toContain("- Live Bravo `#QGRJ2222`");
    expect(prismaMock.playerLink.updateMany).toHaveBeenCalledWith({
      where: {
        playerTag: "#QGRJ2222",
        OR: [{ playerName: null }, { playerName: "" }],
      },
      data: { playerName: "Live Bravo" },
    });
  });

  it("uses local fallback name when live fetch fails and does not write backfill", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#CUV9082",
        playerName: "",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#CUV9082", name: "Activity Charlie", clanTag: "#2QG2C08UP" },
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockRejectedValue(new Error("coc unavailable")),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(getEmbedDescription(interaction)).toContain("- Activity Charlie `#CUV9082`");
    expect(prismaMock.playerLink.updateMany).not.toHaveBeenCalled();
  });

  it("falls back to raw tag when no linked/live/activity name exists", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#LQ9P8R2",
        playerName: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockRejectedValue(new Error("coc unavailable")),
    };
    const interaction = makeInteraction();

    await Accounts.run({} as any, interaction as any, cocService as any);

    expect(getEmbedDescription(interaction)).toContain("- #LQ9P8R2 `#LQ9P8R2`");
    expect(prismaMock.playerLink.updateMany).not.toHaveBeenCalled();
  });
});
