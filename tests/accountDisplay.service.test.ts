import { beforeEach, describe, expect, it, vi } from "vitest";

const accountRowsServiceMock = vi.hoisted(() => ({
  buildAccountsRows: vi.fn(),
}));

const trackedClanRepServiceMock = vi.hoisted(() => ({
  listTrackedClanRepBadgesForPlayerTags: vi.fn(),
}));

const emojiResolverServiceMock = vi.hoisted(() => ({
  fetchApplicationEmojiInventory: vi.fn(),
}));

vi.mock("../src/services/AccountRowsService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/AccountRowsService")>(
    "../src/services/AccountRowsService",
  );
  return {
    ...actual,
    buildAccountsRows: accountRowsServiceMock.buildAccountsRows,
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

describe("AccountDisplayService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    accountRowsServiceMock.buildAccountsRows.mockResolvedValue([]);
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

  it("combines canonical account rows with rep badges", async () => {
    accountRowsServiceMock.buildAccountsRows.mockResolvedValue([
      {
        tag: "#PYLQ0289",
        name: "Current Alpha",
        townHall: 16,
        weight: 210000,
        weightSource: "FwaClanMemberCurrent",
        clanTag: "#CURR1",
        clanName: "Current Clan",
        clanRole: "leader",
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 0,
      },
      {
        tag: "#QGRJ2222",
        name: "Current Bravo",
        townHall: 15,
        weight: 175000,
        weightSource: "WeightInputDeferment",
        clanTag: "#CURR1",
        clanName: "Current Clan",
        clanRole: null,
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 0,
      },
    ]);
    trackedClanRepServiceMock.listTrackedClanRepBadgesForPlayerTags.mockResolvedValue(
      new Map([["#PYLQ0289", ["<:badge:1>"]]]),
    );

    const rows = await buildAccountDisplayRows({
      guildId: "guild-1",
      linkedNameByTag: new Map([
        ["#PYLQ0289", "Linked Alpha"],
        ["#QGRJ2222", "Linked Bravo"],
      ]),
      tags: ["#PYLQ0289", "#QGRJ2222"],
    });

    expect(accountRowsServiceMock.buildAccountsRows).toHaveBeenCalledWith({
      guildId: "guild-1",
      linkedNameByTag: new Map([
        ["#PYLQ0289", "Linked Alpha"],
        ["#QGRJ2222", "Linked Bravo"],
      ]),
      tags: ["#PYLQ0289", "#QGRJ2222"],
    });
    expect(trackedClanRepServiceMock.listTrackedClanRepBadgesForPlayerTags).toHaveBeenCalledWith([
      "#PYLQ0289",
      "#QGRJ2222",
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        tag: "#PYLQ0289",
        repBadgeTokens: ["<:badge:1>"],
      }),
      expect.objectContaining({
        tag: "#QGRJ2222",
        repBadgeTokens: [],
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
