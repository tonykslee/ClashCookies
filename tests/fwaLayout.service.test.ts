import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaLayoutService } from "../src/services/FwaLayoutService";

const LINK_TH18 =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD18";
const LINK_TH17 =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH17%3AWB%3APAYLOAD17";
const NOW = new Date("2026-08-25T00:00:00.000Z");

const db = {
  fwaLayouts: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  layoutRecord: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn(),
};

function buildRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "layout-1",
    layoutLink: LINK_TH18,
    title: null,
    description: null,
    imageUrl: null,
    postedByDiscordUserId: null,
    discordGuildId: null,
    discordChannelId: null,
    discordMessageId: null,
    submittedAt: null,
    lastConfirmedAt: null,
    lastConfirmedByDiscordUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildFwaRow(overrides: Record<string, unknown> = {}) {
  return {
    Townhall: 18,
    Type: "RISINGDAWN",
    LayoutLink: LINK_TH18,
    ImageUrl: null,
    LastUpdated: NOW,
    layoutId: "layout-1",
    layoutRecord: buildRecord(),
    ...overrides,
  };
}

describe("FwaLayoutService", () => {
  let service: FwaLayoutService;

  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (transaction: typeof db) => unknown) =>
      callback(db),
    );
    db.fwaLayouts.findUnique.mockResolvedValue(null);
    db.layoutRecord.findUnique.mockResolvedValue(null);
    db.layoutRecord.create.mockImplementation(async ({ data }: any) =>
      buildRecord({ ...data, id: "layout-created" }),
    );
    db.layoutRecord.update.mockImplementation(async ({ data }: any) =>
      buildRecord({ ...data }),
    );
    db.fwaLayouts.upsert.mockResolvedValue(buildFwaRow());
    db.layoutRecord.upsert.mockResolvedValue(buildRecord({ submittedAt: null }));
    db.fwaLayouts.update.mockResolvedValue(buildFwaRow());
    service = new FwaLayoutService({ db: db as any, now: () => NOW });
  });

  it("derives TH from the link and creates a fresh canonical LayoutRecord", async () => {
    await service.setCanonicalLayout({
      type: "BASIC",
      layoutLink: ` ${LINK_TH18} `,
      postedByDiscordUserId: "admin-1",
      imageUrl: " https://example.com/base.png ",
    });

    expect(db.layoutRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        layoutLink: LINK_TH18,
        imageUrl: "https://example.com/base.png",
        postedByDiscordUserId: "admin-1",
        submittedAt: NOW,
        lastConfirmedAt: null,
        lastConfirmedByDiscordUserId: null,
      }),
    });
    expect(db.fwaLayouts.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ Townhall: 18, Type: "BASIC", layoutId: "layout-created" }),
        update: expect.objectContaining({ LayoutLink: LINK_TH18, layoutId: "layout-created" }),
      }),
    );
  });

  it("rejects an explicit TH that disagrees with the parsed link", async () => {
    await expect(
      service.setCanonicalLayout({
        townhall: 17,
        type: "RISINGDAWN",
        layoutLink: LINK_TH18,
      }),
    ).rejects.toThrow("TH17 does not match");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("reuses an exact link without changing lifecycle or poster fields", async () => {
    const existing = buildRecord({
      submittedAt: new Date("2026-08-01T00:00:00.000Z"),
      lastConfirmedAt: new Date("2026-08-20T00:00:00.000Z"),
      lastConfirmedByDiscordUserId: "confirmer-1",
      postedByDiscordUserId: "original-poster",
    });
    db.layoutRecord.findUnique.mockResolvedValue(existing);

    await service.setCanonicalLayout({
      type: "RISINGDAWN",
      layoutLink: LINK_TH18,
      postedByDiscordUserId: "different-admin",
    });

    expect(db.layoutRecord.create).not.toHaveBeenCalled();
    expect(db.layoutRecord.update).not.toHaveBeenCalled();
    expect(db.fwaLayouts.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          layoutId: existing.id,
          LayoutLink: LINK_TH18,
          ImageUrl: existing.imageUrl,
        }),
      }),
    );
  });

  it("updates presentation fields without changing freshness", async () => {
    const existing = buildRecord({
      submittedAt: new Date("2026-08-01T00:00:00.000Z"),
      lastConfirmedAt: new Date("2026-08-20T00:00:00.000Z"),
      lastConfirmedByDiscordUserId: "confirmer-1",
    });
    db.layoutRecord.findUnique.mockResolvedValue(existing);
    db.layoutRecord.update.mockResolvedValue({
      ...existing,
      title: "Updated title",
      description: "Updated description",
      imageUrl: "https://example.com/new.png",
    });

    await service.setCanonicalLayout({
      type: "RISINGDAWN",
      layoutLink: LINK_TH18,
      title: "Updated title",
      description: "Updated description",
      imageUrl: "https://example.com/new.png",
    });

    expect(db.layoutRecord.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: {
        title: "Updated title",
        description: "Updated description",
        imageUrl: "https://example.com/new.png",
      },
    });
    expect(db.layoutRecord.update.mock.calls[0]?.[0].data).not.toHaveProperty("submittedAt");
    expect(db.layoutRecord.update.mock.calls[0]?.[0].data).not.toHaveProperty("lastConfirmedAt");
  });

  it("repairs an existing customized seed row without overwriting its compatibility values", async () => {
    const current = buildFwaRow({
      LayoutLink: LINK_TH17,
      ImageUrl: "https://example.com/custom.png",
      layoutId: null,
    });
    db.fwaLayouts.findUnique.mockResolvedValue(current);
    db.layoutRecord.upsert.mockResolvedValue(
      buildRecord({
        id: "legacy-custom",
        layoutLink: LINK_TH17,
        imageUrl: "https://example.com/custom.png",
        submittedAt: null,
      }),
    );
    db.fwaLayouts.upsert.mockResolvedValue({ ...current, layoutId: "legacy-custom" });

    await service.upsertSeedRows([
      {
        Townhall: 18,
        Type: "RISINGDAWN",
        LayoutLink: LINK_TH18,
        ImageUrl: "https://example.com/seed.png",
      },
    ]);

    expect(db.layoutRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { layoutLink: LINK_TH17 },
        create: expect.objectContaining({
          layoutLink: LINK_TH17,
          imageUrl: "https://example.com/custom.png",
          submittedAt: null,
          lastConfirmedAt: null,
        }),
      }),
    );
    expect(db.fwaLayouts.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ LayoutLink: LINK_TH18 }),
        update: { layoutId: "legacy-custom" },
      }),
    );
  });
});
