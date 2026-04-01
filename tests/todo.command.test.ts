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
  warAttacks: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  botSetting: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(async (arg: any) => {
    if (typeof arg === "function") {
      return arg({
        todoPlayerSnapshot: {
          upsert: vi.fn().mockResolvedValue(undefined),
        },
        cwlPlayerClanSeason: {
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
  buildTodoRefreshButtonCustomId,
  buildTodoPageButtonCustomId,
  handleTodoPageButtonInteraction,
  handleTodoRefreshButtonInteraction,
  Todo,
} from "../src/commands/Todo";
import { resetTodoRenderCacheForTest } from "../src/services/TodoService";
import { todoSnapshotService } from "../src/services/TodoSnapshotService";
import { todoLastViewedTypeService } from "../src/services/TodoLastViewedTypeService";
import { cocRequestQueueService } from "../src/services/CoCRequestQueueService";

type TodoType = "WAR" | "CWL" | "RAIDS" | "GAMES";
const TODO_DEFAULT_EMBED_COLOR = 0x5865f2;
const TODO_INCOMPLETE_EMBED_COLOR = 0xed4245;
const TODO_COMPLETE_EMBED_COLOR = 0x57f287;

function makeTodoInteraction(input: {
  type?: TodoType | null;
  visibility?: "private" | "public" | null;
  userId?: string;
}) {
  return {
    user: { id: input.userId ?? "111111111111111111" },
    options: {
      getString: vi.fn((name: string) => {
        if (name === "type") return input.type ?? null;
        if (name === "visibility") return input.visibility ?? null;
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTodoButtonInteraction(input: {
  customId: string;
  userId?: string;
  messageId?: string;
  guildId?: string | null;
}) {
  return {
    customId: input.customId,
    user: { id: input.userId ?? "111111111111111111" },
    guildId: input.guildId ?? "123456789012345678",
    message: { id: input.messageId ?? "999999999999999999" },
    update: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
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
  cwlClanTag?: string | null;
  cwlClanName?: string | null;
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
  gamesChampionTotal?: number | null;
  gamesSeasonBaseline?: number | null;
  gamesCycleKey?: string | null;
  gamesEndsAt?: Date | null;
  lastUpdatedAt?: Date;
  updatedAt?: Date;
}) {
  const now = new Date("2026-03-26T00:00:00.000Z");
  const hasOwn = <K extends string>(key: K) =>
    Object.prototype.hasOwnProperty.call(input, key);
  return {
    playerTag: input.playerTag,
    playerName: input.playerName,
    clanTag: input.clanTag ?? "#PQL0289",
    clanName: input.clanName ?? "Clan One",
    cwlClanTag: hasOwn("cwlClanTag")
      ? input.cwlClanTag ?? null
      : input.clanTag ?? "#PQL0289",
    cwlClanName: hasOwn("cwlClanName")
      ? input.cwlClanName ?? null
      : input.clanName ?? "Clan One",
    warActive: input.warActive ?? true,
    warAttacksUsed: input.warAttacksUsed ?? 0,
    warAttacksMax: input.warAttacksMax ?? 2,
    warPhase: input.warPhase ?? "battle day",
    warEndsAt: input.warEndsAt ?? new Date("2026-03-31T12:00:00.000Z"),
    cwlActive: input.cwlActive ?? true,
    cwlAttacksUsed: input.cwlAttacksUsed ?? 0,
    cwlAttacksMax: input.cwlAttacksMax ?? 1,
    cwlPhase: hasOwn("cwlPhase") ? input.cwlPhase ?? null : "preparation",
    cwlEndsAt: hasOwn("cwlEndsAt")
      ? input.cwlEndsAt ?? null
      : new Date("2026-03-30T12:00:00.000Z"),
    raidActive: input.raidActive ?? true,
    raidAttacksUsed: input.raidAttacksUsed ?? 0,
    raidAttacksMax: input.raidAttacksMax ?? 6,
    raidEndsAt: input.raidEndsAt ?? new Date("2026-03-29T07:00:00.000Z"),
    gamesActive: input.gamesActive ?? true,
    gamesPoints: input.gamesPoints === undefined ? 1200 : input.gamesPoints,
    gamesTarget: input.gamesTarget === undefined ? 4000 : input.gamesTarget,
    gamesChampionTotal:
      input.gamesChampionTotal === undefined ? 1200 : input.gamesChampionTotal,
    gamesSeasonBaseline:
      input.gamesSeasonBaseline === undefined ? 0 : input.gamesSeasonBaseline,
    gamesCycleKey: input.gamesCycleKey === undefined ? "cycle-2026-03" : input.gamesCycleKey,
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

function getReplyColor(interaction: any): number | null {
  const payload = interaction.editReply.mock.calls[0]?.[0] as any;
  const color = payload?.embeds?.[0]?.toJSON?.().color;
  return typeof color === "number" ? color : null;
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
    vi.restoreAllMocks();
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
    prismaMock.warAttacks.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.cwlTrackedClan.findMany.mockReset();
    prismaMock.cwlPlayerClanSeason.findMany.mockReset();
    prismaMock.cwlPlayerClanSeason.upsert.mockReset();
    prismaMock.botSetting.findMany.mockReset();
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
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.upsert.mockResolvedValue(undefined);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    vi.spyOn(todoSnapshotService, "refreshSnapshotsForPlayerTags").mockResolvedValue({
      playerCount: 0,
      updatedCount: 0,
    });
    vi.spyOn(todoLastViewedTypeService, "getLastViewedType").mockResolvedValue(null);
    vi.spyOn(todoLastViewedTypeService, "setLastViewedType").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns a clear error when the invoking user has no linked tags", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    const refreshSpy = vi.spyOn(todoSnapshotService, "refreshSnapshotsForPlayerTags");
    const interaction = makeTodoInteraction({ type: "WAR" });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("no_linked_tags"),
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("defers publicly when /todo visibility:public is requested", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    const interaction = makeTodoInteraction({
      type: "WAR",
      visibility: "public",
    });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: false });
  });

  it("defers ephemerally when /todo visibility:private is requested", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    const interaction = makeTodoInteraction({
      type: "WAR",
      visibility: "private",
    });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });

  it("defaults /todo visibility to private when omitted", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    const interaction = makeTodoInteraction({ type: "WAR" });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });

  it("rebuilds invoking-user snapshots before initial /todo render", async () => {
    const refreshSpy = vi
      .spyOn(todoSnapshotService, "refreshSnapshotsForPlayerTags")
      .mockResolvedValue({ playerCount: 2, updatedCount: 2 });
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
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
      }),
    ]);
    const interaction = makeTodoInteraction({ type: "WAR" });
    const cocService = makeCocServiceSpy();

    await Todo.run({} as any, interaction as any, cocService as any);

    expect(refreshSpy).toHaveBeenCalledWith({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: expect.anything(),
    });
    const deferOrder = interaction.deferReply.mock.invocationCallOrder[0] ?? 0;
    const refreshOrder = refreshSpy.mock.invocationCallOrder[0] ?? 0;
    const editOrder = interaction.editReply.mock.invocationCallOrder[0] ?? 0;
    expect(deferOrder).toBeGreaterThan(0);
    expect(deferOrder).toBeLessThan(refreshOrder);
    expect(refreshOrder).toBeGreaterThan(0);
    expect(editOrder).toBeGreaterThan(0);
    expect(refreshOrder).toBeLessThan(editOrder);
  });

  it("serves snapshot output without live refresh when CoC queue is degraded", async () => {
    const queueSpy = vi.spyOn(cocRequestQueueService, "getStatus").mockReturnValue({
      queueDepth: 5,
      inFlight: 1,
      penaltyMs: 1200,
      spacingMs: 1320,
      degraded: true,
    });
    const refreshSpy = vi.spyOn(todoSnapshotService, "refreshSnapshotsForPlayerTags");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

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
      }),
    ]);
    const interaction = makeTodoInteraction({ type: "WAR" });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(queueSpy).toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[todo] event=snapshot_served reason=coc_degraded"),
    );
  });

  it("falls back to snapshot output when bounded initial refresh times out", async () => {
    vi.spyOn(cocRequestQueueService, "getStatus").mockReturnValue({
      queueDepth: 0,
      inFlight: 0,
      penaltyMs: 0,
      spacingMs: 120,
      degraded: false,
    });
    vi.spyOn(todoSnapshotService, "refreshSnapshotsForPlayerTags").mockImplementation(
      async () =>
        await new Promise(() => {
          // intentionally unresolved to force timeout-path snapshot fallback
        }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

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
      }),
    ]);
    const interaction = makeTodoInteraction({ type: "WAR" });

    const runPromise = Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);
    await vi.advanceTimersByTimeAsync(3_100);
    await runPromise;

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[todo] event=snapshot_served reason=bounded_refresh_timeout",
      ),
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
    expect(description).toContain("CWL Status: Not in war yet");
    expect(description).toContain(
      "[Clan One](https://link.clashofclans.com/en?action=OpenClanProfile&tag=PQL0289) `#PQL0289` - Next war <t:",
    );
    expect(description).toContain(":black_circle: Alpha - `0 / 0`");
    expect(payload.components[0].components.map((b: any) => b.toJSON().label)).toEqual([
      "WAR",
      "CWL",
      "RAIDS",
      "GAMES",
    ]);
    const refreshButton = payload.components[1].components[0].toJSON();
    expect(refreshButton.label).toBeUndefined();
    expect(refreshButton.emoji?.name).toBe("🔄");
    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(cocService.getClanWarLeagueGroup).not.toHaveBeenCalled();
    expect(cocService.getClanWarLeagueWar).not.toHaveBeenCalled();
  });

  it("opens no-arg /todo on the remembered page when one exists", async () => {
    vi.spyOn(todoLastViewedTypeService, "getLastViewedType").mockResolvedValue("RAIDS");
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
        raidAttacksUsed: 3,
      }),
    ]);
    const interaction = makeTodoInteraction({ type: null });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(getReplyTitle(interaction)).toBe("Todo - RAIDS");
  });

  it("uses the same CWL prep rendering when no-arg /todo opens on the remembered CWL page", async () => {
    vi.spyOn(todoLastViewedTypeService, "getLastViewedType").mockResolvedValue("CWL");
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
        cwlPhase: "preparation",
        cwlEndsAt: new Date("2026-03-30T12:00:00.000Z"),
      }),
    ]);
    const interaction = makeTodoInteraction({ type: null });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(getReplyTitle(interaction)).toBe("Todo - CWL");
    expect(description).toContain("CWL Status: Not in war yet");
    expect(description).toContain(":black_circle: Alpha - `0 / 0`");
  });

  it("falls back to default WAR page for no-arg /todo when no remembered page exists", async () => {
    vi.spyOn(todoLastViewedTypeService, "getLastViewedType").mockResolvedValue(null);
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
        warAttacksUsed: 1,
      }),
    ]);
    const interaction = makeTodoInteraction({ type: null });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(getReplyTitle(interaction)).toBe("Todo - WAR");
  });

  it("honors explicit type over remembered page and updates remembered page", async () => {
    vi.spyOn(todoLastViewedTypeService, "getLastViewedType").mockResolvedValue("WAR");
    const setSpy = vi
      .spyOn(todoLastViewedTypeService, "setLastViewedType")
      .mockResolvedValue(undefined);
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
        gamesPoints: 3500,
      }),
    ]);
    const interaction = makeTodoInteraction({ type: "GAMES" });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(getReplyTitle(interaction)).toBe("Todo - GAMES");
    expect(setSpy).toHaveBeenCalledWith({
      discordUserId: "111111111111111111",
      type: "GAMES",
    });
  });

  it("falls back safely when remembered page value is invalid", async () => {
    vi
      .spyOn(todoLastViewedTypeService, "getLastViewedType")
      .mockResolvedValue("INVALID_PAGE" as unknown as TodoType);
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
        warAttacksUsed: 1,
      }),
    ]);
    const interaction = makeTodoInteraction({ type: null });

    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(getReplyTitle(interaction)).toBe("Todo - WAR");
  });

  it("renders WAR headers with badge + match indicator and suppresses preparation attack detail", async () => {
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
        warAttacksUsed: 0,
        warPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warAttacksUsed: 1,
        warPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#CUV9082",
        playerName: "Charlie",
        clanTag: "#2QG2C08UP",
        clanName: "Clan Two",
        warAttacksUsed: 2,
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
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", clanBadge: ":rd:" },
      { tag: "#2QG2C08UP", clanBadge: ":ak:" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "FWA",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#2QG2C08UP",
        warId: 1002,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "BL",
        outcome: null,
        state: "preparation",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 0,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#QGRJ2222",
        playerPosition: 1,
        attacksUsed: 1,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#QGRJ2222",
        playerPosition: 1,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 8,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:05:00.000Z"),
      },
      {
        warId: 1002,
        clanTag: "#2QG2C08UP",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#CUV9082",
        playerPosition: 9,
        attacksUsed: 2,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        warId: 1002,
        clanTag: "#2QG2C08UP",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#CUV9082",
        playerPosition: 9,
        attacksUsed: 2,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 8,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:10:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        position: 8,
        attacks: 0,
        defender1Position: null,
        stars1: null,
        defender2Position: null,
        stars2: null,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#PQL0289",
        playerTag: "#QGRJ2222",
        position: 1,
        attacks: 1,
        defender1Position: 3,
        stars1: 1,
        defender2Position: null,
        stars2: null,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#CUV9082",
        position: 9,
        attacks: 2,
        defender1Position: 8,
        stars1: 3,
        defender2Position: 1,
        stars2: 1,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(getReplyTitle(interaction)).toBe("Todo - WAR");
    expect(getReplyColor(interaction)).toBe(TODO_INCOMPLETE_EMBED_COLOR);
    expect(description).toContain("war status: 1 / 6 attacks completed");
    expect(description).not.toContain("Linked players:");
    expect(description).toContain("**:rd: Clan One (#PQL0289) :green_circle: - battle day ends <t:");
    expect(description).toContain("**:ak: Clan Two (#2QG2C08UP) :black_circle: - preparation ends <t:");
    expect(description).toContain("- #8 Alpha - `0 / 2`");
    expect(description).toContain("- #1 Bravo - `1 / 2` | :dagger: #8 ★ ★ ★");
    expect(description).toContain("- #9 Charlie - `0 / 2`");
    expect(description).not.toContain("- #9 Charlie - `2 / 2`");
    expect(description).not.toContain("**Not in active war**");
    expect(description).not.toContain("Delta #LQ9P8R2");
  });

  it("uses check-mark bullets for completed WAR rows while keeping unfinished bullets unchanged", async () => {
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
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", clanBadge: ":rd:" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "FWA",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 1,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 10,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#PQL0289",
        warId: 1001,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#QGRJ2222",
        playerPosition: 2,
        attacksUsed: 2,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 8,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#PQL0289",
        warId: 1001,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#QGRJ2222",
        playerPosition: 2,
        attacksUsed: 2,
        attackOrder: 2,
        attackNumber: 2,
        defenderPosition: 7,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:05:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("Alpha - `1 / 2`");
    expect(description).toContain(":white_check_mark: #2 Bravo - `2 / 2`");
  });

  it("uses green WAR sidebar when all battle-day participant attacks are completed", async () => {
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
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warAttacksUsed: 2,
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
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", clanBadge: ":rd:" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "FWA",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 1,
        attacksUsed: 2,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 10,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#PQL0289",
        warId: 1001,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#QGRJ2222",
        playerPosition: 2,
        attacksUsed: 2,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 8,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(getReplyColor(interaction)).toBe(TODO_COMPLETE_EMBED_COLOR);
    expect(getReplyDescription(interaction)).toContain(
      "war status: 4 / 4 attacks completed",
    );
  });

  it("keeps WAR sidebar default during preparation-only states", async () => {
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
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warAttacksUsed: 0,
        warPhase: "preparation",
      }),
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", clanBadge: ":rd:" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "FWA",
        outcome: "WIN",
        state: "preparation",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 1,
        attacksUsed: 0,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(getReplyColor(interaction)).toBe(TODO_DEFAULT_EMBED_COLOR);
    expect(getReplyDescription(interaction)).toContain(
      "war status: 0 / 2 attacks completed",
    );
  });

  it("moves fully completed WAR clans below unfinished clans while preserving subgroup order", async () => {
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
        clanName: "A Clan",
        warAttacksUsed: 1,
        warPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        clanTag: "#2QG2C08UP",
        clanName: "B Clan",
        warAttacksUsed: 2,
        warPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#CUV9082",
        playerName: "Charlie",
        clanTag: "#Q2V8P9L2",
        clanName: "C Clan",
        warAttacksUsed: 1,
        warPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#LQ9P8R2",
        playerName: "Delta",
        clanTag: "#9C8VY2L2",
        clanName: "D Clan",
        warAttacksUsed: 2,
        warPhase: "battle day",
      }),
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", clanBadge: "" },
      { tag: "#2QG2C08UP", clanBadge: "" },
      { tag: "#Q2V8P9L2", clanBadge: "" },
      { tag: "#9C8VY2L2", clanBadge: "" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 2001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "MM",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#2QG2C08UP",
        warId: 2002,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "MM",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#Q2V8P9L2",
        warId: 2003,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "MM",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#9C8VY2L2",
        warId: 2004,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "MM",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 2001,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 1,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 3,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#2QG2C08UP",
        warId: 2002,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#QGRJ2222",
        playerPosition: 2,
        attacksUsed: 2,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 4,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#Q2V8P9L2",
        warId: 2003,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#CUV9082",
        playerPosition: 3,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 5,
        stars: 1,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        clanTag: "#9C8VY2L2",
        warId: 2004,
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#LQ9P8R2",
        playerPosition: 4,
        attacksUsed: 2,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 6,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    const indexA = description.indexOf("**A Clan (#PQL0289)");
    const indexB = description.indexOf("**B Clan (#2QG2C08UP)");
    const indexC = description.indexOf("**C Clan (#Q2V8P9L2)");
    const indexD = description.indexOf("**D Clan (#9C8VY2L2)");

    expect(indexA).toBeGreaterThan(-1);
    expect(indexB).toBeGreaterThan(-1);
    expect(indexC).toBeGreaterThan(-1);
    expect(indexD).toBeGreaterThan(-1);
    expect(indexA).toBeLessThan(indexC);
    expect(indexC).toBeLessThan(indexB);
    expect(indexB).toBeLessThan(indexD);
  });

  it("suppresses WAR stale-snapshot suffix for 2/2 rows while keeping it for incomplete rows", async () => {
    const staleAt = new Date("2026-03-25T20:00:00.000Z");
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _max: { updatedAt: staleAt },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warAttacksUsed: 2,
        warPhase: "battle day",
        lastUpdatedAt: staleAt,
        updatedAt: staleAt,
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warAttacksUsed: 1,
        warPhase: "battle day",
        lastUpdatedAt: staleAt,
        updatedAt: staleAt,
      }),
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", clanBadge: ":rd:" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "FWA",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 1,
        attacksUsed: 2,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 5,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 1,
        attacksUsed: 2,
        attackOrder: 2,
        attackNumber: 2,
        defenderPosition: 4,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:05:00.000Z"),
      },
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#QGRJ2222",
        playerPosition: 2,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 8,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain(":white_check_mark: #1 Alpha - `2 / 2`");
    expect(description).not.toContain("`2 / 2` - stale snapshot");
    expect(description).toContain("- #2 Bravo - `1 / 2` - stale snapshot");
  });

  it("excludes players not present in the clan's validated current-war member set", async () => {
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
        warAttacksUsed: 0,
        warPhase: "battle day",
      }),
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", clanBadge: ":rd:" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "FWA",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 7,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("- #8 Alpha - `1 / 2`");
    expect(description).not.toContain("Bravo");
  });

  it("uses safe #? fallback when war lineup position is unavailable", async () => {
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
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warAttacksUsed: 1,
        warPhase: "battle day",
      }),
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", clanBadge: ":rd:" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "FWA",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: null,
        attacksUsed: 1,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: null,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: null,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:05:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        position: null,
        attacks: 1,
        defender1Position: null,
        stars1: 2,
        defender2Position: null,
        stars2: null,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("- #? Alpha - `1 / 2` | :dagger: #? ★ ★ ☆");
  });

  it("uses current-war validated tracked rows for war position even when feed clan context differs", async () => {
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
        clanTag: "#Q2V8P9L2",
        clanName: "Stale Clan",
        warAttacksUsed: 1,
        warPhase: "battle day",
      }),
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#Q2V8P9L2", clanBadge: ":rd:" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#Q2V8P9L2",
        warId: 1003,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "FWA",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1003,
        clanTag: "#Q2V8P9L2",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 1,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        warId: 1003,
        clanTag: "#Q2V8P9L2",
        warStartTime: new Date("2026-03-25T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 7,
        stars: 2,
        attackSeenAt: new Date("2026-03-26T00:05:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        position: 8,
        attacks: 1,
        defender1Position: 7,
        stars1: 2,
        defender2Position: null,
        stars2: null,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("- #8 Alpha - `1 / 2`");
    expect(description).toContain("| :dagger: #7 ★ ★ ☆");
    expect(description).not.toContain("- #? Alpha -");
  });

  it("does not use stale/foreign FwaWarMemberCurrent fallback when no validated tracked row exists", async () => {
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
        clanTag: "#PQL0289",
        clanName: "Clan One",
        warAttacksUsed: 0,
        warPhase: "battle day",
      }),
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", clanBadge: ":rd:" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        matchType: "FWA",
        outcome: "WIN",
        state: "inWar",
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#ZZZZZZZZ",
        playerTag: "#PYLQ0289",
        position: 36,
        attacks: 1,
        defender1Position: 20,
        stars1: 2,
        defender2Position: null,
        stars2: null,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "WAR" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("No war active");
    expect(description).not.toContain("Alpha #PYLQ0289");
    expect(description).not.toContain("#36 Alpha");
    expect(prismaMock.fwaWarMemberCurrent.findMany).not.toHaveBeenCalled();
  });

  it("renders CWL grouped sections by shared context and omits non-active linked rows", async () => {
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
        cwlPhase: null,
        cwlEndsAt: null,
        cwlClanTag: null,
        cwlClanName: null,
        cwlAttacksUsed: 0,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "CWL" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(getReplyTitle(interaction)).toBe("Todo - CWL");
    expect(getReplyColor(interaction)).toBe(TODO_INCOMPLETE_EMBED_COLOR);
    expect(description).toContain("CWL Status: 1 / 2 attacks completed");
    expect(description).not.toContain("Linked players:");
    expect(description).toContain(
      "[Clan One](https://link.clashofclans.com/en?action=OpenClanProfile&tag=PQL0289) `#PQL0289` - Next war <t:",
    );
    expect(description).toContain(
      "[Clan Two](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP) `#2QG2C08UP` - Next war <t:",
    );
    expect(description).toContain(":white_check_mark: Alpha - `1 / 1`");
    expect(description).toContain(":black_circle: Bravo - `0 / 1`");
    expect(description).toContain(":black_circle: Charlie - `0 / 0`");
    expect(description).not.toContain("Delta");
  });

  it("uses green CWL sidebar when all active battle-day participants have attacked", async () => {
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
        cwlPhase: "battle day",
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        cwlAttacksUsed: 1,
        cwlPhase: "battle day",
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "CWL" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(getReplyColor(interaction)).toBe(TODO_COMPLETE_EMBED_COLOR);
    expect(getReplyDescription(interaction)).toContain(
      "CWL Status: 2 / 2 attacks completed",
    );
  });

  it("keeps CWL sidebar default during preparation-only states", async () => {
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
        cwlAttacksUsed: 0,
        cwlPhase: "preparation",
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "CWL" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    expect(getReplyColor(interaction)).toBe(TODO_DEFAULT_EMBED_COLOR);
    expect(getReplyDescription(interaction)).toContain(
      "CWL Status: Not in war yet",
    );
    expect(getReplyDescription(interaction)).not.toContain("No CWL active");
    expect(getReplyDescription(interaction)).toContain(":black_circle: Alpha - `0 / 0`");
  });

  it("groups CWL rows by cwlClanTag/cwlClanName when different from home clan", async () => {
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
        clanTag: "#PQL0289",
        clanName: "Home Clan",
        cwlClanTag: "#2QG2C08UP",
        cwlClanName: "CWL One",
        cwlAttacksUsed: 1,
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        clanTag: "#PQL0289",
        clanName: "Home Clan",
        cwlClanTag: "#2QG2C08UP",
        cwlClanName: "CWL One",
        cwlAttacksUsed: 0,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "CWL" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain(
      "[CWL One](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP) `#2QG2C08UP` - Next war <t:",
    );
    expect(description).not.toContain("Home Clan");
    expect(description).toContain(":black_circle: Alpha - `0 / 0`");
  });

  it("renders upcoming CWL context with unknown timing instead of no-context when a CWL clan is already known", async () => {
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
        cwlPhase: null,
        cwlEndsAt: null,
        cwlClanTag: "#2QG2C08UP",
        cwlClanName: "Clan Two",
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "CWL" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("CWL Status: Not in war yet");
    expect(description).not.toContain("No CWL active");
    expect(description).toContain(
      "[Clan Two](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP) `#2QG2C08UP` - Next war unknown",
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
    expect(getReplyColor(interaction)).toBe(TODO_DEFAULT_EMBED_COLOR);
    expect(getReplyDescription(interaction)).toContain(
      "war status: 0 / 0 attacks completed",
    );
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
        cwlPhase: null,
        cwlEndsAt: null,
        cwlClanTag: null,
        cwlClanName: null,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "CWL" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);
    expect(getReplyColor(interaction)).toBe(TODO_DEFAULT_EMBED_COLOR);
    expect(getReplyDescription(interaction)).toContain(
      "CWL Status: 0 / 0 attacks completed",
    );
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

  it("shows off-cycle GAMES view when clan games is not active", async () => {
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
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
        gamesChampionTotal: 1200,
        gamesSeasonBaseline: 1200,
        gamesCycleKey: "1776758400000",
        gamesPoints: null,
        gamesTarget: null,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "GAMES" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);
    const description = getReplyDescription(interaction);
    expect(description).toContain(
      "Clan Games is not active. Showing lifetime Clan Games totals.",
    );
    expect(description).toContain("Alpha `#PYLQ0289` — 1,200");
  });

  it("renders RAIDS markers for complete, active-incomplete, and not-started rows", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
      { playerTag: "#LQ9P8R2", createdAt: new Date("2026-03-03T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 3 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        raidActive: true,
        raidAttacksUsed: 6,
        raidEndsAt: new Date("2026-03-29T07:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        raidActive: true,
        raidAttacksUsed: 1,
        raidEndsAt: new Date("2026-03-29T07:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#LQ9P8R2",
        playerName: "Charlie",
        raidActive: true,
        raidAttacksUsed: 0,
        raidEndsAt: new Date("2026-03-29T07:00:00.000Z"),
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "RAIDS" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("**Time remaining:** <t:");
    expect(countOccurrences(description, "<t:")).toBe(1);
    expect(description).toContain(":white_check_mark: Alpha #PYLQ0289 - clan capital raids: 6/6");
    expect(description).toContain(":yellow_circle: Bravo #QGRJ2222 - clan capital raids: 1/6");
    expect(description).toContain(":black_circle: Charlie #LQ9P8R2 - clan capital raids: 0/6");
  });

  it("sorts RAIDS rows by attacks used desc, then TH desc, then deterministic fallback order", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PQQQ0000", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#PYLL0002", createdAt: new Date("2026-03-02T00:00:00.000Z") },
      { playerTag: "#QGRJ2008", createdAt: new Date("2026-03-03T00:00:00.000Z") },
      { playerTag: "#CUV9900", createdAt: new Date("2026-03-04T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 4 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PQQQ0000",
        playerName: "Delta",
        raidActive: true,
        raidAttacksUsed: 3,
      }),
      makeSnapshotRow({
        playerTag: "#PYLL0002",
        playerName: "Charlie",
        raidActive: true,
        raidAttacksUsed: 3,
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2008",
        playerName: "Bravo",
        raidActive: true,
        raidAttacksUsed: 3,
      }),
      makeSnapshotRow({
        playerTag: "#CUV9900",
        playerName: "Alpha",
        raidActive: true,
        raidAttacksUsed: 1,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PQQQ0000",
        clanTag: "#PQL0289",
        townHall: 15,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#PYLL0002",
        clanTag: "#PQL0289",
        townHall: 15,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2008",
        clanTag: "#PQL0289",
        townHall: 13,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#CUV9900",
        clanTag: "#PQL0289",
        townHall: 16,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);

    const interaction = makeTodoInteraction({ type: "RAIDS" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    const indexDelta = description.indexOf("Delta #PQQQ0000 - clan capital raids: 3/6");
    const indexCharlie = description.indexOf("Charlie #PYLL0002 - clan capital raids: 3/6");
    const indexBravo = description.indexOf("Bravo #QGRJ2008 - clan capital raids: 3/6");
    const indexAlpha = description.indexOf("Alpha #CUV9900 - clan capital raids: 1/6");

    expect(indexDelta).toBeGreaterThan(-1);
    expect(indexCharlie).toBeGreaterThan(-1);
    expect(indexBravo).toBeGreaterThan(-1);
    expect(indexAlpha).toBeGreaterThan(-1);
    expect(indexDelta).toBeLessThan(indexCharlie);
    expect(indexCharlie).toBeLessThan(indexBravo);
    expect(indexBravo).toBeLessThan(indexAlpha);
  });

  it("renders GAMES emojis by progress threshold and sorts by gamesPoints desc then gamesChampionTotal desc", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
      { playerTag: "#CUV9082", createdAt: new Date("2026-03-03T00:00:00.000Z") },
      { playerTag: "#LQ9P8R2", createdAt: new Date("2026-03-04T00:00:00.000Z") },
      { playerTag: "#Q2V8P9L2", createdAt: new Date("2026-03-05T00:00:00.000Z") },
      { playerTag: "#9C8VY2L2", createdAt: new Date("2026-03-06T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 6 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Echo",
        gamesActive: true,
        gamesPoints: 0,
        gamesChampionTotal: 5000,
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Delta",
        gamesActive: true,
        gamesPoints: 3999,
        gamesChampionTotal: 6500,
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#CUV9082",
        playerName: "Charlie",
        gamesActive: true,
        gamesPoints: 5200,
        gamesChampionTotal: 7000,
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#LQ9P8R2",
        playerName: "Alpha",
        gamesActive: true,
        gamesPoints: 10000,
        gamesChampionTotal: 15000,
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#Q2V8P9L2",
        playerName: "Bravo",
        gamesActive: true,
        gamesPoints: 4000,
        gamesChampionTotal: 8000,
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#9C8VY2L2",
        playerName: "Foxtrot",
        gamesActive: true,
        gamesPoints: 3999,
        gamesChampionTotal: 5000,
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "GAMES" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("**Time remaining:** <t:");
    expect(countOccurrences(description, "<t:")).toBe(1);
    expect(description).toContain("Alpha #LQ9P8R2 - clan games points: 10000/4000");
    expect(description).toContain("Bravo #Q2V8P9L2 - clan games points: 4000/4000");
    expect(description).toContain("Charlie #CUV9082 - clan games points: 5200/4000");
    expect(description).toContain("Delta #QGRJ2222 - clan games points: 3999/4000");
    expect(description).toContain("Foxtrot #9C8VY2L2 - clan games points: 3999/4000");
    expect(description).toContain(":black_circle: Echo #PYLQ0289 - clan games points: 0/4000");
    expect(description).toContain("🏆 Alpha #LQ9P8R2 - clan games points: 10000/4000");
    expect(description).toContain("✅ Bravo #Q2V8P9L2 - clan games points: 4000/4000");
    expect(description).toContain("✅ Charlie #CUV9082 - clan games points: 5200/4000");
    expect(description).not.toContain("- 🏆");
    expect(description).not.toContain("- ✅");
    expect(description).not.toContain("- 🟡");

    const indexTrophy = description.indexOf("Alpha #LQ9P8R2");
    const indexBravo = description.indexOf("Bravo #Q2V8P9L2");
    const indexCharlie = description.indexOf("Charlie #CUV9082");
    const indexDelta = description.indexOf("Delta #QGRJ2222");
    const indexFoxtrot = description.indexOf("Foxtrot #9C8VY2L2");
    const indexEcho = description.indexOf("Echo #PYLQ0289");
    expect(indexTrophy).toBeGreaterThan(-1);
    expect(indexBravo).toBeGreaterThan(-1);
    expect(indexCharlie).toBeGreaterThan(-1);
    expect(indexDelta).toBeGreaterThan(-1);
    expect(indexFoxtrot).toBeGreaterThan(-1);
    expect(indexEcho).toBeGreaterThan(-1);
    expect(description).not.toContain("- Echo #PYLQ0289 - clan games points: 0/4000");
    expect(indexTrophy).toBeLessThan(indexCharlie);
    expect(indexCharlie).toBeLessThan(indexBravo);
    expect(indexBravo).toBeLessThan(indexDelta);
    expect(indexDelta).toBeLessThan(indexFoxtrot);
    expect(indexFoxtrot).toBeLessThan(indexEcho);
  });
  it("falls back to PlayerLink identity for linked rows before final raw-tag fallback", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alias",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: null,
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "#PYLQ0289",
        gamesActive: true,
        gamesPoints: 1200,
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "",
        gamesActive: true,
        gamesPoints: 0,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "GAMES" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("🟡 Linked Alias #PYLQ0289 - clan games points: 1200/4000");
    expect(description).not.toContain("- 🟡 Linked Alias #PYLQ0289");
    expect(description).toContain(":black_circle: #QGRJ2222 - clan games points: 0/4000");
  });

  it("does not use discordUsername as normal todo player identity fallback", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUsername: "tonyk_2020",
        playerName: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "#PYLQ0289",
        gamesActive: true,
        gamesPoints: 1200,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "GAMES" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain("🟡 #PYLQ0289 - clan games points: 1200/4000");
    expect(description).not.toContain("- 🟡 #PYLQ0289 - clan games points: 1200/4000");
    expect(description).not.toContain("tonyk_2020");
  });

  it("renders GAMES not-started rows with :black_circle: and no extra bullet prefix", async () => {
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
        gamesActive: true,
        gamesPoints: 1200,
        gamesChampionTotal: 1200,
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        gamesActive: false,
        gamesPoints: 0,
        gamesChampionTotal: 0,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "GAMES" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain(
      ":black_circle: Bravo #QGRJ2222 - clan games points: 0/4000 - not active",
    );
    expect(description).not.toContain(
      "- :black_circle: Bravo #QGRJ2222 - clan games points: 0/4000 - not active",
    );
  });

  it("renders post-reward off-cycle lifetime rankings for all linked accounts", async () => {
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
      {
        playerTag: "#CUV9082",
        playerName: "Linked Charlie",
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
      },
      {
        playerTag: "#LQ9P8R2",
        createdAt: new Date("2026-03-04T00:00:00.000Z"),
      },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 4 },
      _max: { updatedAt: new Date("2026-03-26T00:00:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha Snapshot",
        gamesActive: false,
        gamesChampionTotal: 24000,
        gamesSeasonBaseline: 24000,
        gamesCycleKey: "1776758400000",
        gamesPoints: null,
        gamesTarget: null,
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo Snapshot",
        gamesActive: false,
        gamesChampionTotal: 30000,
        gamesSeasonBaseline: 30000,
        gamesCycleKey: "1776758400000",
        gamesPoints: null,
        gamesTarget: null,
      }),
      makeSnapshotRow({
        playerTag: "#CUV9082",
        playerName: "Charlie Snapshot",
        gamesActive: false,
        gamesChampionTotal: 18000,
        gamesSeasonBaseline: 18000,
        gamesCycleKey: "1776758400000",
        gamesPoints: null,
        gamesTarget: null,
      }),
      makeSnapshotRow({
        playerTag: "#LQ9P8R2",
        playerName: "Delta Snapshot",
        gamesActive: false,
        gamesChampionTotal: null,
        gamesSeasonBaseline: null,
        gamesCycleKey: "1776758400000",
        gamesPoints: null,
        gamesTarget: null,
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "GAMES" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    const statusIndex = description.indexOf(
      "Clan Games is not active. Showing lifetime Clan Games totals.",
    );
    const lifetimeBravoIndex = description.indexOf(
      "Bravo Snapshot `#QGRJ2222` — 30,000",
    );
    const lifetimeAlphaIndex = description.indexOf(
      "Alpha Snapshot `#PYLQ0289` — 24,000",
    );
    const lifetimeCharlieIndex = description.indexOf(
      "Charlie Snapshot `#CUV9082` — 18,000",
    );
    const lifetimeDeltaIndex = description.indexOf("Delta Snapshot `#LQ9P8R2` — 0");

    expect(statusIndex).toBeGreaterThan(-1);
    expect(description).not.toContain("**This season participants");
    expect(lifetimeAlphaIndex).toBeGreaterThan(lifetimeBravoIndex);
    expect(lifetimeCharlieIndex).toBeGreaterThan(lifetimeAlphaIndex);
    expect(lifetimeDeltaIndex).toBeGreaterThan(lifetimeCharlieIndex);
  });

  it("shows latest Clan Games reward-collection results throughout the extended claim window", async () => {
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", createdAt: new Date("2026-03-02T00:00:00.000Z") },
    ]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _max: { updatedAt: new Date("2026-04-03T11:40:00.000Z") },
    });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      makeSnapshotRow({
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        gamesActive: false,
        gamesPoints: 3900,
        gamesChampionTotal: 12345,
        gamesSeasonBaseline: 10000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-04-03T11:40:00.000Z"),
      }),
      makeSnapshotRow({
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        gamesActive: false,
        gamesPoints: 0,
        gamesTarget: 4000,
        gamesChampionTotal: 10000,
        gamesSeasonBaseline: 10000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-04-03T11:40:00.000Z"),
      }),
    ]);

    const interaction = makeTodoInteraction({ type: "GAMES" });
    await Todo.run({} as any, interaction as any, makeCocServiceSpy() as any);

    const description = getReplyDescription(interaction);
    expect(description).toContain(
      "Clan Games point earning has ended. Showing latest Clan Games results during reward collection.",
    );
    expect(description).toContain("**Reward collection time remaining:** <t:");
    expect(description).toContain("Alpha #PYLQ0289 - latest clan games points: 3900/4000");
    expect(description).toContain(
      ":black_circle: Bravo #QGRJ2222 - latest clan games points: 0/4000 - non-participant",
    );
  });
});

describe("/todo pagination buttons", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetTodoRenderCacheForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T00:00:00.000Z"));

    prismaMock.playerLink.findMany.mockReset();
    prismaMock.todoPlayerSnapshot.aggregate.mockReset();
    prismaMock.todoPlayerSnapshot.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fwaWarMemberCurrent.findMany.mockReset();
    prismaMock.currentWar.findMany.mockReset();
    prismaMock.warAttacks.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.cwlTrackedClan.findMany.mockReset();
    prismaMock.cwlPlayerClanSeason.findMany.mockReset();
    prismaMock.cwlPlayerClanSeason.upsert.mockReset();

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
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.upsert.mockResolvedValue(undefined);
    vi.spyOn(todoLastViewedTypeService, "setLastViewedType").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("paginates across WAR/CWL/RAIDS/GAMES with user-scoped access", async () => {
    const checks: Array<{ type: TodoType; contains: string }> = [
      { type: "WAR", contains: "No war active" },
      { type: "CWL", contains: "CWL Status:" },
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

  it("updates remembered page when pagination changes page type", async () => {
    const setSpy = vi
      .spyOn(todoLastViewedTypeService, "setLastViewedType")
      .mockResolvedValue(undefined);
    const interaction = makeTodoButtonInteraction({
      customId: buildTodoPageButtonCustomId("111111111111111111", "CWL"),
    });

    await handleTodoPageButtonInteraction(interaction as any, makeCocServiceSpy() as any);

    expect(setSpy).toHaveBeenCalledWith({
      discordUserId: "111111111111111111",
      type: "CWL",
    });
  });
});

describe("/todo refresh button", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetTodoRenderCacheForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T00:00:00.000Z"));

    prismaMock.playerLink.findMany.mockReset();
    prismaMock.todoPlayerSnapshot.aggregate.mockReset();
    prismaMock.todoPlayerSnapshot.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fwaWarMemberCurrent.findMany.mockReset();
    prismaMock.currentWar.findMany.mockReset();
    prismaMock.warAttacks.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.cwlTrackedClan.findMany.mockReset();
    prismaMock.cwlPlayerClanSeason.findMany.mockReset();
    prismaMock.cwlPlayerClanSeason.upsert.mockReset();

    prismaMock.playerLink.findMany.mockImplementation(async (args: any) => {
      const userId = String(args?.where?.discordUserId ?? "");
      if (userId === "222222222222222222") {
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
        gamesPoints: 2000,
      }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.upsert.mockResolvedValue(undefined);
    vi.spyOn(todoLastViewedTypeService, "setLastViewedType").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refreshes the target user snapshots and updates the existing message on the same page", async () => {
    const refreshSpy = vi
      .spyOn(todoSnapshotService, "refreshSnapshotsForPlayerTags")
      .mockResolvedValue({ playerCount: 2, updatedCount: 2 });
    const interaction = makeTodoButtonInteraction({
      customId: buildTodoRefreshButtonCustomId({
        guildScopeId: "123456789012345678",
        requesterUserId: "111111111111111111",
        targetUserId: "222222222222222222",
        type: "GAMES",
      }),
      userId: "111111111111111111",
      guildId: "123456789012345678",
    });

    await handleTodoRefreshButtonInteraction(interaction as any, makeCocServiceSpy() as any);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: expect.anything(),
    });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(payload.embeds[0].toJSON().title).toBe("Todo - GAMES");
    expect(payload.components[1].components.map((b: any) => b.toJSON().label)).toEqual([
      undefined,
    ]);
    expect(payload.components[1].components.map((b: any) => b.toJSON().emoji?.name)).toEqual([
      "🔄",
    ]);
    expect(todoLastViewedTypeService.setLastViewedType).toHaveBeenCalledWith({
      discordUserId: "111111111111111111",
      type: "GAMES",
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("uses no-linked-tags behavior when the target user has no links", async () => {
    const refreshSpy = vi
      .spyOn(todoSnapshotService, "refreshSnapshotsForPlayerTags")
      .mockResolvedValue({ playerCount: 0, updatedCount: 0 });
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    const interaction = makeTodoButtonInteraction({
      customId: buildTodoRefreshButtonCustomId({
        guildScopeId: "123456789012345678",
        requesterUserId: "111111111111111111",
        targetUserId: "222222222222222222",
        type: "WAR",
      }),
      userId: "111111111111111111",
      guildId: "123456789012345678",
    });

    await handleTodoRefreshButtonInteraction(interaction as any, makeCocServiceSpy() as any);

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "no_linked_tags: no linked player tags found for your Discord account. Use `/link create player-tag:<tag>` first.",
      embeds: [],
      components: [],
    });
  });

  it("returns a specific ephemeral error when targeted refresh fails", async () => {
    vi.spyOn(todoSnapshotService, "refreshSnapshotsForPlayerTags").mockRejectedValue(
      new Error("refresh failed"),
    );
    const interaction = makeTodoButtonInteraction({
      customId: buildTodoRefreshButtonCustomId({
        guildScopeId: "123456789012345678",
        requesterUserId: "111111111111111111",
        targetUserId: "222222222222222222",
        type: "RAIDS",
      }),
      userId: "111111111111111111",
      guildId: "123456789012345678",
    });

    await handleTodoRefreshButtonInteraction(interaction as any, makeCocServiceSpy() as any);

    expect(interaction.followUp).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Failed to refresh todo data. Please try again.",
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("rejects refresh clicks from non-requesting users", async () => {
    const interaction = makeTodoButtonInteraction({
      customId: buildTodoRefreshButtonCustomId({
        guildScopeId: "123456789012345678",
        requesterUserId: "111111111111111111",
        targetUserId: "222222222222222222",
        type: "WAR",
      }),
      userId: "333333333333333333",
      guildId: "123456789012345678",
    });

    await handleTodoRefreshButtonInteraction(interaction as any, makeCocServiceSpy() as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });
});


