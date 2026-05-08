import { beforeEach, describe, expect, it, vi } from "vitest";
import { Defer } from "../src/commands/Defer";

const prismaMock = vi.hoisted(() => ({
  clanNotifyConfig: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  weightInputDeferment: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  playerCurrent: {
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function makeInteraction(input: { playerTag: string; weight: string }) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn().mockReturnValue("add"),
      getString: vi.fn((name: string) => {
        if (name === "player-tag") return input.playerTag;
        if (name === "weight") return input.weight;
        return null;
      }),
    },
  };
}

describe("/defer add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.clanNotifyConfig.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findUnique.mockResolvedValue(null);
    prismaMock.weightInputDeferment.upsert.mockResolvedValue({
      id: "defer-1",
      guildId: "guild-1",
      clanTag: "#PQL0289",
      scopeKey: "guild:guild-1|clan:PQL0289",
      playerTag: "#PYLQ0289",
      deferredWeight: 145000,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      status: "open",
    });
    prismaMock.playerCurrent.upsert.mockResolvedValue({});
  });

  it("writes the deferment and upserts the fetched player profile weight", async () => {
    const interaction = makeInteraction({
      playerTag: "#pylq0289",
      weight: "145k",
    });
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        name: "Live Player",
        townHallLevel: 16,
        clan: {
          tag: "#PQL0289",
          name: "Alpha Clan",
        },
      }),
    };

    await Defer.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#PYLQ0289");
    expect(prismaMock.playerCurrent.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.weightInputDeferment.upsert).toHaveBeenCalledTimes(1);
    expect(
      prismaMock.playerCurrent.upsert.mock.invocationCallOrder[0],
    ).toBeLessThan(prismaMock.weightInputDeferment.upsert.mock.invocationCallOrder[0]);
    expect(prismaMock.weightInputDeferment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          playerTag: "#PYLQ0289",
          deferredWeight: 145000,
        }),
      }),
    );
    expect(prismaMock.playerCurrent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerTag: "#PYLQ0289" },
        create: expect.objectContaining({
          playerTag: "#PYLQ0289",
          playerName: "Live Player",
          townHall: 16,
          currentClanTag: "#PQL0289",
          currentClanName: "Alpha Clan",
          currentWeight: 145000,
        }),
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      "created: #PYLQ0289 queued at 145000 in #PQL0289.",
    );
  });

  it("returns already_exists without calling cocService.getPlayerRaw when an open deferment already exists", async () => {
    prismaMock.weightInputDeferment.findUnique.mockResolvedValue({
      id: "defer-open-1",
      guildId: "guild-1",
      clanTag: "#PQL0289",
      scopeKey: "guild:guild-1|clan:PQL0289",
      playerTag: "#PYLQ0289",
      deferredWeight: 145000,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      status: "open",
    });
    const interaction = makeInteraction({
      playerTag: "#pylq0289",
      weight: "145k",
    });
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    await Defer.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(prismaMock.playerCurrent.upsert).not.toHaveBeenCalled();
    expect(prismaMock.weightInputDeferment.upsert).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "already_exists: #PYLQ0289 is already open in #PQL0289.",
    );
  });

  it("returns not_found when the player profile cannot be fetched", async () => {
    const interaction = makeInteraction({
      playerTag: "#220PUR9JG",
      weight: "145k",
    });
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue(null),
    };

    await Defer.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#220PUR9JG");
    expect(prismaMock.weightInputDeferment.upsert).not.toHaveBeenCalled();
    expect(prismaMock.playerCurrent.upsert).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "not_found: player profile for #220PUR9JG could not be resolved.",
    );
  });

  it("returns a lookup failure message when getPlayerRaw throws", async () => {
    const interaction = makeInteraction({
      playerTag: "#220PUR9JG",
      weight: "145k",
    });
    const cocService = {
      getPlayerRaw: vi.fn().mockRejectedValue(new Error("cooc timeout")),
    };

    await Defer.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#220PUR9JG");
    expect(prismaMock.weightInputDeferment.upsert).not.toHaveBeenCalled();
    expect(prismaMock.playerCurrent.upsert).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "failed: player profile lookup failed for #220PUR9JG. Check bot logs.",
    );
  });

  it("does not write the deferment row when playerCurrent upsert fails", async () => {
    const interaction = makeInteraction({
      playerTag: "#220PUR9JG",
      weight: "145k",
    });
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#220PUR9JG",
        name: "Live Player",
        townHallLevel: 16,
        clan: {
          tag: "#PQL0289",
          name: "Alpha Clan",
        },
      }),
    };
    prismaMock.playerCurrent.upsert.mockRejectedValueOnce(
      new Error("player_current_failed"),
    );

    await Defer.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#220PUR9JG");
    expect(prismaMock.playerCurrent.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.weightInputDeferment.upsert).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "failed: unable to save deferment for #220PUR9JG. Check bot logs.",
    );
  });

  it("does not write the deferment row when the deferment insert fails", async () => {
    const interaction = makeInteraction({
      playerTag: "#220PUR9JG",
      weight: "145k",
    });
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#220PUR9JG",
        name: "Live Player",
        townHallLevel: 16,
        clan: {
          tag: "#PQL0289",
          name: "Alpha Clan",
        },
      }),
    };
    prismaMock.weightInputDeferment.upsert.mockRejectedValueOnce(
      new Error("deferment_failed"),
    );

    await Defer.run({} as any, interaction as any, cocService as any);

    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#220PUR9JG");
    expect(prismaMock.playerCurrent.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.weightInputDeferment.upsert).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      "failed: unable to save deferment for #220PUR9JG. Check bot logs.",
    );
  });
});
