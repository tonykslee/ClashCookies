import { describe, expect, it, vi } from "vitest";
import { repairEndedWarRows } from "../src/services/war-events/endedWarRepair";

function buildDb(input: {
  currentWarRows: Array<Record<string, unknown>>;
  historyRow: Record<string, unknown> | null;
}) {
  const currentWarUpdate = vi.fn().mockResolvedValue({});
  return {
    currentWar: {
      findMany: vi.fn().mockResolvedValue(input.currentWarRows),
      update: currentWarUpdate,
    },
    clanWarHistory: {
      findFirst: vi.fn().mockResolvedValue(input.historyRow),
    },
    trackedMessage: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    currentWarUpdate,
  };
}

describe("repairEndedWarRows", () => {
  it("detects a mismatch in dry-run mode without updating CurrentWar", async () => {
    const db = buildDb({
      currentWarRows: [
        {
          clanTag: "#9GLGQCCU",
          guildId: "guild-1",
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          opponentTag: "#OPP123",
          matchType: "BL",
          outcome: "WIN",
          warEndFwaPoints: 130,
        },
      ],
      historyRow: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        actualOutcome: "WIN",
        pointsAfterWar: 131,
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      },
    });

    const summary = await repairEndedWarRows({
      apply: false,
      db: db as any,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(summary).toMatchObject({
      mode: "dry-run",
      scanned: 1,
      mismatched: 1,
      repaired: 0,
      skipped: 0,
      errors: 0,
    });
    expect(db.currentWar.update).not.toHaveBeenCalled();
  });

  it("repairs CurrentWar from ClanWarHistory in apply mode", async () => {
    const db = buildDb({
      currentWarRows: [
        {
          clanTag: "#LQQ99UV8",
          guildId: "guild-1",
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          opponentTag: "#OPP123",
          matchType: "BL",
          outcome: "WIN",
          warEndFwaPoints: 130,
        },
      ],
      historyRow: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        actualOutcome: "WIN",
        pointsAfterWar: 131,
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      },
    });

    const summary = await repairEndedWarRows({
      apply: true,
      db: db as any,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(summary).toMatchObject({
      mode: "apply",
      scanned: 1,
      mismatched: 1,
      repaired: 1,
      skipped: 0,
      errors: 0,
    });
    expect(db.currentWar.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clanTag_guildId: {
            clanTag: "#LQQ99UV8",
            guildId: "guild-1",
          },
        },
        data: {
          matchType: "FWA",
          outcome: "LOSE",
          warEndFwaPoints: 131,
        },
      }),
    );
  });

  it("uses expectedOutcome instead of actualOutcome when restoring outcome", async () => {
    const db = buildDb({
      currentWarRows: [
        {
          clanTag: "#9GLGQCCU",
          guildId: "guild-1",
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          opponentTag: "#OPP123",
          matchType: "FWA",
          outcome: "WIN",
          warEndFwaPoints: 131,
        },
      ],
      historyRow: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        actualOutcome: "WIN",
        pointsAfterWar: 131,
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      },
    });

    await repairEndedWarRows({
      apply: true,
      db: db as any,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(db.currentWar.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: "LOSE",
        }),
      }),
    );
  });

  it("does nothing when the matching history row is missing", async () => {
    const db = buildDb({
      currentWarRows: [
        {
          clanTag: "#9GLGQCCU",
          guildId: "guild-1",
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          opponentTag: "#OPP123",
          matchType: "FWA",
          outcome: "WIN",
          warEndFwaPoints: 130,
        },
      ],
      historyRow: null,
    });

    const summary = await repairEndedWarRows({
      apply: true,
      db: db as any,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(summary).toMatchObject({
      scanned: 1,
      mismatched: 0,
      repaired: 0,
      skipped: 1,
      missingHistory: 1,
    });
    expect(db.currentWar.update).not.toHaveBeenCalled();
  });

  it("does nothing when CurrentWar already matches ClanWarHistory", async () => {
    const db = buildDb({
      currentWarRows: [
        {
          clanTag: "#9GLGQCCU",
          guildId: "guild-1",
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          opponentTag: "#OPP123",
          matchType: "FWA",
          outcome: "LOSE",
          warEndFwaPoints: 131,
        },
      ],
      historyRow: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        actualOutcome: "WIN",
        pointsAfterWar: 131,
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      },
    });

    const summary = await repairEndedWarRows({
      apply: true,
      db: db as any,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(summary).toMatchObject({
      scanned: 1,
      mismatched: 0,
      repaired: 0,
      skipped: 1,
      errors: 0,
    });
    expect(db.currentWar.update).not.toHaveBeenCalled();
  });
});
