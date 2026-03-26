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

  it("builds from snapshots, opens on requested type, and avoids live coc aggregation", async () => {
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

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe("Todo - CWL");
    expect(String(embed.description ?? "")).toContain("CWL attacks: 1/1");
    expect(String(embed.description ?? "")).toContain("CWL attacks: 0/1");
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

  it("opens on WAR when requested and renders WAR usage from snapshots", async () => {
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
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        warAttacksUsed: 2,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe("Todo - WAR");
    expect(String(embed.description ?? "")).toContain("war attacks: 1/2");
    expect(String(embed.description ?? "")).toContain("war attacks: 2/2");
  });

  it("renders stale and missing snapshots with neutral/unavailable rows", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { updatedAt: new Date("2026-03-20T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        warActive: false,
        warAttacksUsed: 0,
        lastUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
        updatedAt: new Date("2026-03-20T00:00:00.000Z"),
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    expect(description).toContain("stale snapshot");
    expect(description).toContain("snapshot unavailable");
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
        gamesPoints: 3500,
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
      { type: "GAMES", contains: "clan games:" },
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