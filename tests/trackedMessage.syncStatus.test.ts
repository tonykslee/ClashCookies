import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
} from "../src/services/TrackedMessageService";

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
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
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

describe("TrackedMessageService sync spin status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue(null);
    prismaMock.trackedMessage.findUnique.mockResolvedValue(null);
    prismaMock.trackedMessage.upsert.mockResolvedValue(undefined);
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);
    prismaMock.trackedMessage.updateMany.mockResolvedValue({ count: 0 });
  });

  it("posts the scheduled status embed once and reacts with every clan badge", async () => {
    const trackedRow = makeTrackedRow();
    bindTrackedRowPersistence(trackedRow);
    prismaMock.trackedMessage.findMany.mockResolvedValue([trackedRow]);

    const react = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ id: "status-message-1", react });
    const client = makeClient({ guildChannel: { send } });

    const result = await trackedMessageService.processDueSyncReminders(client);

    expect(result).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON() as any;
    expect(embed.title).toBe("Sync Spin Status");
    expect(embed.description).toContain("Claimed: **0/2**");
    expect(embed.description).toContain("- <:rr:111> **RR** (Rocky Road)");
    expect(embed.description).toContain("- <:twc:222> **TWC** (TheWiseCowboys)");
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
          referenceId: "sync-message-1",
          claims: [{ clanTag: "#PYLQ", userId: "user-1" }],
        }),
      })
      .mockResolvedValueOnce({
        ...makeTrackedRow({
          messageId: "status-message-1",
          referenceId: "sync-message-1",
          claims: [],
        }),
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

    edit.mockClear();
    await expect(trackedMessageService.refreshSyncSpinStatusMessage(message as any)).resolves.toBe(
      true,
    );
    expect(edit).toHaveBeenCalledTimes(1);
    expect((edit.mock.calls[0]?.[0] as any).embeds[0].toJSON().description).toContain(
      "- <:rr:111> **RR** (Rocky Road)",
    );
  });
});
