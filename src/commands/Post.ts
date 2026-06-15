import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ChannelType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  MessageMentionOptions,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import {
  CommandPermissionService,
  FWA_LEADER_ROLE_SETTING_KEY,
} from "../services/CommandPermissionService";
import { SettingsService } from "../services/SettingsService";
import {
  buildSyncReadinessMessagePayload,
  buildSyncReadinessMessageContent,
  refreshTrackedClanReadinessState,
} from "../services/SyncTimeFwaClanListViewService";
import {
  buildSyncSpinStatusEmbed,
  parseSyncTimeMetadata,
  trackedMessageService,
  type SyncReadinessTrackedMetadata,
} from "../services/TrackedMessageService";
import {
  activeSyncPostKey,
  getSyncBadgesWithTrackedClanFallback,
  scheduledSyncReadinessPublisherService,
  syncTimePostPublisherService,
} from "../services/SyncTimePostPublisherService";
import { scheduledSyncPostService } from "../services/ScheduledSyncPostService";
import { BotLogChannelService } from "../services/BotLogChannelService";
import {
  autocompleteSyncTimeZones,
  normalizeSyncTimeZone,
} from "../services/syncTimeZone";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;
const POST_SYNC_TIME_MODAL_PREFIX = "post-sync-time";
const DATE_INPUT_ID = "date";
const TIME_INPUT_ID = "time";
const TIMEZONE_INPUT_ID = "timezone";
const ROLE_INPUT_ID = "role";
const IANA_TIMEZONE_HELP_URL =
  "https://en.wikipedia.org/wiki/List_of_tz_database_time_zones";
const SYNC_UNAVAILABLE_EMOJI = "\u{1F4A4}";
const SYNC_TIME_POST_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
] as const;

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

function parseActiveSyncPost(
  raw: string | null
): { channelId: string; messageId: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { channelId?: unknown; messageId?: unknown };
    const channelId = String(parsed.channelId ?? "").trim();
    const messageId = String(parsed.messageId ?? "").trim();
    if (!/^\d{17,22}$/.test(channelId) || !/^\d{17,22}$/.test(messageId)) {
      return null;
    }
    return { channelId, messageId };
  } catch {
    return null;
  }
}

async function resolveStoredActiveSyncMessage(
  context: { guild: Guild | null },
  settings: SettingsService
) {
  const guild = context.guild;
  if (!guild) return null;
  const guildId = guild.id;

  const fetchTrackedMessage = async (channelId: string, messageId: string) => {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !("messages" in channel)) {
      return null;
    }
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message || !message.author.bot || !isBotSyncTimeMessage(message.content)) {
      return null;
    }
    return message;
  };

  const stored = parseActiveSyncPost(await settings.get(activeSyncPostKey(guildId)));
  if (stored) {
    const storedMessage = await fetchTrackedMessage(stored.channelId, stored.messageId);
    if (storedMessage) return storedMessage;
    await settings.delete(activeSyncPostKey(guildId));
  }

  const latestTracked = await trackedMessageService.resolveLatestActiveSyncPost(guildId);
  if (!latestTracked) return null;
  const trackedMessage = await fetchTrackedMessage(latestTracked.channelId, latestTracked.messageId);
  if (!trackedMessage) {
    await trackedMessageService.markMessageDeleted(latestTracked.messageId);
    return null;
  }
  return trackedMessage;
}

async function resolveSyncStatusMessage(
  interaction: ChatInputCommandInteraction,
  settings: SettingsService,
  explicitMessageId: string | null
) {
  if (explicitMessageId) {
    const guild = interaction.guild;
    if (!guild) return null;
    const channels = guild.channels.cache.filter(
      (c) => c.isTextBased() && "messages" in c
    );
    for (const [, guildChannel] of channels) {
      const found = await (guildChannel as any).messages
        ?.fetch(explicitMessageId)
        .catch(() => null);
      if (found) return found;
    }
    return null;
  }

  const storedActiveMessage = await resolveStoredActiveSyncMessage(interaction, settings);
  if (storedActiveMessage) return storedActiveMessage;
  return null;
}

async function handleSyncSpinStatusSubcommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const settings = new SettingsService();
  const explicitMessageIdRaw = interaction.options.getString("message-id", false)?.trim() ?? null;
  const explicitMessageId =
    explicitMessageIdRaw && /^\d{17,22}$/.test(explicitMessageIdRaw) ? explicitMessageIdRaw : null;
  if (explicitMessageIdRaw && !explicitMessageId) {
    await interaction.editReply("Invalid `message-id`. Use a Discord message ID.");
    return;
  }

  const message = await resolveSyncStatusMessage(interaction, settings, explicitMessageId);
  if (!message) {
    await interaction.editReply(
      explicitMessageId
        ? "Could not find that message ID in this channel."
        : "Could not find an active sync-time message. Post one with `/sync time post` first."
    );
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const tracked = await trackedMessageService.fetchSyncTrackedMessageWithClaims(message.id);
  const metadata = tracked ? parseSyncTimeMetadata(tracked.metadata) : null;
  if (!tracked || tracked.status !== "ACTIVE" || tracked.featureType !== "SYNC_TIME_POST" || !metadata) {
    await interaction.editReply("Could not find tracked sync status for that message.");
    return;
  }

  const embed = buildSyncSpinStatusEmbed({
    guildId: guild.id,
    sourceChannelId: tracked.channelId,
    sourceMessageId: tracked.referenceId ?? tracked.messageId,
    metadata,
    claimedClanTags: tracked.claims.map((claim) => claim.clanTag),
    title: "Sync Spin Status",
  });

  await interaction.editReply({ embeds: [embed] });
}

function buildStandaloneReadinessTrackedMetadata(now: Date): SyncReadinessTrackedMetadata {
  return {
    readinessEnabled: true,
    createdAtIso: now.toISOString(),
  };
}

async function handleSyncReadinessSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const visibility = interaction.options.getString("visibility", false) ?? "private";
  const isPublic = visibility === "public";
  const shouldRefresh = interaction.options.getBoolean("refresh", false) ?? false;

  await interaction.deferReply({ ephemeral: !isPublic });

  const now = new Date();
  let refreshSummary:
    | Awaited<ReturnType<typeof refreshTrackedClanReadinessState>>
    | null = null;
  if (shouldRefresh && interaction.guildId) {
    try {
      refreshSummary = await refreshTrackedClanReadinessState({
        guildId: interaction.guildId,
      });
    } catch (err) {
      console.error(
        `[sync-readiness] refresh_failed guild_id=${interaction.guildId} error=${formatError(err)}`,
      );
      await interaction.editReply(
        "Failed to refresh the readiness dashboard. Try again after the clan refresh completes.",
        );
      return;
    }
  }

  if (
    refreshSummary &&
    (refreshSummary.syncAllFailedClanTags.length > 0 ||
      refreshSummary.currentMemberFailedClanTags.length > 0)
  ) {
    console.info(
      `[sync-readiness] refresh_partial_upstream guild_id=${interaction.guildId ?? "unknown"} tracked_clan_count=${refreshSummary.trackedClanCount} sync_failed_clan_count=${refreshSummary.syncAllFailedClanTags.length} member_failed_clan_count=${refreshSummary.currentMemberFailedClanTags.length}`,
    );
  }

  const baseMetadata = buildStandaloneReadinessTrackedMetadata(now);
  let payload: Awaited<ReturnType<typeof buildSyncReadinessMessagePayload>>;
  try {
    payload = await buildSyncReadinessMessagePayload({
      guildId: interaction.guildId,
      baseMetadata,
      now,
      includeRefreshButton: isPublic,
    });
  } catch (err) {
    console.error(
      `[sync-readiness] render_failed guild_id=${interaction.guildId} error=${formatError(err)}`,
    );
    payload = {
      content: buildSyncReadinessMessageContent(),
      embeds: [],
      components: [],
      metadata: baseMetadata,
      trackedClanCount: 0,
    };
  }

  const failedClanCount =
    (refreshSummary?.syncAllFailedClanTags.length ?? 0) +
    (refreshSummary?.currentMemberFailedClanTags.length ?? 0);
  if (failedClanCount > 0) {
    payload = {
      ...payload,
      content: `${payload.content}\n\n⚠️ Refresh completed with ${failedClanCount} clan refresh failure${
        failedClanCount === 1 ? "" : "s"
      }.`,
    };
  }

  await interaction.editReply({
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
  });

  if (isPublic) {
    const message = await interaction.fetchReply();
    await trackedMessageService.replacePriorSyncReadinessTrackedMessagesForGuildAndCreate({
      guildId: interaction.guildId!,
      channelId: message.channelId,
      messageId: message.id,
      referenceId: message.id,
      metadata: payload.metadata as SyncReadinessTrackedMetadata,
    });
  }
}

async function handleSyncClaimStatusSubcommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const settings = new SettingsService();
  const explicitMessageIdRaw = interaction.options.getString("message-id", false)?.trim() ?? null;
  const explicitMessageId =
    explicitMessageIdRaw && /^\d{17,22}$/.test(explicitMessageIdRaw) ? explicitMessageIdRaw : null;
  if (explicitMessageIdRaw && !explicitMessageId) {
    await interaction.editReply("Invalid `message-id`. Use a Discord message ID.");
    return;
  }

  const message = await resolveSyncStatusMessage(interaction, settings, explicitMessageId);
  if (!message) {
    await interaction.editReply(
      explicitMessageId
        ? "Could not find that message ID in this channel."
        : "Could not find an active sync-time message. Post one with `/sync time post` first."
    );
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const badges = await getSyncBadgesWithTrackedClanFallback(
    interaction.client.user?.id,
    interaction.guild
  );
  if (badges.length === 0) {
    await interaction.editReply("No badge emoji configuration found for this bot ID.");
    return;
  }

  const leaderRoleIds = await getLeaderRoleIds(settings, guild.id);
  const memberCache = new Map<string, GuildMember | null>();
  const getMember = async (userId: string): Promise<GuildMember | null> => {
    if (memberCache.has(userId)) return memberCache.get(userId) ?? null;
    const member = await guild.members.fetch(userId).catch(() => null);
    memberCache.set(userId, member);
    return member;
  };

  const claimedLines: string[] = [];
  const unclaimedLines: string[] = [];
  const unavailableUsers: string[] = [];

  for (const badge of badges) {
    const reaction = [...message.reactions.cache.values()].find((r) => reactionMatchesBadge(r, badge));
    const claimedBy: string[] = [];
    const nonLeader: string[] = [];

    if (reaction) {
      const users = await reaction.users.fetch().catch(() => null);
      if (users) {
        for (const user of users.values()) {
          if (user.bot) continue;
          const member = await getMember(user.id);
          if (!member) continue;

          const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
          const hasLeaderRole =
            leaderRoleIds.length > 0 &&
            leaderRoleIds.some((roleId) => member.roles.cache.has(roleId));
          if (isAdmin || hasLeaderRole) {
            claimedBy.push(`<@${user.id}>`);
          } else {
            nonLeader.push(`<@${user.id}>`);
          }
        }
      }
    }

    const emojiInline = badge.emojiInline;
    if (claimedBy.length > 0) {
      const extra =
        nonLeader.length > 0 ? ` | non-leader: ${[...new Set(nonLeader)].join(", ")}` : "";
      claimedLines.push(
        `- ${emojiInline} **${badge.code}** (${badge.label}) - ${[...new Set(claimedBy)].join(", ")}${extra}`
      );
    } else {
      const extra =
        nonLeader.length > 0 ? ` (only non-leader: ${[...new Set(nonLeader)].join(", ")})` : "";
      unclaimedLines.push(`- ${emojiInline} **${badge.code}** (${badge.label})${extra}`);
    }
  }

  const unavailableReaction = [...message.reactions.cache.values()].find(
    (reaction) => !reaction.emoji.id && reaction.emoji.name === SYNC_UNAVAILABLE_EMOJI
  );
  if (unavailableReaction) {
    const users = await unavailableReaction.users.fetch().catch(() => null);
    if (users) {
      for (const user of users.values()) {
        if (user.bot) continue;
        unavailableUsers.push(`<@${user.id}>`);
      }
    }
  }

  const uniqueUnavailableUsers = [...new Set(unavailableUsers)];
  const embed = new EmbedBuilder()
    .setTitle("Sync Claim Status")
    .setDescription(
      [
        `Message: https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}`,
        (() => {
          const epoch = extractSyncEpochSeconds(message.content);
          return epoch
            ? `Sync time: <t:${epoch}:F> (<t:${epoch}:R>)`
            : "Sync time: not detected from message content";
        })(),
        "",
        `Claimed: **${claimedLines.length}/${badges.length}**`,
        `Unavailable (${SYNC_UNAVAILABLE_EMOJI}): **${uniqueUnavailableUsers.length}**`,
        ...(uniqueUnavailableUsers.length > 0
          ? [`${SYNC_UNAVAILABLE_EMOJI} ${uniqueUnavailableUsers.join(", ")}`]
          : []),
        "",
        "**Claimed Clans**",
        ...(claimedLines.length > 0 ? claimedLines : ["- None"]),
        "",
        "**Unclaimed Clans**",
        ...(unclaimedLines.length > 0 ? unclaimedLines : ["- None"]),
      ].join("\n")
    )
    .setFooter({
      text:
        leaderRoleIds.length > 0
          ? "Leader eligibility: Administrator or role allowed for /sync time post"
          : "Leader eligibility: Administrator only (no /sync time post role whitelist configured)",
    });

  await interaction.editReply({ embeds: [embed] });
}

function parseDate(input: string): { year: number; month: number; day: number } | null {
  if (!DATE_PATTERN.test(input)) return null;
  const [year, month, day] = input.split("-").map(Number);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function parseTime(input: string): { hour: number; minute: number } | null {
  if (!TIME_PATTERN.test(input)) return null;
  const [hour, minute] = input.split(":").map(Number);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { hour, minute };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map = new Map(parts.map((p) => [p.type, p.value]));

  const year = Number(map.get("year"));
  const month = Number(map.get("month"));
  const day = Number(map.get("day"));
  const hour = Number(map.get("hour"));
  const minute = Number(map.get("minute"));
  const second = Number(map.get("second"));

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - date.getTime();
}

function toEpochSeconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  let result = utcGuess - firstOffset;

  // Re-apply using the first pass result to stabilize around DST boundaries.
  const secondOffset = getTimeZoneOffsetMs(new Date(result), timeZone);
  result = utcGuess - secondOffset;

  return Math.floor(result / 1000);
}

function getDateTimeInTimeZone(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map = new Map(parts.map((p) => [p.type, p.value]));

  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    hour: Number(map.get("hour")),
    minute: Number(map.get("minute")),
  };
}

function userTimeZoneKey(userId: string): string {
  return `user_timezone:${userId}`;
}

function guildSyncRoleKey(guildId: string): string {
  return `guild_sync_role:${guildId}`;
}

function guildSyncPostChannelKey(guildId: string): string {
  return `guild_sync_post_channel:${guildId}`;
}

type SyncTimePostChannelLike = {
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

type SyncTimePostMessageLike = {
  id: string;
  channelId: string;
  author: { bot: boolean };
  content: string;
  react: (emoji: string) => Promise<void>;
  pin: () => Promise<void>;
  unpin: () => Promise<void>;
};

function isSupportedSyncTimePostChannel(
  channel: SyncTimePostChannelLike | null | undefined
): channel is SyncTimePostChannelLike {
  if (!channel) return false;
  if (typeof channel.type !== "number") return false;
  if (
    !SYNC_TIME_POST_CHANNEL_TYPES.includes(
      channel.type as (typeof SYNC_TIME_POST_CHANNEL_TYPES)[number]
    )
  ) {
    return false;
  }
  if (typeof channel.isTextBased !== "function" || !channel.isTextBased()) return false;
  if (typeof channel.permissionsFor !== "function") return false;
  if (!("messages" in channel) || !("send" in channel)) return false;
  return true;
}

async function resolveConfiguredSyncTimePostChannel(
  guild: Guild,
  channelId: string
): Promise<SyncTimePostChannelLike | null> {
  const cached = guild.channels.cache.get(channelId) as SyncTimePostChannelLike | null | undefined;
  if (isSupportedSyncTimePostChannel(cached)) return cached;

  const fetched = (await guild.channels.fetch(channelId).catch(() => null)) as
    | SyncTimePostChannelLike
    | null;
  if (isSupportedSyncTimePostChannel(fetched)) return fetched;

  return null;
}

async function resolveSyncTimePostDestination(input: {
  guild: Guild;
  guildId: string;
  invocationChannel: SyncTimePostChannelLike | null;
  settings: SettingsService;
  botLogChannelService?: BotLogChannelService;
}): Promise<{
  channel: SyncTimePostChannelLike | null;
  fallbackNotice: string | null;
}> {
  const botLogChannelService =
    input.botLogChannelService ?? new BotLogChannelService(input.settings);
  const typedChannelId = await botLogChannelService.getChannelIdForType(
    input.guildId,
    "sync",
  );
  if (typedChannelId) {
    const typedChannel = await resolveConfiguredSyncTimePostChannel(
      input.guild,
      typedChannelId,
    );
    if (typedChannel) {
      return { channel: typedChannel, fallbackNotice: null };
    }
    await botLogChannelService.clearChannelIdForType(input.guildId, "sync");
    return {
      channel: input.invocationChannel,
      fallbackNotice: `Configured sync bot-log channel <#${typedChannelId}> is unavailable; the sync announcement and readiness dashboard will use this channel instead.`,
    };
  }

  const legacyChannelId = await input.settings.get(
    guildSyncPostChannelKey(input.guildId),
  );
  if (legacyChannelId) {
    const legacyChannel = await resolveConfiguredSyncTimePostChannel(
      input.guild,
      legacyChannelId,
    );
    if (legacyChannel) {
      return { channel: legacyChannel, fallbackNotice: null };
    }
    await input.settings.delete(guildSyncPostChannelKey(input.guildId));
    return {
      channel: input.invocationChannel,
      fallbackNotice: `Configured sync-time post channel <#${legacyChannelId}> is unavailable; the sync announcement and readiness dashboard will use this channel instead.`,
    };
  }

  return { channel: input.invocationChannel, fallbackNotice: null };
}

function isBotSyncTimeMessage(content: string): boolean {
  return content.startsWith("# Sync time :gem:");
}

function extractSyncEpochSeconds(content: string): number | null {
  const match = content.match(/<t:(\d{8,12}):F>/);
  if (!match?.[1]) return null;
  const epoch = Number(match[1]);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return epoch;
}

function reactionMatchesBadge(
  reaction: { emoji: { id: string | null; name: string | null } },
  badge: SyncBadge
): boolean {
  if (reaction.emoji.id && badge.matchEmojiIds.includes(reaction.emoji.id)) return true;
  return Boolean(reaction.emoji.name && badge.matchEmojiNames.includes(reaction.emoji.name));
}

function parseAllowedRoleIds(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)))];
}

async function getLeaderRoleIds(settings: SettingsService, guildId: string): Promise<string[]> {
  const preferredRole = await settings.get(`${FWA_LEADER_ROLE_SETTING_KEY}:${guildId}`);
  if (preferredRole && /^\d+$/.test(preferredRole.trim())) {
    return [preferredRole.trim()];
  }
  const syncRoles = parseAllowedRoleIds(await settings.get("command_roles:post:sync:time"));
  if (syncRoles.length > 0) return syncRoles;
  return parseAllowedRoleIds(await settings.get("command_roles:post"));
}

function buildModalCustomId(userId: string): string {
  return `${POST_SYNC_TIME_MODAL_PREFIX}:${userId}`;
}

function parseModalCustomId(
  customId: string
): { userId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 2 || parts[0] !== POST_SYNC_TIME_MODAL_PREFIX) {
    return null;
  }

  const [, userId] = parts;
  if (!userId) return null;
  return { userId };
}

function parseRoleId(input: string): string | null {
  const trimmed = input.trim();
  const mentionMatch = trimmed.match(/^<@&(\d+)>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];
  if (/^\d+$/.test(trimmed)) return trimmed;
  return null;
}

function getEffectiveDefaults(timeZone: string): {
  date: string;
  time: string;
} {
  const plus12Hours = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const defaultParts = getDateTimeInTimeZone(plus12Hours, timeZone);
  return {
    date: `${defaultParts.year}-${String(defaultParts.month).padStart(2, "0")}-${String(
      defaultParts.day
    ).padStart(2, "0")}`,
    time: `${String(defaultParts.hour).padStart(2, "0")}:${String(
      defaultParts.minute
    ).padStart(2, "0")}`,
  };
}

export function isPostModalCustomId(customId: string): boolean {
  return customId.startsWith(`${POST_SYNC_TIME_MODAL_PREFIX}:`);
}

export async function handlePostModalSubmit(
  interaction: ModalSubmitInteraction
): Promise<void> {
  const parsed = parseModalCustomId(interaction.customId);
  if (!parsed) return;

  if (parsed.userId !== interaction.user.id) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the user who opened this modal can submit it.",
    });
    return;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const settings = new SettingsService();

  const dateInput = interaction.fields.getTextInputValue(DATE_INPUT_ID).trim();
  const timeInput = interaction.fields.getTextInputValue(TIME_INPUT_ID).trim();
  const timezoneRawInput = interaction.fields.getTextInputValue(TIMEZONE_INPUT_ID);
  const timezoneInput = normalizeSyncTimeZone(timezoneRawInput);
  const roleInput = interaction.fields.getTextInputValue(ROLE_INPUT_ID).trim();
  const permissionService = new CommandPermissionService(settings);
  const defaultLeaderRoleId = await permissionService.getFwaLeaderRoleId(interaction.guildId);

  if (!timezoneInput) {
    await interaction.editReply(
      `Invalid timezone. Use a valid IANA timezone like America/New_York, or a supported US alias like EST, EDT, PST, or PDT.\nReference: ${IANA_TIMEZONE_HELP_URL}`
    );
    return;
  }

  const date = parseDate(dateInput);
  if (!date) {
    await interaction.editReply(
      "Invalid date. Use YYYY-MM-DD, for example 2026-02-22."
    );
    return;
  }

  const time = parseTime(timeInput);
  if (!time) {
    await interaction.editReply(
      "Invalid time. Use 24-hour HH:mm, for example 20:30."
    );
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }

  const roleId = parseRoleId(roleInput) ?? defaultLeaderRoleId;
  if (!roleId) {
    await interaction.editReply(
      "Invalid role. Provide a role mention/ID, or set `/fwa leader-role` first."
    );
    return;
  }

  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    await interaction.editReply("Role not found in this server. Use a valid server role mention or role ID.");
    return;
  }

  await settings.set(userTimeZoneKey(interaction.user.id), timezoneInput);
  await settings.set(guildSyncRoleKey(interaction.guildId), role.id);

  const epochSeconds = toEpochSeconds(
    date.year,
    date.month,
    date.day,
    time.hour,
    time.minute,
    timezoneInput
  );

  const invocationChannel = interaction.channel as SyncTimePostChannelLike | null;
  const { channel, fallbackNotice: configuredChannelFallbackNotice } =
    await resolveSyncTimePostDestination({
      guild,
      guildId: interaction.guildId,
      invocationChannel,
      settings,
    });

  if (!isSupportedSyncTimePostChannel(channel)) {
    await interaction.editReply("This command can only post to text channels.");
    return;
  }

  if (typeof channel.permissionsFor !== "function") {
    await interaction.editReply("This command can only post in guild text channels.");
    return;
  }

  // Block duplicate submissions when a sync post already exists for the same epoch.
  const existingActiveSyncPost = await resolveStoredActiveSyncMessage(interaction, settings);
  const existingActiveEpoch = existingActiveSyncPost
    ? extractSyncEpochSeconds(existingActiveSyncPost.content)
    : null;
  if (existingActiveSyncPost && existingActiveEpoch === epochSeconds) {
    const existingLink = `https://discord.com/channels/${guild.id}/${existingActiveSyncPost.channelId}/${existingActiveSyncPost.id}`;
    await interaction.editReply(
      `A sync time post for <t:${epochSeconds}:F> already exists: ${existingLink}`
    );
    return;
  }

  try {
    const pinned = await channel.messages.fetchPinned();
    const duplicatePinned = [...pinned.values()].find((msg) => {
      if (!msg.author.bot) return false;
      if (!isBotSyncTimeMessage(msg.content)) return false;
      const msgEpoch = extractSyncEpochSeconds(msg.content);
      return msgEpoch === epochSeconds;
    });
    if (duplicatePinned) {
      const existingLink = `https://discord.com/channels/${guild.id}/${duplicatePinned.channelId}/${duplicatePinned.id}`;
      await interaction.editReply(
        `A sync time post for <t:${epochSeconds}:F> is already pinned: ${existingLink}`
      );
      return;
    }
  } catch (err) {
    console.error(
      `[post sync time] duplicate-check pinned fetch failed guild=${interaction.guildId} invocation_channel=${interaction.channelId} destination_channel=${channel.id} user=${interaction.user.id} error=${formatError(
        err
      )}`
    );
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    await interaction.editReply("Could not verify bot permissions in this channel.");
    return;
  }

  const permissions = channel.permissionsFor(me);
  if (!permissions?.has(PermissionFlagsBits.SendMessages)) {
    await interaction.editReply(
      "Could not post sync time: bot is missing `Send Messages` in this channel."
    );
    return;
  }

  const canMentionEveryone = permissions.has(PermissionFlagsBits.MentionEveryone);
  const mentionWillNotify = role.mentionable || canMentionEveryone;
  const scheduledSyncTime = new Date(epochSeconds * 1000);
  if (scheduledSyncTime.getTime() <= Date.now()) {
    await interaction.editReply("The sync time must be in the future.");
    return;
  }

  let announcementResult;
  try {
    announcementResult = await syncTimePostPublisherService.publishImmediateSyncTimePost({
      guild,
      channel,
      role,
      syncTime: scheduledSyncTime,
      createdByUserId: interaction.user.id,
      settings,
      clientUserId: interaction.client.user?.id ?? null,
      now: new Date(),
    });
  } catch (err) {
    console.error(
      `[sync-time-announcement] command_failed guild_id=${interaction.guildId} channel_id=${channel.id} role_id=${role.id} user_id=${interaction.user.id} error=${formatError(err)}`,
    );
    await interaction.editReply("Could not post the sync-time announcement. Check the logs and try again.");
    return;
  }

  const publishAt = new Date(epochSeconds * 1000 - 2 * 60 * 60 * 1000);
  let scheduleResult:
    | Awaited<ReturnType<typeof scheduledSyncPostService.scheduleSyncTimePost>>
    | null = null;
  let readinessLink: string | null = null;
  let readinessOutcome: string | null = null;
  let readinessPartialFailure = false;

  try {
    scheduleResult = await scheduledSyncPostService.scheduleSyncTimePost({
      guildId: interaction.guildId,
      channelId: channel.id,
      createdByUserId: interaction.user.id,
      roleId: role.id,
      syncTime: scheduledSyncTime,
      publishAt,
      timezone: timezoneInput,
    });
  } catch (err) {
    console.error(
      `[sync-readiness-schedule] schedule_failed guild_id=${interaction.guildId} channel_id=${channel.id} role_id=${role.id} user_id=${interaction.user.id} sync_epoch=${epochSeconds} publish_epoch=${Math.floor(publishAt.getTime() / 1000)} error=${formatError(err)}`,
    );
    const announcementLink = `https://discord.com/channels/${guild.id}/${announcementResult.channelId}/${announcementResult.messageId}`;
    const notices: string[] = [];
    if (!mentionWillNotify) {
      notices.push(
        `Role mention may not notify members because \`${role.name}\` is not mentionable and the bot lacks \`Mention Everyone\`.`,
      );
    }
    if (configuredChannelFallbackNotice) {
      notices.push(configuredChannelFallbackNotice);
    }
    const noticeBlock =
      notices.length > 0 ? `\n${notices.map((n) => `- ${n}`).join("\n")}` : "";
    const destinationLine =
      channel.id !== interaction.channelId ? `\nWill post in <#${channel.id}>.` : "";
    await interaction.editReply(
      `Sync announcement posted now: ${announcementLink}\nCould not schedule the readiness dashboard. Check the logs and try again.${destinationLine}${noticeBlock}`,
    );
    return;
  }

  if (!scheduleResult) {
    return;
  }

  if (scheduleResult.action === "already_published") {
    readinessOutcome = "already published";
  } else if (publishAt.getTime() <= Date.now()) {
    const claim = await scheduledSyncPostService.tryClaimScheduledSyncPost({
      schedule: scheduleResult.schedule,
      now: new Date(),
    });
    if (claim.claimed && claim.schedule && claim.claimToken) {
      try {
        const immediateReadinessResult =
          await scheduledSyncReadinessPublisherService.publishScheduledSyncReadinessPost({
            guild,
            channel,
            schedule: claim.schedule,
            claimToken: claim.claimToken,
            publicationMode: "immediate",
            now: new Date(),
            scheduleService: scheduledSyncPostService,
          });
        readinessLink = `https://discord.com/channels/${guild.id}/${immediateReadinessResult.channelId}/${immediateReadinessResult.messageId}`;
        readinessOutcome = "posted now";
      } catch (err) {
        readinessPartialFailure = true;
        console.error(
          `[sync-readiness-publish] immediate_failed schedule_id=${claim.schedule.id} guild_id=${claim.schedule.guildId} channel_id=${claim.schedule.channelId} sync_epoch=${epochSeconds} publish_epoch=${Math.floor(publishAt.getTime() / 1000)} error=${formatError(err)}`,
        );
        readinessOutcome = "scheduled";
      }
    } else {
      readinessPartialFailure = true;
      readinessOutcome = "scheduled";
      console.warn(
        `[sync-readiness-publish] immediate_claim_unavailable schedule_id=${scheduleResult.schedule.id} guild_id=${scheduleResult.schedule.guildId} channel_id=${scheduleResult.schedule.channelId} sync_epoch=${epochSeconds} publish_epoch=${Math.floor(publishAt.getTime() / 1000)} claim_reason=${claim.reason}`,
      );
    }
  } else {
    readinessOutcome = `scheduled for <t:${Math.floor(publishAt.getTime() / 1000)}:F>`;
  }

  const notices: string[] = [];
  if (!mentionWillNotify) {
    notices.push(
      `Role mention may not notify members because \`${role.name}\` is not mentionable and the bot lacks \`Mention Everyone\`.`,
    );
  }
  if (configuredChannelFallbackNotice) {
    notices.push(configuredChannelFallbackNotice);
  }
  if (scheduleResult.action === "replaced") {
    notices.push("Replaced older pending/claimed readiness schedules for this guild.");
  } else if (scheduleResult.action === "reused") {
    notices.push("Reused the existing readiness schedule for that sync time.");
  } else if (scheduleResult.action === "reactivated") {
    notices.push("Reactivated the existing terminal readiness schedule for that sync time.");
  }

  const announcementLink = `https://discord.com/channels/${guild.id}/${announcementResult.channelId}/${announcementResult.messageId}`;
  const readinessScheduleLine =
    readinessOutcome ?? `scheduled for <t:${Math.floor(publishAt.getTime() / 1000)}:F>`;
  if (readinessPartialFailure && !readinessLink) {
    notices.push("Readiness dashboard scheduling is still retryable.");
  }
  const noticeBlock =
    notices.length > 0 ? `\n${notices.map((n) => `- ${n}`).join("\n")}` : "";
  const destinationLine = channel.id !== interaction.channelId ? `\nWill post in <#${channel.id}>.` : "";

  await interaction.editReply(
    `Sync announcement posted now: ${announcementLink}\nReadiness dashboard ${readinessScheduleLine}.${readinessLink ? `\nReadiness dashboard message: ${readinessLink}` : ""}${destinationLine}${noticeBlock}`
  );
}

export const Post: Command = {
  name: "sync",
  description: "Sync posting and status commands",
  options: [
    {
      name: "readiness",
      description: "Post the FWA readiness dashboard",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "refresh",
          description: "Force-refresh tracked clan ACTUAL member data before posting",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
        {
          name: "visibility",
          description: "Choose whether the readiness post is private or public",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "private", value: "private" },
            { name: "public", value: "public" },
          ],
        },
      ],
    },
    {
      name: "time",
      description: "Sync time related commands",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "post",
          description: "Post the sync announcement now and schedule the readiness dashboard",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "role",
              description: "Role to ping",
              type: ApplicationCommandOptionType.Role,
              required: false,
            },
            {
              name: "timezone",
              description: "IANA timezone to prefill the modal",
              type: ApplicationCommandOptionType.String,
              required: false,
              autocomplete: true,
            },
          ],
        },
      ],
    },
    {
      name: "post",
      description: "Sync post related commands",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "status",
          description: "Show claimed/unclaimed clan badges for a sync-time post",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "message-id",
              description:
                "Sync-time message ID (optional; defaults to active sync post)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
          ],
        },
      ],
    },
    {
      name: "spin",
      description: "Sync spin status commands",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "status",
          description: "Show the tracked sync spin status",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "message-id",
              description:
                "Sync-time message ID (optional; defaults to active sync post)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
          ],
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    if (!interaction.inGuild()) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(true);
    if (!subcommandGroup && subcommand === "readiness") {
      await handleSyncReadinessSubcommand(interaction);
      return;
    }

    if (!subcommandGroup) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Unknown subcommand.",
      });
      return;
    }

    if (subcommandGroup === "post" && subcommand === "status") {
      await handleSyncClaimStatusSubcommand(interaction);
      return;
    }

    if (subcommandGroup === "spin" && subcommand === "status") {
      await handleSyncSpinStatusSubcommand(interaction);
      return;
    }

    if (!(subcommandGroup === "time" && subcommand === "post")) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Unknown subcommand.",
      });
      return;
    }

    const settings = new SettingsService();
    const role = interaction.options.getRole("role", false);
    const timezoneSeedRaw = interaction.options.getString("timezone", false)?.trim() ?? null;

    const rememberedTimeZoneRaw = await settings.get(userTimeZoneKey(interaction.user.id));
    const rememberedTimeZone = normalizeSyncTimeZone(rememberedTimeZoneRaw);
    if (
      rememberedTimeZone &&
      rememberedTimeZoneRaw?.trim() &&
      rememberedTimeZoneRaw.trim() !== rememberedTimeZone
    ) {
      await settings.set(userTimeZoneKey(interaction.user.id), rememberedTimeZone);
    }
    const rememberedRoleId = await settings.get(guildSyncRoleKey(interaction.guildId));
    const defaultLeaderRoleId =
      (await settings.get(`${FWA_LEADER_ROLE_SETTING_KEY}:${interaction.guildId}`)) ?? "";
    const providedTimeZone = normalizeSyncTimeZone(timezoneSeedRaw);
    const initialTimeZone = providedTimeZone ?? rememberedTimeZone ?? "UTC";
    const defaults = getEffectiveDefaults(initialTimeZone);
    const initialRoleId = role?.id ?? rememberedRoleId ?? defaultLeaderRoleId ?? "";

    const modal = new ModalBuilder()
      .setCustomId(buildModalCustomId(interaction.user.id))
      .setTitle("Schedule Sync Time");

    const dateInput = new TextInputBuilder()
      .setCustomId(DATE_INPUT_ID)
      .setLabel("Date (YYYY-MM-DD)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(defaults.date);
    const timeInput = new TextInputBuilder()
      .setCustomId(TIME_INPUT_ID)
      .setLabel("Time (24h HH:mm)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(defaults.time);
    const timeZoneInput = new TextInputBuilder()
      .setCustomId(TIMEZONE_INPUT_ID)
      .setLabel("Timezone (IANA or US alias)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(initialTimeZone);
    const roleInput = new TextInputBuilder()
      .setCustomId(ROLE_INPUT_ID)
      .setLabel("Role (mention or ID)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    if (initialRoleId) {
      roleInput.setValue(`<@&${initialRoleId}>`);
    }

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(dateInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(timeInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(timeZoneInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(roleInput)
    );

    await interaction.showModal(modal);
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);
    const focused = interaction.options.getFocused(true);

    if (!(subcommandGroup === "time" && subcommand === "post" && focused.name === "timezone")) {
      await interaction.respond([]);
      return;
    }

    await interaction.respond(autocompleteSyncTimeZones(String(focused.value ?? "")));
  },
};

