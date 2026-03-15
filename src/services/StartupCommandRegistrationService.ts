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

export type TransientRetryConfig = {
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxAttempts?: number;
};

export type TransientRetryFailureContext = {
  attempt: number;
  transient: boolean;
  willRetry: boolean;
  backoffMs: number | null;
  maxAttempts?: number;
  error: unknown;
};

export type RunWithTransientRetryInput<T> = {
  execute: () => Promise<T>;
  config: TransientRetryConfig;
  isTransientError?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onFailure?: (context: TransientRetryFailureContext) => void;
};

export type RunWithTransientRetryResult<T> =
  | { status: "success"; attempts: number; value: T }
  | { status: "failed"; attempts: number; transient: boolean; error: unknown };

export type StartupErrorDiagnostics = {
  code: string;
  name: string;
  message: string;
  causeCode: string;
  causeName: string;
  causeMessage: string;
  status: string;
  httpStatus: string;
  transientReason: string;
  stackHead: string;
};

const DEFAULT_REST_TIMEOUT_MS = 30_000;
const DEFAULT_REGISTRATION_MAX_ATTEMPTS = 3;
const DEFAULT_REGISTRATION_BASE_BACKOFF_MS = 2_000;
const DEFAULT_STARTUP_LOGIN_BASE_BACKOFF_MS = 2_000;
const DEFAULT_STARTUP_LOGIN_MAX_BACKOFF_MS = 60_000;
const DEFAULT_STARTUP_BOOTSTRAP_BASE_BACKOFF_MS = 2_000;
const DEFAULT_STARTUP_BOOTSTRAP_MAX_BACKOFF_MS = 60_000;
const DEFAULT_STARTUP_RETRY_LOG_SUMMARY_EVERY = 5;

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

/** Purpose: normalize startup diagnostic values to concise one-line strings. */
function sanitizeDiagnosticValue(input: unknown, maxLen = 180): string {
  const raw = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "none";
  const clipped = raw.length > maxLen ? `${raw.slice(0, maxLen - 3)}...` : raw;
  return clipped.replace(/"/g, "'");
}

/** Purpose: classify timeout/network aborts and return deterministic reason codes. */
function classifyTransientRegistrationError(
  error: unknown
): { transient: boolean; reason: string } {
  const code = String((error as { code?: string } | null | undefined)?.code ?? "").trim();
  const name = String((error as { name?: string } | null | undefined)?.name ?? "").trim();
  const message = String((error as { message?: string } | null | undefined)?.message ?? "").trim();
  const codeUpper = code.toUpperCase();
  const nameUpper = name.toUpperCase();
  const messageLower = message.toLowerCase();

  const codeReasons = new Set([
    "UND_ERR_ABORTED",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ENOTFOUND",
  ]);
  if (codeReasons.has(codeUpper)) {
    return { transient: true, reason: `code:${codeUpper}` };
  }
  if (nameUpper.includes("ABORT")) return { transient: true, reason: "name:ABORT" };
  if (nameUpper.includes("TIMEOUT")) return { transient: true, reason: "name:TIMEOUT" };
  if (messageLower.includes("request aborted")) {
    return { transient: true, reason: "message:request_aborted" };
  }
  if (messageLower.includes("aborterror")) {
    return { transient: true, reason: "message:aborterror" };
  }
  if (messageLower.includes("timed out")) {
    return { transient: true, reason: "message:timed_out" };
  }
  if (messageLower.includes("socket hang up")) {
    return { transient: true, reason: "message:socket_hang_up" };
  }
  return { transient: false, reason: "none" };
}

/** Purpose: classify timeout/network aborts as retryable Discord REST errors. */
export function isTransientRegistrationError(error: unknown): boolean {
  return classifyTransientRegistrationError(error).transient;
}

/** Purpose: normalize unknown startup errors into deterministic diagnostics. */
export function getStartupErrorDiagnostics(error: unknown): StartupErrorDiagnostics {
  const errObj = (error && typeof error === "object" ? error : null) as
    | Record<string, unknown>
    | null;
  const causeObj = (errObj?.cause && typeof errObj.cause === "object" ? errObj.cause : null) as
    | Record<string, unknown>
    | null;
  const transient = classifyTransientRegistrationError(error);
  const stackRaw = typeof errObj?.stack === "string" ? errObj.stack : "";
  const stackHead = stackRaw.length > 0 ? stackRaw.split("\n")[0] ?? "" : "";
  const fallbackMessage =
    typeof error === "string" || typeof error === "number" || typeof error === "boolean"
      ? error
      : errObj?.message;

  return {
    code: sanitizeDiagnosticValue(errObj?.code),
    name: sanitizeDiagnosticValue(errObj?.name),
    message: sanitizeDiagnosticValue(fallbackMessage),
    causeCode: sanitizeDiagnosticValue(causeObj?.code),
    causeName: sanitizeDiagnosticValue(causeObj?.name),
    causeMessage: sanitizeDiagnosticValue(causeObj?.message),
    status: sanitizeDiagnosticValue(errObj?.status),
    httpStatus: sanitizeDiagnosticValue(
      (errObj?.response as Record<string, unknown> | null | undefined)?.status
    ),
    transientReason: transient.reason,
    stackHead: sanitizeDiagnosticValue(stackHead),
  };
}

type StartupLogFieldValue = string | number | boolean | null | undefined;

/** Purpose: format startup log fields into deterministic key-value tokens. */
export function formatStartupLogFields(fields: Record<string, StartupLogFieldValue>): string {
  return Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (typeof value === "number") return `${key}=${Number.isFinite(value) ? value : 0}`;
      if (typeof value === "boolean") return `${key}=${value ? 1 : 0}`;
      return `${key}="${sanitizeDiagnosticValue(value)}"`;
    })
    .join(" ");
}

/** Purpose: parse retry-summary cadence for startup retry logs. */
export function getStartupRetryLogSummaryEveryFromEnv(env: NodeJS.ProcessEnv): number {
  return parsePositiveInt(
    env.STARTUP_RETRY_LOG_SUMMARY_EVERY,
    DEFAULT_STARTUP_RETRY_LOG_SUMMARY_EVERY
  );
}

/** Purpose: deterministically gate periodic startup retry summary emission. */
export function shouldEmitStartupRetrySummary(totalFailures: number, summaryEvery: number): boolean {
  if (!Number.isFinite(totalFailures) || totalFailures <= 0) return false;
  if (!Number.isFinite(summaryEvery) || summaryEvery <= 0) return false;
  return Math.floor(totalFailures) % Math.floor(summaryEvery) === 0;
}

/** Purpose: compute exponential backoff with a deterministic cap. */
function computeBackoffMs(config: TransientRetryConfig, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const candidate = config.baseBackoffMs * Math.pow(2, exponent);
  return Math.min(config.maxBackoffMs, Math.floor(candidate));
}

/** Purpose: run one async operation with transient-aware retry policy. */
export async function runWithTransientRetry<T>(
  input: RunWithTransientRetryInput<T>
): Promise<RunWithTransientRetryResult<T>> {
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
  const isTransient = input.isTransientError ?? isTransientRegistrationError;
  const maxAttempts =
    typeof input.config.maxAttempts === "number" && Number.isFinite(input.config.maxAttempts)
      ? Math.max(1, Math.floor(input.config.maxAttempts))
      : undefined;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = await input.execute();
      return { status: "success", attempts: attempt, value };
    } catch (error) {
      const transient = isTransient(error);
      const exhausted = typeof maxAttempts === "number" && attempt >= maxAttempts;
      const willRetry = transient && !exhausted;
      const backoffMs = willRetry ? computeBackoffMs(input.config, attempt) : null;

      input.onFailure?.({
        attempt,
        transient,
        willRetry,
        backoffMs,
        maxAttempts,
        error,
      });

      if (!willRetry) {
        return {
          status: "failed",
          attempts: attempt,
          transient,
          error,
        };
      }

      await sleep(backoffMs ?? 0);
    }
  }
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

/** Purpose: load startup login retry backoff config from env. */
export function getStartupLoginRetryConfigFromEnv(env: NodeJS.ProcessEnv): TransientRetryConfig {
  const baseBackoffMs = parsePositiveInt(
    env.STARTUP_LOGIN_BASE_BACKOFF_MS,
    DEFAULT_STARTUP_LOGIN_BASE_BACKOFF_MS
  );
  const maxBackoffMs = parsePositiveInt(
    env.STARTUP_LOGIN_MAX_BACKOFF_MS,
    DEFAULT_STARTUP_LOGIN_MAX_BACKOFF_MS
  );
  return {
    baseBackoffMs,
    maxBackoffMs: Math.max(baseBackoffMs, maxBackoffMs),
  };
}

/** Purpose: load startup bootstrap retry backoff config from env. */
export function getStartupBootstrapRetryConfigFromEnv(
  env: NodeJS.ProcessEnv
): TransientRetryConfig {
  const baseBackoffMs = parsePositiveInt(
    env.STARTUP_BOOTSTRAP_BASE_BACKOFF_MS,
    DEFAULT_STARTUP_BOOTSTRAP_BASE_BACKOFF_MS
  );
  const maxBackoffMs = parsePositiveInt(
    env.STARTUP_BOOTSTRAP_MAX_BACKOFF_MS,
    DEFAULT_STARTUP_BOOTSTRAP_MAX_BACKOFF_MS
  );
  return {
    baseBackoffMs,
    maxBackoffMs: Math.max(baseBackoffMs, maxBackoffMs),
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

  if (!input.config.enabled) {
    logger.warn?.("[startup:commands] registration skipped (STARTUP_REGISTER_GUILD_COMMANDS=false)");
    return { status: "skipped" };
  }

  logger.info?.(
    `[startup:commands] registration start attempts=${input.config.maxAttempts} payload_count=${input.commands.length}`
  );

  const maxBackoffMs = input.config.baseBackoffMs * Math.pow(2, Math.max(0, input.config.maxAttempts - 1));
  const result = await runWithTransientRetry<unknown>({
    execute: () => input.guild.commands.set(input.commands),
    config: {
      baseBackoffMs: input.config.baseBackoffMs,
      maxBackoffMs,
      maxAttempts: input.config.maxAttempts,
    },
    sleep: input.sleep,
    isTransientError: isTransientRegistrationError,
    onFailure: (context) => {
      const errorMessage =
        context.error instanceof Error ? context.error.message : String(context.error);
      logger.error?.(
        `[startup:commands] registration failed attempt=${context.attempt}/${context.maxAttempts ?? "inf"} transient=${
          context.transient ? 1 : 0
        } error=${errorMessage}`
      );
      if (context.willRetry && context.backoffMs !== null) {
        logger.warn?.(
          `[startup:commands] retrying registration in ${context.backoffMs}ms attempt=${
            context.attempt + 1
          }`
        );
      }
    },
  });

  if (result.status === "success") {
    logger.info?.(`[startup:commands] registration success attempt=${result.attempts}`);
    return { status: "success", attempts: result.attempts };
  }

  logger.warn?.(
    "[startup:commands] continuing startup in degraded mode (command registration unavailable)"
  );
  return { status: "failed", attempts: result.attempts, error: result.error };
}
