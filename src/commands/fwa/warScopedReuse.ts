export type WarScopedSyncReuseRow = {
  warId: string | null;
  warStartTime: Date;
  syncNum: number;
  opponentTag: string;
  clanPoints: number;
  opponentPoints: number;
  isFwa: boolean | null;
  needsValidation: boolean;
  lastSuccessfulPointsApiFetchAt: Date | null;
  syncFetchedAt: Date;
};

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function toSyncNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function isSameWarIdentity(input: {
  rowWarId: string | null;
  rowWarStartTime: Date;
  warId: string | null;
  warStartTime: Date | null;
}): boolean {
  if (input.warId) {
    return String(input.rowWarId ?? "") === String(input.warId);
  }
  if (input.warStartTime instanceof Date) {
    const targetMs = input.warStartTime.getTime();
    const rowMs = input.rowWarStartTime.getTime();
    return Number.isFinite(targetMs) && Number.isFinite(rowMs) && targetMs === rowMs;
  }
  return false;
}

/** Purpose: select a reusable ClanPointsSync row for the active war context and sync cycle. */
export function selectWarScopedReuseRow(input: {
  rows: WarScopedSyncReuseRow[];
  warId: string | null;
  warStartTime: Date | null;
  opponentTag: string;
  currentSyncNumber: number | null;
  sourceSyncNumber: number | null;
}): WarScopedSyncReuseRow | null {
  const opponentTag = normalizeTag(input.opponentTag);
  if (!opponentTag) return null;
  const currentSync = toSyncNumber(input.currentSyncNumber);
  const sourceSync = toSyncNumber(input.sourceSyncNumber);
  if (currentSync === null && sourceSync === null) return null;

  for (const row of input.rows) {
    if (row.needsValidation) continue;
    if (!isSameWarIdentity({
      rowWarId: row.warId,
      rowWarStartTime: row.warStartTime,
      warId: input.warId,
      warStartTime: input.warStartTime,
    })) {
      continue;
    }

    if (normalizeTag(row.opponentTag) !== opponentTag) continue;
    const rowSync = toSyncNumber(row.syncNum);
    const clanPoints = toSyncNumber(row.clanPoints);
    const opponentPoints = toSyncNumber(row.opponentPoints);
    if (rowSync === null || clanPoints === null || opponentPoints === null) continue;

    if (currentSync !== null && rowSync !== currentSync) continue;
    if (currentSync === null && sourceSync !== null && rowSync <= sourceSync) continue;

    return {
      ...row,
      syncNum: rowSync,
      clanPoints,
      opponentPoints,
    };
  }

  return null;
}
