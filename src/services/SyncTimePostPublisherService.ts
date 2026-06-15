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
  buildSyncReadinessMessageContent,
  buildSyncReadinessMessagePayload,
} from "./SyncTimeFwaClanListViewService";
import {
  trackedMessageService,
  type SyncReadinessTrackedMetadata,
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
  delete?: () => Promise<void>;
  pin: () => Promise<void>;
  unpin: () => Promise<void>;
};

export type SyncTimePostPublishStatus = "success" | "partial_failure";

export type SyncTimePostPublishResult = {
  status: SyncTimePostPublishStatus;
  messageId: string;
  channelId: string;
  messageLink: string;
  trackedClanCount: number;
  sentNewMessage: boolean;
  totalBadgeReactions: number;
  successfulBadgeReactions: number;
  badgeReactionCount: number;
  badgeReactionsSucceeded: number;
  unavailableReactionSucceeded: boolean;
  activeSettingsPointerSucceeded: boolean;
  pinSucceeded: boolean;
  trackedMessageCreated: boolean;
  rollbackSucceeded?: boolean;
  rollbackAttempted?: boolean;
  partialFailureReason?: "tracked_message_failed" | "tracked_message_failed_and_delete_failed" | null;
  partialFailureMessage?: string | null;
};

export type ScheduledSyncReadinessPublishResult = {
  messageId: string;
  channelId: string;
  trackedClanCount: number;
  sentNewMessage: boolean;
  usedFallbackRender: boolean;
  publicationMode: "scheduled" | "immediate";
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

function buildScheduledReadinessMetadata(input: {
  syncTime: Date;
  now: Date;
}): SyncReadinessTrackedMetadata {
  return {
    readinessEnabled: true,
    createdAtIso: input.now.toISOString(),
    refreshExpiresAtIso: input.syncTime.toISOString(),
  };
}

function buildDiscordMessageLink(input: {
  guildId: string;
  channelId: string;
  messageId: string;
}): string {
  return `https://discord.com/channels/${input.guildId}/${input.channelId}/${input.messageId}`;
}

function buildTrackedAnnouncementRecoveryResult(input: {
  guildId: string;
  message: SyncTimePostMessageLike;
  trackedClanCount: number;
  deleteSucceeded: boolean;
  deleteFailed: boolean;
}): SyncTimePostPublishResult {
  const messageLink = buildDiscordMessageLink({
    guildId: input.guildId,
    channelId: input.message.channelId,
    messageId: input.message.id,
  });
  const compensationSucceeded = input.deleteSucceeded;
  const partialFailureReason = input.deleteFailed
    ? "tracked_message_failed_and_delete_failed"
    : "tracked_message_failed";
  const partialFailureMessage = input.deleteFailed
    ? `Could not save the tracked sync announcement and cleanup failed. A visible untracked message may remain: ${messageLink}`
    : "Could not save the tracked sync announcement. The announcement was rolled back and can be retried safely.";

  return {
    status: "partial_failure",
    messageId: input.message.id,
    channelId: input.message.channelId,
    messageLink,
    trackedClanCount: input.trackedClanCount,
    sentNewMessage: true,
    totalBadgeReactions: 0,
    successfulBadgeReactions: 0,
    badgeReactionCount: 0,
    badgeReactionsSucceeded: 0,
    unavailableReactionSucceeded: false,
    activeSettingsPointerSucceeded: false,
    pinSucceeded: false,
    trackedMessageCreated: false,
    rollbackAttempted: true,
    rollbackSucceeded: compensationSucceeded,
    partialFailureReason,
    partialFailureMessage,
  };
}

/** Purpose: publish the immediate sync-time announcement and own the active sync tracked row. */
export class SyncTimePostPublisherService {
  async publishImmediateSyncTimePost(input: {
    guild: Guild;
    channel: SyncTimePostChannelLike;
    role: { id: string; name: string; mentionable: boolean };
    syncTime: Date;
    createdByUserId: string;
    settings?: SettingsService;
    clientUserId?: string | null;
    now?: Date;
  }): Promise<SyncTimePostPublishResult> {
    const now = input.now ?? new Date();
    const settings = input.settings ?? new SettingsService();
    const guild = input.guild;
    const channel = input.channel;
    const role = input.role;

    if (!guild || !channel) {
      throwPublishError("Missing guild or channel for sync announcement.", "missing_target", false);
    }

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

    const syncEpochSeconds = Math.floor(input.syncTime.getTime() / 1000);
    const baseMetadata: SyncTimeTrackedMetadata = {
      syncTimeIso: input.syncTime.toISOString(),
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

    const message = await channel.send({
      content: buildSyncTimeMessageContent(syncEpochSeconds, role.id),
      allowedMentions,
    }).catch((err) => {
      console.error(
        `[sync-time-announcement] send_failed guild_id=${guild.id} channel_id=${channel.id} role_id=${role.id} created_by_user_id=${input.createdByUserId} sync_epoch=${syncEpochSeconds} error=${formatError(err)}`,
      );
      throwPublishError(
        `Could not send the sync-time announcement: ${formatError(err)}`,
        "send_failed",
        true,
      );
    });

    const messageLink = buildDiscordMessageLink({
      guildId: guild.id,
      channelId: message.channelId,
      messageId: message.id,
    });

    let trackedMessageCreated = false;
    try {
      await trackedMessageService.replacePriorRootSyncTimeTrackedMessagesForGuildAndCreate({
        guildId: guild.id,
        channelId: message.channelId,
        messageId: message.id,
        remindAt: new Date(syncEpochSeconds * 1000 - 5 * 60 * 1000),
        expiresAt: new Date(syncEpochSeconds * 1000 + 60 * 60 * 1000),
        metadata: baseMetadata,
      });
      trackedMessageCreated = true;
    } catch (err) {
      console.error(
        `[sync-time-announcement] tracked_message_failed guild_id=${guild.id} channel_id=${message.channelId} message_id=${message.id} created_by_user_id=${input.createdByUserId} sync_epoch=${syncEpochSeconds} error=${formatError(err)}`,
      );

      let deleteSucceeded = false;
      let deleteFailed = false;
      let deleteError: string | null = null;
      if (typeof message.delete === "function") {
        try {
          await message.delete();
          deleteSucceeded = true;
        } catch (deleteErr) {
          deleteFailed = true;
          deleteError = formatError(deleteErr);
          console.error(
            `[sync-time-announcement] delete_failed guild_id=${guild.id} channel_id=${message.channelId} message_id=${message.id} created_by_user_id=${input.createdByUserId} sync_epoch=${syncEpochSeconds} error=${deleteError}`,
          );
        }
      } else {
        deleteFailed = true;
        deleteError = "message_delete_unavailable";
        console.error(
          `[sync-time-announcement] delete_failed guild_id=${guild.id} channel_id=${message.channelId} message_id=${message.id} created_by_user_id=${input.createdByUserId} sync_epoch=${syncEpochSeconds} error=${deleteError}`,
        );
      }

      return buildTrackedAnnouncementRecoveryResult({
        guildId: guild.id,
        message,
        trackedClanCount: badges.length,
        deleteSucceeded,
        deleteFailed,
      });
    }

    let activeSettingsPointerSucceeded = false;
    try {
      await settings.set(
        activeSyncPostKey(guild.id),
        JSON.stringify({
          channelId: message.channelId,
          messageId: message.id,
          epochSeconds: syncEpochSeconds,
        }),
      );
      activeSettingsPointerSucceeded = true;
    } catch (err) {
      console.warn(
        `[sync-time-announcement] active_sync_setting_failed guild_id=${guild.id} channel_id=${message.channelId} message_id=${message.id} created_by_user_id=${input.createdByUserId} sync_epoch=${syncEpochSeconds} error=${formatError(err)}`,
      );
    }

    let badgeReactionCount = 0;
    let badgeReactionsSucceeded = 0;
    for (const badge of badges) {
      badgeReactionCount += 1;
      try {
        await message.react(badge.reactionIdentifier);
        badgeReactionsSucceeded += 1;
      } catch (err) {
        console.error(
          `[sync-time-announcement] react_failed guild_id=${guild.id} channel_id=${message.channelId} message_id=${message.id} emoji=${badge.reactionIdentifier} created_by_user_id=${input.createdByUserId} sync_epoch=${syncEpochSeconds} error=${formatError(err)}`,
        );
      }
    }

    let unavailableSucceeded = false;
    try {
      await message.react(SYNC_UNAVAILABLE_EMOJI);
      unavailableSucceeded = true;
    } catch (err) {
      console.error(
        `[sync-time-announcement] react_failed guild_id=${guild.id} channel_id=${message.channelId} message_id=${message.id} emoji=${SYNC_UNAVAILABLE_EMOJI} created_by_user_id=${input.createdByUserId} sync_epoch=${syncEpochSeconds} error=${formatError(err)}`,
      );
    }

    let pinSucceeded = false;
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
        `[sync-time-announcement] pin_cleanup_failed guild_id=${guild.id} channel_id=${message.channelId} message_id=${message.id} created_by_user_id=${input.createdByUserId} sync_epoch=${syncEpochSeconds} error=${formatError(err)}`,
      );
    }

    try {
      await message.pin();
      pinSucceeded = true;
    } catch (err) {
      console.error(
        `[sync-time-announcement] pin_failed guild_id=${guild.id} channel_id=${message.channelId} message_id=${message.id} created_by_user_id=${input.createdByUserId} sync_epoch=${syncEpochSeconds} error=${formatError(err)}`,
      );
    }

    console.info(
      `[sync-time-announcement] published guild_id=${guild.id} channel_id=${message.channelId} message_id=${message.id} sync_epoch=${syncEpochSeconds} role_id=${role.id} created_by_user_id=${input.createdByUserId} badge_reaction_count=${badgeReactionCount} badge_reactions_succeeded=${badgeReactionsSucceeded} unavailable_reaction_succeeded=${unavailableSucceeded} active_settings_pointer_succeeded=${activeSettingsPointerSucceeded} pin_succeeded=${pinSucceeded}`,
    );

    return {
      status: "success",
      messageId: message.id,
      channelId: message.channelId,
      messageLink,
      trackedClanCount: badges.length,
      sentNewMessage: true,
      totalBadgeReactions: badgeReactionCount,
      successfulBadgeReactions: badgeReactionsSucceeded,
      badgeReactionCount,
      badgeReactionsSucceeded,
      unavailableReactionSucceeded: unavailableSucceeded,
      activeSettingsPointerSucceeded,
      pinSucceeded,
      trackedMessageCreated,
    };
  }
}

/** Purpose: publish the durable readiness dashboard that follows a sync announcement. */
export class ScheduledSyncReadinessPublisherService {
  async publishScheduledSyncReadinessPost(input: {
    guild: Guild;
    channel: SyncTimePostChannelLike;
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
    now?: Date;
    publicationMode: "scheduled" | "immediate";
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
  }): Promise<ScheduledSyncReadinessPublishResult> {
    const now = input.now ?? new Date();
    const guild = input.guild;
    const channel = input.channel;

    if (!guild || !channel) {
      throwPublishError("Missing guild or channel for readiness publication.", "missing_target", false);
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
        `[sync-readiness-publish] ${code} schedule_id=${input.schedule.id} guild_id=${input.schedule.guildId} channel_id=${input.schedule.channelId} sync_epoch=${Math.floor(input.schedule.syncTime.getTime() / 1000)} publish_epoch=${Math.floor(input.schedule.publishAt.getTime() / 1000)} stage=${stage} claim_token=${input.claimToken} status=${ownership.schedule?.status ?? "missing"} message_id=${ownership.schedule?.publishedMessageId ?? "null"}`,
      );
      throwPublishError(
        `Scheduled readiness claim no longer valid (${code}) at ${stage}.`,
        code,
        false,
      );
    }

    let claimedSchedule = await ensureClaimOwnership("pre_send");
    const syncEpochSeconds = Math.floor(claimedSchedule.syncTime.getTime() / 1000);
    const publishEpochSeconds = Math.floor(claimedSchedule.publishAt.getTime() / 1000);
    const payloadMetadata = buildScheduledReadinessMetadata({
      syncTime: claimedSchedule.syncTime,
      now,
    });

    let payload;
    let usedFallbackRender = false;
    try {
      payload = await buildSyncReadinessMessagePayload({
        guildId: claimedSchedule.guildId,
        baseMetadata: payloadMetadata,
        now,
        includeRefreshButton: true,
      });
    } catch (err) {
      console.error(
        `[sync-readiness-publish] render_failed schedule_id=${input.schedule.id} guild_id=${claimedSchedule.guildId} channel_id=${channel.id} sync_epoch=${syncEpochSeconds} publish_epoch=${publishEpochSeconds} publication_mode=${input.publicationMode} error=${formatError(err)}`,
      );
      usedFallbackRender = true;
      payload = {
        content: buildSyncReadinessMessageContent(),
        embeds: [],
        components: [],
        metadata: payloadMetadata,
        trackedClanCount: 0,
      };
    }

    const message = claimedSchedule.publishedMessageId
      ? await channel.messages.fetch(claimedSchedule.publishedMessageId).catch(() => null)
      : await channel.send({
          content: payload.content,
          embeds: payload.embeds,
          components: payload.components,
          allowedMentions: { parse: [] },
        }).catch((err) => {
          console.error(
            `[sync-readiness-publish] send_failed schedule_id=${input.schedule.id} guild_id=${claimedSchedule.guildId} channel_id=${channel.id} sync_epoch=${syncEpochSeconds} publish_epoch=${publishEpochSeconds} publication_mode=${input.publicationMode} error=${formatError(err)}`,
          );
          throwPublishError(
            `Could not send the readiness dashboard: ${formatError(err)}`,
            "send_failed",
            true,
          );
        });

    if (!message) {
      throwPublishError("Published readiness message could not be resolved.", "missing_message", true);
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
          "Could not persist the readiness message id.",
          "persist_message_id_failed",
          true,
        );
      }
    }

    await trackedMessageService.replacePriorSyncReadinessTrackedMessagesForGuildAndCreate({
      guildId: guild.id,
      channelId: message.channelId,
      messageId: message.id,
      referenceId: message.id,
      metadata: payload.metadata as SyncReadinessTrackedMetadata,
    }).catch((err) => {
      throwPublishError(
        `Could not create the tracked readiness row: ${formatError(err)}`,
        "tracked_message_failed",
        true,
      );
    });

    const published = await input.scheduleService.markPublished({
      scheduleId: input.schedule.id,
      claimToken: input.claimToken,
      now,
    });
    if (!published) {
      throwPublishError(
        "Could not finalize the scheduled readiness post.",
        "finalize_failed",
        true,
      );
    }

    console.info(
      `[sync-readiness-publish] published schedule_id=${input.schedule.id} guild_id=${claimedSchedule.guildId} channel_id=${message.channelId} message_id=${message.id} sync_epoch=${syncEpochSeconds} publish_epoch=${publishEpochSeconds} publication_mode=${input.publicationMode} tracked_clan_count=${payload.trackedClanCount} sent_new_message=${sentNewMessage} used_fallback_render=${usedFallbackRender}`,
    );

    return {
      messageId: message.id,
      channelId: message.channelId,
      trackedClanCount: payload.trackedClanCount,
      sentNewMessage,
      usedFallbackRender,
      publicationMode: input.publicationMode,
    };
  }
}

export const syncTimePostPublisherService = new SyncTimePostPublisherService();
export const scheduledSyncReadinessPublisherService = new ScheduledSyncReadinessPublisherService();
export { getSyncBadgesWithTrackedClanFallback };
