import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GuildMember,
  type MessageMentionOptions,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import { SettingsService } from "../services/SettingsService";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;
const POST_SYNC_TIME_MODAL_PREFIX = "post-sync-time";
const DATE_INPUT_ID = "date";
const TIME_INPUT_ID = "time";
const TIMEZONE_INPUT_ID = "timezone";
const ROLE_INPUT_ID = "role";
const IANA_TIMEZONE_HELP_URL =
  "https://en.wikipedia.org/wiki/List_of_tz_database_time_zones";
const PROD_BOT_ID = "1131335782016237749";
const STAGING_BOT_ID = "1474193888146358393";

type BadgeEmoji = { code: string; label: string; name: string; id: string };

const SYNC_BADGE_EMOJIS_BY_BOT: Record<string, BadgeEmoji[]> = {
  [STAGING_BOT_ID]: [
    { code: "ZG", label: "ZERO GRAVITY", name: "zg", id: "1476279645174366449" },
    { code: "TWC", label: "TheWiseCowboys", name: "twc", id: "1476279643660091452" },
    { code: "SE", label: "Steel Empire 2", name: "se", id: "1476279635208573009" },
    { code: "RR", label: "Rocky Road", name: "rr", id: "1476279632729866242" },
    { code: "RD", label: "RISING DAWN", name: "rd", id: "1476279631345614902" },
    { code: "MV", label: "MARVELS", name: "mv", id: "1476279630129528986" },
    { code: "DE", label: "DARK EMPIRE™!", name: "de", id: "1476279629106118676" },
    { code: "AK", label: "ＡＫＡＴＳＵＫＩ", name: "ak", id: "1476279627839307836" },
  ],
  [PROD_BOT_ID]: [
    { code: "ZG", label: "ZERO GRAVITY", name: "zg", id: "1476279778670673930" },
    { code: "TWC", label: "TheWiseCowboys", name: "twc", id: "1476279777466908755" },
    { code: "SE", label: "Steel Empire 2", name: "se", id: "1476279774241493104" },
    { code: "RR", label: "Rocky Road", name: "rr", id: "1476279773243379762" },
    { code: "RD", label: "RISING DAWN", name: "rd", id: "1476279771884290100" },
    { code: "MV", label: "MARVELS", name: "mv", id: "1476279770667814932" },
    { code: "DE", label: "DARK EMPIRE™!", name: "de", id: "1476279769552392427" },
    { code: "AK", label: "ＡＫＡＴＳＵＫＩ", name: "ak", id: "1476279768608411874" },
  ],
};

function getSyncBadgeEmojis(botUserId: string | undefined): BadgeEmoji[] {
  if (!botUserId) return [];
  return SYNC_BADGE_EMOJIS_BY_BOT[botUserId] ?? [];
}

function getSyncBadgeEmojiIdentifiers(botUserId: string | undefined): string[] {
  const badges = getSyncBadgeEmojis(botUserId);
  return badges.map((e) => `${e.name}:${e.id}`);
}

function parseAllowedRoleIds(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)))];
}

async function getLeaderRoleIds(settings: SettingsService): Promise<string[]> {
  const syncRoles = parseAllowedRoleIds(await settings.get("command_roles:post:sync:time"));
  if (syncRoles.length > 0) return syncRoles;
  return parseAllowedRoleIds(await settings.get("command_roles:post"));
}

function activeSyncPostKey(guildId: string): string {
  return `active_sync_post:${guildId}`;
}

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
  interaction: ChatInputCommandInteraction,
  settings: SettingsService
) {
  const guild = interaction.guild;
  if (!guild) return null;
  const guildId = guild.id;

  const stored = parseActiveSyncPost(await settings.get(activeSyncPostKey(guildId)));
  if (!stored) return null;

  const channel = await guild.channels.fetch(stored.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) {
    await settings.delete(activeSyncPostKey(guildId));
    return null;
  }

  const message = await channel.messages.fetch(stored.messageId).catch(() => null);
  if (!message || !message.author.bot || !isBotSyncTimeMessage(message.content)) {
    await settings.delete(activeSyncPostKey(guildId));
    return null;
  }

  return message;
}

async function resolveSyncStatusMessage(
  interaction: ChatInputCommandInteraction,
  settings: SettingsService,
  explicitMessageId: string | null
) {
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("messages" in channel)) {
    return null;
  }

  if (explicitMessageId) {
    return channel.messages.fetch(explicitMessageId).catch(() => null);
  }

  const storedActiveMessage = await resolveStoredActiveSyncMessage(interaction, settings);
  if (storedActiveMessage) return storedActiveMessage;

  const pinned = await channel.messages.fetchPinned().catch(() => null);
  if (pinned && pinned.size > 0) {
    const latestPinnedSync = [...pinned.values()]
      .filter((m) => m.author.bot && isBotSyncTimeMessage(m.content))
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (latestPinnedSync) return latestPinnedSync;
  }

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!recent) return null;
  return [...recent.values()]
    .filter((m) => m.author.bot && isBotSyncTimeMessage(m.content))
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .at(0) ?? null;
}

async function handleSyncStatusSubcommand(
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
        : "Could not find an active sync-time message. Post one with `/post sync time` first."
    );
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const badges = getSyncBadgeEmojis(interaction.client.user?.id);
  if (badges.length === 0) {
    await interaction.editReply(
      "No badge emoji configuration found for this bot ID."
    );
    return;
  }

  const leaderRoleIds = await getLeaderRoleIds(settings);
  const memberCache = new Map<string, GuildMember | null>();
  const getMember = async (userId: string): Promise<GuildMember | null> => {
    if (memberCache.has(userId)) return memberCache.get(userId) ?? null;
    const member = await guild.members.fetch(userId).catch(() => null);
    memberCache.set(userId, member);
    return member;
  };

  const claimedLines: string[] = [];
  const unclaimedLines: string[] = [];

  for (const badge of badges) {
    const reaction = [...message.reactions.cache.values()].find((r) => r.emoji.id === badge.id);
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

    const emojiInline = `<:${badge.name}:${badge.id}>`;
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

  const embed = new EmbedBuilder()
    .setTitle("Sync Claim Status")
    .setDescription(
      [
        `Message: https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}`,
        "",
        `Claimed: **${claimedLines.length}/${badges.length}**`,
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
          ? "Leader = Administrator or role allowed for /post sync time"
          : "Leader = Administrator (no explicit /post role whitelist configured)",
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

function to12HourLabel(hour24: number, minute: number): string {
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
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

function normalizeTimeZone(input: string): string {
  return input.trim();
}

function validateTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
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

function buildSyncMessage(epochSeconds: number, roleId: string): string {
  return `# Sync time :gem:

<t:${epochSeconds}:F> (<t:${epochSeconds}:R>)

<@&${roleId}>`;
}

function summarizePermissionIssue(err: unknown, action: string): string {
  const code = (err as { code?: number } | null | undefined)?.code;
  if (code === 50013 || code === 50001) {
    return `${action} failed due to missing bot permissions in this channel.`;
  }
  if (code) {
    return `${action} failed (Discord code: ${code}). Check bot permissions and logs.`;
  }
  return `${action} failed. Check bot permissions and logs.`;
}

function isBotSyncTimeMessage(content: string): boolean {
  return content.startsWith("# Sync time :gem:");
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
  const timezoneInput = normalizeTimeZone(
    interaction.fields.getTextInputValue(TIMEZONE_INPUT_ID)
  );
  const roleInput = interaction.fields.getTextInputValue(ROLE_INPUT_ID).trim();

  if (!validateTimeZone(timezoneInput)) {
    await interaction.editReply(
      `Invalid timezone. Use a valid IANA timezone like America/New_York.\nReference: ${IANA_TIMEZONE_HELP_URL}`
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

  const roleId = parseRoleId(roleInput);
  if (!roleId) {
    await interaction.editReply("Invalid role. Provide a role mention like <@&123> or a role ID.");
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

  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    await interaction.editReply("This command can only post to text channels.");
    return;
  }

  if (!("permissionsFor" in channel)) {
    await interaction.editReply("This command can only post in guild text channels.");
    return;
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
  const notices: string[] = [];
  const allowedMentions: MessageMentionOptions = mentionWillNotify
    ? { roles: [role.id] }
    : { parse: [] };

  const content = buildSyncMessage(epochSeconds, role.id);
  const postedMessage = await channel
    .send({
      content,
      allowedMentions,
    })
    .catch(async (err) => {
      console.error(
        `[post sync time] send failed guild=${interaction.guildId} channel=${interaction.channelId} role=${role.id} user=${interaction.user.id} error=${formatError(
          err
        )}`
      );
      await interaction.editReply(summarizePermissionIssue(err, "Posting sync time"));
      return null;
    });
  if (!postedMessage) {
    return;
  }
  await settings.set(
    activeSyncPostKey(interaction.guildId),
    JSON.stringify({
      channelId: postedMessage.channelId,
      messageId: postedMessage.id,
    })
  );

  if (!mentionWillNotify) {
    notices.push(
      `Role mention was included but may not notify members because \`${role.name}\` is not mentionable and bot lacks \`Mention Everyone\`.`
    );
  }

  const badgeEmojiIdentifiers = getSyncBadgeEmojiIdentifiers(interaction.client.user?.id);
  if (badgeEmojiIdentifiers.length > 0) {
    let reactedCount = 0;
    for (const emojiIdentifier of badgeEmojiIdentifiers) {
      try {
        await postedMessage.react(emojiIdentifier);
        reactedCount += 1;
      } catch (err) {
        console.error(
          `[post sync time] react failed guild=${interaction.guildId} channel=${interaction.channelId} message=${postedMessage.id} emoji=${emojiIdentifier} user=${interaction.user.id} error=${formatError(
            err
          )}`
        );
      }
    }
    if (reactedCount < badgeEmojiIdentifiers.length) {
      notices.push(
        `Some clan badge reactions failed (${reactedCount}/${badgeEmojiIdentifiers.length}). Check bot \`Add Reactions\` and emoji access in this server.`
      );
    }
  }

  try {
    const pinned = await channel.messages.fetchPinned();
    for (const pinnedMessage of pinned.values()) {
      if (pinnedMessage.id === postedMessage.id) continue;
      if (!pinnedMessage.author.bot) continue;
      if (!isBotSyncTimeMessage(pinnedMessage.content)) continue;
      await pinnedMessage.unpin().catch(() => undefined);
    }
  } catch (err) {
    console.error(
      `[post sync time] fetchPinned/unpin failed guild=${interaction.guildId} channel=${interaction.channelId} user=${interaction.user.id} error=${formatError(
        err
      )}`
    );
    notices.push(summarizePermissionIssue(err, "Cleaning previous sync pins"));
  }

  try {
    await postedMessage.pin();
  } catch (err) {
    console.error(
      `[post sync time] pin failed guild=${interaction.guildId} channel=${interaction.channelId} message=${postedMessage.id} user=${interaction.user.id} error=${formatError(
        err
      )}`
    );
    notices.push(summarizePermissionIssue(err, "Pinning message"));
  }

  const noticeBlock =
    notices.length > 0 ? `\n${notices.map((n) => `- ${n}`).join("\n")}` : "";

  await interaction.editReply(
    `Sync time message posted.\nUsed: ${dateInput} ${timeInput} (${to12HourLabel(
      time.hour,
      time.minute
    )}, ${timezoneInput}).${noticeBlock}`
  );
}

export const Post: Command = {
  name: "post",
  description: "Post formatted messages",
  options: [
    {
      name: "sync",
      description: "Sync related posting commands",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "time",
          description: "Post a localized sync time with role ping",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "role",
              description: "Role to ping",
              type: ApplicationCommandOptionType.Role,
              required: false,
            },
          ],
        },
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
    if (subcommandGroup !== "sync") {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Unknown subcommand.",
      });
      return;
    }

    if (subcommand === "status") {
      await handleSyncStatusSubcommand(interaction);
      return;
    }

    if (subcommand !== "time") {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Unknown subcommand.",
      });
      return;
    }

    const settings = new SettingsService();
    const role = interaction.options.getRole("role", false);

    const rememberedTimeZone = await settings.get(userTimeZoneKey(interaction.user.id));
    const rememberedRoleId = await settings.get(guildSyncRoleKey(interaction.guildId));
    const initialTimeZone =
      rememberedTimeZone && validateTimeZone(rememberedTimeZone)
        ? rememberedTimeZone
        : "UTC";
    const defaults = getEffectiveDefaults(initialTimeZone);
    const initialRoleId = role?.id ?? rememberedRoleId ?? "";

    const modal = new ModalBuilder()
      .setCustomId(buildModalCustomId(interaction.user.id))
      .setTitle("Post Sync Time");

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
      .setLabel("Timezone (IANA)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(initialTimeZone);
    const roleInput = new TextInputBuilder()
      .setCustomId(ROLE_INPUT_ID)
      .setLabel("Role (mention or ID)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

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
};
