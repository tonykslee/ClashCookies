import { Client } from "discord.js";
import { Commands } from "../Commands";
import { CoCService } from "../services/CoCService";
import { ActivityService } from "../services/ActivityService";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";

function normalizeClanTag(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/^#/, "");
  return `#${cleaned}`;
}

export default (client: Client, cocService: CoCService): void => {
  client.once("ready", async () => {
    if (!client.application) return;

    console.log("ClashCookies is starting...");

    const guildId = process.env.GUILD_ID!;
    const guild = await client.guilds.fetch(guildId);

    // Register ONLY guild commands
    await guild.commands.set(Commands);
    console.log(`✅ Guild commands registered (${Commands.length})`);

    // Initial activity observation for tracked clans.
    const activityService = new ActivityService(cocService);

    const dbTracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
    });

    const trackedTags =
      dbTracked.length > 0
        ? dbTracked.map((c) => c.tag)
        : (process.env.TRACKED_CLANS?.split(",") ?? [])
            .map((t) => t.trim())
            .filter(Boolean)
            .map(normalizeClanTag);

    if (trackedTags.length === 0) {
      console.warn(
        "No tracked clans configured. Use /tracked-clan add or set TRACKED_CLANS in .env."
      );
    }

    for (const tag of trackedTags) {
      const normalizedTag = normalizeClanTag(tag);

      try {
        await activityService.observeClan(normalizedTag);
      } catch (err) {
        console.error(
          `observeClan failed for ${normalizedTag}: ${formatError(err)}`
        );
      }
    }


    console.log("ClashCookies is online");
  });
};
