import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: { findUnique: vi.fn() },
  fwaClanMemberCurrent: { findMany: vi.fn() },
  playerLink: { findMany: vi.fn() },
}));
const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));
vi.mock("../src/services/ClanLeadershipLookupService", () => ({
  lookupClanLeadershipForPairs: lookupMock,
}));

import {
  buildSyncLeaderAccountsButtonComponents,
  buildSyncLeaderAccountsLines,
  buildSyncLeaderAccountsPages,
  parseSyncLeaderAccountsButtonCustomId,
} from "../src/services/SyncLeaderAccountsViewService";
import { handleSyncLeaderAccountsButtonInteraction } from "../src/services/SyncLeaderAccountsInteractionService";

const USER_ONE = "111111111111111111";
const USER_TWO = "222222222222222222";
const TRACKED_MESSAGE_ID = "123456789012345678";
const SOURCE_MESSAGE_ID = "987654321098765432";

function makeMetadata(clans = [
  { code: "RD", clanTag: "#PYLQ", clanName: "Rising Dawn", emojiId: "1", emojiName: "rd", emojiInline: "<:rd:1>" },
  { code: "ZG", clanTag: "#PYLG", clanName: "Zero Gravity", emojiId: "2", emojiName: "zg", emojiInline: "<:zg:2>" },
  { code: "RR", clanTag: "#PYLU", clanName: "Rocky Road", emojiId: "3", emojiName: "rr", emojiInline: "<:rr:3>" },
]) {
  return {
    syncTimeIso: "2026-10-27T12:00:00.000Z",
    syncEpochSeconds: 1793102400,
    roleId: "333333333333333333",
    clans,
  } as any;
}

function makeTracked(metadata = makeMetadata(), overrides: Record<string, unknown> = {}) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: TRACKED_MESSAGE_ID,
    featureType: "SYNC_TIME_POST",
    status: "ACTIVE",
    referenceId: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    metadata,
    claims: [],
    ...overrides,
  };
}

function makeButtonInteraction(userId: string, customId: string) {
  const interaction: any = {
    customId,
    user: { id: userId },
    guildId: "guild-1",
    guild: { id: "guild-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction;
}

describe("Sync leader accounts button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeTracked());
    lookupMock.mockImplementation(async (pairs: Array<{ clanTag: string; discordUserId: string }>) => ({
      entries: pairs.map((pair) => {
        const clanTag = pair.clanTag.toUpperCase();
        const accounts = pair.discordUserId === USER_ONE
          ? clanTag === "#PYLQ"
            ? [{ clanTag, discordUserId: pair.discordUserId, playerTag: "#2QG2", playerName: "attk for me", role: "leader" }]
            : clanTag === "#PYLG"
              ? []
              : [
                  { clanTag, discordUserId: pair.discordUserId, playerTag: "#2QG4", playerName: "Tilonius", role: "leader" },
                  { clanTag, discordUserId: pair.discordUserId, playerTag: "#2QG5", playerName: "Tony", role: "coLeader" },
                ]
          : clanTag === "#PYLQ"
            ? [{ clanTag, discordUserId: pair.discordUserId, playerTag: "#2QG2", playerName: "attk for me", role: "leader" }]
            : [];
        return { clanTag, discordUserId: pair.discordUserId, rosterAvailable: true, observedAt: null, accounts };
      }),
    }));
  });

  it("uses one persistent secondary button and parses its bounded page reference", () => {
    const button = buildSyncLeaderAccountsButtonComponents(TRACKED_MESSAGE_ID)[0].toJSON().components[0] as any;
    expect(button.label).toBe("My Leader Accounts");
    expect(button.style).toBe(2);
    expect(button.custom_id).toBe("sync-leaders:v1:123456789012345678:0");
    expect(parseSyncLeaderAccountsButtonCustomId(button.custom_id)).toEqual({
      trackedMessageId: TRACKED_MESSAGE_ID,
      page: 0,
    });
    expect(parseSyncLeaderAccountsButtonCustomId("sync-leaders:v1:other-guild:0")).toBeNull();
  });

  it("renders all metadata clans in order with viewer-specific roles and empty/unavailable states", () => {
    const metadata = makeMetadata([
      { code: "RD", clanTag: "#PYLQ", clanName: "Rising Dawn", emojiId: "1", emojiName: "rd", emojiInline: "<:rd:1>" },
      { code: "ZG", clanTag: "#PYLG", clanName: "Zero Gravity", emojiId: "2", emojiName: "zg", emojiInline: "<:zg:2>" },
      { code: "RR", clanTag: "#PYLU", clanName: "Rocky Road", emojiId: null, emojiName: null, emojiInline: "" },
      { code: "RD", clanTag: "#PYLQ", clanName: "Duplicate", emojiId: "9", emojiName: "duplicate", emojiInline: "<:duplicate:9>" },
    ]);
    const lines = buildSyncLeaderAccountsLines({
      metadata,
      lookup: {
        entries: [
          { clanTag: "#PYLQ", discordUserId: USER_ONE, rosterAvailable: true, observedAt: null, accounts: [{ clanTag: "#PYLQ", discordUserId: USER_ONE, playerTag: "#2QG2", playerName: "attk for me", role: "leader" }] },
          { clanTag: "#PYLG", discordUserId: USER_ONE, rosterAvailable: true, observedAt: null, accounts: [{ clanTag: "#PYLG", discordUserId: USER_ONE, playerTag: "#2QG3", playerName: "Curious George", role: "coLeader" }] },
          { clanTag: "#PYLU", discordUserId: USER_ONE, rosterAvailable: false, observedAt: null, accounts: [] },
        ],
      },
      discordUserId: USER_ONE,
    });
    expect(lines).toEqual([
      "<:rd:1> **RD** (👑 attk for me)",
      "<:zg:2> **ZG** (Curious George)",
      "🏷️ **RR** (Roster unavailable)",
    ]);
    expect(lines.every((line) => !line.startsWith("-"))).toBe(true);
  });

  it("preserves the first duplicate clan metadata entry in the shared interaction/view path", () => {
    const metadata = makeMetadata([
      { code: "FIRST", clanTag: "#PYLQ", clanName: "First", emojiId: "1", emojiName: "first", emojiInline: "🅰️" },
      { code: "SECOND", clanTag: "#pylq", clanName: "Second", emojiId: "2", emojiName: "second", emojiInline: "🅱️" },
      { code: "ZG", clanTag: "#PYLG", clanName: "Zero Gravity", emojiId: "3", emojiName: "zg", emojiInline: "🆉" },
    ]);
    const lines = buildSyncLeaderAccountsLines({
      metadata,
      lookup: { entries: [] },
      discordUserId: USER_ONE,
    });

    expect(lines).toEqual([
      "🅰️ **FIRST** (Roster unavailable)",
      "🆉 **ZG** (Roster unavailable)",
    ]);
  });

  it.each([
    ["replaced", { status: "REPLACED" }],
    ["expired", { expiresAt: new Date("2026-01-01T00:00:00.000Z") }],
    ["cross-guild", { guildId: "guild-2" }],
    ["deleted", null],
  ])("rejects an automatic status with a %s source sync", async (_label, sourceOverrides) => {
    const automatic = makeTracked(makeMetadata(), { referenceId: SOURCE_MESSAGE_ID });
    const source = sourceOverrides
      ? makeTracked(makeMetadata(), { messageId: SOURCE_MESSAGE_ID, ...sourceOverrides })
      : null;
    prismaMock.trackedMessage.findUnique
      .mockResolvedValueOnce(automatic)
      .mockResolvedValueOnce(source);
    const interaction = makeButtonInteraction(USER_ONE, `sync-leaders:v1:${TRACKED_MESSAGE_ID}:0`);

    await handleSyncLeaderAccountsButtonInteraction(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: "This sync status button is no longer available.",
    }));
    expect(lookupMock).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls[0][0].content).toBe("This sync status button is no longer available.");
  });

  it("isolates each clicking user and keeps multiple matching accounts in one clan", async () => {
    const first = makeButtonInteraction(USER_ONE, "sync-leaders:v1:123456789012345678:0");
    await handleSyncLeaderAccountsButtonInteraction(first);
    const firstDescription = first.editReply.mock.calls[0][0].embeds[0].toJSON().description;
    expect(firstDescription).toContain("👑 attk for me");
    expect(firstDescription).toContain("👑 Tilonius, Tony");
    expect(firstDescription).not.toContain("Curious George");

    const second = makeButtonInteraction(USER_TWO, "sync-leaders:v1:123456789012345678:0");
    await handleSyncLeaderAccountsButtonInteraction(second);
    const secondDescription = second.editReply.mock.calls[0][0].embeds[0].toJSON().description;
    expect(secondDescription).toContain("👑 attk for me");
    expect(secondDescription).not.toContain("Tilonius");
    expect(secondDescription).not.toContain("Curious George");
    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(lookupMock.mock.calls[0][0]).toHaveLength(3);
  });

  it("paginates complete output without dropping clans", () => {
    const tagAlphabet = "PYLQGRJCUV0289";
    const metadata = makeMetadata(Array.from({ length: 300 }, (_, index) => ({
      code: `C${index}`,
      clanTag: `#2QG${tagAlphabet[index % tagAlphabet.length]}${tagAlphabet[Math.floor(index / tagAlphabet.length) % tagAlphabet.length]}${tagAlphabet[Math.floor(index / (tagAlphabet.length * tagAlphabet.length))]}`,
      clanName: `Clan ${index}`,
      emojiId: String(index),
      emojiName: `clan${index}`,
      emojiInline: `<:c${index}:${index}>`,
    })));
    const pages = buildSyncLeaderAccountsPages({ metadata, lookup: { entries: [] }, discordUserId: USER_ONE });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("\n").match(/\*\*C\d+\*\*/g)).toHaveLength(300);
  });

  it("keeps pagination restart-safe and viewer-specific across page clicks", async () => {
    const tagAlphabet = "PYLQGRJCUV0289";
    const metadata = makeMetadata(Array.from({ length: 300 }, (_, index) => ({
      code: `P${index}`,
      clanTag: `#2QG${tagAlphabet[index % tagAlphabet.length]}${tagAlphabet[Math.floor(index / tagAlphabet.length) % tagAlphabet.length]}${tagAlphabet[Math.floor(index / (tagAlphabet.length * tagAlphabet.length))]}`,
      clanName: `Clan ${index}`,
      emojiId: String(index),
      emojiName: `clan${index}`,
      emojiInline: `🏷️`,
    })));
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeTracked(metadata));
    lookupMock.mockImplementation(async (pairs: Array<{ clanTag: string; discordUserId: string }>) => ({
      entries: pairs.map((pair) => ({
        clanTag: pair.clanTag,
        discordUserId: pair.discordUserId,
        rosterAvailable: true,
        observedAt: null,
        accounts: pair.discordUserId === USER_ONE
          ? [{ clanTag: pair.clanTag, discordUserId: pair.discordUserId, playerTag: "#P1", playerName: "Only One", role: "leader" }]
          : [{ clanTag: pair.clanTag, discordUserId: pair.discordUserId, playerTag: "#P2", playerName: "Only Two", role: "coLeader" }],
      })),
    }));

    const first = makeButtonInteraction(USER_ONE, `sync-leaders:v1:${TRACKED_MESSAGE_ID}:0`);
    await handleSyncLeaderAccountsButtonInteraction(first);
    const firstReply = first.editReply.mock.calls[0][0];
    const nextButton = firstReply.components[0].toJSON().components[1];
    expect(nextButton.custom_id).toBe(`sync-leaders:v1:${TRACKED_MESSAGE_ID}:1`);
    expect(firstReply.embeds[0].toJSON().description).toContain("Only One");
    expect(firstReply.embeds[0].toJSON().description).not.toContain("Only Two");

    const second = makeButtonInteraction(USER_TWO, nextButton.custom_id);
    await handleSyncLeaderAccountsButtonInteraction(second);
    const secondReply = second.editReply.mock.calls[0][0];
    expect(secondReply.embeds[0].toJSON().description).toContain("Only Two");
    expect(secondReply.embeds[0].toJSON().description).not.toContain("Only One");
    expect(lookupMock.mock.calls.at(-1)?.[0].every((pair: { discordUserId: string }) => pair.discordUserId === USER_TWO)).toBe(true);
  });
});
