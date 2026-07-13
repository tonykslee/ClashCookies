import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  currentWar: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
}));

const warEventLogServiceMock = vi.hoisted(() => ({
  pollClan: vi.fn(),
  poll: vi.fn(),
  refreshBattleDayPosts: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/WarEventLogService", () => ({
  WarEventLogService: class {
    pollClan = warEventLogServiceMock.pollClan;
    poll = warEventLogServiceMock.poll;
    refreshBattleDayPosts = warEventLogServiceMock.refreshBattleDayPosts;
  },
}));

import {
  resolveExactCurrentWarMailIdentityForTagForTest,
  targetedWarMailIdentityResolver,
} from "../src/commands/Fwa";

describe("fwa targeted war-mail identity reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.currentWar.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    warEventLogServiceMock.pollClan.mockResolvedValue({
      processed: true,
      warEnded: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts only an exact active CurrentWar reread with a positive war id", () => {
    const exact = resolveExactCurrentWarMailIdentityForTagForTest(
      {
        warId: 1000610,
        startTime: new Date("2026-07-12T15:22:26.000Z"),
        opponentTag: "#LYPLQQUC",
        state: "preparation",
      },
      {
        liveWarState: "preparation",
        liveWarStartMs: new Date("2026-07-12T15:22:26.000Z").getTime(),
        liveOpponentTag: "LYPLQQUC",
      },
    );

    expect(exact).toEqual({
      warId: 1000610,
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "LYPLQQUC",
    });
  });

  it("rejects a reread when the state, war id, start, or opponent do not match exactly", () => {
    const rejected = resolveExactCurrentWarMailIdentityForTagForTest(
      {
        warId: 0,
        startTime: new Date("2026-07-12T15:22:26.000Z"),
        opponentTag: "#OLDTAG",
        state: "notInWar",
      },
      {
        liveWarState: "preparation",
        liveWarStartMs: new Date("2026-07-12T15:22:26.000Z").getTime(),
        liveOpponentTag: "LYPLQQUC",
      },
    );

    expect(rejected).toBeNull();
  });

  it("returns the current-war identity without polling when the row is already exact", async () => {
    const result = await targetedWarMailIdentityResolver.resolve({
      client: { channels: { fetch: vi.fn() } } as any,
      cocService: {} as any,
      guildId: " guild-1 ",
      normalizedTag: " #lyplqquc ",
      liveWarState: "preparation",
      liveWarStartMs: new Date("2026-07-12T15:22:26.000Z").getTime(),
      liveOpponentTag: "LYPLQQUC",
      currentWarRow: {
        warId: 1000610,
        startTime: new Date("2026-07-12T15:22:26.000Z"),
        opponentTag: "#LYPLQQUC",
        state: "preparation",
      },
    });

    expect(result).toEqual({
      warId: 1000610,
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "LYPLQQUC",
    });
    expect(warEventLogServiceMock.pollClan).not.toHaveBeenCalled();
    expect(warEventLogServiceMock.poll).not.toHaveBeenCalled();
    expect(warEventLogServiceMock.refreshBattleDayPosts).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.findUnique).not.toHaveBeenCalled();
  });

  it("reconciles one clan through pollClan and rereads only the exact CurrentWar row", async () => {
    prismaMock.currentWar.findUnique.mockResolvedValueOnce({
      warId: 1000610,
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "#LYPLQQUC",
      state: "preparation",
    });

    const result = await targetedWarMailIdentityResolver.resolve({
      client: { channels: { fetch: vi.fn() } } as any,
      cocService: {} as any,
      guildId: " guild-1 ",
      normalizedTag: " #lyplqquc ",
      liveWarState: "preparation",
      liveWarStartMs: new Date("2026-07-12T15:22:26.000Z").getTime(),
      liveOpponentTag: "LYPLQQUC",
      currentWarRow: {
        warId: null,
        startTime: null,
        opponentTag: null,
        state: "preparation",
      },
    });

    expect(result).toEqual({
      warId: 1000610,
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "LYPLQQUC",
    });
    expect(warEventLogServiceMock.pollClan).toHaveBeenCalledTimes(1);
    expect(warEventLogServiceMock.pollClan).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "LYPLQQUC",
      sendBattleDaySwapReminders: false,
    });
    expect(warEventLogServiceMock.poll).not.toHaveBeenCalled();
    expect(warEventLogServiceMock.refreshBattleDayPosts).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.currentWar.findUnique).toHaveBeenCalledWith({
      where: {
        clanTag_guildId: {
          guildId: "guild-1",
          clanTag: "#LYPLQQUC",
        },
      },
      select: {
        warId: true,
        startTime: true,
        opponentTag: true,
        state: true,
      },
    });
  });

  it("returns a no-op when the one-clan poll does not materialize a matching CurrentWar row", async () => {
    warEventLogServiceMock.pollClan.mockResolvedValueOnce({
      processed: false,
      warEnded: false,
    });

    const result = await targetedWarMailIdentityResolver.resolve({
      client: { channels: { fetch: vi.fn() } } as any,
      cocService: {} as any,
      guildId: "guild-1",
      normalizedTag: "2RYGLU2UY",
      liveWarState: "preparation",
      liveWarStartMs: new Date("2026-07-12T15:22:26.000Z").getTime(),
      liveOpponentTag: "LYPLQQUC",
      currentWarRow: null,
    });

    expect(result).toBeNull();
    expect(warEventLogServiceMock.pollClan).toHaveBeenCalledTimes(1);
    expect(prismaMock.currentWar.findUnique).not.toHaveBeenCalled();
  });
});
