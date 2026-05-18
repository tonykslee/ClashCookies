import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  CompoFillService,
  buildInGameClanProfileUrlForTest,
  buildInGamePlayerProfileUrlForTest,
  estimateFillEmbedTextLengthForTest,
  formatDiscordMarkdownLinkForTest,
  formatShortWeightForTest,
  normalizeLinkTagForTest,
} from "../src/services/CompoFillService";
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

function makePagedPlannerResult(): any {
  return {
    destinationPlans: Array.from({ length: 11 }, (_value, clanIndex) =>
      makeTrackedClanPlan({
        clanTag: `#CLAN${clanIndex}`,
        clanName: `Clan ${clanIndex}`,
        shortName: `C${clanIndex}`,
        initialMemberCount: 44,
        targetMemberCount: 50,
        remainingSlots: 6,
        initialBucketCounts: {
          TH18: 0,
          TH17: 0,
          TH16: 0,
          TH15: 0,
          TH14: 44,
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
          TH14: 50,
          TH13: 0,
          TH12: 0,
          TH11: 0,
          TH10: 0,
          TH9: 0,
          TH8_OR_LOWER: 0,
        },
        plannedMoves: Array.from({ length: 6 }, (_moveValue, moveIndex) => {
          const memberCountBefore = 44 + moveIndex;
          const memberCountAfter = memberCountBefore + 1;
          const bucketCountsBefore = {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 0,
            TH14: memberCountBefore,
            TH13: 0,
            TH12: 0,
            TH11: 0,
            TH10: 0,
            TH9: 0,
            TH8_OR_LOWER: 0,
          };
          const bucketCountsAfter = {
            ...bucketCountsBefore,
            TH14: memberCountAfter,
          };
          return {
            sequence: clanIndex * 6 + moveIndex + 1,
            matchedBucket: "TH14",
            filler: {
              playerTag: `#P${clanIndex}_${moveIndex}`,
              playerName: `Player ${clanIndex}-${moveIndex}`,
              resolvedWeight: 145000 - moveIndex,
              resolvedWeightBucket: "TH14",
              currentClanTag: null,
              currentClanName: null,
              sourceClanTag: null,
              sourceClanName: null,
              sourceKind: "untracked",
            },
            destinationClanTag: `#CLAN${clanIndex}`,
            destinationClanName: `Clan ${clanIndex}`,
            destinationShortName: `C${clanIndex}`,
            destinationMemberCountBefore: memberCountBefore,
            destinationMemberCountAfter: memberCountAfter,
            destinationBucketCountsBefore: bucketCountsBefore,
            destinationBucketCountsAfter: bucketCountsAfter,
            sourceClanTag: null,
            sourceClanName: null,
            sourceMemberCountBefore: null,
            sourceMemberCountAfter: null,
            sourceBucketCountsBefore: null,
            sourceBucketCountsAfter: null,
          };
        }),
      }),
    ),
    unavailableFillers: [],
    excludedFillers: [],
    unusedAvailableFillers: [],
    remainingUnfilledClanSlots: [],
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
    expect(text).toContain(
      "Recommended Moves - [Alpha](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=AAA111>) `#AAA111` 48/50",
    );
    expect(text).toContain(
      "— | [Alice](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=P1>) (`#P1`) | 145k | ⚜️ outside tracked clans",
    );
    expect(text).toContain(
      "— | [Bob](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=P2>) (`#P2`) | 135k | ⚜️ [Source](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=SRC>)",
    );
    expect(text).toContain("Remaining Open Slots");
    expect(text).toContain(
      "[Bravo](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=BBB222>) `#BBB222` 49/50 | 1 open slot | 49/50",
    );
    expect(text).toContain("Filler Summary");
    expect(text).toContain("Unused Available Fillers: 1");
    expect(text).toContain("Unavailable Fillers: 1");
    expect(text).toContain("Excluded / Missing Weight: 1");
    expect(String(embed.footer?.text ?? "")).toBe("Page 1/1");
  });

  it("renders linked Discord mentions when stored and planned tags differ by leading #", async () => {
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
            memberCount: 49,
            bucketCounts: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 1,
              TH14: 48,
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
        discordUserId: "123456789",
        discordUsername: "alice",
        linkedName: null,
        isFiller: true,
      },
    ] as any);
    vi.spyOn(planner, "buildCompoFillPlan").mockReturnValue({
      destinationPlans: [
        makeTrackedClanPlan({
          clanTag: "#AAA111",
          clanName: "Alpha",
          shortName: "A",
          initialMemberCount: 49,
          targetMemberCount: 50,
          remainingSlots: 0,
          plannedMoves: [
            {
              sequence: 1,
              matchedBucket: "TH15",
              filler: {
                playerTag: "P1",
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
              destinationMemberCountBefore: 49,
              destinationMemberCountAfter: 50,
              destinationBucketCountsBefore: {
                TH18: 0,
                TH17: 0,
                TH16: 0,
                TH15: 1,
                TH14: 48,
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
              sourceClanTag: null,
              sourceClanName: null,
              sourceMemberCountBefore: null,
              sourceMemberCountAfter: null,
              sourceBucketCountsBefore: null,
              sourceBucketCountsAfter: null,
            },
          ],
          initialBucketCounts: {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 1,
            TH14: 48,
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
        }),
      ],
      unavailableFillers: [],
      excludedFillers: [],
      unusedAvailableFillers: [],
      remainingUnfilledClanSlots: [],
    } as any);

    const result = await new CompoFillService().readFill("guild-1", {
      userId: "user-1",
    });

    const embed = getEmbedJSON(result.embeds[0]);
    const text = JSON.stringify(embed);
    expect(text).toContain("<@123456789>");
    expect(text).toContain(
      "[Alice](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=P1>) (`#P1`)",
    );
  });

  it("builds profile URLs and compact display helpers", () => {
    expect(normalizeLinkTagForTest("#2C998J8LY")).toBe("2C998J8LY");
    expect(normalizeLinkTagForTest("  #ABC123  ")).toBe("ABC123");
    expect(buildInGamePlayerProfileUrlForTest("#TAG")).toBe(
      "https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=TAG",
    );
    expect(buildInGameClanProfileUrlForTest("#CLANTAG")).toBe(
      "https://link.clashofclans.com/en/?action=OpenClanProfile&tag=CLANTAG",
    );
    expect(formatDiscordMarkdownLinkForTest("Player Name", "https://example.com")).toBe(
      "[Player Name](<https://example.com>)",
    );
    expect(formatShortWeightForTest(156000)).toBe("156k");
    expect(formatShortWeightForTest(999)).toBe("999");
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

  it("keeps the total embed payload within budget for production-like large output", async () => {
    vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      trackedClanTags: Array.from({ length: 11 }, (_value, index) => `#CLAN${index}`),
      renderableClanTags: Array.from({ length: 11 }, (_value, index) => `#CLAN${index}`),
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
      clans: Array.from({ length: 11 }, (_value, index) => ({
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
    vi.spyOn(fillerAccountService, "listFillerAccountsForGuild").mockResolvedValue(
      Array.from({ length: 91 }, (_value, index) => ({
        tag: `#F${index}`,
        name: `Filler ${index}`,
        clanTag: index % 3 === 0 ? null : "#SRC",
        clanName: index % 3 === 0 ? null : "Source",
        weight: 145000 + index,
        discordUserId: null,
        discordUsername: null,
        linkedName: null,
        isFiller: true,
      })) as any,
    );

    const bigResult = makePlannerResult();
    bigResult.destinationPlans = [
      makeTrackedClanPlan({
        clanTag: "#CLAN0",
        clanName: "Clan 0",
        shortName: "C0",
        initialMemberCount: 49,
        targetMemberCount: 50,
        remainingSlots: 0,
        plannedMoves: [
          {
            sequence: 1,
            matchedBucket: "TH14",
            filler: {
              playerTag: "#F0",
              playerName: "Filler 0",
              resolvedWeight: 145000,
              resolvedWeightBucket: "TH14",
              currentClanTag: null,
              currentClanName: null,
              sourceClanTag: null,
              sourceClanName: null,
              sourceKind: "untracked",
            },
            destinationClanTag: "#CLAN0",
            destinationClanName: "Clan 0",
            destinationShortName: "C0",
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
          },
        ],
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
    ];
    bigResult.unusedAvailableFillers = Array.from({ length: 40 }, (_value, index) => ({
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
    bigResult.unavailableFillers = Array.from({ length: 30 }, (_value, index) => ({
      playerTag: `#B${index}`,
      playerName: `Blocked ${index}`,
      resolvedWeight: 145000,
      resolvedWeightBucket: "TH15",
      currentClanTag: "#SRC",
      currentClanName: "Source",
      sourceClanTag: "#SRC",
      sourceClanName: "Source",
      reasonCodes: ["source_member_count_below_target", "source_bucket_deficit"],
    }));
    bigResult.excludedFillers = Array.from({ length: 20 }, (_value, index) => ({
      playerTag: `#M${index}`,
      playerName: `Missing ${index}`,
      resolvedWeight: null,
      resolvedWeightBucket: null,
      currentClanTag: null,
      currentClanName: null,
      reasonCodes: ["missing_weight"],
    }));
    bigResult.remainingUnfilledClanSlots = [
      {
        clanTag: "#CLAN1",
        clanName: "Clan 1",
        shortName: "C1",
        remainingSlots: 1,
        currentMemberCount: 49,
        targetMemberCount: 50,
      },
    ];
    vi.spyOn(planner, "buildCompoFillPlan").mockReturnValue(bigResult as any);

    const result = await new CompoFillService().readFill("guild-1", {
      userId: "user-1",
    });
    expect(result.embeds).toHaveLength(1);
    const embed = getEmbedJSON(result.embeds[0]);
    const totalEmbedTextLength = estimateFillEmbedTextLengthForTest(embed);
    expect(totalEmbedTextLength).toBeLessThanOrEqual(5500);
    expect(String(embed.title ?? "")).toBe("Compo Fill Planner");
    expect(String(embed.description ?? "")).toContain("Clans under 50: 1");
    expect(String(embed.description ?? "")).toContain("Recommended moves: 1");
    expect(String(embed.footer?.text ?? "")).toBe("Page 1/1");
    const text = JSON.stringify(embed);
    expect(text).toContain(
      "Recommended Moves - [Clan 0](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=CLAN0>) `#CLAN0` 49/50",
    );
    expect(text).toContain("Remaining Open Slots");
    expect(text).toContain("Filler Summary");
    expect(text).toContain("Unused Available Fillers: 40");
    expect(text).toContain("Unavailable Fillers: 30");
    expect(text).toContain("Excluded / Missing Weight: 20");
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.toJSON?.()).toMatchObject({
      type: 1,
      components: [
        expect.objectContaining({
          label: "Refresh Data",
          custom_id: "compo-refresh:fill:user-1",
        }),
      ],
    });
  });

  it("paginates large recommended-move output and keeps each page within budget", async () => {
    vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      trackedClanTags: Array.from({ length: 11 }, (_value, index) => `#CLAN${index}`),
      renderableClanTags: Array.from({ length: 11 }, (_value, index) => `#CLAN${index}`),
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
      clans: Array.from({ length: 11 }, (_value, index) => ({
        clanTag: `#CLAN${index}`,
        clanName: `Clan ${index}`,
        shortName: `C${index}`,
        base: {
          resolvedTotalWeight: 120000 + index,
          unresolvedWeightCount: 0,
          deferredWeightCount: 0,
          memberCount: 44,
          bucketCounts: {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 0,
            TH14: 44,
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
    vi.spyOn(fillerAccountService, "listFillerAccountsForGuild").mockResolvedValue(
      Array.from({ length: 91 }, (_value, index) => ({
        tag: `#F${index}`,
        name: `Filler ${index}`,
        clanTag: index % 3 === 0 ? null : "#SRC",
        clanName: index % 3 === 0 ? null : "Source",
        weight: 145000 + index,
        discordUserId: index % 10 === 0 ? `discord-${index}` : null,
        discordUsername: null,
        linkedName: null,
        isFiller: true,
      })) as any,
    );
    vi.spyOn(planner, "buildCompoFillPlan").mockReturnValue(
      makePagedPlannerResult() as any,
    );

    const firstPage = await new CompoFillService().readFill("guild-1", {
      userId: "user-1",
      pageIndex: 0,
    });
    const secondPage = await new CompoFillService().readFill("guild-1", {
      userId: "user-1",
      pageIndex: 1,
    });
    const clampedFirstPage = await new CompoFillService().readFill("guild-1", {
      userId: "user-1",
      pageIndex: -5,
    });

    expect(firstPage.embeds).toHaveLength(1);
    expect(secondPage.embeds).toHaveLength(1);

    const firstEmbed = getEmbedJSON(firstPage.embeds[0]);
    const secondEmbed = getEmbedJSON(secondPage.embeds[0]);
    const footerMatch = String(firstEmbed.footer?.text ?? "").match(/^Page 1\/(\d+)$/);
    const totalPages = Number(footerMatch?.[1] ?? 0);
    const clampedLastPage = await new CompoFillService().readFill("guild-1", {
      userId: "user-1",
      pageIndex: 999,
    });
    expect(totalPages).toBeGreaterThan(1);
    expect(estimateFillEmbedTextLengthForTest(firstEmbed)).toBeLessThanOrEqual(5500);
    expect(estimateFillEmbedTextLengthForTest(secondEmbed)).toBeLessThanOrEqual(5500);
    expect(
      String(getEmbedJSON(clampedFirstPage.embeds[0]).footer?.text ?? ""),
    ).toMatch(/^Page 1\/\d+$/);
    expect(String(getEmbedJSON(clampedLastPage.embeds[0]).footer?.text ?? "")).toBe(
      `Page ${totalPages}/${totalPages}`,
    );
    expect(String(firstEmbed.footer?.text ?? "")).toMatch(/^Page 1\/\d+$/);
    expect(String(secondEmbed.footer?.text ?? "")).toMatch(/^Page 2\/\d+$/);
    expect(JSON.stringify(firstEmbed)).not.toBe(JSON.stringify(secondEmbed));

    expect(firstPage.components).toHaveLength(1);
    const firstButtons = firstPage.components[0]?.toJSON?.().components as Array<{
      label?: string;
      custom_id?: string;
      disabled?: boolean;
    }>;
    expect(firstButtons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Prev",
          custom_id: "compo-fill-page:user-1:0",
          disabled: true,
        }),
        expect.objectContaining({
          label: "Next",
          custom_id: "compo-fill-page:user-1:1",
        }),
        expect.objectContaining({
          label: "Refresh Data",
          custom_id: "compo-refresh:fill:user-1",
        }),
      ]),
    );

    const secondButtons = secondPage.components[0]?.toJSON?.().components as Array<{
      label?: string;
      custom_id?: string;
      disabled?: boolean;
    }>;
    expect(secondButtons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Prev",
          custom_id: "compo-fill-page:user-1:0",
        }),
        expect.objectContaining({
          label: "Next",
          custom_id: expect.stringMatching(/^compo-fill-page:user-1:\d+$/),
        }),
        expect.objectContaining({
          label: "Refresh Data",
          custom_id: "compo-refresh:fill:user-1",
        }),
      ]),
    );
  });
});
