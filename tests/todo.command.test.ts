import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
  },
  todoPlayerSnapshot: {
    aggregate: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaWarMemberCurrent: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(async (arg: any) => {
    if (typeof arg === "function") {
      return arg({
        todoPlayerSnapshot: {
          upsert: vi.fn().mockResolvedValue(undefined),
        },
      });
    }
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg;
  }),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildTodoPageButtonCustomId,
  handleTodoPageButtonInteraction,
  Todo,
} from "../src/commands/Todo";
import { resetTodoRenderCacheForTest } from "../src/services/TodoService";

type TodoType = "WAR" | "CWL" | "RAIDS" | "GAMES";

function makeTodoInteraction(input: { type: TodoType; userId?: string }) {
  return {
    user: { id: input.userId ?? "111111111111111111" },
    options: {
      getString: vi.fn((name: string) => (name === "type" ? input.type : null)),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTodoButtonInteraction(input: {
  customId: string;
  userId?: string;
}) {
  return {
    customId: input.customId,
    user: { id: input.userId ?? "111111111111111111" },
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    deferred: false,
    replied: false,
  };
}

function makeSnapshotRow(input: {
  playerTag: string;
  playerName: string;
  clanTag?: string | null;
  clanName?: string | null;
  warActive?: boolean;
  warAttacksUsed?: number;
  warAttacksMax?: number;
  warPhase?: string | null;
  warEndsAt?: Date | null;
  cwlActive?: boolean;
  cwlAttacksUsed?: number;
  cwlAttacksMax?: number;
  cwlPhase?: string | null;
  cwlEndsAt?: Date | null;
  raidActive?: boolean;
  raidAttacksUsed?: number;
  raidAttacksMax?: number;
  raidEndsAt?: Date | null;
  gamesActive?: boolean;
  gamesPoints?: number | null;
  gamesTarget?: number | null;
  gamesEndsAt?: Date | null;
  lastUpdatedAt?: Date;
  updatedAt?: Date;
}) {
  const now = new Date("2026-03-26T00:00:00.000Z");
  return {
    playerTag: input.playerTag,
    playerName: input.playerName,
    clanTag: input.clanTag ?? "#PQL0289",
    clanName: input.clanName ?? "Clan One",
    warActive: input.warActive ?? true,
    warAttacksUsed: input.warAttacksUsed ?? 0,
    warAttacksMax: input.warAttacksMax ?? 2,
    warPhase: input.warPhase ?? "battle day",
    warEndsAt: input.warEndsAt ?? new Date("2026-03-31T12:00:00.000Z"),
    cwlActive: input.cwlActive ?? true,
    cwlAttacksUsed: input.cwlAttacksUsed ?? 0,
    cwlAttacksMax: input.cwlAttacksMax ?? 1,
    cwlPhase: input.cwlPhase ?? "preparation",
    cwlEndsAt: input.cwlEndsAt ?? new Date("2026-03-30T12:00:00.000Z"),
    raidActive: input.raidActive ?? true,
    raidAttacksUsed: input.raidAttacksUsed ?? 0,
    raidAttacksMax: input.raidAttacksMax ?? 6,
    raidEndsAt: input.raidEndsAt ?? new Date("2026-03-29T07:00:00.000Z"),
    gamesActive: input.gamesActive ?? true,
    gamesPoints: input.gamesPoints ?? 1200,
    gamesTarget: input.gamesTarget ?? 4000,
    gamesEndsAt: input.gamesEndsAt ?? new Date("2026-03-28T08:00:00.000Z"),
    lastUpdatedAt: input.lastUpdatedAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function makeCocServiceSpy() {
  return {
    getPlayerRaw: vi.fn(),
    getCurrentWar: vi.fn(),
    getClanWarLeagueGroup: vi.fn(),
    getClanWarLeagueWar: vi.fn(),
  };
}

function getReplyDescription(interaction: any): string {
  const payload = interaction.editReply.mock.calls[0]?.[0] as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

function getReplyTitle(interaction: any): string {
  const payload = interaction.editReply.mock.calls[0]?.[0] as any;
  return String(payload?.embeds?.[0]?.toJSON?.().title ?? "");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let offset = 0;
  let count = 0;
  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

describe("/todo command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTodoRenderCacheForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T00:00:00.000Z"));

    prismaMock.playerLink.findMany.mockReset();
    prismaMock.todoPlayerSnapshot.aggregate.mockReset();
    prismaMock.todoPlayerSnapshot.findMany.mockReset();
    prismaMock.todoPlayerSnapshot.upsert.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fwaWarMemberCurrent.findMany.mockReset();
    prismaMock.currentWar.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.$transaction.mockClear();

    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _max: { updatedAt: null },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a clear error when the invoking user has no linked tags", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    const interaction = makeTodoInteraction({ type: "WAR" });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("no_linked_tags"),
    );
  });

  it("builds from snapshots, opens on requested page, and avoids live coc aggregation", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        cwlAttacksUsed: 1,
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        cwlAttacksUsed: 0,
      }),
    ]);

    const cocService = makeCocServiceSpy();
    const interaction = makeTodoInteraction({ type: "CWL" });
    await Todo.run({} as any, interaction as any, cocService as any);

    const description = getReplyDescription(interaction);
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(getReplyTitle(interaction)).toBe("Todo - CWL");
    expect(description).toContain("**Clan One (#PQL0289) - preparation ends <t:");
    expect(description).toContain("CWL attacks: 1/1");
    expect(payload.components[0].components.map((b: any) => b.toJSON().label)).toEqual([
      "WAR",
      "CWL",
      "RAIDS",
      "GAMES",
    ]);
    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(cocService.getClanWarLeagueGroup).not.toHaveBeenCalled();
    expect(cocService.getClanWarLeagueWar).not.toHaveBeenCalled();
  });

  it("renders WAR grouped sections by shared context with neutral non-active rows", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
      { playerTag: "#CUV9082", createdAt: new Date("2026-03-03T00:00:00.000Z") },
      { playerTag: "#LQ9P8R2", createdAt: new Date("2026-03-04T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 4 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warAttacksUsed: 1,
        warPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warAttacksUsed: 2,
        warPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#CUV9082",
        playerName: "Charlie",
        clanTag: "#2QG2C08UP",
        clanName: "Clan Two",
        warAttacksUsed: 0,
        warPhase: "preparation",
        warEndsAt: new Date("2026-03-30T18:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#LQ9P8R2",
        playerName: "Delta",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warActive: false,
        warAttacksUsed: 0,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(getReplyTitle(interaction)).toBe("Todo - WAR");
    expect(description).toContain("**Clan One (#PQL0289) - battle day ends <t:");
    expect(description).toContain("**Clan Two (#2QG2C08UP) - preparation ends <t:");
    expect(description).toContain("- Alpha #PYLQ0289 - war attacks: 1/2");
    expect(description).toContain("- Bravo #QGRJ2222 - war attacks: 2/2");
    expect(description).toContain("**Not in active war**");
    expect(description).toContain("- Delta #LQ9P8R2 - war attacks: 0/2 - not in active war");
  });

  it("renders CWL grouped sections by shared context with neutral non-active rows", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
      { playerTag: "#CUV9082", createdAt: new Date("2026-03-03T00:00:00.000Z") },
      { playerTag: "#LQ9P8R2", createdAt: new Date("2026-03-04T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 4 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        cwlAttacksUsed: 1,
        cwlPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        cwlAttacksUsed: 0,
        cwlPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#CUV9082",
        playerName: "Charlie",
        clanTag: "#2QG2C08UP",
        clanName: "Clan Two",
        cwlAttacksUsed: 1,
        cwlPhase: "preparation",
        cwlEndsAt: new Date("2026-03-29T18:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#LQ9P8R2",
        playerName: "Delta",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        cwlActive: false,
        cwlAttacksUsed: 0,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "CWL" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(getReplyTitle(interaction)).toBe("Todo - CWL");
    expect(description).toContain("**Clan One (#PQL0289) - battle day ends <t:");
    expect(description).toContain("**Clan Two (#2QG2C08UP) - preparation ends <t:");
    expect(description).toContain("- Alpha #PYLQ0289 - CWL attacks: 1/1");
    expect(description).toContain("- Bravo #QGRJ2222 - CWL attacks: 0/1");
    expect(description).toContain("**Not in active CWL**");
    expect(description).toContain(
      "- Delta #LQ9P8R2 - CWL attacks: 0/1 - not in active CWL war",
    );
  });

  it("shows explicit inactive WAR page message when no active war contexts exist", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        warActive: false,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);
    expect(getReplyDescription(interaction)).toContain("No war active");
  });

  it("shows explicit inactive CWL page message when no active CWL contexts exist", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        cwlActive: false,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "CWL" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);
    expect(getReplyDescription(interaction)).toContain("No CWL active");
  });

  it("shows explicit inactive RAIDS page message when raid weekend is not active", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        raidActive: false,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "RAIDS" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);
    expect(getReplyDescription(interaction)).toContain("No raids active");
  });

  it("shows explicit inactive GAMES page message when clan games is not active", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        gamesActive: false,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "GAMES" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);
    expect(getReplyDescription(interaction)).toContain("Clan Games is not active");
  });

  it("renders RAIDS with one shared top timer and per-player usage rows", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        raidActive: true,
        raidAttacksUsed: 3,
        raidEndsAt: new Date("2026-03-29T07:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        raidActive: true,
        raidAttacksUsed: 1,
        raidEndsAt: new Date("2026-03-29T07:00:00.000Z"),
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "RAIDS" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("**Time remaining:** <t:");
    expect(countOccurrences(description, "<t:")).toBe(1);
    expect(description).toContain("- Alpha #PYLQ0289 - clan capital raids: 3/6");
    expect(description).toContain("- Bravo #QGRJ2222 - clan capital raids: 1/6");
  });

  it("renders GAMES with one shared top timer, points, and 4000+ completion marker", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
      { playerTag: "#CUV9082", createdAt: new Date("2026-03-03T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 3 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        gamesActive: true,
        gamesPoints: 3999,
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        gamesActive: true,
        gamesPoints: 4000,
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#CUV9082",
        playerName: "Charlie",
        gamesActive: true,
        gamesPoints: 5200,
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "GAMES" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("**Time remaining:** <t:");
    expect(countOccurrences(description, "<t:")).toBe(1);
    expect(description).toContain("- Alpha #PYLQ0289 - clan games points: 3999/4000");
    expect(description).toContain(
      "- :white_check_mark: Bravo #QGRJ2222 - clan games points: 4000/4000",
    );
    expect(description).toContain(
      "- :white_check_mark: Charlie #CUV9082 - clan games points: 5200/4000",
    );
  });
});

describe("/todo pagination buttons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTodoRenderCacheForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T00:00:00.000Z"));

    prismaMock.playerLink.findMany.mockReset();
    prismaMock.todoPlayerSnapshot.aggregate.mockReset();
    prismaMock.todoPlayerSnapshot.findMany.mockReset();

    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        warAttacksUsed: 1,
        cwlAttacksUsed: 1,
        raidAttacksUsed: 3,
        gamesPoints: 1200,
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        warAttacksUsed: 2,
        cwlAttacksUsed: 0,
        raidAttacksUsed: 0,
        gamesPoints: 4000,
      }),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("paginates across WAR/CWL/RAIDS/GAMES with user-scoped access", async () => {
    const checks: Array<{ type: TodoType; contains: string }> = [
      { type: "WAR", contains: "war attacks:" },
      { type: "CWL", contains: "CWL attacks:" },
      { type: "RAIDS", contains: "clan capital raids:" },
      { type: "GAMES", contains: "clan games points:" },
    ];

    for (const check of checks) {
      const interaction = makeTodoButtonInteraction({
        customId: buildTodoPageButtonCustomId("111111111111111111", check.type),
      });
      await handleTodoPageButtonInteraction(interaction as any, makeCocServiceSpy() as any);

      expect(interaction.update).toHaveBeenCalledTimes(1);
      const payload = interaction.update.mock.calls[0]?.[0] as any;
      const embed = payload.embeds[0].toJSON();
      expect(embed.title).toBe(`Todo - ${check.type}`);
      expect(String(embed.description ?? "")).toContain(check.contains);
      expect(interaction.reply).not.toHaveBeenCalled();
    }
  });

  it("keeps cache scoped by user identity for repeated interactions", async () => {
    prismaMock.playerLink.findMany.mockImplementation(async (args: any) => {
      const userId = String(args?.where?.discordUserId ?? "");
      if (userId === "111111111111111111") {
        return [
          { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
          { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
        ];
      }
      return [
        { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
        { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
      ];
    });

    const firstUserWar = makeTodoButtonInteraction({
      customId: buildTodoPageButtonCustomId("111111111111111111", "WAR"),
    });
    await handleTodoPageButtonInteraction(firstUserWar as any, makeCocServiceSpy() as any);

    const firstUserCwl = makeTodoButtonInteraction({
      customId: buildTodoPageButtonCustomId("111111111111111111", "CWL"),
    });
    await handleTodoPageButtonInteraction(firstUserCwl as any, makeCocServiceSpy() as any);

    const secondUserWar = makeTodoButtonInteraction({
      customId: buildTodoPageButtonCustomId("222222222222222222", "WAR"),
      userId: "222222222222222222",
    });
    await handleTodoPageButtonInteraction(secondUserWar as any, makeCocServiceSpy() as any);

    expect(prismaMock.todoPlayerSnapshot.findMany).toHaveBeenCalledTimes(2);
  });

  it("rejects button interactions from non-requesting users", async () => {
    const interaction = makeTodoButtonInteraction({
      customId: buildTodoPageButtonCustomId("111111111111111111", "WAR"),
      userId: "222222222222222222",
    });

    await handleTodoPageButtonInteraction(interaction as any, makeCocServiceSpy() as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    expect(interaction.update).not.toHaveBeenCalled();
  });
});
