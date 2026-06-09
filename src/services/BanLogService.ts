import { BanRecord, BanTargetKind } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { botLogChannelService } from "./BotLogChannelService";

type DiscordClientLike = {
  guilds: {
    cache: Map<string, unknown> | { get: (id: string) => unknown };
    fetch: (id: string) => Promise<unknown>;
  };
};

function normalizeText(input: string | null | undefined, fallback: string): string {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function formatRelativeTimestamp(input: Date | null | undefined): string {
  if (!input) return "Indefinite";
  return `<t:${Math.floor(input.getTime() / 1000)}:R>`;
}

function normalizeChannelId(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function getGuildFromClient(client: DiscordClientLike, guildId: string): unknown | null {
  const cache = client.guilds.cache;
  if (cache instanceof Map) {
    return cache.get(guildId) ?? null;
  }
  if (cache && typeof cache.get === "function") {
    return cache.get(guildId) ?? null;
  }
  return null;
}

async function resolveGuildFromClient(
  client: DiscordClientLike,
  guildId: string,
): Promise<{
  channels?: {
    cache?: Map<string, unknown> | { get: (id: string) => unknown };
    fetch?: (id: string) => Promise<unknown>;
  };
} | null> {
  const cached = getGuildFromClient(client, guildId);
  if (cached) return cached as any;
  try {
    return (await client.guilds.fetch(guildId)) as any;
  } catch {
    return null;
  }
}

async function resolveSendableGuildChannel(input: {
  client: DiscordClientLike;
  guildId: string;
  channelId: string;
}): Promise<{ send: (payload: { content: string; allowedMentions: { parse: never[] } }) => Promise<unknown> } | null> {
  const guild = await resolveGuildFromClient(input.client, input.guildId);
  if (!guild?.channels) return null;

  const channelCache = guild.channels.cache;
  let channel: unknown | null = null;
  if (channelCache instanceof Map) {
    channel = channelCache.get(input.channelId) ?? null;
  } else if (channelCache && typeof channelCache.get === "function") {
    channel = channelCache.get(input.channelId) ?? null;
  }

  if (!channel && typeof guild.channels.fetch === "function") {
    channel = await guild.channels.fetch(input.channelId).catch(() => null);
  }
  if (!channel || typeof (channel as { send?: unknown }).send !== "function") {
    return null;
  }
  return channel as {
    send: (payload: { content: string; allowedMentions: { parse: never[] } }) => Promise<unknown>;
  };
}

function buildBanActionLogContent(input: {
  action: "created" | "updated" | "removed";
  record: BanRecord;
  actorDiscordUserId: string;
}): string {
  const targetLabel =
    input.record.targetKind === BanTargetKind.PLAYER
      ? input.record.playerTag ?? "unknown"
      : input.record.discordUserId
        ? `<@${input.record.discordUserId}>`
        : "unknown";
  const lines = [`Ban ${input.action}: ${input.record.targetKind} | ${targetLabel}`];
  lines.push(
    input.action === "removed"
      ? `Removed by: <@${input.actorDiscordUserId}>`
      : `Banned by: <@${input.actorDiscordUserId}>`,
  );
  lines.push(
    input.action === "removed"
      ? `Removed: ${formatRelativeTimestamp(input.record.removedAt)}`
      : `Expires: ${formatRelativeTimestamp(input.record.expiresAt)}`,
  );
  lines.push(`Reason: ${normalizeText(input.record.reason, "No reason provided")}`);
  if (input.record.clanTag) {
    lines.push(
      input.record.clanName
        ? `Ban clan: ${normalizeText(input.record.clanName, "Unknown")} (${input.record.clanTag})`
        : `Ban clan: ${input.record.clanTag}`,
    );
  }
  return lines.join("\n");
}

export class BanLogService {
  /** Purpose: post a guild ban action log through the configured ban-log routing. */
  async postBanActionLog(input: {
    client: DiscordClientLike;
    guildId: string;
    action: "created" | "updated" | "removed";
    record: BanRecord;
    actorDiscordUserId: string;
  }): Promise<void> {
    const routingConfig = await botLogChannelService.getRoutingConfigForType(
      input.guildId,
      "ban-log",
    );

    if (!routingConfig.configured || routingConfig.routingMode === "DISABLED") {
      return;
    }

    let channelId: string | null = null;
    if (routingConfig.routingMode === "BOT_LOG") {
      channelId = await botLogChannelService.getChannelId(input.guildId);
    } else if (routingConfig.routingMode === "CUSTOM") {
      channelId = normalizeChannelId(routingConfig.channelId);
    }

    if (!channelId) {
      return;
    }

    const channel = await resolveSendableGuildChannel({
      client: input.client,
      guildId: input.guildId,
      channelId,
    });
    if (!channel) {
      return;
    }

    try {
      await channel.send({
        content: buildBanActionLogContent({
          action: input.action,
          record: input.record,
          actorDiscordUserId: input.actorDiscordUserId,
        }),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error(`ban-log send failed: ${formatError(error)}`);
    }
  }
}

export const banLogService = new BanLogService();
