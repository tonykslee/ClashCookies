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
    updateMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  heatMapRef: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  weightInputDeferment: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildSyncTimeFwaClanListMessagePayload,
  buildSyncReadinessMessagePayload,
  handleSyncTimeFwaClanListRefreshButton,
  SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID,
  tryClaimRefreshLock,
} from "../src/services/SyncTimeFwaClanListViewService";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";

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

function mockReadinessState(
  rows?: Array<Record<string, unknown>>,
  heatMapRefs?: Array<Record<string, unknown>>,
) {
  prismaMock.trackedClan.findMany.mockResolvedValueOnce([
    {
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      shortName: "AC",
    },
  ]);
  prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValueOnce(
    rows ?? [
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Player One",
        townHall: 16,
        weight: 150000,
        sourceSyncedAt: new Date("2026-06-10T11:55:00.000Z"),
      },
    ],
  );
  prismaMock.heatMapRef.findMany.mockResolvedValueOnce(heatMapRefs ?? []);
  prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([]);
  prismaMock.playerCurrent.findMany.mockResolvedValueOnce([]);
  prismaMock.weightInputDeferment.findMany.mockResolvedValueOnce([]);
  prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValueOnce([]);
}

describe("SyncTimeFwaClanListViewService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedMessage.findUnique.mockReset();
    prismaMock.trackedMessage.update.mockReset();
    prismaMock.trackedMessage.updateMany.mockReset();
    prismaMock.trackedMessage.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.heatMapRef.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
  });

  it("builds the sync-time payload with the shared FWA readiness embed and refresh button", async () => {
    mockReadinessState();

    const payload = await buildSyncTimeFwaClanListMessagePayload({
      guildId: "guild-1",
      baseMetadata: makeBaseMetadata(),
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(payload.content).toContain("# Sync time :gem:");
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].toJSON().title).toBe("FWA Readiness (1)");
    expect(String(payload.embeds[0].toJSON().description ?? "")).not.toContain("**FWA Readiness**");
    expect(String(payload.embeds[0].toJSON().description ?? "")).toContain("[Alpha Clan]");
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0].toJSON().components[0].custom_id).toBe(
      SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID,
    );
    expect(payload.metadata).toMatchObject({
      fwaClanListEnabled: true,
      fwaClanListRefreshExpiresAtIso: "2026-06-10T12:00:00.000Z",
      fwaClanListLastRefreshedAtIso: "2026-06-10T12:00:00.000Z",
    });
  });

  it("marks a 50/50 clan with unresolved weights as not ready", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      clanTag: "#2QG2C08UP",
      playerTag: "#PYLQ0289",
      playerName: `Player ${index + 1}`,
      townHall: 16,
      weight: index === 0 ? null : 150000,
      sourceSyncedAt: new Date("2026-06-10T11:55:00.000Z"),
    }));
    mockReadinessState(rows, [
      {
        weightMinInclusive: 0,
        weightMaxInclusive: 10_000_000,
        th18Count: 49,
        th17Count: 0,
        th16Count: 0,
        th15Count: 0,
        th14Count: 0,
        th13Count: 0,
        th12Count: 0,
        th11Count: 0,
        th10OrLowerCount: 0,
        sourceVersion: "test",
        refreshedAt: new Date("2026-06-10T00:00:00.000Z"),
      },
    ]);

    const payload = await buildSyncTimeFwaClanListMessagePayload({
      guildId: "guild-1",
      baseMetadata: makeBaseMetadata(),
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(String(payload.embeds[0].toJSON().description ?? "")).toContain("⚠️ | AC |");
    expect(String(payload.embeds[0].toJSON().description ?? "")).not.toContain("✅ | AC |");
  });

  it("rejects a fresh competing refresh lock claim when another process already holds the row", async () => {
    prismaMock.trackedMessage.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.trackedMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    const metadata = {
      readinessEnabled: true,
      createdAtIso: "2026-06-10T12:00:00.000Z",
      lastRefreshedAtIso: "2026-06-10T12:00:00.000Z",
      lastSuccessfulRefreshAtIso: "2026-06-10T12:00:00.000Z",
    };

    await expect(
      tryClaimRefreshLock({
        trackedMessageId: "sync-message-1",
        updatedAt: new Date("2026-06-10T12:00:00.000Z"),
        now: new Date("2026-06-10T12:01:00.000Z"),
        userId: "user-1",
        metadata: metadata as any,
      }),
    ).resolves.toBe(true);
    await expect(
      tryClaimRefreshLock({
        trackedMessageId: "sync-message-1",
        updatedAt: new Date("2026-06-10T12:00:00.000Z"),
        now: new Date("2026-06-10T12:01:00.000Z"),
        userId: "user-2",
        metadata: metadata as any,
      }),
    ).resolves.toBe(false);
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledTimes(2);
  });

  it("rejects an active refresh lock before the stale timeout without writing", async () => {
    const metadata = {
      readinessEnabled: true,
      createdAtIso: "2026-06-10T12:00:00.000Z",
      refreshInProgressAtIso: "2026-06-10T12:03:00.000Z",
      refreshInProgressByUserId: "user-1",
    };

    await expect(
      tryClaimRefreshLock({
        trackedMessageId: "sync-message-1",
        updatedAt: new Date("2026-06-10T12:04:00.000Z"),
        now: new Date("2026-06-10T12:05:00.000Z"),
        userId: "user-2",
        metadata: metadata as any,
      }),
    ).resolves.toBe(false);
    expect(prismaMock.trackedMessage.updateMany).not.toHaveBeenCalled();
  });

  it("allows a stale refresh lock to be reclaimed after the timeout", async () => {
    prismaMock.trackedMessage.updateMany.mockResolvedValueOnce({ count: 1 });
    const metadata = {
      readinessEnabled: true,
      createdAtIso: "2026-06-10T12:00:00.000Z",
      refreshInProgressAtIso: "2026-06-10T12:00:00.000Z",
      refreshInProgressByUserId: "user-1",
    };

    await expect(
      tryClaimRefreshLock({
        trackedMessageId: "sync-message-1",
        updatedAt: new Date("2026-06-10T12:00:00.000Z"),
        now: new Date("2026-06-10T12:06:01.000Z"),
        userId: "user-2",
        metadata: metadata as any,
      }),
    ).resolves.toBe(true);
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledTimes(1);
  });

  it("refreshes the same sync-time message after reloading clan list state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T11:30:00.000Z"));
    try {
      const fetchSpy = vi.spyOn(trackedMessageService, "fetchSyncTrackedMessageWithClaims");
      const syncAllSpy = vi
        .spyOn(FwaClanMembersSyncService.prototype, "syncAllTrackedClans")
        .mockResolvedValue({
          clanCount: 1,
          rowCount: 1,
          changedRowCount: 1,
          failedClans: [],
        });
      const refreshCurrentSpy = vi
        .spyOn(FwaClanMembersSyncService.prototype, "refreshCurrentClanMembersForClanTags")
        .mockResolvedValue({
          clanCount: 1,
          rowCount: 1,
          changedRowCount: 1,
          failedClans: [],
        });
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
          fwaClanListRefreshExpiresAtIso: "2026-06-10T12:00:00.000Z",
          fwaClanListLastRefreshedAtIso: "2026-06-10T12:00:00.000Z",
        },
        claims: [],
      });
      mockReadinessState();
      mockReadinessState();

      const interaction = makeButtonInteraction();

      await handleSyncTimeFwaClanListRefreshButton(interaction as any);

      expect(syncAllSpy).toHaveBeenCalledWith({ force: true });
      expect(refreshCurrentSpy).toHaveBeenCalledWith(["#2QG2C08UP"]);
      expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith("sync-message-1");
      expect(interaction.message.edit).toHaveBeenCalledTimes(2);
      const pendingEdit = interaction.message.edit.mock.calls[0]?.[0] as any;
      expect(pendingEdit.components[0].toJSON().components[0].label).toBe("Refreshing...");
      const payload = interaction.message.edit.mock.calls[1]?.[0] as any;
      expect(payload.content).toContain("# Sync time :gem:");
      expect(payload.embeds[0].toJSON().title).toBe("FWA Readiness (1)");
      expect(String(payload.embeds[0].toJSON().description ?? "")).not.toContain("**FWA Readiness**");
      expect(String(payload.embeds[0].toJSON().description ?? "")).toContain("Alpha Clan");
      expect(payload.components[0].toJSON().components[0].custom_id).toBe(
        SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID,
      );
      expect(payload.components[0].toJSON().components[0].label).toBe("Refresh");
      expect(prismaMock.trackedMessage.update).toHaveBeenCalledTimes(1);
      const updateArg = prismaMock.trackedMessage.update.mock.calls[0]?.[0] as any;
      expect(updateArg.where).toEqual({ messageId: "sync-message-1" });
      expect(updateArg.data.metadata).toMatchObject({
        syncTimeIso: "2026-06-10T12:00:00.000Z",
        syncEpochSeconds: 1749556800,
        roleId: "123456789012345678",
        fwaClanListEnabled: true,
        fwaClanListRefreshExpiresAtIso: "2026-06-10T12:00:00.000Z",
        fwaClanListLastRefreshedAtIso: expect.any(String),
      });
      expect(Array.isArray(updateArg.data.metadata.clans)).toBe(true);
      expect(updateArg.data.metadata.clans).toHaveLength(1);
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.followUp).not.toHaveBeenCalled();
      syncAllSpy.mockRestore();
      refreshCurrentSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects refreshes at or after the sync time", async () => {
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
    expect(interaction.message.edit).toHaveBeenCalledTimes(1);
    const closedPayload = interaction.message.edit.mock.calls[0]?.[0] as any;
    expect(closedPayload.components[0].toJSON().components[0].label).toBe("Refresh closed");
    expect(closedPayload.components[0].toJSON().components[0].disabled).toBe(true);
    expect(prismaMock.trackedMessage.update).not.toHaveBeenCalled();
  });

  it("renders identical readiness rows for sync-time and standalone readiness posts with the same source data", async () => {
    mockReadinessState();

    const syncTimePayload = await buildSyncTimeFwaClanListMessagePayload({
      guildId: "guild-1",
      baseMetadata: makeBaseMetadata(),
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    mockReadinessState();

    const readinessPayload = await buildSyncReadinessMessagePayload({
      guildId: "guild-1",
      baseMetadata: {
        readinessEnabled: true,
        createdAtIso: "2026-06-10T12:00:00.000Z",
      },
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(syncTimePayload.embeds[0].toJSON().description).toBe(
      readinessPayload.embeds[0].toJSON().description,
    );
    expect(syncTimePayload.embeds[0].toJSON().title).toBe(
      readinessPayload.embeds[0].toJSON().title,
    );
  });
});
