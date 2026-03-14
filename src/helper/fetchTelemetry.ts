import { AsyncLocalStorage } from "node:async_hooks";
import { hasInitializedPrismaClient, prisma } from "../prisma";
import { TelemetryIngestService } from "../services/telemetry/ingest";

type FetchSource = "api" | "web" | "cache_hit" | "cache_miss" | "fallback_cache";

type FetchEvent = {
  namespace: string;
  operation: string;
  source: FetchSource;
  detail?: string;
  incrementBy?: number;
  durationMs?: number;
  status?: "success" | "failure";
  errorCategory?: string;
  errorCode?: string;
  timeout?: boolean;
};

type Totals = Record<FetchSource, number>;

const eventCounts = new Map<string, number>();
const operationTotals = new Map<string, Totals>();
const fetchLogEveryN = Math.max(1, Number(process.env.FETCH_TELEMETRY_LOG_EVERY_N ?? 25));
const telemetryBatchStorage = new AsyncLocalStorage<{
  job: string;
  startedAtMs: number;
  operationTotals: Map<string, Totals>;
}>();
let apiUsagePersistenceDisabled = false;

function makeEmptyTotals(): Totals {
  return {
    api: 0,
    web: 0,
    cache_hit: 0,
    cache_miss: 0,
    fallback_cache: 0,
  };
}

function formatTotals(totals: Totals): string {
  const savedCalls = totals.cache_hit + totals.fallback_cache;
  return `api=${totals.api}, web=${totals.web}, cache_hit=${totals.cache_hit}, cache_miss=${totals.cache_miss}, fallback_cache=${totals.fallback_cache}, saved=${savedCalls}`;
}

function mergeTotals(target: Totals, source: Totals): void {
  target.api += source.api;
  target.web += source.web;
  target.cache_hit += source.cache_hit;
  target.cache_miss += source.cache_miss;
  target.fallback_cache += source.fallback_cache;
}

function getOrCreateTotals(map: Map<string, Totals>, key: string): Totals {
  const existing = map.get(key);
  if (existing) return existing;
  const created = makeEmptyTotals();
  map.set(key, created);
  return created;
}

/** Purpose: determine whether a value supports Promise-style rejection handling. */
function isPromiseLike(value: unknown): value is Promise<unknown> {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

function trackApiUsage(endpoint: string, incrementBy: number): void {
  if (apiUsagePersistenceDisabled) return;
  if (!hasInitializedPrismaClient()) return;

  try {
    const maybePromise = prisma.apiUsage.upsert({
      where: { endpoint },
      create: {
        endpoint,
        lastCall: new Date(),
        callCount: incrementBy,
      },
      update: {
        lastCall: new Date(),
        callCount: { increment: incrementBy },
      },
    });
    if (isPromiseLike(maybePromise)) {
      void maybePromise.catch(() => undefined);
    }
  } catch (error) {
    apiUsagePersistenceDisabled = true;
    const message = String((error as { message?: string } | null)?.message ?? error);
    console.warn(`[telemetry] apiUsage persistence disabled reason=${message}`);
  }
}

export async function runFetchTelemetryBatch<T>(
  job: string,
  run: () => Promise<T>
): Promise<T> {
  const active = telemetryBatchStorage.getStore();
  if (active) {
    return run();
  }

  const store = {
    job,
    startedAtMs: Date.now(),
    operationTotals: new Map<string, Totals>(),
  };

  let output: T | undefined;
  await telemetryBatchStorage.run(store, async () => {
    try {
      output = await run();
    } finally {
      if (store.operationTotals.size === 0) return;

      const durationMs = Date.now() - store.startedAtMs;
      const overall = makeEmptyTotals();
      const opDetails: string[] = [];

      const sortedOps = [...store.operationTotals.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      );
      for (const [opKey, totals] of sortedOps) {
        mergeTotals(overall, totals);
        opDetails.push(`${opKey}{${formatTotals(totals)}}`);
      }

      console.info(
        `[telemetry-job] job=${store.job} duration_ms=${durationMs} operations=${store.operationTotals.size} totals(${formatTotals(
          overall
        )}) details=${opDetails.join("; ")}`
      );
    }
  });
  return output as T;
}

export function recordFetchEvent(event: FetchEvent): void {
  const incrementBy = Math.max(1, Math.trunc(event.incrementBy ?? 1));
  const eventKey = `${event.namespace}:${event.operation}:${event.source}`;
  const opKey = `${event.namespace}:${event.operation}`;
  const isFailure =
    event.status === "failure" ||
    !!event.errorCategory ||
    !!event.errorCode ||
    !!event.timeout;

  const nextEventCount = (eventCounts.get(eventKey) ?? 0) + incrementBy;
  eventCounts.set(eventKey, nextEventCount);

  const totals = getOrCreateTotals(operationTotals, opKey);
  totals[event.source] += incrementBy;
  if (event.source === "api" || event.source === "web") {
    trackApiUsage(`${event.namespace}:${event.operation}`, incrementBy);
  }
  const ingest = TelemetryIngestService.getInstance();
  ingest.recordFetchEventTelemetry({
    namespace: event.namespace,
    operation: event.operation,
    source: event.source,
    detail: event.detail,
    durationMs: event.durationMs,
    status: event.status,
    errorCategory: event.errorCategory,
    errorCode: event.errorCode,
    timeout: event.timeout,
  });

  const batch = telemetryBatchStorage.getStore();
  if (batch) {
    const batchTotals = getOrCreateTotals(batch.operationTotals, opKey);
    batchTotals[event.source] += incrementBy;
    return;
  }

  if (!isFailure && nextEventCount % fetchLogEveryN !== 0) {
    return;
  }
  const savedCalls = totals.cache_hit + totals.fallback_cache;
  const suffix = event.detail ? ` ${event.detail}` : "";
  console.info(
    `[telemetry] ns=${event.namespace} op=${event.operation} source=${event.source} count=${nextEventCount} +${incrementBy} totals(api=${totals.api}, web=${totals.web}, cache_hit=${totals.cache_hit}, cache_miss=${totals.cache_miss}, fallback_cache=${totals.fallback_cache}, saved=${savedCalls})${suffix}`
  );
}
