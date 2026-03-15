import { Client, GatewayIntentBits } from "discord.js";
import ready from "./listeners/ready";
import interactionCreate from "./listeners/interactionCreate";
import { CoCService } from "./services/CoCService";
import {
  getDiscordRestTimeoutMsFromEnv,
  getStartupLoginRetryConfigFromEnv,
  isTransientRegistrationError,
  runWithTransientRetry,
} from "./services/StartupCommandRegistrationService";
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

// Register listeners once before login attempts.
interactionCreate(client, cocService);
ready(client, cocService);

async function loginWithRetry(): Promise<void> {
  const retryConfig = getStartupLoginRetryConfigFromEnv(process.env);
  console.log(
    `[startup:login] start base_backoff_ms=${retryConfig.baseBackoffMs} max_backoff_ms=${retryConfig.maxBackoffMs}`
  );

  const result = await runWithTransientRetry<string>({
    execute: async () => {
      const token = String(process.env.DISCORD_TOKEN ?? "").trim();
      if (!token) {
        throw new Error("MISSING_DISCORD_TOKEN");
      }
      return client.login(token);
    },
    config: retryConfig,
    isTransientError: isTransientRegistrationError,
    onFailure: (context) => {
      const errorMessage =
        context.error instanceof Error ? context.error.message : String(context.error);
      if (context.willRetry && context.backoffMs !== null) {
        console.warn(
          `[startup:login] retry attempt=${context.attempt + 1} backoff_ms=${context.backoffMs} transient=${
            context.transient ? 1 : 0
          } error=${errorMessage}`
        );
        return;
      }

      console.error(
        `[startup:login] fatal_non_transient attempt=${context.attempt} transient=${
          context.transient ? 1 : 0
        } error=${errorMessage}`
      );
    },
  });

  if (result.status === "success") {
    console.log(`[startup:login] success attempt=${result.attempts}`);
    return;
  }

  process.exit(1);
}

void loginWithRetry().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`[startup:login] fatal_non_transient error=${errorMessage}`);
  process.exit(1);
});
