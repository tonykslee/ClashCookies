import { describe, expect, it, vi } from "vitest";
import { HomeRosterService } from "../src/services/HomeRosterService";

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
  it("counts active Home members, presence, open slots, and unassigned occupants in bulk", async () => {
    const homes = Array.from({ length: 50 }, (_, index) => homeRow(generatedTag(index)));
    const current = [
      ...homes.slice(0, 47).map((row) => ({ playerTag: row.playerTag, playerName: `Home ${row.playerTag}` })),
      { playerTag: "#Y002", playerName: "Temporary One" },
      { playerTag: "#Y008", playerName: "Temporary Two" },
      { playerTag: "#Y009", playerName: "Temporary Three" },
    ];
    const dependencies = makeDependencies({ homes, current, feedState: { lastSuccessAt: observedAt } });
    const roster = await new HomeRosterService(dependencies as any).getClanHomeRoster({
      guildId: "guild-1",
      clanTag: "#P0Y0",
    });

    expect(roster).toMatchObject({
      homeMemberCount: 50,
      presentCount: 47,
      awayCount: 3,
      unknownCount: 0,
      openHomeSpots: 0,
      currentClanMemberCount: 50,
      unassignedPresentCount: 3,
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

  it("does not manufacture a destination from stale PlayerCurrent evidence and uses deterministic name fallbacks", async () => {
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

  it("annotates pending transfers and resolves destination names with one tracked-clan read", async () => {
    const dependencies = makeDependencies({
      homes: [homeRow("#P000")],
      feedState: { lastSuccessAt: observedAt },
      pending: [{
        id: "candidate-1",
        guildId: "guild-1",
        playerTag: "#P000",
        homeMembershipPeriodId: "home-P1",
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
});
