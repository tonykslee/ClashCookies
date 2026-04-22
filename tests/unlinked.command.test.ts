import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import { Unlinked } from "../src/commands/Unlinked";
import {
  UnlinkedStageTimeoutError,
  unlinkedMemberAlertService,
} from "../src/services/UnlinkedMemberAlertService";

type InteractionInput = {
  subcommand: "set-alert" | "list";
  guildId?: string | null;
  enable?: string | null;
  channel?:
    | {
        id: string;
        guildId?: string;
        type?: number;
        parentId?: string | null;
        parent?: { id?: string | null } | null;
        isThread?: () => boolean;
      }
    | null;
  clan?: string | null;
};

function createInteraction(input: InteractionInput) {
  const interaction: any = {
    inGuild: vi.fn().mockReturnValue(true),
    guildId: input.guildId ?? "guild-1",
    user: { id: "111111111111111111" },
    deferred: false,
    replied: false,
    reply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "enable") return input.enable ?? null;
        if (name === "clan") return input.clan ?? null;
        return null;
      }),
      getChannel: vi.fn((name: string) => (name === "channel" ? (input.channel ?? null) : null)),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  interaction.deferReply.mockImplementation(async () => {
    interaction.deferred = true;
  });
  interaction.reply.mockImplementation(async () => {
    interaction.replied = true;
  });
  return interaction;
}

describe("/unlinked command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stores clan-log routing through the dedicated service", async () => {
    const setAlertRoutingConfig = vi
      .spyOn(unlinkedMemberAlertService, "setAlertRoutingConfig")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      subcommand: "set-alert",
      enable: "clan-log channel",
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(setAlertRoutingConfig).toHaveBeenCalledWith({
      guildId: "guild-1",
      routingMode: "CLAN_LOG",
      channelId: null,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Saved unlinked-player alert routing: tracked clan log channel.",
    );
  });

  it("stores bot-log routing through the dedicated service", async () => {
    const setAlertRoutingConfig = vi
      .spyOn(unlinkedMemberAlertService, "setAlertRoutingConfig")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      subcommand: "set-alert",
      enable: "bot-log channel",
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(setAlertRoutingConfig).toHaveBeenCalledWith({
      guildId: "guild-1",
      routingMode: "BOT_LOG",
      channelId: null,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Saved unlinked-player alert routing: /bot-logs channel.",
    );
  });

  it("stores a custom thread destination and mentions its parent channel", async () => {
    const setAlertRoutingConfig = vi
      .spyOn(unlinkedMemberAlertService, "setAlertRoutingConfig")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      subcommand: "set-alert",
      enable: "custom",
      channel: {
        id: "thread-1",
        guildId: "guild-1",
        parentId: "parent-1",
        type: ChannelType.AnnouncementThread,
      },
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(setAlertRoutingConfig).toHaveBeenCalledWith({
      guildId: "guild-1",
      routingMode: "CUSTOM",
      channelId: "thread-1",
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Saved unlinked-player alert routing: custom thread <#thread-1> (in <#parent-1>).",
    );
  });

  it("disables unlinked-player alerts through the dedicated service", async () => {
    const setAlertRoutingConfig = vi
      .spyOn(unlinkedMemberAlertService, "setAlertRoutingConfig")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      subcommand: "set-alert",
      enable: "false",
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(setAlertRoutingConfig).toHaveBeenCalledWith({
      guildId: "guild-1",
      routingMode: "DISABLED",
      channelId: null,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Disabled unlinked-player alerts.",
    );
  });

  it("requires a channel for custom routing", async () => {
    const setAlertRoutingConfig = vi.spyOn(
      unlinkedMemberAlertService,
      "setAlertRoutingConfig",
    );
    const interaction = createInteraction({
      subcommand: "set-alert",
      enable: "custom",
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(setAlertRoutingConfig).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "The `channel` option is required when `enable=custom`.",
    );
  });

  it.each([
    "clan-log channel",
    "bot-log channel",
    "false",
  ] as const)("rejects stray channel input for %s", async (enable) => {
    const setAlertRoutingConfig = vi.spyOn(
      unlinkedMemberAlertService,
      "setAlertRoutingConfig",
    );
    const interaction = createInteraction({
      subcommand: "set-alert",
      enable,
      channel: {
        id: "channel-1",
        guildId: "guild-1",
        type: ChannelType.GuildText,
      },
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(setAlertRoutingConfig).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "The `channel` option is only used when `enable=custom`.",
    );
  });

  it("lists current unresolved unlinked players and supports clan filtering", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const liveSpy = vi.spyOn(unlinkedMemberAlertService, "listCurrentUnlinkedMembers");
    vi.spyOn(unlinkedMemberAlertService, "listPersistedUnlinkedMembers").mockResolvedValue([
      {
        playerTag: "#P1",
        playerName: "One",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
      },
    ]);
    const interaction = createInteraction({
      subcommand: "list",
      clan: "#2QG2C08UP",
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(unlinkedMemberAlertService.listPersistedUnlinkedMembers).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
    });
    expect(liveSpy).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Current unresolved unlinked players in #2QG2C08UP:\n- One (`#P1`) | Alpha Clan #2QG2C08UP",
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=handler_entered"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=interaction_deferred"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=scope_resolution_started"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=scope_resolution_completed"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=persisted_unlinked_query_started"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=persisted_unlinked_query_completed"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=list_render_started"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=list_render_completed"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=reply_sent"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=terminal status=success"),
    );
  });

  it("returns a clear empty-state list when no unresolved players remain", async () => {
    const liveSpy = vi.spyOn(unlinkedMemberAlertService, "listCurrentUnlinkedMembers");
    vi.spyOn(unlinkedMemberAlertService, "listPersistedUnlinkedMembers").mockResolvedValue([]);
    const interaction = createInteraction({
      subcommand: "list",
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "Current unresolved unlinked players:\n- none",
    );
    expect(liveSpy).not.toHaveBeenCalled();
  });

  it("surfaces a visible timeout when persisted unresolved lookup stalls", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const liveSpy = vi.spyOn(unlinkedMemberAlertService, "listCurrentUnlinkedMembers");
    vi.spyOn(unlinkedMemberAlertService, "listPersistedUnlinkedMembers").mockRejectedValue(
      new UnlinkedStageTimeoutError("persisted_unlinked_query", 5_000, "guild=guild-1 clan=#2QG2C08UP"),
    );
    const interaction = createInteraction({
      subcommand: "list",
      clan: "#2QG2C08UP",
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Unlinked-player lookup timed out while loading persisted unresolved data. Please try again.",
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=persisted_unlinked_query_started"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=interaction_deferred"),
    );
    expect(liveSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=terminal_error status=timeout"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=terminal status=timeout"),
    );
  });
});
