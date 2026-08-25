import { beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutRecord } from "@prisma/client";
import { InvalidClashLayoutLinkError } from "../src/services/ClashLayoutLinkService";
import {
  DuplicateLayoutLinkError,
  LayoutDiscordPostAlreadyBoundError,
  LayoutService,
} from "../src/services/LayoutService";

const layoutRecordMock = {
  create: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
};

const VALID_LAYOUT_LINK =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD";

function buildRecord(overrides: Partial<LayoutRecord> = {}): LayoutRecord {
  const createdAt = new Date("2026-08-24T00:00:00.000Z");
  return {
    id: "layout-1",
    layoutLink: VALID_LAYOUT_LINK,
    title: null,
    description: null,
    imageUrl: null,
    postedByDiscordUserId: null,
    discordGuildId: null,
    discordChannelId: null,
    discordMessageId: null,
    submittedAt: new Date("2026-08-24T01:00:00.000Z"),
    lastConfirmedAt: null,
    lastConfirmedByDiscordUserId: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("LayoutService", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  let service: LayoutService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LayoutService({
      db: { layoutRecord: layoutRecordMock } as any,
      now: () => now,
    });
  });

  it("creates a new record with an explicit submittedAt and no confirmation yet", async () => {
    layoutRecordMock.findUnique.mockResolvedValue(null);
    const created = buildRecord({ submittedAt: now });
    layoutRecordMock.create.mockResolvedValue(created);

    const result = await service.create({
      layoutLink: ` ${created.layoutLink} `,
      title: "TH18 war base",
      postedByDiscordUserId: "discord-user-1",
    });
    expect(result.submittedAt).toBe(now);
    expect(result.lastConfirmedAt).toBeNull();

    expect(layoutRecordMock.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        layoutLink: created.layoutLink,
        submittedAt: now,
        lastConfirmedAt: null,
        lastConfirmedByDiscordUserId: null,
      }),
    });
    expect(layoutRecordMock.create.mock.calls[0]?.[0].data.lastConfirmedAt).toBeNull();
  });

  it("finds records by id and exact layout link", async () => {
    const record = buildRecord();
    layoutRecordMock.findUnique.mockResolvedValue(record);

    await expect(service.findById(record.id)).resolves.toBe(record);
    await expect(service.findByLayoutLink(record.layoutLink)).resolves.toBe(record);

    expect(layoutRecordMock.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: record.id },
    });
    expect(layoutRecordMock.findUnique).toHaveBeenNthCalledWith(2, {
      where: { layoutLink: record.layoutLink },
    });
  });

  it("confirms an opening by updating only confirmation fields", async () => {
    const record = buildRecord({
      lastConfirmedAt: now,
      lastConfirmedByDiscordUserId: "discord-user-2",
    });
    layoutRecordMock.update.mockResolvedValue(record);

    await service.confirmSuccessfulOpening({
      id: record.id,
      discordUserId: "discord-user-2",
    });

    expect(layoutRecordMock.update).toHaveBeenCalledWith({
      where: { id: record.id },
      data: {
        lastConfirmedAt: now,
        lastConfirmedByDiscordUserId: "discord-user-2",
      },
    });
  });

  it("uses submittedAt before confirmation and lastConfirmedAt afterward", () => {
    const submittedAt = new Date("2026-08-20T00:00:00.000Z");
    const lastConfirmedAt = new Date("2026-08-24T00:00:00.000Z");

    expect(service.deriveFreshnessTimestamp(buildRecord({ submittedAt }))).toBe(submittedAt);
    expect(
      service.deriveFreshnessTimestamp(buildRecord({ submittedAt, lastConfirmedAt }))
    ).toBe(lastConfirmedAt);
  });

  it("keeps legacy records with null submittedAt at unknown freshness until confirmed", () => {
    const legacy = buildRecord({ submittedAt: null, lastConfirmedAt: null });
    const confirmedLegacy = buildRecord({
      submittedAt: null,
      lastConfirmedAt: now,
    });

    expect(service.deriveFreshnessTimestamp(legacy)).toBeNull();
    expect(service.deriveFreshnessTimestamp(confirmedLegacy)).toBe(now);
  });

  it("rejects an existing link before creating a second lifecycle", async () => {
    const existing = buildRecord();
    layoutRecordMock.findUnique.mockResolvedValue(existing);

    await expect(service.create({ layoutLink: existing.layoutLink })).rejects.toBeInstanceOf(
      DuplicateLayoutLinkError
    );
    expect(layoutRecordMock.create).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-layout-link",
    "https://example.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD",
    "",
    " ",
  ])("rejects %j before persistence", async (layoutLink) => {
    await expect(service.create({ layoutLink })).rejects.toBeInstanceOf(
      InvalidClashLayoutLinkError
    );

    expect(layoutRecordMock.findUnique).not.toHaveBeenCalled();
    expect(layoutRecordMock.create).not.toHaveBeenCalled();
  });

  it("turns a raced layout-link unique conflict into the same deterministic error", async () => {
    layoutRecordMock.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(buildRecord());
    layoutRecordMock.create.mockRejectedValue({
      code: "P2002",
    });

    await expect(service.create({ layoutLink: VALID_LAYOUT_LINK })).rejects.toBeInstanceOf(
      DuplicateLayoutLinkError
    );
    expect(layoutRecordMock.findUnique).toHaveBeenNthCalledWith(2, {
      where: { layoutLink: VALID_LAYOUT_LINK },
    });
  });

  it("rethrows an unrelated P2002 when the attempted layout link still does not exist", async () => {
    const uniqueError = {
      code: "P2002",
      meta: {
        target: [
          "discordGuildId",
          "discordChannelId",
          "discordMessageId",
        ],
      },
    };
    layoutRecordMock.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    layoutRecordMock.create.mockRejectedValue(uniqueError);

    await expect(service.create({ layoutLink: VALID_LAYOUT_LINK })).rejects.toBe(uniqueError);
  });

  it("attaches canonical Discord provenance without changing lifecycle fields", async () => {
    const existing = buildRecord({
      submittedAt: new Date("2026-08-20T00:00:00.000Z"),
      lastConfirmedAt: new Date("2026-08-23T00:00:00.000Z"),
      lastConfirmedByDiscordUserId: "old-user",
    });
    const attached = buildRecord({
      ...existing,
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "message-1",
      imageUrl: "https://example.com/layout.png",
    });
    layoutRecordMock.findUnique
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(attached);
    layoutRecordMock.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.attachDiscordPost({
        id: existing.id,
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        imageUrl: " https://example.com/layout.png ",
      }),
    ).resolves.toBe(attached);

    expect(layoutRecordMock.updateMany).toHaveBeenCalledWith({
      where: {
        id: existing.id,
        discordGuildId: null,
        discordChannelId: null,
        discordMessageId: null,
      },
      data: {
        discordGuildId: "guild-1",
        discordChannelId: "channel-1",
        discordMessageId: "message-1",
        imageUrl: "https://example.com/layout.png",
      },
    });
    expect(layoutRecordMock.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("submittedAt");
    expect(layoutRecordMock.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("lastConfirmedAt");
  });

  it("treats an exact canonical post assignment as idempotent", async () => {
    const existing = buildRecord({
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "message-1",
    });
    layoutRecordMock.findUnique.mockResolvedValue(existing);

    await expect(
      service.attachDiscordPost({
        id: existing.id,
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
      }),
    ).resolves.toBe(existing);
    expect(layoutRecordMock.update).not.toHaveBeenCalled();
  });

  it("rejects repointing an already-bound canonical layout post", async () => {
    const existing = buildRecord({
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "message-1",
    });
    layoutRecordMock.findUnique.mockResolvedValue(existing);

    await expect(
      service.attachDiscordPost({
        id: existing.id,
        guildId: "guild-2",
        channelId: "channel-2",
        messageId: "message-2",
      }),
    ).rejects.toBeInstanceOf(LayoutDiscordPostAlreadyBoundError);
    expect(layoutRecordMock.updateMany).not.toHaveBeenCalled();
    expect(layoutRecordMock.update).not.toHaveBeenCalled();
  });

  it("rejects a concurrent bind when another post wins the conditional assignment", async () => {
    const unbound = buildRecord();
    const winner = buildRecord({
      discordGuildId: "guild-2",
      discordChannelId: "channel-2",
      discordMessageId: "message-2",
    });
    layoutRecordMock.findUnique
      .mockResolvedValueOnce(unbound)
      .mockResolvedValueOnce(winner);
    layoutRecordMock.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.attachDiscordPost({
        id: unbound.id,
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
      }),
    ).rejects.toBeInstanceOf(LayoutDiscordPostAlreadyBoundError);
    expect(layoutRecordMock.updateMany).toHaveBeenCalledWith({
      where: {
        id: unbound.id,
        discordGuildId: null,
        discordChannelId: null,
        discordMessageId: null,
      },
      data: {
        discordGuildId: "guild-1",
        discordChannelId: "channel-1",
        discordMessageId: "message-1",
      },
    });
  });

  it("treats a concurrent bind to the same post as idempotent", async () => {
    const unbound = buildRecord();
    const winner = buildRecord({
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "message-1",
    });
    layoutRecordMock.findUnique
      .mockResolvedValueOnce(unbound)
      .mockResolvedValueOnce(winner);
    layoutRecordMock.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.attachDiscordPost({
        id: unbound.id,
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
      }),
    ).resolves.toBe(winner);
  });
});
