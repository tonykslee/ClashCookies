import {
  ApplicationCommandOptionType,
  Client,
  PermissionFlagsBits,
  version as discordJsVersion,
} from "discord.js";
import { Prisma } from "@prisma/client";
import { Commands } from "../Commands";
import { CoCService } from "../services/CoCService";
import { ActivityService } from "../services/ActivityService";
import { formatError } from "../helper/formatError";
import { runFetchTelemetryBatch } from "../helper/fetchTelemetry";
import { prisma } from "../prisma";
import { trackedMessageService } from "../services/TrackedMessageService";
import { processRecruitmentCooldownReminders } from "../services/RecruitmentService";
import { processDueRecruitmentReminders } from "../services/RecruitmentReminderService";
import { processWeightInputDefermentStages } from "../services/WeightInputDefermentService";
import { SettingsService } from "../services/SettingsService";
import { WarEventLogService } from "../services/WarEventLogService";
import { TelemetryIngestService } from "../services/telemetry/ingest";
import { startTelemetryScheduleLoop } from "../services/telemetry/schedule";
import { refreshAllTrackedWarMailPosts } from "../commands/Fwa";
import { backfillMissingDiscordUsernamesForClanMembers } from "../services/PlayerLinkService";
import { HeatMapRefRebuildService } from "../services/HeatMapRefRebuildService";
import { AutoRoleSchedulerService } from "../services/AutoRoleSchedulerService";
import { startActivityObserveLoop } from "../services/ActivityObserveStartupService";
import {
  buildCommandRegistrationDebugSummary,
  formatStartupLogFields,
  getCommandRegistrationConfigFromEnv,
  getStartupErrorDiagnostics,
  getStartupBootstrapRetryConfigFromEnv,
  getStartupRetryLogSummaryEveryFromEnv,
  isTransientRegistrationError,
  registerGuildCommandsWithRetry,
  runWithTransientRetry,
  shouldEmitStartupRetrySummary,
} from "../services/StartupCommandRegistrationService";
import {
  setNextNotifyRefreshAtMs,
  setNextWarMailRefreshAtMs,
} from "../services/refreshSchedule";
import { FwaFeedSchedulerService } from "../services/fwa-feeds/FwaFeedSchedulerService";
import { todoSnapshotService } from "../services/TodoSnapshotService";
import { cwlStateService } from "../services/CwlStateService";
import { ReminderSchedulerService } from "../services/reminders/ReminderSchedulerService";
import { UserActivityReminderSchedulerService } from "../services/remindme/UserActivityReminderSchedulerService";
import {
  botPollJobStatusService,
  type BotPollJobStatusService,
} from "../services/BotPollJobStatusService";
import { botStartupStatusService } from "../services/BotStartupStatusService";
import {
  cocRequestQueueService,
  isCoCQueueSkippedError,
} from "../services/CoCRequestQueueService";
import { PollCycleGuardService } from "../services/PollCycleGuardService";
import { unlinkedMemberAlertService } from "../services/UnlinkedMemberAlertService";
import { runWithCoCQueueContext } from "../services/CoCQueueContext";
import { dozzleLog } from "../helper/dozzleLogger";
import {
  isActivePollingMode,
  resolveMirrorSyncIntervalMsFromEnv,
  resolveRuntimeEnvironment,
  resolvePollingMode,
} from "../services/PollingModeService";
import {
  resolveWarEventPollIntervalMsFromEnv,
} from "../services/WarEventPollScheduleService";
import { MirrorSyncService } from "../services/MirrorSyncService";
const DEFAULT_OBSERVE_INTERVAL_MINUTES = 30;
const RECRUITMENT_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const RECRUITMENT_RULE_REMINDER_INTERVAL_MS = 60 * 1000;
const DEFERMENT_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const TRACKED_MESSAGE_SWEEP_INTERVAL_MS = 60 * 1000;
const OBSERVE_LAST_RUN_AT_KEY = "activity_observe:last_run_at_ms";
const MIRROR_SYNC_POLL_GUARD_KEY = "mirror_snapshot_sync_cycle";
const BOT_POLL_STATUS_JOB_KEYS = {
  recruitmentCooldownReminders: "recruitment_cooldown_reminders",
  recruitmentRuleReminders: "recruitment_rule_reminders",
  defermentReminders: "deferment_reminders",
  trackedMessageSweep: "tracked_message_sweep",
  heatmaprefRebuildCycle: "heatmapref_rebuild_cycle",
  warEventPollCycle: "war_event_poll_cycle",
  fwaFeedScheduler: "fwa_feed_scheduler",
  mirrorSyncCycle: "mirror_sync_cycle",
  userActivityReminderScheduler: "user_activity_reminder_scheduler",
} as const;
const BOT_POLL_STATUS_DISPLAY_NAMES = {
  recruitmentCooldownReminders: "Recruitment cooldown reminders",
  recruitmentRuleReminders: "Recruitment rule reminders",
  defermentReminders: "Deferment reminders",
  trackedMessageSweep: "Tracked message sweep",
  heatmaprefRebuildCycle: "Heatmapref rebuild",
  warEventPollCycle: "War event poll",
  fwaFeedScheduler: "FWA feed scheduler",
  mirrorSyncCycle: "Mirror sync",
  userActivityReminderScheduler: "User activity reminder scheduler",
} as const;
const VISIBILITY_OPTION = {
  name: "visibility",
  description: "Response visibility",
  type: ApplicationCommandOptionType.String,
  required: false,
  choices: [
    { name: "private", value: "private" },
    { name: "public", value: "public" },
  ],
};

function createVisibilityOption(): typeof VISIBILITY_OPTION {
  return {
    ...VISIBILITY_OPTION,
    choices: VISIBILITY_OPTION.choices.map((choice) => ({ ...choice })),
  };
}

function hasVisibilityOption(options: any[] | undefined): boolean {
  if (!options) return false;
  return options.some((opt) => opt?.name === "visibility");
}

function sanitizeOption(option: any): any {
  if (!option || typeof option !== "object") return option;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(option)) {
    if (value === undefined) continue;
    if (key === "options" && Array.isArray(value)) {
      out.options = value.map((entry) => sanitizeOption(entry));
      continue;
    }
    if (key === "choices" && Array.isArray(value)) {
      out.choices = value.map((choice) => ({ ...choice }));
      continue;
    }
    out[key] = value;
  }
  return out;
}

async function safePollJobStatusWrite(
  jobKey: string,
  stage: "started" | "succeeded" | "failed" | "skipped" | "disabled",
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.warn(
      `[poll-status] status_update_failed job_key=${jobKey} stage=${stage} error=${formatError(err)}`,
    );
  }
}

async function safeStartupStatusWrite(
  stage: "phase" | "complete" | "failed",
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.warn(
      `[startup-status] update_failed stage=${stage} error=${formatError(err)}`,
    );
  }
}

async function markStartupPhase(
  phase: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await safeStartupStatusWrite("phase", () =>
    Promise.resolve(botStartupStatusService.markPhase(phase, metadata)),
  );
}

async function markStartupComplete(
  metadata?: Record<string, unknown>,
): Promise<void> {
  await safeStartupStatusWrite("complete", () =>
    Promise.resolve(botStartupStatusService.markComplete(metadata)),
  );
}

async function markStartupFailed(
  error: unknown,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await safeStartupStatusWrite("failed", () =>
    Promise.resolve(botStartupStatusService.markFailed(error, metadata)),
  );
}

function pollJobInput(input: {
  displayName: string;
  intervalMs?: number | null;
  nextDueAt?: Date | null;
  metadata?: Prisma.InputJsonValue | null;
}) {
  return {
    displayName: input.displayName,
    intervalMs: input.intervalMs ?? null,
    nextDueAt: input.nextDueAt ?? null,
    metadata: input.metadata ?? null,
  };
}

async function markPollJobStarted(input: {
  jobKey: string;
  displayName: string;
  intervalMs?: number | null;
  nextDueAt?: Date | null;
  metadata?: Prisma.InputJsonValue | null;
  statusService?: BotPollJobStatusService;
}): Promise<void> {
  const statusService = input.statusService ?? botPollJobStatusService;
  await safePollJobStatusWrite(input.jobKey, "started", () =>
    statusService.markStarted(input.jobKey, pollJobInput({
      displayName: input.displayName,
      intervalMs: input.intervalMs ?? null,
      nextDueAt: input.nextDueAt ?? null,
      metadata: input.metadata ?? null,
    })),
  );
}

async function markPollJobSucceeded(input: {
  jobKey: string;
  displayName: string;
  intervalMs?: number | null;
  nextDueAt?: Date | null;
  metadata?: Prisma.InputJsonValue | null;
  statusService?: BotPollJobStatusService;
}): Promise<void> {
  const statusService = input.statusService ?? botPollJobStatusService;
  await safePollJobStatusWrite(input.jobKey, "succeeded", () =>
    statusService.markSucceeded(input.jobKey, pollJobInput({
      displayName: input.displayName,
      intervalMs: input.intervalMs ?? null,
      nextDueAt: input.nextDueAt ?? null,
      metadata: input.metadata ?? null,
    })),
  );
}

async function markPollJobFailed(input: {
  jobKey: string;
  displayName: string;
  error: unknown;
  intervalMs?: number | null;
  nextDueAt?: Date | null;
  metadata?: Prisma.InputJsonValue | null;
  statusService?: BotPollJobStatusService;
}): Promise<void> {
  const statusService = input.statusService ?? botPollJobStatusService;
  await safePollJobStatusWrite(input.jobKey, "failed", () =>
    statusService.markFailed(
      input.jobKey,
      input.error,
      pollJobInput({
        displayName: input.displayName,
        intervalMs: input.intervalMs ?? null,
        nextDueAt: input.nextDueAt ?? null,
        metadata: input.metadata ?? null,
      }),
    ),
  );
}

async function markPollJobSkipped(input: {
  jobKey: string;
  displayName: string;
  intervalMs?: number | null;
  nextDueAt?: Date | null;
  metadata?: Prisma.InputJsonValue | null;
  statusService?: BotPollJobStatusService;
}): Promise<void> {
  const statusService = input.statusService ?? botPollJobStatusService;
  await safePollJobStatusWrite(input.jobKey, "skipped", () =>
    statusService.markSkipped(input.jobKey, pollJobInput({
      displayName: input.displayName,
      intervalMs: input.intervalMs ?? null,
      nextDueAt: input.nextDueAt ?? null,
      metadata: input.metadata ?? null,
    })),
  );
}

async function markPollJobDisabled(input: {
  jobKey: string;
  displayName: string;
  intervalMs?: number | null;
  metadata?: Prisma.InputJsonValue | null;
  statusService?: BotPollJobStatusService;
}): Promise<void> {
  const statusService = input.statusService ?? botPollJobStatusService;
  await safePollJobStatusWrite(input.jobKey, "disabled", () =>
    statusService.markDisabled(input.jobKey, pollJobInput({
      displayName: input.displayName,
      intervalMs: input.intervalMs ?? null,
      metadata: input.metadata ?? null,
    })),
  );
}

function withVisibilityOnSubcommand(sub: any): any {
  const cleanSub = sanitizeOption(sub);
  const options = Array.isArray(cleanSub.options) ? [...cleanSub.options] : [];
  if (!hasVisibilityOption(options)) {
    options.push(createVisibilityOption());
  }
  return { ...cleanSub, options };
}

function toRegistrationCommand(command: any): any {
  const out: Record<string, unknown> = {};
  const allowedKeys = new Set([
    "name",
    "name_localizations",
    "description",
    "description_localizations",
    "options",
    "default_member_permissions",
    "dm_permission",
    "nsfw",
    "type",
  ]);
  for (const [key, value] of Object.entries(command ?? {})) {
    if (!allowedKeys.has(key)) continue;
    if (value === undefined) continue;
    if (key === "options" && Array.isArray(value)) {
      out.options = value.map((entry) => sanitizeOption(entry));
      continue;
    }
    out[key] = value;
  }
  return out;
}

function injectVisibilityOptions(command: any): any {
  const registration = toRegistrationCommand(command);
  const options = Array.isArray(registration.options) ? [...registration.options] : [];
  if (options.length === 0) {
    return { ...registration, options: [createVisibilityOption()] };
  }

  const hasSubcommands = options.some(
    (opt) =>
      opt?.type === ApplicationCommandOptionType.Subcommand ||
      opt?.type === ApplicationCommandOptionType.SubcommandGroup
  );

  if (!hasSubcommands) {
    if (!hasVisibilityOption(options)) {
      options.push(createVisibilityOption());
    }
    return { ...registration, options };
  }

  const nextOptions = options.map((opt) => {
    if (opt?.type === ApplicationCommandOptionType.Subcommand) {
      return withVisibilityOnSubcommand(opt);
    }
    if (opt?.type === ApplicationCommandOptionType.SubcommandGroup) {
      const subOptions = Array.isArray(opt.options) ? opt.options : [];
      return {
        ...opt,
        options: subOptions.map((sub: any) =>
          sub?.type === ApplicationCommandOptionType.Subcommand
            ? withVisibilityOnSubcommand(sub)
            : sub
        ),
      };
    }
    return opt;
  });

  return { ...registration, options: nextOptions };
}

export default (client: Client, cocService: CoCService): void => {
  client.once("ready", async () => {
    let startupPhase = "ready_start";
    await markStartupPhase(startupPhase);
    try {
      if (!client.application) {
        throw new Error("client.application is unavailable during ready startup");
      }

      dozzleLog.info("ClashCookies is starting...");
      let applicationFetchAttempted = false;
      let applicationFetchSucceeded = false;
      if (client.application) {
        applicationFetchAttempted = true;
        try {
          await client.application.fetch();
          applicationFetchSucceeded = true;
        } catch {
          applicationFetchSucceeded = false;
        }
      }
      const hasApplicationEmojiFetch = Boolean(
        client.application &&
          client.application.emojis &&
          typeof client.application.emojis.fetch === "function"
      );
      dozzleLog.debug(
        `[startup:discord] discord_js_version=${discordJsVersion} application_present=${Boolean(client.application)} application_fetch_attempted=${applicationFetchAttempted} application_fetch_succeeded=${applicationFetchSucceeded} application_emoji_fetch_available=${hasApplicationEmojiFetch}`
      );

    const bootstrapConfig = getStartupBootstrapRetryConfigFromEnv(process.env);
    const summaryEvery = getStartupRetryLogSummaryEveryFromEnv(process.env);
    const startupBootstrapStartMs = Date.now();
    const guildIdRaw = String(process.env.GUILD_ID ?? "").trim();
    const guildIdPresent = guildIdRaw.length > 0;
    let firstFailureMs: number | null = null;
    let totalFailures = 0;
    let bootstrapStage = "guild_fetch";
    dozzleLog.info(
      `[startup:bootstrap] start ${formatStartupLogFields({
        base_backoff_ms: bootstrapConfig.baseBackoffMs,
        guild_id_present: guildIdPresent,
        max_backoff_ms: bootstrapConfig.maxBackoffMs,
        retry_summary_every: summaryEvery,
      })}`
    );
    const bootstrap = await runWithTransientRetry({
      execute: async () => {
        if (!guildIdRaw) {
          throw new Error("MISSING_GUILD_ID");
        }
        bootstrapStage = "guild_fetch";
        const guild = await client.guilds.fetch(guildIdRaw);
        bootstrapStage = "member_fetch";
        const me = await guild.members.fetch(client.user!.id);
        bootstrapStage = "complete";
        return { guildId: guildIdRaw, guild, me };
      },
      config: bootstrapConfig,
      isTransientError: isTransientRegistrationError,
      onFailure: (context) => {
        totalFailures += 1;
        const now = Date.now();
        if (firstFailureMs === null) firstFailureMs = now;
        const diagnostics = getStartupErrorDiagnostics(context.error);
        const baseLog = formatStartupLogFields({
          attempt: context.attempt,
          backoff_ms: context.backoffMs ?? 0,
          client_user_present: Boolean(client.user),
          elapsed_ms: now - startupBootstrapStartMs,
          error_code: diagnostics.code,
          error_name: diagnostics.name,
          error_message: diagnostics.message,
          error_cause_code: diagnostics.causeCode,
          error_cause_name: diagnostics.causeName,
          error_cause_message: diagnostics.causeMessage,
          error_status: diagnostics.status,
          error_http_status: diagnostics.httpStatus,
          error_transient_reason: diagnostics.transientReason,
          error_stack_head: diagnostics.stackHead,
          guild_id_present: guildIdPresent,
          next_attempt: context.willRetry ? context.attempt + 1 : 0,
          stage: bootstrapStage,
          total_failures: totalFailures,
          transient: context.transient,
        });
        if (context.willRetry && context.backoffMs !== null) {
          dozzleLog.warn(`[startup:bootstrap] retry ${baseLog}`);
          if (shouldEmitStartupRetrySummary(totalFailures, summaryEvery)) {
            dozzleLog.warn(
              `[startup:bootstrap] retry_summary ${formatStartupLogFields({
                every: summaryEvery,
                first_failure_ms_ago: firstFailureMs === null ? 0 : now - firstFailureMs,
                last_error_code: diagnostics.code,
                last_error_name: diagnostics.name,
                last_error_reason: diagnostics.transientReason,
                retries: totalFailures,
                since_start_ms: now - startupBootstrapStartMs,
                stage: bootstrapStage,
              })}`
            );
          }
          return;
        }

        dozzleLog.fatal(`[startup:bootstrap] fatal_non_transient ${baseLog}`);
      },
    });
    if (bootstrap.status !== "success") {
      process.exit(1);
      return;
    }

    dozzleLog.info(
      `[startup:bootstrap] success ${formatStartupLogFields({
        attempts: bootstrap.attempts,
        elapsed_ms: Date.now() - startupBootstrapStartMs,
        guild_id_present: guildIdPresent,
        stage: bootstrapStage,
        total_failures: totalFailures,
      })}`
    );
    const { guildId, guild, me } = bootstrap.value;
    const guildPerms = me.permissions;
    const maybePinMessagesBit = (PermissionFlagsBits as Record<string, bigint>).PinMessages;
    const requiredGuildPerms: Array<[bigint, string]> = [
      [PermissionFlagsBits.ViewChannel, "View Channels"],
      [PermissionFlagsBits.SendMessages, "Send Messages"],
      [PermissionFlagsBits.EmbedLinks, "Embed Links"],
      [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
      [PermissionFlagsBits.AddReactions, "Add Reactions (for sync-time clan badge reactions)"],
      [PermissionFlagsBits.MentionEveryone, "Mention Everyone (for non-mentionable role pings)"],
    ];
    if (maybePinMessagesBit) {
      requiredGuildPerms.push([maybePinMessagesBit, "Pin Messages (for pin/unpin)"]);
    }
    const missingGuildPerms = requiredGuildPerms
      .filter(([bit]) => !guildPerms.has(bit))
      .map(([, label]) => label);
    if (missingGuildPerms.length > 0) {
    dozzleLog.warn(
      `Bot is missing recommended guild permissions: ${missingGuildPerms.join(", ")}.`
    );
      dozzleLog.warn(
        "Some commands may partially fail depending on channel overrides. Update role/channel permissions and redeploy."
      );
    }

    // Register ONLY guild commands
    const commandsWithVisibility = Commands.map((cmd) => injectVisibilityOptions(cmd));
    const registrationDebugSummary = buildCommandRegistrationDebugSummary(commandsWithVisibility);
    const runtimeEnvironment = resolveRuntimeEnvironment(process.env);
    dozzleLog.info(
      `[startup:commands] env=${runtimeEnvironment} bot_id=${client.user?.id ?? "unknown"} bot_username=${
        client.user?.username ?? "unknown"
      } guild_id=${guildId} scope=guild payload_count=${registrationDebugSummary.commandCount} roster_included=${
        registrationDebugSummary.rosterIncluded ? 1 : 0
      } roster_create_options=${
        registrationDebugSummary.rosterCreateOptionNames.length > 0
          ? registrationDebugSummary.rosterCreateOptionNames.join(",")
          : "none"
      } roster_edit_options=${
        registrationDebugSummary.rosterEditOptionNames.length > 0
          ? registrationDebugSummary.rosterEditOptionNames.join(",")
          : "none"
      }`
    );
    const registrationConfig = getCommandRegistrationConfigFromEnv(process.env);
    const registrationResult = await registerGuildCommandsWithRetry({
      guild,
      commands: commandsWithVisibility,
      config: registrationConfig,
      logger: console,
    });
    if (registrationResult.status === "success") {
      dozzleLog.info(`[startup:commands] registration complete count=${Commands.length}`);
    } else if (registrationResult.status === "skipped") {
      dozzleLog.warn(
        `[startup:commands] registration skipped by config. payload_count=${Commands.length}`
      );
    } else {
      console.error(
        "Command registration payload summary:",
        commandsWithVisibility.map((c: any) => ({
          name: c?.name,
          optionCount: Array.isArray(c?.options) ? c.options.length : 0,
        }))
      );
      dozzleLog.warn(
        `[startup:commands] registration unavailable after ${registrationResult.attempts} attempt(s); startup continuing.`
      );
    }

    dozzleLog.debug("[reminders] ready_start begin");
    const reminderScheduler = new ReminderSchedulerService(client);
    const reminderSchedulerStart = reminderScheduler.start();
    dozzleLog.info(
      reminderSchedulerStart.started
        ? "[reminders] ready_start complete started=true"
        : `[reminders] ready_start complete started=false reason=${reminderSchedulerStart.reason}`,
    );

    TelemetryIngestService.getInstance().startAutoFlush();
    startTelemetryScheduleLoop(client);
    dozzleLog.info("Telemetry ingest + schedule loops enabled.");

    const activityService = new ActivityService(cocService);
    const warEventLogService = new WarEventLogService(client, cocService);
    const settings = new SettingsService();
    const pollCycleGuard = new PollCycleGuardService();
    const pollingMode = resolvePollingMode(process.env);
    const activePollingEnabled = isActivePollingMode(process.env);
    const mirrorSyncService = new MirrorSyncService();
    const heatMapRefRebuildService = new HeatMapRefRebuildService();
    const warLookupCache: Map<string, Promise<unknown>> = new Map();
    dozzleLog.info(`[polling-mode] mode=${pollingMode}`);

    const observeTrackedClans = async (): Promise<{
      observedTags: string[];
      observedFwaClans: Array<{
        clanTag: string;
        clanName: string;
        logChannelId: string | null;
        members: Array<{ playerTag: string; playerName: string }>;
      }>;
    }> => {
      const dbTracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          tag: true,
          name: true,
          logChannelId: true,
        },
      });

      const trackedTags = dbTracked.map((c) => c.tag);

      if (trackedTags.length === 0) {
        console.warn(
          "No tracked clans configured. Use /clan configure."
        );
        return {
          observedTags: [],
          observedFwaClans: [],
        };
      }

      const observedMemberTags = new Set<string>();
      const observedFwaClans: Array<{
        clanTag: string;
        clanName: string;
        logChannelId: string | null;
        members: Array<{ playerTag: string; playerName: string }>;
      }> = [];
      for (const trackedClan of dbTracked) {
        try {
          const observedClan = await activityService.observeClanDetailed(
            guildId,
            trackedClan.tag
          );
          for (const memberTag of observedClan.memberTags) {
            observedMemberTags.add(memberTag);
          }
          observedFwaClans.push({
            clanTag: observedClan.clanTag,
            clanName: observedClan.clanName,
            logChannelId: trackedClan.logChannelId ?? null,
            members: observedClan.members,
          });
        } catch (err) {
          console.error(
            `observeClan failed for ${trackedClan.tag}: ${formatError(err)}`
          );
        }
      }

      return {
        observedTags: [...observedMemberTags],
        observedFwaClans,
      };
    };

    const markObserveRun = async () => {
      await settings.set(OBSERVE_LAST_RUN_AT_KEY, String(Date.now()));
    };

    const resolveDiscordUsernameForBackfill = async (
      discordUserId: string
    ): Promise<string | null> => {
      const cachedUsername = String(client.users.cache.get(discordUserId)?.username ?? "").trim();
      if (cachedUsername.length > 0) return cachedUsername;

      try {
        const user = await client.users.fetch(discordUserId);
        const fetchedUsername = String(user?.username ?? "").trim();
        return fetchedUsername.length > 0 ? fetchedUsername : null;
      } catch {
        return null;
      }
    };

    const runObservedCycle = async (scheduledAtMs: number = Date.now()) => {
      await runWithCoCQueueContext(
        {
          priority: "background",
          source: "activity_observe_cycle",
          scheduledAtMs,
          nextScheduledAtMs: scheduledAtMs + intervalMs,
        },
        async () => {
      await pollCycleGuard.run("activity_observe_cycle", async () => {
        const queueStatus = cocRequestQueueService.getStatus();
        if (queueStatus.degraded) {
          console.warn(
            `[poll-cycle] event=degraded_mode job=activity_observe_cycle spacing_ms=${queueStatus.spacingMs} penalty_ms=${queueStatus.penaltyMs} queue_depth=${queueStatus.queueDepth} interactive_depth=${queueStatus.interactiveQueueDepth} background_depth=${queueStatus.backgroundQueueDepth} in_flight=${queueStatus.inFlight}`,
          );
        }
        await runFetchTelemetryBatch("activity_observe_cycle", async () => {
          const observed = await observeTrackedClans();
          try {
            const backfill = await backfillMissingDiscordUsernamesForClanMembers({
              memberTagsInOrder: observed.observedTags,
              resolveDiscordUsername: resolveDiscordUsernameForBackfill,
            });
            if (backfill.candidateLinks > 0) {
              console.log(
                `[activity-observe] playerlink_discord_username_backfill candidates=${backfill.candidateLinks} unique_users=${backfill.uniqueUsers} resolved_users=${backfill.resolvedUsers} updated=${backfill.updatedLinks}`
              );
            }
          } catch (err) {
            console.error(
              `[activity-observe] playerlink_discord_username_backfill failed: ${formatError(err)}`
            );
          }
          try {
            const todoRefresh = await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots(
              {
                cadence: "observe",
                cocService,
                nowMs: scheduledAtMs,
                producerPacingMs: intervalMs,
              },
            );
            if (todoRefresh.selectedPlayerCount > 0) {
              console.log(
                `[todo-snapshot] event=observe_cycle_refresh activated_users=${todoRefresh.activatedUserCount} selected_players=${todoRefresh.selectedPlayerCount} tracked_players=${todoRefresh.trackedPlayerCount} non_tracked_players=${todoRefresh.nonTrackedPlayerCount} skipped_never_used_users=${todoRefresh.skippedNeverUsedUserCount}`,
              );
            }
          } catch (err) {
            console.error(
              `[todo-snapshot] event=observe_cycle_refresh_failed error=${formatError(err)}`,
            );
          }
          try {
            const result = await unlinkedMemberAlertService.reconcileGuildAlerts({
              client: client as any,
              guildId,
              cocService,
              observedFwaClans: observed.observedFwaClans,
            });
            if (result.unresolvedCount > 0 || result.resolvedCount > 0 || result.alertedCount > 0) {
              console.log(
                `[unlinked] reconcile_complete guild=${guildId} unresolved=${result.unresolvedCount} alerted=${result.alertedCount} resolved=${result.resolvedCount}`
              );
            }
          } catch (err) {
            if (isCoCQueueSkippedError(err)) {
              console.warn(`[unlinked] reconcile_skipped guild=${guildId} reason=${err.message}`);
              return;
            }
            console.error(`[unlinked] reconcile_failed guild=${guildId} error=${formatError(err)}`);
          }
          try {
            await markObserveRun();
          } catch (err) {
            console.error(`observe run timestamp write failed: ${formatError(err)}`);
          }
        });
      });
        },
      );
    };

    const getInitialObserveDelayMs = async (): Promise<number> => {
      const configuredIntervalMinutes = Number(
        process.env.ACTIVITY_OBSERVE_INTERVAL_MINUTES ?? DEFAULT_OBSERVE_INTERVAL_MINUTES
      );
      const intervalMinutes =
        Number.isFinite(configuredIntervalMinutes) && configuredIntervalMinutes > 0
          ? configuredIntervalMinutes
          : DEFAULT_OBSERVE_INTERVAL_MINUTES;
      const intervalMs = Math.floor(intervalMinutes * 60 * 1000);

      const rawLastRun = await settings.get(OBSERVE_LAST_RUN_AT_KEY);
      const lastRunAtMs = Number(rawLastRun ?? "");
      if (!Number.isFinite(lastRunAtMs) || lastRunAtMs <= 0) {
        return 0;
      }

      const elapsedMs = Date.now() - lastRunAtMs;
      if (elapsedMs >= intervalMs) {
        return 0;
      }

      return Math.max(0, intervalMs - elapsedMs);
    };

    const configuredIntervalMinutes = Number(
      process.env.ACTIVITY_OBSERVE_INTERVAL_MINUTES ?? DEFAULT_OBSERVE_INTERVAL_MINUTES
    );
    const intervalMinutes =
      Number.isFinite(configuredIntervalMinutes) && configuredIntervalMinutes > 0
        ? configuredIntervalMinutes
        : DEFAULT_OBSERVE_INTERVAL_MINUTES;
    const intervalMs = Math.floor(intervalMinutes * 60 * 1000);
    const initialObserveDelayMs = await getInitialObserveDelayMs();
    startupPhase = "activity_observe_loop";
    await markStartupPhase(startupPhase, { pollingMode });
    startActivityObserveLoop({
      activePollingEnabled,
      intervalMinutes,
      intervalMs,
      initialObserveDelayMs,
      runObservedCycle,
    });

    if (activePollingEnabled) {
      startupPhase = "autorole_scheduler";
      await markStartupPhase(startupPhase, { pollingMode });
      const autoRoleScheduler = new AutoRoleSchedulerService(client, cocService);
      autoRoleScheduler.start();
      console.log("Autorole scheduler loop initialized.");
    } else {
      startupPhase = "autorole_scheduler";
      await markStartupPhase(startupPhase, { pollingMode, skipped: true });
      console.log(
        "[polling-mode] event=poller_skipped job=autorole_scheduler mode=mirror",
      );
    }

    const runRecruitmentReminders = async () => {
      const now = new Date();
      await markPollJobStarted({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.recruitmentCooldownReminders,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.recruitmentCooldownReminders,
        intervalMs: RECRUITMENT_REMINDER_INTERVAL_MS,
        nextDueAt: new Date(now.getTime() + RECRUITMENT_REMINDER_INTERVAL_MS),
        metadata: { guildId },
      });
      await runFetchTelemetryBatch("recruitment_reminder_cycle", async () => {
        try {
          await processRecruitmentCooldownReminders(client, guildId);
          await markPollJobSucceeded({
            jobKey: BOT_POLL_STATUS_JOB_KEYS.recruitmentCooldownReminders,
            displayName: BOT_POLL_STATUS_DISPLAY_NAMES.recruitmentCooldownReminders,
            intervalMs: RECRUITMENT_REMINDER_INTERVAL_MS,
            nextDueAt: new Date(now.getTime() + RECRUITMENT_REMINDER_INTERVAL_MS),
            metadata: { guildId },
          });
        } catch (err) {
          console.error(`[recruitment] reminder loop failed: ${formatError(err)}`);
          await markPollJobFailed({
            jobKey: BOT_POLL_STATUS_JOB_KEYS.recruitmentCooldownReminders,
            displayName: BOT_POLL_STATUS_DISPLAY_NAMES.recruitmentCooldownReminders,
            error: err,
            intervalMs: RECRUITMENT_REMINDER_INTERVAL_MS,
            nextDueAt: new Date(now.getTime() + RECRUITMENT_REMINDER_INTERVAL_MS),
            metadata: { guildId },
          });
        }
      });
    };

    startupPhase = "recruitment_reminders";
    await markStartupPhase(startupPhase, { pollingMode });
    await runRecruitmentReminders();
    setInterval(() => {
      runRecruitmentReminders().catch((err) => {
        console.error(`[recruitment] reminder interval failed: ${formatError(err)}`);
      });
    }, RECRUITMENT_REMINDER_INTERVAL_MS);
    console.log("Recruitment reminder loop enabled (every 60 minute(s)).");

    const runRecruitmentRuleReminders = async () => {
      const now = new Date();
      await markPollJobStarted({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.recruitmentRuleReminders,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.recruitmentRuleReminders,
        intervalMs: RECRUITMENT_RULE_REMINDER_INTERVAL_MS,
        nextDueAt: new Date(now.getTime() + RECRUITMENT_RULE_REMINDER_INTERVAL_MS),
      });
      await runFetchTelemetryBatch("recruitment_rule_reminder_cycle", async () => {
        try {
          const counts = await processDueRecruitmentReminders({
            client,
            now,
          });
          console.log(
            `[recruitment-reminder] evaluated=${counts.evaluated} sent=${counts.sent} failed=${counts.failed}`,
          );
          await markPollJobSucceeded({
            jobKey: BOT_POLL_STATUS_JOB_KEYS.recruitmentRuleReminders,
            displayName: BOT_POLL_STATUS_DISPLAY_NAMES.recruitmentRuleReminders,
            intervalMs: RECRUITMENT_RULE_REMINDER_INTERVAL_MS,
            nextDueAt: new Date(now.getTime() + RECRUITMENT_RULE_REMINDER_INTERVAL_MS),
            metadata: {
              evaluated: counts.evaluated,
              sent: counts.sent,
              failed: counts.failed,
            },
          });
        } catch (err) {
          console.error(`[recruitment-reminder] loop failed: ${formatError(err)}`);
          await markPollJobFailed({
            jobKey: BOT_POLL_STATUS_JOB_KEYS.recruitmentRuleReminders,
            displayName: BOT_POLL_STATUS_DISPLAY_NAMES.recruitmentRuleReminders,
            error: err,
            intervalMs: RECRUITMENT_RULE_REMINDER_INTERVAL_MS,
            nextDueAt: new Date(now.getTime() + RECRUITMENT_RULE_REMINDER_INTERVAL_MS),
          });
        }
      });
    };

    await runRecruitmentRuleReminders();
    setInterval(() => {
      runRecruitmentRuleReminders().catch((err) => {
        console.error(`[recruitment-reminder] interval failed: ${formatError(err)}`);
      });
    }, RECRUITMENT_RULE_REMINDER_INTERVAL_MS);
    console.log("Recruitment rule reminder loop enabled (every 1 minute).");

    const runDefermentReminders = async () => {
      const now = new Date();
      await markPollJobStarted({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.defermentReminders,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.defermentReminders,
        intervalMs: DEFERMENT_REMINDER_INTERVAL_MS,
        nextDueAt: new Date(now.getTime() + DEFERMENT_REMINDER_INTERVAL_MS),
        metadata: { guildId },
      });
      await runFetchTelemetryBatch("deferment_reminder_cycle", async () => {
        try {
          await processWeightInputDefermentStages(client, guildId);
          await markPollJobSucceeded({
            jobKey: BOT_POLL_STATUS_JOB_KEYS.defermentReminders,
            displayName: BOT_POLL_STATUS_DISPLAY_NAMES.defermentReminders,
            intervalMs: DEFERMENT_REMINDER_INTERVAL_MS,
            nextDueAt: new Date(now.getTime() + DEFERMENT_REMINDER_INTERVAL_MS),
            metadata: { guildId },
          });
        } catch (err) {
          console.error(`[defer] reminder loop failed: ${formatError(err)}`);
          await markPollJobFailed({
            jobKey: BOT_POLL_STATUS_JOB_KEYS.defermentReminders,
            displayName: BOT_POLL_STATUS_DISPLAY_NAMES.defermentReminders,
            error: err,
            intervalMs: DEFERMENT_REMINDER_INTERVAL_MS,
            nextDueAt: new Date(now.getTime() + DEFERMENT_REMINDER_INTERVAL_MS),
            metadata: { guildId },
          });
        }
      });
    };

    startupPhase = "deferment_reminders";
    await markStartupPhase(startupPhase, { pollingMode });
    await runDefermentReminders();
    setInterval(() => {
      runDefermentReminders().catch((err) => {
        console.error(`[defer] reminder interval failed: ${formatError(err)}`);
      });
    }, DEFERMENT_REMINDER_INTERVAL_MS);
    console.log("Deferment reminder loop enabled (every 60 minute(s)).");

    const runTrackedMessageSweep = async () => {
      const now = new Date();
      await markPollJobStarted({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.trackedMessageSweep,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.trackedMessageSweep,
        intervalMs: TRACKED_MESSAGE_SWEEP_INTERVAL_MS,
        nextDueAt: new Date(now.getTime() + TRACKED_MESSAGE_SWEEP_INTERVAL_MS),
      });
      let sweepError: unknown = null;
      let heatmaprefStatus: string | null = null;
      let heatmaprefRows = 0;
      let heatmaprefQualifying = 0;
      let heatmaprefExcluded = 0;
      try {
        await trackedMessageService.processDueExpirations();
        await trackedMessageService.processDueSyncReminders(client);
      } catch (err) {
        sweepError = err;
        console.error(`[tracked-messages] sweep failed: ${formatError(err)}`);
      }
      try {
        await markPollJobStarted({
          jobKey: BOT_POLL_STATUS_JOB_KEYS.heatmaprefRebuildCycle,
          displayName: BOT_POLL_STATUS_DISPLAY_NAMES.heatmaprefRebuildCycle,
          intervalMs: TRACKED_MESSAGE_SWEEP_INTERVAL_MS,
          nextDueAt: new Date(now.getTime() + TRACKED_MESSAGE_SWEEP_INTERVAL_MS),
        });
        const guardResult = await pollCycleGuard.run("heatmapref_rebuild_cycle", async () => {
          const result = await heatMapRefRebuildService.runScheduledRebuildCycle({
            client,
            guildId,
            pollingMode: activePollingEnabled ? "active" : "mirror",
            now,
          });
          heatmaprefStatus = result.status;
          heatmaprefRows = result.rowCount;
          heatmaprefQualifying = result.qualifyingRosterCount;
          heatmaprefExcluded = result.excludedRosterCount;
          if (result.status !== "skipped") {
            console.log(
              `[heatmapref] status=${result.status} cycle=${result.cycleKey ?? "none"} fwa_clans=${result.trackedClanCount} rosters=${result.sourceRosterCount} qualifying=${result.qualifyingRosterCount} excluded=${result.excludedRosterCount} rows=${result.rowCount} alerted=${result.alertSent}`,
            );
          }
          if (result.status === "failed") {
            await markPollJobFailed({
              jobKey: BOT_POLL_STATUS_JOB_KEYS.heatmaprefRebuildCycle,
              displayName: BOT_POLL_STATUS_DISPLAY_NAMES.heatmaprefRebuildCycle,
              error: new Error(result.reason ?? "Heatmapref rebuild failed"),
              intervalMs: TRACKED_MESSAGE_SWEEP_INTERVAL_MS,
              nextDueAt: new Date(now.getTime() + TRACKED_MESSAGE_SWEEP_INTERVAL_MS),
              metadata: {
                status: result.status,
                cycleKey: result.cycleKey,
                rows: result.rowCount,
                qualifying: result.qualifyingRosterCount,
                excluded: result.excludedRosterCount,
                alerted: result.alertSent,
              },
            });
          } else if (result.status === "skipped") {
            await markPollJobSkipped({
              jobKey: BOT_POLL_STATUS_JOB_KEYS.heatmaprefRebuildCycle,
              displayName: BOT_POLL_STATUS_DISPLAY_NAMES.heatmaprefRebuildCycle,
              intervalMs: TRACKED_MESSAGE_SWEEP_INTERVAL_MS,
              nextDueAt: new Date(now.getTime() + TRACKED_MESSAGE_SWEEP_INTERVAL_MS),
              metadata: {
                status: result.status,
                reason: result.reason,
                cycleKey: result.cycleKey,
              },
            });
          } else {
            await markPollJobSucceeded({
              jobKey: BOT_POLL_STATUS_JOB_KEYS.heatmaprefRebuildCycle,
              displayName: BOT_POLL_STATUS_DISPLAY_NAMES.heatmaprefRebuildCycle,
              intervalMs: TRACKED_MESSAGE_SWEEP_INTERVAL_MS,
              nextDueAt: new Date(now.getTime() + TRACKED_MESSAGE_SWEEP_INTERVAL_MS),
              metadata: {
                status: result.status,
                cycleKey: result.cycleKey,
                rows: result.rowCount,
                qualifying: result.qualifyingRosterCount,
                excluded: result.excludedRosterCount,
                alerted: result.alertSent,
              },
            });
          }
        });
        if (!guardResult.ran) {
          heatmaprefStatus = "skipped";
          await markPollJobSkipped({
            jobKey: BOT_POLL_STATUS_JOB_KEYS.heatmaprefRebuildCycle,
            displayName: BOT_POLL_STATUS_DISPLAY_NAMES.heatmaprefRebuildCycle,
            intervalMs: TRACKED_MESSAGE_SWEEP_INTERVAL_MS,
            nextDueAt: new Date(now.getTime() + TRACKED_MESSAGE_SWEEP_INTERVAL_MS),
            metadata: {
              status: "skipped",
              reason: "in_flight",
            },
          });
        }
      } catch (err) {
        sweepError ??= err;
        console.error(`[tracked-messages] heatmapref failed: ${formatError(err)}`);
      }
      if (sweepError) {
        await markPollJobFailed({
          jobKey: BOT_POLL_STATUS_JOB_KEYS.trackedMessageSweep,
          displayName: BOT_POLL_STATUS_DISPLAY_NAMES.trackedMessageSweep,
          error: sweepError,
          intervalMs: TRACKED_MESSAGE_SWEEP_INTERVAL_MS,
          nextDueAt: new Date(now.getTime() + TRACKED_MESSAGE_SWEEP_INTERVAL_MS),
          metadata: {
            heatmaprefStatus,
            heatmaprefRows,
            heatmaprefQualifying,
            heatmaprefExcluded,
          },
        });
      } else {
        await markPollJobSucceeded({
          jobKey: BOT_POLL_STATUS_JOB_KEYS.trackedMessageSweep,
          displayName: BOT_POLL_STATUS_DISPLAY_NAMES.trackedMessageSweep,
          intervalMs: TRACKED_MESSAGE_SWEEP_INTERVAL_MS,
          nextDueAt: new Date(now.getTime() + TRACKED_MESSAGE_SWEEP_INTERVAL_MS),
          metadata: {
            heatmaprefStatus,
            heatmaprefRows,
            heatmaprefQualifying,
            heatmaprefExcluded,
          },
        });
      }
    };

    startupPhase = "tracked_message_sweep";
    await markStartupPhase(startupPhase, { pollingMode });
    await runTrackedMessageSweep();
    setInterval(() => {
      runTrackedMessageSweep().catch((err) => {
        console.error(`[tracked-messages] interval failed: ${formatError(err)}`);
      });
    }, TRACKED_MESSAGE_SWEEP_INTERVAL_MS);
    console.log("Tracked message sweep enabled (every 1 minute).");

    const warEventPollMs = resolveWarEventPollIntervalMsFromEnv(process.env);
    const warEventPollMinutes = Math.round(warEventPollMs / 60_000);

    const runWarEventPoll = async (scheduledAtMs: number = Date.now()) => {
      const nextDueAt = new Date(scheduledAtMs + warEventPollMs);
      await markPollJobStarted({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.warEventPollCycle,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.warEventPollCycle,
        intervalMs: warEventPollMs,
        nextDueAt,
        metadata: {
          mode: activePollingEnabled ? "active" : "mirror",
        },
      });
      let pollError: unknown = null;
      let skippedReason: string | null = null;
      let guardRan = false;
      await runWithCoCQueueContext(
        {
          priority: "background",
          source: "war_event_poll_cycle",
          scheduledAtMs,
          nextScheduledAtMs: scheduledAtMs + warEventPollMs,
        },
        async () => {
          const guardResult = await pollCycleGuard.run("war_event_poll_cycle", async () => {
            const queueStatus = cocRequestQueueService.getStatus();
            if (queueStatus.degraded) {
              console.warn(
                `[poll-cycle] event=degraded_mode job=war_event_poll_cycle spacing_ms=${queueStatus.spacingMs} penalty_ms=${queueStatus.penaltyMs} queue_depth=${queueStatus.queueDepth} interactive_depth=${queueStatus.interactiveQueueDepth} background_depth=${queueStatus.backgroundQueueDepth} in_flight=${queueStatus.inFlight}`,
              );
            }
            await runFetchTelemetryBatch("war_event_poll_cycle", async () => {
              try {
                await warEventLogService.poll({
                  sendBattleDaySwapReminders: true,
                });
                await warEventLogService.refreshBattleDayPosts();
                await refreshAllTrackedWarMailPosts(client);
                await cwlStateService.refreshTrackedCwlState({
                  cocService,
                });
                await todoSnapshotService.refreshActivatedTodoLinkedPlayerSnapshots({
                  cadence: "tracked",
                  cocService,
                  nowMs: scheduledAtMs,
                  producerPacingMs: warEventPollMs,
                });
              } catch (err) {
                if (isCoCQueueSkippedError(err)) {
                  console.warn(`[war-events] poll_skipped reason=${err.message}`);
                  skippedReason = err.message;
                  return;
                }
                pollError = err;
                console.error(`[war-events] poll loop failed: ${formatError(err)}`);
              }
            });
          });
          guardRan = guardResult.ran;
        },
      );
      if (!guardRan) {
        skippedReason = skippedReason ?? "in_flight";
        await markPollJobSkipped({
          jobKey: BOT_POLL_STATUS_JOB_KEYS.warEventPollCycle,
          displayName: BOT_POLL_STATUS_DISPLAY_NAMES.warEventPollCycle,
          intervalMs: warEventPollMs,
          nextDueAt,
          metadata: {
            mode: activePollingEnabled ? "active" : "mirror",
            skippedReason,
          },
        });
        return;
      }

      if (skippedReason) {
        await markPollJobSkipped({
          jobKey: BOT_POLL_STATUS_JOB_KEYS.warEventPollCycle,
          displayName: BOT_POLL_STATUS_DISPLAY_NAMES.warEventPollCycle,
          intervalMs: warEventPollMs,
          nextDueAt,
          metadata: {
            mode: activePollingEnabled ? "active" : "mirror",
            skippedReason,
          },
        });
        return;
      }

      if (pollError) {
        await markPollJobFailed({
          jobKey: BOT_POLL_STATUS_JOB_KEYS.warEventPollCycle,
          displayName: BOT_POLL_STATUS_DISPLAY_NAMES.warEventPollCycle,
          error: pollError,
          intervalMs: warEventPollMs,
          nextDueAt,
          metadata: {
            mode: activePollingEnabled ? "active" : "mirror",
          },
        });
        return;
      }

      await markPollJobSucceeded({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.warEventPollCycle,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.warEventPollCycle,
        intervalMs: warEventPollMs,
        nextDueAt,
        metadata: {
          mode: activePollingEnabled ? "active" : "mirror",
        },
      });
    };

    if (activePollingEnabled) {
      startupPhase = "war_event_poll";
      await markStartupPhase(startupPhase, { pollingMode });
      setNextNotifyRefreshAtMs(Date.now() + warEventPollMs);
      setNextWarMailRefreshAtMs(Date.now() + warEventPollMs);
      await runWarEventPoll(Date.now());
      setInterval(() => {
        setNextNotifyRefreshAtMs(Date.now() + warEventPollMs);
        setNextWarMailRefreshAtMs(Date.now() + warEventPollMs);
        runWarEventPoll(Date.now()).catch((err) => {
          if (isCoCQueueSkippedError(err)) {
            console.warn(`[war-events] poll_skipped reason=${err.message}`);
            return;
          }
          console.error(`[war-events] poll interval failed: ${formatError(err)}`);
        });
      }, warEventPollMs);
      console.log(
        `War event poll + refresh loop enabled (every ${warEventPollMinutes} minute(s)).`
      );

      const fwaFeedScheduler = new FwaFeedSchedulerService();
      startupPhase = "fwa_feed_scheduler";
      await markStartupPhase(startupPhase, { pollingMode });
      await markPollJobStarted({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.fwaFeedScheduler,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.fwaFeedScheduler,
        intervalMs: null,
        metadata: {
          started: true,
        },
      });
      try {
        fwaFeedScheduler.start();
        await markPollJobSucceeded({
          jobKey: BOT_POLL_STATUS_JOB_KEYS.fwaFeedScheduler,
          displayName: BOT_POLL_STATUS_DISPLAY_NAMES.fwaFeedScheduler,
          intervalMs: null,
          metadata: {
            started: true,
          },
        });
      } catch (err) {
        await markPollJobFailed({
          jobKey: BOT_POLL_STATUS_JOB_KEYS.fwaFeedScheduler,
          displayName: BOT_POLL_STATUS_DISPLAY_NAMES.fwaFeedScheduler,
          error: err,
          intervalMs: null,
          metadata: {
            started: true,
          },
        });
      }
      console.log("FWA feed scheduler loops initialized.");
    } else {
      await markPollJobDisabled({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.warEventPollCycle,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.warEventPollCycle,
        intervalMs: warEventPollMs,
        metadata: { reason: "mirror" },
      });
      await markPollJobDisabled({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.fwaFeedScheduler,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.fwaFeedScheduler,
        metadata: { reason: "mirror" },
      });
      console.log(
        "[polling-mode] event=poller_skipped job=war_event_poll_cycle mode=mirror",
      );
      console.log(
        "[polling-mode] event=poller_skipped job=fwa_feed_scheduler mode=mirror",
      );
    }

    if (!activePollingEnabled) {
      startupPhase = "mirror_sync";
      await markStartupPhase(startupPhase, { pollingMode });
      const mirrorSyncIntervalMs = resolveMirrorSyncIntervalMsFromEnv(process.env);
      const mirrorSyncIntervalMinutes = Math.max(
        1,
        Math.trunc(mirrorSyncIntervalMs / 60_000),
      );

      const runMirrorSyncCycle = async (trigger: "startup" | "scheduled") => {
        const nextDueAt = new Date(Date.now() + mirrorSyncIntervalMs);
        await markPollJobStarted({
          jobKey: BOT_POLL_STATUS_JOB_KEYS.mirrorSyncCycle,
          displayName: BOT_POLL_STATUS_DISPLAY_NAMES.mirrorSyncCycle,
          intervalMs: mirrorSyncIntervalMs,
          nextDueAt,
          metadata: { trigger },
        });
        let cycleError: unknown = null;
        let skippedReason: string | null = null;
        const guardResult = await pollCycleGuard.run(MIRROR_SYNC_POLL_GUARD_KEY, async () => {
          try {
            await mirrorSyncService.syncNow("scheduled");
            await markPollJobSucceeded({
              jobKey: BOT_POLL_STATUS_JOB_KEYS.mirrorSyncCycle,
              displayName: BOT_POLL_STATUS_DISPLAY_NAMES.mirrorSyncCycle,
              intervalMs: mirrorSyncIntervalMs,
              nextDueAt,
              metadata: { trigger },
            });
          } catch (err) {
            cycleError = err;
            console.error(`[mirror-sync] event=${trigger}_failed error=${formatError(err)}`);
          }
        });
        if (!guardResult.ran) {
          skippedReason = "in_flight";
        }
        if (skippedReason) {
          await markPollJobSkipped({
            jobKey: BOT_POLL_STATUS_JOB_KEYS.mirrorSyncCycle,
            displayName: BOT_POLL_STATUS_DISPLAY_NAMES.mirrorSyncCycle,
            intervalMs: mirrorSyncIntervalMs,
            nextDueAt,
            metadata: { trigger, reason: skippedReason },
          });
          return;
        }
        if (cycleError) {
          await markPollJobFailed({
            jobKey: BOT_POLL_STATUS_JOB_KEYS.mirrorSyncCycle,
            displayName: BOT_POLL_STATUS_DISPLAY_NAMES.mirrorSyncCycle,
            error: cycleError,
            intervalMs: mirrorSyncIntervalMs,
            nextDueAt,
            metadata: { trigger },
          });
        }
      };

      await runMirrorSyncCycle("startup");
      setInterval(() => {
        runMirrorSyncCycle("scheduled").catch((err) => {
          console.error(`[mirror-sync] event=scheduled_failed error=${formatError(err)}`);
        });
      }, mirrorSyncIntervalMs);
      console.log(
        `[mirror-sync] event=scheduler_started interval_minutes=${mirrorSyncIntervalMinutes}`,
      );
    } else {
      startupPhase = "mirror_sync";
      await markStartupPhase(startupPhase, { pollingMode, skipped: true });
      await markPollJobDisabled({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.mirrorSyncCycle,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.mirrorSyncCycle,
        metadata: { reason: "active" },
      });
    }

    if (activePollingEnabled) {
      startupPhase = "user_activity_reminder_scheduler";
      await markStartupPhase(startupPhase, { pollingMode });
      const userActivityReminderScheduler = new UserActivityReminderSchedulerService(
        client,
        cocService
      );
      userActivityReminderScheduler.start();
      console.log("User activity reminder scheduler loop initialized.");
    } else {
      startupPhase = "user_activity_reminder_scheduler";
      await markStartupPhase(startupPhase, { pollingMode, skipped: true });
      await markPollJobDisabled({
        jobKey: BOT_POLL_STATUS_JOB_KEYS.userActivityReminderScheduler,
        displayName: BOT_POLL_STATUS_DISPLAY_NAMES.userActivityReminderScheduler,
        intervalMs: null,
        metadata: { reason: "mirror" },
      });
      console.log(
        "[polling-mode] event=poller_skipped job=user_activity_reminder_scheduler mode=mirror",
      );
    }

    await markStartupComplete({ pollingMode });
    console.log("ClashCookies is online");
    } catch (err) {
      await markStartupFailed(err, { phase: startupPhase });
      console.error(`[startup] ready startup failed at phase=${startupPhase}: ${formatError(err)}`);
      throw err;
    }
  });
};
