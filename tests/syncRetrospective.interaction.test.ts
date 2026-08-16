import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRetrospectiveResult } from "../src/services/SyncRetrospectiveService";
import {
  isSyncRetrospectiveClanSelectCustomId,
  parseSyncRetrospectiveClanSelectCustomId,
} from "../src/services/SyncRetrospectiveInteractionIds";
import { handleSyncRetrospectiveClanSelect } from "../src/services/SyncRetrospectiveInteractionService";

function retrospectiveResult(clans: SyncRetrospectiveResult["clans"] = []): SyncRetrospectiveResult {
  return {
    identity: { guildId: "guild-1", syncNumber: 545, syncTime: null, cycleMapped: false },
    warSummary: { clanWarCount: 1, totalStarsKnown: 1, starsCoverage: { known: 1, total: 1 } },
    missedAttacks: { missedAttacksKnownTotal: 0, coverage: { completeClans: 1, warClans: 1 } },
    fwaViolations: { violationKnownTotal: 0, coverage: { completedFwaEvaluations: 1, fwaWars: 1 } },
    readiness: { averageDeviation: null, deviationCoverage: { valid: 0, totalSnapshots: 0 } },
    fillers: { fillerKnownTotal: null, fillerCoverage: { complete: 0, totalSnapshots: 0 } },
    clans,
  };
}

function clan(tag = "#CLAN") {
  return {
    identity: {
      clanTag: tag,
      clanName: "Detail Clan",
      warId: 1,
      matchType: "FWA",
      expectedOutcome: "WIN",
      actualOutcome: "WIN",
    },
    war: { stars: 1 },
    missedAttacks: { total: 0, coverageComplete: true, players: [] },
    violations: { total: 0, evaluationComplete: true, applicable: true, details: [] },
    readiness: { memberCount: null, deviationScore: null, projectionComplete: false, dataAvailable: false },
    fillers: { fillerCount: null, fillerPlayerTags: [], fillerCaptureComplete: false },
  } as SyncRetrospectiveResult["clans"][number];
}

function interaction(customId = "sync-retro:clan:545:0", values = ["#CLAN"]) {
  return {
    customId,
    values,
    guildId: "guild-1",
    inGuild: vi.fn().mockReturnValue(true),
    memberPermissions: { has: vi.fn().mockReturnValue(false) },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("Sync retrospective clan interactions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts only the exact four-part custom-id shape", () => {
    expect(parseSyncRetrospectiveClanSelectCustomId("sync-retro:clan:545:0")).toEqual({ syncNumber: 545, menuIndex: 0 });
    expect(parseSyncRetrospectiveClanSelectCustomId("sync-retro:clan:545:4")).toEqual({ syncNumber: 545, menuIndex: 4 });
    expect(isSyncRetrospectiveClanSelectCustomId("sync-retro:clan:545:0")).toBe(true);
    expect(isSyncRetrospectiveClanSelectCustomId("sync-retro:clan:545:4")).toBe(true);
    expect(isSyncRetrospectiveClanSelectCustomId("sync-retro:clan:545:0:extra")).toBe(false);
    expect(isSyncRetrospectiveClanSelectCustomId("sync-retro:clan:0:0")).toBe(false);
    expect(isSyncRetrospectiveClanSelectCustomId("sync-retro:clan:545:-1")).toBe(false);
    expect(isSyncRetrospectiveClanSelectCustomId("sync-retro:clan:545:5")).toBe(false);
  });

  it("does not enter the handler for malformed ids", async () => {
    const current = interaction("sync-retro:clan:545:0:extra");
    const permissionService = { canUseAnyTarget: vi.fn() };
    const retrospectiveService = { getBySyncNumber: vi.fn() };

    await handleSyncRetrospectiveClanSelect(current, { permissionService: permissionService as any, retrospectiveService: retrospectiveService as any });

    expect(permissionService.canUseAnyTarget).not.toHaveBeenCalled();
    expect(retrospectiveService.getBySyncNumber).not.toHaveBeenCalled();
    expect(current.reply).not.toHaveBeenCalled();
  });

  it("denies before the retrospective read and keeps the denial ephemeral", async () => {
    const current = interaction();
    const permissionService = { canUseAnyTarget: vi.fn().mockResolvedValue(false) };
    const retrospectiveService = { getBySyncNumber: vi.fn() };

    await handleSyncRetrospectiveClanSelect(current, { permissionService: permissionService as any, retrospectiveService: retrospectiveService as any });

    expect(permissionService.canUseAnyTarget).toHaveBeenCalledWith(["sync:retrospective"], current);
    expect(retrospectiveService.getBySyncNumber).not.toHaveBeenCalled();
    expect(current.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(current.deferReply).not.toHaveBeenCalled();
    expect(current.update).not.toHaveBeenCalled();
  });

  it("serves an authorized public-summary selection as an ephemeral detail response", async () => {
    const current = interaction();
    const permissionService = { canUseAnyTarget: vi.fn().mockResolvedValue(true) };
    const retrospectiveService = { getBySyncNumber: vi.fn().mockResolvedValue(retrospectiveResult([clan()])) };

    await handleSyncRetrospectiveClanSelect(current, { permissionService: permissionService as any, retrospectiveService: retrospectiveService as any });

    expect(current.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(retrospectiveService.getBySyncNumber).toHaveBeenCalledWith({ guildId: "guild-1", syncNumber: 545 });
    expect(current.editReply.mock.calls[0][0].embeds[0].data.title).toBe("Sync #545 • Detail Clan");
    expect(current.update).not.toHaveBeenCalled();
  });

  it("does not read when the selected value is not exactly one valid tag", async () => {
    const current = interaction("sync-retro:clan:545:0", ["#CLAN", "#OTHER"]);
    const permissionService = { canUseAnyTarget: vi.fn().mockResolvedValue(true) };
    const retrospectiveService = { getBySyncNumber: vi.fn() };

    await handleSyncRetrospectiveClanSelect(current, { permissionService: permissionService as any, retrospectiveService: retrospectiveService as any });

    expect(retrospectiveService.getBySyncNumber).not.toHaveBeenCalled();
    expect(current.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("reports unavailable retrospective or clan data ephemerally", async () => {
    const missingRetrospective = interaction();
    const permissionService = { canUseAnyTarget: vi.fn().mockResolvedValue(true) };
    const retrospectiveService = { getBySyncNumber: vi.fn().mockResolvedValue(retrospectiveResult()) };
    retrospectiveService.getBySyncNumber.mockResolvedValueOnce({
      ...retrospectiveResult(),
      warSummary: { clanWarCount: 0, totalStarsKnown: null, starsCoverage: { known: 0, total: 0 } },
    });
    await handleSyncRetrospectiveClanSelect(missingRetrospective, { permissionService: permissionService as any, retrospectiveService: retrospectiveService as any });
    expect(missingRetrospective.editReply).toHaveBeenCalledWith("Sync #545 retrospective data is no longer available.");

    const missingClan = interaction("sync-retro:clan:545:0", ["#MISSING"]);
    retrospectiveService.getBySyncNumber.mockResolvedValue(retrospectiveResult([clan()]));
    await handleSyncRetrospectiveClanSelect(missingClan, { permissionService: permissionService as any, retrospectiveService: retrospectiveService as any });
    expect(missingClan.editReply).toHaveBeenCalledWith("That clan is not available in the Sync #545 retrospective.");
  });
});
