import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMock = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanCatalog: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/services/ClanHealthSnapshotService", () => ({
  ClanHealthSnapshotService: class {
    getSnapshot = serviceMock.getSnapshot;
  },
  CLAN_HEALTH_DEFAULT_WINDOW_DAYS: 30,
  CLAN_HEALTH_MIN_WINDOW_DAYS: 7,
  CLAN_HEALTH_MAX_WINDOW_DAYS: 180,
  buildClanHealthHistoricalCutoff: (now: Date, days: number) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { ClanHealth } from "../src/commands/ClanHealth";
import type {
  ClanHealthExternalSnapshot,
  ClanHealthTrackedSnapshot,
} from "../src/services/ClanHealthSnapshotService";

function makeInteraction(tagValue: string, windowValue: number | null = null) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    guildId: "guild-1",
    deferReply,
    editReply,
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        if (name === "tag") return tagValue;
        if (name === "visibility") return "private";
        if (required) return tagValue;
        return null;
      }),
      getInteger: vi.fn((name: string) => (name === "window" ? windowValue : null)),
      getFocused: vi.fn().mockReturnValue({ name: "tag", value: "alp" }),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/clan-health command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.fwaClanCatalog.findMany.mockReset();
  });

  function makeComplianceSnapshot(input: {
    hasCompletedEvaluations: boolean;
    evaluatedWarCount: number;
    affectedWarCount: number;
    violationCount: number;
    distinctPlayerCount: number;
    distinctCurrentDiscordUserCount: number;
  }) {
    return {
      period: "30d",
      hasCompletedEvaluations: input.hasCompletedEvaluations,
      evaluatedWarCount: input.evaluatedWarCount,
      affectedWarCount: input.affectedWarCount,
      violationCount: input.violationCount,
      distinctPlayerCount: input.distinctPlayerCount,
      distinctCurrentDiscordUserCount: input.distinctCurrentDiscordUserCount,
    };
  }

  function makeCompositionSnapshot(input?: Partial<ClanHealthTrackedSnapshot["composition"]>) {
    return {
      viewType: "tracked" as const,
      clanTag: "#AAA111",
      clanName: "Alpha",
      shortName: "A",
      displayCounts: {
        TH18: 0,
        TH17: 0,
        TH16: 0,
        TH15: 0,
        TH14: 0,
        "<=TH13": 0,
      },
      memberCount: 50,
      unresolvedWeightCount: 0,
      sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
      sourceAgeMs: 60 * 60 * 1000,
      selectedHeatMapRefAvailable: true,
      deviationScore: 0,
      healthy: true,
      ...input,
    };
  }

  function makeSnapshot(
    overrides: Partial<ClanHealthTrackedSnapshot> & {
      warPlanCompliance?: Partial<ClanHealthTrackedSnapshot["warPlanCompliance"]>;
      warMetrics?: Partial<ClanHealthTrackedSnapshot["warMetrics"]>;
      inactiveWars?: Partial<ClanHealthTrackedSnapshot["inactiveWars"]>;
      inactiveDays?: Partial<ClanHealthTrackedSnapshot["inactiveDays"]>;
      missingLinks?: Partial<ClanHealthTrackedSnapshot["missingLinks"]>;
      composition?: Partial<ClanHealthTrackedSnapshot["composition"]>;
      telemetry?: Partial<ClanHealthTrackedSnapshot["telemetry"]>;
    } = {}
  ): ClanHealthTrackedSnapshot {
    return {
      viewType: "tracked",
      clanTag: "#AAA111",
      clanName: "Alpha",
      historicalWindow: overrides.historicalWindow ?? {
        kind: "days",
        days: 30,
        cutoff: new Date("2026-02-07T12:00:00.000Z"),
      },
      composition: makeCompositionSnapshot(overrides.composition),
      warPlanCompliance: {
        hasCompletedEvaluations: true,
        evaluatedWarCount: 9,
        affectedWarCount: 4,
        violationCount: 7,
        distinctPlayerCount: 5,
        distinctCurrentDiscordUserCount: 3,
        ...overrides.warPlanCompliance,
      },
      warMetrics: {
        endedWarSampleSize: 20,
        fwaMatchCount: 14,
        fwaWinCount: 10,
        fwaLossCount: 4,
        blMatchCount: 3,
        mmMatchCount: 3,
        blInclusiveMatchCount: 17,
        winCount: 13,
        ...overrides.warMetrics,
      },
      inactiveWars: {
        warsAvailable: 3,
        warsSampled: 3,
        inactivePlayerCount: 2,
        ...overrides.inactiveWars,
      },
      inactiveDays: {
        thresholdDays: 6,
        staleHours: 6,
        observedMemberCount: 40,
        inactivePlayerCount: 5,
        ...overrides.inactiveDays,
      },
      missingLinks: {
        observedMemberCount: 40,
        linkedMemberCount: 35,
        missingMemberCount: 5,
        ...overrides.missingLinks,
      },
      telemetry: {
        warRows: 20,
        recognizedWarRows: 20,
        participationRows: 100,
        activityRows: 40,
        linkRows: 35,
        compositionMemberCount: 50,
        compositionUnresolvedCount: 0,
        compositionComplete: true,
        compositionSelectedHeatMapRefAvailable: true,
        compositionDeviationScore: 0,
        compositionSourceAgeMs: 60 * 60 * 1000,
        warSourceAgeMs: null,
        refreshAttempted: false,
        refreshStatus: "not_needed",
        staleFallbackUsed: false,
        durationMs: 7,
        ...overrides.telemetry,
      },
    };
  }

  function makeExternalCompositionSnapshot(
    input?: Partial<ClanHealthExternalSnapshot["composition"]>
  ): ClanHealthExternalSnapshot["composition"] {
    return {
      clanTag: "#EXT111",
      clanName: "External Alpha",
      displayCounts: {
        TH18: 5,
        TH17: 7,
        TH16: 8,
        TH15: 10,
        TH14: 9,
        "<=TH13": 11,
      },
      memberCount: 50,
      unresolvedWeightCount: 0,
      estimatedWeight: 145000,
      sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
      sourceAgeMs: 60 * 60 * 1000,
      selectedHeatMapRefAvailable: true,
      compositionComplete: true,
      deviationScore: 0,
      healthy: true,
      ...input,
    };
  }

  function makeExternalSnapshot(
    overrides: Partial<ClanHealthExternalSnapshot> & {
      composition?: Partial<ClanHealthExternalSnapshot["composition"]>;
      telemetry?: Partial<ClanHealthExternalSnapshot["telemetry"]>;
    } = {}
  ): ClanHealthExternalSnapshot {
    const warPerformance =
      overrides.warPerformance === null
        ? null
        : {
            endedWarSampleSize: 4,
            recognizedWarRows: 4,
            fwaMatchCount: 2,
            fwaWinCount: 1,
            fwaLossCount: 1,
            blMatchCount: 1,
            mmMatchCount: 1,
            blInclusiveMatchCount: 3,
            winCount: 2,
            sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
            sourceAgeMs: 60 * 60 * 1000,
            refreshAttempted: false,
            refreshStatus: "not_needed",
            staleFallbackUsed: false,
            ...overrides.warPerformance,
          };

    return {
      viewType: "external",
      clanTag: overrides.clanTag ?? "#EXT111",
      clanName: overrides.clanName ?? "External Alpha",
      composition: makeExternalCompositionSnapshot(overrides.composition),
      warPerformance,
      telemetry: {
        warRows: 4,
        recognizedWarRows: 4,
        compositionMemberCount: 50,
        compositionUnresolvedCount: 0,
        compositionComplete: true,
        compositionSelectedHeatMapRefAvailable: true,
        compositionDeviationScore: 0,
        compositionSourceAgeMs: 60 * 60 * 1000,
        warSourceAgeMs: 60 * 60 * 1000,
        refreshAttempted: false,
        refreshStatus: "not_needed",
        staleFallbackUsed: false,
        durationMs: 7,
        ...overrides.telemetry,
      },
    };
  }

  async function renderTrackedSnapshot(snapshot: ClanHealthTrackedSnapshot) {
    serviceMock.getSnapshot.mockResolvedValue(snapshot);
    const interaction = makeInteraction("AAA111");
    await ClanHealth.run({} as any, interaction as any, {
      getCurrentWar: vi.fn(),
      getClan: vi.fn(),
      getPlayerRaw: vi.fn(),
    } as any);
    return interaction.editReply.mock.calls[0]?.[0].embeds[0].toJSON();
  }

  it("renders leadership metrics and does not call external CoC API", async () => {
    serviceMock.getSnapshot.mockResolvedValue(
      makeSnapshot({
        historicalWindow: {
          kind: "syncs",
          requestedSyncCount: 30,
          syncNumbers: [901, 900],
          syncTimes: [new Date("2026-03-09T12:00:00.000Z")],
        },
        warPlanCompliance: makeComplianceSnapshot({
          hasCompletedEvaluations: true,
          evaluatedWarCount: 9,
          affectedWarCount: 4,
          violationCount: 7,
          distinctPlayerCount: 5,
          distinctCurrentDiscordUserCount: 3,
        }),
      }),
    );

    const interaction = makeInteraction("AAA111");
    const cocService = { getCurrentWar: vi.fn(), getClan: vi.fn(), getPlayerRaw: vi.fn() };
    await ClanHealth.run({} as any, interaction as any, cocService as any);

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(cocService.getClan).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
      }),
    );
    const payload = interaction.editReply.mock.calls[0]?.[0];
    const embedJson = payload.embeds[0].toJSON();
    expect(embedJson.title).toContain("Clan Health");
    expect(embedJson.fields.map((field: any) => field.name)).toEqual([
      "War Performance",
      "Current Composition",
      "War Plan Compliance — Last 30 Syncs",
      "Inactivity",
      "Discord Links",
    ]);
    expect(String(embedJson.fields[1].value)).toContain("TH18: **0**");
    expect(String(embedJson.fields[1].value)).toContain("Members: **50/50**");
    expect(String(embedJson.fields[1].value)).toContain("Deviation: **✅ 0**");
    expect(String(embedJson.fields[1].value)).toContain("Source age: **1h**");
    expect(String(embedJson.fields[2].value)).toContain(
      "Violations: **7** across **5** player accounts",
    );
    expect(String(embedJson.fields[2].value)).toContain("Linked Discord users involved: **3**");
    expect(String(embedJson.fields[2].value)).toContain(
      "Affected wars: **4/9** evaluated FWA wars",
    );
    expect(String(embedJson.fields[0].value)).toContain(
      "Match rate (last 30 syncs; 20 ended wars): **70.0% (14/20)**",
    );
    expect(String(embedJson.fields[0].value)).toContain(
      ":green_circle: 10 | :red_circle: 4 | :black_circle: 3 | :white_circle: 3",
    );
    expect(String(embedJson.fields[0].value)).toContain("Match rate (including BL): **85.0%**");
    expect(String(embedJson.fields[0].value)).toContain("Win rate (same window): **65.0% (13/20)**");
    expect(String(embedJson.fields[3].value)).toContain(
      "Missed both attacks (distinct players, >=1 eligible FWA war in last 30 syncs): **2**",
    );
    expect(String(embedJson.fields[3].value)).toContain("Eligible ended FWA wars in window: **3**");
    expect(String(embedJson.fields[3].value)).toContain("Inactive (days, >=6d): **5**");
    const navigationButtons = payload.components[0].components.map((button: any) => button.toJSON());
    expect(navigationButtons.map((button: any) => button.label)).toEqual([
      "View Inactive",
      "View Unlinked",
      "View Compo",
      "View Violations",
      "War History",
    ]);
    expect(navigationButtons[4].custom_id).toBe("clan-health:war-history:AAA111:s30");
    expect(navigationButtons.every((button: any) => button.custom_id.length <= 100)).toBe(true);
    expect(payload.components).toHaveLength(2);
    expect(payload.components[1].components.map((button: any) => button.toJSON())).toEqual([
      expect.objectContaining({
        label: "View Trends",
        custom_id: "clan-health:trends:AAA111:s30",
      }),
    ]);
  });

  it("reports partial mapped sync coverage without changing the default IDs", async () => {
    const embed = await renderTrackedSnapshot(makeSnapshot({
      historicalWindow: {
        kind: "syncs",
        requestedSyncCount: 30,
        syncNumbers: Array.from({ length: 18 }, (_, index) => 900 - index),
        syncTimes: [],
      },
    }));

    expect(String(embed.fields[0].value)).toContain("Mapped syncs available: **18/30**");
    expect(embed.fields[0].value).not.toContain("Mapped syncs available: **30/30**");
  });

  it("does not report a partial coverage note when all default syncs are mapped", async () => {
    const embed = await renderTrackedSnapshot(makeSnapshot({
      historicalWindow: {
        kind: "syncs",
        requestedSyncCount: 30,
        syncNumbers: Array.from({ length: 30 }, (_, index) => 900 - index),
        syncTimes: [],
      },
    }));

    expect(String(embed.fields[0].value)).not.toContain("Mapped syncs available:");
  });

  it("does not report mapped sync coverage for explicit day windows", async () => {
    const embed = await renderTrackedSnapshot(makeSnapshot({
      historicalWindow: {
        kind: "days",
        days: 60,
        cutoff: new Date("2026-01-09T12:00:00.000Z"),
      },
    }));

    expect(String(embed.fields[0].value)).not.toContain("Mapped syncs available:");
  });

  it("declares the bounded optional window and forwards a selected value", async () => {
    const windowOption = ClanHealth.options?.find((option: any) => option.name === "window") as any;
    expect(windowOption).toMatchObject({
      type: 4,
      required: false,
      min_value: 7,
      max_value: 180,
    });

    serviceMock.getSnapshot.mockResolvedValue(makeSnapshot({
      historicalWindow: {
        kind: "days",
        days: 60,
        cutoff: new Date("2026-01-08T12:00:00.000Z"),
      },
    }));
    const interaction = makeInteraction("AAA111", 60);
    await ClanHealth.run({} as any, interaction as any, {} as any);

    expect(serviceMock.getSnapshot).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#AAA111",
      historicalWindowDays: 60,
    });
    const payload = interaction.editReply.mock.calls[0]?.[0];
    expect(payload.components[0].components[4].toJSON().custom_id).toBe(
      "clan-health:war-history:AAA111:60",
    );
    expect(payload.components[1].components[0].toJSON().custom_id).toBe(
      "clan-health:trends:AAA111:60",
    );
  });

  it("renders an external snapshot with war data and omits tracked-only fields", async () => {
    serviceMock.getSnapshot.mockResolvedValue(
      makeExternalSnapshot({
        clanTag: "#EXT111",
        clanName: "External Alpha",
      }),
    );

    const interaction = makeInteraction("EXT111");
    const cocService = { getCurrentWar: vi.fn(), getClan: vi.fn(), getPlayerRaw: vi.fn() };
    await ClanHealth.run({} as any, interaction as any, cocService as any);

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(cocService.getClan).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls[0]?.[0];
    const embedJson = payload.embeds[0].toJSON();
    expect(embedJson.title).toContain("External Clan View");
    expect(embedJson.fields.map((field: any) => field.name)).toEqual([
      "War Performance",
      "Current Composition",
    ]);
    expect(String(embedJson.fields[0].value)).toContain("Match rate (last 30 available ended wars)");
    expect(String(embedJson.fields[1].value)).toContain("Members: **50/50**");
    expect(String(embedJson.fields[1].value)).toContain("Unresolved: **0**");
    expect(String(embedJson.fields[1].value)).toContain("Deviation: **\u2705 0**");
    expect(String(embedJson.fields[1].value)).not.toContain("War Plan Compliance");
    expect(String(embedJson.fields[1].value)).not.toContain("Inactivity");
    expect(String(embedJson.fields[1].value)).not.toContain("Discord Links");
    expect(payload.components).toBeUndefined();
  });

  it("renders an external snapshot without war data using only the composition field", async () => {
    serviceMock.getSnapshot.mockResolvedValue(
      makeExternalSnapshot({
        clanTag: "#EXT222",
        clanName: "External Bravo",
        warPerformance: null,
        telemetry: {
          warRows: 0,
          recognizedWarRows: 0,
          compositionMemberCount: 50,
          compositionUnresolvedCount: 0,
          compositionComplete: true,
          compositionSelectedHeatMapRefAvailable: true,
          compositionDeviationScore: 0,
          compositionSourceAgeMs: 60 * 60 * 1000,
          warSourceAgeMs: null,
          refreshAttempted: true,
          refreshStatus: "failed",
          staleFallbackUsed: false,
          durationMs: 7,
        },
      }),
    );

    const interaction = makeInteraction("EXT222");
    const cocService = { getCurrentWar: vi.fn(), getClan: vi.fn(), getPlayerRaw: vi.fn() };
    await ClanHealth.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0];
    const embedJson = payload.embeds[0].toJSON();
    expect(embedJson.fields.map((field: any) => field.name)).toEqual(["Current Composition"]);
    expect(String(embedJson.fields[0].value)).toContain("Members: **50/50**");
    expect(payload.components).toBeUndefined();
  });

  it("renders only the no-evaluation compliance message when no completed evaluations exist", async () => {
    serviceMock.getSnapshot.mockResolvedValue(
      makeSnapshot({
        warPlanCompliance: makeComplianceSnapshot({
          hasCompletedEvaluations: false,
          evaluatedWarCount: 0,
          affectedWarCount: 0,
          violationCount: 0,
          distinctPlayerCount: 0,
          distinctCurrentDiscordUserCount: 0,
        }),
        warMetrics: {
          endedWarSampleSize: 0,
          fwaMatchCount: 0,
          fwaWinCount: 0,
          fwaLossCount: 0,
          blMatchCount: 0,
          mmMatchCount: 0,
          blInclusiveMatchCount: 0,
          winCount: 0,
        },
        inactiveWars: {
          warsAvailable: 0,
          warsSampled: 0,
          inactivePlayerCount: 0,
        },
        inactiveDays: {
          thresholdDays: 6,
          staleHours: 6,
          observedMemberCount: 0,
          inactivePlayerCount: 0,
        },
        missingLinks: {
          observedMemberCount: 0,
          linkedMemberCount: 0,
          missingMemberCount: 0,
        },
        telemetry: {
          warRows: 0,
          participationRows: 0,
          activityRows: 0,
          linkRows: 0,
          durationMs: 1,
        },
        composition: {
          sourceAgeMs: null,
          selectedHeatMapRefAvailable: false,
          deviationScore: null,
          healthy: false,
        },
      }),
    );

    const interaction = makeInteraction("AAA111");
    const cocService = { getCurrentWar: vi.fn(), getClan: vi.fn(), getPlayerRaw: vi.fn() };
    await ClanHealth.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0];
    const embedJson = payload.embeds[0].toJSON();
    expect(String(embedJson.fields[2].value)).toBe(
      "No completed FWA war-plan evaluations are available yet.",
    );
    expect(String(embedJson.fields[2].value)).not.toContain("Violations:");
    expect(String(embedJson.fields[2].value)).not.toContain("Linked Discord users involved:");
    expect(String(embedJson.fields[2].value)).not.toContain("0/0");
  });

  it("renders the zero-violation summary and pluralizes player accounts correctly", async () => {
    serviceMock.getSnapshot.mockResolvedValue(
      makeSnapshot({
        warPlanCompliance: makeComplianceSnapshot({
          hasCompletedEvaluations: true,
          evaluatedWarCount: 9,
          affectedWarCount: 0,
          violationCount: 0,
          distinctPlayerCount: 0,
          distinctCurrentDiscordUserCount: 0,
        }),
        warMetrics: {
          endedWarSampleSize: 0,
          fwaMatchCount: 0,
          fwaWinCount: 0,
          fwaLossCount: 0,
          blMatchCount: 0,
          mmMatchCount: 0,
          blInclusiveMatchCount: 0,
          winCount: 0,
        },
        inactiveWars: {
          warsAvailable: 0,
          warsSampled: 0,
          inactivePlayerCount: 0,
        },
        inactiveDays: {
          thresholdDays: 6,
          staleHours: 6,
          observedMemberCount: 0,
          inactivePlayerCount: 0,
        },
        missingLinks: {
          observedMemberCount: 0,
          linkedMemberCount: 0,
          missingMemberCount: 0,
        },
        telemetry: {
          warRows: 0,
          participationRows: 0,
          activityRows: 0,
          linkRows: 0,
          durationMs: 1,
        },
        composition: {
          sourceAgeMs: null,
          selectedHeatMapRefAvailable: false,
          deviationScore: null,
          healthy: false,
        },
      }),
    );

    const interaction = makeInteraction("AAA111");
    const cocService = { getCurrentWar: vi.fn(), getClan: vi.fn(), getPlayerRaw: vi.fn() };
    await ClanHealth.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0];
    const embedJson = payload.embeds[0].toJSON();
    expect(String(embedJson.fields[2].value)).toContain(
      "Violations: **0** across **0** player accounts",
    );
    expect(String(embedJson.fields[2].value)).toContain("Linked Discord users involved: **0**");
    expect(String(embedJson.fields[2].value)).toContain("Affected wars: **0/9** evaluated FWA wars");
  });

  it("renders a singular player account label for one violating account", async () => {
    serviceMock.getSnapshot.mockResolvedValue(
      makeSnapshot({
        warPlanCompliance: makeComplianceSnapshot({
          hasCompletedEvaluations: true,
          evaluatedWarCount: 9,
          affectedWarCount: 1,
          violationCount: 1,
          distinctPlayerCount: 1,
          distinctCurrentDiscordUserCount: 1,
        }),
        warMetrics: {
          endedWarSampleSize: 0,
          fwaMatchCount: 0,
          fwaWinCount: 0,
          fwaLossCount: 0,
          blMatchCount: 0,
          mmMatchCount: 0,
          blInclusiveMatchCount: 0,
          winCount: 0,
        },
        inactiveWars: {
          warsAvailable: 0,
          warsSampled: 0,
          inactivePlayerCount: 0,
        },
        inactiveDays: {
          thresholdDays: 6,
          staleHours: 6,
          observedMemberCount: 0,
          inactivePlayerCount: 0,
        },
        missingLinks: {
          observedMemberCount: 0,
          linkedMemberCount: 0,
          missingMemberCount: 0,
        },
        telemetry: {
          warRows: 0,
          participationRows: 0,
          activityRows: 0,
          linkRows: 0,
          durationMs: 1,
        },
        composition: {
          sourceAgeMs: null,
          selectedHeatMapRefAvailable: false,
          deviationScore: null,
          healthy: false,
        },
      }),
    );

    const interaction = makeInteraction("AAA111");
    const cocService = { getCurrentWar: vi.fn(), getClan: vi.fn(), getPlayerRaw: vi.fn() };
    await ClanHealth.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0];
    const embedJson = payload.embeds[0].toJSON();
    expect(String(embedJson.fields[2].value)).toContain(
      "Violations: **1** across **1** player account",
    );
  });

  it("pluralizes player accounts for zero and multiple counts", async () => {
    serviceMock.getSnapshot.mockResolvedValue(
      makeSnapshot({
        warPlanCompliance: makeComplianceSnapshot({
          hasCompletedEvaluations: true,
          evaluatedWarCount: 9,
          affectedWarCount: 2,
          violationCount: 2,
          distinctPlayerCount: 2,
          distinctCurrentDiscordUserCount: 2,
        }),
        warMetrics: {
          endedWarSampleSize: 0,
          fwaMatchCount: 0,
          fwaWinCount: 0,
          fwaLossCount: 0,
          blMatchCount: 0,
          mmMatchCount: 0,
          blInclusiveMatchCount: 0,
          winCount: 0,
        },
        inactiveWars: {
          warsAvailable: 0,
          warsSampled: 0,
          inactivePlayerCount: 0,
        },
        inactiveDays: {
          thresholdDays: 6,
          staleHours: 6,
          observedMemberCount: 0,
          inactivePlayerCount: 0,
        },
        missingLinks: {
          observedMemberCount: 0,
          linkedMemberCount: 0,
          missingMemberCount: 0,
        },
        telemetry: {
          warRows: 0,
          participationRows: 0,
          activityRows: 0,
          linkRows: 0,
          durationMs: 1,
        },
        composition: {
          sourceAgeMs: null,
          selectedHeatMapRefAvailable: false,
          deviationScore: null,
          healthy: false,
        },
      }),
    );

    const interaction = makeInteraction("AAA111");
    const cocService = { getCurrentWar: vi.fn(), getClan: vi.fn(), getPlayerRaw: vi.fn() };
    await ClanHealth.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0];
    const embedJson = payload.embeds[0].toJSON();
    expect(String(embedJson.fields[2].value)).toContain(
      "Violations: **2** across **2** player accounts",
    );
  });

  it("supports tracked-clan autocomplete for tag", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { name: "Alpha", tag: "#AAA111" },
      { name: "Bravo", tag: "#BBB222" },
    ]);
    const interaction = makeInteraction("AAA111");
    interaction.options.getFocused.mockReturnValue({ name: "tag", value: "alp" });

    await ClanHealth.autocomplete?.(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha (#AAA111)", value: "AAA111" },
    ]);
  });

  it("prioritizes tracked clans and appends bounded external matches for autocomplete", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { name: "Alpha", tag: "#AAA111" },
      { name: "Beta", tag: "#BBB222" },
    ]);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([
      { clanTag: "#CCC333", name: "Charlie" },
      { clanTag: "#AAA111", name: "Alpha catalog duplicate" },
      { clanTag: "#DDD444", name: "Delta" },
    ]);

    const interaction = makeInteraction("AAA111");
    interaction.options.getFocused.mockReturnValue({ name: "tag", value: "a" });

    await ClanHealth.autocomplete?.(interaction as any);

    expect(prismaMock.fwaClanCatalog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 23,
      }),
    );
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha (#AAA111)", value: "AAA111" },
      { name: "Beta (#BBB222)", value: "BBB222" },
      { name: "Charlie (#CCC333) - External", value: "CCC333" },
      { name: "Delta (#DDD444) - External", value: "DDD444" },
    ]);
  });

  it("matches external clan names with the raw query and tag text with normalized Clash tags", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanCatalog.findMany
      .mockResolvedValueOnce([{ clanTag: "#ROCKY", name: "Rocky Road" }])
      .mockResolvedValueOnce([{ clanTag: "#PY0L", name: "Tag Match" }]);

    const nameInteraction = makeInteraction("AAA111");
    nameInteraction.options.getFocused.mockReturnValue({ name: "tag", value: "Rocky Road" });
    await ClanHealth.autocomplete?.(nameInteraction as any);

    expect(prismaMock.fwaClanCatalog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              name: { contains: "rocky road", mode: "insensitive" },
            }),
          ]),
        }),
      }),
    );
    expect(nameInteraction.respond).toHaveBeenCalledWith([
      { name: "Rocky Road (#R0CKY) - External", value: "R0CKY" },
    ]);

    prismaMock.fwaClanCatalog.findMany.mockClear();
    const tagInteraction = makeInteraction("AAA111");
    tagInteraction.options.getFocused.mockReturnValue({ name: "tag", value: "PYO" });

    await ClanHealth.autocomplete?.(tagInteraction as any);

    expect(prismaMock.fwaClanCatalog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              clanTag: { contains: "py0", mode: "insensitive" },
            }),
          ]),
        }),
      }),
    );
    expect(tagInteraction.respond).toHaveBeenCalledWith([
      { name: "Tag Match (#PY0L) - External", value: "PY0L" },
    ]);
  });
});
