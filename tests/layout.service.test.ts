import { beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutRecord } from "@prisma/client";
import {
  DuplicateLayoutLinkError,
  LayoutService,
} from "../src/services/LayoutService";

const layoutRecordMock = {
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
};

function buildRecord(overrides: Partial<LayoutRecord> = {}): LayoutRecord {
  const createdAt = new Date("2026-08-24T00:00:00.000Z");
  return {
    id: "layout-1",
    layoutLink:
      "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD",
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

  it("turns a raced layout-link unique conflict into the same deterministic error", async () => {
    layoutRecordMock.findUnique.mockResolvedValue(null);
    layoutRecordMock.create.mockRejectedValue({
      code: "P2002",
      meta: { target: ["layoutLink"] },
    });

    await expect(
      service.create({ layoutLink: "https://link.clashofclans.com/layout" })
    ).rejects.toBeInstanceOf(DuplicateLayoutLinkError);
  });
});
