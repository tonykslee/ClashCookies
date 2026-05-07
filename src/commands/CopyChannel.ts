import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  type Message,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import { buildMessageExportResult } from "../services/MessageExportService";

const MIN_EXPORT_MESSAGES = 1;
const MAX_EXPORT_MESSAGES = 200;
const DISCORD_MESSAGE_ID_PATTERN = /^\d{17,20}$/;
const SUPPORTED_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
]);
const MISSING_ACCESS_MESSAGE =
  "I need `View Channel` and `Read Message History` in this channel to export messages.";

type SupportedCopyChannel = {
  type: ChannelType;
  messages: {
    fetch: (input: {
      limit: number;
      before?: string;
      after?: string;
    }) => Promise<Map<string, Message>>;
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

function normalizeMessageId(input: string | null | undefined): string | null {
  const value = String(input ?? "").trim();
  if (!value || !DISCORD_MESSAGE_ID_PATTERN.test(value)) {
    return null;
  }
  return value;
}

async function fetchChannelMessagesForCopy(
  channel: SupportedCopyChannel,
  input: {
    count: number;
    beforeId?: string | null;
    afterId?: string | null;
  },
): Promise<Message[]> {
  const collected = new Map<string, Message>();
  const maxFetches = Math.max(1, Math.ceil(input.count / 100));
  let cursor: string | null = input.beforeId ?? input.afterId ?? null;
  let fetchCount = 0;

  while (collected.size < input.count && fetchCount < maxFetches) {
    const remaining = input.count - collected.size;
    const limit = Math.min(100, remaining);
    const fetchOptions: {
      limit: number;
      before?: string;
      after?: string;
    } = { limit };

    if (input.afterId) {
      fetchOptions.after = cursor ?? input.afterId;
    } else if (cursor) {
      fetchOptions.before = cursor;
    }

    const batch = await channel.messages.fetch(fetchOptions);
    fetchCount += 1;
    if (batch.size === 0) {
      break;
    }

    const batchMessages = [...batch.values()].sort(
      (left, right) =>
        left.createdTimestamp - right.createdTimestamp || left.id.localeCompare(right.id),
    );
    for (const message of batchMessages) {
      if (!collected.has(message.id)) {
        collected.set(message.id, message);
      }
    }

    const nextCursor = input.afterId
      ? batchMessages[batchMessages.length - 1]?.id ?? null
      : batchMessages[0]?.id ?? null;
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
    if (batch.size < limit) {
      break;
    }
  }

  return [...collected.values()].sort(
    (left, right) =>
      left.createdTimestamp - right.createdTimestamp || left.id.localeCompare(right.id),
  );
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
    {
      name: "after",
      description: "Export messages after this Discord message id",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "before",
      description: "Export messages before this Discord message id",
      type: ApplicationCommandOptionType.String,
      required: false,
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
    const afterAnchor = interaction.options.getString("after", false);
    const beforeAnchor = interaction.options.getString("before", false);
    if (afterAnchor && beforeAnchor) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Use either after or before, not both.",
      });
      return;
    }

    const normalizedAfterAnchor = normalizeMessageId(afterAnchor);
    const normalizedBeforeAnchor = normalizeMessageId(beforeAnchor);
    if (
      (afterAnchor !== null && normalizedAfterAnchor === null) ||
      (beforeAnchor !== null && normalizedBeforeAnchor === null)
    ) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Message id must be a valid Discord message id.",
      });
      return;
    }

    const canRead = await hasReadAccess(interaction, channel);
    if (!canRead) {
      await safeReply(interaction, {
        ephemeral: true,
        content: MISSING_ACCESS_MESSAGE,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    let fetchedMessages: Message[];
    try {
      fetchedMessages = await fetchChannelMessagesForCopy(channel, {
        count: messageCount,
        beforeId: normalizedBeforeAnchor,
        afterId: normalizedAfterAnchor,
      });
    } catch {
      await safeReply(interaction, {
        ephemeral: true,
        content: MISSING_ACCESS_MESSAGE,
      });
      return;
    }

    if (fetchedMessages.length === 0) {
      await interaction.editReply({
        content:
          normalizedAfterAnchor !== null
            ? "No messages found after that message id."
            : normalizedBeforeAnchor !== null
              ? "No messages found before that message id."
              : "No messages found in this channel.",
      });
      return;
    }

    const exportResult = buildMessageExportResult(fetchedMessages);
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
