import { type Guild, type MessageMentionOptions } from "discord.js";
import { findSyncBadgeEmojiForClan, getSyncBadgeEmojis } from "../helper/syncBadgeEmoji";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { SettingsService } from "./SettingsService";
import type {
  ScheduledSyncPostClaimOwnershipResult,
  ScheduledSyncPostRow,
} from "./ScheduledSyncPostService";
import {
  buildSyncTimeMessageContent,
  buildSyncTimeFwaClanListMessagePayload,
} from "./SyncTimeFwaClanListViewService";
import {
  trackedMessageService,
  type SyncTimeTrackedMetadata,
} from "./TrackedMessageService";

const CUSTOM_EMOJI_PATTERN = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/;
const SHORTCODE_EMOJI_PATTERN = /^:([A-Za-z0-9_]+):$/;
const SYNC_UNAVAILABLE_EMOJI = "\u{1F4A4}";
const SEND_MESSAGES_PERMISSION = BigInt(1 << 11);
const MENTION_EVERYONE_PERMISSION = BigInt(1 << 17);

type SyncBadge = {
  clanTag: string;
  code: string;
  label: string;
  reactionIdentifier: string;
  emojiInline: string;
  id: string | null;
  name: string | null;
  matchEmojiIds: string[];
  matchEmojiNames: string[];
};

export type SyncTimePostChannelLike = {
  id: string;
  guildId?: string | null;
  type?: number;
  isTextBased?: () => boolean;
  permissionsFor: (member: { id: string }) => { has: (flag: bigint) => boolean } | null;
  messages: {
    fetch: (messageId: string) => Promise<SyncTimePostMessageLike | null>;
    fetchPinned: () => Promise<Map<string, SyncTimePostMessageLike>>;
  };
  send: (payload: {
    content: string;
    embeds?: unknown[];
    components?: unknown[];
    allowedMentions?: MessageMentionOptions;
  }) => Promise<SyncTimePostMessageLike>;
};

export type SyncTimePostMessageLike = {
  id: string;
  channelId: string;
  author: { bot: boolean };
  content: string;
  react: (emoji: string) => Promise<void>;
  pin: () => Promise<void>;
  unpin: () => Promise<void>;
};

export type SyncTimePostPublishResult = {
  messageId: string;
  channelId: string;
  trackedClanCount: number;
  sentNewMessage: boolean;
  usedFallbackRender: boolean;
};

export class SyncTimePostPublishError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SyncTimePostPublishError";
  }
}

function throwPublishError(message: string, code: string, retryable: boolean): never {
  throw new SyncTimePostPublishError(message, code, retryable);
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && v.trim())).map((v) => v.trim()))];
}

function normalizeString(input: string | null | undefined): string {
  return String(input ?? "").trim();
}

export function activeSyncPostKey(guildId: string): string {
  return `active_sync_post:${normalizeString(guildId)}`;
}

function parseCustomEmoji(raw: string): {
  animated: boolean;
  name: string;
  id: string;
} | null {
  const match = raw.trim().match(CUSTOM_EMOJI_PATTERN);
  if (!match) return null;
  return {
    animated: match[1] === "a",
    name: match[2],
    id: match[3],
  };
}

function resolveAbbreviation(
  shortName: string | null,
  clanName: string | null,
  clanTag: string,
): string {
  const normalized = shortName?.trim().toUpperCase() ?? "";
  if (normalized.length > 0) return normalized;
  const source = (clanName?.trim() || clanTag.replace(/^#/, "")).toUpperCase();
  const lettersAndNumbers = source.replace(/[^A-Z0-9]/g, "");
  const base = lettersAndNumbers.length > 0 ? lettersAndNumbers : source.replace(/\s+/g, "");
  if (base.length >= 3) return base.slice(0, 3);
  const tagBase = clanTag.replace(/^#/, "").toUpperCase();
  return (base + tagBase).slice(0, 3);
}

function makeSyncBadgeFromHardcoded(
  entry: { code: string; label: string; name: string; id: string },
  overrides?: { code?: string; label?: string },
): SyncBadge {
  return {
    clanTag: overrides?.label?.startsWith("#") ? (overrides?.label as string) : `#${(overrides?.code ?? entry.code)}`,
    code: overrides?.code ?? entry.code,
    label: overrides?.label ?? entry.label,
    reactionIdentifier: `${entry.name}:${entry.id}`,
    emojiInline: `<:${entry.name}:${entry.id}>`,
    id: entry.id,
    name: entry.name,
    matchEmojiIds: dedupe([entry.id]),
    matchEmojiNames: dedupe([entry.name]),
  };
}

function makeSyncBadgeFromTrackedClan(
  clanTag: string,
  clanName: string | null,
  configuredBadge: string,
  shortName: string | null,
): SyncBadge {
  const code = resolveAbbreviation(shortName, clanName, clanTag);
  const label = clanName?.trim() || clanTag;
  const trimmed = configuredBadge.trim();
  const custom = parseCustomEmoji(trimmed);

  if (custom) {
    return {
      clanTag,
      code,
      label,
      reactionIdentifier: `${custom.name}:${custom.id}`,
      emojiInline: `<${custom.animated ? "a" : ""}:${custom.name}:${custom.id}>`,
      id: custom.id,
      name: custom.name,
      matchEmojiIds: dedupe([custom.id]),
      matchEmojiNames: dedupe([custom.name]),
    };
  }

  return {
    clanTag,
    code,
    label,
    reactionIdentifier: trimmed,
    emojiInline: trimmed,
    id: null,
    name: trimmed,
    matchEmojiIds: [],
    matchEmojiNames: dedupe([trimmed]),
  };
}

function addAlternateEmojiMatch(
  badge: SyncBadge,
  alternate: { id: string; name: string } | null,
): SyncBadge {
  if (!alternate) return badge;
  return {
    ...badge,
    matchEmojiIds: dedupe([...badge.matchEmojiIds, alternate.id]),
    matchEmojiNames: dedupe([...badge.matchEmojiNames, alternate.name]),
  };
}

async function getSyncBadgesWithTrackedClanFallback(
  botUserId: string | undefined,
  guild: Guild,
): Promise<SyncBadge[]> {
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true, clanBadge: true, shortName: true },
  });

  const hardcoded = getSyncBadgeEmojis(botUserId);
  if (tracked.length === 0) {
    return hardcoded.map((entry) => makeSyncBadgeFromHardcoded(entry));
  }

  const badges: SyncBadge[] = [];
  for (const clan of tracked) {
    const configuredBadge = clan.clanBadge?.trim() ?? "";
    if (configuredBadge.length > 0) {
      const fallbackCode = resolveAbbreviation(clan.shortName, clan.name, clan.tag);
      const fallback = clan.name
        ? findSyncBadgeEmojiForClan(botUserId, clan.name, fallbackCode)
        : null;

      const shortcodeMatch = configuredBadge.match(SHORTCODE_EMOJI_PATTERN);
      if (shortcodeMatch) {
        try {
          let emoji = guild.emojis.cache.find((e) => e.name === shortcodeMatch[1]);
          if (!emoji) {
            await guild.emojis.fetch().catch(() => null);
            emoji = guild.emojis.cache.find((e) => e.name === shortcodeMatch[1]);
          }
          if (emoji) {
            const emojiToken = `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
            badges.push(
              addAlternateEmojiMatch(
                makeSyncBadgeFromTrackedClan(clan.tag, clan.name, emojiToken, clan.shortName),
                fallback,
              ),
            );
            continue;
          }
        } catch (err) {
          console.warn(
            `[sync-time-publish] emoji_resolve_failed guild_id=${guild.id} clan_tag=${clan.tag} error=${formatError(err)}`,
          );
        }
      }

      badges.push(
        addAlternateEmojiMatch(
          makeSyncBadgeFromTrackedClan(clan.tag, clan.name, configuredBadge, clan.shortName),
          fallback,
        ),
      );
      continue;
    }

    const fallbackCode = resolveAbbreviation(clan.shortName, clan.name, clan.tag);
    const fallback = clan.name ? findSyncBadgeEmojiForClan(botUserId, clan.name, fallbackCode) : null;
    if (fallback) {
      badges.push(
        makeSyncBadgeFromHardcoded(fallback, {
          code: fallbackCode,
          label: clan.name?.trim() || clan.tag,
        }),
      );
    }
  }

  if (badges.length === 0) {
    return hardcoded.map((entry) => makeSyncBadgeFromHardcoded(entry));
  }

  return badges;
}

function isBotSyncTimeMessage(content: string): boolean {
  return content.startsWith("# Sync time :gem:");
}

/** Purpose: publish scheduled sync-time posts using the durable schedule row and shared readiness renderer. */
export class SyncTimePostPublisherService {
  async publishScheduledSyncTimePost(input: {
    guild: Guild;
    channel: SyncTimePostChannelLike;
    role: { id: string; name: string; mentionable: boolean };
    schedule: {
      id: string;
      channelId: string;
      guildId: string;
      roleId: string;
      syncTime: Date;
      publishAt: Date;
      publishedMessageId: string | null;
      claimToken: string | null;
    };
    claimToken: string;
    settings?: SettingsService;
    clientUserId?: string | null;
    now?: Date;
    scheduleService: {
      verifyClaimOwnership: (input: {
        scheduleId: string;
        claimToken: string;
      }) => Promise<ScheduledSyncPostClaimOwnershipResult>;
      markPublishedMessageId: (input: {
        scheduleId: string;
        claimToken: string;
        messageId: string;
      }) => Promise<unknown>;
      markPublished: (input: {
        scheduleId: string;
        claimToken: string;
        now: Date;
      }) => Promise<unknown>;
    };
  }): Promise<SyncTimePostPublishResult> {
    const now = input.now ?? new Date();
    const settings = input.settings ?? new SettingsService();
    const guild = input.guild;
    const channel = input.channel;
    const role = input.role;

    if (!guild || !channel) {
      throwPublishError("Missing guild or channel for scheduled sync publication.", "missing_target", false);
    }

    async function ensureClaimOwnership(stage: "pre_send" | "pre_finalize"): Promise<ScheduledSyncPostRow> {
      const ownership = await input.scheduleService.verifyClaimOwnership({
        scheduleId: input.schedule.id,
        claimToken: input.claimToken,
      });
      if (ownership.owned && ownership.schedule) {
        return ownership.schedule;
      }

      const code = ownership.reason === "claim_lost" ? "claim_lost" : "schedule_replaced";
      console.warn(
        `[sync-time-publish] ${code} guild_id=${input.schedule.guildId} schedule_id=${input.schedule.id} stage=${stage} claim_token=${input.claimToken} status=${ownership.schedule?.status ?? "missing"} message_id=${ownership.schedule?.publishedMessageId ?? "null"}`,
      );
      throwPublishError(
        `Scheduled sync claim no longer valid (${code}) at ${stage}.`,
        code,
        false,
      );
    }

    let claimedSchedule = await ensureClaimOwnership("pre_send");

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!me) {
      throwPublishError("Could not verify bot permissions in the destination channel.", "missing_bot_member", false);
    }

    const permissions = channel.permissionsFor(me);
    if (!permissions?.has(SEND_MESSAGES_PERMISSION)) {
      throwPublishError(
        "Could not post sync time: bot is missing Send Messages in this channel.",
        "missing_send_messages",
        false,
      );
    }

    const canMentionEveryone = permissions.has(MENTION_EVERYONE_PERMISSION);
    const mentionWillNotify = role.mentionable || canMentionEveryone;
    const allowedMentions: MessageMentionOptions = mentionWillNotify
      ? { roles: [role.id] }
      : { parse: [] };

    const badges = await getSyncBadgesWithTrackedClanFallback(
      input.clientUserId ?? guild.client.user?.id,
      guild,
    );
    if (badges.length === 0) {
      throwPublishError("No badge emoji configuration found for this bot ID.", "missing_badges", false);
    }

    const syncEpochSeconds = Math.floor(claimedSchedule.syncTime.getTime() / 1000);
    const baseMetadata: SyncTimeTrackedMetadata = {
      syncTimeIso: claimedSchedule.syncTime.toISOString(),
      syncEpochSeconds,
      roleId: role.id,
      clans: badges.map((badge) => ({
        code: badge.code,
        clanTag: badge.clanTag,
        clanName: badge.label,
        emojiId: badge.id,
        emojiName: badge.name,
        emojiInline: badge.emojiInline,
      })),
    };

    let payload;
    let usedFallbackRender = false;
    try {
      payload = await buildSyncTimeFwaClanListMessagePayload({
        guildId: claimedSchedule.guildId,
        baseMetadata,
        now,
      });
    } catch (err) {
      console.error(
        `[sync-time-fwa-list] render_failed guild_id=${claimedSchedule.guildId} schedule_id=${input.schedule.id} error=${formatError(err)}`,
      );
      usedFallbackRender = true;
      payload = {
        content: buildSyncTimeMessageContent(syncEpochSeconds, role.id),
        embeds: [],
        components: [],
        metadata: baseMetadata,
        trackedClanCount: 0,
      };
    }

    const message = claimedSchedule.publishedMessageId
      ? await channel.messages.fetch(claimedSchedule.publishedMessageId).catch(() => null)
      : await channel.send({
          content: payload.content,
          embeds: payload.embeds,
          components: payload.components,
          allowedMentions,
        }).catch(async (err) => {
          console.error(
            `[sync-time-publish] send_failed guild_id=${claimedSchedule.guildId} schedule_id=${input.schedule.id} channel_id=${channel.id} role_id=${role.id} error=${formatError(err)}`,
          );
          throw err;
        });

    if (!message) {
      throwPublishError("Published sync message could not be resolved.", "missing_message", true);
    }

    claimedSchedule = await ensureClaimOwnership("pre_finalize");
    const sentNewMessage = !claimedSchedule.publishedMessageId;

    if (!claimedSchedule.publishedMessageId) {
      const marked = await input.scheduleService.markPublishedMessageId({
        scheduleId: input.schedule.id,
        claimToken: input.claimToken,
        messageId: message.id,
      });
      if (!marked) {
        throwPublishError(
          "Could not persist the published sync message id.",
          "persist_message_id_failed",
          true,
        );
      }
    }

    await settings
      .set(
        activeSyncPostKey(guild.id),
        JSON.stringify({
          channelId: message.channelId,
          messageId: message.id,
          epochSeconds: syncEpochSeconds,
        }),
      )
      .catch((err) => {
        throwPublishError(
          `Could not persist the active sync post setting: ${formatError(err)}`,
          "active_sync_setting_failed",
          true,
        );
      });

    for (const badge of badges) {
      try {
        await message.react(badge.reactionIdentifier);
      } catch (err) {
        console.error(
          `[sync-time-publish] react_failed guild_id=${claimedSchedule.guildId} schedule_id=${input.schedule.id} message_id=${message.id} emoji=${badge.reactionIdentifier} error=${formatError(err)}`,
        );
      }
    }
    try {
      await message.react(SYNC_UNAVAILABLE_EMOJI);
    } catch (err) {
      console.error(
        `[sync-time-publish] react_failed guild_id=${claimedSchedule.guildId} schedule_id=${input.schedule.id} message_id=${message.id} emoji=${SYNC_UNAVAILABLE_EMOJI} error=${formatError(err)}`,
      );
    }

    await trackedMessageService
      .createSyncTimeTrackedMessage({
        guildId: guild.id,
        channelId: message.channelId,
        messageId: message.id,
        remindAt: new Date(syncEpochSeconds * 1000 - 5 * 60 * 1000),
        expiresAt: new Date(syncEpochSeconds * 1000 + 60 * 60 * 1000),
        metadata: payload.metadata as SyncTimeTrackedMetadata,
      })
      .catch((err) => {
        throwPublishError(
          `Could not create the tracked sync-time row: ${formatError(err)}`,
          "tracked_message_failed",
          true,
        );
      });

    try {
      const pinned = await channel.messages.fetchPinned();
      for (const pinnedMessage of pinned.values()) {
        if (pinnedMessage.id === message.id) continue;
        if (!pinnedMessage.author.bot) continue;
        if (!isBotSyncTimeMessage(pinnedMessage.content)) continue;
        await pinnedMessage.unpin().catch(() => undefined);
      }
    } catch (err) {
      console.error(
        `[sync-time-publish] pin_cleanup_failed guild_id=${claimedSchedule.guildId} schedule_id=${input.schedule.id} message_id=${message.id} error=${formatError(err)}`,
      );
    }

    try {
      await message.pin();
    } catch (err) {
      console.error(
        `[sync-time-publish] pin_failed guild_id=${claimedSchedule.guildId} schedule_id=${input.schedule.id} message_id=${message.id} error=${formatError(err)}`,
      );
    }

    const published = await input.scheduleService.markPublished({
      scheduleId: input.schedule.id,
      claimToken: input.claimToken,
      now,
    });
    if (!published) {
      throwPublishError(
        "Could not finalize the scheduled sync post.",
        "finalize_failed",
        true,
      );
    }

    return {
      messageId: message.id,
      channelId: message.channelId,
      trackedClanCount: payload.trackedClanCount,
      sentNewMessage,
      usedFallbackRender,
    };
  }
}

export const syncTimePostPublisherService = new SyncTimePostPublisherService();
export { getSyncBadgesWithTrackedClanFallback };
