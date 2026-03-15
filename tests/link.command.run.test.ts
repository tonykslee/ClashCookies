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
  });
});
