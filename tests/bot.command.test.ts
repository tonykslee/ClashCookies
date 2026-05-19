import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bot, buildBotPollStatusEmbeds } from "../src/commands/Bot";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $queryRawUnsafe: vi.fn(),
}));

const listStatusesMock = vi.hoisted(() => vi.fn());
const getStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/BotPollJobStatusService", () => ({
  botPollJobStatusService: {
    markStarted: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    markSkipped: vi.fn(),
    markDisabled: vi.fn(),
    listStatuses: listStatusesMock,
    getStatus: getStatusMock,
  },
}));

function createInteraction(input: {
  isAdmin?: boolean;
  inGuild?: boolean;
  group?: string | null;
  sub?: string;
  job?: string | null;
} = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    inGuild: vi.fn().mockReturnValue(input.inGuild ?? true),
    guildId: "111111111111111111",
    memberPermissions: {
      has: vi.fn().mockReturnValue(input.isAdmin ?? true),
    },
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(input.group ?? null),
      getSubcommand: vi.fn().mockReturnValue(input.sub ?? "status"),
      getString: vi.fn().mockImplementation((name: string) => {
        if (name === "job") {
          return input.job ?? null;
        }
        return null;
      }),
    },
    reply,
    deferReply,
    editReply,
  };
}

function createClient(isReady = true) {
  return {
    isReady: vi.fn().mockReturnValue(isReady),
  } as any;
}

function flattenEmbedText(payload: any): string {
  const rendered = (payload.embeds ?? []).map((embed: any) => embed.toJSON());
  return rendered
    .flatMap((embed: any) => [
      embed.title,
      embed.description,
      ...(embed.fields ?? []).flatMap((field: any) => [field.name, field.value]),
    ])
    .filter(Boolean)
    .join("\n");
}

describe("/bot status behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
    vi.clearAllMocks();
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ "?column?": 1 }]);
    listStatusesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("denies non-admin users", async () => {
    const interaction = createInteraction({ isAdmin: false, group: null, sub: "status" });

    await Bot.run(createClient(), interaction as any, {} as any);

    expect(listStatusesMock).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "You do not have permission to use /bot.",
    });
  });

  it("renders a healthy overview", async () => {
    const interaction = createInteraction({ group: null, sub: "status" });
    listStatusesMock.mockResolvedValue([
      {
        jobKey: "autorole_scheduler",
        displayName: "Autorole scheduler",
        enabled: true,
        status: "idle",
        intervalMs: 3_600_000,
        lastStartedAt: new Date("2026-05-19T11:00:00.000Z"),
        lastFinishedAt: new Date("2026-05-19T11:01:00.000Z"),
        nextDueAt: new Date("2026-05-19T12:30:00.000Z"),
        lastSuccessAt: new Date("2026-05-19T11:01:00.000Z"),
        lastErrorAt: null,
        lastError: null,
        runCount: 3,
        failureCount: 0,
        metadata: null,
        updatedAt: new Date("2026-05-19T11:01:00.000Z"),
      },
    ]);

    await Bot.run(createClient(), interaction as any, {} as any);

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(listStatusesMock).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const text = flattenEmbedText(payload);
    expect(text).toContain("Bot status");
    expect(text).toContain("Overall: 🟢 healthy");
    expect(text).toContain("Runtime");
    expect(text).toContain("Health");
    expect(text).toContain("Poll jobs summary");
    expect(text).toContain("Warnings");
    expect(text).toContain("No poll job warnings");
    expect(text).toContain("Polling mode:");
    expect(text).toContain("Database: 🟢 reachable");
    expect(text).toContain("Discord: 🟢 ready");
  });

  it("marks failed poll jobs as warnings in the overview", async () => {
    const interaction = createInteraction({ group: null, sub: "status" });
    listStatusesMock.mockResolvedValue([
      {
        jobKey: "war_event_poll_cycle",
        displayName: "War event poll",
        enabled: true,
        status: "failed",
        intervalMs: 60_000,
        lastStartedAt: new Date("2026-05-19T11:00:00.000Z"),
        lastFinishedAt: new Date("2026-05-19T11:05:00.000Z"),
        nextDueAt: new Date("2026-05-19T11:06:00.000Z"),
        lastSuccessAt: null,
        lastErrorAt: new Date("2026-05-19T11:05:00.000Z"),
        lastError: "war boom",
        runCount: 2,
        failureCount: 1,
        metadata: { trigger: "startup" },
        updatedAt: new Date("2026-05-19T11:05:00.000Z"),
      },
    ]);

    await Bot.run(createClient(), interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const text = flattenEmbedText(payload);
    expect(text).toContain("Overall: 🔴 unhealthy");
    expect(text).toContain("War event poll");
    expect(text).toContain("failed");
    expect(text).toContain("last error: war boom");
    expect(text).toContain("trigger=startup");
  });

  it("lists overdue running poll jobs in warnings", async () => {
    const interaction = createInteraction({ group: null, sub: "status" });
    listStatusesMock.mockResolvedValue([
      {
        jobKey: "activity_observe_cycle",
        displayName: "Activity observe",
        enabled: true,
        status: "running",
        intervalMs: 1_800_000,
        lastStartedAt: new Date("2026-05-19T09:00:00.000Z"),
        lastFinishedAt: null,
        nextDueAt: new Date("2026-05-19T09:30:00.000Z"),
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
        runCount: 1,
        failureCount: 0,
        metadata: { trigger: "scheduled" },
        updatedAt: new Date("2026-05-19T09:00:00.000Z"),
      },
    ]);

    await Bot.run(createClient(), interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const text = flattenEmbedText(payload);
    expect(text).toContain("Overall: 🟡 warning");
    expect(text).toContain("Activity observe");
    expect(text).toContain("overdue");
    expect(text).toContain("trigger=scheduled");
  });
});

describe("/bot poll status behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    listStatusesMock.mockResolvedValue([]);
  });

  it("keeps the detailed poll dashboard available", async () => {
    const interaction = createInteraction({ group: "poll", sub: "status" });
    listStatusesMock.mockResolvedValue([
      {
        jobKey: "autorole_scheduler",
        displayName: "Autorole scheduler",
        enabled: true,
        status: "running",
        intervalMs: 60_000,
        lastStartedAt: new Date("2026-05-19T11:59:00.000Z"),
        lastFinishedAt: null,
        nextDueAt: new Date("2026-05-19T12:00:00.000Z"),
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
        runCount: 1,
        failureCount: 0,
        metadata: { trigger: "startup" },
        updatedAt: new Date("2026-05-19T11:59:00.000Z"),
      },
    ]);

    await Bot.run(createClient(), interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const text = flattenEmbedText(payload);
    expect(text).toContain("Bot poll status");
    expect(text).toContain("Autorole scheduler");
    expect(text).toContain("Status:");
    expect(text).toContain("Note: trigger=startup");
  });

  it("returns no autocomplete choices when poll job rows cannot be loaded", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    listStatusesMock.mockRejectedValueOnce(new Error("boom"));
    const respond = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      options: {
        getSubcommandGroup: vi.fn().mockReturnValue("poll"),
        getSubcommand: vi.fn().mockReturnValue("status"),
        getFocused: vi.fn().mockReturnValue({ name: "job", value: "auto" }),
      },
      respond,
    } as any;

    await Bot.autocomplete(interaction);

    expect(respond).toHaveBeenCalledWith([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[bot poll status autocomplete] failed to load status rows:"),
    );
    warnSpy.mockRestore();
  });

  it("renders one job in detail when a job key is provided", async () => {
    const interaction = createInteraction({
      group: "poll",
      sub: "status",
      job: "autorole_scheduler",
    });
    getStatusMock.mockResolvedValue({
      jobKey: "autorole_scheduler",
      displayName: "Autorole scheduler",
      enabled: true,
      status: "running",
      intervalMs: 3_600_000,
      lastStartedAt: new Date("2026-05-19T11:00:00.000Z"),
      lastFinishedAt: null,
      nextDueAt: new Date("2026-05-19T12:30:00.000Z"),
      lastSuccessAt: new Date("2026-05-19T11:00:00.000Z"),
      lastErrorAt: null,
      lastError: null,
      runCount: 42,
      failureCount: 3,
      metadata: { trigger: "startup", nested: { label: "x".repeat(2000) } },
      updatedAt: new Date("2026-05-19T11:00:00.000Z"),
    });

    await Bot.run(createClient(), interaction as any, {} as any);

    expect(getStatusMock).toHaveBeenCalledWith("autorole_scheduler");
    expect(listStatusesMock).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const text = flattenEmbedText(payload);
    expect(text).toContain("Bot poll job: Autorole scheduler");
    expect(text).toContain("Status");
    expect(text).toContain("Enabled: yes");
    expect(text).toContain("Schedule");
    expect(text).toContain("Counts");
    expect(text).toContain("Metadata");
    expect(text).toContain('"trigger": "startup"');
    expect(text).toContain("...[len=");
  });

  it("returns a helpful not-found response for unknown jobs", async () => {
    const interaction = createInteraction({
      group: "poll",
      sub: "status",
      job: "unknown_job",
    });
    getStatusMock.mockResolvedValue(null);

    await Bot.run(createClient(), interaction as any, {} as any);

    expect(getStatusMock).toHaveBeenCalledWith("unknown_job");
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "No poll job found for `unknown_job`.",
    });
  });

  it("shows last error details for failed jobs", async () => {
    const interaction = createInteraction({
      group: "poll",
      sub: "status",
      job: "war_event_poll_cycle",
    });
    getStatusMock.mockResolvedValue({
      jobKey: "war_event_poll_cycle",
      displayName: "War event poll",
      enabled: true,
      status: "failed",
      intervalMs: 60_000,
      lastStartedAt: new Date("2026-05-19T11:00:00.000Z"),
      lastFinishedAt: new Date("2026-05-19T11:01:00.000Z"),
      nextDueAt: new Date("2026-05-19T11:02:00.000Z"),
      lastSuccessAt: null,
      lastErrorAt: new Date("2026-05-19T11:01:00.000Z"),
      lastError: "Very bad poll error",
      runCount: 9,
      failureCount: 2,
      metadata: { reason: "timeout" },
      updatedAt: new Date("2026-05-19T11:01:00.000Z"),
    });

    await Bot.run(createClient(), interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const text = flattenEmbedText(payload);
    expect(text).toContain("Last error");
    expect(text).toContain("Very bad poll error");
    expect(text).toContain("reason");
  });
});

describe("bot poll status renderer", () => {
  it("shows the empty state when no job rows exist", () => {
    const embeds = buildBotPollStatusEmbeds([]);
    const json = embeds[0]?.toJSON() as any;
    expect(json.title).toBe("Bot poll status");
    expect(String(json.description ?? "")).toContain("No poll jobs have reported yet");
  });
});
