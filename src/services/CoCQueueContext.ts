import { AsyncLocalStorage } from "node:async_hooks";

export type CoCQueuePriority = "interactive" | "background";

export type CoCQueueContext = {
  priority: CoCQueuePriority;
  source: string;
  scheduledAtMs?: number | null;
  nextScheduledAtMs?: number | null;
  freshnessDeadlineMs?: number | null;
};

const cocQueueContextStorage = new AsyncLocalStorage<CoCQueueContext>();

function normalizeOptionalTimestamp(value: number | null | undefined): number | undefined {
  if (!Number.isFinite(value ?? NaN)) return undefined;
  return Math.max(0, Math.trunc(Number(value)));
}

/** Purpose: run one async flow with explicit CoC queue priority/source classification. */
export async function runWithCoCQueueContext<T>(
  context: CoCQueueContext,
  run: () => Promise<T>,
): Promise<T> {
  const source = String(context.source ?? "").trim();
  if (!source) {
    throw new Error("COC_QUEUE_CONTEXT_SOURCE_REQUIRED");
  }

  return cocQueueContextStorage.run(
    {
      priority: context.priority,
      source,
      scheduledAtMs: normalizeOptionalTimestamp(context.scheduledAtMs),
      nextScheduledAtMs: normalizeOptionalTimestamp(context.nextScheduledAtMs),
      freshnessDeadlineMs: normalizeOptionalTimestamp(context.freshnessDeadlineMs),
    },
    run,
  );
}

/** Purpose: read the active CoC queue classification for the current async flow. */
export function getCoCQueueContext(): CoCQueueContext | null {
  return cocQueueContextStorage.getStore() ?? null;
}
