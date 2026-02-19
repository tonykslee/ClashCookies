import { Client, GatewayIntentBits } from "discord.js";
import ready from "./listeners/ready";
import interactionCreate from "./listeners/interactionCreate";
import { CoCService } from "./services/CoCService";
import "dotenv/config";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const cocService = new CoCService();

// ✅ Register listeners ONCE
interactionCreate(client, cocService);
ready(client, cocService);

client.login(process.env.DISCORD_TOKEN);
