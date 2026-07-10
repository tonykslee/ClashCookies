import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMock = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/services/ClanHealthSnapshotService", () => ({
  ClanHealthSnapshotService: class {
    getSnapshot = serviceMock.getSnapshot;
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { ClanHealth } from "../src/commands/ClanHealth";
import type { ClanHealthSnapshot } from "../src/services/ClanHealthSnapshotService";

function makeInteraction(tagValue: string) {
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
      getFocused: vi.fn().mockReturnValue({ name: "tag", value: "alp" }),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/clan-health command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  function makeCompositionSnapshot(input?: Partial<ClanHealthSnapshot["composition"]>) {
    return {
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
    overrides: Partial<ClanHealthSnapshot> & {
      warPlanCompliance?: Partial<ClanHealthSnapshot["warPlanCompliance"]>;
      warMetrics?: Partial<ClanHealthSnapshot["warMetrics"]>;
      inactiveWars?: Partial<ClanHealthSnapshot["inactiveWars"]>;
      inactiveDays?: Partial<ClanHealthSnapshot["inactiveDays"]>;
      missingLinks?: Partial<ClanHealthSnapshot["missingLinks"]>;
      composition?: Partial<ClanHealthSnapshot["composition"]>;
      telemetry?: Partial<ClanHealthSnapshot["telemetry"]>;
    } = {}
  ): ClanHealthSnapshot {
    return {
      clanTag: "#AAA111",
      clanName: "Alpha",
      composition: makeCompositionSnapshot(overrides.composition),
      warPlanCompliance: {
        period: "30d",
        hasCompletedEvaluations: true,
        evaluatedWarCount: 9,
        affectedWarCount: 4,
        violationCount: 7,
        distinctPlayerCount: 5,
        distinctCurrentDiscordUserCount: 3,
        ...overrides.warPlanCompliance,
      },
      warMetrics: {
        windowSize: 30,
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
        windowSize: 3,
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
        participationRows: 100,
        activityRows: 40,
        linkRows: 35,
        compositionMemberCount: 50,
        compositionUnresolvedCount: 0,
        compositionSelectedHeatMapRefAvailable: true,
        compositionDeviationScore: 0,
        compositionSourceAgeMs: 60 * 60 * 1000,
        durationMs: 7,
        ...overrides.telemetry,
      },
    };
  }

  it("renders leadership metrics and does not call external CoC API", async () => {
    serviceMock.getSnapshot.mockResolvedValue(
      makeSnapshot({
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
      "War Plan Compliance — Last 30 Days",
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
      "Match rate (last 30 ended wars): **70.0% (14/20)**",
    );
    expect(String(embedJson.fields[0].value)).toContain(
      ":green_circle: 10 | :red_circle: 4 | :black_circle: 3 | :white_circle: 3",
    );
    expect(String(embedJson.fields[0].value)).toContain("Match rate (including BL): **85.0%**");
    expect(String(embedJson.fields[0].value)).toContain("Win rate (same window): **65.0% (13/20)**");
    expect(String(embedJson.fields[3].value)).toContain(
      "Missed both attacks (distinct players, >=1 of last 3 ended FWA wars): **2**",
    );
    expect(String(embedJson.fields[3].value)).toContain("Inactive (days, >=6d): **5**");
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
          windowSize: 30,
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
          windowSize: 3,
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
          windowSize: 30,
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
          windowSize: 3,
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
          windowSize: 30,
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
          windowSize: 3,
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
          windowSize: 30,
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
          windowSize: 3,
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
});
