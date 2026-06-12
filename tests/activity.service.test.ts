import { beforeEach, describe, expect, it, vi } from "vitest";
import { playerCurrentService } from "../src/services/PlayerCurrentService";

const prismaMock = vi.hoisted(() => ({
  playerActivity: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

const recordFetchEventMock = vi.hoisted(() => ({
  recordFetchEvent: vi.fn(),
}));

const activitySignalProcessPlayerMock = vi.hoisted(() => vi.fn());

const dozzleLogMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/helper/fetchTelemetry", () => ({
  recordFetchEvent: recordFetchEventMock.recordFetchEvent,
}));

vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: dozzleLogMock,
}));

vi.mock("../src/services/ActivitySignalService", () => ({
  ActivitySignalService: class ActivitySignalServiceMock {
    processPlayer = activitySignalProcessPlayerMock;
  },
}));

import { ActivityService } from "../src/services/ActivityService";

function makeLivePlayer(overrides: Record<string, unknown> = {}) {
  return {
    tag: "#AAA111",
    name: "Live Alpha",
    clan: {
      tag: "#CLAN1",
      name: "Clan One",
    },
    trophies: 6200,
    donations: 50,
    donationsReceived: 5,
    warStars: 100,
    builderBaseTrophies: 4300,
    clanCapitalContributions: 77,
    attackWins: 12,
    defenseWins: 8,
    versusBattleWins: 3,
    expLevel: 200,
    townHallLevel: 16,
    achievements: [],
    troops: [],
    heroes: [],
    spells: [],
    pets: [],
    heroEquipment: [],
    ...overrides,
  };
}

function makeExistingCurrent(overrides: Record<string, unknown> = {}) {
  return {
    playerTag: "#AAA111",
    playerName: "Cached Alpha",
    townHall: 15,
    currentClanTag: "#OLDCLAN",
    currentClanName: "Old Clan",
    trophies: 6000,
    builderTrophies: 4000,
    warStars: 80,
    expLevel: 190,
    role: "member",
    leagueName: "Legend League",
    currentWeight: 145000,
    currentWeightSource: "manual",
    currentWeightMeasuredAt: new Date("2026-06-10T00:00:00.000Z"),
    achievementsJson: null,
    lastSeenAt: new Date("2026-06-10T00:00:00.000Z"),
    lastFetchedAt: new Date("2026-06-10T00:00:00.000Z"),
    lastSource: "accounts-refresh",
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    source: "player_current",
    liveRefreshInvoked: false,
    ...overrides,
  };
}

describe("ActivityService observeClanDetailed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.playerActivity.findUnique.mockResolvedValue(null);
    prismaMock.playerActivity.upsert.mockResolvedValue({} as never);
    recordFetchEventMock.recordFetchEvent.mockReset();
    activitySignalProcessPlayerMock.mockReset();
    dozzleLogMock.info.mockReset();
    activitySignalProcessPlayerMock.mockResolvedValue({
      state: { signalTimes: {} },
      lastSeenAtMs: null,
    });
  });

  it("updates PlayerActivity and PlayerCurrent from the same live player payload", async () => {
    const getClan = vi.fn().mockResolvedValue({
      tag: "#CLAN1",
      name: "Clan One",
      members: [{ tag: "#PYLQ0289", name: "Alpha" }],
    });
    const getPlayerRaw = vi.fn().mockResolvedValue(
      makeLivePlayer({
        tag: "#PYLQ0289",
        clan: { tag: "#QGRJ2222", name: "Clan One" },
      }),
    );
    const cocService = { getClan, getPlayerRaw } as any;
    const activityService = new ActivityService(cocService);

    const listPlayerCurrentByTagsSpy = vi
      .spyOn(playerCurrentService, "listPlayerCurrentByTags")
      .mockResolvedValue(new Map([["#PYLQ0289", makeExistingCurrent({ playerTag: "#PYLQ0289" })]]));
    const upsertPlayerCurrentSpy = vi
      .spyOn(playerCurrentService, "upsertPlayerCurrentFromLivePlayer")
      .mockResolvedValue({
        ...makeExistingCurrent({ playerTag: "#PYLQ0289" }),
        playerName: "Live Alpha",
        currentClanTag: "#QGRJ2222",
        currentClanName: "Clan One",
        source: "activity_observe",
        liveRefreshInvoked: true,
      } as any);

    const result = await activityService.observeClanDetailed("guild-1", "#CLAN1", {
      activityObserveCycleId: "activity_observe_cycle:123",
      scheduledAtMs: 123,
    });

    expect(result).toEqual({
      clanTag: "#CLAN1",
      clanName: "Clan One",
      memberTags: ["#PYLQ0289"],
      members: [{ playerTag: "#PYLQ0289", playerName: "Alpha" }],
      observedPlayerCurrent: [
        {
          playerTag: "#PYLQ0289",
          clanTag: "#QGRJ2222",
          townHall: 16,
        },
      ],
    });
    expect(getClan).toHaveBeenCalledTimes(1);
    expect(getPlayerRaw).toHaveBeenCalledTimes(1);
    expect(getPlayerRaw).toHaveBeenCalledWith("#PYLQ0289", { suppressTelemetry: true });
    expect(listPlayerCurrentByTagsSpy).toHaveBeenCalledWith(["#PYLQ0289"]);
    expect(upsertPlayerCurrentSpy).toHaveBeenCalledTimes(1);
    expect(upsertPlayerCurrentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        playerTag: "#PYLQ0289",
        livePlayer: expect.objectContaining({
          tag: "#PYLQ0289",
          name: "Live Alpha",
        }),
        existing: expect.objectContaining({
          currentWeight: 145000,
          currentWeightSource: "manual",
        }),
        source: "activity_observe",
      }),
    );
    expect(prismaMock.playerActivity.upsert).toHaveBeenCalledTimes(1);
    expect(recordFetchEventMock.recordFetchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "coc",
        operation: "getPlayerRaw",
        source: "api",
        incrementBy: 1,
        detail: expect.stringContaining("playerCurrentUpsertSuccessCount=1"),
      }),
    );
    expect(dozzleLogMock.info).toHaveBeenCalledWith(
      expect.stringContaining("[activity-observe] event=activity_observe_clan_fetch"),
    );
    expect(dozzleLogMock.info).toHaveBeenCalledWith(
      expect.stringContaining("activity_observe_cycle_id=activity_observe_cycle:123"),
    );
    expect(dozzleLogMock.info).toHaveBeenCalledWith(
      expect.stringContaining("clan_tag=#CLAN1"),
    );
  });

  it("logs PlayerCurrent upsert failures and keeps observing the remaining clan members", async () => {
    const getClan = vi.fn().mockResolvedValue({
      tag: "#CLAN1",
      name: "Clan One",
      members: [
        { tag: "#AAA111", name: "Alpha" },
        { tag: "#BBB222", name: "Bravo" },
      ],
    });
    const getPlayerRaw = vi.fn().mockImplementation(async (tag: string) => {
      if (tag === "#AAA111") return makeLivePlayer({ tag, name: "Live Alpha" });
      return makeLivePlayer({
        tag,
        name: "Live Bravo",
        clan: { tag: "#CLAN1", name: "Clan One" },
      });
    });
    const cocService = { getClan, getPlayerRaw } as any;
    const activityService = new ActivityService(cocService);
    vi.spyOn(playerCurrentService, "listPlayerCurrentByTags").mockResolvedValue(
      new Map([
        ["#AAA111", makeExistingCurrent()],
        [
          "#BBB222",
          makeExistingCurrent({
            playerTag: "#BBB222",
            playerName: "Cached Bravo",
          }),
        ],
      ]),
    );
    const upsertPlayerCurrentSpy = vi
      .spyOn(playerCurrentService, "upsertPlayerCurrentFromLivePlayer")
      .mockRejectedValueOnce(new Error("player current failed"))
      .mockResolvedValueOnce({
        ...makeExistingCurrent({ playerTag: "#BBB222" }),
        playerName: "Live Bravo",
        currentClanTag: "#CLAN1",
        currentClanName: "Clan One",
        source: "activity_observe",
        liveRefreshInvoked: true,
      } as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await activityService.observeClanDetailed("guild-1", "#CLAN1");

    expect(result.memberTags).toEqual(["#AAA111", "#BBB222"]);
    expect(getPlayerRaw).toHaveBeenCalledTimes(2);
    expect(prismaMock.playerActivity.upsert).toHaveBeenCalledTimes(2);
    expect(upsertPlayerCurrentSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[activity-observe] player_current_upsert_failed guild=guild-1 clan=#CLAN1 player=#AAA111",
      ),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("player current failed"),
    );
    expect(recordFetchEventMock.recordFetchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("playerCurrentUpsertSuccessCount=1"),
      }),
    );
    expect(recordFetchEventMock.recordFetchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("playerCurrentUpsertFailedCount=1"),
      }),
    );
    warnSpy.mockRestore();
  });

  it("falls back to an empty PlayerCurrent map when the preload fails", async () => {
    const getClan = vi.fn().mockResolvedValue({
      tag: "#CLAN1",
      name: "Clan One",
      members: [{ tag: "#AAA111", name: "Alpha" }],
    });
    const getPlayerRaw = vi.fn().mockResolvedValue(makeLivePlayer());
    const cocService = { getClan, getPlayerRaw } as any;
    const activityService = new ActivityService(cocService);
    vi.spyOn(playerCurrentService, "listPlayerCurrentByTags").mockRejectedValue(
      new Error("player current preload failed"),
    );
    const upsertPlayerCurrentSpy = vi
      .spyOn(playerCurrentService, "upsertPlayerCurrentFromLivePlayer")
      .mockResolvedValue({
        ...makeExistingCurrent(),
        playerName: "Live Alpha",
        currentClanTag: "#CLAN1",
        currentClanName: "Clan One",
        source: "activity_observe",
        liveRefreshInvoked: true,
      } as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await activityService.observeClanDetailed("guild-1", "#CLAN1");

    expect(getPlayerRaw).toHaveBeenCalledTimes(1);
    expect(upsertPlayerCurrentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        existing: null,
        source: "activity_observe",
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[activity-observe] player_current_preload_failed guild=guild-1 clan=#CLAN1 player_count=1",
      ),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("player current preload failed"));
    warnSpy.mockRestore();
  });

  it("lets PlayerActivity failures abort the observe cycle", async () => {
    const getClan = vi.fn().mockResolvedValue({
      tag: "#CLAN1",
      name: "Clan One",
      members: [{ tag: "#AAA111", name: "Alpha" }],
    });
    const getPlayerRaw = vi.fn().mockResolvedValue(makeLivePlayer());
    const cocService = { getClan, getPlayerRaw } as any;
    const activityService = new ActivityService(cocService);
    vi.spyOn(playerCurrentService, "listPlayerCurrentByTags").mockResolvedValue(
      new Map(),
    );
    const upsertPlayerCurrentSpy = vi.spyOn(
      playerCurrentService,
      "upsertPlayerCurrentFromLivePlayer",
    );
    activitySignalProcessPlayerMock.mockRejectedValueOnce(new Error("activity failed"));

    await expect(
      activityService.observeClanDetailed("guild-1", "#CLAN1"),
    ).rejects.toThrow("activity failed");
    expect(getPlayerRaw).toHaveBeenCalledTimes(1);
    expect(upsertPlayerCurrentSpy).not.toHaveBeenCalled();
  });
});
