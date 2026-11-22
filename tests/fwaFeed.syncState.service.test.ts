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
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("FwaFeedSyncStateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.$executeRaw.mockResolvedValue(0);
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

  it("does not let a CoC attendance refresh delay an established FWA boundary", async () => {
    const now = new Date("2026-03-19T10:00:00.000Z");
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({
      nextEligibleAt: new Date("2026-03-19T09:50:00.000Z"),
      lastAttemptAt: now,
    });
    const service = new FwaFeedSyncStateService();

    await expect(
      service.isEligible(
        { feedType: "CLAN_MEMBERS", scopeType: "CLAN_TAG", scopeKey: "#AAA111" },
        15 * 60 * 1000,
        now,
      ),
    ).resolves.toBe(true);
  });

  it("preserves the original minimum-interval guard for unrelated feeds after an expired boundary", async () => {
    const now = new Date("2026-03-19T10:00:00.000Z");
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({
      nextEligibleAt: new Date("2026-03-19T09:50:00.000Z"),
      lastAttemptAt: new Date("2026-03-19T09:55:00.000Z"),
    });
    const service = new FwaFeedSyncStateService();

    await expect(
      service.isEligible(
        { feedType: "WAR_MEMBERS", scopeType: "GLOBAL", scopeKey: "SWEEP" },
        15 * 60 * 1000,
        now,
      ),
    ).resolves.toBe(false);
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
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
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
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
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

  it("rejects a competing CLAN_MEMBERS attempt in the same millisecond", async () => {
    const state: any = { lastAttemptAt: null, nextEligibleAt: null };
    prismaMock.fwaFeedSyncState.findUnique.mockImplementation(async () => ({ ...state }));
    prismaMock.fwaFeedSyncState.upsert.mockImplementation(async (args: any) => {
      Object.assign(state, args.update ?? args.create ?? {});
    });
    const service = new FwaFeedSyncStateService();
    const now = new Date("2026-11-21T22:40:00.000Z");
    const first = await service.recordAttempt(
      { feedType: "CLAN_MEMBERS", scopeType: "CLAN_TAG", scopeKey: "#AAA111" },
      null,
      now,
    );
    const second = await service.recordAttempt(
      { feedType: "CLAN_MEMBERS", scopeType: "CLAN_TAG", scopeKey: "#AAA111" },
      null,
      now,
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);

    const staleFailure = await service.recordFailure(
      {
        feedType: "CLAN_MEMBERS",
        scopeType: "CLAN_TAG",
        scopeKey: "#AAA111",
        errorCode: "STALE",
        errorSummary: "stale failure",
        nextEligibleAt: null,
      },
      new Date("2026-11-21T22:40:00.000Z"),
      new Date("2026-11-21T22:39:59.999Z"),
    );
    expect(staleFailure).toBe(false);
    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps same-timestamp attempts unchanged for unrelated feeds", async () => {
    const now = new Date("2026-11-21T22:40:00.000Z");
    const state: any = { lastAttemptAt: now, nextEligibleAt: null };
    prismaMock.fwaFeedSyncState.findUnique.mockImplementation(async () => ({ ...state }));
    prismaMock.fwaFeedSyncState.upsert.mockImplementation(async (args: any) => {
      Object.assign(state, args.update ?? args.create ?? {});
    });
    const service = new FwaFeedSyncStateService();

    await expect(
      service.recordAttempt(
        { feedType: "WAR_MEMBERS", scopeType: "GLOBAL", scopeKey: "SWEEP" },
        null,
        now,
      ),
    ).resolves.toBe(true);
    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledTimes(1);
  });

  it("preserves the locked CLAN_MEMBERS cadence when the caller has no boundary", async () => {
    const now = new Date("2026-11-21T22:40:00.000Z");
    const boundary = new Date("2026-11-21T22:55:00.000Z");
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({
      lastAttemptAt: new Date("2026-11-21T22:30:00.000Z"),
      nextEligibleAt: boundary,
    });
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue(undefined);
    const service = new FwaFeedSyncStateService();

    await service.recordAttempt(
      { feedType: "CLAN_MEMBERS", scopeType: "CLAN_TAG", scopeKey: "#AAA111" },
      undefined,
      now,
    );

    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ nextEligibleAt: boundary }),
        update: expect.objectContaining({ nextEligibleAt: boundary }),
      }),
    );
  });

  it("checks scheduled CLAN_MEMBERS eligibility inside the registration fence", async () => {
    const now = new Date("2026-11-21T22:40:00.000Z");
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({
      lastAttemptAt: new Date("2026-11-21T22:30:00.000Z"),
      nextEligibleAt: new Date("2026-11-21T22:55:00.000Z"),
    });
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue(undefined);
    const service = new FwaFeedSyncStateService();

    await expect(
      service.recordAttempt(
        { feedType: "CLAN_MEMBERS", scopeType: "CLAN_TAG", scopeKey: "#AAA111" },
        new Date("2026-11-21T22:55:00.000Z"),
        now,
        { minimumIntervalMs: 15 * 60 * 1000 },
      ),
    ).resolves.toBe(false);
    expect(prismaMock.fwaFeedSyncState.upsert).not.toHaveBeenCalled();
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
