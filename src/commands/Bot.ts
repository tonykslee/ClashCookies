import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  version as discordJsVersion,
} from "discord.js";
import { Command } from "../Command";
import { truncateDiscordContent } from "../helper/discordContent";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { resolvePollingMode, resolveRuntimeEnvironment } from "../services/PollingModeService";
import {
  botPollJobStatusService,
  type BotPollJobStatusRecord,
  type BotPollJobStatusService,
} from "../services/BotPollJobStatusService";
import { formatError } from "../helper/formatError";

const BOT_STATUS_EMOJI = {
  healthy: "🟢",
  warning: "🟡",
  unhealthy: "🔴",
} as const;

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
} as const;

const BOT_STATUS_HELPER_LIMITS = {
  warningJobs: 5,
  errorChars: 180,
} as const;

type MetadataObject = Record<string, unknown>;

type BotStatusHealthSnapshot = {
  dbHealthy: boolean;
  discordHealthy: boolean;
  dbError: string | null;
  pollRowsError: string | null;
  runtimeEnvironment: string;
  pollingMode: string;
  discordVersion: string;
};

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

function formatProcessUptimeLabel(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainderSeconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length > 0) parts.push(`${minutes}m`);
  parts.push(`${remainderSeconds}s`);
  return parts.join(" ");
}

function formatShortError(value: string | null | undefined, maxChars: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "—";
  return truncateDiscordContent(normalized, maxChars);
}

function readStatusNote(job: BotPollJobStatusRecord): string | null {
  if (!isMetadataObject(job.metadata)) return null;
  const trigger = typeof job.metadata.trigger === "string" ? job.metadata.trigger.trim() : "";
  if (trigger) return `trigger=${trigger}`;
  const reason = typeof job.metadata.reason === "string" ? job.metadata.reason.trim() : "";
  if (reason) return `reason=${reason}`;
  return null;
}

function safeJsonPreview(
  value: unknown,
  maxChars = 900,
  stringLimit = 120,
): string {
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === "string") {
          return current.length <= stringLimit
            ? current
            : `${current.slice(0, stringLimit)}...[len=${current.length}]`;
        }
        if (
          typeof current === "number" ||
          typeof current === "boolean" ||
          current === null
        ) {
          return current;
        }
        if (typeof current === "bigint") {
          return current.toString();
        }
        if (typeof current === "undefined") {
          return "[undefined]";
        }
        if (current instanceof Error) {
          return {
            name: current.name,
            message: current.message,
          };
        }
        if (typeof current === "object" && current !== null) {
          if (seen.has(current as object)) return "[Circular]";
          seen.add(current as object);
        }
        return current;
      },
      2,
    );
    if (!text) return "null";
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...[len=${text.length}]`;
  } catch {
    return truncateDiscordContent(String(value ?? ""), maxChars);
  }
}

function formatMetadataField(value: unknown): string {
  if (!isMetadataObject(value)) return "—";
  return `\`\`\`json\n${safeJsonPreview(value, 900, 120)}\n\`\`\``;
}

function buildBotPollJobDetailEmbed(
  job: BotPollJobStatusRecord,
  now: Date = new Date(),
): EmbedBuilder {
  const timing = resolveJobTimes(job, now.getTime());
  const statusLines = [
    `Status: ${BOT_POLL_STATUS_EMOJI[timing.state]} ${timing.state}`,
    `Enabled: ${job.enabled ? "yes" : "no"}`,
  ];
  if (timing.warning) {
    statusLines.push(`Warning: ${timing.warning}`);
  }

  const scheduleLines = [
    `Interval: ${formatIntervalLabel(job.intervalMs)}`,
    `Last started: ${toUnixTimestampLabel(job.lastStartedAt)}`,
    `Last finished: ${toUnixTimestampLabel(job.lastFinishedAt)}`,
    `Last success: ${toUnixTimestampLabel(job.lastSuccessAt)}`,
    `Next due: ${toUnixTimestampLabel(job.nextDueAt)}`,
    `Duration: ${formatDurationLabel(timing.durationMs)}`,
  ];

  const countsLines = [
    `Run count: ${job.runCount}`,
    `Failure count: ${job.failureCount}`,
  ];

  const fields = [
    { name: "Status", value: statusLines.join("\n"), inline: false },
    { name: "Schedule", value: scheduleLines.join("\n"), inline: false },
    { name: "Counts", value: countsLines.join("\n"), inline: false },
    { name: "Metadata", value: formatMetadataField(job.metadata), inline: false },
  ];
  if (job.lastError) {
    fields.push({
      name: "Last error",
      value: formatShortError(job.lastError, 900),
      inline: false,
    });
  }

  return new EmbedBuilder()
    .setTitle(`Bot poll job: ${job.displayName}`)
    .setFooter({ text: `job_key=${job.jobKey}` })
    .addFields(fields);
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
    intervalMs !== null && nextDueAtMs !== null && nowMs > nextDueAtMs + intervalMs;
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
      lastRunAt:
        finishedAtMs !== null
          ? new Date(finishedAtMs)
          : startedAtMs !== null
            ? new Date(startedAtMs)
            : null,
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
      lastRunAt:
        finishedAtMs !== null
          ? new Date(finishedAtMs)
          : startedAtMs !== null
            ? new Date(startedAtMs)
            : null,
      durationMs,
      warning: overdueByNextDue ? "overdue" : null,
      state: overdueByNextDue ? "overdue" : "skipped",
    };
  }

  if (overdueByNextDue) {
    return {
      lastRunAt:
        finishedAtMs !== null
          ? new Date(finishedAtMs)
          : startedAtMs !== null
            ? new Date(startedAtMs)
            : null,
      durationMs,
      warning: "overdue",
      state: "overdue",
    };
  }

  return {
    lastRunAt:
      finishedAtMs !== null
        ? new Date(finishedAtMs)
        : startedAtMs !== null
          ? new Date(startedAtMs)
          : null,
    durationMs,
    warning: null,
    state: "idle",
  };
}

function collectProblematicJobs(
  statuses: BotPollJobStatusRecord[],
  now: Date,
): Array<{
  job: BotPollJobStatusRecord;
  timing: ReturnType<typeof resolveJobTimes>;
  note: string | null;
}> {
  const rows = statuses
    .map((job) => ({
      job,
      timing: resolveJobTimes(job, now.getTime()),
      note: readStatusNote(job),
    }))
    .filter(({ job, timing }) => job.status === "failed" || timing.warning !== null);

  const severityScore = (entry: (typeof rows)[number]): number => {
    if (entry.job.status === "failed") return 0;
    if (entry.timing.warning === "stuck/overdue") return 1;
    return 2;
  };

  return rows.sort((left, right) => severityScore(left) - severityScore(right));
}

function summarizePollJobCounts(statuses: BotPollJobStatusRecord[], now: Date): {
  total: number;
  failed: number;
  running: number;
  overdueOrStuck: number;
  disabledOrSkipped: number;
} {
  let failed = 0;
  let running = 0;
  let overdueOrStuck = 0;
  let disabledOrSkipped = 0;
  for (const job of statuses) {
    const timing = resolveJobTimes(job, now.getTime());
    if (job.status === "failed") failed += 1;
    if (job.status === "running") running += 1;
    if (job.status === "disabled" || job.status === "skipped") disabledOrSkipped += 1;
    if (timing.warning !== null) overdueOrStuck += 1;
  }
  return {
    total: statuses.length,
    failed,
    running,
    overdueOrStuck,
    disabledOrSkipped,
  };
}

function resolveOverallStatus(
  input: BotStatusHealthSnapshot,
  summary: { failed: number; overdueOrStuck: number },
): keyof typeof BOT_STATUS_EMOJI {
  if (!input.dbHealthy || !input.discordHealthy) return "unhealthy";
  if (summary.failed > 0) return "unhealthy";
  if (summary.overdueOrStuck > 0 || input.dbError !== null || input.pollRowsError !== null) return "warning";
  return "healthy";
}

export function buildBotStatusEmbeds(
  statuses: BotPollJobStatusRecord[],
  health: BotStatusHealthSnapshot,
  now: Date = new Date(),
): EmbedBuilder[] {
  const counts = summarizePollJobCounts(statuses, now);
  const warnings = collectProblematicJobs(statuses, now);
  const overall = resolveOverallStatus(health, counts);

  const runtimeLines = [
    `Uptime: ${formatProcessUptimeLabel(process.uptime())}`,
    `Runtime environment: ${health.runtimeEnvironment}`,
    `Polling mode: ${health.pollingMode}`,
    `Discord.js: ${health.discordVersion}`,
  ];

  const healthLines = [
    `Database: ${health.dbHealthy ? "🟢 reachable" : "🔴 unreachable"}`,
    `Discord: ${health.discordHealthy ? "🟢 ready" : "🔴 not ready"}`,
  ];
  if (health.dbError) {
    healthLines.push(`Database error: ${formatShortError(health.dbError, BOT_STATUS_HELPER_LIMITS.errorChars)}`);
  }
  if (health.pollRowsError) {
    healthLines.push(`Poll job rows: ${formatShortError(health.pollRowsError, BOT_STATUS_HELPER_LIMITS.errorChars)}`);
  }

  const summaryLines = [
    `Total known jobs: ${counts.total}`,
    `Failed: ${counts.failed}`,
    `Running: ${counts.running}`,
    `Overdue/stuck: ${counts.overdueOrStuck}`,
    `Disabled/skipped: ${counts.disabledOrSkipped}`,
  ];

  const warningLines = warnings.slice(0, BOT_STATUS_HELPER_LIMITS.warningJobs).map(({ job, timing, note }) => {
    const parts = [`${BOT_POLL_STATUS_EMOJI[timing.state]} ${job.displayName}`];
    const statusText =
      job.status === "failed" ? "failed" : timing.warning ?? timing.state;
    parts.push(statusText);
    if (job.status === "failed" && job.lastError) {
      parts.push(`last error: ${formatShortError(job.lastError, BOT_STATUS_HELPER_LIMITS.errorChars)}`);
    }
    if (note) {
      parts.push(note);
    }
    return parts.join(" — ");
  });

  const warningValue =
    health.pollRowsError && warnings.length === 0
      ? `Poll job rows unavailable: ${formatShortError(health.pollRowsError, BOT_STATUS_HELPER_LIMITS.errorChars)}`
      : warningLines.length > 0
        ? warningLines.join("\n")
        : "No poll job warnings";

  return [
    new EmbedBuilder()
      .setTitle("Bot status")
      .setDescription(`Overall: ${BOT_STATUS_EMOJI[overall]} ${overall}`)
      .addFields(
        { name: "Runtime", value: runtimeLines.join("\n"), inline: false },
        { name: "Health", value: healthLines.join("\n"), inline: false },
        { name: "Poll jobs summary", value: summaryLines.join("\n"), inline: false },
        { name: "Warnings", value: warningValue, inline: false },
      ),
  ];
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
        lines.push(`Last error: ${formatShortError(job.lastError, BOT_POLL_STATUS_HELPER_LIMITS.lastErrorChars)}`);
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

async function runBotStatus(
  client: Client,
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
  const [dbResult, pollRowsResult] = await Promise.allSettled([
    prisma.$queryRawUnsafe("select 1"),
    statusService.listStatuses(),
  ]);

  const dbHealthy = dbResult.status === "fulfilled";
  const discordHealthy =
    typeof client.isReady === "function" ? client.isReady() : Boolean(client.readyAt);

  const statuses = pollRowsResult.status === "fulfilled" ? pollRowsResult.value : [];
  const health: BotStatusHealthSnapshot = {
    dbHealthy,
    discordHealthy,
    dbError: dbResult.status === "rejected" ? formatError(dbResult.reason) : null,
    pollRowsError:
      pollRowsResult.status === "rejected"
        ? formatError(pollRowsResult.reason)
        : null,
    runtimeEnvironment: resolveRuntimeEnvironment(process.env),
    pollingMode: resolvePollingMode(process.env),
    discordVersion: discordJsVersion,
  };

  const embeds = buildBotStatusEmbeds(statuses, health, new Date());
  await interaction.editReply({ embeds });
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
  const jobKey = String(interaction.options.getString("job", false) ?? "").trim();
  if (jobKey) {
    const job = await statusService.getStatus(jobKey);
    if (!job) {
      await interaction.editReply({
        content: `No poll job found for \`${jobKey}\`.`,
      });
      return;
    }

    await interaction.editReply({
      embeds: [buildBotPollJobDetailEmbed(job, new Date())],
    });
    return;
  }

  const statuses = await statusService.listStatuses();
  const embeds = buildBotPollStatusEmbeds(statuses, new Date());
  await interaction.editReply({ embeds });
}

export const Bot: Command = {
  name: "bot",
  description: "Read-only bot health and poll status dashboard",
  options: [
    {
      name: "status",
      description: "Show the concise bot status overview",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "poll",
      description: "Inspect background poll job status",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "status",
          description: "Show background poll job status rows",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "job",
              description: "Show one poll job in detail",
              type: ApplicationCommandOptionType.String,
              required: false,
              autocomplete: true,
            },
          ],
        },
      ],
    },
  ],
  run: async (client: Client, interaction: ChatInputCommandInteraction, _cocService: CoCService) => {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(true);
    if (group === null && sub === "status") {
      await runBotStatus(client, interaction);
      return;
    }
    if (group === "poll" && sub === "status") {
      await runBotPollStatus(interaction);
      return;
    }

    await interaction.reply({
      ephemeral: true,
      content: "Unsupported /bot subcommand.",
    });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);
    const focused = interaction.options.getFocused(true);
    if (group !== "poll" || sub !== "status" || focused.name !== "job") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    let statuses: BotPollJobStatusRecord[];
    try {
      statuses = await botPollJobStatusService.listStatuses();
    } catch (error) {
      console.warn(
        `[bot poll status autocomplete] failed to load status rows: ${formatError(error)}`,
      );
      await interaction.respond([]);
      return;
    }
    const choices = statuses
      .map((job) => {
        const label = `${job.displayName} (${job.jobKey})`;
        return {
          name: label.slice(0, 100),
          value: job.jobKey,
        };
      })
      .filter((choice) => {
        const name = choice.name.toLowerCase();
        const value = choice.value.toLowerCase();
        return !query || name.includes(query) || value.includes(query);
      })
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
