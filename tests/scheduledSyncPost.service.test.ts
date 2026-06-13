import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  scheduledSyncPost: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const txMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  scheduledSyncPost: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "claim-token-1"),
}));

import {
  SCHEDULED_SYNC_POST_STATUS,
  scheduledSyncPostService,
} from "../src/services/ScheduledSyncPostService";

describe("ScheduledSyncPostService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
      callback(txMock),
    );

    txMock.$executeRaw.mockResolvedValue(undefined);
    txMock.scheduledSyncPost.findMany.mockResolvedValue([]);
    txMock.scheduledSyncPost.findUnique.mockResolvedValue(null);
    txMock.scheduledSyncPost.create.mockImplementation(async (args: any) => ({
      id: "scheduled-sync-1",
      ...args.data,
      status: SCHEDULED_SYNC_POST_STATUS.PENDING,
      claimToken: null,
      claimedAt: null,
      publishedMessageId: null,
      publishedAt: null,
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      failureReason: null,
      failureCode: null,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    }));

    prismaMock.scheduledSyncPost.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledSyncPost.findUnique.mockResolvedValue(null);
    prismaMock.scheduledSyncPost.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a schedule and replaces older pending rows in the same guild", async () => {
    txMock.scheduledSyncPost.findUnique.mockResolvedValue(null);
    txMock.scheduledSyncPost.findMany.mockResolvedValue([{ id: "pending-1" }]);

    const result = await scheduledSyncPostService.scheduleSyncTimePost({
      guildId: "guild-1",
      channelId: "channel-1",
      createdByUserId: "user-1",
      roleId: "role-1",
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      publishAt: new Date("2026-06-15T23:30:00.000Z"),
      timezone: "America/Chicago",
    });

    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
    expect(txMock.scheduledSyncPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["pending-1"] },
          status: SCHEDULED_SYNC_POST_STATUS.PENDING,
        },
        data: expect.objectContaining({
          status: SCHEDULED_SYNC_POST_STATUS.REPLACED,
          failureReason: "replaced_by_new_schedule",
          failureCode: "replaced",
        }),
      }),
    );
    expect(txMock.scheduledSyncPost.create).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("replaced");
    expect(result.schedule.id).toBe("scheduled-sync-1");
  });

  it("reuses an existing schedule for the same guild and sync time", async () => {
    const existing = {
      id: "existing-sync-1",
      guildId: "guild-1",
      channelId: "channel-1",
      createdByUserId: "user-1",
      roleId: "role-1",
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      publishAt: new Date("2026-06-15T23:30:00.000Z"),
      timezone: "America/Chicago",
      status: SCHEDULED_SYNC_POST_STATUS.PENDING,
      claimToken: null,
      claimedAt: null,
      publishedMessageId: null,
      publishedAt: null,
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      failureReason: null,
      failureCode: null,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    };
    txMock.scheduledSyncPost.findUnique.mockResolvedValue(existing);

    const result = await scheduledSyncPostService.scheduleSyncTimePost({
      guildId: "guild-1",
      channelId: "channel-1",
      createdByUserId: "user-1",
      roleId: "role-1",
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      publishAt: new Date("2026-06-15T23:30:00.000Z"),
      timezone: "America/Chicago",
    });

    expect(txMock.scheduledSyncPost.create).not.toHaveBeenCalled();
    expect(txMock.scheduledSyncPost.updateMany).not.toHaveBeenCalled();
    expect(result.action).toBe("reused");
    expect(result.schedule.id).toBe(existing.id);
  });

  it("claims pending rows with a deterministic token", async () => {
    const now = new Date("2026-06-15T23:31:00.000Z");
    const row = {
      id: "schedule-claim-1",
      guildId: "guild-1",
      channelId: "channel-1",
      createdByUserId: "user-1",
      roleId: "role-1",
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      publishAt: new Date("2026-06-15T23:30:00.000Z"),
      timezone: "America/Chicago",
      status: SCHEDULED_SYNC_POST_STATUS.PENDING,
      claimToken: null,
      claimedAt: null,
      publishedMessageId: null,
      publishedAt: null,
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      failureReason: null,
      failureCode: null,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    };
    prismaMock.scheduledSyncPost.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledSyncPost.findUnique.mockResolvedValue({
      ...row,
      status: SCHEDULED_SYNC_POST_STATUS.CLAIMED,
      claimToken: "claim-token-1",
      claimedAt: now,
      lastAttemptAt: now,
      attemptCount: 1,
    });

    const result = await scheduledSyncPostService.tryClaimScheduledSyncPost({
      schedule: row as any,
      now,
    });

    expect(result.claimed).toBe(true);
    expect(result.claimToken).toBe("claim-token-1");
    expect(result.reason).toBe("claimed");
    expect(result.schedule?.id).toBe(row.id);
    expect(result.schedule?.claimToken).toBe("claim-token-1");
    expect(prismaMock.scheduledSyncPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: row.id,
          status: SCHEDULED_SYNC_POST_STATUS.PENDING,
        }),
      }),
    );
  });

  it("recovers a stale claimed row after the stale claim window", async () => {
    const now = new Date("2026-06-15T23:31:00.000Z");
    const row = {
      id: "schedule-stale-1",
      guildId: "guild-1",
      channelId: "channel-1",
      createdByUserId: "user-1",
      roleId: "role-1",
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      publishAt: new Date("2026-06-15T23:30:00.000Z"),
      timezone: "America/Chicago",
      status: SCHEDULED_SYNC_POST_STATUS.CLAIMED,
      claimToken: "stale-token",
      claimedAt: new Date("2026-06-15T23:00:00.000Z"),
      publishedMessageId: null,
      publishedAt: null,
      attemptCount: 1,
      lastAttemptAt: new Date("2026-06-15T23:00:00.000Z"),
      nextAttemptAt: null,
      failureReason: null,
      failureCode: null,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    };
    prismaMock.scheduledSyncPost.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledSyncPost.findUnique.mockResolvedValue({
      ...row,
      claimToken: "claim-token-1",
      claimedAt: now,
      lastAttemptAt: now,
      attemptCount: 2,
    });

    const result = await scheduledSyncPostService.tryClaimScheduledSyncPost({
      schedule: row as any,
      now,
    });

    expect(result.claimed).toBe(true);
    expect(result.reason).toBe("stale_recovered");
    expect(result.claimToken).toBe("claim-token-1");
  });

  it("preserves the published message id when scheduling a retry", async () => {
    const nextAttemptAt = new Date("2026-06-15T23:31:00.000Z");
    prismaMock.scheduledSyncPost.findUnique.mockResolvedValue({
      id: "schedule-retry-1",
      publishedMessageId: "message-1",
      nextAttemptAt,
    });

    const result = await scheduledSyncPostService.markRetryScheduled({
      scheduleId: "schedule-retry-1",
      claimToken: "claim-token-1",
      now: new Date("2026-06-15T23:00:00.000Z"),
      failureReason: "temporary failure",
      failureCode: "retryable",
      retryAfterMs: 31_000,
    });

    expect(prismaMock.scheduledSyncPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "schedule-retry-1",
          claimToken: "claim-token-1",
          status: SCHEDULED_SYNC_POST_STATUS.CLAIMED,
        },
      }),
    );
    expect(result?.publishedMessageId).toBe("message-1");
  });

  it("marks expired schedules failed once the sync time has passed", async () => {
    prismaMock.scheduledSyncPost.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledSyncPost.findUnique.mockResolvedValue({
      id: "schedule-expired-1",
      status: SCHEDULED_SYNC_POST_STATUS.FAILED,
      failureReason: "sync_time_passed",
      failureCode: "sync_time_passed",
      publishedMessageId: null,
    });

    const result = await scheduledSyncPostService.markExpired({
      scheduleId: "schedule-expired-1",
      now: new Date("2026-06-16T02:00:00.000Z"),
    });

    expect(prismaMock.scheduledSyncPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "schedule-expired-1",
          status: {
            in: [SCHEDULED_SYNC_POST_STATUS.PENDING, SCHEDULED_SYNC_POST_STATUS.CLAIMED],
          },
        },
        data: expect.objectContaining({
          status: SCHEDULED_SYNC_POST_STATUS.FAILED,
          failureReason: "sync_time_passed",
          failureCode: "sync_time_passed",
        }),
      }),
    );
    expect(result?.status).toBe(SCHEDULED_SYNC_POST_STATUS.FAILED);
  });
});
