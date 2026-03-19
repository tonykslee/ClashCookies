import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaFeedSyncStateService } from "../src/services/fwa-feeds/FwaFeedSyncStateService";
import {
  FWA_FEED_SCOPE_KEY_GLOBAL,
  FWA_FEED_SCOPE_KEY_TRACKED_CLANS,
} from "../src/services/fwa-feeds/scopeKey";

const prismaMock = vi.hoisted(() => ({
  fwaFeedSyncState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("FwaFeedSyncStateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats missing scope state as eligible", async () => {
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    const service = new FwaFeedSyncStateService();
    const eligible = await service.isEligible(
      { feedType: "CLANS", scopeType: "GLOBAL", scopeKey: null },
      15 * 60 * 1000,
      new Date("2026-03-19T10:00:00.000Z"),
    );
    expect(eligible).toBe(true);
    expect(prismaMock.fwaFeedSyncState.findUnique).toHaveBeenCalledWith({
      where: {
        feedType_scopeType_scopeKey: {
          feedType: "CLANS",
          scopeType: "GLOBAL",
          scopeKey: FWA_FEED_SCOPE_KEY_GLOBAL,
        },
      },
    });
  });

  it("blocks runs before nextEligibleAt", async () => {
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({
      nextEligibleAt: new Date("2026-03-19T10:10:00.000Z"),
      lastAttemptAt: new Date("2026-03-19T09:55:00.000Z"),
    });
    const service = new FwaFeedSyncStateService();
    const eligible = await service.isEligible(
      { feedType: "CLAN_MEMBERS", scopeType: "CLAN_TAG", scopeKey: "#AAA111" },
      15 * 60 * 1000,
      new Date("2026-03-19T10:00:00.000Z"),
    );
    expect(eligible).toBe(false);
  });

  it("persists success metadata with row counts and hash", async () => {
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue(undefined);
    const service = new FwaFeedSyncStateService();
    await service.recordSuccess({
      feedType: "WAR_MEMBERS",
      scopeType: "GLOBAL",
      scopeKey: "SWEEP",
      rowCount: 20,
      changedRowCount: 5,
      contentHash: "abc123",
      status: "SUCCESS",
      nextEligibleAt: new Date("2026-03-19T10:15:00.000Z"),
    });
    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastRowCount: 20,
          lastChangedRowCount: 5,
          lastContentHash: "abc123",
          lastStatus: "SUCCESS",
        }),
        where: {
          feedType_scopeType_scopeKey: {
            feedType: "WAR_MEMBERS",
            scopeType: "GLOBAL",
            scopeKey: FWA_FEED_SCOPE_KEY_GLOBAL,
          },
        },
      }),
    );
  });

  it("TRACKED_CLANS upsert resolves to sentinel scopeKey", async () => {
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue(undefined);
    const service = new FwaFeedSyncStateService();

    await service.recordAttempt(
      {
        feedType: "CLAN_MEMBERS",
        scopeType: "TRACKED_CLANS",
        scopeKey: null,
      },
      new Date("2026-03-19T10:15:00.000Z"),
      new Date("2026-03-19T10:00:00.000Z"),
    );

    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          feedType_scopeType_scopeKey: {
            feedType: "CLAN_MEMBERS",
            scopeType: "TRACKED_CLANS",
            scopeKey: FWA_FEED_SCOPE_KEY_TRACKED_CLANS,
          },
        },
        create: expect.objectContaining({
          scopeKey: FWA_FEED_SCOPE_KEY_TRACKED_CLANS,
        }),
      }),
    );
  });

  it("CLAN_TAG upsert resolves to normalized clan tag scopeKey", async () => {
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue(undefined);
    const service = new FwaFeedSyncStateService();

    await service.recordAttempt(
      {
        feedType: "CLAN_WARS",
        scopeType: "CLAN_TAG",
        scopeKey: " aaa111 ",
      },
      new Date("2026-03-19T10:15:00.000Z"),
      new Date("2026-03-19T10:00:00.000Z"),
    );

    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          feedType_scopeType_scopeKey: {
            feedType: "CLAN_WARS",
            scopeType: "CLAN_TAG",
            scopeKey: "#AAA111",
          },
        },
        create: expect.objectContaining({
          scopeKey: "#AAA111",
        }),
      }),
    );
  });

  it("throws when CLAN_TAG scopeKey is missing", async () => {
    const service = new FwaFeedSyncStateService();
    await expect(
      service.recordAttempt(
        {
          feedType: "CLAN_WARS",
          scopeType: "CLAN_TAG",
          scopeKey: null,
        },
        new Date("2026-03-19T10:15:00.000Z"),
      ),
    ).rejects.toThrow("scopeKey is required when scopeType is CLAN_TAG");
    expect(prismaMock.fwaFeedSyncState.upsert).not.toHaveBeenCalled();
  });

  it("never writes null scopeKey in any upsert payload", async () => {
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue(undefined);
    const service = new FwaFeedSyncStateService();

    await service.recordFailure({
      feedType: "CLAN_MEMBERS",
      scopeType: "TRACKED_CLANS",
      scopeKey: null,
      errorCode: "ERR",
      errorSummary: "failed",
      nextEligibleAt: null,
    });

    const upsertArg = prismaMock.fwaFeedSyncState.upsert.mock.calls.at(-1)?.[0];
    expect(upsertArg.create.scopeKey).not.toBeNull();
    expect(upsertArg.where.feedType_scopeType_scopeKey.scopeKey).not.toBeNull();
  });
});
