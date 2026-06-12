import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reportServiceMock = vi.hoisted(() => ({
  buildReport: vi.fn(),
}));

vi.mock("../src/services/RepWorkReportService", () => ({
  repWorkReportService: {
    buildReport: reportServiceMock.buildReport,
  },
  parseRepWorkDuration: vi.fn((input: string) => {
    const normalized = String(input ?? "").trim().toLowerCase();
    if (normalized === "7d") return { amount: 7, unit: "d", days: 7, label: "7d" };
    return null;
  }),
  buildRepWorkReportEmbed: vi.fn((report: any, options?: { displayNameByUserId?: Map<string, string> }) => {
    const userId = String(report?.users?.[0]?.discordUserId ?? "111111111111111111");
    const fieldName = options?.displayNameByUserId?.get(userId) ?? userId;
    return {
      toJSON: () => ({
        title: "Rep Work Stats",
        fields: [
          {
            name: fieldName,
            value: "Bases: 1 (avg n/a)\nSyncs: 1 participated | 1 clan claims\nMails: 0 (avg n/a)\nTop cmds: none",
          },
        ],
        footer: { text: "Since 7d | Showing 1 users" },
        description: "Window: <t:0:f> -> <t:1:f>",
        report,
      }),
    };
  }),
}));

import { RepWork } from "../src/commands/RepWork";

describe("/repwork command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportServiceMock.buildReport.mockReset();
  });

  it("registers since and visibility options", () => {
    expect(RepWork.options?.[0]?.name).toBe("since");
    expect(RepWork.options?.[0]?.type).toBe(ApplicationCommandOptionType.String);
    expect(RepWork.options?.[0]?.required).toBe(true);

    const visibility = RepWork.options?.find((option) => option.name === "visibility");
    expect(visibility?.type).toBe(ApplicationCommandOptionType.String);
    expect(visibility?.required).toBe(false);
  });

  it("renders a report embed for a valid window", async () => {
    reportServiceMock.buildReport.mockResolvedValue({
      guildId: "guild-1",
      start: new Date("2026-06-03T12:00:00.000Z"),
      end: new Date("2026-06-10T12:00:00.000Z"),
      duration: { amount: 7, unit: "d", days: 7, label: "7d" },
      totalUsers: 1,
      visibleUsers: 1,
      limit: 15,
      users: [
        {
          discordUserId: "111111111111111111",
          basesChecked: 1,
          basesAvgPrepTimeLeftSeconds: null,
          syncsParticipated: 1,
          clanClaims: 1,
          mailsChecked: 0,
          mailsAvgPrepTimeLeftSeconds: null,
          topCommands: [],
        },
      ],
    });

    const fetchMember = vi.fn().mockResolvedValue({
      displayName: "Server Display",
      user: {
        globalName: "Global Name",
        username: "username",
      },
    });

    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      guildId: "guild-1",
      guild: {
        members: {
          fetch: fetchMember,
        },
      },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "since") return "7d";
          if (name === "visibility") return "private";
          return null;
        }),
      },
      deferReply,
      editReply,
      reply,
    } as any;

    await RepWork.run({} as any, interaction, {} as any);

    expect(deferReply).toHaveBeenCalled();
    expect(reportServiceMock.buildReport).toHaveBeenCalledWith({
      guildId: "guild-1",
      since: "7d",
    });
    expect(fetchMember).toHaveBeenCalledWith("111111111111111111");
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        allowedMentions: { parse: [] },
      }),
    );
    const embed = (editReply.mock.calls[0]?.[0]?.embeds?.[0] as any)?.toJSON?.();
    expect(embed?.fields?.[0]?.name).toBe("Server Display");
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        allowedMentions: { parse: [] },
      }),
    );
    expect(reply).not.toHaveBeenCalled();
  });

  it("falls back to the raw user id when a guild member cannot be fetched", async () => {
    reportServiceMock.buildReport.mockResolvedValue({
      guildId: "guild-1",
      start: new Date("2026-06-03T12:00:00.000Z"),
      end: new Date("2026-06-10T12:00:00.000Z"),
      duration: { amount: 7, unit: "d", days: 7, label: "7d" },
      totalUsers: 1,
      visibleUsers: 1,
      limit: 15,
      users: [
        {
          discordUserId: "111111111111111111",
          basesChecked: 1,
          basesAvgPrepTimeLeftSeconds: null,
          syncsParticipated: 1,
          clanClaims: 1,
          mailsChecked: 0,
          mailsAvgPrepTimeLeftSeconds: null,
          topCommands: [],
        },
      ],
    });

    const fetchMember = vi.fn().mockRejectedValue(new Error("missing member"));
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      guildId: "guild-1",
      guild: {
        members: {
          fetch: fetchMember,
        },
      },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "since") return "7d";
          return null;
        }),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await RepWork.run({} as any, interaction, {} as any);

    expect(fetchMember).toHaveBeenCalledWith("111111111111111111");
    const embed = (editReply.mock.calls[0]?.[0]?.embeds?.[0] as any)?.toJSON?.();
    expect(embed?.fields?.[0]?.name).toBe("111111111111111111");
  });

  it("rejects invalid durations with a clear error", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      guildId: "guild-1",
      options: {
        getString: vi.fn((name: string) => {
          if (name === "since") return "7days";
          if (name === "visibility") return "private";
          return null;
        }),
      },
      reply,
      deferReply: vi.fn(),
      editReply: vi.fn(),
    } as any;

    await RepWork.run({} as any, interaction, {} as any);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Use a duration like 7d, 4w, or 2mo.",
      }),
    );
    expect(reportServiceMock.buildReport).not.toHaveBeenCalled();
  });
});
