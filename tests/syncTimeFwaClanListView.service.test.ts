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
  updateTrackedMessageMetadataIfLockMatches,
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

const VALID_CLASH_TAG_CHARS = "PYLQGRJCUV0289";

function makeValidClashPlayerTag(index: number): string {
  const base = VALID_CLASH_TAG_CHARS.length;
  let value = index;
  let suffix = "";
  do {
    suffix = `${VALID_CLASH_TAG_CHARS[value % base] ?? "P"}${suffix}`;
    value = Math.floor(value / base);
  } while (value > 0);
  return `#${suffix.padStart(8, "P")}`;
}

function makeCompleteReadinessRows(weight: number): Array<Record<string, unknown>> {
  return Array.from({ length: 50 }, (_, index) => ({
    clanTag: "#2QG2C08UP",
    playerTag: makeValidClashPlayerTag(index + 1),
    playerName: `Player ${index + 1}`,
    townHall: 15,
    weight,
    sourceSyncedAt: new Date("2026-06-10T11:55:00.000Z"),
  }));
}

function makeReadinessHeatMapRef(th15Count: number, th14Count: number) {
  return [
    {
      weightMinInclusive: 7_400_000,
      weightMaxInclusive: 7_600_000,
      th18Count: 0,
      th17Count: 0,
      th16Count: 0,
      th15Count,
      th14Count,
      th13Count: 0,
      th12Count: 0,
      th11Count: 0,
      th10OrLowerCount: 0,
      sourceVersion: "test",
      refreshedAt: new Date("2026-06-10T00:00:00.000Z"),
    },
  ];
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

  it("renders a healthy complete roster with a numeric deviation and a ready indicator", async () => {
    mockReadinessState(
      makeCompleteReadinessRows(150000),
      makeReadinessHeatMapRef(48, 2),
    );

    const payload = await buildSyncTimeFwaClanListMessagePayload({
      guildId: "guild-1",
      baseMetadata: makeBaseMetadata(),
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    const description = String(payload.embeds[0].toJSON().description ?? "");
    expect(description).toContain("✅ | AC |");
    expect(description).toContain("Dev 6");
    expect(description).not.toContain("Dev n/a");
  });

  it("renders an unhealthy complete roster with a numeric deviation and a warning indicator", async () => {
    mockReadinessState(
      makeCompleteReadinessRows(150000),
      makeReadinessHeatMapRef(44, 6),
    );

    const payload = await buildSyncTimeFwaClanListMessagePayload({
      guildId: "guild-1",
      baseMetadata: makeBaseMetadata(),
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    const description = String(payload.embeds[0].toJSON().description ?? "");
    expect(description).toContain("⚠️ | AC |");
    expect(description).toContain("Dev 18");
    expect(description).not.toContain("Dev n/a");
  });

  it("renders Dev n/a when no HeatMapRef is available", async () => {
    mockReadinessState(makeCompleteReadinessRows(150000), []);

    const payload = await buildSyncTimeFwaClanListMessagePayload({
      guildId: "guild-1",
      baseMetadata: makeBaseMetadata(),
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    const description = String(payload.embeds[0].toJSON().description ?? "");
    expect(description).toContain("Dev n/a");
    expect(description).toContain("⚠️ | AC |");
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
    ).resolves.toMatchObject({ claimed: true, lockToken: expect.any(String) });
    await expect(
      tryClaimRefreshLock({
        trackedMessageId: "sync-message-1",
        updatedAt: new Date("2026-06-10T12:00:00.000Z"),
        now: new Date("2026-06-10T12:01:00.000Z"),
        userId: "user-2",
        metadata: metadata as any,
      }),
    ).resolves.toMatchObject({ claimed: false, lockToken: expect.any(String) });
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
    ).resolves.toMatchObject({ claimed: false, lockToken: expect.any(String) });
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
    ).resolves.toMatchObject({ claimed: true, lockToken: expect.any(String) });
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledTimes(1);
  });

  it("prevents a stale worker from clearing a newer worker's refresh metadata", async () => {
    prismaMock.trackedMessage.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.trackedMessage.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.trackedMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    const baseMetadata = {
      readinessEnabled: true,
      createdAtIso: "2026-06-10T12:00:00.000Z",
      lastRefreshedAtIso: "2026-06-10T12:00:00.000Z",
      lastSuccessfulRefreshAtIso: "2026-06-10T12:00:00.000Z",
    };
    const staleMetadata = {
      ...baseMetadata,
      refreshInProgressAtIso: "2026-06-10T11:54:30.000Z",
      refreshInProgressByUserId: "worker-a",
    };
    const claimA = await tryClaimRefreshLock({
      trackedMessageId: "sync-message-1",
      updatedAt: new Date("2026-06-10T12:00:00.000Z"),
      now: new Date("2026-06-10T12:01:00.000Z"),
      userId: "worker-a",
      metadata: baseMetadata as any,
    });
    const claimB = await tryClaimRefreshLock({
      trackedMessageId: "sync-message-1",
      updatedAt: new Date("2026-06-10T12:00:00.000Z"),
      now: new Date("2026-06-10T12:06:02.000Z"),
      userId: "worker-b",
      metadata: staleMetadata as any,
    });
    expect(claimA.claimed).toBe(true);
    expect(claimB.claimed).toBe(true);
    expect(claimA.lockToken).not.toBe(claimB.lockToken);

    const releaseRows = await updateTrackedMessageMetadataIfLockMatches({
      trackedMessageId: "sync-message-1",
      lockToken: claimA.lockToken,
      metadata: {
        ...baseMetadata,
        lastRefreshedAtIso: "2026-06-10T12:06:10.000Z",
        lastSuccessfulRefreshAtIso: "2026-06-10T12:06:10.000Z",
      } as any,
    });

    expect(releaseRows).toBe(0);
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledTimes(3);
    const releaseCall = prismaMock.trackedMessage.updateMany.mock.calls[2]?.[0] as any;
    expect(releaseCall.where).toMatchObject({
      messageId: "sync-message-1",
      metadata: {
        path: ["refreshLockToken"],
        equals: claimA.lockToken,
      },
    });
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
        updatedAt: new Date("2026-06-10T12:00:00.000Z"),
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
      interaction.message.edit
        .mockImplementationOnce(async () => undefined)
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date("2026-06-10T11:30:05.000Z"));
          return undefined;
        });

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
      expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledTimes(2);
      const claimArg = prismaMock.trackedMessage.updateMany.mock.calls[0]?.[0] as any;
      expect(claimArg.where).toEqual({
        messageId: "sync-message-1",
        updatedAt: new Date("2026-06-10T12:00:00.000Z"),
      });
      expect(claimArg.data.metadata).toMatchObject({
        syncTimeIso: "2026-06-10T12:00:00.000Z",
        syncEpochSeconds: 1749556800,
        roleId: "123456789012345678",
        fwaClanListEnabled: true,
        fwaClanListRefreshExpiresAtIso: "2026-06-10T12:00:00.000Z",
        fwaClanListLastRefreshedAtIso: "2026-06-10T11:30:00.000Z",
        fwaClanListRefreshLockToken: expect.any(String),
        fwaClanListRefreshInProgressAtIso: "2026-06-10T11:30:00.000Z",
        fwaClanListRefreshInProgressByUserId: "user-1",
      });
      const releaseArg = prismaMock.trackedMessage.updateMany.mock.calls[1]?.[0] as any;
      expect(releaseArg.where).toMatchObject({
        messageId: "sync-message-1",
        metadata: {
          path: ["fwaClanListRefreshLockToken"],
          equals: claimArg.data.metadata.fwaClanListRefreshLockToken,
        },
      });
      expect(releaseArg.data.metadata).toMatchObject({
        syncTimeIso: "2026-06-10T12:00:00.000Z",
        syncEpochSeconds: 1749556800,
        roleId: "123456789012345678",
        fwaClanListEnabled: true,
        fwaClanListRefreshExpiresAtIso: "2026-06-10T12:00:00.000Z",
        fwaClanListLastRefreshedAtIso: "2026-06-10T11:30:05.000Z",
        fwaClanListLastSuccessfulRefreshAtIso: "2026-06-10T11:30:05.000Z",
      });
      expect(Array.isArray(claimArg.data.metadata.clans)).toBe(true);
      expect(claimArg.data.metadata.clans).toHaveLength(1);
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

  it("keeps manual standalone readiness refreshable when no expiry is recorded", async () => {
    mockReadinessState();

    const payload = await buildSyncReadinessMessagePayload({
      guildId: "guild-1",
      baseMetadata: {
        readinessEnabled: true,
        createdAtIso: "2026-06-10T12:00:00.000Z",
      },
      now: new Date("2026-06-10T12:01:00.000Z"),
    });

    const button = payload.components[0]?.toJSON().components[0] as any;
    expect(button.label).toBe("Refresh");
    expect(button.disabled).toBe(false);
  });

  it("lets standalone readiness refresh clicks proceed when no expiry is recorded", async () => {
    mockReadinessState();
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
      id: "tracked-standalone-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-1",
      updatedAt: new Date("2026-06-10T12:00:00.000Z"),
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
      status: TRACKED_MESSAGE_STATUS.COMPLETED,
      referenceId: null,
      clanTag: null,
      remindAt: null,
      expiresAt: null,
      metadata: {
        readinessEnabled: true,
        createdAtIso: "2026-06-10T12:00:00.000Z",
      },
      claims: [],
    });

    const interaction = makeButtonInteraction();

    await handleSyncTimeFwaClanListRefreshButton(interaction as any);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: "The FWA clan-list refresh window has expired.",
      }),
    );
    expect(interaction.message.edit).toHaveBeenCalledTimes(2);
    const payload = interaction.message.edit.mock.calls[1]?.[0] as any;
    expect(payload.components[0].toJSON().components[0].label).toBe("Refresh");
    expect(payload.components[0].toJSON().components[0].disabled).toBe(false);
    expect(syncAllSpy).toHaveBeenCalledWith({ force: true });
    expect(refreshCurrentSpy).toHaveBeenCalledWith(["#2QG2C08UP"]);
    syncAllSpy.mockRestore();
    refreshCurrentSpy.mockRestore();
  });

  it("closes the standalone readiness refresh button once its expiry passes", async () => {
    mockReadinessState();

    const payload = await buildSyncReadinessMessagePayload({
      guildId: "guild-1",
      baseMetadata: {
        readinessEnabled: true,
        createdAtIso: "2026-06-10T12:00:00.000Z",
        refreshExpiresAtIso: "2026-06-10T12:00:00.000Z",
      },
      now: new Date("2026-06-10T12:01:00.000Z"),
    });

    const button = payload.components[0]?.toJSON().components[0] as any;
    expect(button.label).toBe("Refresh closed");
    expect(button.disabled).toBe(true);
  });
});
