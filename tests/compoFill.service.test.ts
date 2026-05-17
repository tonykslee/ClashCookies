import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompoFillService } from "../src/services/CompoFillService";
import * as actualStateService from "../src/services/CompoActualStateService";
import * as fillerAccountService from "../src/services/FillerAccountService";
import * as planner from "../src/services/CompoFillPlanner";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";
import { playerCurrentService } from "../src/services/PlayerCurrentService";

function getEmbedJSON(embed: any): any {
  return typeof embed?.toJSON === "function" ? embed.toJSON() : embed;
}

function makeTrackedClanPlan(overrides: Partial<any> = {}): any {
  return {
    clanTag: "#AAA111",
    clanName: "Alpha",
    shortName: "A",
    initialMemberCount: 48,
    targetMemberCount: 50,
    remainingSlots: 0,
    initialBucketCounts: {
      TH18: 0,
      TH17: 0,
      TH16: 0,
      TH15: 1,
      TH14: 47,
      TH13: 0,
      TH12: 0,
      TH11: 0,
      TH10: 0,
      TH9: 0,
      TH8_OR_LOWER: 0,
    },
    targetBucketCounts: {
      TH18: 0,
      TH17: 0,
      TH16: 0,
      TH15: 2,
      TH14: 48,
      TH13: 0,
      TH12: 0,
      TH11: 0,
      TH10: 0,
      TH9: 0,
      TH8_OR_LOWER: 0,
    },
    plannedMoves: [],
    ...overrides,
  };
}

function makePlannerResult(): any {
  return {
    destinationPlans: [
      makeTrackedClanPlan({
        plannedMoves: [
          {
            sequence: 1,
            matchedBucket: "TH15",
            filler: {
              playerTag: "#P1",
              playerName: "Alice",
              resolvedWeight: 145000,
              resolvedWeightBucket: "TH15",
              currentClanTag: null,
              currentClanName: null,
              sourceClanTag: null,
              sourceClanName: null,
              sourceKind: "untracked",
            },
            destinationClanTag: "#AAA111",
            destinationClanName: "Alpha",
            destinationShortName: "A",
            destinationMemberCountBefore: 48,
            destinationMemberCountAfter: 49,
            destinationBucketCountsBefore: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 1,
              TH14: 47,
              TH13: 0,
              TH12: 0,
              TH11: 0,
              TH10: 0,
              TH9: 0,
              TH8_OR_LOWER: 0,
            },
            destinationBucketCountsAfter: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 2,
              TH14: 47,
              TH13: 0,
              TH12: 0,
              TH11: 0,
              TH10: 0,
              TH9: 0,
              TH8_OR_LOWER: 0,
            },
            sourceClanTag: null,
            sourceClanName: null,
            sourceMemberCountBefore: null,
            sourceMemberCountAfter: null,
            sourceBucketCountsBefore: null,
            sourceBucketCountsAfter: null,
          },
          {
            sequence: 2,
            matchedBucket: "TH14",
            filler: {
              playerTag: "#P2",
              playerName: "Bob",
              resolvedWeight: 135000,
              resolvedWeightBucket: "TH14",
              currentClanTag: "#SRC",
              currentClanName: "Source",
              sourceClanTag: "#SRC",
              sourceClanName: "Source",
              sourceKind: "tracked_surplus",
            },
            destinationClanTag: "#AAA111",
            destinationClanName: "Alpha",
            destinationShortName: "A",
            destinationMemberCountBefore: 49,
            destinationMemberCountAfter: 50,
            destinationBucketCountsBefore: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 2,
              TH14: 47,
              TH13: 0,
              TH12: 0,
              TH11: 0,
              TH10: 0,
              TH9: 0,
              TH8_OR_LOWER: 0,
            },
            destinationBucketCountsAfter: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 2,
              TH14: 48,
              TH13: 0,
              TH12: 0,
              TH11: 0,
              TH10: 0,
              TH9: 0,
              TH8_OR_LOWER: 0,
            },
            sourceClanTag: "#SRC",
            sourceClanName: "Source",
            sourceMemberCountBefore: 51,
            sourceMemberCountAfter: 50,
            sourceBucketCountsBefore: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 1,
              TH14: 50,
              TH13: 0,
              TH12: 0,
              TH11: 0,
              TH10: 0,
              TH9: 0,
              TH8_OR_LOWER: 0,
            },
            sourceBucketCountsAfter: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 0,
              TH14: 50,
              TH13: 0,
              TH12: 0,
              TH11: 0,
              TH10: 0,
              TH9: 0,
              TH8_OR_LOWER: 0,
            },
          },
        ],
        remainingSlots: 0,
      }),
      makeTrackedClanPlan({
        clanTag: "#BBB222",
        clanName: "Bravo",
        shortName: "B",
        initialMemberCount: 49,
        targetMemberCount: 50,
        remainingSlots: 1,
        initialBucketCounts: {
          TH18: 0,
          TH17: 0,
          TH16: 0,
          TH15: 0,
          TH14: 49,
          TH13: 0,
          TH12: 0,
          TH11: 0,
          TH10: 0,
          TH9: 0,
          TH8_OR_LOWER: 0,
        },
        targetBucketCounts: {
          TH18: 0,
          TH17: 0,
          TH16: 0,
          TH15: 0,
          TH14: 49,
          TH13: 1,
          TH12: 0,
          TH11: 0,
          TH10: 0,
          TH9: 0,
          TH8_OR_LOWER: 0,
        },
        plannedMoves: [],
      }),
    ],
    unavailableFillers: [
      {
        playerTag: "#BLOCKED",
        playerName: "Blocked",
        resolvedWeight: 145000,
        resolvedWeightBucket: "TH15",
        currentClanTag: "#SRC",
        currentClanName: "Source",
        sourceClanTag: "#SRC",
        sourceClanName: "Source",
        reasonCodes: ["source_member_count_below_target", "source_bucket_deficit"],
      },
    ],
    excludedFillers: [
      {
        playerTag: "#MISSING",
        playerName: "Missing",
        resolvedWeight: null,
        resolvedWeightBucket: null,
        currentClanTag: null,
        currentClanName: null,
        reasonCodes: ["missing_weight"],
      },
    ],
    unusedAvailableFillers: [
      {
        playerTag: "#EXTRA",
        playerName: "Extra",
        resolvedWeight: 155000,
        resolvedWeightBucket: "TH16",
        currentClanTag: null,
        currentClanName: null,
        sourceClanTag: null,
        sourceClanName: null,
        sourceKind: "untracked",
      },
    ],
    remainingUnfilledClanSlots: [
      {
        clanTag: "#BBB222",
        clanName: "Bravo",
        shortName: "B",
        remainingSlots: 1,
        currentMemberCount: 49,
        targetMemberCount: 50,
      },
    ],
  };
}

describe("/compo fill service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes tracked clan and filler inputs to the planner and renders grouped sections", async () => {
    vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      trackedClanTags: ["#AAA111", "#BBB222"],
      renderableClanTags: ["#AAA111", "#BBB222"],
      latestSourceSyncedAt: null,
      heatMapRefs: [
        {
          weightMinInclusive: 100000,
          weightMaxInclusive: 200000,
          th18Count: 0,
          th17Count: 0,
          th16Count: 0,
          th15Count: 2,
          th14Count: 48,
          th13Count: 0,
          th12Count: 0,
          th11Count: 0,
          th10OrLowerCount: 0,
        },
      ],
      clans: [
        {
          clanTag: "#AAA111",
          clanName: "Alpha",
          shortName: "A",
          base: {
            resolvedTotalWeight: 123456,
            unresolvedWeightCount: 0,
            deferredWeightCount: 0,
            memberCount: 48,
            bucketCounts: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 1,
              TH14: 47,
              TH13: 0,
              TH12: 0,
              TH11: 0,
              TH10: 0,
              TH9: 0,
              TH8_OR_LOWER: 0,
            },
          },
          members: [],
        },
        {
          clanTag: "#BBB222",
          clanName: "Bravo",
          shortName: "B",
          base: {
            resolvedTotalWeight: 120000,
            unresolvedWeightCount: 0,
            deferredWeightCount: 0,
            memberCount: 49,
            bucketCounts: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 0,
              TH14: 49,
              TH13: 0,
              TH12: 0,
              TH11: 0,
              TH10: 0,
              TH9: 0,
              TH8_OR_LOWER: 0,
            },
          },
          members: [],
        },
      ],
    } as any);
    vi.spyOn(fillerAccountService, "listFillerAccountsForGuild").mockResolvedValue([
      {
        tag: "#P1",
        name: "Alice",
        clanTag: null,
        clanName: null,
        weight: 145000,
        discordUserId: null,
        discordUsername: null,
        linkedName: null,
        isFiller: true,
      },
      {
        tag: "#P2",
        name: "Bob",
        clanTag: "#SRC",
        clanName: "Source",
        weight: 135000,
        discordUserId: null,
        discordUsername: null,
        linkedName: null,
        isFiller: true,
      },
      {
        tag: "#EXTRA",
        name: "Extra",
        clanTag: null,
        clanName: null,
        weight: 155000,
        discordUserId: null,
        discordUsername: null,
        linkedName: null,
        isFiller: true,
      },
    ] as any);

    const plannerSpy = vi
      .spyOn(planner, "buildCompoFillPlan")
      .mockReturnValue(makePlannerResult() as any);

    const result = await new CompoFillService().readFill("guild-1", {
      userId: "user-1",
    });

    expect(plannerSpy).toHaveBeenCalledTimes(1);
    const plannerInput = plannerSpy.mock.calls[0]?.[0] as any;
    expect(plannerInput.trackedClans).toHaveLength(2);
    expect(plannerInput.trackedClans[0]).toMatchObject({
      clanTag: "#AAA111",
      clanName: "Alpha",
      shortName: "A",
      memberCount: 48,
      currentBucketCounts: expect.objectContaining({ TH15: 1, TH14: 47 }),
      targetBucketCounts: expect.objectContaining({ TH15: 2, TH14: 48 }),
    });
    expect(plannerInput.trackedClans[1]).toMatchObject({
      clanTag: "#BBB222",
      clanName: "Bravo",
      shortName: "B",
      memberCount: 49,
      currentBucketCounts: expect.objectContaining({ TH14: 49 }),
      targetBucketCounts: expect.objectContaining({ TH15: 2, TH14: 48 }),
    });
    expect(plannerInput.fillers).toHaveLength(3);
    expect(plannerInput.fillers[0]).toMatchObject({
      playerTag: "#P1",
      playerName: "Alice",
      resolvedWeight: 145000,
      currentClanTag: null,
      currentClanName: null,
    });
    expect(plannerInput.fillers[1]).toMatchObject({
      playerTag: "#P2",
      playerName: "Bob",
      resolvedWeight: 135000,
      currentClanTag: "#SRC",
      currentClanName: "Source",
    });
    expect(plannerInput.fillers[2]).toMatchObject({
      playerTag: "#EXTRA",
      playerName: "Extra",
      resolvedWeight: 155000,
    });

    expect(result.destinationClanCount).toBe(2);
    expect(result.plannedMoveCount).toBe(2);
    expect(result.availableFillerCount).toBe(3);
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.toJSON?.()).toMatchObject({
      type: 1,
      components: [
        expect.objectContaining({
          custom_id: "compo-refresh:fill:user-1",
          label: "Refresh Data",
          disabled: false,
        }),
      ],
    });

    const embed = getEmbedJSON(result.embeds[0]);
    const text = JSON.stringify(embed);
    expect(text).toContain("Clans under 50: 2 | Open slots: 1 | Available fillers: 3 | Recommended moves: 2");
    expect(text).toContain("Recommended Moves - A | Alpha (#AAA111) | 48/50 -> 50/50");
    expect(text).toContain("1. Alice (#P1) | 145,000 | TH15 | from outside tracked clans | matched TH15");
    expect(text).toContain("2. Bob (#P2) | 135,000 | TH14 | from Source (#SRC) | matched TH14");
    expect(text).toContain("Remaining Open Slots");
    expect(text).toContain("B | Bravo (#BBB222) | 1 open slot | 49/50");
    expect(text).toContain("Unused Available Fillers");
    expect(text).toContain("Extra (#EXTRA) | 155,000 | TH16 | from outside tracked clans");
    expect(text).toContain("Unavailable Fillers");
    expect(text).toContain("reason: source_member_count_below_target, source_bucket_deficit");
    expect(text).toContain("Excluded / Missing Weight");
    expect(text).toContain("reason: missing_weight");
  });

  it("refreshes tracked clans and filler current-state data before rerendering with a warning", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      trackedClanTags: ["#AAA111"],
      renderableClanTags: ["#AAA111"],
      latestSourceSyncedAt: null,
      heatMapRefs: [
        {
          weightMinInclusive: 100000,
          weightMaxInclusive: 200000,
          th18Count: 0,
          th17Count: 0,
          th16Count: 0,
          th15Count: 2,
          th14Count: 48,
          th13Count: 0,
          th12Count: 0,
          th11Count: 0,
          th10OrLowerCount: 0,
        },
      ],
      clans: [
        {
          clanTag: "#AAA111",
          clanName: "Alpha",
          shortName: "A",
          base: {
            resolvedTotalWeight: 123456,
            unresolvedWeightCount: 0,
            deferredWeightCount: 0,
            memberCount: 48,
            bucketCounts: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 1,
              TH14: 47,
              TH13: 0,
              TH12: 0,
              TH11: 0,
              TH10: 0,
              TH9: 0,
              TH8_OR_LOWER: 0,
            },
          },
          members: [],
        },
      ],
    } as any);
    vi.spyOn(fillerAccountService, "listFillerAccountsForGuild").mockResolvedValue([
      {
        tag: "#P1",
        name: "Alice",
        clanTag: null,
        clanName: null,
        weight: 145000,
        discordUserId: null,
        discordUsername: null,
        linkedName: null,
        isFiller: true,
      },
      {
        tag: "#P2",
        name: "Bob",
        clanTag: "#SRC",
        clanName: "Source",
        weight: 135000,
        discordUserId: null,
        discordUsername: null,
        linkedName: null,
        isFiller: true,
      },
    ] as any);
    const clanRefreshSpy = vi
      .spyOn(FwaClanMembersSyncService.prototype, "refreshCurrentClanMembersForClanTags")
      .mockResolvedValue({
        clanCount: 1,
        rowCount: 50,
        changedRowCount: 1,
        failedClans: ["#AAA111"],
      });
    const playerRefreshSpy = vi
      .spyOn(playerCurrentService, "refreshCurrentPlayersFromLiveTags")
      .mockResolvedValue({
        playerCount: 2,
        successCount: 1,
        failedPlayerTags: ["#P2"],
      });
    const plannerSpy = vi
      .spyOn(planner, "buildCompoFillPlan")
      .mockReturnValue(makePlannerResult() as any);

    const result = await new CompoFillService().refreshFill("guild-1", {
      userId: "user-1",
      cocService: {
        getClan: vi.fn(),
        getPlayerRaw: vi.fn(),
      } as any,
    });

    expect(clanRefreshSpy).toHaveBeenCalledWith(["#AAA111"], expect.any(Object));
    expect(playerRefreshSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        playerTags: ["#P1", "#P2"],
        cocService: expect.any(Object),
      }),
    );
    expect(plannerSpy).toHaveBeenCalledTimes(1);
    expect(result.warningText).toBe(
      "Refresh warning: 1 tracked clan and 1 filler failed to update.",
    );
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.toJSON?.()).toMatchObject({
      type: 1,
      components: [
        expect.objectContaining({
          custom_id: "compo-refresh:fill:user-1",
          disabled: false,
        }),
      ],
    });

    const fillLogs = consoleLogSpy.mock.calls.map((entry) => String(entry[0] ?? ""));
    expect(fillLogs.some((line) => line.includes("stage=load_context_start"))).toBe(true);
    expect(
      fillLogs.some(
        (line) =>
          line.includes("stage=load_context_complete") &&
          line.includes("trackedClanTags=1") &&
          line.includes("contextClans=1") &&
          line.includes("heatMapRefs=1") &&
          line.includes("duration_ms="),
      ),
    ).toBe(true);
    expect(
      fillLogs.some(
        (line) =>
          line.includes("stage=list_fillers_complete") &&
          line.includes("fillerRows=2") &&
          line.includes("duration_ms="),
      ),
    ).toBe(true);
    expect(
      fillLogs.some(
        (line) =>
          line.includes("stage=build_plan_complete") &&
          line.includes("destinationPlans=2") &&
          line.includes("plannedMoveCount=2") &&
          line.includes("duration_ms="),
      ),
    ).toBe(true);
    expect(
      fillLogs.some(
        (line) =>
          line.includes("stage=build_render_complete") &&
          line.includes("embedCount=1") &&
          line.includes("duration_ms="),
      ),
    ).toBe(true);
  });

  it("paginates safely when the planned output is large", async () => {
    vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      trackedClanTags: Array.from({ length: 18 }, (_value, index) => `#CLAN${index}`),
      renderableClanTags: [],
      latestSourceSyncedAt: null,
      heatMapRefs: [
        {
          weightMinInclusive: 100000,
          weightMaxInclusive: 200000,
          th18Count: 0,
          th17Count: 0,
          th16Count: 0,
          th15Count: 0,
          th14Count: 50,
          th13Count: 0,
          th12Count: 0,
          th11Count: 0,
          th10OrLowerCount: 0,
        },
      ],
      clans: Array.from({ length: 18 }, (_value, index) => ({
        clanTag: `#CLAN${index}`,
        clanName: `Clan ${index}`,
        shortName: `C${index}`,
        base: {
          resolvedTotalWeight: 120000 + index,
          unresolvedWeightCount: 0,
          deferredWeightCount: 0,
          memberCount: 49,
          bucketCounts: {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 0,
            TH14: 49,
            TH13: 0,
            TH12: 0,
            TH11: 0,
            TH10: 0,
            TH9: 0,
            TH8_OR_LOWER: 0,
          },
        },
        members: [],
      })),
    } as any);
    vi.spyOn(fillerAccountService, "listFillerAccountsForGuild").mockResolvedValue([] as any);

    const bigResult = makePlannerResult();
    bigResult.destinationPlans = Array.from({ length: 18 }, (_value, index) =>
      makeTrackedClanPlan({
        clanTag: `#CLAN${index}`,
        clanName: `Clan ${index}`,
        shortName: `C${index}`,
        initialMemberCount: 49,
        targetMemberCount: 50,
        remainingSlots: 0,
        plannedMoves: Array.from({ length: 2 }, (_move, moveIndex) => ({
          sequence: index * 2 + moveIndex + 1,
          matchedBucket: "TH14",
          filler: {
            playerTag: `#P${index}_${moveIndex}`,
            playerName: `Player ${index}-${moveIndex}`,
            resolvedWeight: 135000 + moveIndex,
            resolvedWeightBucket: "TH14",
            currentClanTag: null,
            currentClanName: null,
            sourceClanTag: null,
            sourceClanName: null,
            sourceKind: "untracked",
          },
          destinationClanTag: `#CLAN${index}`,
          destinationClanName: `Clan ${index}`,
          destinationShortName: `C${index}`,
          destinationMemberCountBefore: 49,
          destinationMemberCountAfter: 50,
          destinationBucketCountsBefore: {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 0,
            TH14: 49,
            TH13: 0,
            TH12: 0,
            TH11: 0,
            TH10: 0,
            TH9: 0,
            TH8_OR_LOWER: 0,
          },
          destinationBucketCountsAfter: {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 0,
            TH14: 50,
            TH13: 0,
            TH12: 0,
            TH11: 0,
            TH10: 0,
            TH9: 0,
            TH8_OR_LOWER: 0,
          },
          sourceClanTag: null,
          sourceClanName: null,
          sourceMemberCountBefore: null,
          sourceMemberCountAfter: null,
          sourceBucketCountsBefore: null,
          sourceBucketCountsAfter: null,
        })),
        initialBucketCounts: {
          TH18: 0,
          TH17: 0,
          TH16: 0,
          TH15: 0,
          TH14: 49,
          TH13: 0,
          TH12: 0,
          TH11: 0,
          TH10: 0,
          TH9: 0,
          TH8_OR_LOWER: 0,
        },
        targetBucketCounts: {
          TH18: 0,
          TH17: 0,
          TH16: 0,
          TH15: 0,
          TH14: 49,
          TH13: 1,
          TH12: 0,
          TH11: 0,
          TH10: 0,
          TH9: 0,
          TH8_OR_LOWER: 0,
        },
      }),
    );
    bigResult.unusedAvailableFillers = Array.from({ length: 30 }, (_value, index) => ({
      playerTag: `#U${index}`,
      playerName: `Unused ${index}`,
      resolvedWeight: 155000,
      resolvedWeightBucket: "TH16",
      currentClanTag: null,
      currentClanName: null,
      sourceClanTag: null,
      sourceClanName: null,
      sourceKind: "untracked",
    }));
    bigResult.unavailableFillers = [];
    bigResult.excludedFillers = [];
    bigResult.remainingUnfilledClanSlots = [];
    vi.spyOn(planner, "buildCompoFillPlan").mockReturnValue(bigResult as any);

    const result = await new CompoFillService().readFill("guild-1");
    expect(result.embeds.length).toBeGreaterThan(1);
    expect(result.embeds.length).toBeLessThanOrEqual(10);
    expect(
      result.embeds.every((embed) => (getEmbedJSON(embed).fields ?? []).length <= 25),
    ).toBe(true);
  });
});
