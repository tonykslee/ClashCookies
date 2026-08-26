import { describe, expect, it, vi } from "vitest";
import {
  ActiveWarSyncResolutionService,
  buildActiveWarSyncIdentity,
  resolveActiveWarSyncNumber,
  resolveActiveWarSyncNumberReadOnly,
  resolveCurrentWarSyncIdentity,
} from "../src/services/ActiveWarSyncResolutionService";
import { SyncCycleResolutionSource } from "@prisma/client";
import type { SyncCycleService } from "../src/services/SyncCycleService";

describe("ActiveWarSyncResolutionService resolver", () => {
  it("fails closed for positively resolved preparation wars without sync evidence", () => {
    const resolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "preparation",
        warId: "4001",
      }),
      latestPersistedSyncNumber: 552,
      sameWarPersistedSyncNumber: null,
    });

    expect(resolution).toMatchObject({
      syncNumber: null,
      source: "none",
      isDerived: false,
    });
  });

  it("drops CurrentWar warId when live identity is only partially available", () => {
    const identity = resolveCurrentWarSyncIdentity({
      clanTag: "AAA111",
      warState: "inWar",
      liveWarStartTime: "20260312T090000.000Z",
      liveOpponentTag: null,
      currentWarId: 1001,
      currentWarStartTime: new Date("2026-03-12T09:00:00.000Z"),
      currentWarOpponentTag: "#2OLD",
    });

    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-03-12T09:00:00.000Z");
    expect(identity.opponentTag).toBe("20LD");
    expect(identity.positivelyResolved).toBe(true);
  });

  it("fails closed for positively resolved in-war identities without sync evidence", () => {
    const resolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warStartTime: new Date("2026-04-13T08:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      latestPersistedSyncNumber: 552,
      sameWarPersistedSyncNumber: null,
    });

    expect(resolution).toMatchObject({
      syncNumber: null,
      source: "none",
      isDerived: false,
    });
  });

  it("uses latest persisted sync without +1 for not-in-war paths", () => {
    const resolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "notInWar",
      }),
      latestPersistedSyncNumber: 500,
      sameWarPersistedSyncNumber: null,
    });

    expect(resolution).toMatchObject({
      syncNumber: 500,
      source: "historical_latest_persisted",
      isDerived: false,
    });
  });

  it("lets exact same-war evidence supersede a stale materialized CurrentWar sync", () => {
    const resolution = resolveActiveWarSyncNumberReadOnly({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4006",
      }),
      latestPersistedSyncNumber: 552,
      sameWarPersistedSyncNumber: 552,
      currentWarSyncNumber: 553,
    });

    expect(resolution).toMatchObject({
      syncNumber: 552,
      source: "same_war_persisted",
      isDerived: false,
    });
  });

  it("does not treat a legacy materialized CurrentWar sync as active evidence", () => {
    const resolution = resolveActiveWarSyncNumberReadOnly({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4007",
      }),
      latestPersistedSyncNumber: 552,
      sameWarPersistedSyncNumber: null,
      currentWarSyncNumber: 553,
    });

    expect(resolution).toMatchObject({
      syncNumber: null,
      source: "none",
      isDerived: false,
    });
  });

  it("prefers same-war persisted sync over every fallback", () => {
    const resolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4002",
      }),
      latestPersistedSyncNumber: 500,
      sameWarPersistedSyncNumber: 503,
      postedSyncNumber: 502,
      allowPostedSyncReuse: true,
    });

    expect(resolution).toMatchObject({
      syncNumber: 503,
      source: "same_war_persisted",
      isDerived: false,
    });
  });

  it("reuses posted sync only for refresh continuity when allowed", () => {
    const refreshResolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4003",
      }),
      latestPersistedSyncNumber: 500,
      sameWarPersistedSyncNumber: null,
      postedSyncNumber: 501,
      allowPostedSyncReuse: true,
    });
    const freshResolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4003",
      }),
      latestPersistedSyncNumber: 500,
      sameWarPersistedSyncNumber: null,
      postedSyncNumber: 501,
      allowPostedSyncReuse: false,
    });

    expect(refreshResolution).toMatchObject({
      syncNumber: 501,
      source: "refresh_posted_sync",
      isDerived: false,
    });
    expect(freshResolution).toMatchObject({
      syncNumber: null,
      source: "none",
      isDerived: false,
    });
  });

  it("returns unknown instead of reusing a stale sync when active identity is ambiguous", () => {
    const resolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "preparation",
      }),
      latestPersistedSyncNumber: 500,
      sameWarPersistedSyncNumber: null,
    });

    expect(resolution).toMatchObject({
      syncNumber: null,
      source: "none",
      isDerived: false,
    });
  });

  it("switches from unavailable to same-war persisted once points persistence catches up", () => {
    const unavailableResolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4004",
      }),
      latestPersistedSyncNumber: 500,
      sameWarPersistedSyncNumber: null,
    });
    const persistedResolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4004",
      }),
      latestPersistedSyncNumber: 500,
      sameWarPersistedSyncNumber: 501,
    });

    expect(unavailableResolution.syncNumber).toBeNull();
    expect(unavailableResolution.source).toBe("none");
    expect(persistedResolution.syncNumber).toBe(501);
    expect(persistedResolution.source).toBe("same_war_persisted");
  });

  it("returns none when no persisted baseline exists", () => {
    const resolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4005",
      }),
      latestPersistedSyncNumber: null,
      sameWarPersistedSyncNumber: null,
    });

    expect(resolution).toMatchObject({
      syncNumber: null,
      source: "none",
      isDerived: false,
    });
  });

  it("persists a locally derived active FWA cycle without points-site evidence", async () => {
    const syncTime = new Date("2026-04-13T08:00:00.000Z");
    let boundInput: Record<string, unknown> | null = null;
    const syncCycles = {
      resolveActiveWarCycle: async () => ({
        status: "derived" as const,
        syncNumber: 553,
        scheduledSyncPostId: "post-b",
        syncTime,
        previousSyncNumber: 552,
        reason: "previous_cycle_immediate_next_schedule",
        resolutionSource: SyncCycleResolutionSource.ACTIVE_WAR_CONFIRMED,
      }),
      bindResolvedCanonical: async (input: Record<string, unknown>) => {
        boundInput = input;
        return { status: "created" as const, cycle: {} as never };
      },
    } as unknown as SyncCycleService;
    const service = new ActiveWarSyncResolutionService(undefined, syncCycles);

    const resolution = await service.resolveActiveWarSyncFromCanonicalCycle({
      guildId: "guild-1",
      identity: buildActiveWarSyncIdentity({
        warState: "preparation",
        warStartTime: syncTime,
        opponentTag: "#OPP123",
      }),
      preparationStartTime: new Date("2026-04-12T08:00:00.000Z"),
      matchType: "FWA",
      inferredMatchType: false,
      persistCanonical: true,
    });

    expect(resolution).toMatchObject({
      syncNumber: 553,
      source: "active_war_confirmed",
      status: "derived",
      scheduledSyncPostId: "post-b",
    });
    expect(boundInput).toMatchObject({
      guildId: "guild-1",
      syncNumber: 553,
      scheduledSyncPostId: "post-b",
      resolutionSource: SyncCycleResolutionSource.ACTIVE_WAR_CONFIRMED,
    });
  });

  it("uses an inferred active FWA candidate without persisting a new canonical cycle", async () => {
    const syncTime = new Date("2026-04-13T08:00:00.000Z");
    const bindResolvedCanonical = vi.fn();
    const syncCycles = {
      resolveActiveWarCycle: async () => ({
        status: "derived" as const,
        syncNumber: 553,
        scheduledSyncPostId: "post-b",
        syncTime,
        previousSyncNumber: 552,
        reason: "previous_cycle_immediate_next_schedule",
        resolutionSource: null,
      }),
      bindResolvedCanonical,
    } as unknown as SyncCycleService;
    const service = new ActiveWarSyncResolutionService(undefined, syncCycles);

    const resolution = await service.resolveActiveWarSyncFromCanonicalCycle({
      guildId: "guild-1",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warStartTime: syncTime,
        opponentTag: "#OPP123",
      }),
      preparationStartTime: new Date("2026-04-12T08:00:00.000Z"),
      matchType: "FWA",
      inferredMatchType: true,
      persistCanonical: true,
    });

    expect(resolution).toMatchObject({
      syncNumber: 553,
      source: "active_war_schedule_candidate",
      status: "derived",
    });
    expect(bindResolvedCanonical).not.toHaveBeenCalled();
  });

  it("reuses an exact canonical active cycle while FWA type is still inferred", async () => {
    const syncTime = new Date("2026-04-13T08:00:00.000Z");
    const bindResolvedCanonical = vi.fn();
    const syncCycles = {
      resolveActiveWarCycle: async () => ({
        status: "exact" as const,
        syncNumber: 553,
        scheduledSyncPostId: "post-b",
        syncTime,
        previousSyncNumber: null,
        reason: "exact_sync_cycle",
        resolutionSource: SyncCycleResolutionSource.ACTIVE_WAR_CONFIRMED,
      }),
      bindResolvedCanonical,
    } as unknown as SyncCycleService;
    const service = new ActiveWarSyncResolutionService(undefined, syncCycles);

    const resolution = await service.resolveActiveWarSyncFromCanonicalCycle({
      guildId: "guild-1",
      identity: buildActiveWarSyncIdentity({
        warState: "preparation",
        warStartTime: syncTime,
        opponentTag: "#OPP123",
      }),
      preparationStartTime: new Date("2026-04-12T08:00:00.000Z"),
      matchType: "FWA",
      inferredMatchType: true,
      persistCanonical: true,
    });

    expect(resolution).toMatchObject({
      syncNumber: 553,
      status: "exact",
    });
    expect(bindResolvedCanonical).not.toHaveBeenCalled();
  });

  it.each(["BL", "MM", "SKIP"])(
    "never persists an active FWA cycle for confirmed %s evidence",
    async (matchType) => {
      const bindResolvedCanonical = vi.fn();
      const resolveActiveWarCycle = vi.fn();
      const syncCycles = {
        resolveActiveWarCycle,
        bindResolvedCanonical,
      } as unknown as SyncCycleService;
      const service = new ActiveWarSyncResolutionService(undefined, syncCycles);

      const resolution = await service.resolveActiveWarSyncFromCanonicalCycle({
        guildId: "guild-1",
        identity: buildActiveWarSyncIdentity({
          warState: "inWar",
          warStartTime: new Date("2026-04-13T08:00:00.000Z"),
          opponentTag: "#OPP123",
        }),
        preparationStartTime: new Date("2026-04-12T08:00:00.000Z"),
        matchType,
        inferredMatchType: false,
        persistCanonical: true,
      });

      expect(resolution).toMatchObject({
        syncNumber: null,
        status: "not_fwa",
      });
      expect(resolveActiveWarCycle).not.toHaveBeenCalled();
      expect(bindResolvedCanonical).not.toHaveBeenCalled();
    },
  );
});
