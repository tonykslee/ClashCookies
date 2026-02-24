type FetchSource = "api" | "web" | "cache_hit" | "cache_miss" | "fallback_cache";

type FetchEvent = {
  namespace: string;
  operation: string;
  source: FetchSource;
  detail?: string;
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
  const eventKey = `${event.namespace}:${event.operation}:${event.source}`;
  const opKey = `${event.namespace}:${event.operation}`;

  const nextEventCount = (eventCounts.get(eventKey) ?? 0) + 1;
  eventCounts.set(eventKey, nextEventCount);

  const totals = operationTotals.get(opKey) ?? makeEmptyTotals();
  totals[event.source] += 1;
  operationTotals.set(opKey, totals);

  const savedCalls = totals.cache_hit + totals.fallback_cache;
  const suffix = event.detail ? ` ${event.detail}` : "";
  console.info(
    `[telemetry] ns=${event.namespace} op=${event.operation} source=${event.source} count=${nextEventCount} totals(api=${totals.api}, web=${totals.web}, cache_hit=${totals.cache_hit}, cache_miss=${totals.cache_miss}, fallback_cache=${totals.fallback_cache}, saved=${savedCalls})${suffix}`
  );
}

