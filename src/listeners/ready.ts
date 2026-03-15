import {
  ApplicationCommandOptionType,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Commands } from "../Commands";
import { CoCService } from "../services/CoCService";
import { ActivityService } from "../services/ActivityService";
import { formatError } from "../helper/formatError";
import { runFetchTelemetryBatch } from "../helper/fetchTelemetry";
import { prisma } from "../prisma";
import { processRecruitmentCooldownReminders } from "../services/RecruitmentService";
import { processWeightInputDefermentStages } from "../services/WeightInputDefermentService";
import { SettingsService } from "../services/SettingsService";
import { WarEventLogService } from "../services/WarEventLogService";
import { TelemetryIngestService } from "../services/telemetry/ingest";
import { startTelemetryScheduleLoop } from "../services/telemetry/schedule";
import { refreshAllTrackedWarMailPosts } from "../commands/Fwa";
import {
  getCommandRegistrationConfigFromEnv,
  registerGuildCommandsWithRetry,
} from "../services/StartupCommandRegistrationService";
import {
  setNextNotifyRefreshAtMs,
  setNextWarMailRefreshAtMs,
} from "../services/refreshSchedule";

const DEFAULT_OBSERVE_INTERVAL_MINUTES = 30;
const RECRUITMENT_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const DEFERMENT_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_WAR_EVENT_POLL_INTERVAL_MINUTES = 5;
const OBSERVE_LAST_RUN_AT_KEY = "activity_observe:last_run_at_ms";
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
    if (!client.application) return;

    console.log("ClashCookies is starting...");

    const guildId = process.env.GUILD_ID!;
    const guild = await client.guilds.fetch(guildId);
    const me = await guild.members.fetch(client.user!.id);
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
      console.warn(
        `Bot is missing recommended guild permissions: ${missingGuildPerms.join(", ")}.`
      );
      console.warn(
        "Some commands may partially fail depending on channel overrides. Update role/channel permissions and redeploy."
      );
    }

    // Register ONLY guild commands
    const commandsWithVisibility = Commands.map((cmd) => injectVisibilityOptions(cmd));
    const registrationConfig = getCommandRegistrationConfigFromEnv(process.env);
    const registrationResult = await registerGuildCommandsWithRetry({
      guild,
      commands: commandsWithVisibility,
      config: registrationConfig,
      logger: console,
    });
    if (registrationResult.status === "success") {
      console.log(`[startup:commands] registration complete count=${Commands.length}`);
    } else if (registrationResult.status === "skipped") {
      console.warn(
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
      console.warn(
        `[startup:commands] registration unavailable after ${registrationResult.attempts} attempt(s); startup continuing.`
      );
    }

    TelemetryIngestService.getInstance().startAutoFlush();
    startTelemetryScheduleLoop(client);
    console.log("Telemetry ingest + schedule loops enabled.");

    const activityService = new ActivityService(cocService);
    const warEventLogService = new WarEventLogService(client, cocService);
    const settings = new SettingsService();
    let observeInProgress = false;

    const observeTrackedClans = async (): Promise<string[]> => {
      if (observeInProgress) {
        console.warn("Skipping observe loop because previous run is still in progress.");
        return [];
      }

      observeInProgress = true;
      try {
        const dbTracked = await prisma.trackedClan.findMany({
          orderBy: { createdAt: "asc" },
        });

        const trackedTags = dbTracked.map((c) => c.tag);

        if (trackedTags.length === 0) {
          console.warn(
            "No tracked clans configured. Use /tracked-clan configure."
          );
          return [];
        }

        const observedMemberTags = new Set<string>();
        for (const tag of trackedTags) {
          try {
            const memberTags = await activityService.observeClan(guildId, tag);
            for (const memberTag of memberTags) {
              observedMemberTags.add(memberTag);
            }
          } catch (err) {
            console.error(
              `observeClan failed for ${tag}: ${formatError(err)}`
            );
          }
        }

        return [...observedMemberTags];
      } finally {
        observeInProgress = false;
      }
    };

    const markObserveRun = async () => {
      await settings.set(OBSERVE_LAST_RUN_AT_KEY, String(Date.now()));
    };

    const runObservedCycle = async () => {
      await runFetchTelemetryBatch("activity_observe_cycle", async () => {
        await observeTrackedClans();
        try {
          await markObserveRun();
        } catch (err) {
          console.error(`observe run timestamp write failed: ${formatError(err)}`);
        }
      });
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

    if (initialObserveDelayMs === 0) {
      await runObservedCycle();
      setInterval(() => {
        runObservedCycle().catch((err) => {
          console.error(`observeTrackedClans loop failed: ${formatError(err)}`);
        });
      }, intervalMs);
    } else {
      const initialObserveDelayMin = Math.ceil(initialObserveDelayMs / 60000);
      console.log(
        `Skipping startup activity observe run; next run in ${initialObserveDelayMin} minute(s).`
      );
      setTimeout(() => {
        runObservedCycle()
          .catch((err) => {
            console.error(`observeTrackedClans delayed run failed: ${formatError(err)}`);
          })
          .finally(() => {
            setInterval(() => {
              runObservedCycle().catch((err) => {
                console.error(`observeTrackedClans loop failed: ${formatError(err)}`);
              });
            }, intervalMs);
          });
      }, initialObserveDelayMs);
    }
    console.log(`Activity observe loop enabled (every ${intervalMinutes} minute(s)).`);

    const runRecruitmentReminders = async () => {
      await runFetchTelemetryBatch("recruitment_reminder_cycle", async () => {
        try {
          await processRecruitmentCooldownReminders(client, guildId);
        } catch (err) {
          console.error(`[recruitment] reminder loop failed: ${formatError(err)}`);
        }
      });
    };

    await runRecruitmentReminders();
    setInterval(() => {
      runRecruitmentReminders().catch((err) => {
        console.error(`[recruitment] reminder interval failed: ${formatError(err)}`);
      });
    }, RECRUITMENT_REMINDER_INTERVAL_MS);
    console.log("Recruitment reminder loop enabled (every 60 minute(s)).");

    const runDefermentReminders = async () => {
      await runFetchTelemetryBatch("deferment_reminder_cycle", async () => {
        try {
          await processWeightInputDefermentStages(client, guildId);
        } catch (err) {
          console.error(`[defer] reminder loop failed: ${formatError(err)}`);
        }
      });
    };

    await runDefermentReminders();
    setInterval(() => {
      runDefermentReminders().catch((err) => {
        console.error(`[defer] reminder interval failed: ${formatError(err)}`);
      });
    }, DEFERMENT_REMINDER_INTERVAL_MS);
    console.log("Deferment reminder loop enabled (every 60 minute(s)).");

    const warEventPollMinutesRaw = Number(
      process.env.WAR_EVENT_LOG_POLL_INTERVAL_MINUTES ?? DEFAULT_WAR_EVENT_POLL_INTERVAL_MINUTES
    );
    const warEventPollMinutes =
      Number.isFinite(warEventPollMinutesRaw) && warEventPollMinutesRaw > 0
        ? warEventPollMinutesRaw
        : DEFAULT_WAR_EVENT_POLL_INTERVAL_MINUTES;
    const warEventPollMs = Math.floor(warEventPollMinutes * 60 * 1000);

    const runWarEventPoll = async () => {
      await runFetchTelemetryBatch("war_event_poll_cycle", async () => {
        try {
          await warEventLogService.poll();
          await warEventLogService.refreshBattleDayPosts();
          await refreshAllTrackedWarMailPosts(client);
        } catch (err) {
          console.error(`[war-events] poll loop failed: ${formatError(err)}`);
        }
      });
    };

    setNextNotifyRefreshAtMs(Date.now() + warEventPollMs);
    setNextWarMailRefreshAtMs(Date.now() + warEventPollMs);
    await runWarEventPoll();
    setInterval(() => {
      setNextNotifyRefreshAtMs(Date.now() + warEventPollMs);
      setNextWarMailRefreshAtMs(Date.now() + warEventPollMs);
      runWarEventPoll().catch((err) => {
        console.error(`[war-events] poll interval failed: ${formatError(err)}`);
      });
    }, warEventPollMs);
    console.log(
      `War event poll + refresh loop enabled (every ${warEventPollMinutes} minute(s)).`
    );

    console.log("ClashCookies is online");
  });
};
