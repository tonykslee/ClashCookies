/** Purpose: identify the reminder self-link button custom-id namespace. */
export const REMINDER_LINK_BUTTON_PREFIX = "reminder-link";

/** Purpose: build one reminder self-link claim button custom-id. */
export function buildReminderLinkButtonCustomId(input: {
  guildId: string;
  reminderId: string;
  playerTag: string;
}): string {
  return `${REMINDER_LINK_BUTTON_PREFIX}:claim:${String(input.guildId ?? "").trim()}:${String(
    input.reminderId ?? "",
  ).trim()}:${String(input.playerTag ?? "").trim()}`;
}

/** Purpose: parse one reminder self-link claim button custom-id. */
export function parseReminderLinkButtonCustomId(
  customId: string,
): { guildId: string; reminderId: string; playerTag: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 5 || parts[0] !== REMINDER_LINK_BUTTON_PREFIX || parts[1] !== "claim") {
    return null;
  }
  const guildId = parts[2]?.trim() ?? "";
  const reminderId = parts[3]?.trim() ?? "";
  const playerTag = parts[4]?.trim() ?? "";
  if (!guildId || !reminderId || !playerTag) return null;
  return { guildId, reminderId, playerTag };
}

/** Purpose: build one reminder self-link confirmation button custom-id. */
export function buildReminderLinkConfirmCustomId(input: {
  channelId: string;
  messageId: string;
  playerTag: string;
}): string {
  return `reminder-link:confirm:${String(input.channelId ?? "").trim()}:${String(input.messageId ?? "").trim()}:${String(
    input.playerTag ?? "",
  ).trim()}`;
}

/** Purpose: parse one reminder self-link confirmation button custom-id. */
export function parseReminderLinkConfirmCustomId(
  customId: string,
): { channelId: string; messageId: string; playerTag: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 5 || parts[0] !== "reminder-link" || parts[1] !== "confirm") {
    return null;
  }
  const channelId = parts[2]?.trim() ?? "";
  const messageId = parts[3]?.trim() ?? "";
  const playerTag = parts[4]?.trim() ?? "";
  if (!channelId || !messageId || !playerTag) return null;
  return { channelId, messageId, playerTag };
}

/** Purpose: build one reminder self-link cancel button custom-id. */
export function buildReminderLinkCancelCustomId(input: {
  channelId: string;
  messageId: string;
  playerTag: string;
}): string {
  return `reminder-link:cancel:${String(input.channelId ?? "").trim()}:${String(input.messageId ?? "").trim()}:${String(
    input.playerTag ?? "",
  ).trim()}`;
}

/** Purpose: parse one reminder self-link cancel button custom-id. */
export function parseReminderLinkCancelCustomId(
  customId: string,
): { channelId: string; messageId: string; playerTag: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 5 || parts[0] !== "reminder-link" || parts[1] !== "cancel") {
    return null;
  }
  const channelId = parts[2]?.trim() ?? "";
  const messageId = parts[3]?.trim() ?? "";
  const playerTag = parts[4]?.trim() ?? "";
  if (!channelId || !messageId || !playerTag) return null;
  return { channelId, messageId, playerTag };
}
