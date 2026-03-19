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
      {
        playerName: "Alice",
        playerTag: "#A",
        attacksUsed: 2,
        playerPosition: 1,
      },
      { playerName: "Bob", playerTag: "#B", attacksUsed: 2, playerPosition: 2 },
      {
        playerName: "Cory",
        playerTag: "#C",
        attacksUsed: 0,
        playerPosition: 3,
      },
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
    vi.spyOn(prisma.clanWarPlan, "findFirst").mockResolvedValue(null as any);

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

  it("uses the first offending attack context for strict-window non-mirror triples", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const participants = [
      {
        playerName: "lotus",
        playerTag: "#P2",
        attacksUsed: 2,
        playerPosition: 5,
      },
      {
        playerName: "mirror",
        playerTag: "#P1",
        attacksUsed: 1,
        playerPosition: 1,
      },
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
        attackOrder: 99,
      },
      {
        playerTag: "#P2",
        playerName: "lotus",
        playerPosition: 5,
        defenderPosition: 8,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T03:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
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
    vi.spyOn(prisma.clanWarPlan, "findFirst").mockResolvedValue(null as any);

    const service = new WarComplianceService();
    const report = await service.getComplianceReport({
      clanTag: "#TEST",
      preferredWarStartTime: warStartTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
    });

    expect(report).not.toBeNull();
    const lotus = report?.notFollowingPlan.find(
      (row) => row.playerName === "lotus",
    );
    expect(lotus).toBeTruthy();
    expect(lotus?.playerPosition).toBe(5);
    expect(lotus?.actualBehavior).toContain("#14");
    expect(lotus?.actualBehavior).toContain("#8");
    expect(lotus?.actualBehavior).toContain(
      "tripled non-mirror in strict window",
    );
    expect(lotus?.actualBehavior).toContain("| 0");
    expect(lotus?.actualBehavior).toContain("21h 0m left");
    expect(lotus?.actualBehavior).not.toContain("Attacks used:");
  });

  it("uses explicit first strict-window context for didn't-triple-mirror reason", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const participants = [
      {
        playerName: "mirror",
        playerTag: "#P1",
        attacksUsed: 1,
        playerPosition: 1,
      },
      {
        playerName: "Baby PK",
        playerTag: "#P3",
        attacksUsed: 2,
        playerPosition: 8,
      },
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
        playerTag: "#P3",
        playerName: "Baby PK",
        playerPosition: 8,
        defenderPosition: 8,
        stars: 2,
        trueStars: 2,
        attackSeenAt: new Date("2026-02-01T02:00:00.000Z"),
        warEndTime,
        attackOrder: 50,
      },
      {
        playerTag: "#P3",
        playerName: "Baby PK",
        playerPosition: 8,
        defenderPosition: 9,
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
      warId: 888,
    } as any);
    vi.spyOn(prisma.warAttacks, "findMany")
      .mockResolvedValueOnce(participants as any)
      .mockResolvedValueOnce(attacks as any);
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);
    vi.spyOn(prisma.clanWarPlan, "findFirst").mockResolvedValue(null as any);

    const service = new WarComplianceService();
    const report = await service.getComplianceReport({
      clanTag: "#TEST",
      preferredWarStartTime: warStartTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
    });

    expect(report).not.toBeNull();
    const babyPk = report?.notFollowingPlan.find(
      (row) => row.playerName === "Baby PK",
    );
    expect(babyPk).toBeTruthy();
    expect(babyPk?.actualBehavior).toContain("didn't triple mirror");
    expect(babyPk?.actualBehavior).toContain("| 3");
    expect(babyPk?.actualBehavior).toContain("21h 0m left");
  });

  it("computes breach-context stars from lower attackOrder values when seen times disagree", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const participants = [
      {
        playerName: "Mirror",
        playerTag: "#P1",
        attacksUsed: 1,
        playerPosition: 1,
      },
      {
        playerName: "Breach",
        playerTag: "#P2",
        attacksUsed: 1,
        playerPosition: 5,
      },
    ];
    const attacks = [
      {
        playerTag: "#P2",
        playerName: "Breach",
        playerPosition: 5,
        defenderPosition: 14,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T01:00:00.000Z"),
        warEndTime,
        attackOrder: 2,
      },
      {
        playerTag: "#P1",
        playerName: "Mirror",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T03:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
    ];

    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      warStartTime,
      warEndTime,
      warId: 1002,
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

    const breach = report?.notFollowingPlan.find(
      (row) => row.playerName === "Breach",
    );
    expect(breach?.breachContext?.starsAtBreach).toBe(3);
    expect(breach?.actualBehavior).toContain("| 3★ | 23h 0m left");
  });

  it("shows 0 stars before a breach attack with attackOrder 1", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const participants = [
      {
        playerName: "Solo",
        playerTag: "#P1",
        attacksUsed: 1,
        playerPosition: 4,
      },
    ];
    const attacks = [
      {
        playerTag: "#P1",
        playerName: "Solo",
        playerPosition: 4,
        defenderPosition: 9,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T02:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
    ];

    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      warStartTime,
      warEndTime,
      warId: 1003,
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

    const solo = report?.notFollowingPlan.find(
      (row) => row.playerName === "Solo",
    );
    expect(solo?.breachContext?.starsAtBreach).toBe(0);
    expect(solo?.actualBehavior).toContain("| 0★ | 22h 0m left");
  });

  it("does not flag strict-window non-mirror triples when trueStars is zero", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const participants = [
      {
        playerName: "Alice",
        playerTag: "#A1",
        attacksUsed: 2,
        playerPosition: 1,
      },
      {
        playerName: "Bob",
        playerTag: "#B1",
        attacksUsed: 0,
        playerPosition: 2,
      },
    ];
    const attacks = [
      {
        playerTag: "#A1",
        playerName: "Alice",
        playerPosition: 1,
        defenderPosition: 2,
        stars: 3,
        trueStars: 0,
        attackSeenAt: new Date("2026-02-01T01:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#A1",
        playerName: "Alice",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T02:00:00.000Z"),
        warEndTime,
        attackOrder: 2,
      },
    ];

    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      warStartTime,
      warEndTime,
      warId: 999,
    } as any);
    vi.spyOn(prisma.warAttacks, "findMany")
      .mockResolvedValueOnce(participants as any)
      .mockResolvedValueOnce(attacks as any);
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRIPLE_TOP_30",
    } as any);

    const service = new WarComplianceService();
    const report = await service.getComplianceReport({
      clanTag: "#TEST",
      preferredWarStartTime: warStartTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
    });

    expect(report).not.toBeNull();
    expect(report?.notFollowingPlan).toHaveLength(0);
  });

  it("does not flag mirror-first then redundant non-mirror triple on already-tripled base", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const participants = [
      {
        playerName: "Alice",
        playerTag: "#A1",
        attacksUsed: 2,
        playerPosition: 1,
      },
      {
        playerName: "Bob",
        playerTag: "#B1",
        attacksUsed: 0,
        playerPosition: 2,
      },
    ];
    const attacks = [
      {
        playerTag: "#A1",
        playerName: "Alice",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T01:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#A1",
        playerName: "Alice",
        playerPosition: 1,
        defenderPosition: 2,
        stars: 3,
        trueStars: 0,
        attackSeenAt: new Date("2026-02-01T02:00:00.000Z"),
        warEndTime,
        attackOrder: 2,
      },
    ];

    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      warStartTime,
      warEndTime,
      warId: 1001,
    } as any);
    vi.spyOn(prisma.warAttacks, "findMany")
      .mockResolvedValueOnce(participants as any)
      .mockResolvedValueOnce(attacks as any);
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRIPLE_TOP_30",
    } as any);

    const service = new WarComplianceService();
    const report = await service.getComplianceReport({
      clanTag: "#TEST",
      preferredWarStartTime: warStartTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
    });

    expect(report).not.toBeNull();
    expect(report?.notFollowingPlan).toHaveLength(0);
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

  it("requires explicit current-war scope with a real warId", async () => {
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
      {
        playerName: "Alice",
        playerTag: "#A",
        attacksUsed: 2,
        playerPosition: 1,
        warStartTime,
      },
      {
        playerName: "Bob",
        playerTag: "#B",
        attacksUsed: 2,
        playerPosition: 2,
        warStartTime,
      },
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

    vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue(
      currentRow as any,
    );
    const warAttacksFindManySpy = vi.spyOn(
      prisma.warAttacks,
      "findMany",
    ) as unknown as {
      mockImplementation: (fn: (args?: any) => any) => any;
    };

    warAttacksFindManySpy.mockImplementation((args?: any) => {
      if (args?.where?.attackOrder === 0) return participants as any;
      if (typeof args?.where?.attackOrder === "object") return attacks as any;
      return [] as any;
    });
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);

    const service = new WarComplianceService();
    const result = await service.evaluateComplianceForCommand({
      guildId: "guild-1",
      clanTag: "#TEST",
      scope: "current",
      warId: 1001,
    });

    expect(result.status).toBe("ok");
    expect(result.scope).toBe("current");
    expect(result.warId).toBe(1001);
    expect(result.report?.missedBoth).toEqual([]);
  });

  it("resolves the requested clan current war by the explicit current warId", async () => {
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

    const currentWarSpy = vi.spyOn(
      prisma.currentWar,
      "findFirst",
    ) as unknown as {
      mockImplementation: (fn: (args?: any) => any) => any;
    };

    currentWarSpy.mockImplementation((args?: any) => {
      expect(args?.where?.guildId).toBe("guild-1");
      expect(args?.where?.warId).toBe(requestedWarId);
      return requestedCurrentRow as any;
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
        warStartTime: requestedWarStartTime,
      },
    ];

    const warAttacksSpy = vi.spyOn(
      prisma.warAttacks,
      "findMany",
    ) as unknown as {
      mockImplementation: (fn: (args?: any) => any) => any;
      mock: { calls: any[][] };
    };

    warAttacksSpy.mockImplementation((args?: any) => {
      if (args?.where?.warId !== requestedWarId) return [] as any;
      if (args?.where?.attackOrder === 0) return participants as any;
      if (
        typeof args?.where?.attackOrder === "object" &&
        args?.where?.attackOrder?.gt === 0
      ) {
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
      scope: "current",
      warId: requestedWarId,
    });

    expect(result.status).toBe("ok");
    expect(result.warId).toBe(requestedWarId);
    expect(currentWarSpy).toHaveBeenCalled();
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
          members: [
            { tag: "#X", name: "Opp1", mapPosition: 1 },
            { tag: "#Y", name: "Opp2", mapPosition: 2 },
          ],
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
      {
        playerTag: "#A",
        playerName: "Alice",
        attacksUsed: 1,
        firstAttackAt: new Date("2026-02-01T02:00:00.000Z"),
      },
      {
        playerTag: "#B",
        playerName: "Bob",
        attacksUsed: 0,
        firstAttackAt: null,
      },
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

  it("prefers payload.compliance.canonical rows when complete", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    vi.spyOn(prisma.clanWarHistory, "findFirst").mockResolvedValue({
      warId: 5666,
      warStartTime,
      warEndTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
      clanName: "Test Clan",
      opponentName: "Opp Clan",
    } as any);
    vi.spyOn(prisma.warLookup, "findUnique").mockResolvedValue({
      payload: {
        warMeta: {
          endTime: warEndTime.toISOString(),
        },
        attacks: [
          // Legacy attack shape intentionally invalid to prove canonical precedence.
          { attackerTag: "", order: null },
        ],
        compliance: {
          canonical: {
            warEndTime: warEndTime.toISOString(),
            participants: [
              {
                playerTag: "#A",
                playerName: "Alice",
                playerPosition: 1,
                attacksUsed: 1,
              },
              {
                playerTag: "#B",
                playerName: "Bob",
                playerPosition: 2,
                attacksUsed: 0,
              },
            ],
            attacks: [
              {
                playerTag: "#A",
                playerName: "Alice",
                playerPosition: 1,
                defenderPosition: 2,
                stars: 3,
                trueStars: 3,
                attackOrder: 1,
                attackSeenAt: "2026-02-01T02:00:00.000Z",
              },
            ],
          },
        },
      },
      endTime: warEndTime,
    } as any);
    vi.spyOn(prisma.clanWarParticipation, "findMany").mockResolvedValue(
      [] as any,
    );
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);

    const service = new WarComplianceService();
    const result = await service.evaluateComplianceForCommand({
      guildId: "guild-1",
      clanTag: "#TEST",
      scope: "war_id",
      warId: 5666,
    });

    expect(result.status).toBe("ok");
    expect(result.attacksCount).toBe(1);
    expect(result.participantsCount).toBe(2);
    expect(result.timingInputs.firstAttackSeenAtIso).toBe(
      "2026-02-01T02:00:00.000Z",
    );
  });

  it("falls back to legacy WarLookup normalization when canonical projection is incomplete", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    vi.spyOn(prisma.clanWarHistory, "findFirst").mockResolvedValue({
      warId: 5777,
      warStartTime,
      warEndTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
      clanName: "Test Clan",
      opponentName: "Opp Clan",
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
          members: [
            { tag: "#X", name: "Opp1", mapPosition: 1 },
            { tag: "#Y", name: "Opp2", mapPosition: 2 },
          ],
        },
        attacks: [
          {
            attackerTag: "#A",
            attackerName: "Alice",
            defenderTag: "#Y",
            defenderName: "Opp2",
            stars: 3,
            trueStars: 3,
            order: 1,
            attackSeenAt: "2026-02-01T03:00:00.000Z",
          },
        ],
        compliance: {
          canonical: {
            warEndTime: warEndTime.toISOString(),
            participants: [
              {
                playerTag: "#A",
                playerName: "Alice",
                playerPosition: 1,
                attacksUsed: 1,
              },
            ],
            attacks: [
              // Missing attackSeenAt makes canonical projection incomplete.
              {
                playerTag: "#A",
                playerName: "Alice",
                playerPosition: 1,
                defenderPosition: 2,
                stars: 3,
                trueStars: 3,
                attackOrder: 1,
              },
            ],
          },
        },
      },
      endTime: warEndTime,
    } as any);
    vi.spyOn(prisma.clanWarParticipation, "findMany").mockResolvedValue([
      {
        playerTag: "#A",
        playerName: "Alice",
        attacksUsed: 1,
        firstAttackAt: new Date("2026-02-01T03:00:00.000Z"),
      },
      {
        playerTag: "#B",
        playerName: "Bob",
        attacksUsed: 0,
        firstAttackAt: null,
      },
    ] as any);
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);

    const service = new WarComplianceService();
    const result = await service.evaluateComplianceForCommand({
      guildId: "guild-1",
      clanTag: "#TEST",
      scope: "war_id",
      warId: 5777,
    });

    expect(result.status).toBe("ok");
    expect(result.attacksCount).toBe(1);
    expect(result.timingInputs.firstAttackSeenAtIso).toBe(
      "2026-02-01T03:00:00.000Z",
    );
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
      {
        playerTag: "#A",
        playerName: "Alice",
        attacksUsed: 1,
        firstAttackAt: new Date("2026-02-01T03:00:00.000Z"),
      },
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

    const result = await history.getWarComplianceSnapshot(
      "#TEST",
      warStart,
      "FWA",
      "LOSE",
    );

    expect(result).toEqual(delegated);
    expect(serviceSpy).toHaveBeenCalledWith({
      clanTag: "#TEST",
      preferredWarStartTime: warStart,
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
  });
});
