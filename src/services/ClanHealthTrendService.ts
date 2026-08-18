import { prisma } from "../prisma";
import { normalizeClashTagBareInput } from "../helper/clashTag";

const SAFE_CLAN_TAG_BODY = /^[A-Z0-9]{1,15}$/;

export type ClanHealthTrendWindow =
  | { kind: "days"; days: number; cutoff: Date }
  | {
      kind: "syncs";
      requestedSyncCount: number;
      startSyncNumber: number;
      endSyncNumber: number;
      syncNumbers: readonly number[];
    };

export type ClanHealthTrendInput = {
  guildId: string;
  clanTag: string;
  window: ClanHealthTrendWindow;
  now: Date;
};

export type ClanHealthTrendSnapshot = {
  guildId: string;
  syncTime: Date;
  clanTag: string;
  clanName: string | null;
  memberCount: number;
  unresolvedWeightCount: number;
  deviationScore: number | null;
  projectionComplete: boolean;
  algorithmVersion: string;
  fillerCaptureComplete: boolean;
  fillerPlayerTags: string[];
  syncNumber: number | null;
};

export type ClanHealthTrendReport = {
  guildId: string;
  clanTag: string;
  clanName: string | null;
  window: ClanHealthTrendWindow;
  cutoff: Date;
  now: Date;
  snapshots: ClanHealthTrendSnapshot[];
  displayedSnapshots: ClanHealthTrendSnapshot[];
  coverage: {
    total: number;
    oldestSyncTime: Date | null;
    newestSyncTime: Date | null;
  };
  deviation: {
    validCount: number;
    oldest: number | null;
    latest: number | null;
    change: number | null;
    direction: "improved" | "worsened" | "unchanged" | null;
    average: number | null;
    best: number | null;
    worst: number | null;
  };
  roster: {
    oldest: number | null;
    latest: number | null;
    delta: number | null;
    average: number | null;
    fullCount: number;
  };
  unresolved: {
    oldest: number | null;
    latest: number | null;
    average: number | null;
  };
  fillers: {
    knownOldest: number | null;
    knownLatest: number | null;
    averageKnown: number | null;
    knownCount: number;
  };
  algorithmVersions: string[];
};

type ClanHealthTrendDb = {
  syncClanReadinessSnapshot?: {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  syncCycle?: {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
};

/** Purpose: normalize a bounded clan tag while preserving the navigation tag contract. */
function normalizeTrendClanTag(input: unknown): string {
  const bare = normalizeClashTagBareInput(String(input ?? ""));
  return SAFE_CLAN_TAG_BODY.test(bare) ? `#${bare}` : "";
}

/** Purpose: accept only finite dates from persisted or caller-provided trend inputs. */
function toValidDate(input: unknown): Date | null {
  const date = input instanceof Date ? new Date(input) : new Date(String(input ?? ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Purpose: normalize a finite non-negative persisted metric without inventing historical evidence. */
function normalizeNonNegativeMetric(input: unknown): number {
  const value = Number(input);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Purpose: normalize a persisted readiness snapshot into the trend report shape. */
function normalizeSnapshot(input: unknown, clanTag: string): ClanHealthTrendSnapshot | null {
  const row = input as Record<string, unknown> | null;
  const syncTime = toValidDate(row?.syncTime);
  const rowClanTag = normalizeTrendClanTag(row?.clanTag);
  if (!syncTime || rowClanTag !== clanTag) return null;

  const rawDeviation =
    row?.deviationScore === null || row?.deviationScore === undefined || row?.deviationScore === ""
      ? null
      : Number(row.deviationScore);
  const algorithmVersion = String(row?.algorithmVersion ?? "").trim() || "unknown";
  const fillerPlayerTags = Array.isArray(row?.fillerPlayerTags)
    ? row.fillerPlayerTags
        .map((tag) => normalizeTrendClanTag(tag))
        .filter(Boolean)
    : [];
  const rawSyncNumber = Number(row?.syncNumber);

  return {
    guildId: String(row?.guildId ?? "").trim(),
    syncTime,
    clanTag,
    clanName: String(row?.clanName ?? "").trim() || null,
    memberCount: normalizeNonNegativeMetric(row?.memberCount),
    unresolvedWeightCount: normalizeNonNegativeMetric(row?.unresolvedWeightCount),
    deviationScore: rawDeviation !== null && Number.isFinite(rawDeviation) ? rawDeviation : null,
    projectionComplete: row?.projectionComplete === true,
    algorithmVersion,
    fillerCaptureComplete: row?.fillerCaptureComplete === true,
    fillerPlayerTags: [...new Set(fillerPlayerTags)],
    syncNumber: Number.isInteger(rawSyncNumber) && rawSyncNumber > 0 ? rawSyncNumber : null,
  };
}

/** Purpose: build an empty report while preserving the selected clan and bounded window inputs. */
function emptyReport(input: {
  guildId: string;
  clanTag: string;
  window: ClanHealthTrendWindow;
  now: Date;
}): ClanHealthTrendReport {
  return {
    guildId: input.guildId,
    clanTag: input.clanTag,
    clanName: null,
    window: input.window,
    cutoff: input.window.kind === "days" ? input.window.cutoff : new Date(0),
    now: input.now,
    snapshots: [],
    displayedSnapshots: [],
    coverage: { total: 0, oldestSyncTime: null, newestSyncTime: null },
    deviation: {
      validCount: 0,
      oldest: null,
      latest: null,
      change: null,
      direction: null,
      average: null,
      best: null,
      worst: null,
    },
    roster: { oldest: null, latest: null, delta: null, average: null, fullCount: 0 },
    unresolved: { oldest: null, latest: null, average: null },
    fillers: { knownOldest: null, knownLatest: null, averageKnown: null, knownCount: 0 },
    algorithmVersions: [],
  };
}

/** Purpose: calculate averages without returning a misleading value for an empty series. */
function average(values: readonly number[]): number | null {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

/** Purpose: map each captured sync boundary to its canonical guild-scoped sync number in bulk. */
function mapSyncNumbers(
  snapshots: ClanHealthTrendSnapshot[],
  cycles: unknown[],
): void {
  const syncNumberByTime = new Map<number, number>();
  for (const cycle of cycles) {
    const row = cycle as Record<string, unknown> | null;
    const syncTime = toValidDate(row?.syncTime);
    const syncNumber = Number(row?.syncNumber);
    if (
      syncTime &&
      Number.isInteger(syncNumber) &&
      syncNumber > 0 &&
      !syncNumberByTime.has(syncTime.getTime())
    ) {
      syncNumberByTime.set(syncTime.getTime(), syncNumber);
    }
  }
  for (const snapshot of snapshots) {
    snapshot.syncNumber = syncNumberByTime.get(snapshot.syncTime.getTime()) ?? null;
  }
}

/** Purpose: derive all trend metrics from immutable snapshots in chronological order. */
function buildReport(input: {
  guildId: string;
  clanTag: string;
  window: ClanHealthTrendWindow;
  now: Date;
  snapshots: ClanHealthTrendSnapshot[];
}): ClanHealthTrendReport {
  const snapshots = [...input.snapshots].sort(
    (left, right) => right.syncTime.getTime() - left.syncTime.getTime(),
  );
  const chronological = [...snapshots].reverse();
  const validDeviation = chronological.filter(
    (snapshot) => snapshot.projectionComplete && snapshot.deviationScore !== null,
  );
  const deviationValues = validDeviation.map((snapshot) => snapshot.deviationScore as number);
  const oldestDeviation = validDeviation[0]?.deviationScore ?? null;
  const latestDeviation = validDeviation.at(-1)?.deviationScore ?? null;
  const deviationChange =
    oldestDeviation !== null && latestDeviation !== null && validDeviation.length >= 2
      ? latestDeviation - oldestDeviation
      : null;
  const deviationDirection =
    deviationChange === null
      ? null
      : deviationChange < 0
        ? "improved"
        : deviationChange > 0
          ? "worsened"
          : "unchanged";
  const memberCounts = chronological.map((snapshot) => snapshot.memberCount);
  const unresolvedCounts = chronological.map((snapshot) => snapshot.unresolvedWeightCount);
  const knownFillerCounts = chronological
    .filter((snapshot) => snapshot.fillerCaptureComplete)
    .map((snapshot) => snapshot.fillerPlayerTags.length);
  const algorithmVersions = [...new Set(snapshots.map((snapshot) => snapshot.algorithmVersion))].sort();

  return {
    guildId: input.guildId,
    clanTag: input.clanTag,
    clanName: snapshots.find((snapshot) => snapshot.clanName)?.clanName ?? null,
    window: input.window,
    cutoff: input.window.kind === "days" ? input.window.cutoff : new Date(0),
    now: input.now,
    snapshots,
    displayedSnapshots: snapshots.slice(0, 10),
    coverage: {
      total: snapshots.length,
      oldestSyncTime: chronological[0]?.syncTime ?? null,
      newestSyncTime: snapshots[0]?.syncTime ?? null,
    },
    deviation: {
      validCount: validDeviation.length,
      oldest: oldestDeviation,
      latest: latestDeviation,
      change: deviationChange,
      direction: deviationDirection,
      average: average(deviationValues),
      best: deviationValues.length > 0 ? Math.min(...deviationValues) : null,
      worst: deviationValues.length > 0 ? Math.max(...deviationValues) : null,
    },
    roster: {
      oldest: memberCounts[0] ?? null,
      latest: memberCounts.at(-1) ?? null,
      delta: memberCounts.length >= 2 ? (memberCounts.at(-1) as number) - memberCounts[0] : null,
      average: average(memberCounts),
      fullCount: memberCounts.filter((count) => count === 50).length,
    },
    unresolved: {
      oldest: unresolvedCounts[0] ?? null,
      latest: unresolvedCounts.at(-1) ?? null,
      average: average(unresolvedCounts),
    },
    fillers: {
      knownOldest: knownFillerCounts[0] ?? null,
      knownLatest: knownFillerCounts.at(-1) ?? null,
      averageKnown: average(knownFillerCounts),
      knownCount: knownFillerCounts.length,
    },
    algorithmVersions,
  };
}

export class ClanHealthTrendService {
  constructor(private readonly db: ClanHealthTrendDb = prisma as unknown as ClanHealthTrendDb) {}

  /** Purpose: read bounded sync-boundary snapshots and derive a deterministic Clan Health trend report. */
  async getTrend(input: ClanHealthTrendInput): Promise<ClanHealthTrendReport> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTag = normalizeTrendClanTag(input.clanTag);
    const window = input.window;
    const cutoff = window.kind === "days" ? toValidDate(window.cutoff) : null;
    const now = toValidDate(input.now);
    if (
      !guildId ||
      !clanTag ||
      !now ||
      (window.kind === "days" && !cutoff) ||
      !this.db.syncClanReadinessSnapshot?.findMany
    ) {
      return emptyReport({
        guildId,
        clanTag,
        window,
        now: now ?? new Date(0),
      });
    }
    const syncMode = window.kind === "syncs";

    const rawSnapshots = await this.db.syncClanReadinessSnapshot.findMany({
      where: {
        guildId,
        clanTag,
        syncTime: syncMode ? { lte: now } : { gte: cutoff as Date, lte: now },
      },
      orderBy: [{ syncTime: "desc" }, { id: "desc" }],
      ...(syncMode ? { take: window.requestedSyncCount } : {}),
      select: {
        guildId: true,
        syncTime: true,
        clanTag: true,
        clanName: true,
        memberCount: true,
        unresolvedWeightCount: true,
        deviationScore: true,
        projectionComplete: true,
        algorithmVersion: true,
        fillerCaptureComplete: true,
        fillerPlayerTags: true,
      },
    });
    const snapshots = rawSnapshots
      .map((row) => normalizeSnapshot(row, clanTag))
      .filter((row): row is ClanHealthTrendSnapshot => row !== null);

    if (snapshots.length > 0 && this.db.syncCycle?.findMany) {
      const syncTimes = [...new Map(
        snapshots.map((snapshot) => [snapshot.syncTime.toISOString(), snapshot.syncTime]),
      ).values()];
      const cycles = await this.db.syncCycle.findMany({
        where: { guildId, syncTime: { in: syncTimes } },
        select: { syncNumber: true, syncTime: true },
      });
      mapSyncNumbers(snapshots, cycles);
    }

    return buildReport({ guildId, clanTag, window, now, snapshots });
  }
}
