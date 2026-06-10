import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    groupBy: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildFwaTrackedClanMinimalListRender,
  loadFwaTrackedClanMinimalListState,
} from "../src/services/TrackedClanListService";

describe("TrackedClanListService FWA minimal helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValue([]);
  });

  it("loads tracked clans and persisted member counts for the minimal FWA list", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: "leader-channel-1",
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
    ]);

    const state = await loadFwaTrackedClanMinimalListState();

    expect(state.refreshTags).toEqual(["#2QG2C08UP"]);
    expect(state.memberCountByTag.get("#2QG2C08UP")).toBe(49);
    expect(state.trackedClans).toHaveLength(1);
    expect(state.trackedClans[0]).toMatchObject({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      leadRoleId: "lead-role-1",
    });
    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanMemberCurrent.groupBy).toHaveBeenCalledTimes(1);
  });

  it("renders the exact minimal FWA list embed and refresh button", () => {
    const render = buildFwaTrackedClanMinimalListRender({
      refreshPrefix: "tracked-clan-list:fwa-summary:test",
      trackedClans: [
        {
          tag: "#2QG2C08UP",
          name: "Alpha Clan",
          loseStyle: "TRADITIONAL",
          mailChannelId: null,
          logChannelId: null,
          leaderChannelId: "leader-channel-1",
          clanRoleId: null,
          leadRoleId: "lead-role-1",
          clanBadge: null,
          shortName: "AC",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      ],
      memberCountByTag: new Map([["#2QG2C08UP", 49]]),
      refreshing: false,
    });

    const embed = render.embeds[0]?.toJSON() as any;
    const buttonRow = render.components[0]?.toJSON() as any;

    expect(embed?.title).toBe("Tracked Clans (FWA) (1)");
    expect(String(embed?.description ?? "")).toContain("**FWA**");
    expect(String(embed?.description ?? "")).toContain(
      "- [Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>) `#2QG2C08UP` | 49 👥",
    );
    expect(buttonRow?.components?.[0]?.custom_id).toBe("tracked-clan-list:fwa-summary:test:refresh");
    expect(buttonRow?.components?.[0]?.label).toBe("Refresh");
    expect(buttonRow?.components?.[0]?.disabled).toBe(false);
  });
});
