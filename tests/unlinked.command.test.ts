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
  channel?: { id: string; guildId?: string; type?: number } | null;
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
      getChannel: vi.fn((name: string) => (name === "channel" ? (input.channel ?? null) : null)),
      getString: vi.fn((name: string) => (name === "clan" ? (input.clan ?? null) : null)),
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

  it("stores the configured alert channel through the dedicated service", async () => {
    const setAlertChannelId = vi
      .spyOn(unlinkedMemberAlertService, "setAlertChannelId")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      subcommand: "set-alert",
      channel: {
        id: "channel-1",
        guildId: "guild-1",
        type: ChannelType.GuildText,
      },
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(setAlertChannelId).toHaveBeenCalledWith({
      guildId: "guild-1",
      channelId: "channel-1",
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Saved the unlinked-player alert channel: <#channel-1>.",
    );
  });

  it("lists current unresolved unlinked players and supports clan filtering", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(unlinkedMemberAlertService, "listCurrentUnlinkedMembers").mockResolvedValue([
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

    expect(unlinkedMemberAlertService.listCurrentUnlinkedMembers).toHaveBeenCalledWith({
      guildId: "guild-1",
      cocService: {},
      clanTag: "#2QG2C08UP",
    });
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
      expect.stringContaining("[unlinked] stage=member_fetch_started"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=member_fetch_completed"),
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
    vi.spyOn(unlinkedMemberAlertService, "listCurrentUnlinkedMembers").mockResolvedValue([]);
    const interaction = createInteraction({
      subcommand: "list",
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "Current unresolved unlinked players:\n- none",
    );
  });

  it("surfaces a visible timeout when live member lookup stalls", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(unlinkedMemberAlertService, "listCurrentUnlinkedMembers").mockRejectedValue(
      new UnlinkedStageTimeoutError("fwa_member_fetch", 15_000, "clan=#2QG2C08UP"),
    );
    const interaction = createInteraction({
      subcommand: "list",
      clan: "#2QG2C08UP",
    });

    await Unlinked.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Unlinked-player lookup timed out while loading live clan data. Please try again.",
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=handler_entered"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=interaction_deferred"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=terminal_error status=timeout"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=terminal status=timeout"),
    );
  });
});
