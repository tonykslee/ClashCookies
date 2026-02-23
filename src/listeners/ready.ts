import { Client, PermissionFlagsBits } from "discord.js";
import { Commands } from "../Commands";
import { CoCService } from "../services/CoCService";
import { ActivityService } from "../services/ActivityService";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";

const DEFAULT_OBSERVE_INTERVAL_MINUTES = 30;

export default (client: Client, cocService: CoCService): void => {
  client.once("ready", async () => {
    if (!client.application) return;

    console.log("ClashCookies is starting...");

    const guildId = process.env.GUILD_ID!;
    const guild = await client.guilds.fetch(guildId);
    const me = await guild.members.fetch(client.user!.id);
    const guildPerms = me.permissions;
    const requiredGuildPerms: Array<[bigint, string]> = [
      [PermissionFlagsBits.ViewChannel, "View Channels"],
      [PermissionFlagsBits.SendMessages, "Send Messages"],
      [PermissionFlagsBits.EmbedLinks, "Embed Links"],
      [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
      [PermissionFlagsBits.ManageMessages, "Manage Messages (for pin/unpin)"],
      [PermissionFlagsBits.MentionEveryone, "Mention Everyone (for non-mentionable role pings)"],
    ];
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
    await guild.commands.set(Commands);
    console.log(`✅ Guild commands registered (${Commands.length})`);

    const activityService = new ActivityService(cocService);
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

    // Initial activity observation for tracked clans.
    await observeTrackedClans();

    const configuredIntervalMinutes = Number(
      process.env.ACTIVITY_OBSERVE_INTERVAL_MINUTES ?? DEFAULT_OBSERVE_INTERVAL_MINUTES
    );
    const intervalMinutes =
      Number.isFinite(configuredIntervalMinutes) && configuredIntervalMinutes > 0
        ? configuredIntervalMinutes
        : DEFAULT_OBSERVE_INTERVAL_MINUTES;
    const intervalMs = Math.floor(intervalMinutes * 60 * 1000);

    setInterval(() => {
      observeTrackedClans().catch((err) => {
        console.error(`observeTrackedClans loop failed: ${formatError(err)}`);
      });
    }, intervalMs);
    console.log(`Activity observe loop enabled (every ${intervalMinutes} minute(s)).`);


    console.log("ClashCookies is online");
  });
};
