import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const autoRoleStart = vi.hoisted(() => vi.fn(() => ({ started: true })));
const observeLoopStart = vi.hoisted(() => vi.fn(() => new Promise<void>(() => undefined)));
const reminderStart = vi.hoisted(() => vi.fn(() => ({ started: true })));
const userActivityReminderStart = vi.hoisted(() => vi.fn(() => ({ started: true })));
const fwaFeedStart = vi.hoisted(() => vi.fn());
const statusServiceMock = vi.hoisted(() => ({
  markStarted: vi.fn(),
  markSucceeded: vi.fn(),
  markFailed: vi.fn(),
  markSkipped: vi.fn(),
  markDisabled: vi.fn(),
  listStatuses: vi.fn(),
  getStatus: vi.fn(),
}));
const recruitmentCooldownRemindersMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const recruitmentRuleRemindersMock = vi.hoisted(
  () => vi.fn().mockResolvedValue({ evaluated: 0, sent: 0, failed: 0 }),
);
const defermentRemindersMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const trackedMessageExpirationsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const trackedMessageSyncRemindersMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const warEventPollMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const warEventRefreshMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mirrorSyncMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const isActivePollingModeMock = vi.hoisted(() => vi.fn(() => true));
const resolvePollingModeMock = vi.hoisted(() => vi.fn(() => "active"));

vi.mock("../src/Commands", () => ({
  Commands: [],
}));

vi.mock("../src/services/StartupCommandRegistrationService", () => ({
  buildCommandRegistrationDebugSummary: vi.fn(() => ({
    commandCount: 0,
    rosterIncluded: false,
    rosterCreateOptionNames: [],
    rosterEditOptionNames: [],
  })),
  formatStartupLogFields: vi.fn((fields: Record<string, unknown>) =>
    Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" "),
  ),
  getCommandRegistrationConfigFromEnv: vi.fn(() => ({})),
  getStartupErrorDiagnostics: vi.fn(() => ({
    code: "none",
    name: "Error",
    message: "none",
    causeCode: "none",
    causeName: "Error",
    causeMessage: "none",
    status: undefined,
    httpStatus: undefined,
    transientReason: "none",
    stackHead: "none",
  })),
  getStartupBootstrapRetryConfigFromEnv: vi.fn(() => ({
    baseBackoffMs: 1,
    maxBackoffMs: 1,
  })),
  getStartupRetryLogSummaryEveryFromEnv: vi.fn(() => 0),
  isTransientRegistrationError: vi.fn(() => false),
  registerGuildCommandsWithRetry: vi.fn().mockResolvedValue({ status: "success" }),
  runWithTransientRetry: vi.fn(async () => {
    const me = {
      permissions: {
        has: vi.fn(() => true),
      },
    };
    return {
      status: "success",
      attempts: 1,
      value: {
        guildId: "111111111111111111",
        guild: {
          id: "111111111111111111",
          members: {
            fetch: vi.fn().mockResolvedValue(me),
          },
        },
        me,
      },
    };
  }),
  shouldEmitStartupRetrySummary: vi.fn(() => false),
}));

vi.mock("../src/services/ActivityObserveStartupService", () => ({
  startActivityObserveLoop: observeLoopStart,
}));

vi.mock("../src/services/BotPollJobStatusService", () => ({
  botPollJobStatusService: statusServiceMock,
}));

vi.mock("../src/services/ReminderSchedulerService", () => ({
  ReminderSchedulerService: vi.fn().mockImplementation(() => ({
    start: reminderStart,
  })),
}));

vi.mock("../src/services/remindme/UserActivityReminderSchedulerService", () => ({
  UserActivityReminderSchedulerService: vi.fn().mockImplementation(() => ({
    start: userActivityReminderStart,
  })),
}));

vi.mock("../src/services/AutoRoleSchedulerService", () => ({
  AutoRoleSchedulerService: vi.fn().mockImplementation(() => ({
    start: autoRoleStart,
  })),
}));

vi.mock("../src/services/SettingsService", () => ({
  SettingsService: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/services/ActivityService", () => ({
  ActivityService: vi.fn().mockImplementation(() => ({
    observeClanDetailed: vi.fn().mockResolvedValue({
      clanTag: "#CLAN",
      clanName: "Clan",
      memberTags: [],
      members: [],
    }),
  })),
}));

vi.mock("../src/services/WarEventLogService", () => ({
  WarEventLogService: vi.fn().mockImplementation(() => ({
    poll: warEventPollMock,
    refreshBattleDayPosts: warEventRefreshMock,
  })),
}));

vi.mock("../src/commands/Fwa", () => ({
  refreshAllTrackedWarMailPosts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/TelemetryIngestService", () => ({
  TelemetryIngestService: {
    getInstance: () => ({
      startAutoFlush: vi.fn(),
    }),
  },
}));

vi.mock("../src/services/telemetry/schedule", () => ({
  startTelemetryScheduleLoop: vi.fn(),
}));

vi.mock("../src/services/RecruitmentService", () => ({
  processRecruitmentCooldownReminders: recruitmentCooldownRemindersMock,
}));

vi.mock("../src/services/RecruitmentReminderService", () => ({
  processDueRecruitmentReminders: recruitmentRuleRemindersMock,
}));

vi.mock("../src/services/WeightInputDefermentService", () => ({
  processWeightInputDefermentStages: defermentRemindersMock,
}));

vi.mock("../src/services/TrackedMessageService", () => ({
  trackedMessageService: {
    processDueExpirations: trackedMessageExpirationsMock,
    processDueSyncReminders: trackedMessageSyncRemindersMock,
  },
}));

vi.mock("../src/services/HeatMapRefRebuildService", () => ({
  HeatMapRefRebuildService: vi.fn().mockImplementation(() => ({
    runScheduledRebuildCycle: vi.fn().mockResolvedValue({ status: "skipped" }),
  })),
}));

vi.mock("../src/services/TodoSnapshotService", () => ({
  todoSnapshotService: {
    refreshActivatedTodoLinkedPlayerSnapshots: vi.fn().mockResolvedValue({
      activatedUserCount: 0,
      selectedPlayerCount: 0,
      trackedPlayerCount: 0,
      nonTrackedPlayerCount: 0,
      skippedNeverUsedUserCount: 0,
    }),
  },
}));

vi.mock("../src/services/CwlStateService", () => ({
  cwlStateService: {
    refreshTrackedCwlState: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/services/UnlinkedMemberAlertService", () => ({
  unlinkedMemberAlertService: {
    reconcileGuildAlerts: vi.fn().mockResolvedValue({
      unresolvedCount: 0,
      resolvedCount: 0,
      alertedCount: 0,
    }),
  },
}));

vi.mock("../src/services/CoCQueueContext", () => ({
  runWithCoCQueueContext: vi.fn(async (_context: any, execute: any) => execute()),
}));

vi.mock("../src/services/CoCRequestQueueService", () => ({
  cocRequestQueueService: {
    getStatus: vi.fn(() => ({
      degraded: false,
      spacingMs: 0,
      penaltyMs: 0,
      queueDepth: 0,
      interactiveQueueDepth: 0,
      backgroundQueueDepth: 0,
      inFlight: 0,
    })),
  },
  isCoCQueueSkippedError: vi.fn(() => false),
}));

vi.mock("../src/services/PollCycleGuardService", () => ({
  PollCycleGuardService: vi.fn().mockImplementation(() => ({
    run: vi.fn(async (_key: string, execute: any) => ({
      ran: true,
      value: await execute(),
    })),
  })),
}));

vi.mock("../src/services/PollingModeService", () => ({
  isActivePollingMode: isActivePollingModeMock,
  resolveMirrorSyncIntervalMsFromEnv: vi.fn(() => 60_000),
  resolveRuntimeEnvironment: vi.fn(() => "test"),
  resolvePollingMode: resolvePollingModeMock,
}));

vi.mock("../src/services/WarEventPollScheduleService", () => ({
  resolveWarEventPollIntervalMsFromEnv: vi.fn(() => 60_000),
}));

vi.mock("../src/services/fwa-feeds/FwaFeedSchedulerService", () => ({
  FwaFeedSchedulerService: vi.fn().mockImplementation(() => ({
    start: fwaFeedStart,
  })),
}));

vi.mock("../src/services/MirrorSyncService", () => ({
  MirrorSyncService: vi.fn().mockImplementation(() => ({
    syncNow: mirrorSyncMock,
  })),
}));

vi.mock("../src/services/PlayerLinkService", () => ({
  backfillMissingDiscordUsernamesForClanMembers: vi.fn().mockResolvedValue({
    candidateLinks: 0,
    uniqueUsers: 0,
    resolvedUsers: 0,
    updatedLinks: 0,
  }),
}));

vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    trackedClan: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("../src/helper/formatError", () => ({
  formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import ready from "../src/listeners/ready";

describe("ready listener startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isActivePollingModeMock.mockReturnValue(true);
    resolvePollingModeMock.mockReturnValue("active");
    statusServiceMock.markStarted.mockResolvedValue({});
    statusServiceMock.markSucceeded.mockResolvedValue({});
    statusServiceMock.markFailed.mockResolvedValue({});
    statusServiceMock.markSkipped.mockResolvedValue({});
    statusServiceMock.markDisabled.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function startStartup() {
    let capturedReadyHandler: (() => Promise<void>) | undefined;
    const client = {
      once: vi.fn((event: string, handler: () => Promise<void>) => {
        if (event === "ready") {
          capturedReadyHandler = handler;
        }
      }),
      application: {
        fetch: vi.fn().mockResolvedValue(undefined),
        emojis: {
          fetch: vi.fn(),
        },
      },
      guilds: {
        fetch: vi.fn(),
      },
      user: {
        id: "bot-user",
        username: "ClashCookies",
      },
      users: {
        cache: new Map(),
        fetch: vi.fn(),
      },
    } as any;

    ready(client, {} as any);
    expect(capturedReadyHandler).toBeTypeOf("function");
    const startupPromise = capturedReadyHandler!();
    return { client, startupPromise };
  }

  async function runStartup() {
    const { client, startupPromise } = await startStartup();
    await expect(startupPromise).resolves.toBeUndefined();
    return { client };
  }

  it("continues startup while activity observe work is still pending", async () => {
    await runStartup();
    expect(observeLoopStart).toHaveBeenCalledTimes(1);
    expect(autoRoleStart).toHaveBeenCalledTimes(1);
    expect(fwaFeedStart).toHaveBeenCalledTimes(1);
    expect(userActivityReminderStart).toHaveBeenCalledTimes(1);
    expect(statusServiceMock.markStarted).toHaveBeenCalledWith(
      "recruitment_cooldown_reminders",
      expect.objectContaining({
        displayName: "Recruitment cooldown reminders",
      }),
    );
    expect(statusServiceMock.markSucceeded).toHaveBeenCalledWith(
      "recruitment_rule_reminders",
      expect.objectContaining({
        displayName: "Recruitment rule reminders",
        metadata: expect.objectContaining({
          evaluated: 0,
          sent: 0,
          failed: 0,
        }),
      }),
    );
    expect(statusServiceMock.markStarted).toHaveBeenCalledWith(
      "tracked_message_sweep",
      expect.objectContaining({
        displayName: "Tracked message sweep",
      }),
    );
    expect(statusServiceMock.markSucceeded).toHaveBeenCalledWith(
      "tracked_message_sweep",
      expect.objectContaining({
        displayName: "Tracked message sweep",
      }),
    );
  });

  it("records tracked message sweep and war event poll failures without throwing", async () => {
    trackedMessageExpirationsMock.mockRejectedValueOnce(new Error("tracked sweep boom"));
    warEventPollMock.mockRejectedValueOnce(new Error("war boom"));

    await runStartup();

    expect(statusServiceMock.markFailed).toHaveBeenCalledWith(
      "tracked_message_sweep",
      expect.any(Error),
      expect.objectContaining({
        displayName: "Tracked message sweep",
      }),
    );
    expect(statusServiceMock.markFailed).toHaveBeenCalledWith(
      "war_event_poll_cycle",
      expect.any(Error),
      expect.objectContaining({
        displayName: "War event poll",
      }),
    );
  });

  it("marks active-only poll jobs disabled in mirror mode", async () => {
    isActivePollingModeMock.mockReturnValue(false);
    resolvePollingModeMock.mockReturnValue("mirror");

    await runStartup();

    const disabledJobKeys = statusServiceMock.markDisabled.mock.calls.map((call) => call[0]);
    expect(disabledJobKeys).toEqual(
      expect.arrayContaining([
        "war_event_poll_cycle",
        "fwa_feed_scheduler",
        "user_activity_reminder_scheduler",
      ]),
    );
    expect(statusServiceMock.markDisabled).toHaveBeenCalledWith(
      "war_event_poll_cycle",
      expect.objectContaining({
        displayName: "War event poll",
      }),
    );
    expect(statusServiceMock.markDisabled).toHaveBeenCalledWith(
      "fwa_feed_scheduler",
      expect.objectContaining({
        displayName: "FWA feed scheduler",
      }),
    );
    expect(statusServiceMock.markDisabled).toHaveBeenCalledWith(
      "user_activity_reminder_scheduler",
      expect.objectContaining({
        displayName: "User activity reminder scheduler",
      }),
    );
  });

  it("keeps startup working when a poll-status write fails", async () => {
    statusServiceMock.markStarted.mockRejectedValueOnce(new Error("status down"));

    await runStartup();

    expect(observeLoopStart).toHaveBeenCalledTimes(1);
    expect(autoRoleStart).toHaveBeenCalledTimes(1);
  });

  it("starts autorole before a hung war poll can block startup", async () => {
    warEventPollMock.mockImplementationOnce(() => new Promise<void>(() => undefined));

    const { startupPromise } = await startStartup();
    let settled = false;
    startupPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    for (let index = 0; index < 10 && observeLoopStart.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (let index = 0; index < 10 && autoRoleStart.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(observeLoopStart).toHaveBeenCalledTimes(1);
    expect(autoRoleStart).toHaveBeenCalledTimes(1);
    expect(warEventPollMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });
});
