import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { splitDiscordLineMessages } from "../helper/discordLineMessageSplit";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { resolveCurrentCwlSeasonKey } from "../services/CwlRegistryService";
import { normalizeClanTag } from "../services/PlayerLinkService";
import {
  UnlinkedStageTimeoutError,
  unlinkedMemberAlertService,
} from "../services/UnlinkedMemberAlertService";

const UNLINKED_ALERT_THREAD_CHANNEL_TYPES = [
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
] as const;

const UNLINKED_ALERT_SUPPORTED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ...UNLINKED_ALERT_THREAD_CHANNEL_TYPES,
] as const;

type GuildChannelLike = {
  id: string;
  guildId?: string;
  type?: number;
  parentId?: string | null;
  parent?: {
    id?: string | null;
  } | null;
  isThread?: () => boolean;
};

function isGuildScopedChannel(channel: GuildChannelLike, guildId: string): boolean {
  return String(channel.guildId ?? "").trim() === guildId;
}

function isThreadChannel(channel: GuildChannelLike): boolean {
  if (typeof channel.isThread === "function") {
    return channel.isThread();
  }
  return typeof channel.type === "number"
    ? UNLINKED_ALERT_THREAD_CHANNEL_TYPES.includes(
        channel.type as (typeof UNLINKED_ALERT_THREAD_CHANNEL_TYPES)[number],
      )
    : false;
}

function isSupportedAlertChannel(channel: GuildChannelLike): boolean {
  return typeof channel.type === "number"
    ? channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildAnnouncement ||
        isThreadChannel(channel)
    : false;
}

function formatUnlinkedAlertDestinationConfirmation(channel: GuildChannelLike): string {
  if (!isThreadChannel(channel)) {
    return `Saved the unlinked-player alert channel: <#${channel.id}>.`;
  }

  const parentId = channel.parentId ?? channel.parent?.id ?? null;
  return parentId
    ? `Saved the unlinked-player alert thread: <#${channel.id}> (in <#${parentId}>).`
    : `Saved the unlinked-player alert thread: <#${channel.id}>.`;
}

function buildUnlinkedListLines(input: {
  entries: Array<{
    playerTag: string;
    playerName: string;
    clanTag: string;
    clanName: string;
  }>;
  clanTag: string | null;
}): string[] {
  const header = input.clanTag
    ? `Current unresolved unlinked players in ${input.clanTag}:`
    : "Current unresolved unlinked players:";
  const body =
    input.entries.length > 0
      ? input.entries.map(
          (entry) =>
            `- ${entry.playerName} (\`${entry.playerTag}\`) | ${entry.clanName} ${entry.clanTag}`,
        )
      : ["- none"];
  return [header, ...body];
}

function formatUnlinkedCommandLog(input: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(input)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function logUnlinkedCommandStage(
  stage: string,
  details: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const line = `[unlinked] stage=${stage} ${formatUnlinkedCommandLog(details)}`.trim();
  console.info(line);
}

async function autocompleteTrackedClanChoice(
  interaction: AutocompleteInteraction,
): Promise<Array<{ name: string; value: string }>> {
  const query = String(interaction.options.getFocused(true).value ?? "")
    .trim()
    .toLowerCase();
  const season = resolveCurrentCwlSeasonKey();
  const [trackedFwa, trackedCwl] = await Promise.all([
    prisma.trackedClan.findMany({
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { name: true, tag: true },
    }),
    prisma.cwlTrackedClan.findMany({
      where: { season },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { name: true, tag: true },
    }),
  ]);

  const choicesByTag = new Map<string, { name: string; value: string }>();
  for (const clan of trackedFwa) {
    const tag = normalizeClanTag(clan.tag);
    if (!tag) continue;
    const label = clan.name?.trim() ? `${clan.name.trim()} (${tag}) [FWA]` : `${tag} [FWA]`;
    choicesByTag.set(tag, { name: label.slice(0, 100), value: tag });
  }
  for (const clan of trackedCwl) {
    const tag = normalizeClanTag(clan.tag);
    if (!tag) continue;
    const existing = choicesByTag.get(tag);
    if (existing) {
      choicesByTag.set(tag, {
        name: `${existing.name} [CWL ${season}]`.slice(0, 100),
        value: tag,
      });
      continue;
    }
    const label = clan.name?.trim()
      ? `${clan.name.trim()} (${tag}) [CWL ${season}]`
      : `${tag} [CWL ${season}]`;
    choicesByTag.set(tag, { name: label.slice(0, 100), value: tag });
  }

  return [...choicesByTag.values()]
    .filter(
      (choice) =>
        choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query),
    )
    .slice(0, 25);
}

export const Unlinked: Command = {
  name: "unlinked",
  description: "Configure unlinked-player alerts and list unresolved unlinked tracked members",
  options: [
    {
      name: "set-alert",
      description: "Set the guild-level alert channel or thread for unlinked tracked members",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "channel",
          description: "Channel or thread for unlinked-player alerts",
          type: ApplicationCommandOptionType.Channel,
          required: true,
          channel_types: [...UNLINKED_ALERT_SUPPORTED_CHANNEL_TYPES],
        },
      ],
    },
    {
      name: "list",
      description: "List unresolved unlinked players currently in tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Optional tracked clan tag filter",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    let terminalOutcome: "success" | "error" | "timeout" = "success";
    try {
      logUnlinkedCommandStage("handler_entered", {
        guild: interaction.guildId ?? "DM",
        user: interaction.user.id,
      });
      await interaction.deferReply({ ephemeral: true });
      logUnlinkedCommandStage("interaction_deferred", {
        guild: interaction.guildId ?? "DM",
        user: interaction.user.id,
      });
      if (!interaction.inGuild() || !interaction.guildId) {
        await interaction.editReply("This command can only be used in a server.");
        logUnlinkedCommandStage("reply_sent", {
          method: "editReply",
          status: "success",
          reason: "not_in_guild",
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === "set-alert") {
        const requestedChannel = interaction.options.getChannel("channel", true) as GuildChannelLike;
        if (!isGuildScopedChannel(requestedChannel, interaction.guildId)) {
          await interaction.editReply("Selected channel must belong to this server.");
          return;
        }
        if (!isSupportedAlertChannel(requestedChannel)) {
          await interaction.editReply(
            "Selected destination must be a server text channel, announcement channel, or thread in this server.",
          );
          return;
        }

        await unlinkedMemberAlertService.setAlertChannelId({
          guildId: interaction.guildId,
          channelId: requestedChannel.id,
        });
        await interaction.editReply(formatUnlinkedAlertDestinationConfirmation(requestedChannel));
        logUnlinkedCommandStage("reply_sent", {
          method: "editReply",
          status: "success",
          subcommand,
        });
        return;
      }

      const rawClanFilter = interaction.options.getString("clan", false) ?? "";
      logUnlinkedCommandStage("scope_resolution_started", {
        guild: interaction.guildId,
        clan_filter: rawClanFilter,
      });
      const clanTag = normalizeClanTag(rawClanFilter);
      logUnlinkedCommandStage("scope_resolution_completed", {
        guild: interaction.guildId,
        clan_filter: rawClanFilter,
        normalized_clan: clanTag || "all",
      });
      logUnlinkedCommandStage("persisted_unlinked_query_started", {
        guild: interaction.guildId,
        clan: clanTag || "all",
      });
      const entries = await unlinkedMemberAlertService.listPersistedUnlinkedMembers({
        guildId: interaction.guildId,
        clanTag: clanTag || null,
      });
      logUnlinkedCommandStage("persisted_unlinked_query_completed", {
        guild: interaction.guildId,
        clan: clanTag || "all",
        count: entries.length,
      });
      logUnlinkedCommandStage("list_render_started", {
        guild: interaction.guildId,
        clan: clanTag || "all",
        count: entries.length,
      });
      const messages = splitDiscordLineMessages({
        lines: buildUnlinkedListLines({
          entries,
          clanTag: clanTag || null,
        }),
        maxMessages: 3,
      });
      logUnlinkedCommandStage("list_render_completed", {
        guild: interaction.guildId,
        clan: clanTag || "all",
        message_count: messages.length,
      });
      if (messages.length <= 0) {
        await interaction.editReply("Current unresolved unlinked players:\n- none");
        logUnlinkedCommandStage("reply_sent", {
          method: "editReply",
          status: "success",
          messages: 0,
        });
        return;
      }

      await interaction.editReply(messages[0]);
      logUnlinkedCommandStage("reply_sent", {
        method: "editReply",
        status: "success",
        part: 1,
        total_parts: messages.length,
      });
      for (const message of messages.slice(1)) {
        await interaction.followUp({
          ephemeral: true,
          content: message,
        });
        logUnlinkedCommandStage("reply_sent", {
          method: "followUp",
          status: "success",
          total_parts: messages.length,
        });
      }
      terminalOutcome = "success";
      } catch (err) {
        terminalOutcome = err instanceof UnlinkedStageTimeoutError ? "timeout" : "error";
        const timeout = err instanceof UnlinkedStageTimeoutError;
        console.error(
          `[unlinked] stage=terminal_error status=${terminalOutcome} error=${formatError(err)}`,
        );
        const message = timeout
        ? "Unlinked-player lookup timed out while loading persisted unresolved data. Please try again."
        : "Failed to load unlinked-player data. Please try again.";
      const replyMethod = interaction.deferred || interaction.replied ? "editReply" : "reply";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message);
      } else {
        await interaction.reply({
          ephemeral: true,
          content: message,
        });
      }
      logUnlinkedCommandStage("reply_sent", {
        method: replyMethod,
        status: terminalOutcome,
      });
    } finally {
      logUnlinkedCommandStage("terminal", {
        status: terminalOutcome,
        guild: interaction.guildId ?? "DM",
        user: interaction.user.id,
      });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    await interaction.respond(await autocompleteTrackedClanChoice(interaction));
  },
};
