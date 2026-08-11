import { describe, expect, it } from "vitest";
import {
  buildAttackContextByAttack,
  classifyComplianceReasonForPlayer,
  computeWarComplianceForTest,
  WIN_UNCLEARED_MIRROR_AFTER_OPEN_REASON,
  type WarComplianceAttack,
  type WarComplianceWinGateConfig,
} from "../src/services/war-events/core";

const warEndTime = new Date("2026-04-02T00:00:00.000Z");

function makeAttack(input: {
  attackOrder: number;
  attackSeenAt: string;
  defenderPosition: number;
  stars: number;
  trueStars?: number;
  playerTag?: string;
  playerPosition?: number;
}): WarComplianceAttack {
  return {
    playerTag: input.playerTag ?? "#P",
    playerName: input.playerTag === "#Q" ? "Other" : "Player",
    playerPosition: input.playerPosition ?? 1,
    defenderPosition: input.defenderPosition,
    stars: input.stars,
    trueStars: input.trueStars ?? input.stars,
    attackSeenAt: new Date(input.attackSeenAt),
    warEndTime,
    attackOrder: input.attackOrder,
  };
}

function classifyWin(input: {
  attacks: WarComplianceAttack[];
  config: WarComplianceWinGateConfig;
  attacksUsed?: number;
  requireMirrorAfterOpen?: boolean;
}) {
  const attackContextByAttack = buildAttackContextByAttack(
    input.attacks,
    input.config,
  );
  const attackIndexByAttack = new Map(
    input.attacks.map((attack, index) => [attack, index]),
  );
  return classifyComplianceReasonForPlayer({
    playerAttacks: input.attacks.filter((attack) => attack.playerTag === "#P"),
    allAttacks: input.attacks,
    attackContextByAttack,
    attackIndexByAttack,
    starsAfterByAttackIndex: new Map(),
    playerAttacksUsed: input.attacksUsed ?? 2,
    winRequireMirrorAfterOpen: input.requireMirrorAfterOpen,
    matchType: "FWA",
    expectedOutcome: "WIN",
    loseStyle: "TRADITIONAL",
  });
}

const starGateConfig = {
  nonMirrorTripleMinClanStars: 2,
  allBasesOpenHoursLeft: 0,
};

const timeGateConfig = {
  nonMirrorTripleMinClanStars: 999,
  allBasesOpenHoursLeft: 12,
};

describe("FWA-WIN mirror-after-open core policy", () => {
  it("expires an unresolved mirror when OFF and the final attack opens by stars", () => {
    const attacks = [
      makeAttack({
        attackOrder: 1,
        attackSeenAt: "2026-04-01T01:00:00.000Z",
        defenderPosition: 1,
        stars: 2,
      }),
      makeAttack({
        attackOrder: 2,
        attackSeenAt: "2026-04-01T02:00:00.000Z",
        defenderPosition: 2,
        stars: 3,
      }),
    ];

    expect(
      classifyWin({ attacks, config: starGateConfig }).hasViolation,
    ).toBe(false);
  });

  it("expires an unresolved mirror when OFF and the final attack opens by time", () => {
    const attacks = [
      makeAttack({
        attackOrder: 1,
        attackSeenAt: "2026-04-01T01:00:00.000Z",
        defenderPosition: 1,
        stars: 2,
      }),
      makeAttack({
        attackOrder: 2,
        attackSeenAt: "2026-04-01T15:00:00.000Z",
        defenderPosition: 2,
        stars: 1,
      }),
    ];

    expect(
      classifyWin({ attacks, config: timeGateConfig }).hasViolation,
    ).toBe(false);
  });

  it("keeps the existing strict mirror miss when both attacks remain strict", () => {
    const attacks = [
      makeAttack({
        attackOrder: 1,
        attackSeenAt: "2026-04-01T01:00:00.000Z",
        defenderPosition: 1,
        stars: 2,
      }),
      makeAttack({
        attackOrder: 2,
        attackSeenAt: "2026-04-01T02:00:00.000Z",
        defenderPosition: 2,
        stars: 1,
      }),
    ];

    const reason = classifyWin({
      attacks,
      config: { nonMirrorTripleMinClanStars: 999, allBasesOpenHoursLeft: 0 },
    });
    expect(reason.label).toBe("didn't triple mirror");
    expect(reason.hasViolation).toBe(true);
  });

  it("does not create a mirror obligation for two attacks entirely after open", () => {
    const attacks = [
      makeAttack({
        attackOrder: 1,
        attackSeenAt: "2026-04-01T01:00:00.000Z",
        defenderPosition: 2,
        stars: 1,
      }),
      makeAttack({
        attackOrder: 2,
        attackSeenAt: "2026-04-01T02:00:00.000Z",
        defenderPosition: 3,
        stars: 1,
      }),
    ];

    expect(
      classifyWin({
        attacks,
        config: { nonMirrorTripleMinClanStars: 0, allBasesOpenHoursLeft: 0 },
      }).hasViolation,
    ).toBe(false);
  });

  it("reports the new open-phase reason when ON and the final attack is open", () => {
    const attacks = [
      makeAttack({
        attackOrder: 1,
        attackSeenAt: "2026-04-01T01:00:00.000Z",
        defenderPosition: 1,
        stars: 2,
      }),
      makeAttack({
        attackOrder: 2,
        attackSeenAt: "2026-04-01T02:00:00.000Z",
        defenderPosition: 2,
        stars: 1,
      }),
    ];

    const reason = classifyWin({
      attacks,
      config: starGateConfig,
      requireMirrorAfterOpen: true,
    });
    expect(reason.label).toBe(WIN_UNCLEARED_MIRROR_AFTER_OPEN_REASON);
    expect(reason.strictWindowContext).toBeNull();
    expect(reason.breachAttackOrders).toEqual([]);
  });

  it("reports the same reason for two open-only attacks when ON", () => {
    const attacks = [
      makeAttack({
        attackOrder: 1,
        attackSeenAt: "2026-04-01T01:00:00.000Z",
        defenderPosition: 2,
        stars: 1,
      }),
      makeAttack({
        attackOrder: 2,
        attackSeenAt: "2026-04-01T02:00:00.000Z",
        defenderPosition: 3,
        stars: 1,
      }),
    ];

    expect(
      classifyWin({
        attacks,
        config: { nonMirrorTripleMinClanStars: 0, allBasesOpenHoursLeft: 0 },
        requireMirrorAfterOpen: true,
      }).label,
    ).toBe(WIN_UNCLEARED_MIRROR_AFTER_OPEN_REASON);
  });

  it("allows an open triple on the required mirror to satisfy the ON obligation", () => {
    const attacks = [
      makeAttack({
        attackOrder: 1,
        attackSeenAt: "2026-04-01T01:00:00.000Z",
        defenderPosition: 1,
        stars: 3,
      }),
      makeAttack({
        attackOrder: 2,
        attackSeenAt: "2026-04-01T02:00:00.000Z",
        defenderPosition: 2,
        stars: 1,
      }),
    ];

    expect(
      classifyWin({
        attacks,
        config: { nonMirrorTripleMinClanStars: 0, allBasesOpenHoursLeft: 0 },
        requireMirrorAfterOpen: true,
      }).hasViolation,
    ).toBe(false);
  });

  it("allows another member to triple the required mirror during open", () => {
    const attacks = [
      makeAttack({
        attackOrder: 1,
        attackSeenAt: "2026-04-01T01:00:00.000Z",
        defenderPosition: 2,
        stars: 1,
      }),
      makeAttack({
        attackOrder: 2,
        attackSeenAt: "2026-04-01T02:00:00.000Z",
        defenderPosition: 3,
        stars: 1,
      }),
      makeAttack({
        attackOrder: 3,
        attackSeenAt: "2026-04-01T03:00:00.000Z",
        defenderPosition: 1,
        stars: 3,
        playerTag: "#Q",
        playerPosition: 2,
      }),
    ];
    const snapshot = computeWarComplianceForTest({
      clanTag: "#TEST",
      participants: [
        { playerTag: "#P", playerName: "Player", attacksUsed: 2, playerPosition: 1 },
        { playerTag: "#Q", playerName: "Other", attacksUsed: 1, playerPosition: 2 },
      ],
      attacks,
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "TRADITIONAL",
      winGateConfig: {
        nonMirrorTripleMinClanStars: 0,
        allBasesOpenHoursLeft: 0,
        winRequireMirrorAfterOpen: true,
      },
    });

    expect(snapshot.notFollowingPlan).toEqual([]);
  });

  it("does not report an unresolved mirror before both attacks are consumed", () => {
    const attacks = [
      makeAttack({
        attackOrder: 1,
        attackSeenAt: "2026-04-01T01:00:00.000Z",
        defenderPosition: 2,
        stars: 1,
      }),
    ];

    expect(
      classifyWin({
        attacks,
        config: { nonMirrorTripleMinClanStars: 0, allBasesOpenHoursLeft: 0 },
        attacksUsed: 1,
        requireMirrorAfterOpen: true,
      }).hasViolation,
    ).toBe(false);
  });

  it.each([false, true])(
    "preserves strict non-mirror 3-star violations when toggle=%s",
    (requireMirrorAfterOpen) => {
      const reason = classifyWin({
        attacks: [
          makeAttack({
            attackOrder: 1,
            attackSeenAt: "2026-04-01T01:00:00.000Z",
            defenderPosition: 2,
            stars: 3,
          }),
        ],
        config: { nonMirrorTripleMinClanStars: 999, allBasesOpenHoursLeft: 0 },
        attacksUsed: 1,
        requireMirrorAfterOpen,
      });
      expect(reason.label).toBe("tripled non-mirror in strict window");
      expect(reason.hasViolation).toBe(true);
    },
  );

  it("preserves the strict non-mirror zero-star violation", () => {
    const reason = classifyWin({
      attacks: [
        makeAttack({
          attackOrder: 1,
          attackSeenAt: "2026-04-01T01:00:00.000Z",
          defenderPosition: 2,
          stars: 0,
          trueStars: 0,
        }),
      ],
      config: { nonMirrorTripleMinClanStars: 999, allBasesOpenHoursLeft: 0 },
      attacksUsed: 1,
    });
    expect(reason.label).toBe("didn't triple mirror");
    expect(reason.hasViolation).toBe(true);
  });

  it("preserves a strict mirror triple as compliant", () => {
    const reason = classifyWin({
      attacks: [
        makeAttack({
          attackOrder: 1,
          attackSeenAt: "2026-04-01T01:00:00.000Z",
          defenderPosition: 1,
          stars: 3,
        }),
      ],
      config: { nonMirrorTripleMinClanStars: 999, allBasesOpenHoursLeft: 0 },
      attacksUsed: 1,
    });
    expect(reason.hasViolation).toBe(false);
  });
});
