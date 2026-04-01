export type PollingMode = "active" | "mirror";
export type RuntimeEnvironment = "prod" | "staging" | "dev" | "unknown";

const DEFAULT_MIRROR_SYNC_INTERVAL_MINUTES = 15;
const MIN_MIRROR_SYNC_INTERVAL_MINUTES = 1;

/** Purpose: normalize polling mode env input into one stable runtime mode. */
export function resolvePollingMode(
  env: NodeJS.ProcessEnv = process.env,
): PollingMode {
  const raw = String(env.POLLING_MODE ?? "active")
    .trim()
    .toLowerCase();
  return raw === "mirror" ? "mirror" : "active";
}

/** Purpose: expose explicit active-poller ownership check used by startup schedulers. */
export function isActivePollingMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolvePollingMode(env) === "active";
}

/** Purpose: expose explicit mirror-mode ownership check used by sync schedulers/services. */
export function isMirrorPollingMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolvePollingMode(env) === "mirror";
}

/** Purpose: resolve mirror-sync interval with a guarded minimum to avoid tight-loop retries. */
export function resolveMirrorSyncIntervalMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsedMinutes = Number(env.MIRROR_SYNC_INTERVAL_MINUTES);
  const minutes = Number.isFinite(parsedMinutes)
    ? Math.max(MIN_MIRROR_SYNC_INTERVAL_MINUTES, Math.trunc(parsedMinutes))
    : DEFAULT_MIRROR_SYNC_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

/** Purpose: normalize runtime environment labels for mirror safety checks and observability. */
export function resolveRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeEnvironment {
  const candidates = [
    env.POLLING_ENV,
    env.DEPLOY_ENV,
    env.APP_ENV,
    env.ENVIRONMENT,
    env.NODE_ENV,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "")
      .trim()
      .toLowerCase();
    if (!normalized) continue;
    if (["prod", "production", "live"].includes(normalized)) return "prod";
    if (["staging", "stage", "stg", "preprod", "pre-prod"].includes(normalized)) {
      return "staging";
    }
    if (["dev", "development", "local", "test"].includes(normalized)) return "dev";
  }
  return "unknown";
}

/** Purpose: parse postgres connection URLs into sanitized DB names for structured logs only. */
export function resolveDatabaseNameFromUrlForLog(url: string | null): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "unknown";
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/^\/+/, "");
    return pathname ? decodeURIComponent(pathname) : "unknown";
  } catch {
    return "unknown";
  }
}

