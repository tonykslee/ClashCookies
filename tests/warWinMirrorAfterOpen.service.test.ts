import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import * as PlayerLinkService from "../src/services/PlayerLinkService";
import { WarComplianceService } from "../src/services/WarComplianceService";
import { WIN_UNCLEARED_MIRROR_AFTER_OPEN_REASON } from "../src/services/war-events/core";

const warStartTime = new Date("2026-04-01T00:00:00.000Z");
const warEndTime = new Date("2026-04-02T00:00:00.000Z");

type Participant = {
  playerName: string;
  playerTag: string;
  attacksUsed: number;
  playerPosition: number;
};

type Attack = {
  playerTag: string;
  playerName: string;
  playerPosition: number;
  defenderPosition: number;
  stars: number;
  trueStars: number;
  attackSeenAt: Date;
  warEndTime: Date;
  attackOrder: number;
  warStartTime: Date;
};

async function evaluateCurrent(input: {
  participants: Participant[];
  attacks: Attack[];
  customPlan?: Record<string, unknown> | null;
  defaultPlan?: Record<string, unknown> | null;
  links?: Array<{ playerTag: string; discordUserId: string }>;
}) {
  vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue({
    warId: 9001,
    startTime: warStartTime,
    endTime: warEndTime,
    matchType: "FWA",
    outcome: "WIN",
  } as any);
  vi.spyOn(prisma.warAttacks, "findMany").mockImplementation(
    (async (args?: any) =>
      args?.where?.attackOrder === 0
        ? input.participants.map((row) => ({ ...row, warStartTime }))
        : input.attacks) as typeof prisma.warAttacks.findMany,
  );
  vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
    loseStyle: "TRADITIONAL",
  } as any);
  vi.spyOn(prisma.clanWarPlan, "findFirst")
    .mockResolvedValueOnce(input.customPlan as any)
    .mockResolvedValueOnce(input.defaultPlan as any);
  vi.spyOn(PlayerLinkService, "listPlayerLinksForClanMembers").mockResolvedValue(
    (input.links ?? []) as any,
  );

  return new WarComplianceService().evaluateComplianceForCommand({
    guildId: "guild-1",
    clanTag: "#TEST",
    scope: "current",
    warId: 9001,
  });
}

function attack(input: {
  playerTag: string;
  playerName: string;
  playerPosition: number;
  defenderPosition: number;
  stars: number;
  attackOrder: number;
  hour: number;
}): Attack {
  return {
    ...input,
    trueStars: input.stars,
    attackSeenAt: new Date(
      `2026-04-01T${String(input.hour).padStart(2, "0")}:00:00.000Z`,
    ),
    warEndTime,
    warStartTime,
  };
}

describe("WarComplianceService FWA-WIN mirror-after-open policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const owner: Participant = {
    playerName: "owner",
    playerTag: "#P",
    attacksUsed: 2,
    playerPosition: 1,
  };
  const strictMirrorThenOpenElsewhere = [
    attack({
      playerTag: "#P",
      playerName: "owner",
      playerPosition: 1,
      defenderPosition: 1,
      stars: 2,
      attackOrder: 1,
      hour: 1,
    }),
    attack({
      playerTag: "#P",
      playerName: "owner",
      playerPosition: 1,
      defenderPosition: 2,
      stars: 1,
      attackOrder: 2,
      hour: 2,
    }),
  ];

  it("returns the effective WIN flag and preserves custom/default precedence", async () => {
    const enabled = await evaluateCurrent({
      participants: [owner],
      attacks: strictMirrorThenOpenElsewhere,
      customPlan: {
        nonMirrorTripleMinClanStars: 2,
        allBasesOpenHoursLeft: 0,
        winRequireMirrorAfterOpen: true,
      },
      defaultPlan: { winRequireMirrorAfterOpen: false },
    });
    expect(enabled.report?.fwaWinGateConfig?.winRequireMirrorAfterOpen).toBe(true);

    vi.restoreAllMocks();
    const explicitFalse = await evaluateCurrent({
      participants: [owner],
      attacks: strictMirrorThenOpenElsewhere,
      customPlan: {
        nonMirrorTripleMinClanStars: 2,
        allBasesOpenHoursLeft: 0,
        winRequireMirrorAfterOpen: false,
      },
      defaultPlan: { winRequireMirrorAfterOpen: true },
    });
    expect(explicitFalse.report?.fwaWinGateConfig?.winRequireMirrorAfterOpen).toBe(
      false,
    );
  });

  it("keeps OFF compliant after the final attack crosses into open", async () => {
    const result = await evaluateCurrent({
      participants: [owner],
      attacks: strictMirrorThenOpenElsewhere,
      customPlan: {
        nonMirrorTripleMinClanStars: 2,
        allBasesOpenHoursLeft: 0,
        winRequireMirrorAfterOpen: false,
      },
      defaultPlan: null,
    });

    expect(result.report?.notFollowingPlan).toEqual([]);
  });

  it("reports the ON open-phase obligation without fabricated breach context", async () => {
    const result = await evaluateCurrent({
      participants: [owner],
      attacks: strictMirrorThenOpenElsewhere,
      customPlan: {
        nonMirrorTripleMinClanStars: 2,
        allBasesOpenHoursLeft: 0,
        winRequireMirrorAfterOpen: true,
      },
      defaultPlan: null,
    });

    expect(result.report?.notFollowingPlan).toHaveLength(1);
    expect(result.report?.notFollowingPlan[0]?.reasonLabel).toBe(
      WIN_UNCLEARED_MIRROR_AFTER_OPEN_REASON,
    );
    expect(result.report?.notFollowingPlan[0]?.breachContext).toBeNull();
  });

  it("allows a linked member's open triple to satisfy the owner's ON obligation", async () => {
    const linkedOwner = { ...owner, playerName: "linked-owner" };
    const linkedMember: Participant = {
      playerName: "linked-member",
      playerTag: "#Q",
      attacksUsed: 1,
      playerPosition: 2,
    };
    const result = await evaluateCurrent({
      participants: [linkedOwner, linkedMember],
      attacks: [
        ...strictMirrorThenOpenElsewhere,
        attack({
          playerTag: "#Q",
          playerName: "linked-member",
          playerPosition: 2,
          defenderPosition: 1,
          stars: 3,
          attackOrder: 3,
          hour: 3,
        }),
      ],
      customPlan: {
        nonMirrorTripleMinClanStars: 2,
        allBasesOpenHoursLeft: 0,
        winRequireMirrorAfterOpen: true,
      },
      defaultPlan: null,
      links: [
        { playerTag: "#P", discordUserId: "user-1" },
        { playerTag: "#Q", discordUserId: "user-1" },
      ],
    });

    expect(result.report?.notFollowingPlan).toEqual([]);
  });

  it("retains a linked owner's unresolved ON obligation after open", async () => {
    const linkedMember: Participant = {
      playerName: "linked-member",
      playerTag: "#Q",
      attacksUsed: 0,
      playerPosition: 2,
    };
    const result = await evaluateCurrent({
      participants: [owner, linkedMember],
      attacks: strictMirrorThenOpenElsewhere,
      customPlan: {
        nonMirrorTripleMinClanStars: 0,
        allBasesOpenHoursLeft: 0,
        winRequireMirrorAfterOpen: true,
      },
      defaultPlan: null,
      links: [
        { playerTag: "#P", discordUserId: "user-1" },
        { playerTag: "#Q", discordUserId: "user-1" },
      ],
    });

    expect(result.report?.notFollowingPlan.map((row) => row.playerTag)).toEqual([
      "#P",
    ]);
    expect(result.report?.notFollowingPlan[0]?.reasonLabel).toBe(
      WIN_UNCLEARED_MIRROR_AFTER_OPEN_REASON,
    );
  });

  it("does not retain an OFF linked obligation after the owner finishes open", async () => {
    const linkedMember: Participant = {
      playerName: "linked-member",
      playerTag: "#Q",
      attacksUsed: 0,
      playerPosition: 2,
    };
    const result = await evaluateCurrent({
      participants: [owner, linkedMember],
      attacks: strictMirrorThenOpenElsewhere,
      customPlan: {
        nonMirrorTripleMinClanStars: 2,
        allBasesOpenHoursLeft: 0,
        winRequireMirrorAfterOpen: false,
      },
      defaultPlan: null,
      links: [
        { playerTag: "#P", discordUserId: "user-1" },
        { playerTag: "#Q", discordUserId: "user-1" },
      ],
    });

    expect(result.report?.notFollowingPlan).toEqual([]);
    expect(
      PlayerLinkService.listPlayerLinksForClanMembers,
    ).toHaveBeenCalledTimes(1);
  });
});
