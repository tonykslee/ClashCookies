import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { ChannelType, EmbedBuilder } from "discord.js";
import { prisma } from "../src/prisma";
import { MaintenanceWindowService } from "../src/services/MaintenanceWindowService";
import {
  WarEventLogService,
  buildWarEndDiscrepancyFingerprintForTest,
  buildNotifyWarRefreshCustomId,
} from "../src/services/WarEventLogService";

vi.spyOn(MaintenanceWindowService.prototype, "observeWarFetch").mockResolvedValue({
  maintenanceTransition: null,
});

beforeEach(() => {
  vi.spyOn(MaintenanceWindowService.prototype, "observeWarFetch").mockResolvedValue({
    maintenanceTransition: null,
  });
  vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) =>
    callback(prisma as any),
  );
  vi.spyOn(prisma.currentWar, "updateMany").mockImplementation(async (args: any) => {
    await prisma.currentWar.update(args as any);
    return { count: 1 } as any;
  });
});

function buildBasePayload(overrides?: Partial<Record<string, unknown>>) {
  return {
    eventType: "war_started" as const,
    clanTag: "#AAA111",
    clanName: "Alpha",
    opponentTag: "#OPP123",
    opponentName: "Enemy",
    syncNumber: 123,
    notifyRole: "555",
    pingRole: true,
    fwaPoints: 1000,
    opponentFwaPoints: 1001,
    outcome: "WIN" as const,
    matchType: "FWA" as const,
    warStartFwaPoints: 1000,
    warEndFwaPoints: 999,
    clanStars: 100,
    opponentStars: 99,
    prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
    warStartTime: new Date("2026-03-12T00:00:00.000Z"),
    warEndTime: new Date("2026-03-13T00:00:00.000Z"),
    clanAttacks: 1,
    opponentAttacks: 1,
    teamSize: 50,
    attacksPerMember: 2,
    clanDestruction: 70,
    opponentDestruction: 69,
    ...overrides,
  };
}

function makeSubscription(
  overrides?: Partial<Record<string, unknown>>
): Record<string, unknown> {
  return {
    guildId: "guild-1",
    clanTag: "#AAA111",
    warId: 1001,
    syncNum: 10,
    channelId: "chan-1",
    notify: true,
    pingRole: true,
    embedEnabled: true,
    inferredMatchType: false,
    notifyRole: "555",
    fwaPoints: 1200,
    opponentFwaPoints: 1201,
    outcome: "WIN",
    matchType: "FWA",
    warStartFwaPoints: 1200,
    warEndFwaPoints: null,
    clanStars: 100,
    opponentStars: 99,
    state: "inWar",
    prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
    startTime: new Date("2026-03-12T00:00:00.000Z"),
    endTime: new Date("2026-03-12T01:00:00.000Z"),
    opponentTag: "#OPP123",
    opponentName: "Enemy",
    clanName: "Alpha",
    pointsConfirmedByClanMail: false,
    pointsNeedsValidation: true,
    pointsLastSuccessfulFetchAt: null,
    pointsLastKnownSyncNumber: null,
    pointsLastKnownPoints: null,
    pointsLastKnownMatchType: null,
    pointsLastKnownOutcome: null,
    pointsWarId: null,
    pointsOpponentTag: null,
    pointsWarStartTime: null,
    ...overrides,
  };
}

function buildActiveWarIdentityMock(row: Record<string, unknown>, fallbackWarId = 1001) {
  const normalizeIdentityTag = (value: unknown) =>
    String(value ?? "")
      .trim()
      .toUpperCase()
      .replace(/O/g, "0")
      .replace(/^#/, "") || null;
  const readDate = (value: unknown) =>
    value instanceof Date
      ? Number.isFinite(value.getTime())
        ? value
        : null
      : value
        ? new Date(String(value))
        : null;
  const readState = (value: unknown) => {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized === "preparation") return "preparation" as const;
    if (normalized === "inwar") return "inWar" as const;
    return "notInWar" as const;
  };
  const buildPhysicalIdentity = (source: Record<string, unknown> | null) => {
    if (!source) return null;
    const state = readState(source.state);
    const warStartTime = readDate(source.startTime ?? source.warStartTime ?? null);
    const opponentTag = normalizeIdentityTag(source.opponentTag);
    if (state === "notInWar" || !warStartTime || !opponentTag) return null;
    return { state, warStartTime, opponentTag };
  };
  const buildMetadata = (source: Record<string, unknown> | null) => ({
    preparationStartTime: readDate(
      source?.prepStartTime ?? source?.preparationStartTime ?? null,
    ),
    warEndTime: readDate(source?.endTime ?? source?.warEndTime ?? null),
    opponentName: String(source?.opponentName ?? "").trim() || null,
    clanName: String(source?.clanName ?? "").trim() || null,
  });
  const resolveCurrentWarId = vi.fn().mockImplementation(async (params: any) => {
    const currentWarId =
      Number.isFinite(Number(row.warId)) && Number(row.warId) > 0
        ? Math.trunc(Number(row.warId))
        : fallbackWarId;
    const candidate = params?.candidateIdentity ?? null;
    const candidatePhysical = buildPhysicalIdentity(candidate);
    const candidateMetadata = buildMetadata(candidate);
    const persistedPhysical = buildPhysicalIdentity(row);
    const persistedMetadata = buildMetadata(row);

    if (params?.policy === "preserve_persisted") {
      if (!persistedPhysical || !Number.isFinite(Number(row.warId)) || Number(row.warId) <= 0) {
        return {
          status: "blocked",
          warId: null,
          reason: "missing_preserved_id",
        };
      }
      return {
        status: "resolved",
        source: "preserved_during_outage_recovery",
        warId: currentWarId,
        identity: {
          ...persistedPhysical,
          ...persistedMetadata,
        },
        identityPersisted: true,
        liveValidated: false,
      };
    }

    if (!candidatePhysical) {
      return {
        status: "blocked",
        warId: null,
        reason:
          String(candidate?.state ?? "").trim().toLowerCase() === "notinwar"
            ? "not_in_war"
            : "partial_live_identity",
      };
    }

    return {
      status: "resolved",
      source: "existing_exact_row",
      warId: currentWarId,
      identity: {
        ...candidatePhysical,
        ...candidateMetadata,
      },
      identityPersisted: true,
      liveValidated: params?.policy !== "preserve_persisted",
    };
  });

  return { resolveCurrentWarId };
}

function buildServiceWithHistoryStub(): WarEventLogService {
  const client = { channels: { fetch: vi.fn() } } as unknown as Client;
  const service = new WarEventLogService(client, {} as any);
  const history = (service as any).history;
  vi.spyOn(history, "buildWarPlanText").mockResolvedValue(null);
  vi.spyOn(history, "getWarEndResultSnapshot").mockResolvedValue({
    clanStars: 100,
    opponentStars: 99,
    clanDestruction: 70,
    opponentDestruction: 69,
    warEndTime: null,
    resultLabel: "WIN",
  });
  vi.spyOn(history, "getWarComplianceSnapshot").mockResolvedValue({
    missedBoth: [],
    notFollowingPlan: [],
  });
  return service;
}

describe("War-end opponent tag rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preview path renders opponent tag with a single leading #", async () => {
    const service = buildServiceWithHistoryStub();
    const message = await (service as any).buildEventMessage(buildBasePayload(), "guild-1", {
      includeRoleMention: false,
      includeEventComponents: false,
      warId: 1001,
    });
    const fields = message.embeds[0]?.data?.fields ?? [];
    const opponentField = fields.find((field) => field.name === "Opponent");
    expect(opponentField?.value).toBe("Enemy (#0PP123)");
    expect(opponentField?.value).not.toContain("##OPP123");
  });

  it("live posting path renders opponent tag with a single leading #", async () => {
    const send = vi.fn().mockResolvedValue({ id: "msg-1" });
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          type: ChannelType.GuildText,
          guildId: "guild-1",
          send,
        }),
      },
    } as unknown as Client;
    const service = new WarEventLogService(client, {} as any);
    (service as any).history = {
      buildWarPlanText: vi.fn().mockResolvedValue(null),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 70,
        opponentDestruction: 69,
        warEndTime: null,
        resultLabel: "WIN",
      }),
      getWarComplianceSnapshot: vi.fn().mockResolvedValue({
        missedBoth: [],
        notFollowingPlan: [],
      }),
    };
    await (service as any).emitEvent("chan-1", buildBasePayload(), 1001, undefined);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    const fields = sent?.embeds?.[0]?.data?.fields ?? [];
    const opponentField = fields.find((field: any) => field.name === "Opponent");
    expect(opponentField?.value).toBe("Enemy (#0PP123)");
    expect(opponentField?.value).not.toContain("##OPP123");
  });

  it("war-ended embed points line uses persisted expected points", async () => {
    const service = buildServiceWithHistoryStub();
    const payload = buildBasePayload({
      eventType: "war_ended",
      fwaPoints: 1300,
      warStartFwaPoints: 1200,
      warEndFwaPoints: 1199,
      matchType: "FWA",
      outcome: "WIN",
    });
    const message = await (service as any).buildEventMessage(payload, "guild-1", {
      includeRoleMention: false,
      includeEventComponents: false,
      warId: 1001,
    });
    const fields = message.embeds[0]?.data?.fields ?? [];
    const pointsField = fields.find((field) => field.name === "FWA Points");
    expect(pointsField?.value).toBe("Alpha: 1200 -> 1199 (-1)");
  });
});

describe("War-end expected points persistence via processSubscription", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runProcessSubscriptionCase(input: {
    subOverrides?: Partial<Record<string, unknown>>;
    finalResult: {
      clanStars: number | null;
      opponentStars: number | null;
      clanDestruction: number | null;
      opponentDestruction: number | null;
      warEndTime: Date | null;
      resultLabel: "WIN" | "LOSE" | "TIE" | "UNKNOWN";
    };
    expectedWarEndFwaPoints: number | null;
  }): Promise<Record<string, unknown> | undefined> {
    vi.clearAllMocks();
    const sub = makeSubscription(input.subOverrides);
    const activeWarIdentity = buildActiveWarIdentityMock(
      sub,
      Number(sub.warId ?? 1001),
    );
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
      { activeWarIdentity } as any,
    );

    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    const updateSpy = vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);

    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: null,
      observation: { kind: "success" },
    });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(1001);
    (service as any).activeWarIdentity = {
      resolveCurrentWarId: vi.fn().mockResolvedValue({
        status: "resolved",
        source: "preserved_during_outage_recovery",
        warId: Number(sub.warId ?? 1001),
        identity: {
          state: "inWar",
          warStartTime:
            sub.startTime instanceof Date
              ? sub.startTime
              : new Date("2026-03-12T00:00:00.000Z"),
          opponentTag: String(sub.opponentTag ?? "#OPP123").replace(/^#/, ""),
          preparationStartTime:
            sub.prepStartTime instanceof Date ? sub.prepStartTime : null,
          warEndTime: sub.endTime instanceof Date ? sub.endTime : null,
          opponentName: String(sub.opponentName ?? "Enemy").trim() || "Enemy",
          clanName: String(sub.clanName ?? "Alpha").trim() || "Alpha",
        },
        identityPersisted: true,
        liveValidated: false,
      }),
    };
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
    };
    (service as any).history = {
      resolveExactCanonicalWarEndedHistoryRow: vi.fn().mockResolvedValue(null),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue(input.finalResult),
    };

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateData = updateSpy.mock.calls[0]?.[0]?.data;
    expect(updateData?.warEndFwaPoints).toBe(input.expectedWarEndFwaPoints);
    return updateData;
  }

  it("persists FWA WIN/LOSE/TIE expected points using war-start before points", async () => {
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "FWA", warStartFwaPoints: 100, fwaPoints: 777 },
      finalResult: {
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 60,
        opponentDestruction: 50,
        warEndTime: null,
        resultLabel: "WIN",
      },
      expectedWarEndFwaPoints: 99,
    });
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "FWA", warStartFwaPoints: 100, fwaPoints: 777 },
      finalResult: {
        clanStars: 99,
        opponentStars: 100,
        clanDestruction: 60,
        opponentDestruction: 50,
        warEndTime: null,
        resultLabel: "LOSE",
      },
      expectedWarEndFwaPoints: 101,
    });
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "FWA", warStartFwaPoints: 100, fwaPoints: 777 },
      finalResult: {
        clanStars: 100,
        opponentStars: 100,
        clanDestruction: 60,
        opponentDestruction: 50,
        warEndTime: null,
        resultLabel: "TIE",
      },
      expectedWarEndFwaPoints: 100,
    });
  });

  it("persists MM expected points as +0", async () => {
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "MM", warStartFwaPoints: 350 },
      finalResult: {
        clanStars: 100,
        opponentStars: 90,
        clanDestruction: 70,
        opponentDestruction: 60,
        warEndTime: null,
        resultLabel: "WIN",
      },
      expectedWarEndFwaPoints: 350,
    });
  });

  it("persists BL expected points as +3 / +2 / +1 with strict >60 threshold", async () => {
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "BL", warStartFwaPoints: 500, teamSize: 50 },
      finalResult: {
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 55,
        opponentDestruction: 60,
        warEndTime: null,
        resultLabel: "WIN",
      },
      expectedWarEndFwaPoints: 503,
    });
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "BL", warStartFwaPoints: 500, teamSize: 50 },
      finalResult: {
        clanStars: 90,
        opponentStars: 100,
        clanDestruction: 60.01,
        opponentDestruction: 70,
        warEndTime: null,
        resultLabel: "LOSE",
      },
      expectedWarEndFwaPoints: 502,
    });
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "BL", warStartFwaPoints: 500, teamSize: 50 },
      finalResult: {
        clanStars: 90,
        opponentStars: 100,
        clanDestruction: 60,
        opponentDestruction: 70,
        warEndTime: null,
        resultLabel: "LOSE",
      },
      expectedWarEndFwaPoints: 501,
    });
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "BL", warStartFwaPoints: 500, teamSize: 50 },
      finalResult: {
        clanStars: 150,
        opponentStars: 150,
        clanDestruction: 60,
        opponentDestruction: 60,
        warEndTime: null,
        resultLabel: "TIE",
      },
      expectedWarEndFwaPoints: 503,
    });
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "BL", warStartFwaPoints: 500, teamSize: 45 },
      finalResult: {
        clanStars: 135,
        opponentStars: 135,
        clanDestruction: 60,
        opponentDestruction: 60,
        warEndTime: null,
        resultLabel: "TIE",
      },
      expectedWarEndFwaPoints: 503,
    });
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "BL", warStartFwaPoints: 500, teamSize: 50 },
      finalResult: {
        clanStars: 135,
        opponentStars: 134,
        clanDestruction: 60,
        opponentDestruction: 60,
        warEndTime: null,
        resultLabel: "LOSE",
      },
      expectedWarEndFwaPoints: 501,
    });
  });

  it("uses before unchanged when war-end outcome is unknown", async () => {
    await runProcessSubscriptionCase({
      subOverrides: { matchType: "FWA", warStartFwaPoints: 222, outcome: null },
      finalResult: {
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: null,
        resultLabel: "UNKNOWN",
      },
      expectedWarEndFwaPoints: 222,
    });
  });

  it("persists null expected points when before points are unknown", async () => {
    await runProcessSubscriptionCase({
      subOverrides: {
        matchType: "FWA",
        warStartFwaPoints: null,
        fwaPoints: null,
        outcome: null,
      },
      finalResult: {
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: null,
        resultLabel: "UNKNOWN",
      },
      expectedWarEndFwaPoints: null,
    });
  });

  it("preserves war identity timestamps on war_ended updates", async () => {
    const updateData = await runProcessSubscriptionCase({
      subOverrides: {
        matchType: "BL",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
      },
      finalResult: {
        clanStars: 10,
        opponentStars: 11,
        clanDestruction: 60.01,
        opponentDestruction: 41,
        warEndTime: new Date("2026-03-12T01:00:00.000Z"),
        resultLabel: "LOSE",
      },
      expectedWarEndFwaPoints: 1202,
    });
    expect(updateData?.prepStartTime).toBeUndefined();
    expect(updateData?.startTime).toBeUndefined();
    expect(updateData?.endTime).toBeUndefined();
    expect(updateData?.opponentTag).toBeUndefined();
    expect(updateData?.opponentName).toBeUndefined();
    expect(updateData?.clanName).toBeUndefined();
  });
});

describe("Post-war same-war freeze guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildLiveSnapshot(balance: number, opponentTag: string) {
    return {
      balance,
      activeFwa: false,
      notFound: false,
      winnerBoxTags: [opponentTag],
      winnerBoxText: "not marked as an fwa match",
      effectiveSync: 111,
      fetchedAtMs: Date.now(),
    };
  }

  async function runFrozenPostWarPollCase(input: {
    subOverrides?: Partial<Record<string, unknown>>;
    liveClanBalance: number;
    liveOpponentBalance: number;
    pointsGateAllowed?: boolean;
    historyRow: {
      warId: number;
      syncNumber: number | null;
      matchType: "FWA" | "BL" | "MM" | "SKIP" | null;
      expectedOutcome: string | null;
      actualOutcome: string | null;
      pointsAfterWar: number | null;
      clanName: string | null;
      opponentTag: string | null;
      opponentName: string | null;
      warStartTime: Date;
      warEndTime: Date | null;
    };
  }): Promise<{
    updateData: Record<string, unknown> | undefined;
    upsertPointsSync: ReturnType<typeof vi.fn>;
    markNeedsValidation: ReturnType<typeof vi.fn>;
  }> {
    vi.clearAllMocks();
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const sub = {
      ...makeSubscription(input.subOverrides),
      state: "notInWar",
      inferredMatchType: true,
    };
    sub.state = "notInWar";
    sub.inferredMatchType = true;

    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    const updateSpy = vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: null,
      observation: { kind: "success" },
    });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(1001);
    (service as any).activeWarIdentity = {
      resolveCurrentWarId: vi.fn().mockResolvedValue({
        status: "resolved",
        source: "preserved_during_outage_recovery",
        warId: Number(sub.warId ?? 1001),
        identity: {
          state: "inWar",
          warStartTime:
            sub.startTime instanceof Date
              ? sub.startTime
              : new Date("2026-03-12T00:00:00.000Z"),
          opponentTag: String(sub.opponentTag ?? "#OPP123").replace(/^#/, ""),
          preparationStartTime:
            sub.prepStartTime instanceof Date ? sub.prepStartTime : null,
          warEndTime: sub.endTime instanceof Date ? sub.endTime : null,
          opponentName: String(sub.opponentName ?? "Enemy").trim() || "Enemy",
          clanName: String(sub.clanName ?? "Alpha").trim() || "Alpha",
        },
        identityPersisted: true,
        liveValidated: false,
      }),
    };
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: input.pointsGateAllowed ?? false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).points = {
      fetchSnapshot: vi.fn().mockImplementation(async (clanTag: string) => {
        const normalized = String(clanTag ?? "")
          .replace(/^#/, "")
          .toUpperCase()
          .replace(/O/g, "0");
        const self = String(sub.clanTag ?? "")
          .replace(/^#/, "")
          .toUpperCase()
          .replace(/O/g, "0");
        const opponent = String(sub.opponentTag ?? "")
          .replace(/^#/, "")
          .toUpperCase()
          .replace(/O/g, "0");
        if (normalized === self) {
          return buildLiveSnapshot(input.liveClanBalance, `#${opponent}`);
        }
        if (normalized === opponent) {
          return buildLiveSnapshot(input.liveOpponentBalance, `#${self}`);
        }
        return buildLiveSnapshot(input.liveClanBalance, `#${opponent}`);
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
      upsertPointsSync: vi.fn().mockResolvedValue(undefined),
    };
    (service as any).history = {
      resolveExactCanonicalWarEndedHistoryRow: vi
        .fn()
        .mockResolvedValue(input.historyRow),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: input.historyRow.warEndTime,
        resultLabel: "UNKNOWN",
      }),
    };
    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue(null as any);

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const upsertPointsSync = (service as any).currentSyncs.upsertPointsSync as ReturnType<
      typeof vi.fn
    >;
    return {
      updateData: updateSpy.mock.calls[0]?.[0]?.data,
      upsertPointsSync,
      markNeedsValidation: (service as any).currentSyncs.markNeedsValidation as ReturnType<
        typeof vi.fn
      >,
    };
  }

  async function runResolvedPostWarPointsSyncCase(): Promise<{
    updateData: Record<string, unknown> | undefined;
    upsertPointsSync: ReturnType<typeof vi.fn>;
    markNeedsValidation: ReturnType<typeof vi.fn>;
  }> {
    vi.clearAllMocks();
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const sub = makeSubscription({
      guildId: "guild-1",
      clanTag: "#AAA111",
      state: "inWar",
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      endTime: new Date("2026-03-12T01:00:00.000Z"),
      opponentTag: "#OPP123",
      outcome: "WIN",
      matchType: "FWA",
      warStartFwaPoints: 1200,
      warEndFwaPoints: 1199,
      fwaPoints: 1300,
      inferredMatchType: false,
    });

    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    const updateSpy = vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: null,
      observation: { kind: "success" },
    });
    (service as any).recordCocWarObservation = vi.fn().mockReturnValue({
      suspected: false,
    });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(1001);
    (service as any).activeWarIdentity = buildActiveWarIdentityMock(
      sub,
      Number(sub.warId ?? 1001),
    );
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockResolvedValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).points = {
      fetchSnapshot: vi.fn().mockImplementation(async (clanTag: string) => {
        const normalized = String(clanTag ?? "")
          .trim()
          .toUpperCase()
          .replace(/O/g, "0");
        const self = String(sub.clanTag ?? "")
          .trim()
          .replace(/^#/, "")
          .toUpperCase()
          .replace(/O/g, "0");
        const opponent = String(sub.opponentTag ?? "")
          .trim()
          .replace(/^#/, "")
          .toUpperCase()
          .replace(/O/g, "0");
        if (normalized === self) {
          return buildLiveSnapshot(1300, `#${opponent}`);
        }
        if (normalized === opponent || normalized === `#${opponent}`) {
          return buildLiveSnapshot(1200, `#${self}`);
        }
        return buildLiveSnapshot(1300, `#${opponent}`);
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
      upsertPointsSync: vi.fn().mockResolvedValue(undefined),
    };
    (service as any).history = {
      resolveExactCanonicalWarEndedHistoryRow: vi.fn().mockResolvedValue(null),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 70,
        opponentDestruction: 69,
        warEndTime: new Date("2026-03-12T01:00:00.000Z"),
        resultLabel: "WIN",
      }),
    };

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    return {
      updateData: updateSpy.mock.calls[0]?.[0]?.data,
      upsertPointsSync: (service as any).currentSyncs.upsertPointsSync as ReturnType<
        typeof vi.fn
      >,
      markNeedsValidation: (service as any).currentSyncs.markNeedsValidation as ReturnType<
        typeof vi.fn
      >,
    };
  }

  it("keeps an ended FWA WIN stable after a post-war reconciliation poll", async () => {
    const { updateData, upsertPointsSync } = await runFrozenPostWarPollCase({
      subOverrides: {
        outcome: "WIN",
        matchType: "FWA",
        warEndFwaPoints: 99,
        fwaPoints: 100,
      },
      liveClanBalance: 200,
      liveOpponentBalance: 201,
      historyRow: {
        warId: 1001,
        syncNumber: 10,
        matchType: "FWA",
        expectedOutcome: "WIN",
        actualOutcome: "WIN",
        pointsAfterWar: 99,
        clanName: "Alpha",
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
        warEndTime: new Date("2026-03-12T01:00:00.000Z"),
      },
    });

    expect(updateData?.matchType).toBe("FWA");
    expect(updateData?.outcome).toBe("WIN");
    expect(updateData?.inferredMatchType).toBe(true);
    expect(updateData?.warEndFwaPoints).toBe(99);
    expect(updateData?.prepStartTime).toBeUndefined();
    expect(updateData?.startTime).toBeUndefined();
    expect(updateData?.endTime).toBeUndefined();
    expect(updateData?.opponentTag).toBeUndefined();
    expect(updateData?.opponentName).toBeUndefined();
    expect(updateData?.clanName).toBeUndefined();
    expect(upsertPointsSync).not.toHaveBeenCalled();
  });

  it("keeps an ended FWA LOSE stable after a post-war reconciliation poll", async () => {
    const { updateData, upsertPointsSync } = await runFrozenPostWarPollCase({
      subOverrides: {
        outcome: "LOSE",
        matchType: "FWA",
        warEndFwaPoints: 101,
        fwaPoints: 100,
      },
      liveClanBalance: 203,
      liveOpponentBalance: 202,
      historyRow: {
        warId: 1002,
        syncNumber: 11,
        matchType: "FWA",
        expectedOutcome: "LOSE",
        actualOutcome: "LOSE",
        pointsAfterWar: 101,
        clanName: "Alpha",
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
        warEndTime: new Date("2026-03-12T01:00:00.000Z"),
      },
    });

    expect(updateData?.matchType).toBe("FWA");
    expect(updateData?.outcome).toBe("LOSE");
    expect(updateData?.inferredMatchType).toBe(true);
    expect(updateData?.warEndFwaPoints).toBe(101);
    expect(upsertPointsSync).not.toHaveBeenCalled();
  });

  it("stages post-war points sync from the resolved identity when no live start is available", async () => {
    const { updateData, upsertPointsSync, markNeedsValidation } =
      await runResolvedPostWarPointsSyncCase();

    expect(updateData?.state).toBe("notInWar");
    expect(updateData?.startTime).toBeUndefined();
    expect(updateData?.opponentTag).toBeUndefined();

    expect(markNeedsValidation).toHaveBeenCalledTimes(1);
    expect(markNeedsValidation.mock.calls[0]?.[0]).toMatchObject({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
    });

    expect(upsertPointsSync).toHaveBeenCalledTimes(1);
    expect(upsertPointsSync.mock.calls[0]?.[0]).toMatchObject({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: "1001",
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "0PP123",
    });
    expect(upsertPointsSync.mock.calls[0]?.[0]?.warStartTime).not.toBeNull();
  });

  it("restores canonical history values when CurrentWar is wrong during frozen post-war reconciliation", async () => {
    const { updateData, upsertPointsSync } = await runFrozenPostWarPollCase({
      subOverrides: {
        outcome: "LOSE",
        matchType: "BL",
        inferredMatchType: false,
        warEndFwaPoints: 500,
        fwaPoints: 508,
      },
      liveClanBalance: 220,
      liveOpponentBalance: 221,
      historyRow: {
        warId: 1003,
        syncNumber: 12,
        matchType: "FWA",
        expectedOutcome: "LOSE",
        actualOutcome: "WIN",
        pointsAfterWar: 99,
        clanName: "Alpha",
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
        warEndTime: new Date("2026-03-12T01:00:00.000Z"),
      },
    });

    expect(updateData?.matchType).toBe("FWA");
    expect(updateData?.outcome).toBe("LOSE");
    expect(updateData?.inferredMatchType).toBe(true);
    expect(updateData?.warEndFwaPoints).toBe(99);
    expect(upsertPointsSync).not.toHaveBeenCalled();
  });

  it("keeps paired tracked clans from flipping each other's ended-war outcome", async () => {
    vi.clearAllMocks();
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const clanRows = [
      {
        ...makeSubscription({
          clanTag: "#AAA111",
          opponentTag: "#BBB222",
          outcome: "WIN",
          matchType: "FWA",
          warEndFwaPoints: 99,
          fwaPoints: 100,
        }),
        state: "notInWar",
        inferredMatchType: true,
      },
      {
        ...makeSubscription({
          clanTag: "#BBB222",
          opponentTag: "#AAA111",
          outcome: "LOSE",
          matchType: "FWA",
          warEndFwaPoints: 101,
          fwaPoints: 100,
        }),
        state: "notInWar",
        inferredMatchType: true,
      },
    ];
    clanRows[0].state = "notInWar";
    clanRows[0].inferredMatchType = true;
    clanRows[1].state = "notInWar";
    clanRows[1].inferredMatchType = true;
    const updateSpy = vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);
    let callIndex = 0;
    vi.spyOn(prisma, "$queryRaw").mockImplementation(async () => [clanRows[callIndex++] as any] as any);
    (service as any).activeWarIdentity = {
      resolveCurrentWarId: vi.fn().mockImplementation(async ({ clanTag }: any) => {
        const row =
          String(clanTag ?? "").toUpperCase().replace(/^#/, "") === "AAA111"
            ? clanRows[0]
            : clanRows[1];
        const warStartTime = row.startTime as Date;
        const opponentTag = String(row.opponentTag ?? "");
        const prepStartTime = row.prepStartTime ?? null;
        const warEndTime = row.endTime ?? null;
        const opponentName = row.opponentName ?? null;
        const clanName = row.clanName ?? null;
        return {
          status: "resolved",
          source: "preserved_during_outage_recovery",
          warId: row.warId ?? 1001,
          identity: {
            state: "notInWar",
            warStartTime,
            opponentTag,
            preparationStartTime: prepStartTime,
            warEndTime,
            opponentName,
            clanName,
          },
          identityPersisted: true,
          liveValidated: false,
        };
      }),
    };
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: null,
      observation: { kind: "success" },
    });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(1001);
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).points = {
      fetchSnapshot: vi.fn().mockImplementation(async (clanTag: string) => {
        const normalized = String(clanTag ?? "").replace(/^#/, "").toUpperCase();
        if (normalized === "AAA111") {
          return buildLiveSnapshot(200, "#BBB222");
        }
        if (normalized === "BBB222") {
          return buildLiveSnapshot(201, "#AAA111");
        }
        return buildLiveSnapshot(200, "#BBB222");
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
      upsertPointsSync: vi.fn().mockResolvedValue(undefined),
    };
    (service as any).history = {
      resolveExactCanonicalWarEndedHistoryRow: vi.fn().mockImplementation(
        async ({ clanTag }: { clanTag: string }) => {
          if (clanTag === "#AAA111") {
            return {
              warId: 1001,
              syncNumber: 10,
              matchType: "FWA",
              expectedOutcome: "WIN",
              actualOutcome: "WIN",
              pointsAfterWar: 99,
              clanName: "Alpha",
              opponentTag: "#BBB222",
              opponentName: "Bravo",
              warStartTime: new Date("2026-03-12T00:00:00.000Z"),
              warEndTime: new Date("2026-03-12T01:00:00.000Z"),
            };
          }
          return {
            warId: 1002,
            syncNumber: 10,
            matchType: "FWA",
            expectedOutcome: "LOSE",
            actualOutcome: "LOSE",
            pointsAfterWar: 101,
            clanName: "Bravo",
            opponentTag: "#AAA111",
            opponentName: "Alpha",
            warStartTime: new Date("2026-03-12T00:00:00.000Z"),
            warEndTime: new Date("2026-03-12T01:00:00.000Z"),
          };
        },
      ),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: new Date("2026-03-12T01:00:00.000Z"),
        resultLabel: "UNKNOWN",
      }),
    };
    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue(null as any);

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });
    await (service as any).processSubscription("guild-1", "#BBB222", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[0]?.[0]?.data?.outcome).toBe("WIN");
    expect(updateSpy.mock.calls[0]?.[0]?.data?.matchType).toBe("FWA");
    expect(updateSpy.mock.calls[1]?.[0]?.data?.outcome).toBe("LOSE");
    expect(updateSpy.mock.calls[1]?.[0]?.data?.matchType).toBe("FWA");
    expect((service as any).currentSyncs.upsertPointsSync).not.toHaveBeenCalled();
  });
});

describe("Match-type confirmation rollover via processSubscription", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildObservedWarSnapshot(params: {
    state: string;
    startTime: string;
    preparationStartTime?: string | null;
    endTime?: string | null;
    opponentTag?: string;
  }): Record<string, unknown> {
    return {
      state: params.state,
      startTime: params.startTime,
      preparationStartTime: params.preparationStartTime ?? params.startTime,
      endTime: params.endTime ?? null,
      teamSize: 50,
      attacksPerMember: 2,
      clan: {
        tag: "#AAA111",
        name: "Alpha",
        stars: 0,
        attacks: 0,
        destructionPercentage: 0,
        members: [],
      },
      opponent: {
        tag: params.opponentTag ?? "#OPP999",
        name: "Enemy",
        stars: 0,
        attacks: 0,
        destructionPercentage: 0,
        members: [],
      },
    };
  }

  async function runProcessSubscriptionMatchTypeCase(input: {
    subOverrides?: Partial<Record<string, unknown>>;
    observedWar: Record<string, unknown>;
    expectedMatchType: string | null;
    expectedInferredMatchType: boolean;
  }): Promise<void> {
    vi.clearAllMocks();
    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as unknown as Client, {} as any);
    const sub = makeSubscription({
      matchType: "BL",
      inferredMatchType: false,
      state: "inWar",
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      ...input.subOverrides,
    });
    (service as any).activeWarIdentity = {
      resolveCurrentWarId: vi.fn().mockResolvedValue({
        status: "resolved",
        warId: 1001,
        source: "existing_exact_row",
        identity: {
          state: "inWar",
          warStartTime: new Date("2026-03-12T00:00:00.000Z"),
          opponentTag: "#0PP999",
          preparationStartTime: null,
          warEndTime: null,
          opponentName: "Enemy",
          clanName: "Alpha",
        },
        identityPersisted: true,
        liveValidated: true,
      }),
    };

    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    const updateSpy = vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);

    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: input.observedWar,
      observation: { kind: "success" },
    });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(2002);
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
      upsertPointsSync: vi.fn().mockResolvedValue(undefined),
    };
    (service as any).history = {
      resolveExactCanonicalWarEndedHistoryRow: vi.fn().mockResolvedValue(null),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 70,
        opponentDestruction: 69,
        warEndTime: null,
        resultLabel: "WIN",
      }),
    };

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateData = updateSpy.mock.calls[0]?.[0]?.data;
    expect(updateData?.matchType ?? null).toBe(input.expectedMatchType);
    expect(updateData?.inferredMatchType).toBe(input.expectedInferredMatchType);
  }

  it("resets prior confirmed match-type state when war identity changes", async () => {
    await runProcessSubscriptionMatchTypeCase({
      observedWar: buildObservedWarSnapshot({
        state: "preparation",
        startTime: "20260314T000000.000Z",
        preparationStartTime: "20260313T230000.000Z",
      }),
      expectedMatchType: null,
      expectedInferredMatchType: true,
    });
  });

  it("keeps same-war confirmed match-type state when identity is unchanged", async () => {
    await runProcessSubscriptionMatchTypeCase({
      observedWar: buildObservedWarSnapshot({
        state: "inWar",
        startTime: "20260312T000000.000Z",
        opponentTag: "#OPP123",
      }),
      expectedMatchType: "BL",
      expectedInferredMatchType: false,
    });
  });

  it("allows next-war live opponent inference once stale confirmed state is reset", async () => {
    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as unknown as Client, {} as any);
    const sub = makeSubscription({
      matchType: "BL",
      inferredMatchType: false,
      state: "inWar",
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#OPP999",
    });
    const nowMs = Date.now();

    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    const updateSpy = vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);

    (service as any).activeWarIdentity = {
      resolveCurrentWarId: vi.fn().mockImplementation(async ({ candidateIdentity }: any) => ({
        status: "resolved",
        warId: 2002,
        source: "allocated_new_identity",
        identity: {
          state:
            String(candidateIdentity?.state ?? "preparation").trim() === "inWar"
              ? "inWar"
              : "preparation",
          warStartTime:
            candidateIdentity?.warStartTime instanceof Date
              ? candidateIdentity.warStartTime
              : new Date("2026-03-14T00:00:00.000Z"),
          opponentTag: "#0PP999",
          preparationStartTime:
            candidateIdentity?.preparationStartTime instanceof Date
              ? candidateIdentity.preparationStartTime
              : new Date("2026-03-13T23:00:00.000Z"),
          warEndTime:
            candidateIdentity?.warEndTime instanceof Date
              ? candidateIdentity.warEndTime
              : null,
          opponentName: "Enemy",
          clanName: "Alpha",
        },
        identityPersisted: true,
        liveValidated: true,
      })),
    };
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: buildObservedWarSnapshot({
        state: "inWar",
        startTime: "20260314T000000.000Z",
        opponentTag: "#OPP999",
      }),
      observation: { kind: "success" },
    });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(2002);
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
      upsertPointsSync: vi.fn().mockResolvedValue(undefined),
    };
    (service as any).points = {
      fetchSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          balance: 1200,
          winnerBoxTags: ["#OPP999"],
          winnerBoxText: "",
          effectiveSync: 44,
          fetchedAtMs: nowMs,
        })
        .mockResolvedValueOnce({
          balance: 1201,
          activeFwa: true,
          notFound: false,
          fetchedAtMs: nowMs,
        }),
    };
    (service as any).history = {
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 70,
        opponentDestruction: 69,
        warEndTime: null,
        resultLabel: "WIN",
      }),
    };

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateData = updateSpy.mock.calls[0]?.[0]?.data;
    expect(updateData?.matchType).toBe("FWA");
    expect(updateData?.inferredMatchType).toBe(true);
  });

  it("preserves same-war confirmed outcome while still refreshing live points fields", async () => {
    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as unknown as Client, {} as any);
    const sub = makeSubscription({
      matchType: "FWA",
      inferredMatchType: false,
      outcome: "LOSE",
      state: "inWar",
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#OPP999",
      pointsConfirmedByClanMail: true,
      pointsNeedsValidation: false,
      pointsLastKnownMatchType: "FWA",
      pointsLastKnownOutcome: "LOSE",
      pointsWarId: "1001",
      pointsOpponentTag: "#OPP999",
      pointsWarStartTime: new Date("2026-03-12T00:00:00.000Z"),
    });
    const nowMs = Date.parse("2026-03-12T00:20:00.000Z");

    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    const updateSpy = vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);

    (service as any).activeWarIdentity = buildActiveWarIdentityMock(
      sub,
      Number(sub.warId ?? 1001),
    );
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: buildObservedWarSnapshot({
        state: "inWar",
        startTime: "20260312T000000.000Z",
        opponentTag: "#OPP999",
      }),
      observation: { kind: "success" },
    });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(1001);
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    const upsertPointsSync = vi.fn().mockResolvedValue(undefined);
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
      upsertPointsSync,
    };
    (service as any).points = {
      fetchSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          balance: 1300,
          winnerBoxTags: ["#OPP999"],
          winnerBoxText: "",
          effectiveSync: 44,
          fetchedAtMs: nowMs,
        })
        .mockResolvedValueOnce({
          balance: 1200,
          activeFwa: true,
          notFound: false,
          fetchedAtMs: nowMs,
        }),
    };
    (service as any).history = {
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 70,
        opponentDestruction: 69,
        warEndTime: null,
        resultLabel: "WIN",
      }),
    };

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateData = updateSpy.mock.calls[0]?.[0]?.data;
    expect(updateData?.matchType).toBe("FWA");
    expect(updateData?.outcome).toBe("LOSE");
    expect(updateData?.fwaPoints).toBe(1300);
    expect(updateData?.opponentFwaPoints).toBe(1200);
  });
});

describe("War-event identity guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildBlockedRefreshService() {
    const messageEdit = vi.fn().mockResolvedValue(undefined);
    const messageFetch = vi.fn().mockResolvedValue({
      content: "Refresh me",
      embeds: [new EmbedBuilder()],
      edit: messageEdit,
    });
    const channelFetch = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: messageFetch },
    });
    const service = new WarEventLogService(
      { channels: { fetch: channelFetch } } as unknown as Client,
      {
        getCurrentWar: vi.fn().mockResolvedValue({
          state: "inWar",
          clan: { tag: "#AAA111", name: "Alpha", stars: 100, attacks: 0, destructionPercentage: 0 },
          opponent: { tag: "#OPP123", name: "Enemy", stars: 99, attacks: 0, destructionPercentage: 0 },
          preparationStartTime: "20260311T000000.000Z",
          startTime: "20260312T000000.000Z",
          endTime: "20260313T000000.000Z",
          teamSize: 50,
          attacksPerMember: 2,
        }),
      } as any,
    );
    (service as any).findSubscriptionByGuildAndTag = vi.fn().mockResolvedValue(
      makeSubscription({
        guildId: "guild-1",
        clanTag: "#AAA111",
        state: "inWar",
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
    );
    (service as any).activeWarIdentity = {
      resolveCurrentWarId: vi.fn().mockResolvedValue({
        status: "blocked",
        warId: null,
        reason: "partial_live_identity",
      }),
    };
    return { service, messageEdit };
  }

  it("fails closed for processSubscription when identity resolution is blocked", async () => {
    vi.clearAllMocks();
    const updateManySpy = vi.spyOn(prisma.currentWar, "updateMany");
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const sub = makeSubscription({
      guildId: "guild-1",
      clanTag: "#AAA111",
      state: "inWar",
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#OLDOPP",
    });
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: {
        state: "inWar",
        clan: { tag: "#AAA111", name: "Alpha", stars: 100, attacks: 0, destructionPercentage: 0 },
        opponent: { tag: "#NEW999", name: "Enemy", stars: 99, attacks: 0, destructionPercentage: 0 },
        preparationStartTime: "20260311T000000.000Z",
        startTime: null,
        endTime: "20260313T000000.000Z",
        teamSize: 50,
        attacksPerMember: 2,
      },
      observation: { kind: "success" },
    });
    (service as any).recordCocWarObservation = vi.fn().mockReturnValue({ suspected: false });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(1001);
    (service as any).activeWarIdentity = {
      resolveCurrentWarId: vi.fn().mockResolvedValue({
        status: "blocked",
        warId: null,
        reason: "partial_live_identity",
      }),
    };
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockResolvedValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
      upsertPointsSync: vi.fn().mockResolvedValue(undefined),
    };
    const pointsFetchSnapshotSpy = vi
      .spyOn((service as any).points, "fetchSnapshot")
      .mockResolvedValue(
        {
          balance: 1300,
          activeFwa: false,
          notFound: false,
          winnerBoxTags: ["#NEW999"],
          winnerBoxText: "not marked as an fwa match",
          effectiveSync: 44,
          fetchedAtMs: Date.now(),
        } as any,
      );
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(0);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);

    const ok = await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(ok).toBe(false);
    expect(updateManySpy).not.toHaveBeenCalled();
    expect(pointsFetchSnapshotSpy).not.toHaveBeenCalled();
    expect((service as any).currentSyncs.upsertPointsSync).not.toHaveBeenCalled();
    expect((service as any).currentSyncs.markNeedsValidation).not.toHaveBeenCalled();
    expect((service as any).syncWarAttacksFromWarSnapshot).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
  });

  it("fails closed for notify refresh when identity resolution is blocked", async () => {
    const { service, messageEdit } = buildBlockedRefreshService();
    const updateManySpy = vi.spyOn(prisma.currentWar, "updateMany");

    const ok = await service.refreshCurrentNotifyPost("guild-1", "#AAA111");

    expect(ok).toBe(false);
    expect(updateManySpy).not.toHaveBeenCalled();
    expect(messageEdit).not.toHaveBeenCalled();
  });

  it("fails closed for battle-day refresh when identity resolution is blocked", async () => {
    const { service, messageEdit } = buildBlockedRefreshService();
    const interaction = {
      customId: buildNotifyWarRefreshCustomId("guild-1", "#AAA111"),
      channelId: "chan-1",
      guildId: "guild-1",
      message: { id: "msg-1" },
      replied: false,
      deferred: false,
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await service.refreshBattleDayPostByInteraction(interaction);

    expect(messageEdit).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "This battle day embed can no longer be refreshed.",
      }),
    );
  });
});

describe("War outage recovery reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildOutageRecoveryService(input: {
    subOverrides: Partial<Record<string, unknown>>;
    snapshots: Array<{ war: Record<string, unknown> | null; observation: { kind: "success" } | { kind: "failure"; statusCode: number | null } }>;
  }): {
    service: WarEventLogService;
    sub: Record<string, unknown>;
    updateSpy: ReturnType<typeof vi.spyOn>;
    dispatchSpy: ReturnType<typeof vi.fn>;
    resolveSpy: ReturnType<typeof vi.spyOn>;
  } {
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const sub = makeSubscription(input.subOverrides);
    (service as any).activeWarIdentity = buildActiveWarIdentityMock(
      sub,
      Number(sub.warId ?? 1001),
    );
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue(null as any);
    const updateSpy = vi
      .spyOn(prisma.currentWar, "update")
      .mockImplementation(async (args: any) => {
        Object.assign(sub, args?.data ?? {});
        return {} as any;
      });
    (service as any).getCurrentWarSnapshot = vi
      .fn()
      .mockImplementation(async () => {
        const next = input.snapshots.shift();
        if (!next) return { war: null, observation: { kind: "success" } };
        return next;
      });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(0);
    const dispatchSpy = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = dispatchSpy;
    (service as any).reconcileWarEndedPointsDiscrepancy = vi
      .fn()
      .mockResolvedValue(undefined);
    (service as any).history = {
      resolveExactCanonicalWarEndedHistoryRow: vi.fn().mockResolvedValue(null),
      persistWarEndHistory: vi.fn().mockResolvedValue(undefined),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: null,
        resultLabel: "UNKNOWN",
      }),
    };
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockResolvedValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
    };
    const resolveSpy = vi.spyOn(
      (service as any).activeWarIdentity,
      "resolveCurrentWarId",
    );
    return {
      service,
      sub,
      updateSpy,
      dispatchSpy,
      resolveSpy,
    };
  }

  it("suppresses prep-day outage recovery identity shifts and updates active row in place", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T08:00:00.000Z"));
    const shiftedWar = {
      state: "preparation",
      clan: { tag: "#AAA111", name: "Alpha", stars: 0, attacks: 0, destructionPercentage: 0 },
      opponent: {
        tag: "#OPP123",
        name: "Enemy",
        stars: 0,
        attacks: 0,
        destructionPercentage: 0,
      },
      preparationStartTime: "20260311T020000.000Z",
      startTime: "20260312T020000.000Z",
      endTime: "20260313T020000.000Z",
      teamSize: 50,
      attacksPerMember: 2,
    };
    const snapshots = [
      { war: null, observation: { kind: "failure" as const, statusCode: 503 } },
      { war: null, observation: { kind: "failure" as const, statusCode: 500 } },
      { war: shiftedWar, observation: { kind: "success" as const } },
    ];
    const { service, sub, updateSpy, dispatchSpy, resolveSpy } =
      buildOutageRecoveryService({
        subOverrides: {
          state: "preparation",
          warId: 1001,
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          endTime: new Date("2026-03-13T00:00:00.000Z"),
          prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        },
        snapshots,
      });

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });
    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 11,
      activeSync: 12,
    });
    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 12,
      activeSync: 13,
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      resolveSpy.mock.calls.some((call) => call?.[0]?.policy === "preserve_persisted"),
    ).toBe(true);
    expect(updateSpy).toHaveBeenCalled();
    expect(sub.warId).toBe(1001);
    expect((sub.startTime as Date).toISOString()).toBe("2026-03-12T00:00:00.000Z");
  });

  it("suppresses battle-day outage recovery identity shifts without duplicate battle_day emit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T08:00:00.000Z"));
    const shiftedWar = {
      state: "inWar",
      clan: { tag: "#AAA111", name: "Alpha", stars: 100, attacks: 15, destructionPercentage: 70 },
      opponent: {
        tag: "#OPP123",
        name: "Enemy",
        stars: 99,
        attacks: 14,
        destructionPercentage: 69,
      },
      preparationStartTime: "20260311T010000.000Z",
      startTime: "20260312T010000.000Z",
      endTime: "20260313T010000.000Z",
      teamSize: 50,
      attacksPerMember: 2,
    };
    const snapshots = [
      { war: null, observation: { kind: "failure" as const, statusCode: 503 } },
      { war: null, observation: { kind: "failure" as const, statusCode: 503 } },
      { war: shiftedWar, observation: { kind: "success" as const } },
    ];
    const { service, sub, dispatchSpy, resolveSpy } =
      buildOutageRecoveryService({
        subOverrides: {
          state: "inWar",
          warId: 1001,
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          endTime: new Date("2026-03-13T00:00:00.000Z"),
        },
        snapshots,
      });

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });
    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 11,
      activeSync: 12,
    });
    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 12,
      activeSync: 13,
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      resolveSpy.mock.calls.some((call) => call?.[0]?.policy === "preserve_persisted"),
    ).toBe(true);
    expect(sub.warId).toBe(1001);
  });

  it("skips archive recovery without matching old attack rows and continues new-war processing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service, updateSpy, dispatchSpy, resolveSpy } =
      buildOutageRecoveryService({
        subOverrides: {
          state: "notInWar",
          warId: 1001,
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          endTime: new Date("2026-03-13T00:00:00.000Z"),
          clanName: "Alpha",
          opponentTag: "#XYZ111",
          opponentName: "Enemy",
        },
        snapshots: [
          {
            war: {
              state: "preparation",
              clan: {
                tag: "#AAA111",
                name: "Alpha",
                stars: 0,
                attacks: 0,
                destructionPercentage: 0,
              },
              opponent: {
                tag: "#NEW999",
                name: "New Enemy",
                stars: 0,
                attacks: 0,
                destructionPercentage: 0,
              },
              preparationStartTime: "20260314T000000.000Z",
              startTime: "20260315T000000.000Z",
              endTime: "20260316T000000.000Z",
              teamSize: 50,
              attacksPerMember: 2,
            },
            observation: { kind: "success" as const },
          },
        ],
      });
    const history = (service as any).history;
    const exactLookupSpy = vi
      .spyOn(history, "resolveExactCanonicalWarEndedHistoryRow")
      .mockResolvedValue(null);
    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue(null as any);

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(exactLookupSpy).toHaveBeenCalledTimes(1);
    expect(exactLookupSpy.mock.calls[0]?.[0]).toMatchObject({
      clanTag: "#AAA111",
      opponentTag: "#XYZ111",
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
    });
    expect(history.persistWarEndHistory).not.toHaveBeenCalled();
    expect((service as any).syncWarAttacksFromWarSnapshot).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("event=archive_recovery_skipped") &&
        String(message).includes("reason=no_matching_attack_rows"),
      ),
    ).toBe(true);
  });

  it("recovers a failed archive before a newly observed war can replace stale rows", async () => {
    const recoveryPersistSpy = vi.fn().mockResolvedValue(undefined);
    const { service, updateSpy, dispatchSpy, resolveSpy } =
      buildOutageRecoveryService({
        subOverrides: {
          state: "notInWar",
          warId: 1001,
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          endTime: new Date("2026-03-13T00:00:00.000Z"),
          clanName: "Alpha",
          opponentTag: null,
          opponentName: "Enemy",
        },
        snapshots: [
          {
            war: {
              state: "preparation",
              clan: {
                tag: "#AAA111",
                name: "Alpha",
                stars: 0,
                attacks: 0,
                destructionPercentage: 0,
              },
              opponent: {
                tag: "#NEW999",
                name: "New Enemy",
                stars: 0,
                attacks: 0,
                destructionPercentage: 0,
              },
              preparationStartTime: "20260314T000000.000Z",
              startTime: "20260315T000000.000Z",
              endTime: "20260316T000000.000Z",
              teamSize: 50,
              attacksPerMember: 2,
            },
            observation: { kind: "success" as const },
          },
        ],
      });
    const history = (service as any).history;
    const exactLookupSpy = vi
      .spyOn(history, "resolveExactCanonicalWarEndedHistoryRow")
      .mockResolvedValue(null);
    history.persistWarEndHistory = recoveryPersistSpy;
    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      opponentClanTag: "#XYZ111",
      warId: 1001,
    } as any);

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(exactLookupSpy).toHaveBeenCalledTimes(1);
    expect(exactLookupSpy.mock.calls[0]?.[0]).toMatchObject({
      clanTag: "#AAA111",
      opponentTag: "#XYZ111",
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
    });
    expect(recoveryPersistSpy).toHaveBeenCalledTimes(1);
    expect(recoveryPersistSpy.mock.calls[0]?.[0]).toMatchObject({
      eventType: "war_ended",
      guildId: "guild-1",
      clanTag: "#AAA111",
      clanName: "Alpha",
      opponentTag: "#XYZ111",
      opponentName: "Enemy",
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
    });
    expect((service as any).syncWarAttacksFromWarSnapshot).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("stops newer-war processing when archive recovery replay fails", async () => {
    const recoveryPersistSpy = vi
      .fn()
      .mockRejectedValue(new Error("archive replay failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, updateSpy, dispatchSpy, resolveSpy } =
      buildOutageRecoveryService({
        subOverrides: {
          state: "notInWar",
          warId: 1001,
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          endTime: new Date("2026-03-13T00:00:00.000Z"),
          clanName: "Alpha",
          opponentTag: null,
          opponentName: "Enemy",
        },
        snapshots: [
          {
            war: {
              state: "preparation",
              clan: {
                tag: "#AAA111",
                name: "Alpha",
                stars: 0,
                attacks: 0,
                destructionPercentage: 0,
              },
              opponent: {
                tag: "#NEW999",
                name: "New Enemy",
                stars: 0,
                attacks: 0,
                destructionPercentage: 0,
              },
              preparationStartTime: "20260314T000000.000Z",
              startTime: "20260315T000000.000Z",
              endTime: "20260316T000000.000Z",
              teamSize: 50,
              attacksPerMember: 2,
            },
            observation: { kind: "success" as const },
          },
        ],
      });
    const history = (service as any).history;
    const exactLookupSpy = vi
      .spyOn(history, "resolveExactCanonicalWarEndedHistoryRow")
      .mockResolvedValue(null);
    history.persistWarEndHistory = recoveryPersistSpy;
    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      opponentClanTag: "#XYZ111",
      warId: 1001,
    } as any);

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(exactLookupSpy).toHaveBeenCalledTimes(1);
    expect(recoveryPersistSpy).toHaveBeenCalledTimes(1);
    expect((service as any).syncWarAttacksFromWarSnapshot).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.some(([message]) =>
        String(message).includes("archive_recovery_failed"),
      ),
    ).toBe(true);
  });

  it("skips recovery when exact old history already exists and continues normal new-war processing", async () => {
    const recoveryPersistSpy = vi.fn();
    const { service, updateSpy, dispatchSpy, resolveSpy } =
      buildOutageRecoveryService({
        subOverrides: {
          state: "notInWar",
          warId: 1001,
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          endTime: new Date("2026-03-13T00:00:00.000Z"),
          clanName: "Alpha",
          opponentTag: "#XYZ111",
          opponentName: "Enemy",
        },
        snapshots: [
          {
            war: {
              state: "preparation",
              clan: {
                tag: "#AAA111",
                name: "Alpha",
                stars: 0,
                attacks: 0,
                destructionPercentage: 0,
              },
              opponent: {
                tag: "#NEW999",
                name: "New Enemy",
                stars: 0,
                attacks: 0,
                destructionPercentage: 0,
              },
              preparationStartTime: "20260314T000000.000Z",
              startTime: "20260315T000000.000Z",
              endTime: "20260316T000000.000Z",
              teamSize: 50,
              attacksPerMember: 2,
            },
            observation: { kind: "success" as const },
          },
        ],
      });
    const history = (service as any).history;
    const exactLookupSpy = vi
      .spyOn(history, "resolveExactCanonicalWarEndedHistoryRow")
      .mockResolvedValue({
        warId: 1001,
        syncNumber: 10,
        matchType: "FWA",
        expectedOutcome: "WIN",
        actualOutcome: "WIN",
        pointsAfterWar: 99,
        clanName: "Alpha",
        opponentTag: "#XYZ111",
        opponentName: "Enemy",
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
        warEndTime: new Date("2026-03-13T00:00:00.000Z"),
      } as any);
    history.persistWarEndHistory = recoveryPersistSpy;
    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      opponentClanTag: "#XYZ111",
      warId: 1001,
    } as any);

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(exactLookupSpy).toHaveBeenCalledTimes(1);
    expect(exactLookupSpy.mock.calls[0]?.[0]).toMatchObject({
      clanTag: "#AAA111",
      opponentTag: "#XYZ111",
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
    });
    expect(recoveryPersistSpy).not.toHaveBeenCalled();
    expect((service as any).syncWarAttacksFromWarSnapshot).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalled();
  });

  it("keeps healthy non-outage preparation->inWar transitions emitting once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T08:00:00.000Z"));
    const snapshots = [
      {
        war: {
          state: "inWar",
          clan: { tag: "#AAA111", name: "Alpha", stars: 100, attacks: 12, destructionPercentage: 70 },
          opponent: {
            tag: "#OPP123",
            name: "Enemy",
            stars: 99,
            attacks: 11,
            destructionPercentage: 69,
          },
          preparationStartTime: "20260311T000000.000Z",
          startTime: "20260312T000000.000Z",
          endTime: "20260313T000000.000Z",
          teamSize: 50,
          attacksPerMember: 2,
        },
        observation: { kind: "success" as const },
      },
    ];
    const { service, dispatchSpy } = buildOutageRecoveryService({
      subOverrides: {
        state: "preparation",
        warId: 1001,
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-13T00:00:00.000Z"),
      },
      snapshots,
    });

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.calls[0]?.[0]?.payload?.eventType).toBe("battle_day");
  });
});

describe("FWA police poll-time enforcement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildInWarSnapshot(): Record<string, unknown> {
    return {
      state: "inWar",
      startTime: "20260312T000000.000Z",
      preparationStartTime: "20260311T000000.000Z",
      endTime: "20260313T000000.000Z",
      teamSize: 50,
      attacksPerMember: 2,
      clan: {
        tag: "#AAA111",
        name: "Alpha",
        stars: 100,
        attacks: 10,
        destructionPercentage: 70,
        members: [],
      },
      opponent: {
        tag: "#OPP123",
        name: "Enemy",
        stars: 99,
        attacks: 10,
        destructionPercentage: 69,
        members: [],
      },
    };
  }

  function buildProcessSubscriptionService(syncResults: number[]): {
    service: WarEventLogService;
    enforceSpy: ReturnType<typeof vi.spyOn>;
  } {
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const sub = makeSubscription({
      guildId: "guild-1",
      clanTag: "#AAA111",
      state: "inWar",
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      endTime: new Date("2026-03-13T00:00:00.000Z"),
      opponentTag: "#OPP123",
      opponentName: "Enemy",
    });
    (service as any).activeWarIdentity = buildActiveWarIdentityMock(
      sub,
      Number(sub.warId ?? 1001),
    );

    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: buildInWarSnapshot(),
      observation: { kind: "success" },
    });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(1001);
    (service as any).syncWarAttacksFromWarSnapshot = vi
      .fn()
      .mockImplementation(async () => syncResults.shift() ?? 0);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi
      .fn()
      .mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(10),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
    };
    const enforceSpy = vi
      .spyOn((service as any).fwaPolice, "enforceWarViolations")
      .mockResolvedValue({
        evaluatedViolations: 1,
        created: 1,
        deduped: 0,
        dmSent: 0,
        logSent: 1,
      });
    return { service, enforceSpy };
  }

  it("enforces police immediately in poll cycle after new attack rows are synced", async () => {
    const { service, enforceSpy } = buildProcessSubscriptionService([1]);
    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });

    expect(enforceSpy).toHaveBeenCalledTimes(1);
    expect(enforceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#AAA111",
        warId: 1001,
      }),
    );
  });

  it("does not re-enforce on later polls when no new attack rows are observed", async () => {
    const { service, enforceSpy } = buildProcessSubscriptionService([1, 0]);
    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 10,
      activeSync: 11,
    });
    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: 11,
      activeSync: 12,
    });

    expect(enforceSpy).toHaveBeenCalledTimes(1);
  });

  it("does not trigger police delivery from war-ended dispatch flow", async () => {
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const enforceSpy = vi
      .spyOn((service as any).fwaPolice, "enforceWarViolations")
      .mockResolvedValue({
        evaluatedViolations: 0,
        created: 0,
        deduped: 0,
        dmSent: 0,
        logSent: 0,
      });

    (service as any).history = {
      persistWarEndHistory: vi.fn().mockResolvedValue(undefined),
      resolveCanonicalWarEndedContext: vi.fn().mockResolvedValue(null),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 70,
        opponentDestruction: 69,
        warEndTime: new Date("2026-03-10T00:00:00.000Z"),
        resultLabel: "WIN",
      }),
    };

    await (service as any).dispatchDetectedEvent({
      sub: makeSubscription({
        guildId: "guild-1",
        clanTag: "#AAA111",
        notify: false,
      }),
      payload: buildBasePayload({
        eventType: "war_ended",
        clanTag: "#AAA111",
        warStartTime: new Date("2026-03-09T00:00:00.000Z"),
        warEndTime: new Date("2026-03-10T00:00:00.000Z"),
      }),
      resolvedWarId: 1001,
    });

    expect(enforceSpy).not.toHaveBeenCalled();
  });
});

describe("War-end points reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildReconcileService(channelMock: unknown): WarEventLogService {
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue(channelMock),
      },
    } as unknown as Client;
    const service = new WarEventLogService(client, {} as any);
    (service as any).points = {
      fetchSnapshot: vi.fn().mockResolvedValue({ balance: 100 }),
    };
    (service as any).commandPermissions = {
      getFwaLeaderRoleId: vi.fn().mockResolvedValue("777"),
    };
    return service;
  }

  it("equal expected/actual points produce no warning output", async () => {
    const channelFetch = vi.fn();
    const service = new WarEventLogService(
      { channels: { fetch: channelFetch } } as unknown as Client,
      {} as any
    );
    (service as any).points = {
      fetchSnapshot: vi.fn().mockResolvedValue({ balance: 100 }),
    };
    vi.spyOn(prisma.clanPostedMessage, "findFirst").mockResolvedValue({
      id: "pm-1",
      guildId: "guild-1",
      clanTag: "#AAA111",
      type: "notify",
      event: "war_ended",
      channelId: "chan-1",
      messageId: "msg-1",
      messageUrl: "",
      warId: "1001",
      syncNum: null,
      configHash: "cfg",
      createdAt: new Date(),
    } as any);
    vi.spyOn(prisma.clanWarHistory, "findFirst").mockResolvedValue({
      pointsAfterWar: 100,
      clanName: "Alpha",
      opponentName: "Enemy",
    } as any);
    const updateSpy = vi.spyOn(prisma.clanPostedMessage, "update").mockResolvedValue({} as any);

    await (service as any).reconcileWarEndedPointsDiscrepancy({
      guildId: "guild-1",
      clanTag: "#AAA111",
      fallbackOpponentName: "Enemy",
      allowProviderFetch: true,
      fetchReason: "post_war_reconciliation",
    });

    expect(channelFetch).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("mismatch edits original message with visible warning and no leader ping", async () => {
    const edit = vi.fn().mockResolvedValue({});
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue({
          content: "War ended against Enemy\n<@&55555>",
          edit,
        }),
      },
      send: vi.fn(),
    };
    const service = buildReconcileService(channel);
    (service as any).points = {
      fetchSnapshot: vi.fn().mockResolvedValue({ balance: 99 }),
    };

    vi.spyOn(prisma.clanPostedMessage, "findFirst").mockResolvedValue({
      id: "pm-1",
      guildId: "guild-1",
      clanTag: "#AAA111",
      type: "notify",
      event: "war_ended",
      channelId: "chan-1",
      messageId: "msg-1",
      messageUrl: "",
      warId: "1001",
      syncNum: null,
      configHash: "cfg",
      createdAt: new Date(),
    } as any);
    vi.spyOn(prisma.clanWarHistory, "findFirst").mockResolvedValue({
      pointsAfterWar: 100,
      clanName: "Alpha",
      opponentName: "Enemy",
    } as any);
    const updateSpy = vi.spyOn(prisma.clanPostedMessage, "update").mockResolvedValue({} as any);

    await (service as any).reconcileWarEndedPointsDiscrepancy({
      guildId: "guild-1",
      clanTag: "#AAA111",
      fallbackOpponentName: "Enemy",
      allowProviderFetch: true,
      fetchReason: "post_war_reconciliation",
    });

    expect(edit).toHaveBeenCalledTimes(1);
    const editPayload = edit.mock.calls[0]?.[0];
    expect(editPayload.content).toContain(
      "⚠️ War-end points mismatch detected. [points.fwafarm](<https://points.fwafarm.com/clan?tag=AAA111>)"
    );
    expect(editPayload.content).toContain("Expected points: 100");
    expect(editPayload.content).toContain("Actual points: 99");
    expect(editPayload.content).toContain("<@&55555>");
    expect(editPayload.content).not.toContain("<@&777>");
    expect(editPayload.allowedMentions).toEqual({ parse: [] });
    expect(editPayload.content).not.toContain("clan?tag=OPP123");
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("idempotency skips repeated alerts for unchanged mismatch fingerprint", async () => {
    const edit = vi.fn().mockResolvedValue({});
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue({
          content: "War ended against Enemy\n<@&555>",
          edit,
        }),
      },
      send: vi.fn(),
    };
    const service = buildReconcileService(channel);
    (service as any).points = {
      fetchSnapshot: vi.fn().mockResolvedValue({ balance: 99 }),
    };
    const fingerprint = buildWarEndDiscrepancyFingerprintForTest(1001, 100, 99);

    vi.spyOn(prisma.clanPostedMessage, "findFirst").mockResolvedValue({
      id: "pm-1",
      guildId: "guild-1",
      clanTag: "#AAA111",
      type: "notify",
      event: "war_ended",
      channelId: "chan-1",
      messageId: "msg-1",
      messageUrl: "",
      warId: "1001",
      syncNum: null,
      configHash: `cfg|war_end_discrepancy:${fingerprint}`,
      createdAt: new Date(),
    } as any);
    vi.spyOn(prisma.clanWarHistory, "findFirst").mockResolvedValue({
      pointsAfterWar: 100,
      clanName: "Alpha",
      opponentName: "Enemy",
    } as any);
    const updateSpy = vi.spyOn(prisma.clanPostedMessage, "update").mockResolvedValue({} as any);

    await (service as any).reconcileWarEndedPointsDiscrepancy({
      guildId: "guild-1",
      clanTag: "#AAA111",
      fallbackOpponentName: "Enemy",
      allowProviderFetch: true,
      fetchReason: "post_war_reconciliation",
    });

    expect(edit).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("falls back to a follow-up message when editing the original message is not possible", async () => {
    const send = vi.fn().mockResolvedValue({ id: "fallback-msg" });
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(null),
      },
      send,
    };
    const service = buildReconcileService(channel);
    (service as any).points = {
      fetchSnapshot: vi.fn().mockResolvedValue({ balance: 99 }),
    };

    vi.spyOn(prisma.clanPostedMessage, "findFirst").mockResolvedValue({
      id: "pm-1",
      guildId: "guild-1",
      clanTag: "#AAA111",
      type: "notify",
      event: "war_ended",
      channelId: "chan-1",
      messageId: "msg-1",
      messageUrl: "",
      warId: "1001",
      syncNum: null,
      configHash: "cfg",
      createdAt: new Date(),
    } as any);
    vi.spyOn(prisma.clanWarHistory, "findFirst").mockResolvedValue({
      pointsAfterWar: 100,
      clanName: "Alpha",
      opponentName: "Enemy",
    } as any);
    const updateSpy = vi.spyOn(prisma.clanPostedMessage, "update").mockResolvedValue({} as any);

    await (service as any).reconcileWarEndedPointsDiscrepancy({
      guildId: "guild-1",
      clanTag: "#AAA111",
      fallbackOpponentName: "Enemy",
      allowProviderFetch: true,
      fetchReason: "post_war_reconciliation",
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]?.content).toContain(
      "[points.fwafarm](<https://points.fwafarm.com/clan?tag=AAA111>)"
    );
    expect(send.mock.calls[0]?.[0]?.content).toContain("Expected points: 100");
    expect(send.mock.calls[0]?.[0]?.content).toContain("Actual points: 99");
    expect(send.mock.calls[0]?.[0]?.content).not.toContain("clan?tag=OPP123");
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
});

describe("War-ended sync and metadata canonicalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the same resolved sync for tie outcome logic and displayed event sync", async () => {
    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as unknown as Client, {} as any);
    const sub = makeSubscription({
      clanTag: "#R80L8VYG",
      opponentTag: "#8CPGGJ8P",
      matchType: "FWA",
      inferredMatchType: true,
      state: "inWar",
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      warStartFwaPoints: 1200,
      fwaPoints: 1200,
    });
    const nowMs = Date.now();

    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    const updateSpy = vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);
    const dispatchSpy = vi.fn().mockResolvedValue(undefined);

    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: null,
      observation: { kind: "success" },
    });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(1001);
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = dispatchSpy;
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue({ syncNum: 476 }),
      upsertPointsSync: vi.fn().mockResolvedValue(undefined),
    };
    (service as any).points = {
      fetchSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          balance: 1200,
          winnerBoxTags: ["#8CPGGJ8P"],
          winnerBoxText: "",
          effectiveSync: 477,
          fetchedAtMs: nowMs,
        })
        .mockResolvedValueOnce({
          balance: 1200,
          activeFwa: true,
          notFound: false,
          fetchedAtMs: nowMs,
        }),
    };
    (service as any).history = {
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: null,
        resultLabel: "UNKNOWN",
      }),
    };

    await (service as any).processSubscription("guild-1", "#R80L8VYG", {
      previousSync: 476,
      activeSync: 477,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const detectedPayload = dispatchSpy.mock.calls[0]?.[0]?.payload;
    expect(detectedPayload.syncNumber).toBe(476);
    expect(detectedPayload.outcome).toBe("WIN");
    const updateData = updateSpy.mock.calls[0]?.[0]?.data;
    expect(updateData?.outcome).toBe("WIN");
  });

  it("uses canonical persisted war-ended context for live dispatch metadata", async () => {
    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as unknown as Client, {} as any);
    const payload = buildBasePayload({
      eventType: "war_ended",
      clanTag: "#R80L8VYG",
      clanName: "DARK EMPIRE™!",
      opponentTag: "#8CPGGJ8P",
      opponentName: "War Farmers 17",
      syncNumber: 476,
      warStartTime: new Date("2026-03-10T00:00:00.000Z"),
      warEndTime: new Date("2026-03-11T00:00:00.000Z"),
    });
    const sub = makeSubscription({
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      channelId: "chan-1",
      notify: true,
      state: "notInWar",
    });
    const reserveSpy = vi
      .spyOn(service as any, "reserveEventDelivery")
      .mockResolvedValue({ allowed: true, existingMessage: null, warId: "1001303" });
    const emitSpy = vi.spyOn(service as any, "emitEvent").mockResolvedValue(undefined);

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    (service as any).history = {
      persistWarEndHistory: persistSpy,
      resolveCanonicalWarEndedContext: vi.fn().mockResolvedValue({
        warId: 1001303,
        syncNumber: 477,
        clanName: "DARK EMPIRE™!",
        opponentTag: "#8CPGGJ8P",
        opponentName: "War Farmers 17",
        warStartTime: new Date("2026-03-09T00:00:00.000Z"),
        warEndTime: new Date("2026-03-10T00:00:00.000Z"),
      }),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: new Date("2026-03-10T00:00:00.000Z"),
        resultLabel: "UNKNOWN",
      }),
    };

    await (service as any).dispatchDetectedEvent({
      sub,
      payload,
      resolvedWarId: 1001350,
    });

    expect(reserveSpy).toHaveBeenCalledTimes(1);
    const reserveArgs = reserveSpy.mock.calls[0]?.[0];
    expect(reserveArgs.resolvedWarId).toBe(1001303);
    expect(reserveArgs.payload.syncNumber).toBe(477);
    expect(reserveArgs.payload.warStartTime?.toISOString()).toBe("2026-03-09T00:00:00.000Z");

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0]?.[2]).toBe(1001303);
    expect(emitSpy.mock.calls[0]?.[1]?.syncNumber).toBe(477);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy.mock.calls[0]?.[0]?.guildId).toBe("guild-1");
  });

  it("recomputes canonical war-ended expected points before live emit", async () => {
    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as unknown as Client, {} as any);
    const payload = buildBasePayload({
      eventType: "war_ended",
      clanTag: "#R80L8VYG",
      clanName: "Rocky Road",
      opponentTag: "#8CPGGJ8P",
      opponentName: "War Farmers 17",
      matchType: "FWA",
      outcome: "LOSE",
      warStartFwaPoints: 9,
      fwaPoints: 9,
      warEndFwaPoints: 10,
      clanStars: 100,
      opponentStars: 99,
    });
    const sub = makeSubscription({
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      channelId: "chan-1",
      notify: true,
      state: "notInWar",
    });
    const reserveSpy = vi
      .spyOn(service as any, "reserveEventDelivery")
      .mockResolvedValue({ allowed: true, existingMessage: null, warId: "1001303" });
    const emitSpy = vi.spyOn(service as any, "emitEvent").mockResolvedValue(undefined);
    const persistSpy = vi.fn().mockResolvedValue(undefined);
    (service as any).history = {
      persistWarEndHistory: persistSpy,
      resolveCanonicalWarEndedContext: vi.fn().mockResolvedValue({
        warId: 1001303,
        syncNumber: 477,
        clanName: "Rocky Road",
        opponentTag: "#8CPGGJ8P",
        opponentName: "War Farmers 17",
        warStartTime: new Date("2026-03-09T00:00:00.000Z"),
        warEndTime: new Date("2026-03-10T00:00:00.000Z"),
      }),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 70,
        opponentDestruction: 69,
        warEndTime: new Date("2026-03-10T00:00:00.000Z"),
        resultLabel: "WIN",
      }),
    };

    await (service as any).dispatchDetectedEvent({
      sub,
      payload,
      resolvedWarId: 1001350,
    });

    expect(reserveSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0]?.[1]?.warEndFwaPoints).toBe(8);
    expect(emitSpy.mock.calls[0]?.[1]?.testFinalResultOverride?.resultLabel).toBe("WIN");
    expect(persistSpy).toHaveBeenCalledTimes(2);
    expect(persistSpy.mock.calls[0]?.[0]?.guildId).toBe("guild-1");
    expect(persistSpy.mock.calls[1]?.[0]?.guildId).toBe("guild-1");
    expect(persistSpy.mock.calls[1]?.[0]?.warEndFwaPoints).toBe(8);
  });

  it("preview last-war path uses canonical persisted war-ended context metadata", async () => {
    const service = buildServiceWithHistoryStub();
    const history = (service as any).history;
    vi.spyOn(history, "resolveCanonicalWarEndedContext").mockResolvedValue({
      warId: 1001303,
      syncNumber: 477,
      clanName: "Rocky Road",
      opponentTag: "#8CPGGJ8P",
      opponentName: "War Farmers 17",
      warStartTime: new Date("2026-03-09T00:00:00.000Z"),
      warEndTime: new Date("2026-03-10T00:00:00.000Z"),
    });
    vi.spyOn(prisma.trackedClan, "findUnique").mockResolvedValue({
      notifyChannelId: "chan-1",
      notifyRole: null,
      notifyEnabled: true,
    } as any);
    vi.spyOn(prisma.clanNotifyConfig, "findUnique").mockResolvedValue({
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      channelId: "chan-1",
      roleId: null,
      pingEnabled: true,
      embedEnabled: true,
    } as any);
    (service as any).findSubscriptionByGuildAndTag = vi.fn().mockResolvedValue(
      makeSubscription({
        guildId: "guild-1",
        clanTag: "#R80L8VYG",
      })
    );
    (service as any).buildTestEventPayload = vi.fn().mockResolvedValue(
      buildBasePayload({
        eventType: "war_ended",
        clanTag: "#R80L8VYG",
        clanName: "Rocky Road",
        opponentTag: "#8CPGGJ8P",
        opponentName: "War Farmers 17",
        syncNumber: 476,
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
        resolvedWarIdHint: 1001350,
      })
    );

    const result = await service.buildTestEventPreviewForClan({
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      eventType: "war_ended",
      source: "last",
    });

    expect(result.ok).toBe(true);
    const fields = result.embeds?.[0]?.data?.fields ?? [];
    const metadataField = fields.find((field) => field.name === "War Metadata");
    expect(metadataField?.value).toContain("War ID: 1001303");
    expect(metadataField?.value).toContain("Sync: 477");
  });
});

describe("Battle-day swap reminder dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the reminder even when notify is disabled", async () => {
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const reminderSpy = vi
      .spyOn(service as any, "sendFwaBaseSwapBattleDayReminder")
      .mockResolvedValue(true);
    const reserveSpy = vi.spyOn(service as any, "reserveEventDelivery");
    const emitSpy = vi.spyOn(service as any, "emitEvent");
    const payload = buildBasePayload({
      eventType: "battle_day",
      matchType: "BL",
    });
    const sub = makeSubscription({
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      notify: false,
      channelId: null,
    });

    await (service as any).dispatchDetectedEvent({
      sub,
      payload,
      resolvedWarId: 1001303,
      sendBattleDaySwapReminders: true,
    });

    expect(reminderSpy).toHaveBeenCalledTimes(1);
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("still sends the reminder when battle-day delivery is blocked by reservation", async () => {
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const reminderSpy = vi
      .spyOn(service as any, "sendFwaBaseSwapBattleDayReminder")
      .mockResolvedValue(true);
    const reserveSpy = vi
      .spyOn(service as any, "reserveEventDelivery")
      .mockResolvedValue({
        allowed: false,
        existingMessage: {
          channelId: "chan-1",
          messageId: "msg-1",
        },
        warId: 1001303,
      });
    const emitSpy = vi.spyOn(service as any, "emitEvent");
    const payload = buildBasePayload({
      eventType: "battle_day",
      matchType: "BL",
    });
    const sub = makeSubscription({
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      channelId: "chan-1",
      notify: true,
    });

    await (service as any).dispatchDetectedEvent({
      sub,
      payload,
      resolvedWarId: 1001303,
      sendBattleDaySwapReminders: true,
    });

    expect(reminderSpy).toHaveBeenCalledTimes(1);
    expect(reserveSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe("War-start notify refresh sync fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runWarStartedInitialCase(input: {
    sameWarSync: number | null;
    previousSync: number | null;
  }): Promise<{
    payloadSyncNumber: number | null;
  }> {
    vi.clearAllMocks();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) =>
      callback(prisma as any),
    );
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as unknown as Client,
      {} as any,
    );
    const sub = makeSubscription({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: null,
      state: "notInWar",
      prepStartTime: null,
      startTime: null,
      endTime: null,
      opponentTag: null,
      opponentName: null,
    });
    (service as any).activeWarIdentity = buildActiveWarIdentityMock(
      sub,
      Number(sub.warId ?? 1001),
    );

    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([sub] as any);
    vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: {
        state: "preparation",
        clan: {
          name: "Alpha",
          stars: 0,
          attacks: 0,
          destructionPercentage: 0,
        },
        opponent: {
          tag: "#OPP123",
          name: "Enemy",
          stars: 0,
          attacks: 0,
          destructionPercentage: 0,
        },
        preparationStartTime: "20260311T000000.000Z",
        startTime: "20260312T000000.000Z",
        endTime: "20260313T000000.000Z",
        teamSize: 50,
        attacksPerMember: 2,
      },
      observation: { kind: "success" },
    });
    (service as any).recordCocWarObservation = vi
      .fn()
      .mockReturnValue({ suspected: false });
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).ensureCurrentWarId = vi.fn().mockResolvedValue(1000105);
    (service as any).syncWarAttacksFromWarSnapshot = vi
      .fn()
      .mockResolvedValue(undefined);
    const dispatchDetectedEventSpy = vi.fn().mockResolvedValue(undefined);
    (service as any).dispatchDetectedEvent = dispatchDetectedEventSpy;
    (service as any).reconcileWarEndedPointsDiscrepancy = vi
      .fn()
      .mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockResolvedValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(input.previousSync),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi
        .fn()
        .mockResolvedValue(input.sameWarSync === null ? null : { syncNum: input.sameWarSync }),
    };

    await (service as any).processSubscription("guild-1", "#AAA111", {
      previousSync: input.previousSync,
      activeSync:
        input.previousSync !== null && Number.isFinite(input.previousSync)
          ? Math.trunc(input.previousSync) + 1
          : null,
    });

    const payloadSyncNumber =
      (dispatchDetectedEventSpy.mock.calls[0]?.[0]?.payload?.syncNumber as
        | number
        | null
        | undefined) ?? null;
    return { payloadSyncNumber };
  }

  async function runWarStartedRefreshCase(input: {
    sameWarSync: number | null;
    postedSync: number | null;
    previousSync: number | null;
  }): Promise<{
    ok: boolean;
    payloadSyncNumber: number | null;
    getLatestPersistedSyncBaselineSpy: ReturnType<typeof vi.fn>;
    resolveSpy: ReturnType<typeof vi.spyOn>;
  }> {
    vi.clearAllMocks();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) =>
      callback(prisma as any),
    );
    const messageEdit = vi.fn().mockResolvedValue(undefined);
    const messageFetch = vi.fn().mockResolvedValue({
      content: "War declared against Enemy",
      embeds: [],
      edit: messageEdit,
    });
    const channelFetch = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: messageFetch },
    });
    const coc = {
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "preparation",
        clan: { name: "Alpha", stars: 0 },
        opponent: { tag: "#OPP123", name: "Enemy", stars: 0 },
        preparationStartTime: "20260311T000000.000Z",
        startTime: "20260312T000000.000Z",
        endTime: "20260313T000000.000Z",
      }),
    };
    const service = new WarEventLogService(
      { channels: { fetch: channelFetch } } as unknown as Client,
      coc as any
    );
    const sub = makeSubscription({
      guildId: "guild-1",
      clanTag: "#AAA111",
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
      endTime: new Date("2026-03-13T00:00:00.000Z"),
    });
    (service as any).activeWarIdentity = buildActiveWarIdentityMock(
      sub,
      Number(sub.warId ?? 1001),
    );

    vi.spyOn(prisma.currentWar, "update").mockResolvedValue({} as any);
    (service as any).findSubscriptionByGuildAndTag = vi.fn().mockResolvedValue(sub);
    (service as any).postedMessages = {
      findExistingMessage: vi.fn().mockResolvedValue({
        channelId: "chan-1",
        messageId: "msg-1",
        syncNum: input.postedSync,
      }),
    };
    (service as any).currentSyncs = {
      getCurrentSyncForClan: vi
        .fn()
        .mockResolvedValue(input.sameWarSync === null ? null : { syncNum: input.sameWarSync }),
    };
    const getLatestPersistedSyncBaselineSpy = vi
      .fn()
      .mockResolvedValue(input.previousSync);
    (service as any).syncResolution = {
      getLatestPersistedSyncBaseline: getLatestPersistedSyncBaselineSpy,
    };
    const resolveSpy = vi.spyOn((service as any).activeWarIdentity, "resolveCurrentWarId");

    const buildSpy = vi
      .spyOn(service as any, "buildWarStartedRefreshEmbed")
      .mockResolvedValue(new EmbedBuilder());

    const ok = await service.refreshCurrentNotifyPost("guild-1", "#AAA111");
    const payloadSyncNumber = (buildSpy.mock.calls[0]?.[0]?.syncNumber as number | null) ?? null;
    return {
      ok,
      payloadSyncNumber,
      getLatestPersistedSyncBaselineSpy,
      resolveSpy,
    };
  }

  it("prefers same-war sync over posted and derived values", async () => {
    const result = await runWarStartedRefreshCase({
      sameWarSync: 482,
      postedSync: 481,
      previousSync: 480,
    });

    expect(result.ok).toBe(true);
    expect(result.payloadSyncNumber).toBe(482);
    expect(result.getLatestPersistedSyncBaselineSpy).not.toHaveBeenCalled();
  });

  it("falls back to posted sync when same-war sync is unavailable", async () => {
    const result = await runWarStartedRefreshCase({
      sameWarSync: null,
      postedSync: 482,
      previousSync: 481,
    });

    expect(result.ok).toBe(true);
    expect(result.payloadSyncNumber).toBe(482);
    expect(result.getLatestPersistedSyncBaselineSpy).not.toHaveBeenCalled();
  });

  it("derives active-war sync as previous+1 when same-war and posted sync are unavailable", async () => {
    const result = await runWarStartedRefreshCase({
      sameWarSync: null,
      postedSync: null,
      previousSync: 481,
    });

    expect(result.ok).toBe(true);
    expect(result.payloadSyncNumber).toBe(482);
    expect(result.getLatestPersistedSyncBaselineSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps initial notify and refresh sync aligned when same-war sync exists", async () => {
    const initial = await runWarStartedInitialCase({
      sameWarSync: 482,
      previousSync: 480,
    });
    const refresh = await runWarStartedRefreshCase({
      sameWarSync: 482,
      postedSync: null,
      previousSync: 480,
    });

    expect(initial.payloadSyncNumber).toBe(482);
    expect(refresh.payloadSyncNumber).toBe(482);
    expect(initial.payloadSyncNumber).toBe(refresh.payloadSyncNumber);
  });

  it("keeps initial notify and refresh sync aligned for derived active fallback", async () => {
    const initial = await runWarStartedInitialCase({
      sameWarSync: null,
      previousSync: 481,
    });
    const refresh = await runWarStartedRefreshCase({
      sameWarSync: null,
      postedSync: null,
      previousSync: 481,
    });

    expect(initial.payloadSyncNumber).toBe(482);
    expect(refresh.payloadSyncNumber).toBe(482);
    expect(initial.payloadSyncNumber).toBe(refresh.payloadSyncNumber);
  });

  it("repairs notify refresh identity from live war data without falling back to the subscription row", async () => {
    const refresh = await runWarStartedRefreshCase({
      sameWarSync: 482,
      postedSync: null,
      previousSync: 480,
    });

    const call = refresh.resolveSpy.mock.calls[0]?.[0];
    expect(call?.policy).toBe("interactive_materialize");
    expect(call?.candidateIdentity?.state).toBe("preparation");
    expect(call?.candidateIdentity?.warStartTime).toEqual(
      new Date("2026-03-12T00:00:00.000Z"),
    );
    expect(call?.candidateIdentity?.preparationStartTime).toEqual(
      new Date("2026-03-11T00:00:00.000Z"),
    );
    expect(call?.candidateIdentity?.warEndTime).toEqual(
      new Date("2026-03-13T00:00:00.000Z"),
    );
    expect(
      String(call?.candidateIdentity?.opponentTag ?? "")
        .trim()
        .toUpperCase()
        .replace(/O/g, "0")
        .replace(/^#/, ""),
    ).toBe("0PP123");
    expect(call?.candidateIdentity?.opponentName).toBe("Enemy");
    expect(call?.candidateIdentity?.clanName).toBe("Alpha");
  });
});
