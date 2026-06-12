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

function makeReportUserRow(input: {
  discordUserId: string;
  basesChecked?: number;
  basesAvgPrepTimeLeftSeconds?: number | null;
  syncsParticipated?: number;
  clanClaims?: number;
  mailsChecked?: number;
  mailsCheckedAvgPrepTimeLeftSeconds?: number | null;
  mailsSent?: number;
  mailsSentAvgPrepTimeLeftSeconds?: number | null;
  topCommands?: Array<{ label: string; totalCount: number }>;
}) {
  return {
    discordUserId: input.discordUserId,
    basesChecked: input.basesChecked ?? 1,
    basesAvgPrepTimeLeftSeconds: input.basesAvgPrepTimeLeftSeconds ?? 3600,
    syncsParticipated: input.syncsParticipated ?? 1,
    clanClaims: input.clanClaims ?? 1,
    mailsChecked: input.mailsChecked ?? 1,
    mailsCheckedAvgPrepTimeLeftSeconds: input.mailsCheckedAvgPrepTimeLeftSeconds ?? 1800,
    mailsSent: input.mailsSent ?? 1,
    mailsSentAvgPrepTimeLeftSeconds: input.mailsSentAvgPrepTimeLeftSeconds ?? 900,
    topCommands:
      input.topCommands ?? [
        { label: "/fwa base-swap", totalCount: 1 },
        { label: "/sync time post", totalCount: 1 },
      ],
  };
}

function makePagedReport(count: number) {
  return {
    guildId: "guild-1",
    start: new Date("2026-06-03T12:00:00.000Z"),
    end: new Date("2026-06-10T12:00:00.000Z"),
    duration: { amount: 7, unit: "d", days: 7, label: "7d" },
    totalUsers: count,
    visibleUsers: count,
    limit: 100,
    users: Array.from({ length: count }, (_, index) => {
      const suffix = String(index + 1).padStart(3, "0");
      return makeReportUserRow({
        discordUserId: `111111111111111${suffix}`,
      });
    }),
  };
}

function makeCollector() {
  const handlers: Record<string, any> = {};
  const collector = {
    on: vi.fn((event: string, handler: any) => {
      handlers[event] = handler;
      return collector;
    }),
  };
  return { collector, handlers };
}

function makeButtonInteraction(customId: string, userId: string) {
  return {
    customId,
    user: { id: userId },
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
  } as any;
}

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
      limit: 100,
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
    const fetchReply = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const client = { user: { id: "bot-1" } } as any;
    const interaction = {
      guildId: "guild-1",
      id: "interaction-1",
      user: { id: "111111111111111111" },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "since") return "7d";
          if (name === "visibility") return "private";
          return null;
        }),
      },
      deferReply,
      editReply,
      fetchReply,
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
        components: [],
      }),
    );
    expect(fetchReply).not.toHaveBeenCalled();

    const embed = (editReply.mock.calls[0]?.[0]?.embeds?.[0] as any)?.toJSON?.();
    expect(embed?.fields?.[0]?.name).toBe("\u200b");
    expect(String(embed?.fields?.[0]?.value)).toContain("**<@111111111111111111>** <:badge:123>");
    expect(String(embed?.fields?.[0]?.value)).toContain(
      "Mails: Discord 2 (avg 1h left) | In-game 3 (avg 30m left)",
    );
    expect(reply).not.toHaveBeenCalled();
  });

  it("renders navigation buttons and keeps each user block on a single page", async () => {
    reportServiceMock.buildReport.mockResolvedValue(makePagedReport(26));
    badgeResolverMock.resolveRepWorkRenderedClanBadgesByUserId.mockResolvedValue(
      new Map([["111111111111111001", ["<:badge:123>"]]]),
    );

    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const fetchReply = vi.fn();
    const { collector, handlers } = makeCollector();
    fetchReply.mockResolvedValue({
      createMessageComponentCollector: vi.fn(() => collector),
    });
    const client = { user: { id: "bot-1" } } as any;
    const interaction = {
      guildId: "guild-1",
      id: "interaction-2",
      user: { id: "111111111111111111" },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "since") return "7d";
          if (name === "visibility") return "private";
          return null;
        }),
      },
      deferReply,
      editReply,
      fetchReply,
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await RepWork.run(client, interaction, {} as any);

    expect(fetchReply).toHaveBeenCalledTimes(1);
    const initialPayload = editReply.mock.calls[0]?.[0] as any;
    expect(initialPayload.allowedMentions).toEqual({ parse: [] });
    expect(initialPayload.components).toHaveLength(1);

    const initialButtons = initialPayload.components[0].toJSON().components;
    expect(initialButtons[0].disabled).toBe(true);
    expect(initialButtons[1].disabled).toBe(false);

    const initialEmbed = initialPayload.embeds[0].toJSON() as any;
    expect(String(initialEmbed.footer.text)).toBe(
      "Page 1/2 | Since 7d | Showing users 1-25 of 26",
    );
    expect(String(initialEmbed.fields[0].value)).toContain("**<@111111111111111001>** <:badge:123>");
    expect(String(initialEmbed.fields[24].value)).toContain("**<@111111111111111025>**");
    expect(String(initialEmbed.fields[24].value)).not.toContain("111111111111111026");

    const collect = handlers.collect;
    expect(collect).toBeTypeOf("function");

    const nextButton = makeButtonInteraction("repwork:interaction-2:next", "111111111111111111");
    await collect(nextButton);

    expect(nextButton.update).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: { parse: [] },
      }),
    );
    const nextPayload = nextButton.update.mock.calls[0][0] as any;
    const nextEmbed = nextPayload.embeds[0].toJSON() as any;
    const nextButtons = nextPayload.components[0].toJSON().components;
    expect(String(nextEmbed.footer.text)).toBe(
      "Page 2/2 | Since 7d | Showing users 26-26 of 26",
    );
    expect(String(nextEmbed.fields[0].value)).toContain("**<@111111111111111026>**");
    expect(nextButtons[0].disabled).toBe(false);
    expect(nextButtons[1].disabled).toBe(true);
  });

  it("rejects other users from repwork pagination with an ephemeral reply", async () => {
    reportServiceMock.buildReport.mockResolvedValue(makePagedReport(26));
    badgeResolverMock.resolveRepWorkRenderedClanBadgesByUserId.mockResolvedValue(new Map());

    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const fetchReply = vi.fn();
    const { collector, handlers } = makeCollector();
    fetchReply.mockResolvedValue({
      createMessageComponentCollector: vi.fn(() => collector),
    });
    const interaction = {
      guildId: "guild-1",
      id: "interaction-3",
      user: { id: "111111111111111111" },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "since") return "7d";
          if (name === "visibility") return "private";
          return null;
        }),
      },
      deferReply,
      editReply,
      fetchReply,
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await RepWork.run({ user: { id: "bot-1" } } as any, interaction, {} as any);

    const collect = handlers.collect;
    expect(collect).toBeTypeOf("function");

    const otherUserButton = makeButtonInteraction("repwork:interaction-3:next", "222222222222222222");
    await collect(otherUserButton);

    expect(otherUserButton.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "This pagination belongs to another user.",
        ephemeral: true,
      }),
    );
    expect(otherUserButton.update).not.toHaveBeenCalled();
  });

  it("falls back to the raw user id when the report row is not a Discord snowflake", async () => {
    reportServiceMock.buildReport.mockResolvedValue({
      guildId: "guild-1",
      start: new Date("2026-06-03T12:00:00.000Z"),
      end: new Date("2026-06-10T12:00:00.000Z"),
      duration: { amount: 7, unit: "d", days: 7, label: "7d" },
      totalUsers: 1,
      visibleUsers: 1,
      limit: 100,
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
      fetchReply: vi.fn(),
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
      fetchReply: vi.fn(),
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
