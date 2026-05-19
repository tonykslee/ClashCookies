import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { truncateDiscordContent } from "../helper/discordContent";
import { CoCService } from "../services/CoCService";
import {
  botPollJobStatusService,
  type BotPollJobStatusRecord,
  type BotPollJobStatusService,
} from "../services/BotPollJobStatusService";

const BOT_POLL_STATUS_EMOJI = {
  idle: "🟢",
  running: "🔵",
  skipped: "🟡",
  failed: "🔴",
  disabled: "⚫",
  overdue: "🟡",
  stuck: "🟡",
} as const;

const BOT_POLL_STATUS_HELPER_LIMITS = {
  fieldsPerEmbed: 20,
  lastErrorChars: 180,
};

type MetadataObject = Record<string, unknown>;

function hasAdministratorPermission(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function isMetadataObject(value: unknown): value is MetadataObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toUnixTimestampLabel(value: Date | null | undefined): string {
  if (!value) return "—";
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

function formatIntervalLabel(intervalMs: number | null): string {
  if (!intervalMs || intervalMs <= 0) return "—";
  const totalSeconds = Math.max(0, Math.floor(intervalMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatDurationLabel(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatShortError(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "—";
  return truncateDiscordContent(normalized, BOT_POLL_STATUS_HELPER_LIMITS.lastErrorChars);
}

function readStatusNote(job: BotPollJobStatusRecord): string | null {
  if (!isMetadataObject(job.metadata)) return null;
  const trigger = typeof job.metadata.trigger === "string" ? job.metadata.trigger.trim() : "";
  if (trigger) return `trigger=${trigger}`;
  const reason = typeof job.metadata.reason === "string" ? job.metadata.reason.trim() : "";
  if (reason) return `reason=${reason}`;
  return null;
}

function resolveJobTimes(job: BotPollJobStatusRecord, nowMs: number): {
  lastRunAt: Date | null;
  durationMs: number | null;
  warning: string | null;
  state: keyof typeof BOT_POLL_STATUS_EMOJI;
} {
  const intervalMs = job.intervalMs ?? null;
  const startedAtMs = job.lastStartedAt?.getTime() ?? null;
  const finishedAtMs = job.lastFinishedAt?.getTime() ?? null;
  const nextDueAtMs = job.nextDueAt?.getTime() ?? null;
  const status = String(job.status ?? "").toLowerCase();

  const runningAgeMs = startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs);
  const durationMs =
    status === "running" && startedAtMs !== null
      ? runningAgeMs
      : startedAtMs !== null && finishedAtMs !== null
        ? Math.max(0, finishedAtMs - startedAtMs)
        : null;

  const overdueByNextDue =
    intervalMs !== null &&
    nextDueAtMs !== null &&
    nowMs > nextDueAtMs + intervalMs;
  const stuckByAge =
    status === "running" &&
    intervalMs !== null &&
    runningAgeMs !== null &&
    runningAgeMs > intervalMs * 2;

  if (status === "disabled") {
    return {
      lastRunAt: finishedAtMs !== null ? new Date(finishedAtMs) : null,
      durationMs,
      warning: null,
      state: "disabled",
    };
  }

  if (status === "failed") {
    return {
      lastRunAt: finishedAtMs !== null ? new Date(finishedAtMs) : startedAtMs !== null ? new Date(startedAtMs) : null,
      durationMs,
      warning: null,
      state: "failed",
    };
  }

  if (status === "running") {
    return {
      lastRunAt: startedAtMs !== null ? new Date(startedAtMs) : null,
      durationMs,
      warning: stuckByAge ? "stuck/overdue" : overdueByNextDue ? "overdue" : null,
      state: stuckByAge || overdueByNextDue ? "overdue" : "running",
    };
  }

  if (status === "skipped") {
    return {
      lastRunAt: finishedAtMs !== null ? new Date(finishedAtMs) : startedAtMs !== null ? new Date(startedAtMs) : null,
      durationMs,
      warning: overdueByNextDue ? "overdue" : null,
      state: overdueByNextDue ? "overdue" : "skipped",
    };
  }

  if (overdueByNextDue) {
    return {
      lastRunAt: finishedAtMs !== null ? new Date(finishedAtMs) : startedAtMs !== null ? new Date(startedAtMs) : null,
      durationMs,
      warning: "overdue",
      state: "overdue",
    };
  }

  return {
    lastRunAt: finishedAtMs !== null ? new Date(finishedAtMs) : startedAtMs !== null ? new Date(startedAtMs) : null,
    durationMs,
    warning: null,
    state: "idle",
  };
}

export function buildBotPollStatusEmbeds(
  statuses: BotPollJobStatusRecord[],
  now: Date = new Date(),
): EmbedBuilder[] {
  if (statuses.length === 0) {
    return [
      new EmbedBuilder()
        .setTitle("Bot poll status")
        .setDescription(
          "No poll jobs have reported yet. The rows appear after the activity observe and autorole scheduler loops start.",
        ),
    ];
  }

  const embeds: EmbedBuilder[] = [];
  for (let index = 0; index < statuses.length; index += BOT_POLL_STATUS_HELPER_LIMITS.fieldsPerEmbed) {
    const chunk = statuses.slice(index, index + BOT_POLL_STATUS_HELPER_LIMITS.fieldsPerEmbed);
    const embed = new EmbedBuilder()
      .setTitle("Bot poll status")
      .setDescription("Read-only status for background poll jobs.");

    for (const job of chunk) {
      const timing = resolveJobTimes(job, now.getTime());
      const note = readStatusNote(job);
      const lines = [
        `Status: ${BOT_POLL_STATUS_EMOJI[timing.state]} ${timing.state}`,
        `Interval: ${formatIntervalLabel(job.intervalMs)}`,
        `Last run: ${toUnixTimestampLabel(timing.lastRunAt)}`,
        `Next run: ${toUnixTimestampLabel(job.nextDueAt)}`,
        `Duration: ${formatDurationLabel(timing.durationMs)}`,
      ];
      if (timing.warning) {
        lines.push(`Warning: ${timing.warning}`);
      }
      if (job.status === "failed" && job.lastError) {
        lines.push(`Last error: ${formatShortError(job.lastError)}`);
      }
      if (note) {
        lines.push(`Note: ${note}`);
      }

      embed.addFields({
        name: `${BOT_POLL_STATUS_EMOJI[timing.state]} ${job.displayName}`,
        value: lines.join("\n"),
        inline: false,
      });
    }

    embeds.push(embed);
  }

  return embeds;
}

async function runBotPollStatus(
  interaction: ChatInputCommandInteraction,
  statusService: BotPollJobStatusService = botPollJobStatusService,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }

  if (!hasAdministratorPermission(interaction)) {
    await interaction.reply({
      ephemeral: true,
      content: "You do not have permission to use /bot.",
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const statuses = await statusService.listStatuses();
  const embeds = buildBotPollStatusEmbeds(statuses, new Date());
  await interaction.editReply({ embeds });
}

export const Bot: Command = {
  name: "bot",
  description: "Read-only poll job status dashboard",
  options: [
    {
      name: "poll",
      description: "Inspect background poll job status",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "status",
          description: "Show background poll job status rows",
          type: ApplicationCommandOptionType.Subcommand,
        },
      ],
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction, _cocService: CoCService) => {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(true);
    if (group !== "poll" || sub !== "status") {
      await interaction.reply({
        ephemeral: true,
        content: "Unsupported /bot subcommand.",
      });
      return;
    }
    await runBotPollStatus(interaction);
  },
};
