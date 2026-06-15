import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "discord.js";
import {
  ScheduledSyncPostSchedulerService,
  SCHEDULED_SYNC_POST_SCHEDULER_DISPLAY_NAME,
  SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY,
} from "../src/services/ScheduledSyncPostSchedulerService";
import {
  scheduledSyncPostService,
  SCHEDULED_SYNC_POST_STATUS,
} from "../src/services/ScheduledSyncPostService";
import {
  scheduledSyncReadinessPublisherService,
  SyncTimePostPublishError,
} from "../src/services/SyncTimePostPublisherService";

const mirrorModeMock = vi.hoisted(() => vi.fn(() => false));
const dozzleLogMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../src/services/PollingModeService", () => ({
  isMirrorPollingMode: mirrorModeMock,
}));

vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: dozzleLogMock,
  dozzleConsoleSink: {
    write: vi.fn(),
  },
}));

function makeChannel() {
  return {
    id: "channel-1",
    isTextBased: () => true,
    permissionsFor: vi.fn().mockReturnValue({
      has: vi.fn().mockReturnValue(true),
    }),
    messages: {
      fetch: vi.fn(),
      fetchPinned: vi.fn().mockResolvedValue(new Map()),
    },
    send: vi.fn(),
  };
}

describe("ScheduledSyncPostSchedulerService", () => {
  let statusService: {
    markStarted: ReturnType<typeof vi.fn>;
    markSucceeded: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
    markSkipped: ReturnType<typeof vi.fn>;
    markDisabled: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mirrorModeMock.mockReturnValue(false);
    statusService = {
      markStarted: vi.fn().mockResolvedValue(undefined),
      markSucceeded: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      markSkipped: vi.fn().mockResolvedValue(undefined),
      markDisabled: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not start in mirror mode", () => {
    mirrorModeMock.mockReturnValue(true);
    const scheduler = new ScheduledSyncPostSchedulerService({} as Client, 15_000, statusService as any);

    const result = scheduler.start();

    expect(result).toEqual({ started: false, reason: "mirror" });
    expect(statusService.markDisabled).toHaveBeenCalledWith(
      SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY,
      expect.objectContaining({
        displayName: SCHEDULED_SYNC_POST_SCHEDULER_DISPLAY_NAME,
      }),
    );
  });

  it("claims and publishes one due schedule", async () => {
    const scheduler = new ScheduledSyncPostSchedulerService(
      {
        user: { id: "bot-1" },
        guilds: {
          fetch: vi.fn().mockResolvedValue({
            id: "guild-1",
            channels: {
              fetch: vi.fn().mockResolvedValue(makeChannel()),
            },
          }),
        },
      } as any,
      15_000,
      statusService as any,
    );

    const dueRow = {
      id: "schedule-1",
      guildId: "guild-1",
      channelId: "channel-1",
      roleId: "role-1",
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      publishAt: new Date("2026-06-15T23:30:00.000Z"),
      createdByUserId: "user-1",
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
    const claimedRow = {
      ...dueRow,
      status: SCHEDULED_SYNC_POST_STATUS.CLAIMED,
      claimToken: "claim-token-1",
      claimedAt: new Date("2026-06-15T23:00:00.000Z"),
      lastAttemptAt: new Date("2026-06-15T23:00:00.000Z"),
      attemptCount: 1,
    };
    const publisherSpy = vi
      .spyOn(scheduledSyncReadinessPublisherService, "publishScheduledSyncReadinessPost")
      .mockResolvedValue({
        messageId: "message-1",
        channelId: "channel-1",
        trackedClanCount: 2,
        sentNewMessage: true,
        usedFallbackRender: false,
        publicationMode: "scheduled",
      });
    const serviceSpy = vi
      .spyOn(scheduledSyncPostService, "findExpiredScheduledSyncPosts")
      .mockResolvedValue([]);
    const dueSpy = vi
      .spyOn(scheduledSyncPostService, "findDueScheduledSyncPosts")
      .mockResolvedValue([dueRow as any]);
    const claimSpy = vi
      .spyOn(scheduledSyncPostService, "tryClaimScheduledSyncPost")
      .mockResolvedValue({
        claimed: true,
        claimToken: "claim-token-1",
        reason: "claimed",
        schedule: claimedRow as any,
      });
    const counts = await scheduler.runCycle(new Date("2026-06-15T23:00:00.000Z").getTime());

    expect(serviceSpy).toHaveBeenCalledTimes(1);
    expect(dueSpy).toHaveBeenCalledTimes(1);
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(publisherSpy).toHaveBeenCalledTimes(1);
    expect(counts.published).toBe(1);
  });

  it("retries a retryable publish failure", async () => {
    const scheduler = new ScheduledSyncPostSchedulerService(
      {
        user: { id: "bot-1" },
        guilds: {
          fetch: vi.fn().mockResolvedValue({
            id: "guild-1",
            channels: {
              fetch: vi.fn().mockResolvedValue(makeChannel()),
            },
          }),
        },
      } as any,
      15_000,
      statusService as any,
    );

    const dueRow = {
      id: "schedule-1",
      guildId: "guild-1",
      channelId: "channel-1",
      roleId: "role-1",
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      publishAt: new Date("2026-06-15T23:30:00.000Z"),
      createdByUserId: "user-1",
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

    vi.spyOn(scheduledSyncPostService, "findExpiredScheduledSyncPosts").mockResolvedValue([]);
    vi.spyOn(scheduledSyncPostService, "findDueScheduledSyncPosts").mockResolvedValue([dueRow as any]);
    vi.spyOn(scheduledSyncPostService, "tryClaimScheduledSyncPost").mockResolvedValue({
      claimed: true,
      claimToken: "claim-token-1",
      reason: "claimed",
      schedule: {
        ...dueRow,
        status: SCHEDULED_SYNC_POST_STATUS.CLAIMED,
        claimToken: "claim-token-1",
        claimedAt: new Date("2026-06-15T23:00:00.000Z"),
        lastAttemptAt: new Date("2026-06-15T23:00:00.000Z"),
        attemptCount: 1,
      } as any,
    });
    const retrySpy = vi.spyOn(scheduledSyncPostService, "markRetryScheduled").mockResolvedValue({
      ...dueRow,
      status: SCHEDULED_SYNC_POST_STATUS.PENDING,
    } as any);
    const failedSpy = vi.spyOn(scheduledSyncPostService, "markFailed").mockResolvedValue(null);
    vi.spyOn(scheduledSyncReadinessPublisherService, "publishScheduledSyncReadinessPost").mockRejectedValue(
      new SyncTimePostPublishError("temporary", "temporary", true),
    );

    const counts = await scheduler.runCycle(new Date("2026-06-15T23:00:00.000Z").getTime());

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(failedSpy).not.toHaveBeenCalled();
    expect(counts.retried).toBe(1);
  });

  it("marks terminal publish failures failed", async () => {
    const scheduler = new ScheduledSyncPostSchedulerService(
      {
        user: { id: "bot-1" },
        guilds: {
          fetch: vi.fn().mockResolvedValue({
            id: "guild-1",
            channels: {
              fetch: vi.fn().mockResolvedValue(makeChannel()),
            },
          }),
        },
      } as any,
      15_000,
      statusService as any,
    );

    const dueRow = {
      id: "schedule-1",
      guildId: "guild-1",
      channelId: "channel-1",
      roleId: "role-1",
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      publishAt: new Date("2026-06-15T23:30:00.000Z"),
      createdByUserId: "user-1",
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

    vi.spyOn(scheduledSyncPostService, "findExpiredScheduledSyncPosts").mockResolvedValue([]);
    vi.spyOn(scheduledSyncPostService, "findDueScheduledSyncPosts").mockResolvedValue([dueRow as any]);
    vi.spyOn(scheduledSyncPostService, "tryClaimScheduledSyncPost").mockResolvedValue({
      claimed: true,
      claimToken: "claim-token-1",
      reason: "claimed",
      schedule: {
        ...dueRow,
        status: SCHEDULED_SYNC_POST_STATUS.CLAIMED,
        claimToken: "claim-token-1",
        claimedAt: new Date("2026-06-15T23:00:00.000Z"),
        lastAttemptAt: new Date("2026-06-15T23:00:00.000Z"),
        attemptCount: 1,
      } as any,
    });
    const failedSpy = vi.spyOn(scheduledSyncPostService, "markFailed").mockResolvedValue(null);
    vi.spyOn(scheduledSyncReadinessPublisherService, "publishScheduledSyncReadinessPost").mockRejectedValue(
      new SyncTimePostPublishError("terminal", "terminal", false),
    );

    const counts = await scheduler.runCycle(new Date("2026-06-15T23:00:00.000Z").getTime());

    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(counts.failed).toBe(1);
  });
});
