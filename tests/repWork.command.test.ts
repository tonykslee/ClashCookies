import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reportServiceMock = vi.hoisted(() => ({
  buildReport: vi.fn(),
}));

const badgeResolverMock = vi.hoisted(() => ({
  resolveRepWorkRenderedClanBadgesByUserId: vi.fn(),
}));

vi.mock("../src/services/RepWorkReportService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/RepWorkReportService")>(
    "../src/services/RepWorkReportService",
  );
  return {
    ...actual,
    repWorkReportService: {
      buildReport: reportServiceMock.buildReport,
    },
    parseRepWorkDuration: vi.fn((input: string) => {
      const normalized = String(input ?? "").trim().toLowerCase();
      if (normalized === "7d") return { amount: 7, unit: "d", days: 7, label: "7d" };
      return null;
    }),
  };
});

vi.mock("../src/services/RepWorkBadgeService", () => ({
  resolveRepWorkRenderedClanBadgesByUserId: badgeResolverMock.resolveRepWorkRenderedClanBadgesByUserId,
}));

import { RepWork } from "../src/commands/RepWork";

describe("/repwork command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportServiceMock.buildReport.mockReset();
    badgeResolverMock.resolveRepWorkRenderedClanBadgesByUserId.mockReset();
  });

  it("registers since and visibility options", () => {
    expect(RepWork.options?.[0]?.name).toBe("since");
    expect(RepWork.options?.[0]?.type).toBe(ApplicationCommandOptionType.String);
    expect(RepWork.options?.[0]?.required).toBe(true);

    const visibility = RepWork.options?.find((option) => option.name === "visibility");
    expect(visibility?.type).toBe(ApplicationCommandOptionType.String);
    expect(visibility?.required).toBe(false);
  });

  it("renders user mentions in the field value and keeps the field header non-mention text", async () => {
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
          mailsChecked: 2,
          mailsCheckedAvgPrepTimeLeftSeconds: 3600,
          mailsSent: 3,
          mailsSentAvgPrepTimeLeftSeconds: 1800,
          topCommands: [],
        },
      ],
    });
    badgeResolverMock.resolveRepWorkRenderedClanBadgesByUserId.mockResolvedValue(
      new Map([["111111111111111111", ["<:badge:123>"]]]),
    );

    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const client = { user: { id: "bot-1" } } as any;
    const interaction = {
      guildId: "guild-1",
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

    await RepWork.run(client, interaction, {} as any);

    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(reportServiceMock.buildReport).toHaveBeenCalledWith({
      guildId: "guild-1",
      since: "7d",
    });
    expect(badgeResolverMock.resolveRepWorkRenderedClanBadgesByUserId).toHaveBeenCalledWith({
      client,
      userIds: ["111111111111111111"],
    });
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        allowedMentions: { parse: [] },
      }),
    );

    const embed = (editReply.mock.calls[0]?.[0]?.embeds?.[0] as any)?.toJSON?.();
    expect(embed?.fields?.[0]?.name).toBe("\u200b");
    expect(String(embed?.fields?.[0]?.value)).toContain("**<@111111111111111111>** <:badge:123>");
    expect(String(embed?.fields?.[0]?.value)).toContain("Mails: Discord 2 (avg 1h left) | In-game 3 (avg 30m left)");
    expect(reply).not.toHaveBeenCalled();
  });

  it("falls back to the raw user id when the report row is not a Discord snowflake", async () => {
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
          discordUserId: "not-a-snowflake",
          basesChecked: 0,
          basesAvgPrepTimeLeftSeconds: null,
          syncsParticipated: 0,
          clanClaims: 0,
          mailsChecked: 0,
          mailsCheckedAvgPrepTimeLeftSeconds: null,
          mailsSent: 0,
          mailsSentAvgPrepTimeLeftSeconds: null,
          topCommands: [],
        },
      ],
    });
    badgeResolverMock.resolveRepWorkRenderedClanBadgesByUserId.mockResolvedValue(new Map());

    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      guildId: "guild-1",
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

    await RepWork.run({ user: { id: "bot-1" } } as any, interaction, {} as any);

    const embed = (editReply.mock.calls[0]?.[0]?.embeds?.[0] as any)?.toJSON?.();
    expect(String(embed?.fields?.[0]?.value)).toContain("**not-a-snowflake**");
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

    await RepWork.run({ user: { id: "bot-1" } } as any, interaction, {} as any);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Use a duration like 7d, 4w, or 2mo.",
      }),
    );
    expect(reportServiceMock.buildReport).not.toHaveBeenCalled();
  });
});
