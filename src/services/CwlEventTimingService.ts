export type PersistedCwlEventTiming = {
  eventInstanceId: string;
  startsAt: Date | null;
  endsAt: Date | null;
  coverageThrough: Date | null;
  startResolved: boolean;
  endResolved: boolean;
};

export type CwlEventTimingDb = {
  currentCwlRound: { findMany: (args?: any) => Promise<any[]> };
  currentCwlPrepSnapshot: { findMany: (args?: any) => Promise<any[]> };
  cwlRoundHistory: { findMany: (args?: any) => Promise<any[]> };
};

/** Purpose: normalize only finite persisted Date values so malformed timing fails closed. */
function validDate(value: unknown): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

/** Purpose: identify the persisted terminal state required for a trustworthy Round 7 end. */
function isEndedCwlRoundState(value: unknown): boolean {
  return String(value ?? "").toLowerCase().includes("warended");
}

/** Purpose: choose the strongest lifecycle-known-through timestamp from one persisted round row. */
function rowCoverageThrough(row: any): Date | null {
  return validDate(row?.endTime) ?? validDate(row?.startTime) ?? validDate(row?.preparationStartTime);
}

/** Purpose: resolve event-owned CWL timing for all requested event instances in three bounded reads. */
export async function resolvePersistedCwlEventTimings(
  db: CwlEventTimingDb,
  eventInstanceIds: string[],
): Promise<Map<string, PersistedCwlEventTiming>> {
  const ids = [...new Set(eventInstanceIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  const timings = new Map<string, PersistedCwlEventTiming>();
  if (ids.length === 0) return timings;

  const where = { eventInstanceId: { in: ids } };
  const [currentRows, prepRows, historyRows] = await Promise.all([
    db.currentCwlRound.findMany({ where }),
    db.currentCwlPrepSnapshot.findMany({ where }),
    db.cwlRoundHistory.findMany({ where }),
  ]);
  const rowsByEvent = new Map<string, any[]>();
  for (const row of [...currentRows, ...prepRows, ...historyRows]) {
    const eventInstanceId = String(row?.eventInstanceId ?? "").trim();
    if (!eventInstanceId || !ids.includes(eventInstanceId)) continue;
    const rows = rowsByEvent.get(eventInstanceId) ?? [];
    rows.push(row);
    rowsByEvent.set(eventInstanceId, rows);
  }

  for (const eventInstanceId of ids) {
    const rows = rowsByEvent.get(eventInstanceId) ?? [];
    const roundOneRows = rows.filter((row) => Number(row?.roundDay) === 1);
    const startCandidates = roundOneRows
      .map((row) => validDate(row?.preparationStartTime) ?? validDate(row?.startTime))
      .filter((value): value is Date => value !== null);
    const endedRoundSevenRows = rows.filter(
      (row) => Number(row?.roundDay) === 7 && isEndedCwlRoundState(row?.roundState),
    );
    const endCandidates = endedRoundSevenRows
      .map((row) => validDate(row?.endTime))
      .filter((value): value is Date => value !== null);
    const coverageCandidates = rows
      .map(rowCoverageThrough)
      .filter((value): value is Date => value !== null);
    timings.set(eventInstanceId, {
      eventInstanceId,
      startsAt: startCandidates.length > 0
        ? new Date(Math.min(...startCandidates.map((value) => value.getTime())))
        : null,
      endsAt: endCandidates.length > 0
        ? new Date(Math.max(...endCandidates.map((value) => value.getTime())))
        : null,
      coverageThrough: coverageCandidates.length > 0
        ? new Date(Math.max(...coverageCandidates.map((value) => value.getTime())))
        : null,
      startResolved: startCandidates.length > 0,
      endResolved: endCandidates.length > 0,
    });
  }
  return timings;
}
