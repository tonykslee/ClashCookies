import { beforeEach, describe, expect, it, vi } from "vitest";

import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
  },
  clanWarHistory: {
    findMany: vi.fn(),
  },
  warLookup: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Fwa } from "../src/commands/Fwa";

function makeInteraction(input: { tag: string | null; focused: string; guildId?: string | null }) {
  return {
    guildId: input.guildId ?? "guild-1",
    options: {
      getFocused: vi.fn().mockReturnValue({ name: "war-id", value: input.focused }),
      getSubcommand: vi.fn().mockReturnValue("compliance"),
      getString: vi.fn((name: string) => {
        if (name === "tag") return input.tag;
        return null;
      }),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/fwa compliance war-id autocomplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zero suggestions when tag is unresolved", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    const interaction = makeInteraction({ tag: "AAA111", focused: "" });

    await Fwa.autocomplete?.(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it("prepends the ongoing war choice before historical wars", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({ tag: "#AAA111" });
    prismaMock.currentWar.findFirst.mockResolvedValue({
      warId: 8123,
      opponentName: "Live Opp",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      { warId: 7002, warEndTime: new Date("2026-03-12T00:00:00.000Z"), opponentName: "Opp 2" },
      { warId: 7001, warEndTime: new Date("2026-03-11T00:00:00.000Z"), opponentName: "Opp 1" },
    ]);
    prismaMock.warLookup.findMany.mockResolvedValue([]);

    const interaction = makeInteraction({ tag: "AAA111", focused: "" });

    await Fwa.autocomplete?.(interaction as any);

    const choices = interaction.respond.mock.calls[0]?.[0] ?? [];
    expect(choices).toEqual([
      { name: "Ongoing | 8123 | Live Opp", value: "Ongoing" },
      { name: "7002 | ended: 03/11 | Opp 2", value: "7002" },
      { name: "7001 | ended: 03/10 | Opp 1", value: "7001" },
    ]);
  });

  it("returns deterministic top-10 choices with ongoing first, then ended wars sorted by endedAt then warId", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({ tag: "#AAA111" });
    prismaMock.currentWar.findFirst.mockResolvedValue({
      warId: 8123,
      opponentName: "Live Opp",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      { warId: 7001, warEndTime: new Date("2026-03-12T00:00:00.000Z"), opponentName: "Opp 1" },
      { warId: 7002, warEndTime: new Date("2026-03-12T00:00:00.000Z"), opponentName: "Opp 2" },
      { warId: 7003, warEndTime: new Date("2026-03-11T00:00:00.000Z"), opponentName: "Opp 3" },
      { warId: 7004, warEndTime: new Date("2026-03-10T00:00:00.000Z"), opponentName: "Opp 4" },
      { warId: 7005, warEndTime: new Date("2026-03-09T00:00:00.000Z"), opponentName: "Opp 5" },
      { warId: 7006, warEndTime: new Date("2026-03-08T00:00:00.000Z"), opponentName: "Opp 6" },
      { warId: 7007, warEndTime: new Date("2026-03-07T00:00:00.000Z"), opponentName: "Opp 7" },
      { warId: 7008, warEndTime: new Date("2026-03-06T00:00:00.000Z"), opponentName: "Opp 8" },
      { warId: 7009, warEndTime: new Date("2026-03-05T00:00:00.000Z"), opponentName: "Opp 9" },
      { warId: 7010, warEndTime: new Date("2026-03-04T00:00:00.000Z"), opponentName: "Opp 10" },
      { warId: 7011, warEndTime: new Date("2026-03-03T00:00:00.000Z"), opponentName: "Opp 11" },
      { warId: 7012, warEndTime: new Date("2026-03-02T00:00:00.000Z"), opponentName: "Opp 12" },
    ]);
    prismaMock.warLookup.findMany.mockResolvedValue([
      {
        warId: "7999",
        endTime: new Date("2026-03-20T00:00:00.000Z"),
        payload: { opponent: { name: "Lookup Opp" } },
      },
    ]);

    const interaction = makeInteraction({ tag: "AAA111", focused: "" });

    await Fwa.autocomplete?.(interaction as any);

    expect(prismaMock.currentWar.findFirst).toHaveBeenCalled();
    expect(prismaMock.clanWarHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ clanTag: "#AAA111" }, { clanTag: "AAA111" }]),
        }),
      })
    );

    const choices = interaction.respond.mock.calls[0]?.[0] ?? [];
    expect(choices).toHaveLength(10);
    expect(choices.map((choice: { value: string }) => choice.value)).toEqual([
      "Ongoing",
      "7999",
      "7002",
      "7001",
      "7003",
      "7004",
      "7005",
      "7006",
      "7007",
      "7008",
    ]);
  });

  it("applies focused-input filtering to ongoing and historical choices", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({ tag: "#AAA111" });
    prismaMock.currentWar.findFirst.mockResolvedValue({
      warId: 8123,
      opponentName: "Live Opp",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      { warId: 9001, warEndTime: null, opponentName: null },
      { warId: 9002, warEndTime: new Date("2026-03-10T00:00:00.000Z"), opponentName: "Bravo" },
      { warId: 9003, warEndTime: new Date("2026-03-09T00:00:00.000Z"), opponentName: "Alpha" },
    ]);
    prismaMock.warLookup.findMany.mockResolvedValue([]);

    const interaction = makeInteraction({ tag: "AAA111", focused: "ongoing" });

    await Fwa.autocomplete?.(interaction as any);

    const choices = interaction.respond.mock.calls[0]?.[0] ?? [];
    expect(choices).toEqual([{ name: "Ongoing | 8123 | Live Opp", value: "Ongoing" }]);
  });

  it("uses unknown opponent fallback deterministically for historical entries", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({ tag: "#AAA111" });
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      { warId: 9001, warEndTime: null, opponentName: null },
      { warId: 9002, warEndTime: new Date("2026-03-10T00:00:00.000Z"), opponentName: "Bravo" },
    ]);
    prismaMock.warLookup.findMany.mockResolvedValue([]);

    const interaction = makeInteraction({ tag: "AAA111", focused: "unknown" });

    await Fwa.autocomplete?.(interaction as any);

    const choices = interaction.respond.mock.calls[0]?.[0] ?? [];
    expect(choices).toHaveLength(1);
    expect(choices[0]).toEqual({
      name: "9001 | ended: ??/?? | Unknown Opponent",
      value: "9001",
    });
  });
});

