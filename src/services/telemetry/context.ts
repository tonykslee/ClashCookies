import { AsyncLocalStorage } from "node:async_hooks";

export type TelemetryCommandContext = {
  runId: string;
  guildId: string;
  userId: string;
  commandName: string;
  subcommand: string;
  interactionId: string;
};

const telemetryContextStorage = new AsyncLocalStorage<TelemetryCommandContext>();

/** Purpose: execute a callback with command telemetry context bound via AsyncLocalStorage. */
export async function runWithTelemetryContext<T>(
  context: TelemetryCommandContext,
  run: () => Promise<T>
): Promise<T> {
  return telemetryContextStorage.run(context, run);
}

/** Purpose: get the current command telemetry context when one is active. */
export function getTelemetryContext(): TelemetryCommandContext | null {
  return telemetryContextStorage.getStore() ?? null;
}
