import { Client, GatewayIntentBits } from "discord.js";
import ready from "./listeners/ready";
import interactionCreate from "./listeners/interactionCreate";
import { CoCService } from "./services/CoCService";
import { getDiscordRestTimeoutMsFromEnv } from "./services/StartupCommandRegistrationService";
import "dotenv/config";

const discordRestTimeoutMs = getDiscordRestTimeoutMsFromEnv(process.env);
console.log(`[startup:discord-rest] timeout_ms=${discordRestTimeoutMs}`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
  rest: {
    timeout: discordRestTimeoutMs,
  },
});

const cocService = new CoCService();

// ✅ Register listeners ONCE
interactionCreate(client, cocService);
ready(client, cocService);

client.login(process.env.DISCORD_TOKEN);
