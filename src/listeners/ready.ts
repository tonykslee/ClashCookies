import { Client } from "discord.js";
import { Commands } from "../Commands";
import { CoCService } from "../services/CoCService";
import { SnapshotService } from "../services/SnapshotService";

export default (client: Client, cocService: CoCService): void => {
  client.once("ready", async () => {
    if (!client.user || !client.application) return;
  
    console.log("ClashCookies is starting...");
  
    // 🔥 Clear global commands (one-time cleanup)
    await client.application.commands.set([]);
    console.log("Global commands cleared");
  
    const GUILD_ID = process.env.GUILD_ID!;
    const guild = await client.guilds.fetch(GUILD_ID);
  
    const snapshotService = new SnapshotService(cocService);
    await snapshotService.snapshotClan("#2RYGLU2UY");
    console.log("Initial snapshots collected");

    
    await guild.commands.set(Commands);
    console.log(`Guild commands registered (${Commands.length})`);
  
    console.log("ClashCookies is online");
  });
  
};
