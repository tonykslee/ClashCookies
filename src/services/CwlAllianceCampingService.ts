import { prisma } from "../prisma";
import { normalizeClashTagWithHash } from "../helper/clashTag";
import {
  cwlAllianceActivityService,
  type CwlAllianceActivityResult,
} from "./CwlAllianceActivityService";

export type CwlAllianceCampingInput = {
  season: string;
  guildId: string;
  now?: Date;
};

export type CwlAllianceCampingTrackingCoverageStatus = "UNAVAILABLE" | "PARTIAL" | "OBSERVED";

export type CwlAllianceCampingPlayer = {
  playerTag: string;
  playerName: string | null;
  homeFwaClanTag: string;
  cwlClanTagsVisited: string[];
  duringCwlDurationMs: number | null;
  postCwlDurationMs: number | null;
  totalObservedCampingDurationMs: number | null;
  currentlyCamping: boolean;
  currentCwlClanTag: string | null;
  currentCampingSince: Date | null;
  currentCampingDurationMs: number | null;
};

export type CwlAllianceCampingClan = {
  clanTag: string;
  clanName: string | null;
  uniqueAttributedCamperCount: number;
  totalDuringCwlCampingDurationMs: number | null;
  totalPostCwlCampingDurationMs: number | null;
  currentlyCampingCount: number;
};

export type CwlAllianceCampingResult = {
  season: string;
  reportNow: Date;
  cwlWindow: CwlAllianceActivityResult["cwlWindow"];
  timing: {
    available: boolean;
    reason: string | null;
  };
  trackingCoverage: {
    status: CwlAllianceCampingTrackingCoverageStatus;
    trackingStartedAt: Date | null;
    reason: string | null;
  };
  sourceCoverage: {
    preFwaClansCovered: number;
    preFwaClansExpected: number;
    cwlEventsResolved: number;
    cwlClanCount: number;
    homeAttributionComplete: boolean;
    cwlEventCoverageComplete: boolean;
  };
  summary: {
    attributedPreFwaAccounts: number;
    camperCount: number | null;
    zeroObservedCampingCount: number | null;
    totalCampingDurationMs: number | null;
    averageCampingDurationMs: number | null;
    medianCampingDurationMs: number | null;
    postCwlCamperCount: number | null;
    totalPostCwlCampingDurationMs: number | null;
    currentlyCampingCount: number;
  };
  unattributed: {
    observedAccountCount: number;
    observedDurationMs: number | null;
  };
  players: CwlAllianceCampingPlayer[];
  clans: CwlAllianceCampingClan[];
  overlapReconciliationCount: number;
  intervalRowCount: number;
};

type CampingDb = {
  cwlTrackedClan: { findMany: (args?: any) => Promise<any[]> };
  allianceClanMembershipInterval: { findMany: (args?: any) => Promise<any[]> };
};

type ActivityReader = Pick<typeof cwlAllianceActivityService, "getActivity">;

type MembershipInterval = {
  playerTag: string;
  clanTag: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
  endedAt: Date | null;
};

type Range = {
  startMs: number;
  endMs: number;
  clanTag: string;
};

type PlayerAccumulator = {
  playerTag: string;
  playerName: string | null;
  homeFwaClanTag: string;
  during: Range[];
  post: Range[];
  current: Array<{ clanTag: string; firstObservedAt: Date }>;
};

type ClanAccumulator = {
  clanTag: string;
  clanName: string | null;
  duringByPlayer: Map<string, Range[]>;
  postByPlayer: Map<string, Range[]>;
  currentPlayers: Set<string>;
};

const campingDb = prisma as unknown as CampingDb;

/** Purpose: collect read-only observed camping analytics from persisted activity and interval history. */
export class CwlAllianceCampingService {
  constructor(
    private readonly db: CampingDb = campingDb,
    private readonly activityReader: ActivityReader = cwlAllianceActivityService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Purpose: build a read-only observed camping report from persisted CWL attribution and membership history. */
  async getCamping(input: CwlAllianceCampingInput): Promise<CwlAllianceCampingResult> {
    const startedAtMs = Date.now();
    const activity = await this.activityReader.getActivity({
      season: input.season,
      guildId: input.guildId,
    });
    const reportNow = toDate(input.now ?? this.clock()) ?? new Date();
    const trackedRows = await this.db.cwlTrackedClan.findMany({
      where: { season: activity.season },
      orderBy: [{ tag: "asc" }, { id: "asc" }],
      select: { tag: true, name: true },
    });
    const trackedClans = normalizeTrackedClans(trackedRows);
    const trackedByTag = new Map(trackedClans.map((clan) => [clan.clanTag, clan]));
    const timing = resolveTiming(activity.cwlWindow);
    const normalizedGuildId = String(input.guildId ?? "").trim();
    const trackingStartRows = await this.db.allianceClanMembershipInterval.findMany({
      where: { guildId: normalizedGuildId },
      orderBy: [{ firstObservedAt: "asc" }, { playerTag: "asc" }, { clanTag: "asc" }],
      take: 1,
      select: { firstObservedAt: true },
    });
    const historyRows = timing.available && activity.cwlWindow.startsAt
      ? await this.db.allianceClanMembershipInterval.findMany({
          where: {
            guildId: normalizedGuildId,
            clanTag: { in: trackedClans.map((clan) => clan.clanTag) },
            firstObservedAt: { lt: reportNow },
            OR: [
              { endedAt: null },
              { endedAt: { gt: activity.cwlWindow.startsAt } },
            ],
          },
          orderBy: [{ firstObservedAt: "asc" }, { playerTag: "asc" }, { clanTag: "asc" }],
          select: {
            playerTag: true,
            clanTag: true,
            firstObservedAt: true,
            lastObservedAt: true,
            endedAt: true,
          },
        })
      : [];
    const intervals = normalizeIntervals(historyRows);
    const trackingStartedAt = toDate(trackingStartRows[0]?.firstObservedAt);
    const trackingCoverage = resolveTrackingCoverage(trackingStartedAt, activity.cwlWindow.startsAt);
    const homeByPlayer = new Map(
      activity.players.preFwa.map((player) => [normalizeTag(player.playerTag), {
        homeFwaClanTag: normalizeTag(player.homeFwaClanTag),
        playerName: normalizeNullableName(player.playerName),
      }]),
    );
    const nameByPlayer = buildActivityNameIndex(activity);
    const attributed = new Map<string, PlayerAccumulator>();
    if (trackingCoverage.status !== "UNAVAILABLE") {
      for (const prePlayer of activity.players.preFwa) {
        const playerTag = normalizeTag(prePlayer.playerTag);
        const homeFwaClanTag = normalizeTag(prePlayer.homeFwaClanTag);
        if (!playerTag || !homeFwaClanTag) continue;
        attributed.set(playerTag, {
          playerTag,
          playerName: normalizeNullableName(prePlayer.playerName) ?? nameByPlayer.get(playerTag) ?? null,
          homeFwaClanTag,
          during: [],
          post: [],
          current: [],
        });
      }
    }
    const unattributedRangesByPlayer = new Map<string, Range[]>();
    const clanAccumulators = new Map<string, ClanAccumulator>();
    for (const clan of trackedClans) {
      clanAccumulators.set(clan.clanTag, {
        clanTag: clan.clanTag,
        clanName: clan.clanName,
        duringByPlayer: new Map(),
        postByPlayer: new Map(),
        currentPlayers: new Set(),
      });
    }

    let overlapReconciliationCount = 0;
    for (const interval of intervals) {
      const clan = trackedByTag.get(interval.clanTag);
      if (!clan || !timing.available || !activity.cwlWindow.startsAt) continue;
      const home = homeByPlayer.get(interval.playerTag);
      const isAttributedCamping = Boolean(home && interval.clanTag !== home.homeFwaClanTag);
      const during = clipInterval(interval, activity.cwlWindow.startsAt, activity.cwlWindow.endsAt ?? reportNow);
      const post = activity.cwlWindow.endsAt
        ? clipInterval(interval, activity.cwlWindow.endsAt, reportNow)
        : [];
      if (!home) {
        const ranges = unattributedRangesByPlayer.get(interval.playerTag) ?? [];
        ranges.push(...during, ...post);
        unattributedRangesByPlayer.set(interval.playerTag, ranges);
        continue;
      }
      if (!isAttributedCamping) continue;
      const player = attributed.get(interval.playerTag) ?? {
        playerTag: interval.playerTag,
        playerName: home.playerName ?? nameByPlayer.get(interval.playerTag) ?? null,
        homeFwaClanTag: home.homeFwaClanTag,
        during: [],
        post: [],
        current: [],
      };
      player.during.push(...during);
      player.post.push(...post);
      if (interval.endedAt === null && interval.firstObservedAt.getTime() <= reportNow.getTime()) {
        player.current.push({ clanTag: interval.clanTag, firstObservedAt: interval.firstObservedAt });
      }
      attributed.set(interval.playerTag, player);
    }

    const players = [...attributed.values()]
      .map((player) => {
        const during = reconcileRanges(player.during);
        const post = activity.cwlWindow.endsAt ? reconcileRanges(player.post) : null;
        overlapReconciliationCount += during.overlapCount + (post?.overlapCount ?? 0);
        for (const [clanTag, ranges] of during.allocatedByClan) {
          const clan = clanAccumulators.get(clanTag);
          if (clan) addClanRange(clan.duringByPlayer, player.playerTag, ranges);
        }
        for (const [clanTag, ranges] of post?.allocatedByClan ?? []) {
          const clan = clanAccumulators.get(clanTag);
          if (clan) addClanRange(clan.postByPlayer, player.playerTag, ranges);
        }
        const current = [...player.current].sort((a, b) =>
          b.firstObservedAt.getTime() - a.firstObservedAt.getTime() || a.clanTag.localeCompare(b.clanTag),
        )[0] ?? null;
        if (current) clanAccumulators.get(current.clanTag)?.currentPlayers.add(player.playerTag);
        const duringDurationMs = timing.available ? during.durationMs : null;
        const postDurationMs = post ? post.durationMs : null;
        const currentBoundary = activity.cwlWindow.endsAt ?? activity.cwlWindow.startsAt;
        const currentCampingDurationMs = current && timing.available && currentBoundary
          ? Math.max(0, reportNow.getTime() - Math.max(current.firstObservedAt.getTime(), currentBoundary.getTime()))
          : null;
        return {
          playerTag: player.playerTag,
          playerName: player.playerName,
          homeFwaClanTag: player.homeFwaClanTag,
          cwlClanTagsVisited: [...new Set(player.during.concat(player.post).map((range) => range.clanTag))].sort(),
          duringCwlDurationMs: duringDurationMs,
          postCwlDurationMs: postDurationMs,
          totalObservedCampingDurationMs: timing.available
            ? duringDurationMs! + (postDurationMs ?? 0)
            : null,
          currentlyCamping: current !== null,
          currentCwlClanTag: current?.clanTag ?? null,
          currentCampingSince: current?.firstObservedAt ?? null,
          currentCampingDurationMs,
        } satisfies CwlAllianceCampingPlayer;
      })
      .sort(compareCampingPlayers);
    const camperDurations = players
      .map((player) => player.duringCwlDurationMs)
      .filter((duration): duration is number => duration !== null && duration > 0)
      .sort((a, b) => a - b);
    const postCamperCount = activity.cwlWindow.endsAt === null
      ? null
      : players.filter((player) => (player.postCwlDurationMs ?? 0) > 0).length;
    const totalDuring = timing.available
      ? camperDurations.reduce((sum, duration) => sum + duration, 0)
      : null;
    const totalPost = activity.cwlWindow.endsAt === null
      ? null
      : players.reduce((sum, player) => sum + (player.postCwlDurationMs ?? 0), 0);
    let unattributedDurationMs = 0;
    for (const ranges of unattributedRangesByPlayer.values()) {
      const merged = mergeRanges(ranges);
      unattributedDurationMs += merged.durationMs;
      overlapReconciliationCount += merged.overlapCount;
    }
    const clans = [...clanAccumulators.values()]
      .map((clan) => toClanResult(clan, activity.cwlWindow.endsAt !== null, timing.available))
      .sort(compareCampingClans);
    const trackingUnavailable = trackingCoverage.status === "UNAVAILABLE";
    const sourceCoverage = {
      preFwaClansCovered: activity.coverage.preFwaClansCovered,
      preFwaClansExpected: activity.coverage.preFwaClansExpected,
      cwlEventsResolved: activity.coverage.resolvedEventCount,
      cwlClanCount: activity.coverage.cwlClanCount,
      homeAttributionComplete: activity.coverage.preFwaClansCovered >= activity.coverage.preFwaClansExpected,
      cwlEventCoverageComplete: activity.coverage.resolvedEventCount >= activity.coverage.cwlClanCount,
    };

    const result: CwlAllianceCampingResult = {
      season: activity.season,
      reportNow,
      cwlWindow: activity.cwlWindow,
      timing,
      trackingCoverage,
      sourceCoverage,
      summary: {
        attributedPreFwaAccounts: activity.players.preFwa.length,
        camperCount: timing.available && !trackingUnavailable ? camperDurations.length : null,
        zeroObservedCampingCount: trackingCoverage.status === "OBSERVED" && timing.available
          ? Math.max(0, activity.players.preFwa.length - camperDurations.length)
          : null,
        totalCampingDurationMs: trackingUnavailable ? null : totalDuring,
        averageCampingDurationMs: camperDurations.length > 0
          ? camperDurations.reduce((sum, duration) => sum + duration, 0) / camperDurations.length
          : timing.available && !trackingUnavailable ? 0 : null,
        medianCampingDurationMs: median(camperDurations),
        postCwlCamperCount: trackingUnavailable ? null : postCamperCount,
        totalPostCwlCampingDurationMs: trackingUnavailable ? null : totalPost,
        currentlyCampingCount: trackingUnavailable ? 0 : players.filter((player) => player.currentlyCamping).length,
      },
      unattributed: {
        observedAccountCount: new Set(intervals
          .filter((interval) => trackedByTag.has(interval.clanTag) && !homeByPlayer.has(interval.playerTag))
          .map((interval) => interval.playerTag)).size,
        observedDurationMs: trackingUnavailable || !timing.available ? null : unattributedDurationMs,
      },
      players,
      clans,
      overlapReconciliationCount,
      intervalRowCount: intervals.filter((interval) => trackedByTag.has(interval.clanTag)).length,
    };
    console.info(
      `[cwl-camping] event=report_summary guild_id=${String(input.guildId ?? "").trim()} season=${result.season} tracking_coverage=${result.trackingCoverage.status} interval_rows=${result.intervalRowCount} attributed_accounts=${result.summary.attributedPreFwaAccounts} campers=${result.summary.camperCount ?? 0} unattributed_accounts=${result.unattributed.observedAccountCount} currently_camping=${result.summary.currentlyCampingCount} overlap_reconciliations=${result.overlapReconciliationCount} duration_ms=${Date.now() - startedAtMs}`,
    );
    return result;
  }
}

export const cwlAllianceCampingService = new CwlAllianceCampingService();

/** Purpose: normalize season CWL registry rows into deterministic canonical clan metadata. */
function normalizeTrackedClans(rows: any[]): Array<{ clanTag: string; clanName: string | null }> {
  const byTag = new Map<string, { clanTag: string; clanName: string | null }>();
  for (const row of rows) {
    const clanTag = normalizeTag(row?.tag);
    if (!clanTag || byTag.has(clanTag)) continue;
    byTag.set(clanTag, { clanTag, clanName: normalizeNullableName(row?.name) });
  }
  return [...byTag.values()].sort((a, b) => a.clanTag.localeCompare(b.clanTag));
}

/** Purpose: normalize persisted interval rows and discard malformed timestamps safely. */
function normalizeIntervals(rows: any[]): MembershipInterval[] {
  return rows
    .map((row) => {
      const playerTag = normalizeTag(row?.playerTag);
      const clanTag = normalizeTag(row?.clanTag);
      const firstObservedAt = toDate(row?.firstObservedAt);
      const lastObservedAt = toDate(row?.lastObservedAt);
      const endedAt = row?.endedAt === null || row?.endedAt === undefined ? null : toDate(row.endedAt);
      if (!playerTag || !clanTag || !firstObservedAt || !lastObservedAt || (row?.endedAt != null && !endedAt)) return null;
      return { playerTag, clanTag, firstObservedAt, lastObservedAt, endedAt };
    })
    .filter((row): row is MembershipInterval => row !== null)
    .sort((a, b) => a.firstObservedAt.getTime() - b.firstObservedAt.getTime() || a.playerTag.localeCompare(b.playerTag) || a.clanTag.localeCompare(b.clanTag));
}

/** Purpose: resolve whether the persisted CWL window is safe for duration arithmetic. */
function resolveTiming(window: CwlAllianceActivityResult["cwlWindow"]): { available: boolean; reason: string | null } {
  return window.startsAt
    ? { available: true, reason: null }
    : { available: false, reason: "CWL start timing is unavailable in persisted history; observed camping duration cannot be calculated." };
}

/** Purpose: classify interval collection coverage relative to the authoritative CWL start. */
function resolveTrackingCoverage(
  trackingStartedAt: Date | null,
  startsAt: Date | null,
): CwlAllianceCampingResult["trackingCoverage"] {
  if (!trackingStartedAt) {
    return { status: "UNAVAILABLE", trackingStartedAt: null, reason: "No observed membership history exists for this guild." };
  }
  if (!startsAt) {
    return { status: "UNAVAILABLE", trackingStartedAt, reason: "CWL start timing is unavailable; tracking completeness cannot be proven." };
  }
  if (trackingStartedAt.getTime() > startsAt.getTime()) {
    return { status: "PARTIAL", trackingStartedAt, reason: "Membership tracking began after CWL started; earlier membership is unobserved." };
  }
  return { status: "OBSERVED", trackingStartedAt, reason: null };
}

/** Purpose: clip one stored interval to a report window without changing persisted timestamps. */
function clipInterval(interval: MembershipInterval, windowStart: Date, windowEnd: Date): Range[] {
  const startMs = Math.max(interval.firstObservedAt.getTime(), windowStart.getTime());
  const endMs = Math.min((interval.endedAt ?? windowEnd).getTime(), windowEnd.getTime());
  return endMs > startMs ? [{ startMs, endMs, clanTag: interval.clanTag }] : [];
}

/** Purpose: merge per-player wall-clock ranges so malformed overlaps cannot inflate duration totals. */
function mergeRanges(ranges: Range[]): { durationMs: number; overlapCount: number; ranges: Range[] } {
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.clanTag.localeCompare(b.clanTag));
  const merged: Range[] = [];
  let overlapCount = 0;
  for (const range of sorted) {
    const current = merged.at(-1);
    if (!current || range.startMs > current.endMs) {
      merged.push({ ...range });
      continue;
    }
    if (range.startMs < current.endMs) overlapCount += 1;
    current.endMs = Math.max(current.endMs, range.endMs);
  }
  return {
    durationMs: merged.reduce((sum, range) => sum + range.endMs - range.startMs, 0),
    overlapCount,
    ranges: merged,
  };
}

/** Purpose: allocate each wall-clock segment to one deterministic clan owner while preserving player uniqueness. */
function reconcileRanges(ranges: Range[]): {
  durationMs: number;
  overlapCount: number;
  allocatedByClan: Map<string, Range[]>;
} {
  const boundaries = [...new Set(ranges.flatMap((range) => [range.startMs, range.endMs]))].sort((a, b) => a - b);
  const allocatedByClan = new Map<string, Range[]>();
  let durationMs = 0;
  let overlapCount = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMs = boundaries[index];
    const endMs = boundaries[index + 1];
    if (endMs <= startMs) continue;
    const active = ranges.filter((range) => range.startMs <= startMs && range.endMs >= endMs);
    if (active.length === 0) continue;
    if (active.length > 1) overlapCount += active.length - 1;
    const owner = [...active].sort((a, b) =>
      b.startMs - a.startMs || a.clanTag.localeCompare(b.clanTag),
    )[0];
    const allocated = allocatedByClan.get(owner.clanTag) ?? [];
    appendRange(allocated, { startMs, endMs, clanTag: owner.clanTag });
    allocatedByClan.set(owner.clanTag, allocated);
    durationMs += endMs - startMs;
  }
  return { durationMs, overlapCount, allocatedByClan };
}

/** Purpose: coalesce adjacent segments already assigned to the same clan. */
function appendRange(target: Range[], range: Range): void {
  const previous = target.at(-1);
  if (previous && previous.clanTag === range.clanTag && previous.endMs >= range.startMs) {
    previous.endMs = Math.max(previous.endMs, range.endMs);
    return;
  }
  target.push({ ...range });
}

/** Purpose: add clipped interval portions to a deterministic per-clan player bucket. */
function addClanRange(target: Map<string, Range[]>, playerTag: string, ranges: Range[]): void {
  if (ranges.length === 0) return;
  target.set(playerTag, [...(target.get(playerTag) ?? []), ...ranges]);
}

/** Purpose: build a persisted player-name lookup without consulting current-state owners or APIs. */
function buildActivityNameIndex(activity: CwlAllianceActivityResult): Map<string, string> {
  const names = new Map<string, string>();
  for (const player of [
    ...activity.players.preFwa,
    ...activity.players.cwl,
    ...activity.players.both,
    ...activity.players.fwaOnly,
    ...activity.players.cwlOnly,
  ]) {
    const tag = normalizeTag(player.playerTag);
    const name = normalizeNullableName(player.playerName);
    if (tag && name && !names.has(tag)) names.set(tag, name);
  }
  return names;
}

/** Purpose: render a deterministic per-clan aggregate from the player's actual clipped interval portions. */
function toClanResult(
  clan: ClanAccumulator,
  hasPostWindow: boolean,
  timingAvailable: boolean,
): CwlAllianceCampingClan {
  let totalDuring = 0;
  let totalPost = 0;
  const camperTags = new Set<string>();
  for (const [playerTag, ranges] of clan.duringByPlayer) {
    const merged = mergeRanges(ranges);
    totalDuring += merged.durationMs;
    if (merged.durationMs > 0) camperTags.add(playerTag);
  }
  for (const [playerTag, ranges] of clan.postByPlayer) {
    const merged = mergeRanges(ranges);
    totalPost += merged.durationMs;
    if (merged.durationMs > 0) camperTags.add(playerTag);
  }
  return {
    clanTag: clan.clanTag,
    clanName: clan.clanName,
    uniqueAttributedCamperCount: camperTags.size,
    totalDuringCwlCampingDurationMs: timingAvailable ? totalDuring : null,
    totalPostCwlCampingDurationMs: hasPostWindow ? totalPost : null,
    currentlyCampingCount: clan.currentPlayers.size,
  };
}

/** Purpose: sort players by observed camping time before applying stable player-tag ordering. */
function compareCampingPlayers(a: CwlAllianceCampingPlayer, b: CwlAllianceCampingPlayer): number {
  return (b.totalObservedCampingDurationMs ?? -1) - (a.totalObservedCampingDurationMs ?? -1) || a.playerTag.localeCompare(b.playerTag);
}

/** Purpose: sort clan aggregates by during-CWL observed camping time before stable tag ordering. */
function compareCampingClans(a: CwlAllianceCampingClan, b: CwlAllianceCampingClan): number {
  return (b.totalDuringCwlCampingDurationMs ?? -1) - (a.totalDuringCwlCampingDurationMs ?? -1) || a.clanTag.localeCompare(b.clanTag);
}

/** Purpose: calculate the median of sorted observed camper durations. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}

/** Purpose: normalize persisted clan/player tags to one comparison key. */
function normalizeTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? "").trim());
}

/** Purpose: preserve nullable persisted names while trimming display noise. */
function normalizeNullableName(value: unknown): string | null {
  const name = String(value ?? "").trim();
  return name || null;
}

/** Purpose: convert persisted or injected date values without accepting invalid timestamps. */
function toDate(value: unknown): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
}
