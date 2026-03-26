import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildTodoPageButtonCustomId,
  handleTodoPageButtonInteraction,
  Todo,
} from "../src/commands/Todo";

function makeTodoInteraction(input: { type: "WAR" | "CWL" | "RAIDS" | "GAMES"; userId?: string }) {
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

function makeCocServiceMock() {
  return {
    getPlayerRaw: vi.fn((tag: string) => {
      if (tag === "#PYLQ0289") {
        return Promise.resolve({
          tag: "#PYLQ0289",
          name: "Alpha",
          clan: { tag: "#PQL0289", name: "Clan One" },
          achievements: [],
        });
      }
      if (tag === "#QGRJ2222") {
        return Promise.resolve({
          tag: "#QGRJ2222",
          name: "Bravo",
          clan: { tag: "#PQL0289", name: "Clan One" },
          achievements: [],
        });
      }
      return Promise.resolve(null);
    }),
    getCurrentWar: vi.fn().mockResolvedValue({
      state: "inWar",
      endTime: "20260331T120000.000Z",
      clan: {
        tag: "#PQL0289",
        members: [
          { tag: "#PYLQ0289", attacks: [{ order: 1 }] },
          { tag: "#QGRJ2222", attacks: [{ order: 1 }, { order: 2 }] },
        ],
      },
      opponent: {
        tag: "#2QG2C08UP",
        members: [],
      },
    }),
    getClanWarLeagueGroup: vi.fn().mockResolvedValue({
      state: "inWar",
      rounds: [{ warTags: ["#WAR1"] }],
    }),
    getClanWarLeagueWar: vi.fn().mockResolvedValue({
      state: "preparation",
      startTime: "20260330T120000.000Z",
      clan: {
        tag: "#PQL0289",
        members: [
          { tag: "#PYLQ0289", attacks: [{ order: 1 }] },
          { tag: "#QGRJ2222", attacks: [] },
        ],
      },
      opponent: {
        tag: "#2QG2C08UP",
        members: [],
      },
    }),
  };
}

describe("/todo command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T00:00:00.000Z"));
    prismaMock.playerLink.findMany.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a clear error when the invoking user has no linked tags", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    const interaction = makeTodoInteraction({ type: "WAR" });

    await Todo.run({} as any, interaction as any, makeCocServiceMock() as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("no_linked_tags"),
    );
  });

  it("opens on the requested initial page while building the paginated todo view", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);
    const cocService = makeCocServiceMock();
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
  });

  it("opens on WAR when requested and renders WAR attack usage rows", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);
    const interaction = makeTodoInteraction({ type: "WAR" });

    await Todo.run({} as any, interaction as any, makeCocServiceMock() as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe("Todo - WAR");
    expect(String(embed.description ?? "")).toContain("war attacks: 1/2");
    expect(String(embed.description ?? "")).toContain("war attacks: 2/2");
  });
});

describe("/todo pagination buttons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T00:00:00.000Z"));
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("paginates across WAR/CWL/RAIDS/GAMES with user-scoped access", async () => {
    const cocService = makeCocServiceMock();
    const checks: Array<{ type: "WAR" | "CWL" | "RAIDS" | "GAMES"; contains: string }> = [
      { type: "WAR", contains: "war attacks:" },
      { type: "CWL", contains: "CWL attacks:" },
      { type: "RAIDS", contains: "clan capital raids:" },
      { type: "GAMES", contains: "clan games:" },
    ];

    for (const check of checks) {
      const interaction = makeTodoButtonInteraction({
        customId: buildTodoPageButtonCustomId("111111111111111111", check.type),
      });
      await handleTodoPageButtonInteraction(interaction as any, cocService as any);

      expect(interaction.update).toHaveBeenCalledTimes(1);
      const payload = interaction.update.mock.calls[0]?.[0] as any;
      const embed = payload.embeds[0].toJSON();
      expect(embed.title).toBe(`Todo - ${check.type}`);
      expect(String(embed.description ?? "")).toContain(check.contains);
      expect(interaction.reply).not.toHaveBeenCalled();
    }
  });

  it("rejects button interactions from non-requesting users", async () => {
    const interaction = makeTodoButtonInteraction({
      customId: buildTodoPageButtonCustomId("111111111111111111", "WAR"),
      userId: "222222222222222222",
    });

    await handleTodoPageButtonInteraction(interaction as any, makeCocServiceMock() as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    expect(interaction.update).not.toHaveBeenCalled();
  });
});
