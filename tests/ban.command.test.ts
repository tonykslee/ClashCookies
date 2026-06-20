import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ban, buildBanListEmbeds, parseBanDuration } from "../src/commands/Ban";
import { banLogService } from "../src/services/BanLogService";
import { BanService } from "../src/services/BanService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function createInteraction(input: {
  subcommand: "add" | "list" | "remove";
  player?: string | null;
  user?: { id: string; username?: string | null } | null;
  member?: { displayName?: string | null } | null;
  clan?: string | null;
  reason?: string | null;
  duration?: string | null;
  guildId?: string;
  isAdmin?: boolean;
  fetchReplyMessage?: any;
} = {}) {
  const interaction: any = {
    id: "interaction-1",
    user: { id: "111111111111111111" },
    guildId: input.guildId ?? "guild-1",
    inGuild: vi.fn().mockReturnValue(true),
    memberPermissions: {
      has: vi.fn().mockReturnValue(input.isAdmin ?? true),
    },
    options: {
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getSubcommandGroup: vi.fn().mockReturnValue(null),
      getString: vi.fn((name: string) => {
        if (name === "player") return input.player ?? null;
        if (name === "clan") return input.clan ?? null;
        if (name === "reason") return input.reason ?? null;
        if (name === "duration") return input.duration ?? null;
        return null;
      }),
      getUser: vi.fn((name: string) => {
        if (name === "user") return input.user ?? null;
        return null;
      }),
      getMember: vi.fn((name: string) => {
        if (name === "user") return input.member ?? null;
        return null;
      }),
    },
  };

  interaction.reply = vi.fn().mockImplementation(async () => {
    interaction.replied = true;
    return undefined;
  });
  interaction.deferReply = vi.fn().mockImplementation(async () => {
    interaction.deferred = true;
    return undefined;
  });
  interaction.editReply = vi.fn().mockResolvedValue(undefined);
  interaction.fetchReply = vi.fn().mockResolvedValue(input.fetchReplyMessage ?? null);
  interaction.replied = false;
  interaction.deferred = false;

  return interaction;
}

function createAutocompleteInteraction(input: { value?: string; subcommand?: "add" | "list" | "remove" } = {}) {
  const interaction: any = {
    options: {
      getFocused: vi.fn().mockReturnValue({ name: "clan", value: input.value ?? "" }),
      getSubcommand: vi.fn().mockReturnValue(input.subcommand ?? "add"),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
  return interaction;
}

function createButton(customId: string, userId = "111111111111111111") {
  return {
    customId,
    user: { id: userId },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function extractComponentIds(payload: any): string[] {
  return (payload.components ?? []).flatMap((row: any) => {
    const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
    return (rowJson.components ?? []).map(
      (component: any) => component.customId ?? component.custom_id ?? "",
    );
  });
}

describe("/ban command shape", () => {
  it("registers add/list/remove subcommands with the expected option types", () => {
    const add = Ban.options?.find(
      (option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === "add",
    );
    const list = Ban.options?.find(
      (option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === "list",
    );
    const remove = Ban.options?.find(
      (option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === "remove",
    );

    expect(add).toBeTruthy();
    expect(list).toBeTruthy();
    expect(remove).toBeTruthy();
    expect(add?.options?.find((option: any) => option.name === "player")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(add?.options?.find((option: any) => option.name === "user")?.type).toBe(
      ApplicationCommandOptionType.User,
    );
    expect(add?.options?.find((option: any) => option.name === "clan")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(add?.options?.find((option: any) => option.name === "clan")?.autocomplete).toBe(true);
    expect(add?.options?.find((option: any) => option.name === "reason")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(add?.options?.find((option: any) => option.name === "duration")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(remove?.options?.find((option: any) => option.name === "player")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(remove?.options?.find((option: any) => option.name === "user")?.type).toBe(
      ApplicationCommandOptionType.User,
    );
  });
});

describe("ban duration parsing", () => {
  it("accepts 3mo, 2w, 10d, and 12h", () => {
    const now = new Date("2026-01-31T12:00:00.000Z");

    expect(parseBanDuration("3mo", now)).toEqual({
      kind: "valid",
      expiresAt: new Date("2026-04-30T12:00:00.000Z"),
    });
    expect(parseBanDuration("2w", now)).toEqual({
      kind: "valid",
      expiresAt: new Date("2026-02-14T12:00:00.000Z"),
    });
    expect(parseBanDuration("10d", now)).toEqual({
      kind: "valid",
      expiresAt: new Date("2026-02-10T12:00:00.000Z"),
    });
    expect(parseBanDuration("12h", now)).toEqual({
      kind: "valid",
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
    });
  });

  it("rejects invalid duration strings", () => {
    for (const input of ["3m", "abc", "0d", "-1w"]) {
      const result = parseBanDuration(input, new Date("2026-01-31T12:00:00.000Z"));
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.message).toContain("invalid_duration");
      }
    }
  });
});

describe("/ban command behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    vi.spyOn(banLogService, "postBanActionLog").mockResolvedValue(undefined);
  });

  it("adds a player ban with normalized tag, reason, duration, and clan context", async () => {
    const addPlayerBan = vi
      .spyOn(BanService.prototype, "addPlayerBan")
      .mockResolvedValue({
        outcome: "created",
        record: {
          id: "ban-1",
          guildId: "guild-1",
          targetKind: "PLAYER",
          playerTag: "#PYLQ0289",
          discordUserId: null,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          reason: "spam",
          bannedByDiscordUserId: "111111111111111111",
          createdAt: new Date("2026-01-31T12:00:00.000Z"),
          expiresAt: new Date("2026-04-30T12:00:00.000Z"),
          removedAt: null,
          removedByDiscordUserId: null,
          removeReason: null,
          updatedAt: new Date("2026-01-31T12:00:00.000Z"),
        },
      } as any);
    const interaction = createInteraction({
      subcommand: "add",
      player: "pylq0289",
      clan: "2qg2c08up",
      reason: "  spam  ",
      duration: "3mo",
    });

    await Ban.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(addPlayerBan).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        clanTag: "2qg2c08up",
        reason: "spam",
        bannedByDiscordUserId: "111111111111111111",
      }),
    );
    expect((addPlayerBan.mock.calls[0]?.[0] as any).expiresAt).toBeInstanceOf(Date);
    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: expect.stringContaining("created: player ban for #PYLQ0289."),
    });
    expect((interaction.editReply.mock.calls[0]?.[0] as any).content).toContain("expires <t:");
    expect(banLogService.postBanActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        client: {},
        guildId: "guild-1",
        action: "created",
        actorDiscordUserId: "111111111111111111",
      }),
    );
  });

  it("adds a user ban with the provided Discord user target", async () => {
    const addUserBan = vi.spyOn(BanService.prototype, "addUserBan").mockResolvedValue({
      outcome: "created",
      record: {
        id: "ban-1",
        guildId: "guild-1",
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        targetDiscordUsername: "someuser",
        targetDiscordDisplayName: "Some Display Name",
        clanTag: null,
        clanName: null,
        reason: null,
        bannedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
        expiresAt: null,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
        updatedAt: new Date("2026-06-08T12:00:00.000Z"),
      },
    } as any);
    const interaction = createInteraction({
      subcommand: "add",
      user: { id: "222222222222222222", username: "someuser" },
      member: { displayName: "Some Display Name" },
    });

    await Ban.run({} as any, interaction as any, {} as any);

    expect(addUserBan).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        discordUserId: "222222222222222222",
        bannedByDiscordUserId: "111111111111111111",
        reason: null,
        expiresAt: null,
        targetDiscordUsername: "someuser",
        targetDiscordDisplayName: "Some Display Name",
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "created: user ban for <@222222222222222222>. indefinite.",
    });
    expect(banLogService.postBanActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        client: {},
        guildId: "guild-1",
        action: "created",
        actorDiscordUserId: "111111111111111111",
      }),
    );
  });

  it("returns a clear error for invalid clan values", async () => {
    vi.spyOn(BanService.prototype, "addPlayerBan").mockResolvedValue({
      outcome: "invalid_clan",
      record: null,
    } as any);
    const interaction = createInteraction({
      subcommand: "add",
      player: "#PYLQ0289",
      clan: "#ZZZ999999",
    });

    await Ban.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "invalid_clan: select a tracked clan from autocomplete or use a tracked clan tag.",
    });
  });

  it("requires exactly one target for add", async () => {
    const interaction = createInteraction({
      subcommand: "add",
    });

    await Ban.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "exactly_one_target_required: provide either player or user, but not both.",
    });
  });

  it("requires exactly one target for remove", async () => {
    const interaction = createInteraction({
      subcommand: "remove",
      player: "#PYLQ0289",
      user: { id: "222222222222222222" },
    });

    await Ban.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "exactly_one_target_required: provide either player or user, but not both.",
    });
  });

  it("returns a clear error for invalid player tags", async () => {
    const interaction = createInteraction({
      subcommand: "add",
      player: "abc",
    });

    await Ban.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
    });
  });

  it("returns a clear error for invalid duration strings", async () => {
    const interaction = createInteraction({
      subcommand: "add",
      player: "#PYLQ0289",
      duration: "3m",
    });

    await Ban.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "invalid_duration: use 3mo, 2w, 10d, or 12h.",
    });
    expect(banLogService.postBanActionLog).not.toHaveBeenCalled();
  });

  it("returns a no-op message when removing a missing active ban", async () => {
    vi.spyOn(BanService.prototype, "removePlayerBan").mockResolvedValue({
      outcome: "not_found",
      record: null,
    } as any);
    const interaction = createInteraction({
      subcommand: "remove",
      player: "#PYLQ0289",
    });

    await Ban.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "no_active_ban: #PYLQ0289 is not actively banned.",
    });
  });

  it("removes an active player ban and posts a ban-log entry", async () => {
    const removePlayerBan = vi.spyOn(BanService.prototype, "removePlayerBan").mockResolvedValue({
      outcome: "removed",
      record: {
        id: "ban-1",
        guildId: "guild-1",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        discordUserId: null,
        clanTag: null,
        clanName: null,
        reason: "spam",
        bannedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
        expiresAt: null,
        removedAt: new Date("2026-06-08T13:00:00.000Z"),
        removedByDiscordUserId: "111111111111111111",
        removeReason: null,
        updatedAt: new Date("2026-06-08T13:00:00.000Z"),
      },
    } as any);
    const interaction = createInteraction({
      subcommand: "remove",
      player: "#PYLQ0289",
    });

    await Ban.run({} as any, interaction as any, {} as any);

    expect(removePlayerBan).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        removedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "removed: player ban for #PYLQ0289.",
    });
    expect(banLogService.postBanActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        client: {},
        guildId: "guild-1",
        action: "removed",
        actorDiscordUserId: "111111111111111111",
      }),
    );
  });

  it("renders paginated list embeds and advances pages with the navigation buttons", async () => {
    const rows = Array.from({ length: 28 }, (_value, index) => ({
      id: `ban-${index + 1}`,
      guildId: "guild-1",
      targetKind: "PLAYER",
      playerTag: `#PYLQ${String(index % 10000).padStart(4, "0").replace(/[^0289]/g, "0")}`,
      discordUserId: null,
      reason: `Reason ${index + 1} ${"x".repeat(90)}`,
      bannedByDiscordUserId: "111111111111111111",
      createdAt: new Date(`2026-06-08T${String(index % 10).padStart(2, "0")}:00:00.000Z`),
      expiresAt: null,
      removedAt: null,
      removedByDiscordUserId: null,
      removeReason: null,
      updatedAt: new Date(`2026-06-08T${String(index % 10).padStart(2, "0")}:00:00.000Z`),
      linkedPlayerTags: [],
    }));

    const collectorState: {
      collect?: (button: any) => Promise<void>;
      end?: () => Promise<void>;
    } = {};
    const collector = {
      on: vi.fn((event: string, handler: any) => {
        if (event === "collect") collectorState.collect = handler;
        if (event === "end") collectorState.end = handler;
        return collector;
      }),
    };
    const createMessageComponentCollector = vi.fn().mockReturnValue(collector);
    const replyMessage = { createMessageComponentCollector };
    vi.spyOn(BanService.prototype, "listActiveBans").mockResolvedValue(rows as any);
    const interaction = createInteraction({
      subcommand: "list",
      fetchReplyMessage: replyMessage,
    });

    await Ban.run({} as any, interaction as any, {} as any);

    const firstPayload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(firstPayload.embeds).toHaveLength(1);
    expect(extractComponentIds(firstPayload)).toEqual([
      "ban:interaction-1:prev",
      "ban:interaction-1:next",
    ]);
    expect(createMessageComponentCollector).toHaveBeenCalledTimes(1);
    expect(collectorState.collect).toBeTruthy();
    expect(collectorState.end).toBeTruthy();

    const nextButton = createButton("ban:interaction-1:next");
    await collectorState.collect?.(nextButton);
    expect(nextButton.update).toHaveBeenCalledTimes(1);
    const nextPayload = nextButton.update.mock.calls[0]?.[0] as any;
    expect(nextPayload.embeds[0].toJSON().footer.text).toContain("Page 2/");

    const prevButton = createButton("ban:interaction-1:prev");
    await collectorState.collect?.(prevButton);
    expect(prevButton.update).toHaveBeenCalledTimes(1);
    const prevPayload = prevButton.update.mock.calls[0]?.[0] as any;
    expect(prevPayload.embeds[0].toJSON().footer.text).toContain("Page 1/");

    await collectorState.end?.();
    expect(interaction.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("includes clan context in list embeds when present and omits it when absent", () => {
    const withClan = buildBanListEmbeds([
      {
        id: "ban-1",
        guildId: "guild-1",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        discordUserId: null,
        targetDiscordUsername: null,
        targetDiscordDisplayName: null,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        reason: "spam",
        bannedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
        expiresAt: null,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
        updatedAt: new Date("2026-06-08T12:00:00.000Z"),
        linkedPlayerTags: [],
        targetPlayerName: "Alpha Player",
      } as any,
    ]);
    const withoutClan = buildBanListEmbeds([
      {
        id: "ban-2",
        guildId: "guild-1",
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        targetDiscordUsername: "someuser",
        targetDiscordDisplayName: "Some Display Name",
        clanTag: null,
        clanName: null,
        reason: null,
        bannedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
        expiresAt: null,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
        updatedAt: new Date("2026-06-08T12:00:00.000Z"),
        linkedPlayerTags: ["#PYLQ0289"],
        targetPlayerName: null,
      } as any,
    ]);

    expect(withClan[0]?.toJSON().description).toContain("PLAYER | Alpha Player `#PYLQ0289`");
    expect(withClan[0]?.toJSON().description).toContain("clan: Alpha Clan `#2QG2C08UP`");
    expect(withoutClan[0]?.toJSON().description).toContain(
      "USER | <@222222222222222222> | username: someuser | display: Some Display Name",
    );
    expect(withoutClan[0]?.toJSON().description).not.toContain("clan:");
  });

  it("autocompletes tracked clans with stable tag values", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Alpha Clan" },
      { tag: "#QGRJ0222", name: "Beta Clan" },
    ]);
    const interaction = createAutocompleteInteraction({ value: "clan" });

    await Ban.autocomplete?.(interaction as any);

    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { name: true, tag: true },
    });
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha Clan (#2QG2C08UP)", value: "#2QG2C08UP" },
      { name: "Beta Clan (#QGRJ0222)", value: "#QGRJ0222" },
    ]);
  });

  it("renders list rows without reason text when no reason is stored", () => {
    const embeds = buildBanListEmbeds([
      {
        id: "ban-1",
        guildId: "guild-1",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        discordUserId: null,
        targetDiscordUsername: null,
        targetDiscordDisplayName: null,
        clanTag: null,
        clanName: null,
        reason: null,
        bannedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
        expiresAt: null,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
        updatedAt: new Date("2026-06-08T12:00:00.000Z"),
        linkedPlayerTags: [],
        targetPlayerName: null,
      } as any,
    ]);

    const payload = embeds[0]?.toJSON() as any;
    expect(payload.description).toContain("PLAYER | `#PYLQ0289`");
    expect(payload.description).not.toContain("reason:");
  });
});
