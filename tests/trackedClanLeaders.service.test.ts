import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: { findMany: vi.fn() },
  cwlTrackedClan: { findMany: vi.fn() },
  raidTrackedClan: { findMany: vi.fn() },
  fwaClanMemberCurrent: { findMany: vi.fn() },
  fwaFeedSyncState: { findMany: vi.fn() },
  playerLink: { findMany: vi.fn() },
}));

const memberRefreshMock = vi.hoisted(() => vi.fn());
const queueMock = vi.hoisted(() => vi.fn(async (_context: unknown, run: () => Promise<unknown>) => run()));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));
vi.mock("../src/services/CwlRegistryService", () => ({
  resolveCurrentCwlSeasonKey: vi.fn(() => "2026-10"),
}));
vi.mock("../src/services/CoCQueueContext", () => ({ runWithCoCQueueContext: queueMock }));
vi.mock("../src/services/fwa-feeds/FwaClanMembersSyncService", () => ({
  FwaClanMembersSyncService: class {
    refreshCurrentClanMembersForClanTags = memberRefreshMock;
  },
}));

import {
  loadTrackedClanLeadersView,
  normalizeTrackedClanLeaderRole,
  refreshTrackedClanLeadersWithQueueContext,
} from "../src/services/TrackedClanLeadersService";

const fwaTag = "#2QG2C08UP";
const cwlTag = "#PYLQ0289";
const raidsTag = "#2RVGJYLC0";
const now = new Date("2026-10-23T12:00:00.000Z");

describe("TrackedClanLeadersService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockImplementation(async (args: any) =>
      args?.where?.tag?.in
        ? [{ tag: fwaTag, name: "Configured FWA", clanBadge: ":fwa:" }]
        : [{ tag: fwaTag, name: "FWA Alpha", clanBadge: ":fwa:" }],
    );
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { season: "2026-10", tag: cwlTag, name: "CWL Alpha", leagueLabel: "Crystal League II", createdAt: new Date("2026-10-02") },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([
      { clanTag: raidsTag.slice(1), name: "Raid Alpha", createdAt: new Date("2026-10-03") },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      { clanTag: fwaTag, playerTag: "#2QG2C08UPP", playerName: "Lead*One", role: "leader", sourceSyncedAt: now },
      { clanTag: fwaTag, playerTag: "#2QG2C08UPY", playerName: "CoTwo", role: "co-leader", sourceSyncedAt: now },
      { clanTag: fwaTag, playerTag: "#2QG2C08UPL", playerName: "Elder", role: "elder", sourceSyncedAt: now },
      { clanTag: cwlTag, playerTag: "#PYLQ0289P", playerName: "Cwl Co", role: "CoLeader", sourceSyncedAt: now },
      { clanTag: raidsTag, playerTag: "#2RVGJYLC0P", playerName: "Raid Lead", role: "leader", sourceSyncedAt: now },
    ]);
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([
      { scopeKey: fwaTag, lastAttemptAt: now, lastSuccessAt: now, lastStatus: "NOOP", lastErrorSummary: null, lastRowCount: 3 },
      { scopeKey: cwlTag, lastAttemptAt: now, lastSuccessAt: now, lastStatus: "SUCCESS", lastErrorSummary: null, lastRowCount: 1 },
      { scopeKey: raidsTag, lastAttemptAt: now, lastSuccessAt: now, lastStatus: "NOOP", lastErrorSummary: null, lastRowCount: 1 },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#2QG2C08UPP", discordUserId: "111111111111111111" },
      { playerTag: "#2QG2C08UPY", discordUserId: "111111111111111111" },
      { playerTag: "#PYLQ0289P", discordUserId: null },
    ]);
    memberRefreshMock.mockResolvedValue({ clanCount: 2, rowCount: 4, changedRowCount: 2, failedClans: [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes only current leader and co-leader roster roles", () => {
    expect(normalizeTrackedClanLeaderRole("leader")).toBe("leader");
    expect(normalizeTrackedClanLeaderRole("Co-Leader")).toBe("coLeader");
    expect(normalizeTrackedClanLeaderRole("co.leader")).toBe("coLeader");
    expect(normalizeTrackedClanLeaderRole("elder")).toBeNull();
    expect(normalizeTrackedClanLeaderRole("lead-role")).toBeNull();
  });

  it("combines all registries in order, normalizes bare RAIDS tags, and groups linked accounts", async () => {
    const view = await loadTrackedClanLeadersView({ now });

    expect(view.totalClanCount).toBe(3);
    expect(view.sections.map((section) => section.registry)).toEqual(["FWA", "CWL", "RAIDS"]);
    expect(view.displayedClanTags).toEqual([fwaTag, cwlTag, raidsTag]);
    expect(view.sections[0]?.clans[0]?.clanBadge).toBe(":fwa:");
    expect(view.sections[2]?.clans[0]?.clanTag).toBe(raidsTag);
    expect(view.sections[0]?.clans[0]?.leaderGroups).toEqual([
      {
        discordUserId: "111111111111111111",
        hasLeader: true,
        accounts: [
          expect.objectContaining({ playerName: "Lead*One", role: "leader" }),
          expect.objectContaining({ playerName: "CoTwo", role: "coLeader" }),
        ],
      },
    ]);
    expect(view.sections[1]?.clans[0]?.leaderGroups[0]).toEqual({
      discordUserId: null,
      hasLeader: false,
      accounts: [expect.objectContaining({ playerName: "Cwl Co", role: "coLeader" })],
    });
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.playerLink.findMany).toHaveBeenCalledTimes(1);
  });

  it("distinguishes unavailable, stale, and failed refresh states from an empty current roster", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      { clanTag: fwaTag, playerTag: "#2QG2C08UPP", playerName: "Old Lead", role: "leader", sourceSyncedAt: new Date("2026-08-01") },
    ]);
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([
      { scopeKey: fwaTag, lastAttemptAt: new Date("2026-08-02"), lastSuccessAt: new Date("2026-08-01"), lastStatus: "SUCCESS", lastErrorSummary: null },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    const stale = await loadTrackedClanLeadersView({ registry: "FWA", now });
    expect(stale.sections[0]?.clans[0]?.freshness).toBe("STALE");
    expect(stale.sections[0]?.clans[0]?.leaderGroups).toHaveLength(1);

    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([]);
    const unavailable = await loadTrackedClanLeadersView({ registry: "FWA", now });
    expect(unavailable.sections[0]?.clans[0]?.freshness).toBe("UNAVAILABLE");
    expect(unavailable.sections[0]?.clans[0]?.leaderGroups).toEqual([]);

    const failed = await loadTrackedClanLeadersView({ registry: "FWA", now, refreshFailedTags: [fwaTag] });
    expect(failed.sections[0]?.clans[0]?.freshness).toBe("REFRESH_FAILED");
  });

  it("does not treat a recent feed success as complete when current-member rows are missing", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([
      {
        scopeKey: fwaTag,
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastStatus: "SUCCESS",
        lastErrorSummary: null,
        lastRowCount: 25,
      },
    ]);

    const view = await loadTrackedClanLeadersView({ registry: "FWA", now });
    expect(view.sections[0]?.clans[0]?.freshness).toBe("UNAVAILABLE");
  });

  it("uses the configured clan-member cadence for freshness", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    const observedAt = new Date(now.getTime() - 50 * 60 * 1000);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      { clanTag: fwaTag, playerTag: "#2QG2C08UPP", playerName: "Lead", role: "leader", sourceSyncedAt: observedAt },
    ]);
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([
      { scopeKey: fwaTag, lastAttemptAt: observedAt, lastSuccessAt: observedAt, lastStatus: "NOOP", lastErrorSummary: null, lastRowCount: 1 },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);

    const defaultCadence = await loadTrackedClanLeadersView({ registry: "FWA", now });
    expect(defaultCadence.sections[0]?.clans[0]?.freshness).toBe("STALE");

    vi.stubEnv("FWA_CLAN_MEMBERS_SYNC_MINUTES", "60");
    const configuredCadence = await loadTrackedClanLeadersView({ registry: "FWA", now });
    expect(configuredCadence.sections[0]?.clans[0]?.freshness).toBe("CURRENT");
  });

  it("treats invalid linked Discord IDs as unlinked", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      { clanTag: fwaTag, playerTag: "#2QG2C08UPP", playerName: "Invalid Link", role: "leader", sourceSyncedAt: now },
    ]);
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([
      { scopeKey: fwaTag, lastAttemptAt: now, lastSuccessAt: now, lastStatus: "NOOP", lastErrorSummary: null, lastRowCount: 1 },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#2QG2C08UPP", discordUserId: "not-a-discord-id" },
    ]);

    const view = await loadTrackedClanLeadersView({ registry: "FWA", now });
    expect(view.sections[0]?.clans[0]?.leaderGroups[0]).toEqual({
      discordUserId: null,
      hasLeader: true,
      accounts: [expect.objectContaining({ playerName: "Invalid Link", discordUserId: null })],
    });
  });

  it("deduplicates refresh requests for clans present in multiple registries and preserves partial failures", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { season: "2026-10", tag: fwaTag, name: "CWL Same Clan", leagueLabel: null, createdAt: new Date("2026-10-02") },
      { season: "2026-10", tag: cwlTag, name: "CWL Other Clan", leagueLabel: null, createdAt: new Date("2026-10-02") },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([
      { clanTag: fwaTag.slice(1), name: "Raid Same Clan", createdAt: new Date("2026-10-03") },
      { clanTag: raidsTag.slice(1), name: "Raid Other Clan", createdAt: new Date("2026-10-03") },
    ]);
    memberRefreshMock.mockResolvedValue({ clanCount: 1, rowCount: 1, changedRowCount: 1, failedClans: [fwaTag] });

    const result = await refreshTrackedClanLeadersWithQueueContext({ cocService: {} as any, now });

    expect(memberRefreshMock).toHaveBeenCalledWith([fwaTag, cwlTag, raidsTag], { cocService: {}, concurrency: 4 });
    expect(result.failedClanTags).toEqual([fwaTag]);
    expect(result.view.sections.flatMap((section) => section.clans).find((clan) => clan.clanTag === cwlTag)?.freshness).toBe("CURRENT");
    expect(result.view.sections.flatMap((section) => section.clans).find((clan) => clan.clanTag === raidsTag)?.freshness).toBe("CURRENT");
    expect(queueMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "interactive" }), expect.any(Function));
  });

  it("preserves persisted freshness in mirror mode", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    vi.stubEnv("POLLING_MODE", "mirror");

    const result = await refreshTrackedClanLeadersWithQueueContext({ cocService: {} as any, now });
    expect(result.blockedReason).toBe("MIRROR_MODE_DISABLED");
    expect(result.failedClanTags).toEqual([]);
    expect(result.view.sections[0]?.clans[0]?.freshness).toBe("CURRENT");
    expect(memberRefreshMock).not.toHaveBeenCalled();
  });

  it("logs FAILURE when every refresh fails", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    memberRefreshMock.mockResolvedValue({ clanCount: 0, rowCount: 0, changedRowCount: 0, failedClans: [fwaTag] });

    const result = await refreshTrackedClanLeadersWithQueueContext({ cocService: {} as any, now });
    expect(result.refreshedClanTags).toEqual([]);
    expect(result.failedClanTags).toEqual([fwaTag]);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("status=FAILURE"));
    infoSpy.mockRestore();
  });
});
