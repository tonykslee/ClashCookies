let nextWarMailRefreshAtMs: number | null = null;
let nextNotifyRefreshAtMs: number | null = null;

export function setNextWarMailRefreshAtMs(nextAtMs: number): void {
  nextWarMailRefreshAtMs = Number.isFinite(nextAtMs) ? Math.trunc(nextAtMs) : null;
}

export function getNextWarMailRefreshAtMs(): number | null {
  return nextWarMailRefreshAtMs;
}

export function setNextNotifyRefreshAtMs(nextAtMs: number): void {
  nextNotifyRefreshAtMs = Number.isFinite(nextAtMs) ? Math.trunc(nextAtMs) : null;
}

export function getNextNotifyRefreshAtMs(): number | null {
  return nextNotifyRefreshAtMs;
}

