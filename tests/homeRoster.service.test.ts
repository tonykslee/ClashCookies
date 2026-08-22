import { describe, expect, it, vi } from "vitest";
import {
  getHomeRosterCoverage,
  HomeRosterService,
} from "../src/services/HomeRosterService";

const observedAt = new Date("2026-08-22T12:00:00.000Z");

function homeRow(playerTag: string, input: Partial<Record<string, unknown>> = {}) {
  return {
    id: `home-${playerTag}`,
    guildId: "guild-1",
    playerTag,
    clanTag: "#P0Y0",
    startedAtSyncTime: new Date("2026-08-01T12:00:00.000Z"),
    qualifiedAtSyncTime: new Date("2026-08-03T12:00:00.000Z"),
    endedAtSyncTime: null,
    establishmentSource: "AUTO_3_SYNC",
    endReason: null,
    ...input,
  };
}

function generatedTag(index: number): string {
  const digits = "0289";
  let value = index;
  let suffix = "";
  for (let position = 0; position < 3; position += 1) {
    suffix = digits[value % digits.length] + suffix;
    value = Math.floor(value / digits.length);
  }
  return `#P${suffix}`;
}

function makeDependencies(input: {
  homes?: any[];
  current?: any[];
  feedState?: any;
  playerCurrent?: Map<string, any>;
  catalog?: any[];
  pending?: any[];
  clans?: any[];
} = {}) {
  const db = {
    clanHomeMembershipPeriod: { findMany: vi.fn().mockResolvedValue(input.homes ?? []) },
    fwaClanMemberCurrent: { findMany: vi.fn().mockResolvedValue(input.current ?? []) },
    fwaPlayerCatalog: { findMany: vi.fn().mockResolvedValue(input.catalog ?? []) },
    trackedClan: { findMany: vi.fn().mockResolvedValue(input.clans ?? []) },
  };
  const feedSyncStateService = { getState: vi.fn().mockResolvedValue(input.feedState ?? null) };
  const playerCurrentService = {
    listPlayerCurrentByTags: vi.fn().mockResolvedValue(input.playerCurrent ?? new Map()),
  };
  const homeMembershipService = {
    getPendingTransferCandidates: vi.fn().mockResolvedValue(input.pending ?? []),
  };
  return { db, feedSyncStateService, playerCurrentService, homeMembershipService };
}

describe("HomeRosterService", () => {
  it("classifies recent, stale, and unavailable feed observations deterministically", () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    expect(getHomeRosterCoverage({
      lastSuccessAt: new Date("2026-08-22T11:30:00.000Z"),
      now,
      cadenceMinutes: 15,
    })).toMatchObject({ coverage: "CURRENT" });
    expect(getHomeRosterCoverage({
      lastSuccessAt: new Date("2026-08-22T10:00:00.000Z"),
      now,
      cadenceMinutes: 15,
    })).toMatchObject({ coverage: "STALE" });
    expect(getHomeRosterCoverage({ lastSuccessAt: null, now })).toMatchObject({
      coverage: "UNAVAILABLE",
      observedAt: null,
    });
  });

  it("counts active Home members, presence, open slots, and unassigned occupants in bulk", async () => {
    const homes = Array.from({ length: 50 }, (_, index) => homeRow(generatedTag(index)));
    const current = [
      ...homes.slice(0, 47).map((row) => ({
        playerTag: row.playerTag,
        playerName: `Home ${row.playerTag}`,
        sourceSyncedAt: new Date("2026-07-01T12:00:00.000Z"),
      })),
      { playerTag: "#Y002", playerName: "Temporary One" },
      { playerTag: "#Y008", playerName: "Temporary Two" },
      { playerTag: "#Y009", playerName: "Temporary Three" },
    ];
    const dependencies = makeDependencies({ homes, current, feedState: { lastSuccessAt: observedAt } });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
      now: new Date("2026-08-22T12:15:00.000Z"),
    });

    expect(roster).toMatchObject({
      homeMemberCount: 50,
      presentCount: 47,
      awayCount: 3,
      unknownCount: 0,
      openHomeSpots: 0,
      currentClanMemberCount: 50,
      unassignedPresentCount: 3,
      currentRosterCoverage: "CURRENT",
      currentRosterObservedAt: observedAt,
    });
    expect(dependencies.db.clanHomeMembershipPeriod.findMany).toHaveBeenCalledTimes(1);
    expect(dependencies.db.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(dependencies.playerCurrentService.listPlayerCurrentByTags).toHaveBeenCalledTimes(1);
    expect(dependencies.homeMembershipService.getPendingTransferCandidates).toHaveBeenCalledTimes(1);
  });

  it("keeps ended periods out and preserves Unknown when no successful feed observation exists", async () => {
    const homes = [homeRow("#P000"), homeRow("#P002", { endedAtSyncTime: new Date("2026-08-20T12:00:00.000Z") })];
    const dependencies = makeDependencies({ homes });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
    });

    expect(roster).toMatchObject({ homeMemberCount: 1, presentCount: 0, awayCount: 0, unknownCount: 1 });
    expect(dependencies.db.clanHomeMembershipPeriod.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { guildId: "guild-1", clanTag: "#P0Y0", endedAtSyncTime: null } }),
    );
  });

  it("keeps a recent good roster current even when the latest attempt failed", async () => {
    const dependencies = makeDependencies({
      homes: [homeRow("#P000"), homeRow("#P002")],
      current: [{ playerTag: "#P000", playerName: "Present" }],
      feedState: { lastSuccessAt: observedAt, lastStatus: "FAILURE" },
    });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
      now: new Date("2026-08-22T12:15:00.000Z"),
    });

    expect(roster.currentRosterCoverage).toBe("CURRENT");
    expect(roster.presentCount).toBe(1);
    expect(roster.awayCount).toBe(1);
  });

  it("marks old successful coverage stale without exposing current physical counts", async () => {
    const oldObservedAt = new Date("2026-08-22T10:00:00.000Z");
    const dependencies = makeDependencies({
      homes: [homeRow("#P000"), homeRow("#P002")],
      current: [
        { playerTag: "#P000", playerName: "Present" },
        { playerTag: "#Y002", playerName: "Temporary" },
      ],
      feedState: { lastSuccessAt: oldObservedAt },
    });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
      now: new Date("2026-08-22T12:00:00.000Z"),
    });

    expect(roster).toMatchObject({
      currentRosterCoverage: "STALE",
      currentRosterObservedAt: oldObservedAt,
      presentCount: 0,
      awayCount: 0,
      unknownCount: 2,
      currentClanMemberCount: null,
      unassignedPresentCount: null,
    });
  });

  it("derives Away from successful Home coverage even when the destination is unknown", async () => {
    const dependencies = makeDependencies({
      homes: [homeRow("#P000"), homeRow("#P002")],
      current: [{ playerTag: "#P000", playerName: "Present Name" }],
      feedState: { lastSuccessAt: observedAt },
      playerCurrent: new Map([
        ["#P002", {
          playerTag: "#P002",
          playerName: "Away Name",
          currentClanTag: "#Y002",
          currentClanName: "Destination",
          lastSource: "activity_observe",
          lastFetchedAt: observedAt,
          lastSeenAt: observedAt,
          updatedAt: observedAt,
        }],
      ]),
    });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
      now: new Date("2026-08-22T12:15:00.000Z"),
    });

    expect(roster.presentCount).toBe(1);
    expect(roster.awayCount).toBe(1);
    expect(roster.members.find((member) => member.playerTag === "#P002")).toMatchObject({
      presence: "AWAY",
      currentClanTag: "#Y002",
      currentClanName: "Destination",
      currentLocationObservedAt: observedAt,
    });
  });

  it("suppresses non-authoritative PlayerCurrent locations and uses deterministic name fallbacks", async () => {
    const dependencies = makeDependencies({
      homes: [homeRow("#P000"), homeRow("#P002"), homeRow("#P008")],
      current: [{ playerTag: "#P000", playerName: "Roster Name" }],
      feedState: { lastSuccessAt: observedAt },
      playerCurrent: new Map([
        ["#P000", { playerTag: "#P000", playerName: "PlayerCurrent Name", lastSource: "player_current" }],
        ["#P002", { playerTag: "#P002", playerName: "Current Name", currentClanTag: "#Y002", lastSource: "player_current" }],
      ]),
      catalog: [{ playerTag: "#P008", latestName: "Catalog Name" }],
    });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
    });

    expect(roster.members.find((member) => member.playerTag === "#P000")?.playerName).toBe("Roster Name");
    expect(roster.members.find((member) => member.playerTag === "#P002")).toMatchObject({
      playerName: "Current Name",
      currentClanTag: null,
      currentClanName: null,
    });
    expect(roster.members.find((member) => member.playerTag === "#P008")?.playerName).toBe("Catalog Name");
  });

  it("suppresses an authoritative location observed before the Home roster", async () => {
    const dependencies = makeDependencies({
      homes: [homeRow("#P002")],
      feedState: { lastSuccessAt: observedAt },
      playerCurrent: new Map([["#P002", {
        playerTag: "#P002",
        currentClanTag: "#Y002",
        currentClanName: "Destination",
        lastSource: "activity_observe",
        lastSeenAt: new Date("2026-08-22T11:59:00.000Z"),
      }]]),
    });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
      now: new Date("2026-08-22T12:15:00.000Z"),
    });

    expect(roster.members[0]).toMatchObject({
      presence: "AWAY",
      currentClanTag: null,
      currentClanName: null,
      currentLocationObservedAt: null,
    });
  });

  it("shows an authoritative location observed at or after the Home roster", async () => {
    const locationObservedAt = new Date("2026-08-22T12:01:00.000Z");
    const dependencies = makeDependencies({
      homes: [homeRow("#P002")],
      feedState: { lastSuccessAt: observedAt },
      playerCurrent: new Map([["#P002", {
        playerTag: "#P002",
        currentClanTag: "#Y002",
        currentClanName: "Destination",
        lastSource: "activity_observe",
        lastSeenAt: locationObservedAt,
      }]]),
    });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
      now: new Date("2026-08-22T12:15:00.000Z"),
    });

    expect(roster.members[0]).toMatchObject({
      presence: "AWAY",
      currentClanTag: "#Y002",
      currentClanName: "Destination",
      currentLocationObservedAt: locationObservedAt,
    });
  });

  it("suppresses a Home-clan claim and generic updatedAt-only evidence", async () => {
    const dependencies = makeDependencies({
      homes: [homeRow("#P002"), homeRow("#P008")],
      feedState: { lastSuccessAt: observedAt },
      playerCurrent: new Map([
        ["#P002", {
          playerTag: "#P002",
          currentClanTag: "#P0Y0",
          currentClanName: "Home Clan",
          lastSource: "activity_observe",
          lastSeenAt: observedAt,
        }],
        ["#P008", {
          playerTag: "#P008",
          currentClanTag: "#Y008",
          currentClanName: "Destination",
          lastSource: "activity_observe",
          updatedAt: new Date("2026-08-22T12:15:00.000Z"),
        }],
      ]),
    });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
      now: new Date("2026-08-22T12:15:00.000Z"),
    });

    expect(roster.members.map((member) => member.currentClanTag)).toEqual([null, null]);
  });

  it("annotates pending transfers and resolves destination names with one tracked-clan read", async () => {
    const dependencies = makeDependencies({
      homes: [homeRow("#P000")],
      feedState: { lastSuccessAt: observedAt },
      pending: [{
        id: "candidate-1",
        guildId: "guild-1",
        playerTag: "#P000",
        homeMembershipPeriodId: "home-#P000",
        fromClanTag: "#P0Y0",
        toClanTag: "#Y002",
        startedAtSyncTime: new Date("2026-08-10T12:00:00.000Z"),
        qualifiedAtSyncTime: new Date("2026-08-12T12:00:00.000Z"),
        status: "PENDING",
      }],
      clans: [{ tag: "#P0Y0", name: "Home Clan" }, { tag: "#Y002", name: "Destination Clan" }],
    });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
    });

    expect(roster).toMatchObject({ clanName: "Home Clan", pendingTransferCount: 1 });
    expect(roster.members[0]?.pendingTransfer).toMatchObject({
      id: "candidate-1",
      toClanTag: "#Y002",
      toClanName: "Destination Clan",
    });
    expect(dependencies.db.trackedClan.findMany).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending candidate belonging to an older Home period", async () => {
    const dependencies = makeDependencies({
      homes: [homeRow("#P000", { id: "home-period-B" })],
      pending: [{
        id: "candidate-old",
        guildId: "guild-1",
        playerTag: "#P000",
        homeMembershipPeriodId: "home-period-A",
        fromClanTag: "#P0Y0",
        toClanTag: "#Y002",
        startedAtSyncTime: new Date("2026-08-10T12:00:00.000Z"),
        qualifiedAtSyncTime: new Date("2026-08-12T12:00:00.000Z"),
        status: "PENDING",
      }],
    });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
    });

    expect(roster.pendingTransferCount).toBe(0);
    expect(roster.members[0]?.pendingTransfer).toBeNull();
    expect(dependencies.db.trackedClan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tag: { in: ["#P0Y0"] } },
    }));
  });
});
