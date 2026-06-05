import { describe, expect, it, vi } from "vitest";
import {
  KNOWN_AFFECTED_ENDED_WAR_CLANS,
  repairEndedWarRows,
} from "../src/services/war-events/endedWarRepair";
import {
  parseRepairEndedWarStateArgs,
  resolveRepairEndedWarStateScope,
} from "../src/scripts/repairEndedWarState";

function buildDb(input: {
  currentWarRows: Array<Record<string, unknown>>;
  historyRow: Record<string, unknown> | null;
  trackedMessageRows?: Array<Record<string, unknown>>;
  updateManyCount?: number;
}) {
  const currentWarUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: input.updateManyCount ?? 1 });
  return {
    currentWar: {
      findMany: vi.fn().mockResolvedValue(input.currentWarRows),
      updateMany: currentWarUpdateMany,
    },
    clanWarHistory: {
      findFirst: vi.fn().mockResolvedValue(input.historyRow),
    },
    trackedMessage: {
      findMany: vi.fn().mockResolvedValue(input.trackedMessageRows ?? []),
    },
    currentWarUpdateMany,
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
    expect(db.currentWar.updateMany).not.toHaveBeenCalled();
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
    expect(db.currentWar.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clanTag: "#LQQ99UV8",
          guildId: "guild-1",
          state: "notInWar",
          startTime: new Date("2026-03-12T00:00:00.000Z"),
          opponentTag: "#OPP123",
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

    expect(db.currentWar.updateMany).toHaveBeenCalledWith(
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
    expect(db.currentWar.updateMany).not.toHaveBeenCalled();
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
    expect(db.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("logs race skips when updateMany reports zero updated rows", async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
      updateManyCount: 0,
    });

    const summary = await repairEndedWarRows({
      apply: true,
      db: db as any,
      logger,
    });

    expect(summary).toMatchObject({
      mismatched: 1,
      repaired: 0,
      skipped: 1,
    });
    expect(db.currentWar.updateMany).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ended_war_repair_race"),
    );
  });

  it("includes active checklist targets whose clanTag is null but metadata rows include the repaired clan", async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
      trackedMessageRows: [
        {
          guildId: "guild-1",
          channelId: "chan-1",
          messageId: "msg-1",
          clanTag: null,
          metadata: {
            kind: "mail_checklist",
            createdByUserId: "user-1",
            createdAtIso: "2026-03-12T00:00:00.000Z",
            rows: [
              {
                clanTag: "#9GLGQCCU",
                compactCopyLine: "Alpha vs Enemy",
                badgeEmojiInline: "<:alpha:1>",
                badgeEmojiId: "1",
                badgeEmojiName: "alpha",
              },
            ],
          },
        },
      ],
    });

    const summary = await repairEndedWarRows({
      apply: true,
      db: db as any,
      logger,
    });

    expect(summary.refreshTargets).toBe(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("ended_war_refresh_target"),
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("\"messageId\":\"msg-1\""),
    );
  });
});

describe("repairEndedWarState script args", () => {
  it("refuses apply mode without an explicit scope", () => {
    expect(() =>
      resolveRepairEndedWarStateScope(
        parseRepairEndedWarStateArgs(["--apply"]),
      ),
    ).toThrow(/Apply mode requires one explicit scope/);
  });

  it("keeps known affected scope to Marvels and Zero Gravity", () => {
    const scope = resolveRepairEndedWarStateScope(
      parseRepairEndedWarStateArgs(["--apply", "--known-affected"]),
    );
    expect(scope.clanTags).toEqual([...KNOWN_AFFECTED_ENDED_WAR_CLANS]);
    expect(scope.scopeMode).toBe("known-affected");
  });
});
