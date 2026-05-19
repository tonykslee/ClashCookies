import { afterEach, describe, expect, it, vi } from "vitest";

const autoRoleStart = vi.hoisted(() => vi.fn(() => ({ started: true })));
const observeLoopStart = vi.hoisted(() => vi.fn(() => new Promise<void>(() => undefined)));
const reminderStart = vi.hoisted(() => vi.fn(() => ({ started: true })));
const userActivityReminderStart = vi.hoisted(() => vi.fn(() => ({ started: true })));
const fwaFeedStart = vi.hoisted(() => vi.fn());

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
    poll: vi.fn().mockResolvedValue(undefined),
    refreshBattleDayPosts: vi.fn().mockResolvedValue(undefined),
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
  processRecruitmentCooldownReminders: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/RecruitmentReminderService", () => ({
  processDueRecruitmentReminders: vi.fn().mockResolvedValue({
    evaluated: 0,
    sent: 0,
    failed: 0,
  }),
}));

vi.mock("../src/services/WeightInputDefermentService", () => ({
  processWeightInputDefermentStages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/TrackedMessageService", () => ({
  trackedMessageService: {
    processDueExpirations: vi.fn().mockResolvedValue(undefined),
    processDueSyncReminders: vi.fn().mockResolvedValue(undefined),
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
    run: vi.fn(async (_key: string, execute: any) => execute()),
  })),
}));

vi.mock("../src/services/PollingModeService", () => ({
  isActivePollingMode: vi.fn(() => true),
  resolveMirrorSyncIntervalMsFromEnv: vi.fn(() => 60_000),
  resolveRuntimeEnvironment: vi.fn(() => "test"),
  resolvePollingMode: vi.fn(() => "active"),
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
    syncNow: vi.fn().mockResolvedValue(undefined),
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
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("continues startup while activity observe work is still pending", async () => {
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
    await expect(startupPromise).resolves.toBeUndefined();
    expect(observeLoopStart).toHaveBeenCalledTimes(1);
    expect(autoRoleStart).toHaveBeenCalledTimes(1);
    expect(fwaFeedStart).toHaveBeenCalledTimes(1);
    expect(userActivityReminderStart).toHaveBeenCalledTimes(1);
  });
});
