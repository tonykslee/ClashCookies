import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

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
    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapTrackedMessageForClan",
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
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
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
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockImplementation(
      async ({ clanTag }) => {
        if (clanTag !== "#PYPY") return null;
        return {
          id: "tracked-1",
          guildId: "guild-1",
          channelId: "channel-1",
          messageId: "message-1",
          referenceId: "ref-1",
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
              {
                position: 35,
                playerTag: "#CCC",
                playerName: "Ignored",
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
    expect(state.rows[0].detailLines).toEqual([
      "  War bases:",
      "    - #12 PlayerOne",
      "  Base errors:",
      "    - #23 PlayerTwo",
    ]);
    expect(state.rows[1].compactCopyLine).toContain("Bravo |");
    expect(state.rows[1].compactCopyLine).toContain("❌ Bases not checked");
    expect(state.expiresAt?.toISOString()).toBe("2026-05-13T22:00:00.000Z");
    expect(getCurrentWar).not.toHaveBeenCalled();
  });
});
