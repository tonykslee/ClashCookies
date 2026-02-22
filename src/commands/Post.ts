import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
  Role,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import { SettingsService } from "../services/SettingsService";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

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

function buildSyncMessage(epochSeconds: number, roleId: string): string {
  return `# Sync time :gem:

<t:${epochSeconds}:F> (<t:${epochSeconds}:R>)

<@&${roleId}>`;
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
              name: "date",
              description: "Date in YYYY-MM-DD format (default: now + 12h)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "time",
              description: "Time in 24h HH:mm format (default: now + 12h)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "timezone",
              description: "IANA timezone, e.g. America/New_York (remembered)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "role",
              description: "Role to ping",
              type: ApplicationCommandOptionType.Role,
              required: true,
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

    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "You need Administrator permission to use /post commands.",
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

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

    const dateInput = interaction.options.getString("date", false)?.trim();
    const timeInput = interaction.options.getString("time", false)?.trim();
    const timezoneInputRaw = interaction.options.getString("timezone", false);
    const role = interaction.options.getRole("role", true);

    if (!(role instanceof Role)) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Invalid role selected.",
      });
      return;
    }

    const rememberedTimeZone = await settings.get(userTimeZoneKey(interaction.user.id));
    const timezoneInput = timezoneInputRaw
      ? normalizeTimeZone(timezoneInputRaw)
      : rememberedTimeZone ?? "UTC";

    if (!validateTimeZone(timezoneInput)) {
      await safeReply(interaction, {
        ephemeral: true,
        content:
          "Invalid timezone. Use a valid IANA timezone like America/New_York.",
      });
      return;
    }

    if (timezoneInputRaw) {
      await settings.set(userTimeZoneKey(interaction.user.id), timezoneInput);
    }

    const plus12Hours = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const defaultParts = getDateTimeInTimeZone(plus12Hours, timezoneInput);

    const effectiveDateInput =
      dateInput ??
      `${defaultParts.year}-${String(defaultParts.month).padStart(2, "0")}-${String(
        defaultParts.day
      ).padStart(2, "0")}`;
    const effectiveTimeInput =
      timeInput ??
      `${String(defaultParts.hour).padStart(2, "0")}:${String(
        defaultParts.minute
      ).padStart(2, "0")}`;

    const date = parseDate(effectiveDateInput);
    if (!date) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Invalid date. Use YYYY-MM-DD, for example 2026-02-22.",
      });
      return;
    }

    const time = parseTime(effectiveTimeInput);
    if (!time) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Invalid time. Use 24-hour HH:mm, for example 20:30.",
      });
      return;
    }

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
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only post to text channels.",
      });
      return;
    }

    const content = buildSyncMessage(epochSeconds, role.id);
    const postedMessage = await channel.send({
      content,
      allowedMentions: { roles: [role.id] },
    });

    let pinNote = "";
    try {
      await postedMessage.pin();
    } catch {
      pinNote = " Posted, but I could not pin it (missing permission).";
    }

    await safeReply(interaction, {
      ephemeral: true,
      content:
        `Sync time message posted${pinNote}\n` +
        `Used: ${effectiveDateInput} ${effectiveTimeInput} (${timezoneInput}).`,
    });
  },
};
