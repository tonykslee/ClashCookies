import { describe, expect, it, vi, beforeEach } from "vitest";

const blacklistClanServiceMock = vi.hoisted(() => ({
  upsertBlacklistClanTags: vi.fn(),
}));

const blacklistMatchSampleServiceMock = vi.hoisted(() => ({
  rebuildBlacklistMatchSamples: vi.fn(),
}));

const blacklistHeatmapRefServiceMock = vi.hoisted(() => ({
  rebuildBlacklistHeatmapRef: vi.fn(),
}));

const fwaMatchChecklistStateServiceMock = vi.hoisted(() => ({
  buildFwaMatchChecklistRenderStateForGuild: vi.fn().mockResolvedValue({
    rows: [
      {
        clanTag: "#PYPY",
        compactCopyLine: "📬 | 🟢 | RR vs `Bravo` (`#B1`)",
        badgeEmojiId: "111",
        badgeEmojiName: "rr",
        badgeEmojiInline: "<:rr:111>",
        contextKey: "ctx-rr",
      },
    ],
    scopeKey: "fwa_match_checklist|guild=guild-1|clan=all|rows=ctx-rr",
    checkedClanTags: ["#PYPY"],
    referenceId: "sync-message-1",
    emptyMessage: null,
  }),
}));

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  clanPointsSync: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  warMailLifecycle: {
    findFirst: vi.fn(),
  },
  clanWarPlan: {
    findFirst: vi.fn(),
  },
  trackedMessage: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

vi.mock("../src/services/BlacklistClanService", () => ({
  blacklistClanService: blacklistClanServiceMock,
}));

vi.mock("../src/services/BlacklistMatchSampleService", () => ({
  blacklistMatchSampleService: blacklistMatchSampleServiceMock,
}));

vi.mock("../src/services/BlacklistHeatmapRefService", () => ({
  blacklistHeatmapRefService: blacklistHeatmapRefServiceMock,
}));

vi.mock("../src/services/FwaMatchChecklistStateService", () => ({
  buildFwaMatchChecklistRenderStateForGuild:
    fwaMatchChecklistStateServiceMock.buildFwaMatchChecklistRenderStateForGuild,
}));

import {
  Fwa,
  buildTrackedMatchOverviewForTest,
  buildWarMailEmbedForTagForTest,
  normalizeFwaMatchResponseModeForTest,
  resolveCurrentWarOutcomeForPersistenceForTest,
  resolveFwaMatchDisplayStateForTest,
  resolveSafeFwaPointsProjectionForTest,
} from "../src/commands/Fwa";
import { trackedMessageService } from "../src/services/TrackedMessageService";

function makeMatchInteraction(params: {
  subcommand?: "match" | "match-checklist" | "blacklist-import" | "rebuild";
  subcommandGroup?: "blacklist-samples" | "blacklist-profile" | null;
  visibility?: "private" | "public";
  type?: "Mail" | "Bases";
  clan?: string | null;
  checked?: boolean | null;
  copyPaste?: boolean;
  tag?: string | null;
  tags?: string | null;
  sourceLabel?: string | null;
  active?: boolean | null;
  isAdmin?: boolean;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const react = vi.fn().mockResolvedValue(undefined);
  const pin = vi.fn().mockResolvedValue(undefined);
  const fetchReply = vi.fn().mockResolvedValue({
    id: "message-1",
    react,
    pin,
  });
  const interaction = {
    id: "interaction-1",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    deferReply,
    editReply,
    fetchReply,
    followUp: vi.fn().mockResolvedValue(undefined),
    memberPermissions: {
      has: vi.fn(() => Boolean(params.isAdmin)),
    },
    inGuild: vi.fn(() => true),
    options: {
      getSubcommandGroup: vi.fn(() => params.subcommandGroup ?? null),
      getSubcommand: vi.fn(() => params.subcommand ?? "match"),
      getString: vi.fn((name: string) => {
        if (name === "visibility") return params.visibility ?? "private";
        if (name === "type") return params.type ?? null;
        if (name === "clan") return params.clan ?? null;
        if (name === "tag") return params.tag ?? "ABC123";
        if (name === "tags") return params.tags ?? null;
        if (name === "source-label") return params.sourceLabel ?? null;
        if (name === "debug-mail-status") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "checked") return params.checked ?? null;
        if (name === "copy_paste") return params.copyPaste ?? false;
        if (name === "active") return params.active ?? true;
        if (name === "debug-mail-status") return false;
        return null;
      }),
    },
  };
  return { interaction, deferReply, editReply };
}

describe("/fwa match response normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
    prismaMock.clanPointsSync.findMany.mockResolvedValue([]);
    prismaMock.clanPointsSync.findUnique.mockResolvedValue(null);
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.currentWar.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.upsert.mockResolvedValue({});
    prismaMock.warMailLifecycle.findFirst.mockResolvedValue(null);
    prismaMock.clanWarPlan.findFirst.mockResolvedValue(null);
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue(null);
    blacklistClanServiceMock.upsertBlacklistClanTags.mockReset();
    blacklistMatchSampleServiceMock.rebuildBlacklistMatchSamples.mockReset();
    blacklistHeatmapRefServiceMock.rebuildBlacklistHeatmapRef.mockReset();
    blacklistClanServiceMock.upsertBlacklistClanTags.mockResolvedValue({
      sourceLabel: "manual-import",
      active: true,
      added: [],
      updated: [],
      invalid: [],
      duplicateInRequest: [],
      totalRequested: 0,
    });
    blacklistMatchSampleServiceMock.rebuildBlacklistMatchSamples.mockResolvedValue({
      status: "success",
      reason: null,
      activeBlacklistCount: 1,
      fwaClanCount: 1,
      candidateWarCount: 1,
      qualifyingSampleCount: 1,
      skippedCandidateCount: 0,
      addedCount: 1,
      updatedCount: 0,
      summaryLines: ["sample summary"],
    });
    blacklistHeatmapRefServiceMock.rebuildBlacklistHeatmapRef.mockResolvedValue({
      status: "success",
      reason: null,
      usableSampleCount: 4,
      bandCount: 2,
      addedCount: 2,
      updatedCount: 0,
      removedCount: 0,
      summaryLines: ["profile summary"],
    });
  });

  it("accepts only a complete same-sync persisted projection for display", async () => {
    const resolveMatchup = vi.fn().mockResolvedValue({
      clan: {
        balance: 99,
        coverage: "complete_reconstruction",
        projectionSafe: true,
        syncNumber: 102,
        isEstimate: true,
      },
      opponent: {
        balance: 101,
        coverage: "complete_reconstruction",
        projectionSafe: true,
        syncNumber: 102,
        isEstimate: true,
      },
    });

    await expect(
      resolveSafeFwaPointsProjectionForTest({
        guildId: "guild-1",
        clanTag: "#HOME",
        opponentTag: "#OPP",
        activeWar: {
          trackedClanTag: "#HOME",
          warId: "game-war-102",
          warStartTime: new Date("2026-05-13T18:00:00.000Z"),
          syncNumber: 102,
          matchType: "FWA",
          inferredMatchType: true,
          warState: "inWar",
        },
        resolver: { resolveMatchup } as any,
      }),
    ).resolves.toEqual({
      clanBalance: 99,
      opponentBalance: 101,
      estimated: true,
    });
    expect(resolveMatchup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unsafe coverage", { coverage: "last_known_unresolved_history", projectionSafe: false }, null],
    ["different sync", { coverage: "complete_reconstruction", projectionSafe: true, syncNumber: 101 }, null],
  ])("rejects a projection with %s", async (_label, override, expected) => {
    const resolveMatchup = vi.fn().mockResolvedValue({
      clan: { balance: 99, coverage: "complete_reconstruction", projectionSafe: true, syncNumber: 102, isEstimate: true, ...override },
      opponent: { balance: 101, coverage: "complete_reconstruction", projectionSafe: true, syncNumber: 102, isEstimate: true },
    });

    await expect(
      resolveSafeFwaPointsProjectionForTest({
        guildId: "guild-1",
        clanTag: "#HOME",
        opponentTag: "#OPP",
        activeWar: {
          trackedClanTag: "#HOME",
          warId: "game-war-102",
          warStartTime: new Date("2026-05-13T18:00:00.000Z"),
          syncNumber: 102,
          matchType: "FWA",
          inferredMatchType: true,
          warState: "inWar",
        },
        resolver: { resolveMatchup } as any,
      }),
    ).resolves.toBe(expected);
  });

  it("does not resolve a projection when active sync identity is missing", async () => {
    const resolveMatchup = vi.fn();
    const result = await resolveSafeFwaPointsProjectionForTest({
      guildId: "guild-1",
      clanTag: "#HOME",
      opponentTag: "#OPP",
      activeWar: {
        trackedClanTag: "#HOME",
        warId: "game-war-102",
        warStartTime: new Date("2026-05-13T18:00:00.000Z"),
        syncNumber: null,
        matchType: "FWA",
        inferredMatchType: true,
        warState: "inWar",
      },
      resolver: { resolveMatchup } as any,
    });

    expect(result).toBeNull();
    expect(resolveMatchup).not.toHaveBeenCalled();
  });

  it.each([
    ["stale site without estimate", false, "WIN", "WIN"],
    ["validated site", false, "LOSE", "LOSE"],
    ["estimated display with no confirmed outcome", true, null, undefined],
    ["estimated display with confirmed outcome", true, "WIN", "WIN"],
  ])(
    "keeps CurrentWar outcome persistence separate for %s",
    (_label, estimatedProjection, liveExpectedOutcome, expected) => {
      expect(
        resolveCurrentWarOutcomeForPersistenceForTest({
          displayOnlyProjection: estimatedProjection,
          liveExpectedOutcome,
        }),
      ).toBe(expected);
    },
  );

  it("uses one display state for estimated balances, winner, and warning", () => {
    expect(
      resolveFwaMatchDisplayStateForTest({
        clanTag: "#HOME",
        opponentTag: "#OPP",
        syncNumber: 102,
        currentPrimaryBalance: null,
        currentOpponentBalance: null,
        safeProjection: {
          clanBalance: 101,
          opponentBalance: 99,
          estimated: true,
        },
        siteUpdatedForAlert: false,
      }),
    ).toEqual({
      primaryBalance: 101,
      opponentBalance: 99,
      estimated: true,
      displayOnlyFallback: true,
      warningLine:
        ":warning: Points projected from persisted evidence; not current points.fwafarm data.",
      projectedOutcome: "WIN",
    });
  });

  it("labels a validated stale-site fallback independently of resolver estimate provenance", () => {
    expect(
      resolveFwaMatchDisplayStateForTest({
        clanTag: "#HOME",
        opponentTag: "#OPP",
        syncNumber: 102,
        currentPrimaryBalance: null,
        currentOpponentBalance: null,
        safeProjection: {
          clanBalance: 101,
          opponentBalance: 99,
          estimated: false,
        },
        siteUpdatedForAlert: false,
      }),
    ).toEqual({
      primaryBalance: 101,
      opponentBalance: 99,
      estimated: false,
      displayOnlyFallback: true,
      warningLine:
        ":warning: Points from persisted fallback evidence; not current points.fwafarm data.",
      projectedOutcome: "WIN",
    });
  });

  it("does not project a winner when the estimate is unresolved", () => {
    expect(
      resolveFwaMatchDisplayStateForTest({
        clanTag: "#HOME",
        opponentTag: "#OPP",
        syncNumber: 102,
        currentPrimaryBalance: null,
        currentOpponentBalance: null,
        safeProjection: null,
        siteUpdatedForAlert: false,
      }),
    ).toEqual({
      primaryBalance: null,
      opponentBalance: null,
      estimated: false,
      displayOnlyFallback: false,
      warningLine: null,
      projectedOutcome: null,
    });
  });

  it("keeps a safe validated fallback display-only at the real overview call site", async () => {
    const warStartTime = new Date("2026-05-13T18:00:00.000Z");
    const staleSyncRow = (clanTag: string, points: number, opponentPoints: number) => ({
      clanTag,
      warId: "7001",
      warStartTime,
      syncNum: 102,
      lastKnownSyncNumber: 102,
      lastKnownMatchType: "FWA",
      opponentTag: clanTag === "#HOME" ? "#OPP" : "#HOME",
      clanPoints: points,
      opponentPoints,
      isFwa: true,
      needsValidation: false,
      lastSuccessfulPointsApiFetchAt: new Date("2026-05-13T19:00:00.000Z"),
      syncFetchedAt: new Date("2026-05-13T19:00:00.000Z"),
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#HOME", name: "Home", shortName: "H", mailChannelId: null },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#HOME",
        warId: "7001",
        startTime: warStartTime,
        opponentTag: "#OPP",
        state: "inWar",
        prepStartTime: new Date("2026-05-12T18:00:00.000Z"),
        endTime: null,
        opponentName: "Opponent",
        clanName: "Home",
        channelId: "channel-1",
        notify: false,
        pingRole: false,
        notifyRole: false,
        matchType: "FWA",
        inferredMatchType: false,
        outcome: null,
        fwaPoints: 100,
        opponentFwaPoints: 98,
      },
    ]);
    prismaMock.clanPointsSync.findMany.mockResolvedValue([
      staleSyncRow("#HOME", 100, 98),
    ]);
    prismaMock.currentWar.upsert.mockResolvedValue({
      warId: "7001",
      startTime: warStartTime,
      opponentTag: "#OPP",
      state: "inWar",
      matchType: "FWA",
      inferredMatchType: false,
      outcome: null,
      fwaPoints: 100,
      opponentFwaPoints: 98,
    });

    const resolver = {
      resolveMatchup: vi.fn().mockResolvedValue({
        clan: {
          balance: 101,
          coverage: "complete_reconstruction",
          projectionSafe: true,
          syncNumber: 102,
          isEstimate: false,
        },
        opponent: {
          balance: 99,
          coverage: "complete_reconstruction",
          projectionSafe: true,
          syncNumber: 102,
          isEstimate: false,
        },
      }),
    };
    const cocService = {
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "inWar",
        startTime: "20260513T180000.000Z",
        preparationStartTime: "20260512T180000.000Z",
        endTime: null,
        clan: { tag: "#HOME", name: "Home", stars: 0, attacks: 0 },
        opponent: { tag: "#OPP", name: "Opponent", stars: 0, attacks: 0 },
      }),
    };
    const staleSnapshot = (tag: string, balance: number, opponentTag: string, opponentBalance: number) => ({
      version: 5,
      tag,
      url: `https://points.fwafarm.com/clan?tag=${tag.replace(/^#/, "")}`,
      snapshotSource: "direct",
      lookupState: "ok",
      balance,
      clanName: tag === "#HOME" ? "Home" : "Opponent",
      activeFwa: true,
      notFound: false,
      winnerBoxText: null,
      winnerBoxTags: [tag, opponentTag],
      winnerBoxSync: 101,
      effectiveSync: 101,
      syncMode: "high",
      winnerBoxHasTag: true,
      headerPrimaryTag: tag,
      headerOpponentTag: opponentTag,
      headerPrimaryBalance: balance,
      headerOpponentBalance: opponentBalance,
      warEndMs: null,
      lastWarCheckAtMs: null,
      fetchedAtMs: Date.now(),
      refreshedForWarEndMs: null,
    });

    const result = await buildTrackedMatchOverviewForTest(
      cocService as any,
      102,
      "guild-1",
      undefined,
      null,
      {
        includeActualSheet: false,
        pointsEstimateResolver: resolver as any,
        pointsSnapshotProvider: vi.fn(async (tag: string) =>
          tag === "HOME"
            ? staleSnapshot("#HOME", 100, "#OPP", 98)
            : staleSnapshot("#OPP", 98, "#HOME", 100),
        ),
      },
    );

    const view = result.singleViews.HOME;
    expect(view.embed.toJSON().fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Persisted Points",
          value: expect.stringContaining("101"),
        }),
      ]),
    );
    expect(view.embed.toJSON().description).toContain(
      "persisted fallback evidence",
    );
    expect(view.embed.toJSON().description).toContain("Expected outcome: **WIN**");
    expect(result.embed.toJSON().fields?.[0]?.value).toContain(
      "Persisted points: 101 - 99",
    );
    expect(result.embed.toJSON().fields?.[0]?.value).toContain(
      "Outcome: **WIN**",
    );
    expect(view.effectiveRevisionFields?.expectedOutcome).toBe("UNKNOWN");
    expect(view.mailAction?.enabled).toBe(false);
    const overviewUpsert = prismaMock.currentWar.upsert.mock.calls.at(-1)?.[0];
    expect(overviewUpsert).toEqual(
      expect.objectContaining({
        create: expect.objectContaining({
          fwaPoints: null,
          opponentFwaPoints: null,
          outcome: null,
        }),
        update: expect.objectContaining({
          matchType: "FWA",
          inferredMatchType: false,
          outcome: undefined,
          fwaPoints: undefined,
          opponentFwaPoints: undefined,
        }),
      }),
    );
    expect(resolver.resolveMatchup).toHaveBeenCalledTimes(1);
  });

  it.each(["BL", "MM"] as const)(
    "does not render a safe FWA projection as %s points when the website snapshot is missing",
    async (revisionMatchType) => {
      const warStartTime = new Date("2026-05-13T18:00:00.000Z");
      prismaMock.trackedClan.findMany.mockResolvedValue([
        { tag: "#HOME", name: "Home", shortName: "H", mailChannelId: null },
      ]);
      prismaMock.currentWar.findMany.mockResolvedValue([
        {
          clanTag: "#HOME",
          warId: "7001",
          startTime: warStartTime,
          opponentTag: "#OPP",
          state: "inWar",
          prepStartTime: new Date("2026-05-12T18:00:00.000Z"),
          endTime: null,
          opponentName: "Opponent",
          clanName: "Home",
          channelId: "channel-1",
          notify: false,
          pingRole: false,
          notifyRole: false,
          matchType: "FWA",
          inferredMatchType: false,
          outcome: null,
          fwaPoints: 100,
          opponentFwaPoints: 98,
        },
      ]);
      prismaMock.clanPointsSync.findMany.mockResolvedValue([
        {
          clanTag: "#HOME",
          warId: "7001",
          warStartTime: warStartTime,
          syncNum: 102,
          lastKnownSyncNumber: 102,
          lastKnownMatchType: "FWA",
          opponentTag: "#OPP",
          clanPoints: 100,
          opponentPoints: 98,
          isFwa: true,
          needsValidation: false,
          lastSuccessfulPointsApiFetchAt: new Date("2026-05-13T19:00:00.000Z"),
          syncFetchedAt: new Date("2026-05-13T19:00:00.000Z"),
        },
      ]);

      const resolver = {
        resolveMatchup: vi.fn().mockResolvedValue({
          clan: {
            balance: 101,
            coverage: "complete_reconstruction",
            projectionSafe: true,
            syncNumber: 102,
            isEstimate: true,
          },
          opponent: {
            balance: 99,
            coverage: "complete_reconstruction",
            projectionSafe: true,
            syncNumber: 102,
            isEstimate: true,
          },
        }),
      };
      const cocService = {
        getCurrentWar: vi.fn().mockResolvedValue({
          state: "inWar",
          startTime: "20260513T180000.000Z",
          preparationStartTime: "20260512T180000.000Z",
          endTime: null,
          clan: { tag: "#HOME", name: "Home", stars: 0, attacks: 0 },
          opponent: { tag: "#OPP", name: "Opponent", stars: 0, attacks: 0 },
        }),
      };

      const result = await buildTrackedMatchOverviewForTest(
        cocService as any,
        102,
        "guild-1",
        undefined,
        null,
        {
          includeActualSheet: false,
          pointsEstimateResolver: resolver as any,
          revisionDraftByTag: {
            HOME: {
              warId: "7001",
              opponentTag: "#OPP",
              matchType: revisionMatchType,
              expectedOutcome: null,
            },
          },
          pointsSnapshotProvider: vi.fn(async () => null as any),
        },
      );

      const view = result.singleViews.HOME;
      expect(view.embed.toJSON().fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Points",
            value: "Unavailable",
          }),
        ]),
      );
      expect(view.embed.toJSON().fields).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: expect.stringMatching(/Estimated|Persisted/),
          }),
        ]),
      );
      expect(resolver.resolveMatchup).toHaveBeenCalledTimes(1);
    },
  );

  it("retains same-war stored points for a blocked routine mail render without deriving an outcome", async () => {
    const warStartTime = new Date("2026-05-13T18:00:00.000Z");
    const currentWar = {
      guildId: "guild-1",
      clanTag: "#HOME",
      warId: "7001",
      startTime: warStartTime,
      opponentTag: "#OPP",
      state: "inWar",
      prepStartTime: new Date("2026-05-12T18:00:00.000Z"),
      endTime: new Date("2026-05-14T18:00:00.000Z"),
      opponentName: "Opponent",
      clanName: "Home",
      matchType: "FWA",
      inferredMatchType: false,
      outcome: null,
      fwaPoints: 100,
      opponentFwaPoints: 98,
      clanStars: null,
      opponentStars: null,
      clanDestruction: null,
      opponentDestruction: null,
      updatedAt: new Date("2026-05-14T18:01:00.000Z"),
    };
    const syncRow = {
      guildId: "guild-1",
      clanTag: "#HOME",
      warId: "7001",
      warStartTime,
      syncNum: 102,
      lastKnownSyncNumber: 102,
      lastKnownMatchType: "FWA",
      lastKnownOutcome: null,
      opponentTag: "#OPP",
      clanPoints: 100,
      opponentPoints: 98,
      isFwa: true,
      needsValidation: false,
      confirmedByClanMail: false,
      lastSuccessfulPointsApiFetchAt: new Date("2026-05-14T18:01:00.000Z"),
      syncFetchedAt: new Date("2026-05-14T18:01:00.000Z"),
      updatedAt: new Date("2026-05-14T18:01:00.000Z"),
    };
    prismaMock.$queryRaw.mockResolvedValue([
      { tag: "#HOME", name: "Home", mailChannelId: "mail-1", clanRoleId: null },
    ]);
    prismaMock.currentWar.findUnique.mockResolvedValue(currentWar);
    prismaMock.currentWar.findFirst.mockResolvedValue(currentWar);
    prismaMock.clanPointsSync.findUnique.mockResolvedValue(syncRow);
    prismaMock.clanPointsSync.findFirst.mockResolvedValue(syncRow);
    prismaMock.trackedClan.findUnique.mockResolvedValue({ mailConfig: null });

    const result = await buildWarMailEmbedForTagForTest(
      {
        getCurrentWar: vi.fn().mockResolvedValue({
          state: "inWar",
          startTime: "20260513T180000.000Z",
          preparationStartTime: "20260512T180000.000Z",
          endTime: "20260514T180000.000Z",
          clan: { tag: "#HOME", name: "Home", stars: 0, attacks: 0 },
          opponent: { tag: "#OPP", name: "Opponent", stars: 0, attacks: 0 },
        }),
      } as any,
      "guild-1",
      "#HOME",
      { routine: true, fetchReason: "mail_refresh" },
    );

    expect(result.embed.toJSON().fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Stored Points",
          value: "100 - 98 (current points unavailable)",
        }),
      ]),
    );
    expect(result.expectedOutcome).toBe("UNKNOWN");
    expect(result.renderResult.kind).toBe("unresolved_fwa_expected_outcome");
  });

  it("does not display stored points from a stale war identity during a blocked mail render", async () => {
    const staleWarStartTime = new Date("2026-05-12T18:00:00.000Z");
    const currentWar = {
      guildId: "guild-1",
      clanTag: "#HOME",
      warId: "6001",
      startTime: staleWarStartTime,
      opponentTag: "#OLDOPP",
      state: "inWar",
      prepStartTime: new Date("2026-05-11T18:00:00.000Z"),
      endTime: new Date("2026-05-13T18:00:00.000Z"),
      opponentName: "Old Opponent",
      clanName: "Home",
      matchType: "FWA",
      inferredMatchType: false,
      outcome: null,
      fwaPoints: 100,
      opponentFwaPoints: 98,
      clanStars: null,
      opponentStars: null,
      clanDestruction: null,
      opponentDestruction: null,
      updatedAt: new Date("2026-05-13T18:01:00.000Z"),
    };
    const syncRow = {
      guildId: "guild-1",
      clanTag: "#HOME",
      warId: "6001",
      warStartTime: staleWarStartTime,
      syncNum: 101,
      lastKnownSyncNumber: 101,
      lastKnownMatchType: "FWA",
      lastKnownOutcome: null,
      opponentTag: "#OLDOPP",
      clanPoints: 100,
      opponentPoints: 98,
      isFwa: true,
      needsValidation: false,
      confirmedByClanMail: false,
      lastSuccessfulPointsApiFetchAt: new Date("2026-05-13T18:01:00.000Z"),
      syncFetchedAt: new Date("2026-05-13T18:01:00.000Z"),
      updatedAt: new Date("2026-05-13T18:01:00.000Z"),
    };
    prismaMock.$queryRaw.mockResolvedValue([
      { tag: "#HOME", name: "Home", mailChannelId: "mail-1", clanRoleId: null },
    ]);
    prismaMock.currentWar.findUnique.mockResolvedValue(currentWar);
    prismaMock.currentWar.findFirst.mockResolvedValue(currentWar);
    prismaMock.clanPointsSync.findUnique.mockResolvedValue(syncRow);
    prismaMock.clanPointsSync.findFirst.mockResolvedValue(syncRow);
    prismaMock.trackedClan.findUnique.mockResolvedValue({ mailConfig: null });

    const result = await buildWarMailEmbedForTagForTest(
      {
        getCurrentWar: vi.fn().mockResolvedValue({
          state: "inWar",
          startTime: "20260513T180000.000Z",
          preparationStartTime: "20260512T180000.000Z",
          endTime: "20260514T180000.000Z",
          clan: { tag: "#HOME", name: "Home", stars: 0, attacks: 0 },
          opponent: { tag: "#OPP", name: "Opponent", stars: 0, attacks: 0 },
        }),
      } as any,
      "guild-1",
      "#HOME",
      { routine: true, fetchReason: "mail_refresh" },
    );

    expect(result.embed.toJSON().fields).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Stored Points" }),
      ]),
    );
    expect(result.expectedOutcome).toBeNull();
    expect(result.renderResult.kind).not.toBe("resolved_fwa_expected_outcome");
  });

  it("normalizes copy-paste into public visibility", () => {
    const normalized = normalizeFwaMatchResponseModeForTest({
      visibility: "private",
      copyPaste: true,
    });

    expect(normalized.normalizedCopyPaste).toBe(true);
    expect(normalized.normalizedVisibility).toBe("public");
    expect(normalized.isPublic).toBe(true);
  });

  it("forces public visibility when copy_paste:true is requested", async () => {
    const run = makeMatchInteraction({
      visibility: "private",
      copyPaste: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Clan #ABC123 is not in tracked clans.",
      }),
    );
  });

  it("keeps private non-copy-paste match replies ephemeral", async () => {
    const run = makeMatchInteraction({
      visibility: "private",
      copyPaste: false,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });

  it("renders the checklist snapshot command without requiring copy-paste", async () => {
    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "private",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Mail Checklist"),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("📬 | 🟢 | ✅ | RR vs `Bravo` (`#B1`)"),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "React with your clan's badge to indicate that the in-game mails have been sent.",
        ),
      }),
    );
  });

  it("defaults /fwa match-checklist to Mail when type is omitted", async () => {
    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "public",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(fwaMatchChecklistStateServiceMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Mail",
      }),
    );
    const payload = run.editReply.mock.calls.at(-1)?.[0] as any;
    const refreshButton = payload?.components?.[0]?.toJSON?.().components?.[0];
    expect(refreshButton?.label).toBe("Refresh");
  });

  it("renders the bases checklist snapshot command as read-only text", async () => {
    fwaMatchChecklistStateServiceMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
          badgeEmojiId: null,
          badgeEmojiName: null,
          badgeEmojiInline: "",
        },
      ],
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
      checkedClanTags: [],
      referenceId: null,
      expiresAt: new Date("2026-05-13T22:00:00.000Z"),
      emptyMessage: null,
    } as any);

    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "private",
      type: "Bases",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(fwaMatchChecklistStateServiceMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Bases",
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Bases Checklist"),
        components: [],
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("❌ Bases not checked"),
      }),
    );
  });


  it("renders the public bases checklist with a Refresh button", async () => {
    fwaMatchChecklistStateServiceMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
          badgeEmojiId: null,
          badgeEmojiName: null,
          badgeEmojiInline: "",
        },
      ],
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
      checkedClanTags: [],
      referenceId: null,
      expiresAt: new Date("2026-05-13T22:00:00.000Z"),
      emptyMessage: null,
    } as any);

    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "public",
      type: "Bases",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    const payload = run.editReply.mock.calls[0]?.[0] as any;
    expect(payload.components?.[0]?.toJSON?.().components?.[0]?.label).toBe("Refresh");
    expect(run.interaction.fetchReply).toHaveBeenCalledTimes(1);
  });

  it("persists a bases checked completion for the current war", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findFirst.mockImplementation(async ({ where }) => {
      const candidates = Array.isArray(where?.OR) ? where.OR : [];
      const found = candidates.some(
        (candidate: { clanTag?: string | null }) => candidate?.clanTag === "PYPY",
      );
      return found
        ? {
            warId: 1001,
            startTime: new Date("2026-05-13T18:00:00.000Z"),
            opponentTag: "#OPP1",
            state: "preparation",
          }
        : null;
    });
    const completionSpy = vi
      .spyOn(trackedMessageService, "setFwaMatchChecklistBasesCompletion")
      .mockResolvedValue(true);

    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "public",
      type: "Bases",
      clan: "A",
      checked: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(completionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "channel-1",
        createdByUserId: "user-1",
        clanTag: "#PYPY",
        checked: true,
        warId: 1001,
        warStartTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
      }),
    );
    expect(prismaMock.currentWar.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          OR: expect.arrayContaining([
            { clanTag: "PYPY" },
            { clanTag: "#PYPY" },
          ]),
        }),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Bases checked and all good saved"),
      }),
    );
  });

  it("clears a bases checked completion for the current war", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      warId: 1001,
      startTime: new Date("2026-05-13T18:00:00.000Z"),
      opponentTag: "#OPP1",
      state: "battle",
    });
    const completionSpy = vi
      .spyOn(trackedMessageService, "setFwaMatchChecklistBasesCompletion")
      .mockResolvedValue(true);

    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "private",
      type: "Bases",
      clan: "A",
      checked: false,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(completionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        clanTag: "#PYPY",
        checked: false,
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Cleared all-good bases state"),
      }),
    );
  });

  it("rejects clan and checked when provided for mail mode", async () => {
    const completionSpy = vi.spyOn(
      trackedMessageService,
      "setFwaMatchChecklistBasesCompletion",
    );
    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "private",
      type: "Mail",
      clan: "Alpha",
      checked: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "`clan` and `checked` only apply to `type:Bases`.",
      }),
    );
    expect(completionSpy).not.toHaveBeenCalled();
  });

  it("imports blacklist clans through the new admin command path", async () => {
    blacklistClanServiceMock.upsertBlacklistClanTags.mockResolvedValueOnce({
      sourceLabel: "manual-import",
      active: false,
      added: ["#PYLQ0289", "#PYLQ0288", "#PYLQ0280"],
      updated: [],
      invalid: [],
      duplicateInRequest: ["#PYLQ0289"],
      totalRequested: 4,
    });
    const run = makeMatchInteraction({
      subcommand: "blacklist-import",
      tags: "#PYLQ0289, PYLQ0288 PYLQ0280 #PYLQ0289",
      sourceLabel: "manual-import",
      active: false,
      isAdmin: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(blacklistClanServiceMock.upsertBlacklistClanTags).toHaveBeenCalledWith(
      expect.objectContaining({
        rawTags: "#PYLQ0289, PYLQ0288 PYLQ0280 #PYLQ0289",
        sourceLabel: "manual-import",
        active: false,
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Blacklist registry updated from `manual-import` (inactive)."),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Added: **3**"),
      }),
    );
  });

  it("rejects blacklist import for non-admin users", async () => {
    const run = makeMatchInteraction({
      subcommand: "blacklist-import",
      tags: "#AAA111",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(blacklistClanServiceMock.upsertBlacklistClanTags).not.toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only administrators can use this command.",
      }),
    );
  });

  it("rebuilds blacklist matchup samples through the new admin command path", async () => {
    const run = makeMatchInteraction({
      subcommandGroup: "blacklist-samples",
      subcommand: "rebuild",
      isAdmin: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(blacklistMatchSampleServiceMock.rebuildBlacklistMatchSamples).toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Blacklist matchup samples rebuilt."),
        components: expect.any(Array),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("sample summary"),
      }),
    );
  });

  it("rebuilds the blacklist heatmapref profile through the new admin command path", async () => {
    const run = makeMatchInteraction({
      subcommandGroup: "blacklist-profile",
      subcommand: "rebuild",
      isAdmin: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(blacklistHeatmapRefServiceMock.rebuildBlacklistHeatmapRef).toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Blacklist heatmapref profile rebuilt."),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("profile summary"),
      }),
    );
  });

  it("rejects blacklist sample rebuild for non-admin users", async () => {
    const run = makeMatchInteraction({
      subcommandGroup: "blacklist-samples",
      subcommand: "rebuild",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(blacklistMatchSampleServiceMock.rebuildBlacklistMatchSamples).not.toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only administrators can use this command.",
      }),
    );
  });

  it("rejects blacklist heatmapref profile rebuild for non-admin users", async () => {
    const run = makeMatchInteraction({
      subcommandGroup: "blacklist-profile",
      subcommand: "rebuild",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(blacklistHeatmapRefServiceMock.rebuildBlacklistHeatmapRef).not.toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only administrators can use this command.",
      }),
    );
  });
});
