import { Prisma } from "@prisma/client";

export type MatchMailConfig = {
  lastPostedMessageId: string | null;
  lastPostedChannelId: string | null;
  lastPostedAtUnix: number | null;
  lastWarStartMs: number | null;
  lastMatchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null;
  lastExpectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  lastDataChangedAtUnix: number | null;
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
  skipSyncHistory: null,
};

type VersionedBlob = {
  version?: number;
  data?: unknown;
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
  const root = value as Record<string, unknown>;
  const maybeVersioned = root as VersionedBlob;
  const payload =
    typeof maybeVersioned.version === "number" &&
    maybeVersioned.data &&
    typeof maybeVersioned.data === "object" &&
    !Array.isArray(maybeVersioned.data)
      ? (maybeVersioned.data as Record<string, unknown>)
      : root;
  const obj = payload;
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
    skipSyncHistory,
  };
}

export function asMailConfigInputJson(config: MatchMailConfig): Prisma.InputJsonValue {
  return {
    version: 1,
    data: config,
  } as unknown as Prisma.InputJsonValue;
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
