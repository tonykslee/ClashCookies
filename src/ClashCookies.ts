import { Client, GatewayIntentBits, Partials } from "discord.js";
import ready from "./listeners/ready";
import interactionCreate from "./listeners/interactionCreate";
import messageReactionAdd from "./listeners/messageReactionAdd";
import { CoCService } from "./services/CoCService";
import {
  formatStartupLogFields,
  getDiscordRestTimeoutMsFromEnv,
  getStartupErrorDiagnostics,
  getStartupLoginRetryConfigFromEnv,
  getStartupRetryLogSummaryEveryFromEnv,
  isTransientRegistrationError,
  runWithTransientRetry,
  shouldEmitStartupRetrySummary,
} from "./services/StartupCommandRegistrationService";
import "dotenv/config";

const discordRestTimeoutMs = getDiscordRestTimeoutMsFromEnv(process.env);
console.log(`[startup:discord-rest] timeout_ms=${discordRestTimeoutMs}`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  rest: {
    timeout: discordRestTimeoutMs,
  },
});

const cocService = new CoCService();

// Register listeners once before login attempts.
interactionCreate(client, cocService);
messageReactionAdd(client);
ready(client, cocService);

async function loginWithRetry(): Promise<void> {
  const retryConfig = getStartupLoginRetryConfigFromEnv(process.env);
  const summaryEvery = getStartupRetryLogSummaryEveryFromEnv(process.env);
  const startupLoginStartMs = Date.now();
  const token = String(process.env.DISCORD_TOKEN ?? "").trim();
  const tokenPresent = token.length > 0;
  let firstFailureMs: number | null = null;
  let totalFailures = 0;
  console.log(
    `[startup:login] start ${formatStartupLogFields({
      base_backoff_ms: retryConfig.baseBackoffMs,
      max_backoff_ms: retryConfig.maxBackoffMs,
      rest_timeout_ms: discordRestTimeoutMs,
      retry_summary_every: summaryEvery,
      token_present: tokenPresent,
    })}`
  );

  const result = await runWithTransientRetry<string>({
    execute: async () => {
      if (!token) {
        throw new Error("MISSING_DISCORD_TOKEN");
      }
      return client.login(token);
    },
    config: retryConfig,
    isTransientError: isTransientRegistrationError,
    onFailure: (context) => {
      totalFailures += 1;
      const now = Date.now();
      if (firstFailureMs === null) firstFailureMs = now;
      const diagnostics = getStartupErrorDiagnostics(context.error);
      const baseLog = formatStartupLogFields({
        attempt: context.attempt,
        backoff_ms: context.backoffMs ?? 0,
        elapsed_ms: now - startupLoginStartMs,
        next_attempt: context.willRetry ? context.attempt + 1 : 0,
        rest_timeout_ms: discordRestTimeoutMs,
        token_present: tokenPresent,
        total_failures: totalFailures,
        transient: context.transient,
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
      });
      if (context.willRetry && context.backoffMs !== null) {
        console.warn(`[startup:login] retry ${baseLog}`);
        if (shouldEmitStartupRetrySummary(totalFailures, summaryEvery)) {
          console.warn(
            `[startup:login] retry_summary ${formatStartupLogFields({
              every: summaryEvery,
              first_failure_ms_ago: firstFailureMs === null ? 0 : now - firstFailureMs,
              last_error_code: diagnostics.code,
              last_error_name: diagnostics.name,
              last_error_reason: diagnostics.transientReason,
              retries: totalFailures,
              since_start_ms: now - startupLoginStartMs,
            })}`
          );
        }
        return;
      }

      console.error(`[startup:login] fatal_non_transient ${baseLog}`);
    },
  });

  if (result.status === "success") {
    console.log(
      `[startup:login] success ${formatStartupLogFields({
        attempts: result.attempts,
        elapsed_ms: Date.now() - startupLoginStartMs,
        total_failures: totalFailures,
      })}`
    );
    return;
  }

  process.exit(1);
}

void loginWithRetry().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`[startup:login] fatal_non_transient error=${errorMessage}`);
  process.exit(1);
});
