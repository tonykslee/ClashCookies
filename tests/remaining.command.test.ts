import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  currentWar: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Remaining } from "../src/commands/Remaining";

/** Purpose: create a minimal chat-command interaction mock for /remaining war tests. */
function makeInteraction(params: { tag: string | null; guildId?: string | null }) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    guildId: params.guildId ?? "guild-1",
    deferReply,
    editReply,
    options: {
      getSubcommand: vi.fn().mockReturnValue("war"),
      getString: vi.fn((name: string) => {
        if (name === "tag") return params.tag;
        return null;
      }),
    },
  };
  return { interaction, deferReply, editReply };
}

describe("/remaining war command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps single-tag behavior using persisted CurrentWar state only", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
    });
    prismaMock.currentWar.findUnique.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      state: "preparation",
      startTime: new Date("2026-03-08T10:00:00.000Z"),
      endTime: new Date("2026-03-09T10:00:00.000Z"),
    });

    const cocService = { getCurrentWar: vi.fn() };
    const { interaction, editReply } = makeInteraction({ tag: "2QG2C08UP" });

    await Remaining.run({} as any, interaction as any, cocService as any);

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.currentWar.findUnique).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining("Current phase: **Preparation Day**")
    );
  });

  it("returns aggregate dominant-cluster summary when tag is omitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T00:00:00.000Z"));

    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#A", name: "Alpha" },
      { tag: "#B", name: "Bravo" },
      { tag: "#C", name: "Charlie" },
      { tag: "#D", name: "Delta" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#A",
        state: "inWar",
        startTime: new Date("2026-03-07T00:00:00.000Z"),
        endTime: new Date("2026-03-08T01:00:00.000Z"),
      },
      {
        clanTag: "#B",
        state: "inWar",
        startTime: new Date("2026-03-07T00:00:00.000Z"),
        endTime: new Date("2026-03-08T01:05:00.000Z"),
      },
      {
        clanTag: "#C",
        state: "inWar",
        startTime: new Date("2026-03-07T00:00:00.000Z"),
        endTime: new Date("2026-03-08T01:10:00.000Z"),
      },
      {
        clanTag: "#D",
        state: "inWar",
        startTime: new Date("2026-03-07T00:00:00.000Z"),
        endTime: new Date("2026-03-08T02:30:00.000Z"),
      },
    ]);

    const cocService = { getCurrentWar: vi.fn() };
    const { interaction, editReply } = makeInteraction({ tag: null });

    await Remaining.run({} as any, interaction as any, cocService as any);

    const output = String(editReply.mock.calls[0]?.[0] ?? "");
    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(output).toContain("Dominant cluster mean remaining");
    expect(output).toContain("Cluster spread");
    expect(output).toContain("Outliers (1)");
    expect(output).toContain("Delta (#D)");
  });

  it("returns no-active-war message in aggregate mode when no rows are active", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#A", name: "Alpha" }]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);

    const cocService = { getCurrentWar: vi.fn() };
    const { interaction, editReply } = makeInteraction({ tag: null });

    await Remaining.run({} as any, interaction as any, cocService as any);

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith("No tracked clans are currently in active war.");
  });
});
