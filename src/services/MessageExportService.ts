import { type Message } from "discord.js";

const DISCORD_MESSAGE_LIMIT = 2000;

export type MessageExportAttachment = {
  name: string;
  buffer: Buffer;
};

export type MessageExportResult = {
  content: string;
  attachment?: MessageExportAttachment;
};

function normalizeText(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function formatTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function resolveDisplayName(message: Message): string {
  const author = message.author as {
    displayName?: string | null;
    globalName?: string | null;
    username: string;
  };
  return (
    normalizeText(message.member?.displayName ?? null) ??
    normalizeText(author.displayName ?? null) ??
    normalizeText(author.globalName ?? null) ??
    normalizeText(author.username ?? null) ??
    author.username
  );
}

function buildMessageBody(message: Message): string {
  const content = normalizeText(message.content);
  const annotationParts: string[] = [];
  const attachmentCount = message.attachments?.size ?? 0;
  const embedCount = message.embeds?.length ?? 0;
  const stickerCount = message.stickers?.size ?? 0;

  if (attachmentCount > 0) {
    annotationParts.push(`attachments: ${attachmentCount}`);
  }
  if (embedCount > 0) {
    annotationParts.push(`embeds: ${embedCount}`);
  }
  if (stickerCount > 0) {
    annotationParts.push(`stickers: ${stickerCount}`);
  }

  if (!content && annotationParts.length === 0) {
    return "[empty]";
  }
  if (!content) {
    return `[${annotationParts.join("; ")}]`;
  }
  if (annotationParts.length === 0) {
    return content;
  }
  return `${content} [${annotationParts.join("; ")}]`;
}

function formatMessageLine(message: Message): string {
  return `[${formatTimestamp(message.createdTimestamp)}] ${resolveDisplayName(message)}: ${buildMessageBody(message)}`;
}

function escapeCodeFenceTerminators(input: string): string {
  return input.replaceAll("```", "`\u200b``");
}

function formatInlineBlock(input: string): string {
  return `\`\`\`text\n${escapeCodeFenceTerminators(input)}\n\`\`\``;
}

function buildExportFileName(messageCount: number): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  return `copy-channel-${messageCount}-${timestamp}.txt`;
}

export function buildMessageExportResult(messages: readonly Message[]): MessageExportResult {
  const sortedMessages = [...messages].sort(
    (left, right) => left.createdTimestamp - right.createdTimestamp || left.id.localeCompare(right.id),
  );
  const raw = sortedMessages.map((message) => formatMessageLine(message)).join("\n");
  const inline = formatInlineBlock(raw);

  if (inline.length <= DISCORD_MESSAGE_LIMIT) {
    return { content: inline };
  }

  return {
    content: `Exported ${sortedMessages.length} messages to a .txt attachment.`,
    attachment: {
      name: buildExportFileName(sortedMessages.length),
      buffer: Buffer.from(raw, "utf8"),
    },
  };
}
