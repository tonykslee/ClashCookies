import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMock = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/services/ClanHealthSnapshotService", () => ({
  ClanHealthSnapshotService: class {
    getSnapshot = serviceMock.getSnapshot;
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { ClanHealth } from "../src/commands/ClanHealth";

function makeInteraction(tagValue: string) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    guildId: "guild-1",
    deferReply,
    editReply,
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        if (name === "tag") return tagValue;
        if (name === "visibility") return "private";
        if (required) return tagValue;
        return null;
      }),
      getFocused: vi.fn().mockReturnValue({ name: "tag", value: "alp" }),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/clan-health command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders leadership metrics and does not call external CoC API", async () => {
    serviceMock.getSnapshot.mockResolvedValue({
      clanTag: "#AAA111",
      clanName: "Alpha",
      warMetrics: {
        windowSize: 30,
        endedWarSampleSize: 20,
        fwaMatchCount: 14,
        winCount: 11,
      },
      inactiveWars: {
        windowSize: 3,
        warsAvailable: 3,
        warsSampled: 3,
        inactivePlayerCount: 2,
      },
      inactiveDays: {
        thresholdDays: 7,
        staleHours: 6,
        observedMemberCount: 40,
        inactivePlayerCount: 5,
      },
      missingLinks: {
        observedMemberCount: 40,
        linkedMemberCount: 35,
        missingMemberCount: 5,
      },
      telemetry: {
        warRows: 20,
        participationRows: 100,
        activityRows: 40,
        linkRows: 35,
        durationMs: 7,
      },
    });

    const interaction = makeInteraction("AAA111");
    const cocService = { getCurrentWar: vi.fn(), getClan: vi.fn(), getPlayerRaw: vi.fn() };
    await ClanHealth.run({} as any, interaction as any, cocService as any);

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(cocService.getClan).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
      })
    );
    const payload = interaction.editReply.mock.calls[0]?.[0];
    const embedJson = payload.embeds[0].toJSON();
    expect(embedJson.title).toContain("Clan Health");
    expect(embedJson.fields.map((field: any) => field.name)).toEqual([
      "War Performance",
      "Inactivity",
      "Discord Links",
    ]);
  });

  it("supports tracked-clan autocomplete for tag", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { name: "Alpha", tag: "#AAA111" },
      { name: "Bravo", tag: "#BBB222" },
    ]);
    const interaction = makeInteraction("AAA111");
    interaction.options.getFocused.mockReturnValue({ name: "tag", value: "alp" });

    await ClanHealth.autocomplete?.(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha (#AAA111)", value: "AAA111" },
    ]);
  });
});
