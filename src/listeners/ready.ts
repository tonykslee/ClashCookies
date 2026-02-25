import {
  ApplicationCommandOptionType,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Commands } from "../Commands";
import { CoCService } from "../services/CoCService";
import { ActivityService } from "../services/ActivityService";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { processRecruitmentCooldownReminders } from "../services/RecruitmentService";
import { SettingsService } from "../services/SettingsService";

const DEFAULT_OBSERVE_INTERVAL_MINUTES = 30;
const RECRUITMENT_REMINDER_INTERVAL_MS = 5 * 60 * 1000;
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

function hasVisibilityOption(options: any[] | undefined): boolean {
  if (!options) return false;
  return options.some((opt) => opt?.name === "visibility");
}

function withVisibilityOnSubcommand(sub: any): any {
  const options = Array.isArray(sub.options) ? [...sub.options] : [];
  if (!hasVisibilityOption(options)) {
    options.push(VISIBILITY_OPTION);
  }
  return { ...sub, options };
}

function injectVisibilityOptions(command: any): any {
  const options = Array.isArray(command.options) ? [...command.options] : [];
  if (options.length === 0) {
    return { ...command, options: [VISIBILITY_OPTION] };
  }

  const hasSubcommands = options.some(
    (opt) =>
      opt?.type === ApplicationCommandOptionType.Subcommand ||
      opt?.type === ApplicationCommandOptionType.SubcommandGroup
  );

  if (!hasSubcommands) {
    if (!hasVisibilityOption(options)) {
      options.push(VISIBILITY_OPTION);
    }
    return { ...command, options };
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

  return { ...command, options: nextOptions };
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
    await guild.commands.set(commandsWithVisibility);
    console.log(`✅ Guild commands registered (${Commands.length})`);

    const activityService = new ActivityService(cocService);
    const settings = new SettingsService();
    let observeInProgress = false;

    const observeTrackedClans = async () => {
      if (observeInProgress) {
        console.warn("Skipping observe loop because previous run is still in progress.");
        return;
      }

      observeInProgress = true;
      try {
        const dbTracked = await prisma.trackedClan.findMany({
          orderBy: { createdAt: "asc" },
        });

        const trackedTags = dbTracked.map((c) => c.tag);

        if (trackedTags.length === 0) {
          console.warn(
            "No tracked clans configured. Use /tracked-clan add."
          );
          return;
        }

        for (const tag of trackedTags) {
          try {
            await activityService.observeClan(tag);
          } catch (err) {
            console.error(
              `observeClan failed for ${tag}: ${formatError(err)}`
            );
          }
        }
      } finally {
        observeInProgress = false;
      }
    };

    const markObserveRun = async () => {
      await settings.set(OBSERVE_LAST_RUN_AT_KEY, String(Date.now()));
    };

    const runObservedCycle = async () => {
      await observeTrackedClans();
      try {
        await markObserveRun();
      } catch (err) {
        console.error(`observe run timestamp write failed: ${formatError(err)}`);
      }
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
      try {
        await processRecruitmentCooldownReminders(client);
      } catch (err) {
        console.error(`[recruitment] reminder loop failed: ${formatError(err)}`);
      }
    };

    await runRecruitmentReminders();
    setInterval(() => {
      runRecruitmentReminders().catch((err) => {
        console.error(`[recruitment] reminder interval failed: ${formatError(err)}`);
      });
    }, RECRUITMENT_REMINDER_INTERVAL_MS);
    console.log("Recruitment reminder loop enabled (every 5 minute(s)).");

    console.log("ClashCookies is online");
  });
};
