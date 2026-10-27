import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
} from "../src/services/TrackedMessageService";
import { BotLogChannelService } from "../src/services/BotLogChannelService";

const leadershipLookupMock = vi.hoisted(() => vi.fn());

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  trackedMessageClaim: {
    findFirst: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/ClanLeadershipLookupService", () => ({
  lookupClanLeadershipForPairs: leadershipLookupMock,
}));

function makeMetadata() {
  return {
    syncTimeIso: "2026-03-19T15:30:00.000Z",
    syncEpochSeconds: 1742407800,
    roleId: "456",
    reminderSentAt: null,
    clans: [
      {
      code: "RR",
        clanTag: "#PYLQ",
        clanName: "Rocky Road",
        emojiId: "111",
        emojiName: "rr",
        emojiInline: "<:rr:111>",
      },
      {
        code: "TWC",
        clanTag: "#PYLG",
        clanName: "TheWiseCowboys",
        emojiId: "222",
        emojiName: "twc",
        emojiInline: "<:twc:222>",
      },
    ],
  };
}

function makeTrackedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tracked-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "sync-message-1",
    featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    referenceId: null,
    remindAt: new Date("2026-03-19T15:25:00.000Z"),
    expiresAt: new Date("2026-03-19T17:30:00.000Z"),
    metadata: makeMetadata(),
    claims: [],
    ...overrides,
  };
}

function makeClient(params?: {
  guildChannel?: { send: ReturnType<typeof vi.fn> };
  userById?: Record<string, { send: ReturnType<typeof vi.fn> }>;
}) {
  const guildChannel = params?.guildChannel ?? { send: vi.fn().mockResolvedValue({ id: "status-message-1", react: vi.fn() }) };
  const userById = params?.userById ?? {};
  return {
    guilds: {
      fetch: vi.fn().mockResolvedValue({
        channels: {
          fetch: vi.fn().mockResolvedValue({
            isTextBased: () => true,
            send: guildChannel.send,
          }),
        },
      }),
    },
    users: {
      fetch: vi.fn(async (userId: string) => userById[userId] ?? null),
    },
  } as any;
}

function bindTrackedRowPersistence(trackedRow: ReturnType<typeof makeTrackedRow>): void {
  prismaMock.trackedMessage.update.mockImplementation(async ({ where, data }: any) => {
    if (where?.id === trackedRow.id && data?.metadata) {
      trackedRow.metadata = {
        ...(trackedRow.metadata as Record<string, unknown>),
        ...(data.metadata as Record<string, unknown>),
      };
    }
    if (where?.id === trackedRow.id && data?.status) {
      trackedRow.status = data.status;
    }
    return trackedRow;
  });
}

function makeLeadershipEntry(input: {
  clanTag: string;
  discordUserId: string;
  rosterAvailable?: boolean;
  accounts?: Array<{ playerTag: string; playerName: string; role: "leader" | "coLeader" }>;
}) {
  return {
    clanTag: input.clanTag,
    discordUserId: input.discordUserId,
    rosterAvailable: input.rosterAvailable ?? true,
    observedAt: new Date("2026-03-19T15:20:00.000Z"),
    accounts: (input.accounts ?? []).map((account) => ({
      ...account,
      clanTag: input.clanTag,
      discordUserId: input.discordUserId,
    })),
  };
}

function getDmContent(send: ReturnType<typeof vi.fn>): string {
  return send.mock.calls[0]?.[0]?.content ?? "";
}

describe("TrackedMessageService sync spin status", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue(null);
    prismaMock.trackedMessage.findUnique.mockResolvedValue(null);
    prismaMock.trackedMessage.upsert.mockResolvedValue(undefined);
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);
    prismaMock.trackedMessage.updateMany.mockResolvedValue({ count: 0 });
    leadershipLookupMock.mockResolvedValue({ entries: [] });
    vi.spyOn(BotLogChannelService.prototype, "getChannelIdForType").mockResolvedValue(null);
  });

  it("enriches one aggregated reminder DM with linked leader and co-leader names", async () => {
    const userId = "111111111111111111";
    const otherUserId = "222222222222222222";
    const trackedRow = makeTrackedRow({
      claims: [
        { clanTag: "#PYLQ", userId },
        { clanTag: "#PYLQ", userId },
        { clanTag: "#PYLG", userId },
        { clanTag: "#PYLG", userId: otherUserId },
      ],
    });
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue({ id: "status-message-1" });
    const userSend = vi.fn().mockResolvedValue(undefined);
    const otherUserSend = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      userById: {
        [userId]: { send: userSend },
        [otherUserId]: { send: otherUserSend },
      },
    });
    leadershipLookupMock.mockResolvedValue({
      entries: [
        makeLeadershipEntry({
          clanTag: "#PYLQ",
          discordUserId: userId,
          accounts: [
            { playerTag: "#P1", playerName: "Lead*One", role: "leader" },
            { playerTag: "#P2", playerName: "Co <@everyone>", role: "coLeader" },
          ],
        }),
        makeLeadershipEntry({
          clanTag: "#PYLG",
          discordUserId: userId,
          accounts: [{ playerTag: "#P3", playerName: "Second Clan Co", role: "coLeader" }],
        }),
        makeLeadershipEntry({
          clanTag: "#PYLG",
          discordUserId: otherUserId,
          accounts: [{ playerTag: "#P4", playerName: "Other User", role: "leader" }],
        }),
      ],
    });

    await trackedMessageService.processDueSyncReminders(client);

    const content = getDmContent(userSend);
    expect(content).toContain("<@111111111111111111> sync reminder for <t:1742407800:F> (<t:1742407800:R>).");
    expect(content).toContain("- Rocky Road (👑 Lead\\*One, Co \\<\\@everyone\\>)");
    expect(content).toContain("- TheWiseCowboys (Second Clan Co)");
    expect(content).not.toContain("#P1");
    expect(content).not.toContain("Other User");
    expect(content).not.toContain("co-leader");
    expect(content).not.toContain("<@everyone>");
    expect(content).toContain("\\@everyone");
    expect(otherUserSend).toHaveBeenCalledTimes(1);
    expect(leadershipLookupMock).toHaveBeenCalledTimes(1);
    expect(leadershipLookupMock.mock.calls[0][0]).toHaveLength(3);
  });

  it("distinguishes an empty matching roster from an unavailable roster", async () => {
    const userId = "333333333333333333";
    const trackedRow = makeTrackedRow({
      claims: [
        { clanTag: "#PYLQ", userId },
        { clanTag: "#PYLG", userId },
      ],
    });
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue({ id: "status-message-1" });
    const userSend = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ userById: { [userId]: { send: userSend } } });
    leadershipLookupMock.mockResolvedValue({
      entries: [
        makeLeadershipEntry({ clanTag: "#PYLQ", discordUserId: userId }),
        makeLeadershipEntry({ clanTag: "#PYLG", discordUserId: userId, rosterAvailable: false }),
      ],
    });

    await trackedMessageService.processDueSyncReminders(client);

    const content = getDmContent(userSend);
    expect(content).toContain("- Rocky Road (no linked leader/co-leader found)");
    expect(content).toContain("- TheWiseCowboys (roster unavailable)");
  });

  it("falls back to claim counts when leadership enrichment fails", async () => {
    const userId = "444444444444444444";
    const trackedRow = makeTrackedRow({ claims: [{ clanTag: "#PYLQ", userId }] });
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue({ id: "status-message-1" });
    const userSend = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ userById: { [userId]: { send: userSend } } });
    leadershipLookupMock.mockRejectedValueOnce(new Error("lookup unavailable"));

    await trackedMessageService.processDueSyncReminders(client);

    expect(getDmContent(userSend)).toContain("- Rocky Road (1)");
    expect(getDmContent(userSend)).not.toContain("roster unavailable");
    expect(userSend).toHaveBeenCalledTimes(1);
  });

  it("bounds excessive linked account names without sending duplicate reminders", async () => {
    const userId = "555555555555555555";
    const trackedRow = makeTrackedRow({ claims: [{ clanTag: "#PYLQ", userId }] });
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue({ id: "status-message-1" });
    const userSend = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ userById: { [userId]: { send: userSend } } });
    leadershipLookupMock.mockResolvedValue({
      entries: [makeLeadershipEntry({
        clanTag: "#PYLQ",
        discordUserId: userId,
        accounts: Array.from({ length: 120 }, (_, index) => ({
          playerTag: `#P${index}`,
          playerName: `Very Long Linked Account Name ${index} with extra text`,
          role: "coLeader" as const,
        })),
      })],
    });

    await trackedMessageService.processDueSyncReminders(client);

    const content = getDmContent(userSend);
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain("Rocky Road");
    expect(content).toContain("more");
    expect(userSend).toHaveBeenCalledTimes(1);
  });

  it("does not add a leading comma when later clans receive zero account-name budget", async () => {
    const userId = "666666666666666666";
    const baseMetadata = makeMetadata();
    const trackedRow = makeTrackedRow({
      metadata: {
        ...baseMetadata,
        clans: [
          ...baseMetadata.clans,
          {
            code: "ZG",
            clanTag: "#PYLU",
            clanName: "Zero Gravity",
            emojiId: "333",
            emojiName: "zg",
            emojiInline: "<:zg:333>",
          },
        ],
      },
      claims: [
        { clanTag: "#PYLQ", userId },
        { clanTag: "#PYLG", userId },
        { clanTag: "#PYLU", userId },
      ],
    });
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue({ id: "status-message-1" });
    const userSend = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ userById: { [userId]: { send: userSend } } });
    leadershipLookupMock.mockResolvedValue({
      entries: [
        makeLeadershipEntry({
          clanTag: "#PYLQ",
          discordUserId: userId,
          accounts: Array.from({ length: 80 }, (_, index) => ({
            playerTag: `#Q${index}`,
            playerName: `Rocky Account ${index} with a deliberately long name`,
            role: "coLeader" as const,
          })),
        }),
        makeLeadershipEntry({
          clanTag: "#PYLG",
          discordUserId: userId,
          accounts: [
            { playerTag: "#T1", playerName: "Tilonius", role: "coLeader" },
            { playerTag: "#T2", playerName: "Zoey", role: "coLeader" },
            { playerTag: "#T3", playerName: "Joka", role: "coLeader" },
          ],
        }),
        makeLeadershipEntry({
          clanTag: "#PYLU",
          discordUserId: userId,
          accounts: [
            { playerTag: "#Z1", playerName: "Zero One", role: "coLeader" },
            { playerTag: "#Z2", playerName: "Zero Two", role: "coLeader" },
            { playerTag: "#Z3", playerName: "Zero Three", role: "coLeader" },
          ],
        }),
      ],
    });

    await trackedMessageService.processDueSyncReminders(client);

    const content = getDmContent(userSend);
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain("- TheWiseCowboys (… +3 more)");
    expect(content).toContain("- Zero Gravity (… +3 more)");
    expect(content).not.toContain("- TheWiseCowboys (, …");
    expect(content).not.toContain("- Zero Gravity (, …");
    expect(userSend).toHaveBeenCalledTimes(1);
  });

  it("posts the scheduled status embed once and reacts with every clan badge", async () => {
    const trackedRow = makeTrackedRow({
      claims: [
        { clanTag: "#PYLQ", userId: "user-1" },
        { clanTag: "#PYLG", userId: "user-2" },
      ],
    });
    bindTrackedRowPersistence(trackedRow);
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);

    const react = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ id: "status-message-1", react });
    const user1Send = vi.fn().mockResolvedValue(undefined);
    const user2Send = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      guildChannel: { send },
      userById: {
        "user-1": { send: user1Send },
        "user-2": { send: user2Send },
      },
    });

    const result = await trackedMessageService.processDueSyncReminders(client);

    expect(result).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON() as any;
    expect(embed.title).toBe("Sync Spin Status");
    expect(embed.description).toContain("Claimed: **0/2**");
    expect(embed.description).toContain("- <:rr:111> **RR** (Rocky Road)");
    expect(embed.description).toContain("- <:twc:222> **TWC** (TheWiseCowboys)");
    expect(payload.components[0].components[0].data.label).toBe("My Leader Accounts");
    expect(payload.components[0].components[0].data.custom_id).toBe(
      "sync-leaders:v1:sync-message-1:0",
    );
    expect(user1Send).toHaveBeenCalledTimes(1);
    expect(user2Send).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("<:rr:111>");
    expect(react).toHaveBeenCalledWith("<:twc:222>");
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "status-message-1" },
        create: expect.objectContaining({
          referenceId: "sync-message-1",
          remindAt: null,
        }),
      }),
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tracked-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            reminderSentAt: expect.any(String),
          }),
        }),
      }),
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tracked-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            statusPostedAt: expect.any(String),
          }),
        }),
      }),
    );
  });

  it("posts the scheduled status embed to the typed sync channel when configured", async () => {
    const trackedRow = makeTrackedRow({
      claims: [{ clanTag: "#PYLQ", userId: "user-1" }],
    });
    bindTrackedRowPersistence(trackedRow);
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "typed-sync-channel",
    );

    const sourceSend = vi.fn().mockResolvedValue({ id: "source-status", react: vi.fn() });
    const typedReact = vi.fn().mockResolvedValue(undefined);
    const typedSend = vi.fn().mockResolvedValue({
      id: "typed-status-message",
      react: typedReact,
    });
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue({
          channels: {
            fetch: vi.fn(async (channelId: string) => ({
              isTextBased: () => true,
              send: channelId === "typed-sync-channel" ? typedSend : sourceSend,
            })),
          },
        }),
      },
      users: {
        fetch: vi.fn(async () => null),
      },
    } as any;

    const result = await trackedMessageService.processDueSyncReminders(client);

    expect(result).toBe(1);
    expect(typedSend).toHaveBeenCalledTimes(1);
    expect(sourceSend).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "typed-status-message" },
        create: expect.objectContaining({
          channelId: "typed-sync-channel",
          referenceId: "sync-message-1",
        }),
      }),
    );
  });

  it("falls back to the source sync post channel when the typed sync channel is unavailable", async () => {
    const trackedRow = makeTrackedRow({
      claims: [{ clanTag: "#PYLQ", userId: "user-1" }],
    });
    bindTrackedRowPersistence(trackedRow);
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "typed-sync-channel",
    );

    const sourceSend = vi.fn().mockResolvedValue({
      id: "fallback-status-message",
      react: vi.fn().mockResolvedValue(undefined),
    });
    const fetch = vi.fn(async (channelId: string) => {
      if (channelId === "typed-sync-channel") return null;
      if (channelId === "channel-1") {
        return {
          isTextBased: () => true,
          send: sourceSend,
        };
      }
      return null;
    });
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue({
          channels: { fetch },
        }),
      },
      users: {
        fetch: vi.fn(async () => null),
      },
    } as any;

    const result = await trackedMessageService.processDueSyncReminders(client);

    expect(result).toBe(1);
    expect(fetch).toHaveBeenCalledWith("typed-sync-channel");
    expect(fetch).toHaveBeenCalledWith("channel-1");
    expect(sourceSend).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "fallback-status-message" },
        create: expect.objectContaining({
          channelId: "channel-1",
          referenceId: "sync-message-1",
        }),
      }),
    );
  });

  it("keeps sending DMs when the public status post already exists", async () => {
    const trackedRow = makeTrackedRow({
      claims: [{ clanTag: "#PYLQ", userId: "user-1" }],
    });
    bindTrackedRowPersistence(trackedRow);
    prismaMock.trackedMessage.findMany.mockImplementation(() => [trackedRow]);
    prismaMock.trackedMessage.findFirst.mockImplementation(async () => ({ id: "status-message-1" }));

    const send = vi.fn().mockResolvedValue({ id: "status-message-1", react: vi.fn() });
    const userSend = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      guildChannel: { send },
      userById: {
        "user-1": { send: userSend },
      },
    });

    await trackedMessageService.processDueSyncReminders(client);
    await trackedMessageService.processDueSyncReminders(client);

    expect(send).not.toHaveBeenCalled();
    expect(userSend).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(0);
    expect(trackedRow.metadata.reminderSentAt).toEqual(expect.any(String));
    expect(trackedRow.metadata.statusPostedAt).toEqual(expect.any(String));
  });

  it("sends DMs and the public status post together on the first due sweep", async () => {
    const trackedRow = makeTrackedRow({
      claims: [
        { clanTag: "#PYLQ", userId: "user-1" },
        { clanTag: "#PYLG", userId: "user-1" },
        { clanTag: "#PYLG", userId: "user-2" },
      ],
    });
    bindTrackedRowPersistence(trackedRow);
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue(null);

    const react = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ id: "status-message-1", react });
    const user1Send = vi.fn().mockResolvedValue(undefined);
    const user2Send = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      guildChannel: { send },
      userById: {
        "user-1": { send: user1Send },
        "user-2": { send: user2Send },
      },
    });

    const result = await trackedMessageService.processDueSyncReminders(client);

    expect(result).toBe(1);
    expect(user1Send).toHaveBeenCalledTimes(1);
    expect(user2Send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(1);
    expect(trackedRow.metadata.reminderSentAt).toEqual(expect.any(String));
    expect(trackedRow.metadata.statusPostedAt).toEqual(expect.any(String));
  });

  it("sends DMs even when the public status post already exists", async () => {
    const trackedRow = makeTrackedRow({
      claims: [{ clanTag: "#PYLQ", userId: "user-1" }],
    });
    bindTrackedRowPersistence(trackedRow);
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue({ id: "status-message-1" });

    const send = vi.fn().mockResolvedValue({ id: "status-message-1", react: vi.fn() });
    const userSend = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      guildChannel: { send },
      userById: {
        "user-1": { send: userSend },
      },
    });

    const result = await trackedMessageService.processDueSyncReminders(client);

    expect(result).toBe(1);
    expect(userSend).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessage.upsert).not.toHaveBeenCalled();
    expect(trackedRow.metadata.reminderSentAt).toEqual(expect.any(String));
    expect(trackedRow.metadata.statusPostedAt).toEqual(expect.any(String));
  });

  it("retries the public status post when DMs were already sent", async () => {
    const trackedRow = makeTrackedRow({
      metadata: {
        ...makeMetadata(),
        reminderSentAt: "2026-03-19T15:25:00.000Z",
      },
      claims: [{ clanTag: "#PYLQ", userId: "user-1" }],
    });
    bindTrackedRowPersistence(trackedRow);
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue(null);

    const react = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ id: "status-message-1", react });
    const userSend = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      guildChannel: { send },
      userById: {
        "user-1": { send: userSend },
      },
    });

    const result = await trackedMessageService.processDueSyncReminders(client);

    expect(result).toBe(1);
    expect(userSend).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(1);
    expect(trackedRow.metadata.reminderSentAt).toBe("2026-03-19T15:25:00.000Z");
    expect(trackedRow.metadata.statusPostedAt).toEqual(expect.any(String));
  });

  it("re-renders the status message line to claimed and back to unclaimed", async () => {
    prismaMock.trackedMessage.findUnique
      .mockResolvedValueOnce({
        ...makeTrackedRow({
          messageId: "status-message-1",
          channelId: "typed-sync-channel",
          referenceId: "sync-message-1",
          claims: [{ clanTag: "#PYLQ", userId: "user-1" }],
        }),
      })
      .mockResolvedValueOnce({
        channelId: "source-channel",
      })
      .mockResolvedValueOnce({
        ...makeTrackedRow({
          messageId: "status-message-1",
          channelId: "typed-sync-channel",
          referenceId: "sync-message-1",
          claims: [],
        }),
      })
      .mockResolvedValueOnce({
        channelId: "source-channel",
      });

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "status-message-1",
      edit,
    };

    await expect(trackedMessageService.refreshSyncSpinStatusMessage(message as any)).resolves.toBe(
      true,
    );
    expect(edit).toHaveBeenCalledTimes(1);
    expect((edit.mock.calls[0]?.[0] as any).embeds[0].toJSON().description).toContain(
      "✅ <:rr:111> **RR** (Rocky Road)",
    );
    expect((edit.mock.calls[0]?.[0] as any).components[0].components[0].data.label).toBe(
      "My Leader Accounts",
    );

    const claimedDescription = (edit.mock.calls[0]?.[0] as any).embeds[0].toJSON().description;
    expect(claimedDescription).toContain(
      "https://discord.com/channels/guild-1/source-channel/sync-message-1",
    );
    expect(claimedDescription).not.toContain(
      "https://discord.com/channels/guild-1/typed-sync-channel/sync-message-1",
    );

    edit.mockClear();
    await expect(trackedMessageService.refreshSyncSpinStatusMessage(message as any)).resolves.toBe(
      true,
    );
    expect(edit).toHaveBeenCalledTimes(1);
    expect((edit.mock.calls[0]?.[0] as any).embeds[0].toJSON().description).toContain(
      "- <:rr:111> **RR** (Rocky Road)",
    );
    expect((edit.mock.calls[0]?.[0] as any).components[0].components[0].data.label).toBe(
      "My Leader Accounts",
    );
  });
});
