type LoggerLike = {
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
};

type GuildCommandRegistrar = {
  commands: {
    set: (commands: any[]) => Promise<unknown>;
  };
};

export type CommandRegistrationConfig = {
  enabled: boolean;
  maxAttempts: number;
  baseBackoffMs: number;
};

export type CommandRegistrationResult =
  | { status: "skipped" }
  | { status: "success"; attempts: number }
  | { status: "failed"; attempts: number; error: unknown };

export type RegisterGuildCommandsInput = {
  guild: GuildCommandRegistrar;
  commands: unknown[];
  config: CommandRegistrationConfig;
  logger?: LoggerLike;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_REST_TIMEOUT_MS = 30_000;
const DEFAULT_REGISTRATION_MAX_ATTEMPTS = 3;
const DEFAULT_REGISTRATION_BASE_BACKOFF_MS = 2_000;

/** Purpose: parse an env flag into a deterministic boolean. */
function parseBoolean(input: string | undefined, fallback: boolean): boolean {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/** Purpose: parse a positive integer from env with deterministic fallback. */
function parsePositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number(input ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** Purpose: classify timeout/network aborts as retryable registration errors. */
export function isTransientRegistrationError(error: unknown): boolean {
  const code = String((error as { code?: string } | null | undefined)?.code ?? "").trim();
  const name = String((error as { name?: string } | null | undefined)?.name ?? "").trim();
  const message = String((error as { message?: string } | null | undefined)?.message ?? "").trim();
  const codeUpper = code.toUpperCase();
  const nameUpper = name.toUpperCase();
  const messageLower = message.toLowerCase();

  if (
    ["UND_ERR_ABORTED", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"].includes(
      codeUpper
    )
  ) {
    return true;
  }
  if (nameUpper.includes("ABORT") || nameUpper.includes("TIMEOUT")) return true;
  if (
    messageLower.includes("request aborted") ||
    messageLower.includes("aborterror") ||
    messageLower.includes("timed out") ||
    messageLower.includes("socket hang up")
  ) {
    return true;
  }
  return false;
}

/** Purpose: load command registration retry config from process env. */
export function getCommandRegistrationConfigFromEnv(
  env: NodeJS.ProcessEnv
): CommandRegistrationConfig {
  return {
    enabled: parseBoolean(env.STARTUP_REGISTER_GUILD_COMMANDS, true),
    maxAttempts: parsePositiveInt(
      env.STARTUP_COMMAND_REGISTRATION_MAX_ATTEMPTS,
      DEFAULT_REGISTRATION_MAX_ATTEMPTS
    ),
    baseBackoffMs: parsePositiveInt(
      env.STARTUP_COMMAND_REGISTRATION_BASE_BACKOFF_MS,
      DEFAULT_REGISTRATION_BASE_BACKOFF_MS
    ),
  };
}

/** Purpose: load Discord REST timeout from env with safe fallback. */
export function getDiscordRestTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  return parsePositiveInt(env.DISCORD_REST_TIMEOUT_MS, DEFAULT_REST_TIMEOUT_MS);
}

/** Purpose: perform bounded retry registration and return a non-throwing result. */
export async function registerGuildCommandsWithRetry(
  input: RegisterGuildCommandsInput
): Promise<CommandRegistrationResult> {
  const logger = input.logger ?? console;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));

  if (!input.config.enabled) {
    logger.warn?.("[startup:commands] registration skipped (STARTUP_REGISTER_GUILD_COMMANDS=false)");
    return { status: "skipped" };
  }

  logger.info?.(
    `[startup:commands] registration start attempts=${input.config.maxAttempts} payload_count=${input.commands.length}`
  );

  for (let attempt = 1; attempt <= input.config.maxAttempts; attempt += 1) {
    try {
      await input.guild.commands.set(input.commands);
      logger.info?.(`[startup:commands] registration success attempt=${attempt}`);
      return { status: "success", attempts: attempt };
    } catch (error) {
      const transient = isTransientRegistrationError(error);
      logger.error?.(
        `[startup:commands] registration failed attempt=${attempt}/${input.config.maxAttempts} transient=${
          transient ? 1 : 0
        } error=${error instanceof Error ? error.message : String(error)}`
      );

      const finalAttempt = attempt >= input.config.maxAttempts;
      if (!transient || finalAttempt) {
        logger.warn?.(
          "[startup:commands] continuing startup in degraded mode (command registration unavailable)"
        );
        return { status: "failed", attempts: attempt, error };
      }

      const backoffMs = input.config.baseBackoffMs * Math.pow(2, attempt - 1);
      logger.warn?.(
        `[startup:commands] retrying registration in ${backoffMs}ms attempt=${attempt + 1}`
      );
      await sleep(backoffMs);
    }
  }

  const fallbackError = new Error("Registration failed without explicit error.");
  logger.warn?.("[startup:commands] continuing startup in degraded mode (fallback terminal path)");
  return { status: "failed", attempts: input.config.maxAttempts, error: fallbackError };
}
