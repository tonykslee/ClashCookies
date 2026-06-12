import { RepWorkActivityType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_MESSAGE_FEATURE_TYPE } from "../src/services/TrackedMessageService";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  trackedMessageClaim: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function normalizeSqlText(query: any): string {
  return String(query?.strings?.join(" ") ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

import {
  buildRepWorkReportEmbed,
  buildRepWorkReportEmbeds,
  parseRepWorkDuration,
  repWorkReportService,
  truncateDiscordText,
} from "../src/services/RepWorkReportService";

describe("rep work report service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$queryRaw.mockReset();
    prismaMock.trackedMessageClaim.findMany.mockReset();
  });

  it("parses valid rep-work durations", () => {
    expect(parseRepWorkDuration("1d")).toEqual({
      amount: 1,
      unit: "d",
      days: 1,
      label: "1d",
    });
    expect(parseRepWorkDuration(" 7d ")).toEqual({
      amount: 7,
      unit: "d",
      days: 7,
      label: "7d",
    });
    expect(parseRepWorkDuration("4w")).toEqual({
      amount: 4,
      unit: "w",
      days: 28,
      label: "4w",
    });
    expect(parseRepWorkDuration("2mo")).toEqual({
      amount: 2,
      unit: "mo",
      days: 60,
      label: "2mo",
    });
    expect(parseRepWorkDuration("2MO")).toEqual({
      amount: 2,
      unit: "mo",
      days: 60,
      label: "2mo",
    });
  });

  it("rejects invalid rep-work durations", () => {
    expect(parseRepWorkDuration("")).toBeNull();
    expect(parseRepWorkDuration("0d")).toBeNull();
    expect(parseRepWorkDuration("7days")).toBeNull();
    expect(parseRepWorkDuration("1m")).toBeNull();
    expect(parseRepWorkDuration("-7d")).toBeNull();
    expect(parseRepWorkDuration("19mo")).toBeNull();
  });

  it("aggregates rep-work activity, sync participation, and top commands", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 2,
          avgPrepTimeLeftSeconds: 21600,
        },
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.MAIL_CHECKED,
          totalCount: 4,
          avgPrepTimeLeftSeconds: null,
        },
        {
          discordUserId: "222222222222222222",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 1,
          avgPrepTimeLeftSeconds: 1800,
        },
      ])
      .mockResolvedValueOnce([
        {
          discordUserId: "111111111111111111",
          commandName: "fwa",
          subcommand: "base-swap",
          totalCount: 12,
        },
        {
          discordUserId: "111111111111111111",
          commandName: "sync",
          subcommand: "time:post",
          totalCount: 8,
        },
        {
          discordUserId: "111111111111111111",
          commandName: "clan-health",
          subcommand: "",
          totalCount: 5,
        },
        {
          discordUserId: "111111111111111111",
          commandName: "todo",
          subcommand: "",
          totalCount: 4,
        },
        {
          discordUserId: "222222222222222222",
          commandName: "sync",
          subcommand: "time:post",
          totalCount: 6,
        },
      ]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([
      ...Array.from({ length: 30 }, (_, index) => ({
        userId: "111111111111111111",
        trackedMessageId: `sync-${index + 1}`,
        clanTag: "#AAA111",
      })),
      ...Array.from({ length: 6 }, (_, syncIndex) =>
        Array.from({ length: 5 }, (_, clanIndex) => ({
          userId: "222222222222222222",
          trackedMessageId: `sync-${syncIndex + 1}`,
          clanTag: `#BBB${clanIndex + 1}`,
        })),
      ).flat(),
      {
        userId:
          "fwa_match_checklist_publication|guild=1324040917602013261|sync=1514480098756263996|feature=FWA_MATCH_CHECKLIST|kind=bases_checklist",
        trackedMessageId: "sync-999",
        clanTag: "#ZZZ999",
      },
    ]);

    const report = await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "30d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(report).toBeTruthy();
    expect(report?.users).toHaveLength(2);
    expect(report?.users[0]).toMatchObject({
      discordUserId: "111111111111111111",
      basesChecked: 2,
      mailsChecked: 4,
      mailsSent: 0,
      syncsParticipated: 30,
      clanClaims: 30,
    });
    expect(report?.users[0].basesAvgPrepTimeLeftSeconds).toBe(21600);
    expect(report?.users[0].mailsCheckedAvgPrepTimeLeftSeconds).toBeNull();
    expect(report?.users[0].mailsSentAvgPrepTimeLeftSeconds).toBeNull();
    expect(report?.users[0].topCommands).toEqual([
      { label: "/fwa base-swap", totalCount: 12 },
      { label: "/sync time post", totalCount: 8 },
      { label: "/clan-health", totalCount: 5 },
    ]);
    expect(report?.users[1]).toMatchObject({
      discordUserId: "222222222222222222",
      basesChecked: 1,
      mailsChecked: 0,
      mailsSent: 0,
      syncsParticipated: 6,
      clanClaims: 30,
    });
    expect(report?.users[1].topCommands).toEqual([
      { label: "/sync time post", totalCount: 6 },
    ]);
    expect(report?.totalUsers).toBe(2);

    const embed = buildRepWorkReportEmbed(report!, {
      renderedBadgesByUserId: new Map([
        ["111111111111111111", ["<:badge:123>"]],
        ["222222222222222222", []],
      ]),
    });
    const json = embed.toJSON() as any;
    expect(json.title).toBe("Rep Work Stats");
    expect(String(json.description)).toContain("Window:");
    expect(json.fields[0].name).toBe("\u200b");
    expect(String(json.fields[0].value)).toContain("**<@111111111111111111>** <:badge:123>");
    expect(String(json.fields[1].value)).toContain("**<@222222222222222222>**");
    expect(String(json.fields[0].value)).toContain("Bases: 2 (avg 6h left)");
    expect(String(json.fields[0].value)).toContain("Syncs: 30 participated | 30 clan claims");
    expect(String(json.fields[0].value)).toContain("Mails: Discord 4 (avg n/a) | In-game 0 (avg n/a)");
    expect(String(json.fields[0].value)).toContain("Top cmds: `/fwa base-swap` 12");
    expect(String(json.footer?.text)).toContain("Since 30d");
  });

  it("ignores synthetic-only sync claims when building report users", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([
      {
        userId:
          "fwa_match_checklist_publication|guild=1324040917602013261|sync=1514480098756263996|feature=FWA_MATCH_CHECKLIST|kind=bases_checklist",
        trackedMessageId: "sync-999",
        clanTag: "#ZZZ999",
      },
    ]);

    const report = await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "30d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(report?.users).toEqual([]);
    expect(report?.totalUsers).toBe(0);
    expect(report?.visibleUsers).toBe(0);
  });

  it("uses the first event per sync when averaging prep time", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 2,
          avgPrepTimeLeftSeconds: 20000,
        },
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.MAIL_CHECKED,
          totalCount: 2,
          avgPrepTimeLeftSeconds: 12000,
        },
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.MAIL_SENT,
          totalCount: 1,
          avgPrepTimeLeftSeconds: 6000,
        },
        {
          discordUserId: "222222222222222222",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 3,
          avgPrepTimeLeftSeconds: 15000,
        },
        {
          discordUserId: "222222222222222222",
          activityType: RepWorkActivityType.MAIL_CHECKED,
          totalCount: 4,
          avgPrepTimeLeftSeconds: 10000,
        },
        {
          discordUserId: "222222222222222222",
          activityType: RepWorkActivityType.MAIL_SENT,
          totalCount: 2,
          avgPrepTimeLeftSeconds: 9000,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([]);

    const report = await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "14d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    const byUserId = new Map(report?.users.map((row) => [row.discordUserId, row]));
    expect(byUserId.get("111111111111111111")).toMatchObject({
      basesChecked: 2,
      basesAvgPrepTimeLeftSeconds: 20000,
      mailsChecked: 2,
      mailsCheckedAvgPrepTimeLeftSeconds: 12000,
      mailsSent: 1,
      mailsSentAvgPrepTimeLeftSeconds: 6000,
    });
    expect(byUserId.get("222222222222222222")).toMatchObject({
      basesChecked: 3,
      basesAvgPrepTimeLeftSeconds: 15000,
      mailsChecked: 4,
      mailsCheckedAvgPrepTimeLeftSeconds: 10000,
      mailsSent: 2,
      mailsSentAvgPrepTimeLeftSeconds: 9000,
    });
  });

  it("keeps null first-row prep timings as n/a", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 2,
          avgPrepTimeLeftSeconds: null,
        },
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.MAIL_CHECKED,
          totalCount: 1,
          avgPrepTimeLeftSeconds: 7200,
        },
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.MAIL_SENT,
          totalCount: 1,
          avgPrepTimeLeftSeconds: 3600,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([]);

    const report = await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "7d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(report?.users[0].basesAvgPrepTimeLeftSeconds).toBeNull();
    expect(report?.users[0].mailsCheckedAvgPrepTimeLeftSeconds).toBe(7200);
    expect(report?.users[0].mailsSentAvgPrepTimeLeftSeconds).toBe(3600);

    const embed = buildRepWorkReportEmbed(report!, {
      renderedBadgesByUserId: new Map([["111111111111111111", ["<:badge:123>", "<:badge:123>"]]]),
    });
    const json = embed.toJSON() as any;
    expect(String(json.fields[0].value)).toContain("Bases: 2 (avg n/a)");
    expect(String(json.fields[0].value)).toContain("Mails: Discord 1 (avg 2h left) | In-game 1 (avg 1h left)");
    expect(String(json.fields[0].value)).toContain("**<@111111111111111111>** <:badge:123>");
  });

  it("dedupes rendered badges per user safely", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 1,
          avgPrepTimeLeftSeconds: 6000,
        },
        {
          discordUserId: "222222222222222222",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 1,
          avgPrepTimeLeftSeconds: 7000,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([]);

    const report = await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "7d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    const embed = buildRepWorkReportEmbed(report!, {
      renderedBadgesByUserId: new Map([
        ["111111111111111111", ["<:badge:123>", "<:badge:123>"]],
        ["222222222222222222", ["<:badge:999>"]],
      ]),
    });
    const json = embed.toJSON() as any;
    expect(String(json.fields[0].value)).toContain("**<@111111111111111111>** <:badge:123>");
    expect(String(json.fields[0].value)).not.toContain("<:badge:123> <:badge:123>");
    expect(String(json.fields[1].value)).toContain("**<@222222222222222222>** <:badge:999>");
  });

  it("keeps truncateDiscordText within the requested maximum length", () => {
    expect(truncateDiscordText("abcdef", 0)).toBe("");
    expect(truncateDiscordText("abcdef", 1)).toBe("a");
    expect(truncateDiscordText("abcdef", 2)).toBe("ab");
    expect(truncateDiscordText("abcdef", 3)).toBe("...");
    expect(truncateDiscordText("abcdef", 4)).toBe("a...");
    expect(truncateDiscordText("abcdef", 5)).toBe("ab...");
    expect(truncateDiscordText("abcdef", 6)).toBe("abcdef");
    expect(truncateDiscordText("abcdef", 7)).toBe("abcdef");
    expect(truncateDiscordText("abcdefghijk", 5).length).toBeLessThanOrEqual(5);
    expect(truncateDiscordText("abcdefghijk", 2).length).toBeLessThanOrEqual(2);
  });

  it("paginates users without splitting a user across pages", async () => {
    const users = Array.from({ length: 26 }, (_, index) => {
      const suffix = String(index + 1).padStart(3, "0");
      return {
        discordUserId: `111111111111111${suffix}`,
        activityType: RepWorkActivityType.BASES_CHECKED,
        totalCount: 1,
        avgPrepTimeLeftSeconds: 3600,
      };
    });
    prismaMock.$queryRaw
      .mockResolvedValueOnce(users)
      .mockResolvedValueOnce([]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([]);

    const report = await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "7d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    const embeds = buildRepWorkReportEmbeds(report!, {
      renderedBadgesByUserId: new Map([
        ["111111111111111001", ["<:badge:123>"]],
      ]),
    });

    expect(embeds).toHaveLength(2);

    const firstPage = embeds[0].toJSON() as any;
    const secondPage = embeds[1].toJSON() as any;
    expect(firstPage.fields).toHaveLength(25);
    expect(secondPage.fields).toHaveLength(1);
    expect(String(firstPage.fields[0].value)).toContain("**<@111111111111111001>** <:badge:123>");
    expect(String(firstPage.fields[0].value)).toContain("Bases: 1 (avg 1h left)");
    expect(String(firstPage.footer?.text)).toBe(
      "Page 1/2 | Since 7d | Showing users 1-25 of 26",
    );
    expect(String(secondPage.fields[0].value)).toContain("**<@111111111111111026>**");
    expect(String(secondPage.footer?.text)).toBe(
      "Page 2/2 | Since 7d | Showing users 26-26 of 26",
    );
  });

  it("truncates an oversized user field without splitting the user across pages", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 1,
          avgPrepTimeLeftSeconds: 3600,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([]);

    const report = await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "7d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    report!.users[0].topCommands = Array.from({ length: 20 }, (_, index) => ({
      label: `/command-${index + 1}-${"x".repeat(80)}`,
      totalCount: 1000 - index,
    }));

    const embed = buildRepWorkReportEmbed(report!, {
      renderedBadgesByUserId: new Map([["111111111111111111", ["<:badge:123>"]]]),
    });
    const json = embed.toJSON() as any;
    const fieldValue = String(json.fields[0].value);

    expect(json.fields).toHaveLength(1);
    expect(fieldValue.length).toBeLessThanOrEqual(1024);
    expect(fieldValue).toContain("**<@111111111111111111>** <:badge:123>");
    expect(fieldValue).toContain("Bases: 1 (avg 1h left)");
    expect(fieldValue).toContain("Syncs: 0 participated | 0 clan claims");
    expect(fieldValue).toContain("Mails: Discord 0 (avg n/a) | In-game 0 (avg n/a)");
    expect(fieldValue).toContain("Top cmds:");
  });

  it("uses first-row-per-sync SQL for prep timing averages", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 2,
          avgPrepTimeLeftSeconds: 20000,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([]);

    await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "7d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    const sqlText = normalizeSqlText(prismaMock.$queryRaw.mock.calls[0]?.[0]);
    expect(sqlText).toContain('ROW_NUMBER() OVER ( PARTITION BY "discordUserId", "activityType", COALESCE("syncMessageId", "sourceMessageId", "id") ORDER BY "eventAt" ASC, "createdAt" ASC, "id" ASC ) AS "rn"');
    expect(sqlText).toContain('"rn" = 1');
    expect(sqlText).toContain('AVG("prepTimeLeftSeconds")::double precision AS "avgPrepTimeLeftSeconds"');
  });

  it("ignores null prep timing values when averaging", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.BASES_CHECKED,
          totalCount: 2,
          avgPrepTimeLeftSeconds: null,
        },
        {
          discordUserId: "111111111111111111",
          activityType: RepWorkActivityType.MAIL_CHECKED,
          totalCount: 1,
          avgPrepTimeLeftSeconds: 7200,
        },
      ])
      .mockResolvedValueOnce([
        {
          discordUserId: "111111111111111111",
          commandName: "clan-health",
          subcommand: "",
          totalCount: 1,
        },
      ]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([
      {
        userId: "111111111111111111",
        trackedMessageId: "sync-1",
        clanTag: "#AAA111",
      },
    ]);

    const report = await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "7d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(report?.users[0].basesAvgPrepTimeLeftSeconds).toBeNull();
    expect(report?.users[0].mailsCheckedAvgPrepTimeLeftSeconds).toBe(7200);
    expect(report?.users[0].mailsSentAvgPrepTimeLeftSeconds).toBeNull();
  });

  it("omits command-only users from the main report", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([]);

    const report = await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "7d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(report?.users).toEqual([]);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("uses Prisma enum filtering for sync claims instead of raw text SQL", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.trackedMessageClaim.findMany.mockResolvedValue([
      {
        userId: "111111111111111111",
        trackedMessageId: "sync-1",
        clanTag: "#AAA111",
      },
    ]);

    await repWorkReportService.buildReport({
      guildId: "guild-1",
      since: "7d",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(prismaMock.trackedMessageClaim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trackedMessage: expect.objectContaining({
            guildId: "guild-1",
          }),
        }),
      }),
    );
    const callArg = prismaMock.trackedMessageClaim.findMany.mock.calls[0]?.[0] as any;
    expect(callArg.where.trackedMessage.featureType).toBe(TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST);
  });
});
