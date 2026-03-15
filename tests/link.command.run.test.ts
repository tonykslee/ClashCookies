import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Link } from "../src/commands/Link";
import { CommandPermissionService } from "../src/services/CommandPermissionService";

type InteractionInput = {
  subcommand: "create" | "delete" | "list";
  playerTag?: string | null;
  userOverride?: string | null;
  clanTag?: string | null;
  userId?: string;
  isAdmin?: boolean;
};

function makeInteraction(input: InteractionInput) {
  return {
    guildId: "guild-1",
    user: { id: input.userId ?? "111111111111111111" },
    memberPermissions: {
      has: vi.fn().mockReturnValue(Boolean(input.isAdmin)),
    },
    options: {
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "player-tag") return input.playerTag ?? null;
        if (name === "user") return input.userOverride ?? null;
        if (name === "clan-tag") return input.clanTag ?? null;
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/link run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findUnique.mockReset();
    prismaMock.playerLink.create.mockReset();
    prismaMock.playerLink.delete.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
  });

  it("creates a self-link when tag is unlinked", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue(null);
    prismaMock.playerLink.create.mockResolvedValue({
      playerTag: "#PYL0289",
      discordUserId: "111111111111111111",
    });
    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289",
      userId: "111111111111111111",
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.create).toHaveBeenCalledWith({
      data: { playerTag: "#PYL0289", discordUserId: "111111111111111111" },
    });
    expect(interaction.editReply).toHaveBeenCalledWith("created: #PYL0289 linked to you.");
  });

  it("returns conflict when already linked to another user", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "999999999999999999",
    });
    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289",
      userId: "111111111111111111",
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.create).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "already_linked_to_other_user: #PYL0289 is linked to <@999999999999999999>. delete-first is required."
    );
  });

  it("rejects create-for-other when admin override permission is denied", async () => {
    vi.spyOn(CommandPermissionService.prototype, "canUseAnyTarget").mockResolvedValue(false);
    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289",
      userOverride: "222222222222222222",
      userId: "111111111111111111",
      isAdmin: false,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "not_allowed: only admins can create links for another Discord user."
    );
    expect(prismaMock.playerLink.create).not.toHaveBeenCalled();
  });

  it("deletes link when invoked by owner", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "111111111111111111",
    });
    prismaMock.playerLink.delete.mockResolvedValue({});
    const interaction = makeInteraction({
      subcommand: "delete",
      playerTag: "#pyl0289",
      userId: "111111111111111111",
      isAdmin: false,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.delete).toHaveBeenCalledWith({
      where: { playerTag: "#PYL0289" },
    });
    expect(interaction.editReply).toHaveBeenCalledWith("deleted: #PYL0289.");
  });

  it("lists linked members in roster order with deterministic linkedAt format", async () => {
    const createdAt = new Date("2026-03-15T09:07:00.000Z");
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#QGRJ2222", discordUserId: "222222222222222222", createdAt },
      { playerTag: "#PYLQ0289", discordUserId: "111111111111111111", createdAt },
    ]);
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        members: [
          { tag: "#PYLQ0289", mapPosition: 1 },
          { tag: "#QGRJ2222", mapPosition: 2 },
          { tag: "#CUV02888", mapPosition: 3 },
        ],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      [
        "linked_players: 2 for #PQL0289",
        "- #PYLQ0289 | <@111111111111111111> (111111111111111111) | linkedAt 2026-03-15 09:07 UTC",
        "- #QGRJ2222 | <@222222222222222222> (222222222222222222) | linkedAt 2026-03-15 09:07 UTC",
      ].join("\n")
    );
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("chunks /link list output when message content exceeds Discord limit", async () => {
    const createdAt = new Date("2026-03-15T09:07:00.000Z");
    const alphabet = "PYLQGRJCUV0289";
    const makeValidTag = (index: number): string => {
      const a = alphabet[Math.floor(index / alphabet.length) % alphabet.length];
      const b = alphabet[index % alphabet.length];
      return `#PY${a}${b}${a}${b}`;
    };
    const records = Array.from({ length: 45 }, (_, i) => {
      return {
        playerTag: makeValidTag(i),
        discordUserId: `11111111111111${String(i).padStart(4, "0")}`,
        createdAt,
      };
    });
    prismaMock.playerLink.findMany.mockResolvedValue(records);
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        members: records.map((row, index) => ({
          tag: row.playerTag,
          mapPosition: index + 1,
        })),
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const first = String(interaction.editReply.mock.calls[0]?.[0] ?? "");
    const followUps = interaction.followUp.mock.calls.map((call) =>
      String(call[0]?.content ?? "")
    );
    const allMessages = [first, ...followUps];

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalled();
    expect(allMessages.every((content) => content.length <= 2000)).toBe(true);
    expect(first).toContain("linked_players: 45 for #PQL0289");
    expect(allMessages.join("\n")).toContain(records[records.length - 1]?.playerTag ?? "");
  });

  it("keeps output valid when a single line would exceed Discord limit", async () => {
    const createdAt = new Date("2026-03-15T09:07:00.000Z");
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", discordUserId: "1".repeat(2500), createdAt },
    ]);
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        members: [{ tag: "#PYLQ0289", mapPosition: 1 }],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const first = String(interaction.editReply.mock.calls[0]?.[0] ?? "");
    const second = String(interaction.followUp.mock.calls[0]?.[0]?.content ?? "");
    expect(first.length).toBeLessThanOrEqual(2000);
    expect(second.length).toBeLessThanOrEqual(2000);
    expect(second).toContain("...truncated");
  });
});
