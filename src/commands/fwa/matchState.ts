export type WarStateForSync = "preparation" | "inWar" | "notInWar";

export const MISSED_SYNC_WINDOW_MS = 2 * 60 * 60 * 1000;

type PointsSnapshotLike = {
  winnerBoxTags: string[];
  winnerBoxSync: number | null;
  headerPrimaryTag: string | null;
  headerOpponentTag: string | null;
  headerPrimaryBalance: number | null;
  headerOpponentBalance: number | null;
};

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function parseCocApiTime(input: string | null | undefined): number | null {
  if (!input) return null;
  const match = input.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/
  );
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
}

function getSyncModeFromPrevious(previousSync: number | null): "high" | "low" | null {
  if (previousSync === null) return null;
  return (previousSync + 1) % 2 === 0 ? "high" : "low";
}

export function deriveWarState(rawState: string | null | undefined): WarStateForSync {
  const state = String(rawState ?? "").toLowerCase();
  if (state.includes("preparation")) return "preparation";
  if (state.includes("inwar")) return "inWar";
  return "notInWar";
}

export function getCurrentSyncFromPrevious(
  previousSync: number | null,
  warState: WarStateForSync
): number | null {
  if (previousSync === null) return null;
  if (warState === "notInWar") return null;
  return previousSync + 1;
}

export function getSyncDisplay(
  previousSync: number | null,
  warState: WarStateForSync
): string {
  if (previousSync === null) return "unknown";
  const current = previousSync + 1;
  if (warState === "notInWar") {
    return `between #${previousSync} and #${current}`;
  }
  return `#${current}`;
}

export function withSyncModeLabel(syncText: string, previousSync: number | null): string {
  const mode = getSyncModeFromPrevious(previousSync);
  if (!mode) return syncText;
  return `${syncText} (${mode === "high" ? "High Sync" : "Low Sync"})`;
}

export function formatWarStateLabel(warState: WarStateForSync): string {
  if (warState === "preparation") return "preparation";
  if (warState === "inWar") return "battle day";
  return "no war";
}

export function formatMatchTypeLabel(
  matchType: "FWA" | "BL" | "MM" | "UNKNOWN",
  inferred: boolean
): string {
  if (!inferred) return matchType;
  return `${matchType} \u26A0\uFE0F`;
}

export function isPointsSiteUpdatedForOpponent(
  primary: PointsSnapshotLike,
  opponentTag: string,
  previousSync: number | null
): boolean {
  const normalizedOpponent = normalizeTag(opponentTag);
  const hasOpponent = primary.winnerBoxTags.map((t) => normalizeTag(t)).includes(normalizedOpponent);
  if (!hasOpponent) return false;
  if (
    previousSync !== null &&
    primary.winnerBoxSync !== null &&
    Number.isFinite(primary.winnerBoxSync) &&
    primary.winnerBoxSync <= previousSync
  ) {
    return false;
  }
  return true;
}

export function deriveOpponentBalanceFromPrimarySnapshot(
  primary: PointsSnapshotLike,
  primaryTag: string,
  opponentTag: string
): number | null {
  const normalizedPrimary = normalizeTag(primaryTag);
  const normalizedOpponent = normalizeTag(opponentTag);
  if (
    primary.headerPrimaryTag === normalizedPrimary &&
    primary.headerOpponentTag === normalizedOpponent
  ) {
    return primary.headerOpponentBalance;
  }
  if (
    primary.headerPrimaryTag === normalizedOpponent &&
    primary.headerOpponentTag === normalizedPrimary
  ) {
    return primary.headerPrimaryBalance;
  }
  return null;
}

export function buildPointsMismatchWarning(
  label: string,
  expected: number | null | undefined,
  actual: number | null | undefined
): string | null {
  if (
    expected === null ||
    expected === undefined ||
    actual === null ||
    actual === undefined ||
    Number.isNaN(expected) ||
    Number.isNaN(actual)
  ) {
    return null;
  }
  if (expected === actual) return null;
  return `\u26A0\uFE0F ${label} points mismatch: expected ${expected}, site ${actual}.`;
}

export function buildSyncMismatchWarning(
  expectedSync: number | null | undefined,
  siteSync: number | null | undefined
): string | null {
  if (
    expectedSync === null ||
    expectedSync === undefined ||
    siteSync === null ||
    siteSync === undefined ||
    Number.isNaN(expectedSync) ||
    Number.isNaN(siteSync)
  ) {
    return null;
  }
  if (expectedSync === siteSync) return null;
  return `\u26A0\uFE0F Sync # mismatch: expected #${expectedSync}, site #${siteSync}.`;
}

export function buildOutcomeMismatchWarning(
  expectedOutcome: "WIN" | "LOSE" | null | undefined,
  siteOutcome: "WIN" | "LOSE" | null | undefined
): string | null {
  if (!siteOutcome) return null;
  if (expectedOutcome === siteOutcome) return null;
  return `\u26A0\uFE0F Outcome mismatch: expected ${expectedOutcome ?? "UNKNOWN"}, site ${siteOutcome}.`;
}

export function buildPointsSyncStatusLine(siteUpdated: boolean, hasMismatch: boolean): string {
  if (!siteUpdated) {
    return ":hourglass_flowing_sand: points.fwafarm is not updated for this matchup yet.";
  }
  if (hasMismatch) {
    return ":broken_chain: out of sync with points site";
  }
  return ":white_check_mark: data in sync with points.fwafarm";
}

export function getWarStateRemaining(
  war: { startTime?: string | null; endTime?: string | null } | null | undefined,
  warState: WarStateForSync
): string {
  if (warState === "notInWar") return "n/a";
  const startMs = parseCocApiTime(war?.startTime);
  const endMs = parseCocApiTime(war?.endTime);
  const targetMs = warState === "preparation" ? startMs : endMs;
  if (targetMs === null || !Number.isFinite(targetMs)) return "unknown";
  return `<t:${Math.floor(targetMs / 1000)}:R>`;
}

export function isMissedSyncClan(input: {
  baselineWarStartMs: number | null;
  clanWarState: WarStateForSync;
  clanWarStartMs: number | null;
  nowMs: number;
}): boolean {
  const { baselineWarStartMs, clanWarState, clanWarStartMs, nowMs } = input;
  if (baselineWarStartMs === null || !Number.isFinite(baselineWarStartMs)) return false;
  const deadlineMs = baselineWarStartMs + MISSED_SYNC_WINDOW_MS;
  if (clanWarState === "notInWar") {
    return nowMs >= deadlineMs;
  }
  if (clanWarStartMs === null || !Number.isFinite(clanWarStartMs)) return false;
  return clanWarStartMs > deadlineMs;
}

export function isMissedSyncClanForTest(input: {
  baselineWarStartMs: number | null;
  clanWarState: WarStateForSync;
  clanWarStartMs: number | null;
  nowMs: number;
}): boolean {
  return isMissedSyncClan(input);
}
