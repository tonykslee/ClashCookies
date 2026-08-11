import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
  },
}));

const playerCurrentServiceMock = vi.hoisted(() => ({
  listPlayerCurrentByTags: vi.fn(),
  refreshCurrentPlayersFromLiveTags: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: {
    info: vi.fn(),
  },
}));

vi.mock("../src/services/PlayerCurrentService", () => ({
  playerCurrentService: playerCurrentServiceMock,
}));

vi.mock("../src/services/PlayerLinkService", () => ({
  normalizeClanTag: (input: string) => String(input ?? "").trim().toUpperCase(),
  normalizePlayerTag: (input: string) => String(input ?? "").trim().toUpperCase(),
}));

import {
  DEFAULT_LINKED_PLAYER_RECONCILE_BATCH_SIZE,
  LinkedPlayerCurrentReconcileService,
} from "../src/services/LinkedPlayerCurrentReconcileService";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function makeCurrent(input: {
  playerTag: string;
  currentClanTag: string | null;
  lastSource?: string;
  lastFetchedAt?: Date | null;
}): any {
  return {
    playerTag: input.playerTag,
    playerName: "Cached Player",
    townHall: 16,
    currentClanTag: input.currentClanTag,
    currentClanName: input.currentClanTag ? "Cached Clan" : null,
    trophies: 6000,
    builderTrophies: 4000,
    warStars: 100,
    expLevel: 200,
    role: "member",
    leagueName: "Legend League",
    currentWeight: null,
    currentWeightSource: null,
    currentWeightMeasuredAt: null,
    achievementsJson: null,
    lastSeenAt: input.lastFetchedAt ?? new Date("2026-06-01T00:00:00.000Z"),
    lastFetchedAt: input.lastFetchedAt ?? new Date("2026-06-01T00:00:00.000Z"),
    lastSource: input.lastSource ?? "activity_observe",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    source: "player_current",
    liveRefreshInvoked: false,
  };
}

function configureLinkedRows(rows: any[]): void {
  prismaMock.playerLink.findMany.mockResolvedValue(
    rows.map((row) => ({ playerTag: row.playerTag, discordUserId: "discord-1" })),
  );
  playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(
    new Map(rows.map((row) => [row.playerTag, row.current === null ? null : row.current ?? row])),
  );
  playerCurrentServiceMock.refreshCurrentPlayersFromLiveTags.mockImplementation(
    async (input: { playerTags: string[] }) => ({
      playerCount: input.playerTags.length,
      successCount: input.playerTags.length,
      failedPlayerTags: [],
    }),
  );
}

function baseInput(overrides: Record<string, unknown> = {}): any {
  return {
    configuredTrackedClanTags: ["#CLANA"],
    successfullyObservedTrackedClanTags: ["#CLANA"],
    observedTrackedClans: [{ clanTag: "#CLANA", memberTags: [] }],
    failedTrackedClanTags: [],
    cocService: { getPlayerRaw: vi.fn() },
    now: NOW,
    ...overrides,
  };
}

describe("LinkedPlayerCurrentReconcileService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(new Map());
    playerCurrentServiceMock.refreshCurrentPlayersFromLiveTags.mockResolvedValue({
      playerCount: 0,
      successCount: 0,
      failedPlayerTags: [],
    });
  });

  it("refreshes a linked departure from tracked FWA into a non-FWA clan", async () => {
    const playerTag = "#PLAYERA";
    configureLinkedRows([
      { playerTag, current: makeCurrent({ playerTag, currentClanTag: "#CLANA" }) },
    ]);

    const result = await new LinkedPlayerCurrentReconcileService().reconcile(baseInput());

    expect(result).toMatchObject({
      linkedPlayersConsidered: 1,
      departureCandidates: 1,
      refreshAttempted: 1,
      refreshSucceeded: 1,
    });
    expect(playerCurrentServiceMock.refreshCurrentPlayersFromLiveTags).toHaveBeenCalledWith(
      expect.objectContaining({
        playerTags: [playerTag],
        source: "live_refresh",
        now: NOW,
      }),
    );
  });

  it("refreshes a tracked departure that is now clanless", async () => {
    const playerTag = "#PLAYERB";
    configureLinkedRows([
      { playerTag, current: makeCurrent({ playerTag, currentClanTag: "#CLANA" }) },
    ]);

    const result = await new LinkedPlayerCurrentReconcileService().reconcile(baseInput());

    expect(result.departureCandidates).toBe(1);
    expect(playerCurrentServiceMock.refreshCurrentPlayersFromLiveTags).toHaveBeenCalledWith(
      expect.objectContaining({ playerTags: [playerTag], source: "live_refresh" }),
    );
  });

  it("refreshes stale movement between non-FWA clans", async () => {
    const playerTag = "#PLAYERC";
    configureLinkedRows([
      { playerTag, current: makeCurrent({ playerTag, currentClanTag: "#CLANX" }) },
    ]);

    const result = await new LinkedPlayerCurrentReconcileService().reconcile(
      baseInput({
        configuredTrackedClanTags: ["#CLANA"],
        successfullyObservedTrackedClanTags: ["#CLANA"],
      }),
    );

    expect(result.staleOutsideOrClanlessCandidates).toBe(1);
    expect(playerCurrentServiceMock.refreshCurrentPlayersFromLiveTags).toHaveBeenCalledWith(
      expect.objectContaining({ playerTags: [playerTag] }),
    );
  });

  it("refreshes stale confirmed-clanless rows that now have a non-FWA clan", async () => {
    const playerTag = "#PLAYERD";
    configureLinkedRows([
      {
        playerTag,
        current: makeCurrent({
          playerTag,
          currentClanTag: null,
          lastSource: "live_refresh",
        }),
      },
    ]);

    const result = await new LinkedPlayerCurrentReconcileService().reconcile(baseInput());

    expect(result.staleOutsideOrClanlessCandidates).toBe(1);
    expect(playerCurrentServiceMock.refreshCurrentPlayersFromLiveTags).toHaveBeenCalledWith(
      expect.objectContaining({ playerTags: [playerTag] }),
    );
  });

  it("refreshes missing PlayerCurrent rows and skips recently refreshed outside rows", async () => {
    const missingTag = "#PLAYERE";
    const freshTag = "#PLAYERF";
    configureLinkedRows([
      { playerTag: missingTag, current: null },
      {
        playerTag: freshTag,
        current: makeCurrent({
          playerTag: freshTag,
          currentClanTag: "#CLANX",
          lastFetchedAt: new Date("2026-08-11T11:30:00.000Z"),
        }),
      },
    ]);

    const result = await new LinkedPlayerCurrentReconcileService().reconcile(baseInput());

    expect(result.refreshAttempted).toBe(1);
    expect(playerCurrentServiceMock.refreshCurrentPlayersFromLiveTags).toHaveBeenCalledWith(
      expect.objectContaining({ playerTags: [missingTag] }),
    );
  });

  it("does not re-fetch linked players already observed in a tracked roster", async () => {
    const playerTag = "#PLAYERG";
    configureLinkedRows([
      { playerTag, current: makeCurrent({ playerTag, currentClanTag: "#CLANA" }) },
    ]);

    const result = await new LinkedPlayerCurrentReconcileService().reconcile(
      baseInput({ observedTrackedClans: [{ clanTag: "#CLANA", memberTags: [playerTag] }] }),
    );

    expect(result.alreadyObservedTrackedPlayersSkipped).toBe(1);
    expect(result.refreshAttempted).toBe(0);
    expect(playerCurrentServiceMock.refreshCurrentPlayersFromLiveTags).not.toHaveBeenCalled();
  });

  it("does not infer departure from a tracked clan whose observation failed", async () => {
    const playerTag = "#PLAYERH";
    configureLinkedRows([
      { playerTag, current: makeCurrent({ playerTag, currentClanTag: "#CLANA" }) },
    ]);

    const result = await new LinkedPlayerCurrentReconcileService().reconcile(
      baseInput({
        successfullyObservedTrackedClanTags: [],
        observedTrackedClans: [],
        failedTrackedClanTags: ["#CLANA"],
      }),
    );

    expect(result.departureCandidates).toBe(0);
    expect(result.refreshAttempted).toBe(0);
    expect(result.failedTrackedClanTags).toEqual(["#CLANA"]);
  });

  it("prioritizes departures before routine stale maintenance and reports the batch deferral", async () => {
    const departureTags = ["#PLAYERI", "#PLAYERJ"];
    const routineTag = "#PLAYERK";
    configureLinkedRows([
      ...departureTags.map((playerTag) => ({
        playerTag,
        current: makeCurrent({ playerTag, currentClanTag: "#CLANA" }),
      })),
      {
        playerTag: routineTag,
        current: makeCurrent({ playerTag: routineTag, currentClanTag: "#CLANX" }),
      },
    ]);

    const result = await new LinkedPlayerCurrentReconcileService().reconcile(
      baseInput({ batchSize: 2 }),
    );

    expect(result.departureCandidates).toBe(2);
    expect(result.staleOutsideOrClanlessCandidates).toBe(1);
    expect(result.deferredByBatchBound).toBe(1);
    expect(playerCurrentServiceMock.refreshCurrentPlayersFromLiveTags).toHaveBeenCalledWith(
      expect.objectContaining({ playerTags: departureTags }),
    );
  });

  it("uses the default bounded maintenance batch", async () => {
    expect(DEFAULT_LINKED_PLAYER_RECONCILE_BATCH_SIZE).toBe(100);
  });
});
