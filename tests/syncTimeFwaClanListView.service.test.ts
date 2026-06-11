import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
} from "../src/services/TrackedMessageService";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
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
  buildSyncTimeFwaClanListMessagePayload,
  handleSyncTimeFwaClanListRefreshButton,
  SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID,
} from "../src/services/SyncTimeFwaClanListViewService";

function makeBaseMetadata() {
  return {
    syncTimeIso: "2026-06-10T12:00:00.000Z",
    syncEpochSeconds: 1749556800,
    roleId: "123456789012345678",
    clans: [
      {
        code: "AC",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        emojiId: "111",
        emojiName: "alpha",
        emojiInline: "<:alpha:111>",
      },
    ],
  };
}

function makeButtonInteraction(overrides?: Partial<Record<string, unknown>>) {
  return {
    customId: SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID,
    guildId: "guild-1",
    inGuild: () => true,
    message: {
      id: "sync-message-1",
      edit: vi.fn().mockResolvedValue(undefined),
    },
    user: { id: "user-1" },
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
    ...overrides,
  };
}

describe("SyncTimeFwaClanListViewService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedMessage.findUnique.mockReset();
    prismaMock.trackedMessage.update.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.groupBy.mockReset();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValue([]);
  });

  it("builds the sync-time payload with the FWA minimal clan list embed and refresh button", async () => {
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

    const payload = await buildSyncTimeFwaClanListMessagePayload({
      guildId: "guild-1",
      baseMetadata: makeBaseMetadata(),
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(payload.content).toContain("# Sync time :gem:");
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].toJSON().title).toBe("Tracked Clans (FWA) (1)");
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0].toJSON().components[0].custom_id).toBe(
      SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID,
    );
    expect(payload.metadata).toMatchObject({
      fwaClanListEnabled: true,
      fwaClanListRefreshExpiresAtIso: "2026-06-11T12:00:00.000Z",
      fwaClanListLastRefreshedAtIso: "2026-06-10T12:00:00.000Z",
    });
  });

  it("refreshes the same sync-time message after reloading clan list state", async () => {
    const fetchSpy = vi.spyOn(trackedMessageService, "fetchSyncTrackedMessageWithClaims");
    prismaMock.trackedMessage.findUnique.mockResolvedValueOnce({
      id: "tracked-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-1",
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: null,
      clanTag: null,
      remindAt: null,
      expiresAt: new Date("2026-06-10T13:00:00.000Z"),
      metadata: {
        ...makeBaseMetadata(),
        fwaClanListEnabled: true,
        fwaClanListRefreshExpiresAtIso: "2026-06-11T12:00:00.000Z",
        fwaClanListLastRefreshedAtIso: "2026-06-10T12:00:00.000Z",
      },
      claims: [],
    });
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
      { clanTag: "#2QG2C08UP", _count: { clanTag: 50 } },
    ]);

    const interaction = makeButtonInteraction();

    await handleSyncTimeFwaClanListRefreshButton(interaction as any);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("sync-message-1");
    expect(interaction.message.edit).toHaveBeenCalledTimes(1);
    const payload = interaction.message.edit.mock.calls[0]?.[0] as any;
    expect(payload.content).toContain("# Sync time :gem:");
    expect(String(payload.embeds[0].toJSON().description ?? "")).toContain("50");
    expect(payload.components[0].toJSON().components[0].custom_id).toBe(
      SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID,
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledTimes(1);
    const updateArg = prismaMock.trackedMessage.update.mock.calls[0]?.[0] as any;
    expect(updateArg.where).toEqual({ messageId: "sync-message-1" });
    expect(updateArg.data.metadata).toMatchObject({
      syncTimeIso: "2026-06-10T12:00:00.000Z",
      syncEpochSeconds: 1749556800,
      roleId: "123456789012345678",
      fwaClanListEnabled: true,
      fwaClanListRefreshExpiresAtIso: "2026-06-11T12:00:00.000Z",
      fwaClanListLastRefreshedAtIso: expect.any(String),
    });
    expect(Array.isArray(updateArg.data.metadata.clans)).toBe(true);
    expect(updateArg.data.metadata.clans).toHaveLength(1);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("rejects refreshes after the 24 hour window expires", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValueOnce({
      id: "tracked-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-1",
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: null,
      clanTag: null,
      remindAt: null,
      expiresAt: new Date("2026-06-10T13:00:00.000Z"),
      metadata: {
        ...makeBaseMetadata(),
        fwaClanListEnabled: true,
        fwaClanListRefreshExpiresAtIso: "2026-06-09T12:00:00.000Z",
        fwaClanListLastRefreshedAtIso: "2026-06-10T12:00:00.000Z",
      },
      claims: [],
    });

    const interaction = makeButtonInteraction();

    await handleSyncTimeFwaClanListRefreshButton(interaction as any);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: "The FWA clan-list refresh window has expired.",
      }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.message.edit).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessage.update).not.toHaveBeenCalled();
  });
});
