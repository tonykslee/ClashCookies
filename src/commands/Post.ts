import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
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

  const canManageMessages = permissions.has(PermissionFlagsBits.ManageMessages);
  const canMentionEveryone = permissions.has(PermissionFlagsBits.MentionEveryone);
  const mentionWillNotify = role.mentionable || canMentionEveryone;
  const notices: string[] = [];

  const content = buildSyncMessage(epochSeconds, role.id);
  const postedMessage = await channel
    .send({
      content,
      allowedMentions: {
        parse: ["roles"],
        roles: [role.id],
      },
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

  if (!mentionWillNotify) {
    notices.push(
      `Role mention was included but may not notify members because \`${role.name}\` is not mentionable and bot lacks \`Mention Everyone\`.`
    );
  }

  if (canManageMessages) {
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
  } else {
    notices.push("Message posted, but bot is missing `Manage Messages` so it could not pin.");
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
    if (subcommandGroup !== "sync" || subcommand !== "time") {
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
