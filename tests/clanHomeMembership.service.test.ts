import { describe, expect, it, vi } from "vitest";
import {
  ClanHomeMembershipService,
  type ActiveHomeMembership,
} from "../src/services/ClanHomeMembershipService";
import type {
  MembershipBoundaryEvidence,
  MembershipBoundaryEvidenceByPlayer,
} from "../src/services/MembershipStreakService";

const guildId = "guild-1";
const playerTag = "#P2222";
const rr = "#RRRR";
const eb = "#GJJJ";
const de = "#DEEE";

function time(day: number): Date {
  return new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`);
}

function member(day: number, clanTag = rr, tag = playerTag) {
  return { guildId, syncTime: time(day), clanTag, playerTag: tag };
}

function readiness(
  day: number,
  options: { clanTag?: string; complete?: boolean; fillerPlayerTags?: string[] } = {},
) {
  return {
    guildId,
    syncTime: time(day),
    clanTag: options.clanTag ?? rr,
    fillerCaptureComplete: options.complete ?? true,
    fillerPlayerTags: options.fillerPlayerTags ?? [],
  };
}

function activeHome(clanTag = rr): ActiveHomeMembership {
  return {
    id: "home-1",
    guildId,
    playerTag,
    clanTag,
    startedAtSyncTime: time(1),
    qualifiedAtSyncTime: time(1),
    endedAtSyncTime: null,
    establishmentSource: "AUTO_3_SYNC",
    endReason: null,
  };
}

function cwlWindow(overrides: Partial<Record<string, any>> = {}) {
  return {
    season: "2026-08",
    startsAt: null,
    endsAt: null,
    timingCoverageComplete: false,
    startTimingResolved: false,
    endTimingResolved: false,
    missingTimingDetails: ["NO_TRACKED_CWL_REGISTRY"],
    hasTrackedCwlClans: false,
    resolvedEventCount: 0,
    unresolvedCwlClans: [],
    ...overrides,
  };
}

function fwaEvidence(
  day: number,
  options: {
    status?: "RESOLVED" | "AMBIGUOUS" | "ABSENT" | "UNKNOWN";
    clanTag?: string | null;
    source?: "SYNC_SNAPSHOT" | "FWA_WAR_PARTICIPATION_FALLBACK" | null;
    alliancePositive?: boolean;
  } = {},
): MembershipBoundaryEvidence {
  const status = options.status ?? "RESOLVED";
  const clanTag = options.clanTag === undefined ? rr : options.clanTag;
  return {
    playerTag,
    boundaryTime: time(day),
    fwa: {
      status,
      clanTag: status === "RESOLVED" ? clanTag : null,
      clanTags: clanTag ? [clanTag] : [],
      source: options.source === undefined
        ? (status === "RESOLVED" ? "SYNC_SNAPSHOT" : null)
        : options.source,
    },
    alliance: {
      positive: options.alliancePositive ?? status === "RESOLVED",
      clanTags: clanTag ? [clanTag] : [],
      ambiguous: status === "AMBIGUOUS",
      sources: options.alliancePositive || status === "RESOLVED" ? ["FWA_EVIDENCE"] : [],
    },
  };
}

type Fixture = {
  memberRows?: any[];
  readinessRows?: any[];
  trackedTags?: string[];
  evidence?: MembershipBoundaryEvidence[];
  periods?: ActiveHomeMembership[];
  candidateRows?: any[];
  cwlWindows?: Record<string, any>;
  candidateRaceOnCreate?: boolean;
  raceOnCreate?: boolean;
  mirrorMode?: boolean;
};

function makeDb(fixture: Fixture = {}) {
  const state = {
    memberRows: fixture.memberRows ?? [member(3)],
    readinessRows: fixture.readinessRows ?? [readiness(3), readiness(2), readiness(1)],
    trackedTags: fixture.trackedTags ?? [rr],
    periods: [...(fixture.periods ?? [])],
    candidateRows: [...(fixture.candidateRows ?? [])],
    cwlWindows: fixture.cwlWindows ?? {},
    candidateRaceOnCreate: fixture.candidateRaceOnCreate ?? false,
    raceOnCreate: fixture.raceOnCreate ?? false,
    mirrorMode: fixture.mirrorMode ?? false,
  };
  const evidenceByPlayer: MembershipBoundaryEvidenceByPlayer = {
    [playerTag]: fixture.evidence ?? [fwaEvidence(3), fwaEvidence(2), fwaEvidence(1)],
  };
  const periodModel = {
    findMany: vi.fn(async () => state.periods.filter((row) => row.endedAtSyncTime === null)),
    findFirst: vi.fn(async ({ where }: any) => state.periods.find((row) =>
      row.guildId === where.guildId &&
      row.playerTag === where.playerTag &&
      row.endedAtSyncTime === null,
    ) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const created = {
        id: `home-${state.periods.length + 1}`,
        ...data,
        createdAt: time(3),
        updatedAt: time(3),
      };
      state.periods.push(created);
      if (state.raceOnCreate) {
        const error = Object.assign(new Error("active Home already exists"), { code: "P2002" });
        throw error;
      }
      return created;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of state.periods) {
        const matches = Object.entries(where ?? {}).every(([key, condition]: [string, any]) => {
          if (condition && typeof condition === "object" && "in" in condition) return condition.in.includes(row[key]);
          return row[key] === condition;
        });
        if (!matches) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    }),
  };
  const candidateModel = {
    findMany: vi.fn(async ({ where }: any = {}) => state.candidateRows.filter((row) =>
      Object.entries(where ?? {}).every(([key, condition]: [string, any]) => {
        if (condition && typeof condition === "object" && "in" in condition) return condition.in.includes(row[key]);
        return row[key] === condition;
      }),
    )),
    findFirst: vi.fn(async ({ where }: any = {}) => state.candidateRows.find((row) =>
      Object.entries(where ?? {}).every(([key, condition]: [string, any]) => row[key] === condition),
    ) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const created = { id: `candidate-${state.candidateRows.length + 1}`, ...data, createdAt: time(3), updatedAt: time(3) };
      state.candidateRows.push(created);
      if (state.candidateRaceOnCreate) {
        const error = Object.assign(new Error("pending candidate already exists"), { code: "P2002" });
        throw error;
      }
      return created;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of state.candidateRows) {
        const matches = Object.entries(where ?? {}).every(([key, condition]: [string, any]) => row[key] === condition);
        if (!matches) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    }),
  };
  const db = {
    syncClanMemberSnapshot: {
      groupBy: vi.fn(async () => {
        const latestByGuild = new Map<string, Date>();
        for (const row of state.memberRows) {
          if (!latestByGuild.has(row.guildId) || row.syncTime > latestByGuild.get(row.guildId)) {
            latestByGuild.set(row.guildId, row.syncTime);
          }
        }
        return [...latestByGuild.entries()].map(([rowGuildId, syncTime]) => ({
          guildId: rowGuildId,
          _max: { syncTime },
        }));
      }),
      findMany: vi.fn(async ({ where }: any) => state.memberRows.filter((row) =>
        where.OR?.some((candidate: any) =>
          candidate.guildId === row.guildId && candidate.syncTime.getTime() === row.syncTime.getTime(),
        ),
      )),
    },
    syncClanReadinessSnapshot: {
      findMany: vi.fn(async () => state.readinessRows),
    },
    trackedClan: {
      findMany: vi.fn(async () => state.trackedTags.map((tag) => ({ tag }))),
    },
    clanHomeMembershipPeriod: periodModel,
    clanHomeTransferCandidate: candidateModel,
    $transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn({
      clanHomeMembershipPeriod: periodModel,
      clanHomeTransferCandidate: candidateModel,
      trackedClan: db.trackedClan,
    })),
  };
  return { db, state, evidenceByPlayer };
}

function serviceFor(fixture: Fixture = {}) {
  const built = makeDb(fixture);
  const evidenceService = {
    getMembershipBoundaryEvidenceForPlayers: vi.fn(async () => built.evidenceByPlayer),
  };
  const cwlWindowReader = {
    getCwlWindow: vi.fn(async ({ season }: { season: string }) => built.state.cwlWindows[season] ?? {
      season,
      startsAt: null,
      endsAt: null,
      timingCoverageComplete: false,
      startTimingResolved: false,
      endTimingResolved: false,
      missingTimingDetails: ["NO_TRACKED_CWL_REGISTRY"],
      hasTrackedCwlClans: false,
      resolvedEventCount: 0,
      unresolvedCwlClans: [],
    }),
  };
  return {
    ...built,
    service: new ClanHomeMembershipService(
      built.db as any,
      evidenceService,
      cwlWindowReader,
      () => built.state.mirrorMode,
    ),
    evidenceService,
    cwlWindowReader,
  };
}

function decisionInput(candidateId: string, actorDiscordUserId: string, decidedAt?: Date) {
  return {
    candidateId,
    actorDiscordUserId,
    guildId,
    expectedFromClanTag: rr,
    ...(decidedAt ? { decidedAt } : {}),
  };
}

describe("ClanHomeMembershipService", () => {
  it("reads active Home periods in bulk without requiring a PlayerLink", async () => {
    const existing = {
      id: "home-1",
      guildId,
      playerTag,
      clanTag: rr,
      startedAtSyncTime: time(1),
      qualifiedAtSyncTime: time(3),
      endedAtSyncTime: null,
      establishmentSource: "AUTO_3_SYNC",
      endReason: null,
    };
    const { service } = serviceFor({ periods: [existing] });

    await expect(service.getActiveHomeMembershipsForPlayers({ guildId, playerTags: [playerTag] }))
      .resolves.toEqual([existing]);
  });

  it("does not establish Home after one qualifying exact sync", async () => {
    const built = serviceFor({ evidence: [fwaEvidence(3)] });

    const result = await built.service.reconcileLatestExactBoundaries();
    const replay = await built.service.reconcileLatestExactBoundaries();

    expect(result.established).toBe(0);
    expect(result.retryable).toBe(0);
    expect(replay.retryable).toBe(0);
    expect(built.state.periods).toHaveLength(0);
    expect(built.db.syncClanMemberSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(built.evidenceService.getMembershipBoundaryEvidenceForPlayers).toHaveBeenCalledTimes(1);
  });

  it("does not establish Home after two qualifying exact syncs", async () => {
    const built = serviceFor({ evidence: [fwaEvidence(3), fwaEvidence(2)] });

    const result = await built.service.reconcileLatestExactBoundaries();
    const replay = await built.service.reconcileLatestExactBoundaries();

    expect(result.established).toBe(0);
    expect(result.retryable).toBe(0);
    expect(replay.retryable).toBe(0);
    expect(built.state.periods).toHaveLength(0);
    expect(built.db.syncClanMemberSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(built.evidenceService.getMembershipBoundaryEvidenceForPlayers).toHaveBeenCalledTimes(1);
  });

  it("establishes one Home period after three consecutive exact non-filler syncs", async () => {
    const { service, state } = serviceFor();

    const result = await service.reconcileLatestExactBoundaries();

    expect(result.established).toBe(1);
    expect(state.periods).toMatchObject([{
      guildId,
      playerTag,
      clanTag: rr,
      startedAtSyncTime: time(1),
      qualifiedAtSyncTime: time(3),
      establishmentSource: "AUTO_3_SYNC",
    }]);
  });

  it("credits the first sync as startedAt and the third as qualifiedAt", async () => {
    const { service, state } = serviceFor();

    await service.reconcileLatestExactBoundaries();

    expect(state.periods[0].startedAtSyncTime).toEqual(time(1));
    expect(state.periods[0].qualifiedAtSyncTime).toEqual(time(3));
  });

  it("does not duplicate a replayed boundary", async () => {
    const built = serviceFor();

    await built.service.reconcileLatestExactBoundaries();
    const memberReads = built.db.syncClanMemberSnapshot.findMany.mock.calls.length;
    const evidenceReads = built.evidenceService.getMembershipBoundaryEvidenceForPlayers.mock.calls.length;
    const readinessReads = built.db.syncClanReadinessSnapshot.findMany.mock.calls.length;
    const activeHomeReads = built.db.clanHomeMembershipPeriod.findMany.mock.calls.length;
    const activeHomeChecks = built.db.clanHomeMembershipPeriod.findFirst.mock.calls.length;
    const homeWrites = built.db.clanHomeMembershipPeriod.create.mock.calls.length;

    const replay = await built.service.reconcileLatestExactBoundaries();

    expect(replay).toEqual({
      guilds: 0,
      boundaries: 0,
      evaluated: 0,
      established: 0,
      skippedExisting: 0,
      skippedFillerOrUnknown: 0,
      retryable: 0,
      transferEvaluated: 0,
      transferCandidatesCreated: 0,
      transferPendingExisting: 0,
      transferCwlSuppressed: 0,
    });
    expect(built.db.syncClanMemberSnapshot.groupBy).toHaveBeenCalledTimes(2);
    expect(built.db.syncClanMemberSnapshot.findMany).toHaveBeenCalledTimes(memberReads);
    expect(built.evidenceService.getMembershipBoundaryEvidenceForPlayers).toHaveBeenCalledTimes(evidenceReads);
    expect(built.db.syncClanReadinessSnapshot.findMany).toHaveBeenCalledTimes(readinessReads);
    expect(built.db.clanHomeMembershipPeriod.findMany).toHaveBeenCalledTimes(activeHomeReads);
    expect(built.db.clanHomeMembershipPeriod.findFirst).toHaveBeenCalledTimes(activeHomeChecks);
    expect(built.db.clanHomeMembershipPeriod.create).toHaveBeenCalledTimes(homeWrites);
    expect(built.state.periods).toHaveLength(1);
  });

  it("remains idempotent after service restart", async () => {
    const first = serviceFor();
    await first.service.reconcileLatestExactBoundaries();
    const restarted = new ClanHomeMembershipService(first.db as any, {
      getMembershipBoundaryEvidenceForPlayers: vi.fn(async () => first.evidenceByPlayer),
    });

    await restarted.reconcileLatestExactBoundaries();

    expect(first.state.periods).toHaveLength(1);
  });

  it("never overwrites an existing active Home when the physical clan changes", async () => {
    const existing = {
      id: "home-1",
      guildId,
      playerTag,
      clanTag: eb,
      startedAtSyncTime: time(1),
      qualifiedAtSyncTime: time(1),
      endedAtSyncTime: null,
      establishmentSource: "MANUAL",
      endReason: null,
    };
    const { service, state } = serviceFor({ periods: [existing] });

    await service.reconcileLatestExactBoundaries();

    expect(state.periods).toEqual([existing]);
  });

  it("does not qualify RR to EB back to RR", async () => {
    const { service, state } = serviceFor({
      evidence: [fwaEvidence(3), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1)],
    });

    await service.reconcileLatestExactBoundaries();

    expect(state.periods).toHaveLength(0);
  });

  it.each([
    ["UNKNOWN", fwaEvidence(2, { status: "UNKNOWN", clanTag: null })],
    ["AMBIGUOUS", fwaEvidence(2, { status: "AMBIGUOUS", clanTag: rr })],
    ["ABSENT", fwaEvidence(2, { status: "ABSENT", clanTag: null })],
    ["historical fallback", fwaEvidence(2, { source: "FWA_WAR_PARTICIPATION_FALLBACK" })],
  ])("does not qualify with a %s middle boundary", (_label, middle) => {
    const { service, state } = serviceFor({ evidence: [fwaEvidence(3), middle, fwaEvidence(1)] });

    return service.reconcileLatestExactBoundaries().then(() => {
      expect(state.periods).toHaveLength(0);
    });
  });

  it("does not qualify from alliance interval-only evidence", async () => {
    const { service, state } = serviceFor({
      evidence: [
        fwaEvidence(3, { status: "UNKNOWN", clanTag: null, alliancePositive: true }),
        fwaEvidence(2, { status: "UNKNOWN", clanTag: null, alliancePositive: true }),
        fwaEvidence(1, { status: "UNKNOWN", clanTag: null, alliancePositive: true }),
      ],
    });

    await service.reconcileLatestExactBoundaries();

    expect(state.periods).toHaveLength(0);
  });

  it("does not qualify when filler is present on any qualifying boundary", async () => {
    const { service, state } = serviceFor({
      readinessRows: [readiness(3), readiness(2, { fillerPlayerTags: [playerTag] }), readiness(1)],
    });

    await service.reconcileLatestExactBoundaries();

    expect(state.periods).toHaveLength(0);
  });

  it("does not qualify when filler capture is incomplete", async () => {
    const { service, state } = serviceFor({
      readinessRows: [readiness(3), readiness(2, { complete: false }), readiness(1)],
    });

    await service.reconcileLatestExactBoundaries();

    expect(state.periods).toHaveLength(0);
  });

  it("treats known filler as permanent even when an older readiness row is missing", async () => {
    const built = serviceFor({
      readinessRows: [readiness(3), readiness(2, { fillerPlayerTags: [playerTag] })],
    });

    const result = await built.service.reconcileLatestExactBoundaries();

    expect(result.retryable).toBe(0);
    expect(result.skippedFillerOrUnknown).toBe(1);
    expect(built.state.periods).toHaveLength(0);
  });

  it("treats incomplete filler capture as permanent even when an older readiness row is missing", async () => {
    const built = serviceFor({
      readinessRows: [readiness(3), readiness(2, { complete: false })],
    });

    const result = await built.service.reconcileLatestExactBoundaries();

    expect(result.retryable).toBe(0);
    expect(result.skippedFillerOrUnknown).toBe(1);
    expect(built.state.periods).toHaveLength(0);
  });

  it("keeps an otherwise eligible candidate retryable when only readiness is missing", async () => {
    const built = serviceFor({ readinessRows: [readiness(3), readiness(2)] });

    const result = await built.service.reconcileLatestExactBoundaries();

    expect(result.retryable).toBe(1);
    expect(result.skippedFillerOrUnknown).toBe(0);
    expect(built.state.periods).toHaveLength(0);
  });

  it("does not create a transfer candidate after one ordinary EB boundary", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb })],
    });

    const result = await built.service.reconcileLatestExactBoundaries();

    expect(result.transferCandidatesCreated).toBe(0);
    expect(result.retryable).toBe(0);
    expect(built.state.candidateRows).toHaveLength(0);
  });

  it("does not create a transfer candidate after two ordinary EB boundaries", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb })],
    });

    const result = await built.service.reconcileLatestExactBoundaries();

    expect(result.transferCandidatesCreated).toBe(0);
    expect(result.retryable).toBe(0);
    expect(built.state.candidateRows).toHaveLength(0);
  });

  it("creates one pending transfer candidate after three ordinary EB boundaries", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });

    const result = await built.service.reconcileLatestExactBoundaries();

    expect(result.transferCandidatesCreated).toBe(1);
    expect(built.state.candidateRows).toMatchObject([{
      status: "PENDING",
      homeMembershipPeriodId: "home-1",
      fromClanTag: rr,
      toClanTag: eb,
      startedAtSyncTime: time(1),
      qualifiedAtSyncTime: time(3),
    }]);
  });

  it.each([
    ["RR -> EB -> DE -> EB", [fwaEvidence(4, { clanTag: eb }), fwaEvidence(3, { clanTag: de }), fwaEvidence(2, { clanTag: eb })]],
    ["UNKNOWN middle boundary", [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { status: "UNKNOWN", clanTag: null }), fwaEvidence(1, { clanTag: eb })]],
    ["ABSENT middle boundary", [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { status: "ABSENT", clanTag: null }), fwaEvidence(1, { clanTag: eb })]],
    ["AMBIGUOUS middle boundary", [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { status: "AMBIGUOUS", clanTag: eb }), fwaEvidence(1, { clanTag: eb })]],
    ["historical fallback", [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb, source: "FWA_WAR_PARTICIPATION_FALLBACK" }), fwaEvidence(1, { clanTag: eb })]],
  ])("does not qualify a transfer from %s", async (_label, evidence) => {
    const built = serviceFor({
      memberRows: [member(evidence[0].boundaryTime.getUTCDate(), eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb, de],
      evidence,
    });

    await built.service.reconcileLatestExactBoundaries();

    expect(built.state.candidateRows).toHaveLength(0);
  });

  it("does not qualify a destination that is not a permanent TrackedClan", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });

    await built.service.reconcileLatestExactBoundaries();

    expect(built.state.candidateRows).toHaveLength(0);
  });

  it("does not qualify three syncs that remain in the active Home clan", async () => {
    const built = serviceFor({
      periods: [activeHome(rr)],
      trackedTags: [rr],
      evidence: [fwaEvidence(3, { clanTag: rr }), fwaEvidence(2, { clanTag: rr }), fwaEvidence(1, { clanTag: rr })],
    });

    await built.service.reconcileLatestExactBoundaries();

    expect(built.state.candidateRows).toHaveLength(0);
  });

  it("does not duplicate a pending candidate across replay or service restart", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });

    await built.service.reconcileLatestExactBoundaries();
    await built.service.reconcileLatestExactBoundaries();
    const restarted = new ClanHomeMembershipService(built.db as any, {
      getMembershipBoundaryEvidenceForPlayers: vi.fn(async () => built.evidenceByPlayer),
    }, built.cwlWindowReader);
    await restarted.reconcileLatestExactBoundaries();

    expect(built.state.candidateRows).toHaveLength(1);
  });

  it("treats a concurrent candidate-create unique race as one pending candidate", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
      candidateRaceOnCreate: true,
    });

    const result = await built.service.reconcileLatestExactBoundaries();

    expect(result.transferCandidatesCreated).toBe(0);
    expect(built.state.candidateRows).toHaveLength(1);
  });

  it("does not create another candidate while one is pending", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      candidateRows: [{
        id: "candidate-1",
        guildId,
        playerTag,
        homeMembershipPeriodId: "home-1",
        fromClanTag: rr,
        toClanTag: eb,
        startedAtSyncTime: time(1),
        qualifiedAtSyncTime: time(3),
        status: "PENDING",
        decidedAt: null,
        decidedByDiscordUserId: null,
      }],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });

    const result = await built.service.reconcileLatestExactBoundaries();

    expect(result.transferCandidatesCreated).toBe(0);
    expect(result.transferPendingExisting).toBe(1);
    expect(built.evidenceService.getMembershipBoundaryEvidenceForPlayers).not.toHaveBeenCalled();
  });

  it.each([
    ["inside a persisted CWL window", cwlWindow({ hasTrackedCwlClans: true, resolvedEventCount: 1, startsAt: time(1), endsAt: time(4), startTimingResolved: true, endTimingResolved: true, timingCoverageComplete: true, missingTimingDetails: [] }), [3, 2, 1]],
    ["after an ongoing CWL start", cwlWindow({ hasTrackedCwlClans: true, resolvedEventCount: 1, startsAt: time(2), endsAt: null, startTimingResolved: true, endTimingResolved: false, missingTimingDetails: ["event-1:FINAL_END_ROUND_7"] }), [3, 2, 1]],
    ["with unresolved CWL timing", cwlWindow({ hasTrackedCwlClans: true, resolvedEventCount: 1, startsAt: null, endsAt: null, startTimingResolved: false, endTimingResolved: false, timingCoverageComplete: false, missingTimingDetails: ["event-1:START_ROUND_1"] }), [3, 2, 1]],
  ])("suppresses a transfer when the run is %s", async (_label, window, days) => {
    const built = serviceFor({
      memberRows: [member(days[0], eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      cwlWindows: { "2026-08": window },
      evidence: days.map((day) => fwaEvidence(day, { clanTag: eb })),
    });

    const result = await built.service.reconcileLatestExactBoundaries();

    expect(result.transferCwlSuppressed).toBe(1);
    expect(built.state.candidateRows).toHaveLength(0);
  });

  it("keeps known pre-CWL boundaries ordinary", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      cwlWindows: { "2026-08": cwlWindow({ hasTrackedCwlClans: true, resolvedEventCount: 1, startsAt: time(5), startTimingResolved: true, missingTimingDetails: ["event-1:FINAL_END_ROUND_7"] }) },
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });

    await built.service.reconcileLatestExactBoundaries();

    expect(built.state.candidateRows).toHaveLength(1);
  });

  it("keeps known post-CWL boundaries ordinary", async () => {
    const days = [6, 5, 4];
    const built = serviceFor({
      memberRows: [member(days[0], eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      cwlWindows: { "2026-08": cwlWindow({ hasTrackedCwlClans: true, resolvedEventCount: 1, startsAt: time(1), endsAt: time(3), startTimingResolved: true, endTimingResolved: true, timingCoverageComplete: true, missingTimingDetails: [] }) },
      evidence: days.map((day) => fwaEvidence(day, { clanTag: eb })),
    });

    await built.service.reconcileLatestExactBoundaries();

    expect(built.state.candidateRows).toHaveLength(1);
  });

  it("Keep Home leaves the active Home untouched and records the decision", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;

    const result = await built.service.keepHomeTransferCandidate(decisionInput(candidateId, "leader-1", time(10)));

    expect(result.status).toBe("KEPT_HOME");
    expect(result).toMatchObject({
      candidate: {
        status: "KEPT_HOME",
        decidedAt: time(10),
        decidedByDiscordUserId: "leader-1",
      },
    });
    expect(built.state.candidateRows[0]).toMatchObject({ status: "KEPT_HOME", decidedAt: time(10), decidedByDiscordUserId: "leader-1" });
    expect(built.state.periods).toMatchObject([{ id: "home-1", clanTag: rr, endedAtSyncTime: null }]);
  });

  it("Keep Home is idempotent on replay", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;

    await built.service.keepHomeTransferCandidate(decisionInput(candidateId, "leader-1", time(10)));
    const replay = await built.service.keepHomeTransferCandidate(decisionInput(candidateId, "leader-2", time(11)));

    expect(replay).toEqual({ status: "ALREADY_RESOLVED", candidateId, resolvedStatus: "KEPT_HOME" });
    expect(built.state.candidateRows[0].decidedByDiscordUserId).toBe("leader-1");
  });

  it("requires three fresh boundaries after Keep Home before creating another candidate", async () => {
    const built = serviceFor({
      memberRows: [member(12, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(12, { clanTag: eb }), fwaEvidence(11, { clanTag: eb }), fwaEvidence(10, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;
    await built.service.keepHomeTransferCandidate(decisionInput(candidateId, "leader-1", time(12)));

    built.state.memberRows = [member(13, eb)];
    built.evidenceByPlayer[playerTag] = [fwaEvidence(13, { clanTag: eb }), fwaEvidence(12, { clanTag: eb }), fwaEvidence(11, { clanTag: eb })];
    await built.service.reconcileLatestExactBoundaries();
    expect(built.state.candidateRows).toHaveLength(1);

    built.state.memberRows = [member(15, eb)];
    built.evidenceByPlayer[playerTag] = [fwaEvidence(15, { clanTag: eb }), fwaEvidence(14, { clanTag: eb }), fwaEvidence(13, { clanTag: eb })];
    await built.service.reconcileLatestExactBoundaries();

    expect(built.state.candidateRows).toHaveLength(2);
    expect(built.state.candidateRows[1]).toMatchObject({ startedAtSyncTime: time(13), qualifiedAtSyncTime: time(15) });
  });

  it("confirms a transfer by ending the old Home and creating a TRANSFER Home", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidate = built.state.candidateRows[0];

    const result = await built.service.confirmHomeTransferCandidate(decisionInput(candidate.id, "leader-1", time(10)));

    expect(result.status).toBe("CONFIRMED");
    expect(result).toMatchObject({
      candidate: {
        status: "CONFIRMED",
        decidedAt: time(10),
        decidedByDiscordUserId: "leader-1",
      },
    });
    expect(built.state.periods).toMatchObject([
      { id: "home-1", clanTag: rr, endedAtSyncTime: time(1), endReason: "TRANSFERRED" },
      { clanTag: eb, startedAtSyncTime: time(1), qualifiedAtSyncTime: time(3), establishmentSource: "TRANSFER", endedAtSyncTime: null },
    ]);
    expect(built.state.candidateRows[0]).toMatchObject({ status: "CONFIRMED", decidedAt: time(10), decidedByDiscordUserId: "leader-1" });
  });

  it("returns already resolved on repeat confirm", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;
    await built.service.confirmHomeTransferCandidate(decisionInput(candidateId, "leader-1", time(10)));

    const replay = await built.service.confirmHomeTransferCandidate(decisionInput(candidateId, "leader-2", time(11)));

    expect(replay).toEqual({ status: "ALREADY_RESOLVED", candidateId, resolvedStatus: "CONFIRMED" });
    expect(built.state.periods.filter((period) => period.endedAtSyncTime === null)).toHaveLength(1);
  });

  it("resolves confirm-versus-keep races to one decision", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;

    const [confirm, keep] = await Promise.all([
      built.service.confirmHomeTransferCandidate(decisionInput(candidateId, "leader-confirm", time(10))),
      built.service.keepHomeTransferCandidate(decisionInput(candidateId, "leader-keep", time(11))),
    ]);

    expect([confirm.status, keep.status].filter((status) => status === "CONFIRMED" || status === "KEPT_HOME")).toHaveLength(1);
    expect([confirm.status, keep.status].some((status) => status === "ALREADY_RESOLVED")).toBe(true);
    expect(built.state.periods.filter((period) => period.endedAtSyncTime === null)).toHaveLength(1);
  });

  it("fails closed when the referenced Home period is stale", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;
    built.state.periods[0].endedAtSyncTime = time(4);

    const result = await built.service.confirmHomeTransferCandidate(decisionInput(candidateId, "leader-1"));

    expect(result).toEqual({ status: "STALE", candidateId, reason: "HOME_PERIOD_NO_LONGER_MATCHES" });
    expect(built.state.candidateRows[0].status).toBe("PENDING");
    expect(built.state.periods).toHaveLength(1);
  });

  it("fails closed when the destination is no longer permanently tracked", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;
    built.state.trackedTags = [rr];

    const result = await built.service.confirmHomeTransferCandidate(decisionInput(candidateId, "leader-1"));

    expect(result).toEqual({ status: "STALE", candidateId, reason: "DESTINATION_NOT_TRACKED" });
    expect(built.state.periods).toHaveLength(1);
  });

  it.each([
    ["guild", { guildId: "forged-guild", expectedFromClanTag: rr }],
    ["clan", { guildId, expectedFromClanTag: eb }],
  ])("rejects a forged %s decision scope without mutation", async (_label, scope) => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;

    const result = await built.service.keepHomeTransferCandidate({
      ...decisionInput(candidateId, "leader-1"),
      ...scope,
    });

    expect(result).toMatchObject({ status: "STALE" });
    expect(built.state.candidateRows[0].status).toBe("PENDING");
    expect(built.state.periods).toMatchObject([{ id: "home-1", endedAtSyncTime: null }]);
    expect(built.db.clanHomeTransferCandidate.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a stale active Home period for Keep Home without mutation", async () => {
    const built = serviceFor({
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;
    built.state.periods[0].endedAtSyncTime = time(4);

    const result = await built.service.keepHomeTransferCandidate(decisionInput(candidateId, "leader-1"));

    expect(result).toEqual({ status: "STALE", candidateId, reason: "HOME_PERIOD_NO_LONGER_MATCHES" });
    expect(built.db.clanHomeTransferCandidate.updateMany).not.toHaveBeenCalled();
  });

  it.each(["keep", "confirm"] as const)("blocks direct %s decisions in mirror mode", async (decision) => {
    const built = serviceFor({
      mirrorMode: true,
      memberRows: [member(3, eb)],
      periods: [activeHome(rr)],
      trackedTags: [rr, eb],
      evidence: [fwaEvidence(3, { clanTag: eb }), fwaEvidence(2, { clanTag: eb }), fwaEvidence(1, { clanTag: eb })],
    });
    await built.service.reconcileLatestExactBoundaries();
    const candidateId = built.state.candidateRows[0].id;
    built.db.$transaction.mockClear();
    const result = decision === "keep"
      ? await built.service.keepHomeTransferCandidate(decisionInput(candidateId, "leader-1"))
      : await built.service.confirmHomeTransferCandidate(decisionInput(candidateId, "leader-1"));

    expect(result).toEqual({ status: "WRITE_DISABLED", candidateId, reason: "MIRROR_MODE" });
    expect(built.state.candidateRows[0].status).toBe("PENDING");
    expect(built.db.$transaction).not.toHaveBeenCalled();
  });

  it("reads pending candidates in bulk without N+1 queries", async () => {
    const built = serviceFor({ candidateRows: [
      {
        id: "candidate-1", guildId, playerTag, homeMembershipPeriodId: "home-1", fromClanTag: rr, toClanTag: eb,
        startedAtSyncTime: time(1), qualifiedAtSyncTime: time(3), status: "PENDING", decidedAt: null, decidedByDiscordUserId: null,
      },
    ] });

    const result = await built.service.getPendingTransferCandidates({ guildId, playerTags: [playerTag], fromClanTag: rr });

    expect(result).toMatchObject([{ id: "candidate-1", playerTag, fromClanTag: rr, toClanTag: eb }]);
    expect(built.db.clanHomeTransferCandidate.findMany).toHaveBeenCalledTimes(1);
  });

  it("uses immutable readiness filler facts and never consults FillerAccount", async () => {
    const built = serviceFor();

    await built.service.reconcileLatestExactBoundaries();

    expect((built.db as any).fillerAccount).toBeUndefined();
    expect(built.state.periods).toHaveLength(1);
  });

  it("allows an unlinked player tag to receive Home membership", async () => {
    const { service, state } = serviceFor();

    await service.reconcileLatestExactBoundaries();

    expect(state.periods[0].playerTag).toBe(playerTag);
  });

  it("treats a concurrent partial-unique race as an idempotent no-op", async () => {
    const { service, state } = serviceFor({ raceOnCreate: true });

    const result = await service.reconcileLatestExactBoundaries();

    expect(result.established).toBe(0);
    expect(state.periods).toHaveLength(1);
  });

  it("does not end an existing Home period during temporary physical absence", async () => {
    const existing = {
      id: "home-1",
      guildId,
      playerTag,
      clanTag: rr,
      startedAtSyncTime: time(1),
      qualifiedAtSyncTime: time(3),
      endedAtSyncTime: null,
      establishmentSource: "AUTO_3_SYNC",
      endReason: null,
    };
    const { service, state } = serviceFor({
      periods: [existing],
      evidence: [fwaEvidence(3, { status: "ABSENT", clanTag: null })],
    });

    await service.reconcileLatestExactBoundaries();

    expect(state.periods[0].endedAtSyncTime).toBeNull();
  });

  it("leaves a missing readiness row retryable instead of marking the boundary complete", async () => {
    const built = serviceFor({ readinessRows: [readiness(3)] });

    const first = await built.service.reconcileLatestExactBoundaries();
    expect(first.retryable).toBe(1);
    expect(built.state.periods).toHaveLength(0);

    built.state.readinessRows.push(readiness(2), readiness(1));
    const second = await built.service.reconcileLatestExactBoundaries();

    expect(second.established).toBe(1);
    expect(built.state.periods).toHaveLength(1);
  });
});
