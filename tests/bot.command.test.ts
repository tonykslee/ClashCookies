import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bot, buildBotPollStatusEmbeds } from "../src/commands/Bot";

const listStatusesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/BotPollJobStatusService", () => ({
  botPollJobStatusService: {
    markStarted: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    markSkipped: vi.fn(),
    markDisabled: vi.fn(),
    listStatuses: listStatusesMock,
    getStatus: vi.fn(),
  },
}));

function createInteraction(input: { isAdmin?: boolean; inGuild?: boolean } = {}) {
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
      getSubcommandGroup: vi.fn().mockReturnValue("poll"),
      getSubcommand: vi.fn().mockReturnValue("status"),
    },
    reply,
    deferReply,
    editReply,
  };
}

describe("/bot poll status behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listStatusesMock.mockResolvedValue([]);
  });

  it("denies non-admin users", async () => {
    const interaction = createInteraction({ isAdmin: false });

    await Bot.run({} as any, interaction as any, {} as any);

    expect(listStatusesMock).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "You do not have permission to use /bot.",
    });
  });

  it("requires a guild context", async () => {
    const interaction = createInteraction({ inGuild: false });

    await Bot.run({} as any, interaction as any, {} as any);

    expect(listStatusesMock).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
  });

  it("loads job rows and renders status embeds", async () => {
    const interaction = createInteraction({ isAdmin: true });
    listStatusesMock.mockResolvedValue([
      {
        jobKey: "autorole_scheduler",
        displayName: "Autorole scheduler",
        enabled: true,
        status: "running",
        intervalMs: 5 * 60 * 1000,
        lastStartedAt: new Date("2026-05-19T11:40:00.000Z"),
        lastFinishedAt: null,
        nextDueAt: new Date("2026-05-19T11:45:00.000Z"),
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
        runCount: 5,
        failureCount: 0,
        metadata: { trigger: "startup" },
        updatedAt: new Date("2026-05-19T11:45:00.000Z"),
      },
      {
        jobKey: "activity_observe_cycle",
        displayName: "Activity observe",
        enabled: true,
        status: "failed",
        intervalMs: 1_800_000,
        lastStartedAt: new Date("2026-05-19T11:00:00.000Z"),
        lastFinishedAt: new Date("2026-05-19T11:05:00.000Z"),
        nextDueAt: new Date("2026-05-19T11:30:00.000Z"),
        lastSuccessAt: null,
        lastErrorAt: new Date("2026-05-19T11:05:00.000Z"),
        lastError: "observe boom",
        runCount: 3,
        failureCount: 1,
        metadata: { trigger: "scheduled" },
        updatedAt: new Date("2026-05-19T11:05:00.000Z"),
      },
    ]);

    await Bot.run({} as any, interaction as any, {} as any);

    expect(listStatusesMock).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(payload.embeds).toBeTruthy();
    const rendered = payload.embeds.map((embed: any) => embed.toJSON());
    const text = rendered
      .flatMap((embed: any) => [
        embed.title,
        embed.description,
        ...(embed.fields ?? []).flatMap((field: any) => [field.name, field.value]),
      ])
      .join("\n");
    expect(text).toContain("Bot poll status");
    expect(text).toContain("Autorole scheduler");
    expect(text).toContain("Activity observe");
    expect(text).toContain("Status:");
    expect(text).toContain("Last error: observe boom");
    expect(text).toContain("Note: trigger=startup");
    expect(text).toContain("Warning: stuck/overdue");
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
