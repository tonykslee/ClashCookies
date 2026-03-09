import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { truncateDiscordContent } from "../helper/discordContent";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import {
  buildTelemetryReport,
  parseTelemetryPeriod,
  renderTelemetryReport,
} from "../services/telemetry/report";
import {
  disableTelemetryReportSchedule,
  formatTelemetryScheduleSummary,
  getTelemetryReportSchedule,
  runTelemetryScheduleOnce,
  upsertTelemetryReportSchedule,
} from "../services/telemetry/schedule";
import { isValidIanaTimeZone, normalizeCadenceHours } from "../services/telemetry/timeWindow";

const PERIOD_CHOICES = [
  { name: "24h", value: "24h" },
  { name: "7d", value: "7d" },
  { name: "30d", value: "30d" },
] as const;

async function runManualReport(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await safeReply(interaction, {
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const period = parseTelemetryPeriod(interaction.options.getString("period", false));
  const timezoneInput = interaction.options.getString("timezone", false)?.trim() || "UTC";
  const timeZone = isValidIanaTimeZone(timezoneInput) ? timezoneInput : "UTC";
  const report = await buildTelemetryReport({
    guildId: interaction.guildId,
    period,
    timeZone,
  });
  await interaction.editReply(truncateDiscordContent(renderTelemetryReport(report)));
}

async function runScheduleSet(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await safeReply(interaction, {
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }
  const channel = interaction.options.getChannel("target-channel", true);
  const cadenceHours = normalizeCadenceHours(interaction.options.getInteger("cadence-hours", true));
  const rawTz = interaction.options.getString("timezone", false)?.trim() || "UTC";
  const timezone = isValidIanaTimeZone(rawTz) ? rawTz : "UTC";
  const enabled = interaction.options.getBoolean("enabled", false) ?? true;
  await upsertTelemetryReportSchedule({
    guildId: interaction.guildId,
    channelId: channel.id,
    cadenceHours,
    timezone,
    enabled,
  });
  const schedule = await getTelemetryReportSchedule(interaction.guildId);
  await safeReply(interaction, {
    ephemeral: true,
    content: `Telemetry schedule saved.\n${formatTelemetryScheduleSummary(schedule)}`,
  });
}

async function runScheduleShow(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await safeReply(interaction, {
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }
  const schedule = await getTelemetryReportSchedule(interaction.guildId);
  await safeReply(interaction, {
    ephemeral: true,
    content: formatTelemetryScheduleSummary(schedule),
  });
}

async function runScheduleDisable(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await safeReply(interaction, {
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }
  await disableTelemetryReportSchedule(interaction.guildId);
  const schedule = await getTelemetryReportSchedule(interaction.guildId);
  await safeReply(interaction, {
    ephemeral: true,
    content: `Telemetry schedule disabled.\n${formatTelemetryScheduleSummary(schedule)}`,
  });
}

async function runScheduleNow(
  client: Client,
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId) {
    await safeReply(interaction, {
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const schedule = await getTelemetryReportSchedule(interaction.guildId);
  if (!schedule || !schedule.enabled) {
    await interaction.editReply(
      "No enabled telemetry schedule found. Configure one with `/telemetry schedule set`."
    );
    return;
  }
  const posted = await runTelemetryScheduleOnce(client, schedule);
  await interaction.editReply(
    posted
      ? "Telemetry report posted for the current completed schedule window."
      : "Telemetry report for this schedule window was already posted."
  );
}

export const Telemetry: Command = {
  name: "telemetry",
  description: "Telemetry reporting and scheduled summary management",
  options: [
    {
      name: "report",
      description: "Generate an on-demand telemetry report",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "period",
          description: "Report window length",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [...PERIOD_CHOICES],
        },
        {
          name: "timezone",
          description: "IANA timezone (for window display labels)",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "schedule",
      description: "Configure and run scheduled telemetry reports",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "set",
          description: "Set schedule target, cadence, timezone, and enabled flag",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "target-channel",
              description: "Channel where scheduled reports are posted",
              type: ApplicationCommandOptionType.Channel,
              required: true,
              channel_types: [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildAnnouncement],
            },
            {
              name: "cadence-hours",
              description: "How often to post (hours)",
              type: ApplicationCommandOptionType.Integer,
              required: true,
              min_value: 1,
              max_value: 720,
            },
            {
              name: "timezone",
              description: "IANA timezone (example: America/Los_Angeles)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "enabled",
              description: "Enable/disable immediately after save",
              type: ApplicationCommandOptionType.Boolean,
              required: false,
            },
          ],
        },
        {
          name: "show",
          description: "Show current telemetry schedule",
          type: ApplicationCommandOptionType.Subcommand,
        },
        {
          name: "disable",
          description: "Disable scheduled telemetry posts",
          type: ApplicationCommandOptionType.Subcommand,
        },
        {
          name: "run-now",
          description: "Run one schedule post for the current completed window",
          type: ApplicationCommandOptionType.Subcommand,
        },
      ],
    },
  ],
  run: async (
    client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(true);

    if (!group && sub === "report") {
      await runManualReport(interaction);
      return;
    }

    if (group === "schedule" && sub === "set") {
      await runScheduleSet(interaction);
      return;
    }
    if (group === "schedule" && sub === "show") {
      await runScheduleShow(interaction);
      return;
    }
    if (group === "schedule" && sub === "disable") {
      await runScheduleDisable(interaction);
      return;
    }
    if (group === "schedule" && sub === "run-now") {
      await runScheduleNow(client, interaction);
      return;
    }

    await safeReply(interaction, {
      ephemeral: true,
      content: "Unknown subcommand.",
    });
  },
};
