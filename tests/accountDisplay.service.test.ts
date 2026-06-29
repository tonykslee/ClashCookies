import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerActivity: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  externalPlayerWeightCurrent: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
}));

const playerCurrentServiceMock = vi.hoisted(() => ({
  listPlayerCurrentByTags: vi.fn(),
}));

const weightInputDefermentServiceMock = vi.hoisted(() => ({
  listOpenDeferredWeightsByClanAndPlayerTags: vi.fn(),
}));

const trackedClanRepServiceMock = vi.hoisted(() => ({
  listTrackedClanRepBadgesForPlayerTags: vi.fn(),
}));

const emojiResolverServiceMock = vi.hoisted(() => ({
  fetchApplicationEmojiInventory: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PlayerCurrentService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/PlayerCurrentService")>(
    "../src/services/PlayerCurrentService",
  );
  return {
    ...actual,
    playerCurrentService: playerCurrentServiceMock,
  };
});

vi.mock("../src/services/WeightInputDefermentService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/WeightInputDefermentService")>(
    "../src/services/WeightInputDefermentService",
  );
  return {
    ...actual,
    listOpenDeferredWeightsByClanAndPlayerTags: weightInputDefermentServiceMock.listOpenDeferredWeightsByClanAndPlayerTags,
  };
});

vi.mock("../src/services/TrackedClanRepService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/TrackedClanRepService")>(
    "../src/services/TrackedClanRepService",
  );
  return {
    ...actual,
    listTrackedClanRepBadgesForPlayerTags: trackedClanRepServiceMock.listTrackedClanRepBadgesForPlayerTags,
  };
});

vi.mock("../src/services/emoji/EmojiResolverService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/emoji/EmojiResolverService")>(
    "../src/services/emoji/EmojiResolverService",
  );
  return {
    ...actual,
    emojiResolverService: emojiResolverServiceMock,
  };
});

import {
  buildAccountDisplayRowText,
  buildAccountDisplayRows,
  resolveTownHallEmojiMap,
} from "../src/services/AccountDisplayService";

function makePlayerCurrentRow(overrides: Record<string, any> = {}) {
  return {
    playerTag: "#PYLQ0289",
    playerName: "Current Alpha",
    townHall: 16,
    currentClanTag: "#CURR1",
    currentClanName: "Current Clan",
    trophies: 6000,
    builderTrophies: 4000,
    warStars: 100,
    expLevel: 200,
    role: "leader",
    leagueName: "Legend League",
    currentWeight: null,
    currentWeightSource: null,
    currentWeightMeasuredAt: null,
    achievementsJson: null,
    lastSeenAt: new Date("2026-04-20T00:00:00.000Z"),
    lastFetchedAt: new Date("2026-04-20T00:00:00.000Z"),
    lastSource: "accounts-refresh",
    createdAt: new Date("2026-04-20T00:00:00.000Z"),
    updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("AccountDisplayService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);

    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(new Map());
    weightInputDefermentServiceMock.listOpenDeferredWeightsByClanAndPlayerTags.mockResolvedValue(new Map());
    trackedClanRepServiceMock.listTrackedClanRepBadgesForPlayerTags.mockResolvedValue(new Map());
    emojiResolverServiceMock.fetchApplicationEmojiInventory.mockResolvedValue({
      ok: false,
    });
  });

  it("renders one display row with rep badges, Town Hall emoji, crown, and compact weight", () => {
    const text = buildAccountDisplayRowText(
      {
        tag: "#PYLQ0289",
        name: "Displayed Alpha",
        repBadgeTokens: ["<:badge:1>", "<:badge:2>"],
        townHall: 16,
        weight: 210000,
        weightSource: "FwaClanMemberCurrent",
        clanTag: "#CURR1",
        clanName: "Current Clan",
        clanRole: "coleader",
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 0,
      },
      new Map([[16, "<:th16:116>"]]),
    );

    expect(text).toBe(
      "<:badge:1> <:badge:2> <:th16:116> [Displayed Alpha](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=PYLQ0289>) :crown: `#PYLQ0289` - 210k",
    );
  });

  it("builds display rows using the current-name, Town Hall, clan, weight, and rep precedence", async () => {
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(
      new Map([
        [
          "#PYLQ0289",
          makePlayerCurrentRow({
            playerTag: "#PYLQ0289",
            playerName: "Current Alpha",
            townHall: 16,
            currentClanTag: "#CURR1",
            currentClanName: "Current Clan",
            role: "leader",
          }),
        ],
        [
          "#QGRJ2222",
          makePlayerCurrentRow({
            playerTag: "#QGRJ2222",
            playerName: null,
            townHall: null,
            currentClanTag: null,
            currentClanName: null,
            role: null,
            currentWeight: null,
            lastSource: "fwa_player_catalog",
          }),
        ],
      ]),
    );

    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#PYLQ0289",
        name: "Activity Alpha",
        clanTag: "#CURR1",
        clanName: "Current Clan",
      },
      {
        tag: "#QGRJ2222",
        name: "Activity Bravo",
        clanTag: "#ACT2",
        clanName: "Activity Clan",
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#CURR1",
        townHall: 17,
        weight: 210000,
        sourceSyncedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#ACT2",
        townHall: 15,
        weight: null,
        sourceSyncedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        latestTownHall: 18,
        latestKnownWeight: 145000,
      },
      {
        playerTag: "#QGRJ2222",
        latestTownHall: 14,
        latestKnownWeight: 145000,
      },
    ]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        weight: 165000,
        measuredAt: new Date("2026-04-01T00:00:00.000Z"),
        source: "manual",
      },
      {
        playerTag: "#QGRJ2222",
        weight: 166000,
        measuredAt: new Date("2026-04-01T00:00:00.000Z"),
        source: "manual",
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#CURR1", name: "Current Clan" },
    ]);
    trackedClanRepServiceMock.listTrackedClanRepBadgesForPlayerTags.mockResolvedValue(
      new Map([["#PYLQ0289", ["<:badge:1>"]]]),
    );
    weightInputDefermentServiceMock.listOpenDeferredWeightsByClanAndPlayerTags.mockResolvedValue(
      new Map([
        ["#CURR1", new Map([["#PYLQ0289", 175000]])],
        ["#ACT2", new Map([["#QGRJ2222", 177000]])],
      ]),
    );

    const rows = await buildAccountDisplayRows({
      guildId: "guild-1",
      linkedNameByTag: new Map([
        ["#PYLQ0289", "Linked Alpha"],
        ["#QGRJ2222", "Linked Bravo"],
      ]),
      tags: ["#PYLQ0289", "#QGRJ2222"],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        tag: "#PYLQ0289",
        name: "Current Alpha",
        repBadgeTokens: ["<:badge:1>"],
        townHall: 16,
        weight: 210000,
        weightSource: "FwaClanMemberCurrent",
        clanTag: "#CURR1",
        clanName: "Current Clan",
        clanRole: "leader",
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 0,
      }),
      expect.objectContaining({
        tag: "#QGRJ2222",
        name: "Linked Bravo",
        repBadgeTokens: [],
        townHall: 15,
        weight: 177000,
        weightSource: "WeightInputDeferment",
        clanTag: "#ACT2",
        clanName: "Activity Clan",
        clanRole: null,
        clanState: "known",
        isTrackedFwaClan: false,
        trackedClanSortOrder: null,
      }),
    ]);
  });

  it("resolves Town Hall application emojis from exact and lowercase shortcode names", async () => {
    emojiResolverServiceMock.fetchApplicationEmojiInventory.mockResolvedValue({
      ok: true,
      snapshot: {
        exactByName: new Map([
          ["th16", { rendered: "<:th16:116>" }],
        ]),
        lowercaseByName: new Map([
          ["th17", { rendered: "<:th17:117>" }],
        ]),
      },
    });

    const map = await resolveTownHallEmojiMap({} as any);

    expect(map.get(16)).toBe("<:th16:116>");
    expect(map.get(17)).toBe("<:th17:117>");
    expect(map.has(18)).toBe(false);
  });
});
