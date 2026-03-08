type CurrentWarPhase = "preparation" | "inWar";

export type CurrentWarRemainingRow = {
  clanTag: string;
  state: string | null;
  startTime: Date | null;
  endTime: Date | null;
};

export type ActiveWarRemainingSample = {
  clanTag: string;
  clanName: string | null;
  phase: CurrentWarPhase;
  phaseEndAtMs: number;
  remainingSeconds: number;
  remainingMinutes: number;
};

type RemainingCluster = {
  members: ActiveWarRemainingSample[];
  meanRemainingSeconds: number;
  spreadSeconds: number;
  lexicalKey: string;
};

type ClusterRankInput = {
  size: number;
  meanRemainingSeconds: number;
  lexicalKey: string;
};

export type DominantRemainingClusterResult = {
  dominantCluster: RemainingCluster;
  outliers: ActiveWarRemainingSample[];
  totalActiveWarClans: number;
};

const DEFAULT_CLUSTER_PROXIMITY_MINUTES = 10;

/** Purpose: normalize tags to uppercase with leading '#'. */
export function normalizeClanTag(input: string): string {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

/** Purpose: classify current-war phase from persisted state value. */
export function getCurrentWarPhase(state: string | null | undefined): CurrentWarPhase | null {
  const normalized = String(state ?? "").trim().toLowerCase();
  if (normalized === "preparation") return "preparation";
  if (normalized === "inwar") return "inWar";
  return null;
}

/** Purpose: convert valid Date values to epoch milliseconds. */
function toEpochMs(value: Date | null | undefined): number | null {
  if (!(value instanceof Date)) return null;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Purpose: compute phase-end ms for a persisted current-war row. */
export function getPhaseEndAtMs(row: CurrentWarRemainingRow): number | null {
  const phase = getCurrentWarPhase(row.state);
  if (phase === "preparation") return toEpochMs(row.startTime);
  if (phase === "inWar") return toEpochMs(row.endTime);
  return null;
}

/** Purpose: map persisted current-war rows into active-war remaining-time samples. */
export function buildActiveWarRemainingSamples(
  rows: CurrentWarRemainingRow[],
  clanNameByTag: Map<string, string | null>,
  nowMs = Date.now()
): ActiveWarRemainingSample[] {
  const samples: ActiveWarRemainingSample[] = [];
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag) continue;
    const phase = getCurrentWarPhase(row.state);
    if (!phase) continue;
    const phaseEndAtMs = getPhaseEndAtMs(row);
    if (phaseEndAtMs === null) continue;
    const remainingSeconds = Math.max(0, Math.trunc((phaseEndAtMs - nowMs) / 1000));
    samples.push({
      clanTag,
      clanName: clanNameByTag.get(clanTag) ?? null,
      phase,
      phaseEndAtMs,
      remainingSeconds,
      remainingMinutes: Math.trunc(remainingSeconds / 60),
    });
  }
  return samples.sort((a, b) => {
    if (a.remainingSeconds !== b.remainingSeconds) {
      return a.remainingSeconds - b.remainingSeconds;
    }
    return a.clanTag.localeCompare(b.clanTag);
  });
}

/** Purpose: compute deterministic cluster metadata from a set of samples. */
function toCluster(members: ActiveWarRemainingSample[]): RemainingCluster {
  const sortedMembers = [...members].sort((a, b) => a.clanTag.localeCompare(b.clanTag));
  const totalRemainingSeconds = sortedMembers.reduce((acc, item) => acc + item.remainingSeconds, 0);
  const meanRemainingSeconds = Math.round(totalRemainingSeconds / Math.max(1, sortedMembers.length));
  const minRemaining = Math.min(...sortedMembers.map((item) => item.remainingSeconds));
  const maxRemaining = Math.max(...sortedMembers.map((item) => item.remainingSeconds));
  return {
    members: sortedMembers,
    meanRemainingSeconds,
    spreadSeconds: Math.max(0, maxRemaining - minRemaining),
    lexicalKey: sortedMembers.map((item) => item.clanTag).join("|"),
  };
}

/** Purpose: rank clusters deterministically by size, mean remaining, then clan tag order. */
function compareClusterRank(a: ClusterRankInput, b: ClusterRankInput): number {
  if (a.size !== b.size) return b.size - a.size;
  if (a.meanRemainingSeconds !== b.meanRemainingSeconds) {
    return a.meanRemainingSeconds - b.meanRemainingSeconds;
  }
  return a.lexicalKey.localeCompare(b.lexicalKey);
}

/** Purpose: rank synthetic candidates for deterministic tie-break unit testing. */
export function pickDominantClusterRankForTest(
  inputs: ClusterRankInput[]
): ClusterRankInput | null {
  if (inputs.length === 0) return null;
  return [...inputs].sort(compareClusterRank)[0];
}

/** Purpose: split active-war samples into clusters where max-min remaining is <= proximity. */
function buildClusters(
  samples: ActiveWarRemainingSample[],
  proximityMinutes: number
): RemainingCluster[] {
  if (samples.length === 0) return [];
  const proximity = Math.max(0, Math.trunc(proximityMinutes));
  const sorted = [...samples].sort((a, b) => {
    if (a.remainingMinutes !== b.remainingMinutes) return a.remainingMinutes - b.remainingMinutes;
    return a.clanTag.localeCompare(b.clanTag);
  });

  const clusters: ActiveWarRemainingSample[][] = [];
  let current: ActiveWarRemainingSample[] = [sorted[0]];
  let currentMinMinutes = sorted[0].remainingMinutes;
  for (let i = 1; i < sorted.length; i += 1) {
    const candidate = sorted[i];
    if (candidate.remainingMinutes - currentMinMinutes <= proximity) {
      current.push(candidate);
      continue;
    }
    clusters.push(current);
    current = [candidate];
    currentMinMinutes = candidate.remainingMinutes;
  }
  clusters.push(current);
  return clusters.map((clusterMembers) => toCluster(clusterMembers));
}

/** Purpose: identify dominant remaining-time cluster and outliers across active-war clans. */
export function summarizeDominantRemainingCluster(
  samples: ActiveWarRemainingSample[],
  proximityMinutes = DEFAULT_CLUSTER_PROXIMITY_MINUTES
): DominantRemainingClusterResult | null {
  if (samples.length === 0) return null;
  const clusters = buildClusters(samples, proximityMinutes).sort((a, b) =>
    compareClusterRank(
      {
        size: a.members.length,
        meanRemainingSeconds: a.meanRemainingSeconds,
        lexicalKey: a.lexicalKey,
      },
      {
        size: b.members.length,
        meanRemainingSeconds: b.meanRemainingSeconds,
        lexicalKey: b.lexicalKey,
      }
    )
  );
  const dominantCluster = clusters[0];
  const dominantTags = new Set(dominantCluster.members.map((item) => item.clanTag));
  const outliers = samples
    .filter((item) => !dominantTags.has(item.clanTag))
    .sort((a, b) => {
      if (a.remainingSeconds !== b.remainingSeconds) return a.remainingSeconds - b.remainingSeconds;
      return a.clanTag.localeCompare(b.clanTag);
    });
  return {
    dominantCluster,
    outliers,
    totalActiveWarClans: samples.length,
  };
}

/** Purpose: format seconds as XmYs for spread and compact duration fields. */
export function formatMinutesSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.trunc(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}m${seconds}s`;
}

/** Purpose: format seconds as a readable h/m/s string for headline and outlier values. */
export function formatHumanDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Purpose: map persisted phase values to user-facing labels. */
export function formatCurrentWarPhaseLabel(phase: CurrentWarPhase): string {
  return phase === "preparation" ? "Preparation Day" : "Battle Day";
}
