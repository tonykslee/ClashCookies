import { BanRecord, BanTargetKind } from "@prisma/client";
import { normalizeClanTag, normalizeDiscordUserId, normalizePlayerTag } from "./PlayerLinkService";

export type BanDisplayRecord = BanRecord & {
  linkedPlayerTags: string[];
  targetPlayerName: string | null;
};

type BanDisplayInput = Pick<
  BanDisplayRecord,
  | "clanName"
  | "clanTag"
  | "createdAt"
  | "discordUserId"
  | "expiresAt"
  | "linkedPlayerTags"
  | "playerTag"
  | "reason"
  | "targetDiscordDisplayName"
  | "targetDiscordUsername"
  | "targetKind"
  | "targetPlayerName"
  | "bannedByDiscordUserId"
  | "removedAt"
  | "removedByDiscordUserId"
  | "removeReason"
> & {
  targetPlayerName?: string | null;
};

function normalizeDisplayText(input: string | null | undefined): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function formatBacktickedTag(input: string | null | undefined): string {
  const normalized = normalizePlayerTag(String(input ?? ""));
  return normalized ? `\`${normalized}\`` : "unknown";
}

function formatTargetLabel(input: BanDisplayInput): string {
  if (input.targetKind === BanTargetKind.PLAYER) {
    const playerName = normalizeDisplayText(input.targetPlayerName);
    const playerTag = formatBacktickedTag(input.playerTag);
    return playerName ? `PLAYER | ${playerName} ${playerTag}` : `PLAYER | ${playerTag}`;
  }

  const discordUserId = normalizeDiscordUserId(input.discordUserId);
  const target = discordUserId ? `<@${discordUserId}>` : "unknown";
  const parts = ["USER", target];
  const username = normalizeDisplayText(input.targetDiscordUsername);
  const displayName = normalizeDisplayText(input.targetDiscordDisplayName);
  if (username) parts.push(`username: ${username}`);
  if (displayName) parts.push(`display: ${displayName}`);
  return parts.join(" | ");
}

function formatBanClanLabel(input: Pick<BanDisplayInput, "clanName" | "clanTag">): string | null {
  const clanTag = normalizeClanTag(String(input.clanTag ?? ""));
  if (!clanTag) return null;
  const clanName = normalizeDisplayText(input.clanName);
  return clanName ? `${clanName} \`${clanTag}\`` : `\`${clanTag}\``;
}

function formatLinkedPlayerTags(input: Pick<BanDisplayInput, "linkedPlayerTags">): string {
  if (input.linkedPlayerTags.length === 0) return "none";
  return input.linkedPlayerTags.map((tag) => formatBacktickedTag(tag)).join(", ");
}

function formatUnixTimestamp(value: Date | null | undefined): string {
  if (!value) return "Indefinite";
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

/** Purpose: format the shared target label used by ban list and ban-log output. */
export function formatBanTargetLabel(input: BanDisplayInput): string {
  return formatTargetLabel(input);
}

/** Purpose: format one ban list row using the shared target-label formatter. */
export function formatBanListRow(input: BanDisplayRecord): string {
  const parts = [formatTargetLabel(input)];

  const clanLabel = formatBanClanLabel(input);
  if (clanLabel) {
    parts.push(`clan: ${clanLabel}`);
  }

  if (input.targetKind === BanTargetKind.USER) {
    parts.push(`linked: ${formatLinkedPlayerTags(input)}`);
  }

  parts.push(`banned ${formatUnixTimestamp(input.createdAt)}`);
  parts.push(`expires ${formatUnixTimestamp(input.expiresAt)}`);
  parts.push(`by <@${input.bannedByDiscordUserId}>`);

  if (input.reason) {
    parts.push(`reason: ${String(input.reason).replace(/\s+/g, " ").trim()}`);
  }

  return parts.join(" | ").slice(0, 420);
}

/** Purpose: format the ban-action log body using the same target-label formatter as list output. */
export function formatBanActionLogContent(input: {
  action: "created" | "updated" | "removed";
  record: BanDisplayRecord;
  actorDiscordUserId: string;
}): string {
  const lines = [`Ban ${input.action}: ${formatTargetLabel(input.record)}`];
  lines.push(
    input.action === "removed"
      ? `Removed by: <@${input.actorDiscordUserId}>`
      : `Banned by: <@${input.actorDiscordUserId}>`,
  );
  lines.push(
    input.action === "removed"
      ? `Removed: ${formatUnixTimestamp(input.record.removedAt)}`
      : `Expires: ${formatUnixTimestamp(input.record.expiresAt)}`,
  );
  lines.push(`Reason: ${normalizeDisplayText(input.record.reason) ?? "No reason provided"}`);

  if (input.record.clanTag) {
    const clanLabel = formatBanClanLabel(input.record);
    lines.push(clanLabel ? `Ban clan: ${clanLabel}` : `Ban clan: ${formatBacktickedTag(input.record.clanTag)}`);
  }

  return lines.join("\n");
}
