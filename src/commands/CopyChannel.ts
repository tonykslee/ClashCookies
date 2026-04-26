import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import { buildMessageExportResult } from "../services/MessageExportService";

const MIN_EXPORT_MESSAGES = 1;
const MAX_EXPORT_MESSAGES = 100;
const SUPPORTED_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
]);
const MISSING_ACCESS_MESSAGE =
  "I need `View Channel` and `Read Message History` in this channel to export messages.";

type SupportedCopyChannel = {
  type: ChannelType;
  messages: {
    fetch: (input: { limit: number }) => Promise<Map<string, unknown>>;
  };
  permissionsFor?: (member: unknown) => { has: (permissions: unknown[]) => boolean } | null;
};

function isSupportedCopyChannel(channel: { type?: ChannelType | number } | null | undefined): channel is SupportedCopyChannel {
  return Boolean(channel && typeof channel.type === "number" && SUPPORTED_CHANNEL_TYPES.has(channel.type as ChannelType));
}

function clampMessageCount(input: number): number {
  if (!Number.isFinite(input)) return MIN_EXPORT_MESSAGES;
  return Math.min(MAX_EXPORT_MESSAGES, Math.max(MIN_EXPORT_MESSAGES, Math.trunc(input)));
}

async function hasReadAccess(interaction: ChatInputCommandInteraction, channel: SupportedCopyChannel): Promise<boolean> {
  const me = interaction.guild?.members.me ?? (await interaction.guild?.members.fetchMe().catch(() => null));
  if (!me) return true;

  const permissions = channel.permissionsFor?.(me);
  if (!permissions) return true;

  return permissions.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
}

export const CopyChannel: Command = {
  name: "copy-channel",
  description: "Export recent channel messages as copy-friendly text",
  options: [
    {
      name: "messages",
      description: "Number of recent messages to export",
      type: ApplicationCommandOptionType.Integer,
      required: true,
      minValue: MIN_EXPORT_MESSAGES,
      maxValue: MAX_EXPORT_MESSAGES,
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction) => {
    if (!interaction.inGuild() || !interaction.guildId) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only be used in a server text or announcement channel.",
      });
      return;
    }

    const channel = interaction.channel;
    if (!isSupportedCopyChannel(channel)) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only be used in a server text or announcement channel.",
      });
      return;
    }

    const messageCount = clampMessageCount(interaction.options.getInteger("messages", true));
    const canRead = await hasReadAccess(interaction, channel);
    if (!canRead) {
      await safeReply(interaction, {
        ephemeral: true,
        content: MISSING_ACCESS_MESSAGE,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    let fetchedMessages;
    try {
      fetchedMessages = await channel.messages.fetch({ limit: messageCount });
    } catch {
      await safeReply(interaction, {
        ephemeral: true,
        content: MISSING_ACCESS_MESSAGE,
      });
      return;
    }

    if (fetchedMessages.size === 0) {
      await interaction.editReply({
        content: "No messages found in this channel.",
      });
      return;
    }

    const exportResult = buildMessageExportResult([...fetchedMessages.values()]);
    if (exportResult.attachment) {
      await interaction.editReply({
        content: exportResult.content,
        files: [
          {
            attachment: exportResult.attachment.buffer,
            name: exportResult.attachment.name,
          },
        ],
      });
      return;
    }

    await interaction.editReply({
      content: exportResult.content,
    });
  },
};
