import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  trackedMessage: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CoCService", () => ({
  CoCService: vi.fn().mockImplementation(() => ({})),
}));

import { trackedMessageService } from "../src/services/TrackedMessageService";
import { WarMailLifecycleService } from "../src/services/WarMailLifecycleService";
import { buildFwaMatchChecklistRenderStateForGuild } from "../src/services/FwaMatchChecklistStateService";

describe("FwaMatchChecklistStateService checklist expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
      { tag: "#PYPL", clanBadge: "<:twc:222>", name: "Bravo", shortName: "B" },
    ]);
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
      },
      {
        clanTag: "#PYPL",
        warId: 2,
        startTime: new Date("2026-05-13T22:00:00.000Z"),
        opponentTag: "#OPP2",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
      },
    ]);
    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue(null);
    vi.spyOn(trackedMessageService, "resolveLatestRelevantSyncPostForClanWar").mockResolvedValue(
      null as any,
    );
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue(
      null as any,
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestFwaMatchChecklistBasesCompletionForClan",
    ).mockResolvedValue(null as any);
    vi.spyOn(WarMailLifecycleService.prototype, "resolveStatusForCurrentWar").mockResolvedValue({
      status: "posted",
      mailStatusEmoji: "📬",
      debug: {
        currentWarId: null,
        trackedMailWarId: null,
        trackedChannelId: null,
        trackedMessageId: null,
        trackedMessageExists: "unknown",
        currentWarConfigMatchesTrackedMessage: false,
        winningSource: "none",
        finalNormalizedStatus: "posted",
        reconciliationOutcome: "not_checked",
        reconciliationCertainty: "not_checked",
        debugReasonCode: "no_post_tracked",
        debugReason: "No POSTED lifecycle row exists for the active war.",
        environmentMismatchSignal: false,
        trackingCleared: false,
      },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the latest current-war start time as the checklist expiry", async () => {
    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
    });

    expect(state.expiresAt?.toISOString()).toBe("2026-05-13T22:00:00.000Z");
  });

  it("renders a preserved ended FWA outcome for a notInWar current-war row", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "FWA",
        inferredMatchType: true,
        outcome: "WIN",
        state: "notInWar",
      },
    ]);

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
    });

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].compactCopyLine).toContain("\u{1F7E2}");
    expect(state.rows[0].compactCopyLine).not.toContain("\u{1F534}");
  });

  it("falls back to the existing 30-minute expiry when war timing is unavailable", async () => {
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        startTime: null,
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
      },
    ]);
    const before = Date.now();
    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
    });

    expect(state.expiresAt).toBeInstanceOf(Date);
    expect(state.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
  });

  it("renders a bases checklist from current-war and tracked base-swap metadata", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
      { tag: "#PYPL", clanBadge: "<:twc:222>", name: "Bravo", shortName: null },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
      },
      {
        clanTag: "#PYPL",
        warId: 2,
        startTime: new Date("2026-05-13T22:00:00.000Z"),
        opponentTag: "#OPP2",
        matchType: "FWA",
        inferredMatchType: null,
        outcome: "WIN",
      },
    ]);
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValue({
      id: "sync-tracked-2",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-2",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-05-13T16:55:00.000Z"),
      expiresAt: null,
      metadata: {} as any,
    } as any);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockImplementation(
      async ({ clanTag, syncMessageId }) => {
        if (clanTag !== "#PYPY") return null;
        if (syncMessageId !== "sync-message-2") return null;
        return {
          id: "tracked-1",
          guildId: "guild-1",
          channelId: "channel-1",
          messageId: "message-1",
          referenceId: "fwa-base-swap:split-1",
          clanTag: "#PYPY",
          createdAt: new Date("2026-05-13T17:00:00.000Z"),
          expiresAt: null,
          metadata: {
            clanName: "Alpha",
            createdByUserId: "user-1",
            createdAtIso: "2026-05-13T17:00:00.000Z",
            syncMessageId: "sync-message-2",
            clanRoleId: null,
            swapReminder: true,
            entries: [
              {
                position: 12,
                playerTag: "#AAA",
                playerName: "PlayerOne",
                discordUserId: "111",
                townhallLevel: 15,
                section: "war_bases",
                acknowledged: false,
              },
              {
                position: 23,
                playerTag: "#BBB",
                playerName: "PlayerTwo",
                discordUserId: "222",
                townhallLevel: 14,
                section: "base_errors",
                acknowledged: false,
              },
            ],
          } as any,
        } as any;
      },
    );
    vi.mocked(
      trackedMessageService.findLatestFwaMatchChecklistBasesCompletionForClan,
    ).mockImplementation(async ({ clanTag, warId, syncMessageId }) => {
      if (clanTag !== "#PYPL") return null;
      if (String(warId ?? "") !== "2") return null;
      if (syncMessageId !== "sync-message-2") return null;
      return {
        id: "completion-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId:
          "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPL|war=2|opponent=OPP2|start=2026-05-13T22:00:00.000Z|sync=sync-message-2",
        referenceId: "sync-message-2",
        clanTag: "#PYPL",
        createdAt: new Date("2026-05-13T21:59:00.000Z"),
        expiresAt: null,
        metadata: {
          kind: "bases_completion",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T21:58:00.000Z",
          syncMessageId: "sync-message-2",
          syncReferenceId: null,
          clanTag: "PYPL",
          clanName: "Bravo",
          checked: true,
          warId: "2",
          opponentTag: "OPP2",
          warStartTimeIso: "2026-05-13T22:00:00.000Z",
        },
      } as any;
    });

    const getCurrentWar = vi.fn().mockResolvedValue(null);
    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
    });

    expect(state.viewType).toBe("Bases");
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0].compactCopyLine).toContain("A |");
    expect(state.rows[0].compactCopyLine).toContain("⚠️ Bases checked - issues found");
    expect(state.rows[0].compactCopyLine).toContain("[base-swap post](");
    expect(state.rows[0].detailLines).toBeNull();
    expect(state.rows[1].compactCopyLine).toContain("Bravo |");
    expect(state.rows[1].compactCopyLine).toContain("✅ Bases checked and all good");
    expect(trackedMessageService.findLatestFwaMatchChecklistBasesCompletionForClan).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#PYPL",
        warId: 2,
        warStartTime: new Date("2026-05-13T22:00:00.000Z"),
        opponentTag: "#OPP2",
        syncMessageId: "sync-message-2",
      }),
    );
    expect(state.referenceId).toBe("sync-message-2");
    expect(state.expiresAt?.toISOString()).toBe("2026-05-13T22:00:00.000Z");
    expect(getCurrentWar).not.toHaveBeenCalled();
  });

  it("renders a bases checklist from an expired sync post fallback when the active sync post is missing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
        state: "preparation",
      },
    ]);
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValueOnce(null);
    vi.mocked(trackedMessageService.resolveLatestRelevantSyncPostForClanWar).mockResolvedValueOnce(
      "sync-message-expired",
    );
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockImplementation(
      async ({ clanTag, syncMessageId }) => {
        if (clanTag !== "#PYPY") return null;
        if (syncMessageId !== "sync-message-expired") return null;
        return {
          id: "tracked-expired-1",
          guildId: "guild-1",
          channelId: "channel-1",
          messageId: "message-expired-1",
          referenceId: "fwa-base-swap:split-expired-1",
          clanTag: "#PYPY",
          createdAt: new Date("2026-05-13T17:00:00.000Z"),
          expiresAt: null,
          metadata: {
            clanName: "Alpha",
            createdByUserId: "user-1",
            createdAtIso: "2026-05-13T17:00:00.000Z",
            syncMessageId: "sync-message-expired",
            clanRoleId: null,
            swapReminder: true,
            entries: [
              {
                position: 12,
                playerTag: "#AAA",
                playerName: "PlayerOne",
                discordUserId: "111",
                townhallLevel: 15,
                section: "war_bases",
                acknowledged: false,
              },
            ],
          } as any,
        } as any;
      },
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
    });

    expect(state.referenceId).toBe("sync-message-expired");
    expect(state.rows[0].compactCopyLine).not.toContain("âŒ Bases not checked");
    expect(trackedMessageService.resolveLatestRelevantSyncPostForClanWar).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#PYPY",
        warStartTime: new Date("2026-05-13T18:00:00.000Z"),
      }),
    );
    expect(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#PYPY",
        syncMessageId: "sync-message-expired",
      }),
    );
  });

  it("keeps MM clans visible in the bases checklist", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "MM",
        inferredMatchType: null,
        outcome: null,
      },
    ]);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockResolvedValue(
      null as any,
    );
    vi.mocked(
      trackedMessageService.findLatestFwaMatchChecklistBasesCompletionForClan,
    ).mockResolvedValue(null as any);

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
    });

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].compactCopyLine).toContain("A |");
    expect(state.rows[0].compactCopyLine).toContain("❌ Bases not checked");
    expect(state.rows[0].detailLines).toBeNull();
  });

  it("treats fwa bases as a checklist issue for BL matches", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
      },
    ]);
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValue({
      id: "sync-tracked-2",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-2",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-05-13T16:55:00.000Z"),
      expiresAt: null,
      metadata: {} as any,
    } as any);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockResolvedValue({
      id: "tracked-bl",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-bl",
      referenceId: "fwa-base-swap:split-2",
      clanTag: "#PYPY",
      createdAt: new Date("2026-05-13T17:00:00.000Z"),
      expiresAt: null,
      metadata: {
        clanName: "Alpha",
        createdByUserId: "user-1",
        createdAtIso: "2026-05-13T17:00:00.000Z",
        syncMessageId: "sync-message-2",
        clanRoleId: null,
        swapReminder: true,
        entries: [
          {
            position: 35,
            playerTag: "#CCC",
            playerName: "OnlyFwa",
            discordUserId: "333",
            townhallLevel: 13,
            section: "fwa_bases",
            acknowledged: false,
          },
        ],
      } as any,
    } as any);

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
    });

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].compactCopyLine).toContain("⚠️ Bases checked - issues found");
    expect(state.rows[0].compactCopyLine).toContain("[base-swap post](");
    expect(state.rows[0].detailLines).toBeNull();
  });

  it("does not treat fwa bases as an issue for FWA matches", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "FWA",
        inferredMatchType: null,
        outcome: null,
      },
    ]);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockResolvedValue({
      id: "tracked-fwa",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-fwa",
      referenceId: "ref-fwa",
      clanTag: "#PYPY",
      createdAt: new Date("2026-05-13T17:00:00.000Z"),
      expiresAt: null,
      metadata: {
        clanName: "Alpha",
        createdByUserId: "user-1",
        createdAtIso: "2026-05-13T17:00:00.000Z",
        clanRoleId: null,
        swapReminder: true,
        entries: [
          {
            position: 35,
            playerTag: "#CCC",
            playerName: "OnlyFwa",
            discordUserId: "333",
            townhallLevel: 13,
            section: "fwa_bases",
            acknowledged: false,
          },
        ],
      } as any,
    } as any);

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
    });

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].compactCopyLine).toContain("❌ Bases not checked");
    expect(state.rows[0].compactCopyLine).not.toContain("[base-swap post](");
    expect(state.rows[0].detailLines).toBeNull();
  });

  it("does not carry bases issues into a different sync identity", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
      },
    ]);
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValue({
      id: "sync-tracked-4",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-4",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-05-13T21:55:00.000Z"),
      expiresAt: null,
      metadata: {} as any,
    } as any);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockImplementation(
      async ({ clanTag, syncMessageId }) => {
        if (clanTag !== "#PYPY") return null;
        if (syncMessageId !== "sync-message-2") return null;
        return {
          id: "tracked-stale",
          guildId: "guild-1",
          channelId: "channel-1",
          messageId: "message-stale",
          referenceId: "fwa-base-swap:split-stale",
          clanTag: "#PYPY",
          createdAt: new Date("2026-05-13T17:00:00.000Z"),
          expiresAt: null,
          metadata: {
            clanName: "Alpha",
            createdByUserId: "user-1",
            createdAtIso: "2026-05-13T17:00:00.000Z",
            syncMessageId: "sync-message-2",
            clanRoleId: null,
            swapReminder: true,
            entries: [
              {
                position: 35,
                playerTag: "#CCC",
                playerName: "OnlyFwa",
                discordUserId: "333",
                townhallLevel: 13,
                section: "fwa_bases",
                acknowledged: false,
              },
            ],
          } as any,
        } as any;
      },
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
    });

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].compactCopyLine).toContain("❌ Bases not checked");
    expect(state.rows[0].compactCopyLine).not.toContain("[base-swap post](");
    expect(state.rows[0].detailLines).toBeNull();
  });

  it("does not carry bases completion into a different sync identity", async () => {
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPL",
        warId: 2,
        startTime: new Date("2026-05-13T22:00:00.000Z"),
        opponentTag: "#OPP2",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
      },
    ]);
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValue({
      id: "sync-tracked-3",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-3",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-05-13T21:55:00.000Z"),
      expiresAt: null,
      metadata: {} as any,
    } as any);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockResolvedValue(
      null as any,
    );
    vi.mocked(
      trackedMessageService.findLatestFwaMatchChecklistBasesCompletionForClan,
    ).mockImplementation(async ({ clanTag, warId, opponentTag, syncMessageId }) => {
      if (
        clanTag === "#PYPL" &&
        String(warId ?? "") === "2" &&
        opponentTag === "#OPP2" &&
        syncMessageId === "sync-message-2"
      ) {
        return {
          id: "completion-old",
          guildId: "guild-1",
          channelId: "channel-1",
          messageId:
            "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPL|war=2|opponent=OPP2|start=2026-05-13T22:00:00.000Z|sync=sync-message-2",
          referenceId: "sync-message-2",
          clanTag: "#PYPL",
          createdAt: new Date("2026-05-13T21:59:00.000Z"),
          expiresAt: null,
          metadata: {
            kind: "bases_completion",
            createdByUserId: "user-1",
            createdAtIso: "2026-05-13T21:58:00.000Z",
            syncMessageId: "sync-message-2",
            syncReferenceId: null,
            clanTag: "PYPL",
            clanName: "Bravo",
            checked: true,
            warId: "2",
            opponentTag: "OPP2",
            warStartTimeIso: "2026-05-13T22:00:00.000Z",
          },
        } as any;
      }
      return null;
    });

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
    });

    expect(state.rows[0].compactCopyLine).toContain("❌ Bases not checked");
  });
});
