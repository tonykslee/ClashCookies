type FetchSource = "api" | "web" | "cache_hit" | "cache_miss" | "fallback_cache";

type FetchEvent = {
  namespace: string;
  operation: string;
  source: FetchSource;
  detail?: string;
  incrementBy?: number;
};

type Totals = Record<FetchSource, number>;

const eventCounts = new Map<string, number>();
const operationTotals = new Map<string, Totals>();

function makeEmptyTotals(): Totals {
  return {
    api: 0,
    web: 0,
    cache_hit: 0,
    cache_miss: 0,
    fallback_cache: 0,
  };
}

export function recordFetchEvent(event: FetchEvent): void {
  const incrementBy = Math.max(1, Math.trunc(event.incrementBy ?? 1));
  const eventKey = `${event.namespace}:${event.operation}:${event.source}`;
  const opKey = `${event.namespace}:${event.operation}`;

  const nextEventCount = (eventCounts.get(eventKey) ?? 0) + incrementBy;
  eventCounts.set(eventKey, nextEventCount);

  const totals = operationTotals.get(opKey) ?? makeEmptyTotals();
  totals[event.source] += incrementBy;
  operationTotals.set(opKey, totals);

  const savedCalls = totals.cache_hit + totals.fallback_cache;
  const suffix = event.detail ? ` ${event.detail}` : "";
  console.info(
    `[telemetry] ns=${event.namespace} op=${event.operation} source=${event.source} count=${nextEventCount} +${incrementBy} totals(api=${totals.api}, web=${totals.web}, cache_hit=${totals.cache_hit}, cache_miss=${totals.cache_miss}, fallback_cache=${totals.fallback_cache}, saved=${savedCalls})${suffix}`
  );
}
