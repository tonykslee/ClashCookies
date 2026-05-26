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
});
