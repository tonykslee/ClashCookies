const DEFAULT_WAR_EVENT_POLL_INTERVAL_MINUTES = 15;

function resolvePositiveMinutes(value: unknown, fallbackMinutes: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMinutes;
  }
  return parsed;
}

/** Purpose: resolve the war-event poll cadence from env with a safer bounded default. */
export function resolveWarEventPollIntervalMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const minutes = resolvePositiveMinutes(
    env.WAR_EVENT_LOG_POLL_INTERVAL_MINUTES ?? DEFAULT_WAR_EVENT_POLL_INTERVAL_MINUTES,
    DEFAULT_WAR_EVENT_POLL_INTERVAL_MINUTES,
  );
  return minutes * 60_000;
}

/** Purpose: expose the current default for docs/tests without duplicating the constant. */
export function getDefaultWarEventPollIntervalMinutes(): number {
  return DEFAULT_WAR_EVENT_POLL_INTERVAL_MINUTES;
}
