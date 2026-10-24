import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  fwaClanMemberCurrent: { findMany: vi.fn() },
  playerLink: { findMany: vi.fn() },
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

import { lookupClanLeadershipForPairs } from "../src/services/ClanLeadershipLookupService";

describe("ClanLeadershipLookupService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
  });

  it("bulk-reads requested rosters and links, normalizes roles, and preserves deterministic account order", async () => {
    const observedAt = new Date("2026-10-23T12:00:00.000Z");
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      { clanTag: "#2qg2", playerTag: "#2qg9", playerName: "Co*Name", role: "co.leader", sourceSyncedAt: observedAt },
      { clanTag: "#2QG2", playerTag: "#2QG8", playerName: "Lead", role: "LEADER", sourceSyncedAt: observedAt },
      { clanTag: "#2QG2", playerTag: "#2QGL", playerName: "Elder", role: "elder", sourceSyncedAt: observedAt },
      { clanTag: "#PYLQ", playerTag: "#PYLQ2", playerName: "Other", role: "leader", sourceSyncedAt: observedAt },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#2QG8", discordUserId: "111111111111111111" },
      { playerTag: "#2QG9", discordUserId: "111111111111111111" },
      { playerTag: "#2QGL", discordUserId: "111111111111111111" },
      { playerTag: "#PYLQ2", discordUserId: "222222222222222222" },
    ]);

    const result = await lookupClanLeadershipForPairs([
      { clanTag: "2qg2", discordUserId: "111111111111111111" },
      { clanTag: "#2QG2", discordUserId: "111111111111111111" },
      { clanTag: "#pylq", discordUserId: "222222222222222222" },
    ]);

    expect(result.entries).toEqual([
      {
        clanTag: "#2QG2",
        discordUserId: "111111111111111111",
        rosterAvailable: true,
        observedAt,
        accounts: [
          expect.objectContaining({ playerTag: "#2QG8", playerName: "Lead", role: "leader" }),
          expect.objectContaining({ playerTag: "#2QG9", playerName: "Co*Name", role: "coLeader" }),
        ],
      },
      {
        clanTag: "#PYLQ",
        discordUserId: "222222222222222222",
        rosterAvailable: true,
        observedAt,
        accounts: [expect.objectContaining({ playerTag: "#PYLQ2", role: "leader" })],
      },
    ]);
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.playerLink.findMany).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable roster evidence separately from an available roster with no matching linked co-leader", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      { clanTag: "#2QG2", playerTag: "#2QG9", playerName: "Unlinked", role: "coLeader", sourceSyncedAt: null },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#2QG9", discordUserId: "invalid-discord-id" },
    ]);

    const result = await lookupClanLeadershipForPairs([
      { clanTag: "#2QG2", discordUserId: "111111111111111111" },
      { clanTag: "#PYLQ", discordUserId: "111111111111111111" },
    ]);

    expect(result.entries).toEqual([
      expect.objectContaining({ clanTag: "#2QG2", rosterAvailable: true, accounts: [] }),
      expect.objectContaining({ clanTag: "#PYLQ", rosterAvailable: false, accounts: [] }),
    ]);
  });

  it("rejects invalid Discord IDs and does not query for them", async () => {
    const result = await lookupClanLeadershipForPairs([
      { clanTag: "#CLAN", discordUserId: "not-a-snowflake" },
    ]);

    expect(result.entries).toEqual([]);
    expect(prismaMock.fwaClanMemberCurrent.findMany).not.toHaveBeenCalled();
    expect(prismaMock.playerLink.findMany).not.toHaveBeenCalled();
  });
});
