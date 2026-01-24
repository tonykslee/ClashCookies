import { Client } from "discord.js";
import { Commands } from "../Commands";
import { CoCService } from "../services/CoCService";
import { ActivityService } from "../services/ActivityService";

export default (client: Client, cocService: CoCService): void => {
  client.once("ready", async () => {
    if (!client.application) return;

    console.log("ClashCookies is starting...");

    const guildId = process.env.GUILD_ID!;
    const guild = await client.guilds.fetch(guildId);

    // Register ONLY guild commands
    await guild.commands.set(Commands);
    console.log(`✅ Guild commands registered (${Commands.length})`);

    // Initial activity observation (optional but good)
    const activityService = new ActivityService(cocService);
    // await activityService.observeClan("#2RYGLU2UY");
    const clans = process.env.TRACKED_CLANS?.split(",") ?? [];
    for (const tag of clans) {
      await activityService.observeClan(`#${tag}`);
    }


    console.log("ClashCookies is online");
  });
};
