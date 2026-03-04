import { Prisma } from "@prisma/client";

export type MatchMailMessageRef = {
  messageType: "mail" | "notify";
  messageID: string;
  channelId?: string;
  messageUrl?: string;
  notifyType?: "war_start" | "battle_start" | "war_end";
};

export type MatchMailConfig = {
  lastPostedMessageId: string | null;
  lastPostedChannelId: string | null;
  lastPostedAtUnix: number | null;
  lastWarStartMs: number | null;
  lastMatchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null;
  lastExpectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  lastDataChangedAtUnix: number | null;
  messages: MatchMailMessageRef[];
  skipSyncHistory: {
    warId: number;
    warStartUnix: number;
    opponentTag: string;
  } | null;
};

export type ForceMailMessageType = {
  messageType: "mail" | "notify";
  notifyType?: "war_start" | "battle_start" | "war_end";
};

export type MailPostTarget = {
  channelId: string;
  messageId: string;
};

export const MATCH_MAIL_CONFIG_DEFAULT: MatchMailConfig = {
  lastPostedMessageId: null,
  lastPostedChannelId: null,
  lastPostedAtUnix: null,
  lastWarStartMs: null,
  lastMatchType: null,
  lastExpectedOutcome: null,
  lastDataChangedAtUnix: null,
  messages: [],
  skipSyncHistory: null,
};

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function isMatchTypeValue(value: unknown): value is "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" {
  return value === "FWA" || value === "BL" || value === "MM" || value === "SKIP" || value === "UNKNOWN";
}

function isExpectedOutcomeValue(value: unknown): value is "WIN" | "LOSE" | "UNKNOWN" {
  return value === "WIN" || value === "LOSE" || value === "UNKNOWN";
}

export function parseForceMailMessageType(value: string): ForceMailMessageType | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "mail") return { messageType: "mail" };
  if (normalized === "notify:war_start") return { messageType: "notify", notifyType: "war_start" };
  if (normalized === "notify:battle_start") return { messageType: "notify", notifyType: "battle_start" };
  if (normalized === "notify:war_end") return { messageType: "notify", notifyType: "war_end" };
  return null;
}

export function parseMatchMailConfig(value: Prisma.JsonValue | null | undefined): MatchMailConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...MATCH_MAIL_CONFIG_DEFAULT };
  }
  const obj = value as Record<string, unknown>;
  const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];
  const messages: MatchMailMessageRef[] = [];
  for (const entry of rawMessages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const messageType = item.messageType;
    const messageID = typeof item.messageID === "string" ? item.messageID.trim() : "";
    const channelId = typeof item.channelId === "string" ? item.channelId.trim() : "";
    const messageUrl = typeof item.messageUrl === "string" ? item.messageUrl.trim() : "";
    const notifyTypeRaw = typeof item.notifyType === "string" ? item.notifyType.trim() : "";
    const notifyType =
      notifyTypeRaw === "war_start" || notifyTypeRaw === "battle_start" || notifyTypeRaw === "war_end"
        ? notifyTypeRaw
        : undefined;
    if ((messageType !== "mail" && messageType !== "notify") || !messageID) continue;
    messages.push({
      messageType,
      messageID,
      channelId: channelId || undefined,
      messageUrl: messageUrl || undefined,
      notifyType: messageType === "notify" ? notifyType : undefined,
    });
  }

  const lastPostedMessageId =
    typeof obj.lastPostedMessageId === "string" && obj.lastPostedMessageId.trim()
      ? obj.lastPostedMessageId.trim()
      : null;
  const lastPostedChannelId =
    typeof obj.lastPostedChannelId === "string" && obj.lastPostedChannelId.trim()
      ? obj.lastPostedChannelId.trim()
      : null;
  const lastPostedAtUnix =
    typeof obj.lastPostedAtUnix === "number" && Number.isFinite(obj.lastPostedAtUnix)
      ? Math.trunc(obj.lastPostedAtUnix)
      : null;
  const lastWarStartMs =
    typeof obj.lastWarStartMs === "number" && Number.isFinite(obj.lastWarStartMs)
      ? Math.trunc(obj.lastWarStartMs)
      : null;
  const lastMatchType = isMatchTypeValue(obj.lastMatchType) ? obj.lastMatchType : null;
  const lastExpectedOutcome = isExpectedOutcomeValue(obj.lastExpectedOutcome)
    ? obj.lastExpectedOutcome
    : null;
  const lastDataChangedAtUnix =
    typeof obj.lastDataChangedAtUnix === "number" && Number.isFinite(obj.lastDataChangedAtUnix)
      ? Math.trunc(obj.lastDataChangedAtUnix)
      : null;
  const skipSyncRaw =
    obj.skipSyncHistory && typeof obj.skipSyncHistory === "object" && !Array.isArray(obj.skipSyncHistory)
      ? (obj.skipSyncHistory as Record<string, unknown>)
      : null;
  const skipSyncWarId =
    skipSyncRaw && typeof skipSyncRaw.warId === "number" && Number.isFinite(skipSyncRaw.warId)
      ? Math.trunc(skipSyncRaw.warId)
      : null;
  const skipSyncWarStartUnix =
    skipSyncRaw && typeof skipSyncRaw.warStartUnix === "number" && Number.isFinite(skipSyncRaw.warStartUnix)
      ? Math.trunc(skipSyncRaw.warStartUnix)
      : null;
  const skipSyncOpponentTag =
    skipSyncRaw && typeof skipSyncRaw.opponentTag === "string" ? normalizeTag(skipSyncRaw.opponentTag) : "";
  const skipSyncHistory =
    skipSyncWarId !== null && skipSyncWarStartUnix !== null
      ? {
          warId: skipSyncWarId,
          warStartUnix: skipSyncWarStartUnix,
          opponentTag: skipSyncOpponentTag || "SKIP",
        }
      : null;

  return {
    lastPostedMessageId,
    lastPostedChannelId,
    lastPostedAtUnix,
    lastWarStartMs,
    lastMatchType,
    lastExpectedOutcome,
    lastDataChangedAtUnix,
    messages,
    skipSyncHistory,
  };
}

export function asMailConfigInputJson(config: MatchMailConfig): Prisma.InputJsonValue {
  return config as unknown as Prisma.InputJsonValue;
}

export function buildDiscordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function parseDiscordMessageUrl(url: string | null | undefined): MailPostTarget | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/\/channels\/\d+\/(\d+)\/(\d+)(?:$|[/?#])/i);
  if (!match?.[1] || !match?.[2]) return null;
  return { channelId: match[1], messageId: match[2] };
}

export function getPrimaryMailMessageRef(
  config: MatchMailConfig | null | undefined
): { channelId: string; messageId: string } | null {
  if (!config) return null;
  for (let i = config.messages.length - 1; i >= 0; i -= 1) {
    const entry = config.messages[i];
    if (!entry || entry.messageType !== "mail") continue;
    const fromUrl = parseDiscordMessageUrl(entry.messageUrl);
    const channelId = (entry.channelId ?? "").trim() || fromUrl?.channelId || "";
    const messageId = (entry.messageID ?? "").trim() || fromUrl?.messageId || "";
    if (/^\d+$/.test(channelId) && /^\d+$/.test(messageId)) {
      return { channelId, messageId };
    }
  }
  const fallbackChannelId = config.lastPostedChannelId?.trim() ?? "";
  const fallbackMessageId = config.lastPostedMessageId?.trim() ?? "";
  if (/^\d+$/.test(fallbackChannelId) && /^\d+$/.test(fallbackMessageId)) {
    return { channelId: fallbackChannelId, messageId: fallbackMessageId };
  }
  return null;
}

export function collectMailPostTargetsFromConfig(config: MatchMailConfig): MailPostTarget[] {
  const out: MailPostTarget[] = [];
  const push = (candidate: MailPostTarget | null) => {
    if (!candidate?.channelId || !candidate?.messageId) return;
    if (!/^\d+$/.test(candidate.channelId) || !/^\d+$/.test(candidate.messageId)) return;
    out.push(candidate);
  };

  for (const entry of config.messages) {
    if (entry.messageType !== "mail") continue;
    const fromUrl = parseDiscordMessageUrl(entry.messageUrl);
    const channelId = (entry.channelId ?? "").trim() || fromUrl?.channelId || "";
    const messageId = (entry.messageID ?? "").trim() || fromUrl?.messageId || "";
    push(channelId && messageId ? { channelId, messageId } : null);
  }

  push(
    config.lastPostedChannelId && config.lastPostedMessageId
      ? { channelId: config.lastPostedChannelId, messageId: config.lastPostedMessageId }
      : null
  );

  const deduped = new Map<string, MailPostTarget>();
  for (const candidate of out) {
    deduped.set(`${candidate.channelId}:${candidate.messageId}`, candidate);
  }
  return [...deduped.values()];
}

export function withRecoveredMailReference(
  config: MatchMailConfig,
  target: MailPostTarget,
  guildId: string
): MatchMailConfig {
  const messages = config.messages.filter((entry) => entry.messageType !== "mail");
  messages.push({
    messageType: "mail",
    messageID: target.messageId,
    channelId: target.channelId,
    messageUrl: buildDiscordMessageUrl(guildId, target.channelId, target.messageId),
  });
  return {
    ...config,
    lastPostedChannelId: target.channelId,
    lastPostedMessageId: target.messageId,
    messages,
  };
}
