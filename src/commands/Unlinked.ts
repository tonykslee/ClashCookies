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
import { unlinkedMemberAlertService } from "../services/UnlinkedMemberAlertService";

const UNLINKED_ALERT_SUPPORTED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
] as const;

type GuildChannelLike = {
  id: string;
  guildId?: string;
  type?: number;
};

function isGuildScopedChannel(channel: GuildChannelLike, guildId: string): boolean {
  return String(channel.guildId ?? "").trim() === guildId;
}

function isSupportedAlertChannel(channel: GuildChannelLike): boolean {
  return typeof channel.type === "number"
    ? UNLINKED_ALERT_SUPPORTED_CHANNEL_TYPES.includes(
        channel.type as (typeof UNLINKED_ALERT_SUPPORTED_CHANNEL_TYPES)[number],
      )
    : false;
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
      description: "Set the guild-level alert channel for unlinked tracked members",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "channel",
          description: "Channel for unlinked-player alerts",
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
    cocService: CoCService,
  ) => {
    try {
      await interaction.deferReply({ ephemeral: true });
      if (!interaction.inGuild() || !interaction.guildId) {
        await interaction.editReply("This command can only be used in a server.");
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
            "Selected channel must be a server text, announcement, or thread channel.",
          );
          return;
        }

        await unlinkedMemberAlertService.setAlertChannelId({
          guildId: interaction.guildId,
          channelId: requestedChannel.id,
        });
        await interaction.editReply(
          `Saved the unlinked-player alert channel: <#${requestedChannel.id}>.`,
        );
        return;
      }

      const clanTag = normalizeClanTag(interaction.options.getString("clan", false) ?? "");
      const entries = await unlinkedMemberAlertService.listCurrentUnlinkedMembers({
        guildId: interaction.guildId,
        cocService,
        clanTag: clanTag || null,
      });
      const messages = splitDiscordLineMessages({
        lines: buildUnlinkedListLines({
          entries,
          clanTag: clanTag || null,
        }),
        maxMessages: 3,
      });
      if (messages.length <= 0) {
        await interaction.editReply("Current unresolved unlinked players:\n- none");
        return;
      }

      await interaction.editReply(messages[0]);
      for (const message of messages.slice(1)) {
        await interaction.followUp({
          ephemeral: true,
          content: message,
        });
      }
    } catch (err) {
      console.error(`unlinked command failed: ${formatError(err)}`);
      await interaction.editReply("Failed to load unlinked-player data. Please try again.");
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
