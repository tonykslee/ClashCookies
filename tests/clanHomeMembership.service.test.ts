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
  raceOnCreate?: boolean;
};

function makeDb(fixture: Fixture = {}) {
  const state = {
    memberRows: fixture.memberRows ?? [member(3)],
    readinessRows: fixture.readinessRows ?? [readiness(3), readiness(2), readiness(1)],
    trackedTags: fixture.trackedTags ?? [rr],
    periods: [...(fixture.periods ?? [])],
    raceOnCreate: fixture.raceOnCreate ?? false,
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
    $transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn({ clanHomeMembershipPeriod: periodModel })),
  };
  return { db, state, evidenceByPlayer };
}

function serviceFor(fixture: Fixture = {}) {
  const built = makeDb(fixture);
  const evidenceService = {
    getMembershipBoundaryEvidenceForPlayers: vi.fn(async () => built.evidenceByPlayer),
  };
  return {
    ...built,
    service: new ClanHomeMembershipService(built.db as any, evidenceService),
    evidenceService,
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
    const { service, state } = serviceFor({ evidence: [fwaEvidence(3)] });

    const result = await service.reconcileLatestExactBoundaries();

    expect(result.established).toBe(0);
    expect(state.periods).toHaveLength(0);
  });

  it("does not establish Home after two qualifying exact syncs", async () => {
    const { service, state } = serviceFor({ evidence: [fwaEvidence(3), fwaEvidence(2)] });

    await service.reconcileLatestExactBoundaries();

    expect(state.periods).toHaveLength(0);
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
    const { service, state } = serviceFor();

    await service.reconcileLatestExactBoundaries();
    await service.reconcileLatestExactBoundaries();

    expect(state.periods).toHaveLength(1);
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
