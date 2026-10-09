import { beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutRecord } from "@prisma/client";
import { InvalidClashLayoutLinkError } from "../src/services/ClashLayoutLinkService";
import {
  ConcurrentLayoutReplacementError,
  DuplicateLayoutLinkError,
  LayoutDiscordPostAlreadyBoundError,
  LayoutReplacementKindMismatchError,
  LayoutReplacementTownHallMismatchError,
  LayoutService,
  StaleLayoutConfirmationError,
} from "../src/services/LayoutService";

const layoutRecordMock = {
  create: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
};

const fwaLayoutsMock = {
  updateMany: vi.fn(),
};

const projectionDb = {
  layoutRecord: layoutRecordMock,
  fwaLayouts: fwaLayoutsMock,
  $transaction: vi.fn(),
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
    projectionDb.$transaction.mockImplementation(async (callback: (transaction: typeof projectionDb) => unknown) =>
      callback(projectionDb),
    );
    fwaLayoutsMock.updateMany.mockResolvedValue({ count: 2 });
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
    layoutRecordMock.updateMany.mockResolvedValue({ count: 1 });
    layoutRecordMock.findUnique.mockResolvedValue(record);

    await service.confirmSuccessfulOpening({
      id: record.id,
      discordUserId: "discord-user-2",
      expectedLayoutLink: record.layoutLink,
    });

    expect(layoutRecordMock.updateMany).toHaveBeenCalledWith({
      where: { id: record.id, layoutLink: record.layoutLink },
      data: {
        lastConfirmedAt: now,
        lastConfirmedByDiscordUserId: "discord-user-2",
      },
    });
  });

  it("replaces a link with a stable record ID and resets freshness through a CAS", async () => {
    const replacement = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AREPLACED";
    const current = buildRecord({
      lastConfirmedAt: now,
      lastConfirmedByDiscordUserId: "discord-user-2",
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "message-1",
    });
    const updated = buildRecord({
      ...current,
      layoutLink: replacement,
      submittedAt: now,
      lastConfirmedAt: null,
      lastConfirmedByDiscordUserId: null,
    });
    layoutRecordMock.findUnique
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(updated);
    layoutRecordMock.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.replaceLink({
      id: current.id,
      expectedOldLayoutLink: current.layoutLink,
      replacementLink: replacement,
    })).resolves.toEqual(updated);

    expect(layoutRecordMock.updateMany).toHaveBeenCalledWith({
      where: { id: current.id, layoutLink: current.layoutLink },
      data: {
        layoutLink: replacement,
        submittedAt: now,
        lastConfirmedAt: null,
        lastConfirmedByDiscordUserId: null,
      },
    });
    expect(updated.id).toBe(current.id);
  });

  it("updates every FWA compatibility projection in the same transaction", async () => {
    const replacement = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APROJECTED";
    const current = buildRecord();
    const updated = buildRecord({ ...current, layoutLink: replacement, submittedAt: now });
    layoutRecordMock.findUnique
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(updated);
    layoutRecordMock.updateMany.mockResolvedValue({ count: 1 });
    const transactionalService = new LayoutService({ db: projectionDb as any, now: () => now });

    await transactionalService.replaceLink({
      id: current.id,
      expectedOldLayoutLink: current.layoutLink,
      replacementLink: replacement,
    });

    expect(fwaLayoutsMock.updateMany).toHaveBeenCalledWith({
      where: { layoutId: current.id },
      data: { LayoutLink: replacement, ImageUrl: current.imageUrl },
    });
  });

  it("rolls back the layout and FWA copies when projection fails in the transaction", async () => {
    const replacement = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APROJECTION_FAIL";
    const current = buildRecord();
    const initialFwaCopies = [
      { layoutId: current.id, LayoutLink: current.layoutLink, ImageUrl: current.imageUrl },
      { layoutId: current.id, LayoutLink: current.layoutLink, ImageUrl: current.imageUrl },
    ];
    let persistedLayout = current;
    let persistedFwaCopies = initialFwaCopies.map((copy) => ({ ...copy }));
    const transactionalDb: any = {
      layoutRecord: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string; layoutLink?: string } }) => {
          if (where.id && persistedLayout.id !== where.id) return null;
          if (where.layoutLink && persistedLayout.layoutLink !== where.layoutLink) return null;
          return persistedLayout;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { id: string; layoutLink: string }; data: Partial<LayoutRecord> }) => {
          if (persistedLayout.id !== where.id || persistedLayout.layoutLink !== where.layoutLink) return { count: 0 };
          persistedLayout = { ...persistedLayout, ...data };
          return { count: 1 };
        }),
      },
      fwaLayouts: {
        updateMany: vi.fn(async ({ where, data }: { where: { layoutId: string }; data: { LayoutLink: string; ImageUrl: string | null } }) => {
          persistedFwaCopies = persistedFwaCopies.map((copy) =>
            copy.layoutId === where.layoutId ? { ...copy, ...data } : copy,
          );
          throw new Error("projection unavailable");
        }),
      },
      $transaction: vi.fn(async (callback: (transaction: any) => Promise<unknown>) => {
        const layoutBeforeTransaction = persistedLayout;
        const fwaCopiesBeforeTransaction = persistedFwaCopies.map((copy) => ({ ...copy }));
        try {
          return await callback(transactionalDb);
        } catch (error) {
          persistedLayout = layoutBeforeTransaction;
          persistedFwaCopies = fwaCopiesBeforeTransaction;
          throw error;
        }
      }),
    };
    const transactionalService = new LayoutService({ db: transactionalDb, now: () => now });

    await expect(transactionalService.replaceLink({
      id: current.id,
      expectedOldLayoutLink: current.layoutLink,
      replacementLink: replacement,
    })).rejects.toThrow("projection unavailable");
    expect(persistedLayout).toEqual(current);
    expect(persistedFwaCopies).toEqual(initialFwaCopies);
  });

  it("rejects a replacement when its expected old link is stale", async () => {
    const current = buildRecord({
      layoutLink: "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3ACURRENT",
    });
    layoutRecordMock.findUnique.mockResolvedValue(current);

    await expect(service.replaceLink({
      id: current.id,
      expectedOldLayoutLink: VALID_LAYOUT_LINK,
      replacementLink: "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AREPLACED",
    })).rejects.toBeInstanceOf(ConcurrentLayoutReplacementError);
    expect(layoutRecordMock.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a replacement link already owned by another record", async () => {
    const replacement = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AALREADY_OWNED";
    const current = buildRecord();
    const owner = buildRecord({ id: "other-layout", layoutLink: replacement });
    layoutRecordMock.findUnique
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(owner);

    await expect(service.replaceLink({
      id: current.id,
      expectedOldLayoutLink: current.layoutLink,
      replacementLink: replacement,
    })).rejects.toBeInstanceOf(DuplicateLayoutLinkError);
    expect(layoutRecordMock.updateMany).not.toHaveBeenCalled();
  });

  it("treats an unchanged semantic layout ID as a no-op without resetting freshness", async () => {
    const current = buildRecord({ lastConfirmedAt: now });
    const equivalentLink = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD";
    layoutRecordMock.findUnique.mockResolvedValue(current);

    await expect(service.replaceLink({
      id: current.id,
      expectedOldLayoutLink: current.layoutLink,
      replacementLink: equivalentLink,
    })).resolves.toBe(current);
    expect(layoutRecordMock.updateMany).not.toHaveBeenCalled();
    expect(current.lastConfirmedAt).toBe(now);
  });

  it("enforces Town Hall and layout kind invariants at the service boundary", async () => {
    const current = buildRecord();
    layoutRecordMock.findUnique.mockResolvedValue(current);

    await expect(service.replaceLink({
      id: current.id,
      expectedOldLayoutLink: current.layoutLink,
      replacementLink: "https://link.clashofclans.com/en?action=OpenLayout&id=TH17%3AWB%3AREPLACED",
    })).rejects.toBeInstanceOf(LayoutReplacementTownHallMismatchError);

    layoutRecordMock.findUnique.mockReset();
    layoutRecordMock.findUnique.mockResolvedValue(current);
    await expect(service.replaceLink({
      id: current.id,
      expectedOldLayoutLink: current.layoutLink,
      replacementLink: "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AHV%3AREPLACED",
    })).rejects.toBeInstanceOf(LayoutReplacementKindMismatchError);
    expect(layoutRecordMock.updateMany).not.toHaveBeenCalled();
  });

  it("guards confirmation against a link replacement that raced the click", async () => {
    layoutRecordMock.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.confirmSuccessfulOpening({
      id: "layout-1",
      discordUserId: "discord-user-1",
      expectedLayoutLink: VALID_LAYOUT_LINK,
    })).rejects.toBeInstanceOf(StaleLayoutConfirmationError);
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

  it("atomically reuses an exact link without refreshing lifecycle or poster fields", async () => {
    const existing = buildRecord({
      submittedAt: new Date("2026-08-20T00:00:00.000Z"),
      lastConfirmedAt: new Date("2026-08-23T00:00:00.000Z"),
      lastConfirmedByDiscordUserId: "confirmer-1",
      postedByDiscordUserId: "original-poster",
    });
    layoutRecordMock.upsert.mockResolvedValue(existing);

    await expect(
      service.getOrCreate({
        layoutLink: VALID_LAYOUT_LINK,
        postedByDiscordUserId: "different-poster",
      }),
    ).resolves.toBe(existing);

    expect(layoutRecordMock.upsert).toHaveBeenCalledWith({
      where: { layoutLink: VALID_LAYOUT_LINK },
      update: {},
      create: expect.objectContaining({
        submittedAt: now,
        postedByDiscordUserId: "different-poster",
        lastConfirmedAt: null,
      }),
    });
  });

  it("resolves a concurrent exact-link get-or-create race to the one persisted record", async () => {
    const existing = buildRecord();
    const uniqueError = { code: "P2002" };
    layoutRecordMock.upsert.mockRejectedValue(uniqueError);
    layoutRecordMock.findUnique.mockResolvedValue(existing);

    await expect(service.getOrCreate({ layoutLink: VALID_LAYOUT_LINK })).resolves.toBe(existing);
    expect(layoutRecordMock.findUnique).toHaveBeenCalledWith({
      where: { layoutLink: VALID_LAYOUT_LINK },
    });
  });

  it("projects a root get-or-create presentation change to every shared FWA row", async () => {
    const projected = buildRecord({ imageUrl: "https://example.com/new.png" });
    layoutRecordMock.upsert.mockResolvedValue(projected);
    const projectedService = new LayoutService({ db: projectionDb as any, now: () => now });

    await expect(projectedService.getOrCreate({
      layoutLink: VALID_LAYOUT_LINK,
      imageUrl: projected.imageUrl,
    })).resolves.toBe(projected);

    expect(projectionDb.$transaction).toHaveBeenCalledTimes(1);
    expect(fwaLayoutsMock.updateMany).toHaveBeenCalledWith({
      where: { layoutId: projected.id },
      data: { LayoutLink: projected.layoutLink, ImageUrl: projected.imageUrl },
    });
  });

  it("projects a root create presentation to shared FWA rows", async () => {
    const created = buildRecord({ imageUrl: "https://example.com/created.png" });
    layoutRecordMock.findUnique.mockResolvedValue(null);
    layoutRecordMock.create.mockResolvedValue(created);
    const projectedService = new LayoutService({ db: projectionDb as any, now: () => now });

    await expect(projectedService.create({
      layoutLink: VALID_LAYOUT_LINK,
      imageUrl: created.imageUrl,
    })).resolves.toBe(created);

    expect(fwaLayoutsMock.updateMany).toHaveBeenCalledWith({
      where: { layoutId: created.id },
      data: { LayoutLink: created.layoutLink, ImageUrl: created.imageUrl },
    });
  });

  it("projects a root presentation update without changing FWA designation fields", async () => {
    const existing = buildRecord({ imageUrl: "https://example.com/old.png" });
    const updated = buildRecord({ imageUrl: "https://example.com/new.png" });
    layoutRecordMock.update.mockResolvedValue(updated);
    const projectedService = new LayoutService({ db: projectionDb as any, now: () => now });

    await expect(projectedService.updatePresentation(existing.id, {
      imageUrl: updated.imageUrl,
    })).resolves.toBe(updated);

    expect(fwaLayoutsMock.updateMany).toHaveBeenCalledWith({
      where: { layoutId: existing.id },
      data: { LayoutLink: updated.layoutLink, ImageUrl: updated.imageUrl },
    });
    expect(fwaLayoutsMock.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("layoutId");
    expect(fwaLayoutsMock.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("Townhall");
    expect(fwaLayoutsMock.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("Type");
  });

  it("keeps title and description-only projection writes designation-neutral", async () => {
    const existing = buildRecord();
    const updated = buildRecord({ title: "Title", description: "Description" });
    layoutRecordMock.update.mockResolvedValue(updated);
    const projectedService = new LayoutService({ db: projectionDb as any, now: () => now });

    await projectedService.updatePresentation(existing.id, {
      title: updated.title,
      description: updated.description,
    });

    expect(fwaLayoutsMock.updateMany).toHaveBeenCalledWith({
      where: { layoutId: existing.id },
      data: { LayoutLink: existing.layoutLink, ImageUrl: existing.imageUrl },
    });
  });

  it("rolls back a root presentation mutation when compatibility projection fails", async () => {
    let persisted = buildRecord({ imageUrl: "https://example.com/old.png" });
    layoutRecordMock.update.mockImplementation(async ({ data }: any) => {
      persisted = { ...persisted, ...data };
      return persisted;
    });
    fwaLayoutsMock.updateMany.mockRejectedValue(new Error("projection failed"));
    projectionDb.$transaction.mockImplementation(async (callback: (transaction: typeof projectionDb) => unknown) => {
      const before = persisted;
      try {
        return await callback(projectionDb);
      } catch (error) {
        persisted = before;
        throw error;
      }
    });
    const projectedService = new LayoutService({ db: projectionDb as any, now: () => now });

    await expect(projectedService.updatePresentation(persisted.id, {
      imageUrl: "https://example.com/new.png",
    })).rejects.toThrow("projection failed");
    expect(persisted.imageUrl).toBe("https://example.com/old.png");
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
