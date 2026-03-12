import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import { WarComplianceService } from "../src/services/WarComplianceService";
import { WarEventHistoryService } from "../src/services/war-events/history";
import { computeWarComplianceForTest } from "../src/services/war-events/core";

describe("WarComplianceService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps compliance snapshot parity with the shared war-end rule engine", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const participants = [
      { playerName: "Alice", playerTag: "#A", attacksUsed: 2, playerPosition: 1 },
      { playerName: "Bob", playerTag: "#B", attacksUsed: 2, playerPosition: 2 },
      { playerName: "Cory", playerTag: "#C", attacksUsed: 0, playerPosition: 3 },
    ];
    const attacks = [
      {
        playerTag: "#A",
        playerName: "Alice",
        playerPosition: 1,
        defenderPosition: 2,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T02:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#B",
        playerName: "Bob",
        playerPosition: 2,
        defenderPosition: 2,
        stars: 2,
        trueStars: 2,
        attackSeenAt: new Date("2026-02-01T03:00:00.000Z"),
        warEndTime,
        attackOrder: 2,
      },
    ];

    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      warStartTime,
      warEndTime,
      warId: 777,
    } as any);
    vi.spyOn(prisma.warAttacks, "findMany")
      .mockResolvedValueOnce(participants as any)
      .mockResolvedValueOnce(attacks as any);
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);

    const service = new WarComplianceService();
    const snapshot = await service.getComplianceSnapshot({
      clanTag: "#TEST",
      preferredWarStartTime: warStartTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
    });

    const expected = computeWarComplianceForTest({
      clanTag: "#TEST",
      participants: participants as any,
      attacks: attacks as any,
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "TRADITIONAL",
    });
    expect(snapshot).toEqual(expected);
  });

  it("formats not-following-plan behavior with stars, reason, and strict-window context", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const participants = [
      { playerName: "lotus", playerTag: "#P2", attacksUsed: 2, playerPosition: 5 },
      { playerName: "mirror", playerTag: "#P1", attacksUsed: 1, playerPosition: 1 },
    ];
    const attacks = [
      {
        playerTag: "#P1",
        playerName: "mirror",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T01:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#P2",
        playerName: "lotus",
        playerPosition: 5,
        defenderPosition: 14,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T02:00:00.000Z"),
        warEndTime,
        attackOrder: 2,
      },
      {
        playerTag: "#P2",
        playerName: "lotus",
        playerPosition: 5,
        defenderPosition: 5,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T03:00:00.000Z"),
        warEndTime,
        attackOrder: 3,
      },
    ];

    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      warStartTime,
      warEndTime,
      warId: 777,
    } as any);
    vi.spyOn(prisma.warAttacks, "findMany")
      .mockResolvedValueOnce(participants as any)
      .mockResolvedValueOnce(attacks as any);
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);

    const service = new WarComplianceService();
    const report = await service.getComplianceReport({
      clanTag: "#TEST",
      preferredWarStartTime: warStartTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
    });

    expect(report).not.toBeNull();
    const lotus = report?.notFollowingPlan.find((row) => row.playerName === "lotus");
    expect(lotus).toBeTruthy();
    expect(lotus?.playerPosition).toBe(5);
    expect(lotus?.actualBehavior).toContain("#14 (★ ★ ★)");
    expect(lotus?.actualBehavior).toContain("#5 (★ ★ ★)");
    expect(lotus?.actualBehavior).toContain("tripled non-mirror in strict window");
    expect(lotus?.actualBehavior).toContain("★ |");
    expect(lotus?.actualBehavior).not.toContain("Attacks used:");
  });

  it("returns null report for BL/MM checks without hitting DB", async () => {
    const findFirstSpy = vi.spyOn(prisma.warAttacks, "findFirst");
    const service = new WarComplianceService();

    const report = await service.getComplianceReport({
      clanTag: "#TEST",
      matchType: "BL",
      expectedOutcome: null,
    });

    expect(report).toBeNull();
    expect(findFirstSpy).not.toHaveBeenCalled();
  });

  it("defaults to current-war scope and matches explicit war-id:current behavior", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const currentRow = {
      warId: 1001,
      startTime: warStartTime,
      endTime: warEndTime,
      matchType: "FWA",
      outcome: "WIN",
    };
    const participants = [
      { playerName: "Alice", playerTag: "#A", attacksUsed: 2, playerPosition: 1, warStartTime },
      { playerName: "Bob", playerTag: "#B", attacksUsed: 0, playerPosition: 2, warStartTime },
    ];
    const attacks = [
      {
        playerTag: "#A",
        playerName: "Alice",
        playerPosition: 1,
        defenderPosition: 2,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T02:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
        warStartTime,
      },
    ];

    vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue(currentRow as any);
    vi.spyOn(prisma.warAttacks, "findMany").mockImplementation(async (args: any) => {
      if (args?.where?.attackOrder === 0) return participants as any;
      if (typeof args?.where?.attackOrder === "object") return attacks as any;
      return [] as any;
    });
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);

    const service = new WarComplianceService();
    const defaultScope = await service.evaluateComplianceForCommand({
      guildId: "guild-1",
      clanTag: "#TEST",
    });
    const explicitCurrent = await service.evaluateComplianceForCommand({
      guildId: "guild-1",
      clanTag: "#TEST",
      scope: "current",
    });

    expect(defaultScope.status).toBe("ok");
    expect(explicitCurrent.status).toBe("ok");
    expect(defaultScope.scope).toBe("current");
    expect(explicitCurrent.scope).toBe("current");
    expect(defaultScope.warId).toBe(explicitCurrent.warId);
    expect(defaultScope.report?.missedBoth).toEqual(explicitCurrent.report?.missedBoth);
    expect(defaultScope.report?.notFollowingPlan).toEqual(explicitCurrent.report?.notFollowingPlan);
  });

  it("resolves the requested clan current war when another clan row is newer", async () => {
    const requestedClanTag = "#2RVV0L0VP";
    const requestedWarId = 1001324;
    const requestedWarStartTime = new Date("2026-02-10T00:00:00.000Z");
    const requestedWarEndTime = new Date("2026-02-11T00:00:00.000Z");
    const requestedCurrentRow = {
      warId: requestedWarId,
      startTime: requestedWarStartTime,
      endTime: requestedWarEndTime,
      matchType: "FWA",
      outcome: "WIN",
      updatedAt: new Date("2026-02-10T01:00:00.000Z"),
    };
    const otherClanCurrentRow = {
      warId: 1001329,
      startTime: requestedWarStartTime,
      endTime: requestedWarEndTime,
      matchType: "FWA",
      outcome: "WIN",
      updatedAt: new Date("2026-02-10T02:00:00.000Z"),
    };
    const currentWarSpy = vi.spyOn(prisma.currentWar, "findFirst").mockImplementation(async (args: any) => {
      const andClauses = Array.isArray(args?.where?.AND) ? args.where.AND : [];
      const hasClanFilter = andClauses.some((clause: any) => {
        const orClauses = Array.isArray(clause?.OR) ? clause.OR : [];
        return orClauses.some(
          (entry: any) => entry?.clanTag === requestedClanTag || entry?.clanTag === "2RVV0L0VP"
        );
      });
      const hasStateFilter = andClauses.some((clause: any) => {
        const orClauses = Array.isArray(clause?.OR) ? clause.OR : [];
        return orClauses.some((entry: any) => {
          const stateValue = String(entry?.state?.equals ?? "").toLowerCase();
          return stateValue === "preparation" || stateValue === "inwar";
        });
      });
      return (hasClanFilter && hasStateFilter ? requestedCurrentRow : otherClanCurrentRow) as any;
    });

    const participants = [
      {
        playerName: "Lead",
        playerTag: "#P88QVY8JG",
        attacksUsed: 1,
        playerPosition: 1,
        warStartTime: requestedWarStartTime,
      },
    ];
    const attacks = [
      {
        playerTag: "#P88QVY8JG",
        playerName: "Lead",
        playerPosition: 1,
        defenderPosition: 2,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-10T03:00:00.000Z"),
        warEndTime: requestedWarEndTime,
        attackOrder: 1,
      },
    ];
    const warAttacksSpy = vi.spyOn(prisma.warAttacks, "findMany").mockImplementation(async (args: any) => {
      if (args?.where?.warId !== requestedWarId) return [] as any;
      if (args?.where?.attackOrder === 0) return participants as any;
      if (typeof args?.where?.attackOrder === "object" && args?.where?.attackOrder?.gt === 0) {
        return attacks as any;
      }
      return [] as any;
    });
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);

    const service = new WarComplianceService();
    const result = await service.evaluateComplianceForCommand({
      guildId: "guild-1",
      clanTag: requestedClanTag,
    });

    expect(result.status).toBe("ok");
    expect(result.warId).toBe(requestedWarId);
    expect(Array.isArray((currentWarSpy.mock.calls[0]?.[0] as any)?.where?.AND)).toBe(true);
    const participantsQuery = warAttacksSpy.mock.calls
      .map((call) => call[0] as any)
      .find((query) => query?.where?.attackOrder === 0);
    expect(participantsQuery?.where?.warId).toBe(requestedWarId);
    expect(result.participantsCount).toBe(1);
    expect(result.attacksCount).toBe(1);
  });

  it("evaluates numeric war-id from WarLookup + ClanWarParticipation without WarAttacks", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const warAttacksSpy = vi.spyOn(prisma.warAttacks, "findMany");
    vi.spyOn(prisma.clanWarHistory, "findFirst").mockResolvedValue({
      warId: 5555,
      warStartTime,
      warEndTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
    } as any);
    vi.spyOn(prisma.warLookup, "findUnique").mockResolvedValue({
      payload: {
        warMeta: {
          endTime: warEndTime.toISOString(),
        },
        clan: {
          members: [
            { tag: "#A", name: "Alice", mapPosition: 1 },
            { tag: "#B", name: "Bob", mapPosition: 2 },
          ],
        },
        opponent: {
          members: [{ tag: "#X", name: "Opp1", mapPosition: 1 }, { tag: "#Y", name: "Opp2", mapPosition: 2 }],
        },
        attacks: [
          {
            attackerTag: "#A",
            attackerName: "Alice",
            defenderTag: "#Y",
            defenderName: "Opp2",
            stars: 3,
            order: 1,
            attackSeenAt: "2026-02-01T02:00:00.000Z",
          },
        ],
      },
      endTime: warEndTime,
    } as any);
    vi.spyOn(prisma.clanWarParticipation, "findMany").mockResolvedValue([
      { playerTag: "#A", playerName: "Alice", attacksUsed: 1, firstAttackAt: new Date("2026-02-01T02:00:00.000Z") },
      { playerTag: "#B", playerName: "Bob", attacksUsed: 0, firstAttackAt: null },
    ] as any);
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);

    const service = new WarComplianceService();
    const result = await service.evaluateComplianceForCommand({
      guildId: "guild-1",
      clanTag: "#TEST",
      scope: "war_id",
      warId: 5555,
    });

    expect(result.status).toBe("ok");
    expect(result.source).toBe("war_lookup");
    expect(result.warResolutionSource).toBe("clan_war_history");
    expect(result.report?.notFollowingPlan.length).toBeGreaterThan(0);
    expect(warAttacksSpy).not.toHaveBeenCalled();
  });

  it("returns no_active_war when no current war is available", async () => {
    vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue(null);
    const service = new WarComplianceService();

    const result = await service.evaluateComplianceForCommand({
      guildId: "guild-1",
      clanTag: "#TEST",
    });

    expect(result.status).toBe("no_active_war");
  });

  it("returns insufficient_data when historical participation implies attacks but no attack rows exist", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    vi.spyOn(prisma.clanWarHistory, "findFirst").mockResolvedValue({
      warId: 7777,
      warStartTime,
      warEndTime,
      matchType: "FWA",
      expectedOutcome: "LOSE",
    } as any);
    vi.spyOn(prisma.warLookup, "findUnique").mockResolvedValue({
      payload: { attacks: [] },
      endTime: warEndTime,
    } as any);
    vi.spyOn(prisma.clanWarParticipation, "findMany").mockResolvedValue([
      { playerTag: "#A", playerName: "Alice", attacksUsed: 1, firstAttackAt: new Date("2026-02-01T03:00:00.000Z") },
    ] as any);

    const service = new WarComplianceService();
    const result = await service.evaluateComplianceForCommand({
      guildId: "guild-1",
      clanTag: "#TEST",
      scope: "war_id",
      warId: 7777,
    });

    expect(result.status).toBe("insufficient_data");
    expect(result.source).toBe("war_lookup");
  });
});

describe("WarEventHistoryService.getWarComplianceSnapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates compliance evaluation to WarComplianceService", async () => {
    const delegated = { missedBoth: ["Alice"], notFollowingPlan: ["Bob"] };
    const serviceSpy = vi
      .spyOn(WarComplianceService.prototype, "getComplianceSnapshot")
      .mockResolvedValue(delegated);
    const history = new WarEventHistoryService({} as any);
    const warStart = new Date("2026-02-01T00:00:00.000Z");

    const result = await history.getWarComplianceSnapshot("#TEST", warStart, "FWA", "LOSE");

    expect(result).toEqual(delegated);
    expect(serviceSpy).toHaveBeenCalledWith({
      clanTag: "#TEST",
      preferredWarStartTime: warStart,
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
  });
});

