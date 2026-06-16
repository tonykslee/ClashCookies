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
import { buildFwaMatchBasesMessageContent } from "../src/services/FwaMatchChecklistService";
import { buildFwaMatchChecklistRenderStateForGuild } from "../src/services/FwaMatchChecklistStateService";

function makeBaseSwapTrackedMessageRow(params: {
  messageId: string;
  createdAtIso: string;
  syncMessageId?: string | null;
  status?: "ACTIVE" | "COMPLETED";
  entries: Array<{
    position: number;
    playerTag: string;
    playerName: string;
    discordUserId: string | null;
    townhallLevel: number | null;
    section: "war_bases" | "base_errors" | "fwa_bases";
    acknowledged: boolean;
  }>;
}) {
  return {
    id: `${params.messageId}-tracked`,
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: params.messageId,
    referenceId: "fwa-base-swap:split-1",
    clanTag: "#PYPY",
    createdAt: new Date(params.createdAtIso),
    expiresAt: new Date("2026-06-13T19:00:00.000Z"),
    status: params.status ?? "ACTIVE",
    metadata: {
      clanKind: "FWA",
      clanName: "Alpha",
      createdByUserId: "user-1",
      createdAtIso: params.createdAtIso,
      syncMessageId: params.syncMessageId ?? undefined,
      clanRoleId: null,
      swapReminder: false,
      renderVariant: "single",
      phaseTimingLine: null,
      alertEmoji: null,
      fwaAlertEmoji: null,
      layoutBulletEmoji: null,
      entries: params.entries,
      layoutLinks: [],
    },
  } as any;
}

function makeCurrentWarRow(params: {
  clanTag: string;
  warId: number;
  startTimeIso: string;
  prepStartTimeIso?: string | null;
  endTimeIso?: string | null;
  opponentTag: string;
  state?: string | null;
  matchType?: string | null;
  inferredMatchType?: boolean | null;
  outcome?: string | null;
}) {
  return {
    clanTag: params.clanTag,
    warId: params.warId,
    prepStartTime: params.prepStartTimeIso ? new Date(params.prepStartTimeIso) : null,
    startTime: new Date(params.startTimeIso),
    endTime: params.endTimeIso ? new Date(params.endTimeIso) : null,
    opponentTag: params.opponentTag,
    matchType: params.matchType ?? "FWA",
    inferredMatchType: params.inferredMatchType ?? null,
    outcome: params.outcome ?? null,
    state: params.state ?? "preparation",
  } as any;
}

function toClashApiTime(input: string): string {
  const date = new Date(input);
  const pad = (value: number, size: number) => String(value).padStart(size, "0");
  return [
    pad(date.getUTCFullYear(), 4),
    pad(date.getUTCMonth() + 1, 2),
    pad(date.getUTCDate(), 2),
    "T",
    pad(date.getUTCHours(), 2),
    pad(date.getUTCMinutes(), 2),
    pad(date.getUTCSeconds(), 2),
    ".000Z",
  ].join("");
}

function makeLiveWarSnapshot(params: {
  startTimeIso: string;
  opponentTag: string;
  state?: string | null;
  opponentName?: string | null;
}) {
  return {
    startTime: toClashApiTime(params.startTimeIso),
    opponent: {
      tag: params.opponentTag,
      name: params.opponentName ?? "Opponent",
    },
    state: params.state ?? "preparation",
  } as any;
}

describe("FwaMatchChecklistStateService checklist expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-13T16:00:00.000Z"));
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
        state: "preparation",
      },
      {
        clanTag: "#PYPL",
        warId: 2,
        startTime: new Date("2026-05-13T22:00:00.000Z"),
        opponentTag: "#OPP2",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
        state: "preparation",
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
    vi.useRealTimers();
  });

  it("uses the latest confirmed current-war end time as the checklist expiry", async () => {
    const getCurrentWar = vi.fn().mockImplementation(async (clanTag: string) => {
      if (clanTag === "#PYPY") {
        return makeLiveWarSnapshot({
          startTimeIso: "2026-05-13T18:00:00.000Z",
          opponentTag: "#OPP1",
          state: "preparation",
        });
      }
      if (clanTag === "#PYPL") {
        return makeLiveWarSnapshot({
          startTimeIso: "2026-05-13T22:00:00.000Z",
          opponentTag: "#OPP2",
          state: "preparation",
        });
      }
      return null;
    });
    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
    });

    expect(state.expiresAt?.toISOString()).toBe("2026-05-14T22:00:00.000Z");
  });

  it("renders a safe unknown mail row for a notInWar current-war row", async () => {
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
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-05-13T18:00:00.000Z",
        opponentTag: "#OPP1",
        state: "preparation",
      }),
    );
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
    });

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].compactCopyLine).toBe("\u{1F4ED} | \u{1F518} | A vs `-`");
    expect(state.rows[0].compactCopyLine).not.toContain("(");
    expect(state.rows[0].contextKey).toBeNull();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("[fwa_checklist_mail_identity_suppressed]"),
    );
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("reason=current_not_in_war"));
    expect(WarMailLifecycleService.prototype.resolveStatusForCurrentWar).not.toHaveBeenCalled();
  });

  it("renders a safe unknown mail row when the persisted state is unknown", async () => {
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
        state: "mystery",
      },
    ]);
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-05-13T18:00:00.000Z",
        opponentTag: "#OPP1",
        state: "preparation",
      }),
    );
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
    });

    expect(state.rows[0].compactCopyLine).toBe("\u{1F4ED} | \u{1F518} | A vs `-`");
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("reason=current_state_unknown"));
  });

  it("renders a stale BL row as the neutral unknown mail row", async () => {
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
        state: "mystery",
      },
    ]);
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-05-13T18:00:00.000Z",
        opponentTag: "#OPP1",
        state: "preparation",
      }),
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
    });

    expect(state.rows[0].compactCopyLine).toBe("\u{1F4ED} | \u{1F518} | A vs `-`");
    expect(state.rows[0].compactCopyLine).not.toContain("\u{26AB}");
  });

  it("renders a stale MM row as the neutral unknown mail row", async () => {
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
        state: "mystery",
      },
    ]);
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-05-13T18:00:00.000Z",
        opponentTag: "#OPP1",
        state: "preparation",
      }),
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
    });

    expect(state.rows[0].compactCopyLine).toBe("\u{1F4ED} | \u{1F518} | A vs `-`");
    expect(state.rows[0].compactCopyLine).not.toContain("\u{26AA}");
  });

  it("does not let a stale previous-war row override the supplied fallback expiry", async () => {
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        prepStartTime: new Date("2026-05-11T13:00:00.000Z"),
        startTime: null,
        endTime: new Date("2026-05-11T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
        state: "notInWar",
      },
    ]);
    const fallbackExpiresAt = new Date("2026-05-15T16:00:00.000Z");
    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockRejectedValue(new Error("boom")) } as any,
      guildId: "guild-1",
      client: {} as any,
      fallbackExpiresAt,
    });

    expect(state.expiresAt).toBeInstanceOf(Date);
    expect(state.expiresAt!.toISOString()).toBe(fallbackExpiresAt.toISOString());
    expect(state.rows[0].compactCopyLine).toBe("\u{1F4ED} | \u{1F518} | A vs `-`");
  });

  it("uses missing_identity and the 30-minute fallback when the live war API fails", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        prepStartTime: new Date("2026-05-11T13:00:00.000Z"),
        startTime: new Date("2026-05-11T18:00:00.000Z"),
        endTime: new Date("2026-05-11T19:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "FWA",
        inferredMatchType: null,
        outcome: null,
        state: "preparation",
      },
    ]);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const before = Date.now();
    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockRejectedValue(new Error("boom")) } as any,
      guildId: "guild-1",
      client: {} as any,
    });

    expect(state.rows[0].compactCopyLine).toBe("\u{1F4ED} | \u{1F518} | A vs `-`");
    expect(state.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("reason=missing_identity"));
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
        state: "mystery",
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
    expect(state.rows[0].compactCopyLine).toBe("\u{1F4ED} | \u{1F518} | A vs `-`");
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
    expect(state.expiresAt?.toISOString()).toBe("2026-05-14T22:00:00.000Z");
    expect(getCurrentWar).not.toHaveBeenCalled();
  });

  it("treats a completed current-scope base-swap as resolved without a separate checklist completion", async () => {
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
        state: "battle",
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
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockResolvedValue(
      makeBaseSwapTrackedMessageRow({
        messageId: "message-1",
        createdAtIso: "2026-05-13T17:00:00.000Z",
        syncMessageId: "sync-message-2",
        status: "COMPLETED",
        entries: [
          {
            position: 12,
            playerTag: "#AAA",
            playerName: "PlayerOne",
            discordUserId: "111",
            townhallLevel: 15,
            section: "war_bases",
            acknowledged: true,
          },
        ],
      }) as any,
    );
    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
    });

    expect(state.rows[0].compactCopyLine).toContain("✅ Bases checked and all good");
    expect(state.rows[0].compactCopyLine).not.toContain("❌ Bases not checked");
    expect(trackedMessageService.findLatestFwaMatchChecklistBasesCompletionForClan).not.toHaveBeenCalled();
  });

  it("ignores stale current-war timing and falls back to the provided sync+48h expiry", async () => {
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        prepStartTime: new Date("2026-05-10T14:00:00.000Z"),
        startTime: new Date("2026-05-10T18:00:00.000Z"),
        endTime: new Date("2026-05-11T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
      },
    ]);

    const fallbackExpiresAt = new Date("2026-05-15T16:00:00.000Z");
    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      fallbackExpiresAt,
    });

    expect(state.expiresAt?.toISOString()).toBe(fallbackExpiresAt.toISOString());
  });

  it("uses a future current-war end time when it exists", async () => {
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        prepStartTime: null,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        endTime: new Date("2026-05-14T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
        state: "preparation",
      },
    ]);

    const fallbackExpiresAt = new Date("2026-05-15T16:00:00.000Z");
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-05-13T18:00:00.000Z",
        opponentTag: "#OPP1",
        state: "preparation",
      }),
    );
    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
      fallbackExpiresAt,
    });

    expect(state.expiresAt?.toISOString()).toBe("2026-05-14T18:00:00.000Z");
  });

  it("does not render an unscoped previous-war base-swap when a sync identity exists", async () => {
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
        state: "battle",
      },
    ]);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockRestore();
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      makeBaseSwapTrackedMessageRow({
        messageId: "old-base-swap-message",
        createdAtIso: "2026-05-13T15:00:00.000Z",
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
      }),
    ]);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
      syncMessageId: "sync-message-1",
    });

    const content = buildFwaMatchBasesMessageContent({ rows: state.rows });
    expect(content).toContain("❌ Bases not checked");
    expect(content).not.toContain("[base-swap post](");
    expect(content).not.toContain("old-base-swap-message");
  });

  it("renders a matching sync-scoped base-swap in the Bases checklist", async () => {
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
        state: "battle",
      },
    ]);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockRestore();
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      makeBaseSwapTrackedMessageRow({
        messageId: "current-base-swap-message",
        createdAtIso: "2026-05-13T17:00:00.000Z",
        syncMessageId: "sync-message-1",
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
      }),
    ]);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar: vi.fn().mockResolvedValue(null) } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Bases",
      syncMessageId: "sync-message-1",
    });

    const content = buildFwaMatchBasesMessageContent({ rows: state.rows });
    expect(content).toContain("[base-swap post](");
    expect(content).toContain("current-base-swap-message");
    expect(content).not.toContain("old-base-swap-message");
  });

  it("renders a bases checklist from an expired sync post fallback when the active sync post is missing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1,
        prepStartTime: new Date("2026-05-13T17:00:00.000Z"),
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
        battleDayStart: new Date("2026-05-13T18:00:00.000Z"),
        prepStartTime: new Date("2026-05-13T17:00:00.000Z"),
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

  it("fails safe to unsent for stale current-war rows that still have posted mail lifecycle data", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      makeCurrentWarRow({
        clanTag: "#PYPY",
        warId: 1000466,
        prepStartTimeIso: "2026-06-10T13:05:00.000Z",
        startTimeIso: "2026-06-10T13:20:00.000Z",
        endTimeIso: "2026-06-10T14:20:00.000Z",
        opponentTag: "#PYPL",
        state: "preparation",
      }),
    ]);
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-06-11T13:20:00.000Z",
        opponentTag: "#PYLQ",
        state: "preparation",
      }),
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Mail",
    });

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].compactCopyLine).toContain("\u{1F4ED}");
    expect(state.rows[0].compactCopyLine).not.toContain("\u{1F4EC}");
    expect(WarMailLifecycleService.prototype.resolveStatusForCurrentWar).not.toHaveBeenCalled();
  });

  it("renders posted mail only when the live war confirms the current war identity", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      makeCurrentWarRow({
        clanTag: "#PYPY",
        warId: 1000481,
        prepStartTimeIso: "2026-06-11T13:05:00.000Z",
        startTimeIso: "2026-06-11T13:20:00.000Z",
        endTimeIso: "2026-06-11T14:20:00.000Z",
        opponentTag: "#PYPL",
        matchType: null,
        state: "preparation",
      }),
    ]);
    const resolveStatusForCurrentWar = vi
      .mocked(WarMailLifecycleService.prototype.resolveStatusForCurrentWar)
      .mockResolvedValue({
        status: "posted",
        mailStatusEmoji: "\u{1F4EC}",
        debug: {
          currentWarId: 1000481,
          trackedMailWarId: 1000481,
          trackedChannelId: "channel-1",
          trackedMessageId: "message-1",
          trackedMessageExists: "yes",
          currentWarConfigMatchesTrackedMessage: true,
          winningSource: "tracked",
          finalNormalizedStatus: "posted",
          reconciliationOutcome: "not_checked",
          reconciliationCertainty: "not_checked",
          debugReasonCode: "posted",
          debugReason: "Posted lifecycle row exists.",
          environmentMismatchSignal: false,
          trackingCleared: false,
        },
      } as any);
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-06-11T13:20:00.000Z",
        opponentTag: "#PYPL",
        state: "preparation",
      }),
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Mail",
    });

    expect(resolveStatusForCurrentWar).toHaveBeenCalledTimes(1);
    expect(resolveStatusForCurrentWar).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#PYPY",
        warId: 1000481,
        warStartTime: new Date("2026-06-11T13:20:00.000Z"),
        opponentTag: "#PYPL",
        sentEmoji: "\u{1F4EC}",
        unsentEmoji: "\u{1F4ED}",
      }),
    );
    expect(state.rows[0].compactCopyLine).toBe("\u{1F4EC} | \u{1F518} | A vs `Opponent` (`#PYPL`)");
  });

  it("renders a confirmed identity with a missing opponent name using a hyphen", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      makeCurrentWarRow({
        clanTag: "#PYPY",
        warId: 1000481,
        prepStartTimeIso: "2026-06-11T13:05:00.000Z",
        startTimeIso: "2026-06-11T13:20:00.000Z",
        endTimeIso: "2026-06-11T14:20:00.000Z",
        opponentTag: "#PYPL",
        matchType: null,
        state: "preparation",
      }),
    ]);
    const resolveStatusForCurrentWar = vi
      .mocked(WarMailLifecycleService.prototype.resolveStatusForCurrentWar)
      .mockResolvedValue({
        status: "posted",
        mailStatusEmoji: "\u{1F4EC}",
        debug: {
          currentWarId: 1000481,
          trackedMailWarId: 1000481,
          trackedChannelId: "channel-1",
          trackedMessageId: "message-1",
          trackedMessageExists: "yes",
          currentWarConfigMatchesTrackedMessage: true,
          winningSource: "tracked",
          finalNormalizedStatus: "posted",
          reconciliationOutcome: "not_checked",
          reconciliationCertainty: "not_checked",
          debugReasonCode: "posted",
          debugReason: "Posted lifecycle row exists.",
          environmentMismatchSignal: false,
          trackingCleared: false,
        },
      } as any);
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-06-11T13:20:00.000Z",
        opponentTag: "#PYPL",
        opponentName: "",
        state: "preparation",
      }),
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Mail",
    });

    expect(resolveStatusForCurrentWar).toHaveBeenCalledTimes(1);
    expect(state.rows[0].compactCopyLine).toBe("\u{1F4EC} | \u{1F518} | A vs `-` (`#PYPL`)");
    expect(state.rows[0].compactCopyLine).not.toContain("Unknown Opponent");
  });

  it("renders unsent mail when the live war opponent does not match the current-war row", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      makeCurrentWarRow({
        clanTag: "#PYPY",
        warId: 1000481,
        prepStartTimeIso: "2026-06-11T13:05:00.000Z",
        startTimeIso: "2026-06-11T13:20:00.000Z",
        endTimeIso: "2026-06-11T14:20:00.000Z",
        opponentTag: "#PYPL",
        state: "preparation",
      }),
    ]);
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-06-11T13:20:00.000Z",
        opponentTag: "#PYLQ",
        state: "preparation",
      }),
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Mail",
    });

    expect(WarMailLifecycleService.prototype.resolveStatusForCurrentWar).not.toHaveBeenCalled();
    expect(state.rows[0].compactCopyLine).toBe("\u{1F4ED} | \u{1F518} | A vs `-`");
  });

  it("renders unsent mail when the live war start time does not match the current-war row", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      makeCurrentWarRow({
        clanTag: "#PYPY",
        warId: 1000481,
        prepStartTimeIso: "2026-06-11T13:05:00.000Z",
        startTimeIso: "2026-06-11T13:20:00.000Z",
        endTimeIso: "2026-06-11T14:20:00.000Z",
        opponentTag: "#PYPL",
        state: "preparation",
      }),
    ]);
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-06-11T13:24:00.000Z",
        opponentTag: "#PYPL",
        state: "preparation",
      }),
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Mail",
    });

    expect(WarMailLifecycleService.prototype.resolveStatusForCurrentWar).not.toHaveBeenCalled();
    expect(state.rows[0].compactCopyLine).toBe("\u{1F4ED} | \u{1F518} | A vs `-`");
  });

  it("does not let checked-clan state change the mailbox emoji for stale current-war rows", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", clanBadge: "<:rr:111>", name: "Alpha", shortName: "A" },
    ]);
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValue({
      id: "sync-tracked-mail",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-checked",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-06-11T15:55:00.000Z"),
      expiresAt: null,
      metadata: {} as any,
    } as any);
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        metadata: {
          kind: "mail_checklist",
          createdByUserId: "user-1",
          createdAtIso: "2026-06-11T15:56:00.000Z",
          scopeKey: "scope-placeholder",
          referenceId: "sync-message-checked",
          checkedClanTags: ["#PYPY"],
          rows: [],
        },
        referenceId: "sync-message-checked",
      } as any,
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      makeCurrentWarRow({
        clanTag: "#PYPY",
        warId: 1000466,
        prepStartTimeIso: "2026-06-10T13:05:00.000Z",
        startTimeIso: "2026-06-10T13:20:00.000Z",
        endTimeIso: "2026-06-10T14:20:00.000Z",
        opponentTag: "#PYPL",
        state: "preparation",
      }),
    ]);
    const getCurrentWar = vi.fn().mockResolvedValue(
      makeLiveWarSnapshot({
        startTimeIso: "2026-06-11T13:20:00.000Z",
        opponentTag: "#PYLQ",
        state: "preparation",
      }),
    );

    const state = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: { getCurrentWar } as any,
      guildId: "guild-1",
      client: {} as any,
      viewType: "Mail",
    });

    expect(state.rows[0].compactCopyLine).toContain("\u{1F4ED}");
    expect(state.rows[0].compactCopyLine).not.toContain("\u{1F4EC}");
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
