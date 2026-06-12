import { Prisma, RepWorkActivityType } from "@prisma/client";
import { EmbedBuilder } from "discord.js";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { TRACKED_MESSAGE_FEATURE_TYPE } from "./TrackedMessageService";

const DEFAULT_RESULT_LIMIT = 100;
const MAX_RESULT_LIMIT = 100;
const MAX_DURATION_DAYS = 18 * 30;
const MIN_DURATION_DAYS = 1;
const REPWORK_EMBED_PAGE_CHAR_LIMIT = 5900;
const REPWORK_EMBED_PAGE_CHAR_RESERVE = 140;
const REPWORK_EMBED_FIELD_VALUE_LIMIT = 1024;
const REPWORK_EMBED_MAX_FIELDS_PER_PAGE = 25;

export type RepWorkDurationUnit = "d" | "w" | "mo";

export type ParsedRepWorkDuration = {
  amount: number;
  unit: RepWorkDurationUnit;
  days: number;
  label: string;
};

export type RepWorkReportCommandRow = {
  label: string;
  totalCount: number;
};

export type RepWorkReportUserRow = {
  discordUserId: string;
  basesChecked: number;
  basesAvgPrepTimeLeftSeconds: number | null;
  syncsParticipated: number;
  clanClaims: number;
  mailsChecked: number;
  mailsCheckedAvgPrepTimeLeftSeconds: number | null;
  mailsSent: number;
  mailsSentAvgPrepTimeLeftSeconds: number | null;
  topCommands: RepWorkReportCommandRow[];
};

export type RepWorkReport = {
  guildId: string;
  start: Date;
  end: Date;
  duration: ParsedRepWorkDuration;
  totalUsers: number;
  visibleUsers: number;
  limit: number;
  users: RepWorkReportUserRow[];
};

export type RepWorkReportEmbedOptions = {
  renderedBadgesByUserId?: Map<string, string[]>;
};

export type RepWorkReportEmbedPage = {
  embed: EmbedBuilder;
  pageIndex: number;
  pageCount: number;
  startUserIndex: number;
  endUserIndex: number;
};

type RepWorkActivityAggregateRow = {
  discordUserId: string;
  activityType: RepWorkActivityType;
  totalCount: bigint | number | string;
  avgPrepTimeLeftSeconds: number | string | null;
};

type RepWorkSyncClaimAggregateRow = {
  userId: string;
  trackedMessageId: string;
  clanTag: string;
};

type RepWorkTelemetryAggregateRow = {
  discordUserId: string;
  commandName: string;
  subcommand: string;
  totalCount: bigint | number | string;
};

function toNumber(value: bigint | number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeIntegerText(input: string): number | null {
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function formatPrepTimeLeft(avgSeconds: number | null): string {
  if (avgSeconds === null || !Number.isFinite(avgSeconds)) return "avg n/a";
  const roundedMinutes = Math.max(0, Math.round(avgSeconds / 60));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (hours === 0 && minutes === 0) return "avg 0m left";
  if (hours === 0) return `avg ${minutes}m left`;
  if (minutes === 0) return `avg ${hours}h left`;
  return `avg ${hours}h ${String(minutes).padStart(2, "0")}m left`;
}

function formatCommandLabel(commandName: string, subcommand: string): string {
  const normalizedCommand = String(commandName ?? "").trim();
  const normalizedSubcommand = String(subcommand ?? "").trim();
  if (!normalizedSubcommand) return `/${normalizedCommand}`;
  return `/${normalizedCommand} ${normalizedSubcommand.replaceAll(":", " ")}`;
}

export function truncateDiscordText(input: string, maxLength: number): string {
  const normalized = String(input ?? "");
  if (maxLength <= 0) return "";
  if (normalized.length <= maxLength) return normalized;
  if (maxLength < 3) return normalized.slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isDiscordSnowflakeId(value: string | null | undefined): boolean {
  return /^\d{17,20}$/.test(String(value ?? "").trim());
}

function buildRepWorkUserIdentityLine(input: {
  discordUserId: string;
  renderedBadgesByUserId?: Map<string, string[]>;
}): string {
  const identity = isDiscordSnowflakeId(input.discordUserId)
    ? `<@${input.discordUserId}>`
    : input.discordUserId;
  const badges = [
    ...new Set(input.renderedBadgesByUserId?.get(input.discordUserId) ?? []),
  ].filter((badge) => String(badge ?? "").trim());
  return badges.length > 0
    ? `**${identity}** ${badges.join(" ")}`
    : `**${identity}**`;
}

function formatRenderedBadges(
  renderedBadges: string[],
  maxLength: number,
): string {
  const badges = [...new Set(renderedBadges.map((badge) => String(badge ?? "").trim()).filter(Boolean))];
  if (badges.length === 0) return "";
  let rendered = "";
  for (const badge of badges) {
    const next = rendered ? `${rendered} ${badge}` : badge;
    if (next.length <= maxLength) {
      rendered = next;
      continue;
    }
    if (rendered.length === 0) {
      return truncateDiscordText(badge, maxLength);
    }
    return truncateDiscordText(`${rendered}...`, maxLength);
  }
  return rendered;
}

function buildRepWorkUserFieldValue(input: {
  row: RepWorkReportUserRow;
  renderedBadgesByUserId?: Map<string, string[]>;
}): string {
  const row = input.row;
  const renderedBadges = [
    ...new Set(input.renderedBadgesByUserId?.get(row.discordUserId) ?? []),
  ].filter((badge) => String(badge ?? "").trim());

  const identity = isDiscordSnowflakeId(row.discordUserId)
    ? `<@${row.discordUserId}>`
    : row.discordUserId;
  const basesLine = `Bases: ${row.basesChecked} (${formatPrepTimeLeft(row.basesAvgPrepTimeLeftSeconds)})`;
  const syncsLine = `Syncs: ${row.syncsParticipated} participated | ${row.clanClaims} clan claims`;
  const mailsLine = `Mails: Discord ${row.mailsChecked} (${formatPrepTimeLeft(row.mailsCheckedAvgPrepTimeLeftSeconds)}) | In-game ${row.mailsSent} (${formatPrepTimeLeft(row.mailsSentAvgPrepTimeLeftSeconds)})`;
  const topCommandsText =
    row.topCommands.length > 0
      ? row.topCommands.map((command) => `\`${command.label}\` ${command.totalCount}`).join(", ")
      : "none";

  const badgeLengthOptions = [160, 120, 80, 0];
  for (const badgeLimit of badgeLengthOptions) {
    const badgeSuffix = formatRenderedBadges(renderedBadges, badgeLimit);
    const firstLine =
      badgeSuffix.length > 0 ? `**${identity}** ${badgeSuffix}` : `**${identity}**`;
    const coreLines = [firstLine, basesLine, syncsLine, mailsLine];
    const topCmdPrefix = "Top cmds: ";
    const coreText = coreLines.join("\n");
    const remainingForTopCmds = Math.max(
      0,
      REPWORK_EMBED_FIELD_VALUE_LIMIT - coreText.length - 1 - topCmdPrefix.length,
    );
    const truncatedTopCommands = truncateDiscordText(topCommandsText, remainingForTopCmds);
    const candidate = `${coreText}\n${topCmdPrefix}${truncatedTopCommands}`;
    if (candidate.length <= REPWORK_EMBED_FIELD_VALUE_LIMIT) {
      return candidate;
    }
    const noTopCmdsCandidate = `${coreText}\nTop cmds: ...`;
    if (noTopCmdsCandidate.length <= REPWORK_EMBED_FIELD_VALUE_LIMIT) {
      return noTopCmdsCandidate;
    }
  }

  const fallback = [
    `**${identity}**`,
    `Bases: ${row.basesChecked} (${formatPrepTimeLeft(row.basesAvgPrepTimeLeftSeconds)})`,
    `Syncs: ${row.syncsParticipated} participated | ${row.clanClaims} clan claims`,
    `Mails: Discord ${row.mailsChecked} (${formatPrepTimeLeft(row.mailsCheckedAvgPrepTimeLeftSeconds)}) | In-game ${row.mailsSent} (${formatPrepTimeLeft(row.mailsSentAvgPrepTimeLeftSeconds)})`,
    `Top cmds: ${truncateDiscordText(topCommandsText, 32)}`,
  ].join("\n");
  return truncateDiscordText(fallback, REPWORK_EMBED_FIELD_VALUE_LIMIT);
}

function buildRepWorkPageFooter(input: {
  report: RepWorkReport;
  pageIndex: number;
  pageCount: number;
  startUserIndex: number;
  endUserIndex: number;
}): string {
  const pageText = `Page ${input.pageIndex + 1}/${input.pageCount}`;
  const rangeText = `Showing users ${input.startUserIndex + 1}-${input.endUserIndex + 1} of ${input.report.visibleUsers}`;
  const totalText =
    input.report.totalUsers > input.report.visibleUsers
      ? `Showing top ${input.report.visibleUsers} of ${input.report.totalUsers} users`
      : null;
  return totalText
    ? `${pageText} | Since ${input.report.duration.label} | ${rangeText} | ${totalText}`
    : `${pageText} | Since ${input.report.duration.label} | ${rangeText}`;
}

function buildRepWorkReportPageEmbeds(
  report: RepWorkReport,
  options?: RepWorkReportEmbedOptions,
): RepWorkReportEmbedPage[] {
  const baseDescription = `Window: <t:${Math.trunc(report.start.getTime() / 1000)}:f> -> <t:${Math.trunc(report.end.getTime() / 1000)}:f>`;
  if (report.users.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle("Rep Work Stats")
      .setDescription(baseDescription)
      .setColor(0x57f287)
      .addFields({
        name: "No activity",
        value: "No rep-work activity found in this window.",
        inline: false,
      })
      .setFooter({ text: `Since ${report.duration.label} | Showing 0 of 0 users` });
    return [
      {
        embed,
        pageIndex: 0,
        pageCount: 1,
        startUserIndex: 0,
        endUserIndex: 0,
      },
    ];
  }

  const pages: Array<Array<{ name: string; value: string; inline: boolean }>> = [];
  let currentFields: Array<{ name: string; value: string; inline: boolean }> = [];
  let currentFieldChars = 0;
  const pageBaseChars =
    "Rep Work Stats".length +
    baseDescription.length +
    REPWORK_EMBED_PAGE_CHAR_RESERVE;

  for (const row of report.users) {
    const value = buildRepWorkUserFieldValue({
      row,
      renderedBadgesByUserId: options?.renderedBadgesByUserId,
    });
    const field = {
      name: "\u200b",
      value,
      inline: false,
    };
    const fieldChars = field.name.length + field.value.length;
    const wouldExceedFieldCount = currentFields.length >= REPWORK_EMBED_MAX_FIELDS_PER_PAGE;
    const wouldExceedChars =
      pageBaseChars + currentFieldChars + fieldChars > REPWORK_EMBED_PAGE_CHAR_LIMIT;

    if (currentFields.length > 0 && (wouldExceedFieldCount || wouldExceedChars)) {
      pages.push(currentFields);
      currentFields = [];
      currentFieldChars = 0;
    }

    currentFields.push(field);
    currentFieldChars += fieldChars;
  }

  if (currentFields.length > 0) {
    pages.push(currentFields);
  }

  return pages.map((fields, pageIndex) => {
    const startUserIndex = pages
      .slice(0, pageIndex)
      .reduce((sum, pageFields) => sum + pageFields.length, 0);
    const endUserIndex = startUserIndex + fields.length - 1;
    const embed = new EmbedBuilder()
      .setTitle("Rep Work Stats")
      .setDescription(baseDescription)
      .setColor(0x57f287)
      .addFields(fields)
      .setFooter({
        text: buildRepWorkPageFooter({
          report,
          pageIndex,
          pageCount: pages.length,
          startUserIndex,
          endUserIndex,
        }),
      });
    return {
      embed,
      pageIndex,
      pageCount: pages.length,
      startUserIndex,
      endUserIndex,
    };
  });
}

function buildWindow(now: Date, durationDays: number): { start: Date; end: Date } {
  const end = new Date(now);
  const start = new Date(end.getTime() - durationDays * 24 * 60 * 60 * 1000);
  return { start, end };
}

function ensureUserRow(
  users: Map<string, RepWorkReportUserRow>,
  discordUserId: string,
): RepWorkReportUserRow {
  const existing = users.get(discordUserId);
  if (existing) return existing;
  const row: RepWorkReportUserRow = {
    discordUserId,
    basesChecked: 0,
    basesAvgPrepTimeLeftSeconds: null,
    syncsParticipated: 0,
    clanClaims: 0,
    mailsChecked: 0,
    mailsCheckedAvgPrepTimeLeftSeconds: null,
    mailsSent: 0,
    mailsSentAvgPrepTimeLeftSeconds: null,
    topCommands: [],
  };
  users.set(discordUserId, row);
  return row;
}

function logBuildFailure(input: {
  guildId: string;
  since: string;
  start: Date;
  end: Date;
  stage: string;
  error: unknown;
}): void {
  console.error(
    `[rep-work-report] build_failed guildId=${input.guildId} since=${input.since} start=${input.start.toISOString()} end=${input.end.toISOString()} stage=${input.stage} error=${formatError(input.error)}`,
  );
}

function sortReportUsers(rows: RepWorkReportUserRow[]): RepWorkReportUserRow[] {
  return [...rows].sort((a, b) => {
    if (b.basesChecked !== a.basesChecked) return b.basesChecked - a.basesChecked;
    const aMailTotal = a.mailsChecked + a.mailsSent;
    const bMailTotal = b.mailsChecked + b.mailsSent;
    if (bMailTotal !== aMailTotal) return bMailTotal - aMailTotal;
    if (b.clanClaims !== a.clanClaims) return b.clanClaims - a.clanClaims;
    if (b.syncsParticipated !== a.syncsParticipated) {
      return b.syncsParticipated - a.syncsParticipated;
    }
    return a.discordUserId.localeCompare(b.discordUserId);
  });
}

function buildTopCommands(
  commandRows: RepWorkTelemetryAggregateRow[],
): Map<string, RepWorkReportCommandRow[]> {
  const grouped = new Map<string, Array<{ label: string; totalCount: number }>>();
  for (const row of commandRows) {
    const discordUserId = String(row.discordUserId ?? "").trim();
    if (!discordUserId) continue;
    const label = formatCommandLabel(row.commandName, row.subcommand);
    const totalCount = toNumber(row.totalCount);
    const rows = grouped.get(discordUserId) ?? [];
    rows.push({ label, totalCount });
    grouped.set(discordUserId, rows);
  }

  const result = new Map<string, RepWorkReportCommandRow[]>();
  for (const [discordUserId, rows] of grouped.entries()) {
    const topRows = [...rows]
      .sort((a, b) => {
        if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
        return a.label.localeCompare(b.label);
      })
      .slice(0, 3);
    result.set(discordUserId, topRows);
  }
  return result;
}

/** Purpose: parse `since` duration text into a bounded rep-work window spec. */
export function parseRepWorkDuration(input: string | null | undefined): ParsedRepWorkDuration | null {
  const normalized = String(input ?? "").trim().toLowerCase();
  const match = normalized.match(/^([1-9]\d*)(d|w|mo)$/i);
  if (!match) return null;
  const amount = normalizeIntegerText(match[1] ?? "");
  if (!amount) return null;
  const unit = (match[2] ?? "").toLowerCase() as RepWorkDurationUnit;
  const days = unit === "d" ? amount : unit === "w" ? amount * 7 : amount * 30;
  if (days < MIN_DURATION_DAYS || days > MAX_DURATION_DAYS) return null;
  return {
    amount,
    unit,
    days,
    label: `${amount}${unit}`,
  };
}

export function buildRepWorkReportEmbed(
  report: RepWorkReport,
  options?: RepWorkReportEmbedOptions,
): EmbedBuilder {
  return buildRepWorkReportPageEmbeds(report, options)[0]?.embed ?? new EmbedBuilder();
}

export function buildRepWorkReportEmbeds(
  report: RepWorkReport,
  options?: RepWorkReportEmbedOptions,
): EmbedBuilder[] {
  return buildRepWorkReportPageEmbeds(report, options).map((page) => page.embed);
}

export class RepWorkReportService {
  async buildReport(input: {
    guildId: string;
    since: string;
    now?: Date;
    limit?: number;
  }): Promise<RepWorkReport | null> {
    const guildId = String(input.guildId ?? "").trim();
    if (!guildId) return null;

    const duration = parseRepWorkDuration(input.since);
    if (!duration) return null;

    const now = input.now ?? new Date();
    const { start, end } = buildWindow(now, duration.days);
    const requestedLimit = Number.isFinite(input.limit ?? NaN)
      ? Math.trunc(input.limit ?? DEFAULT_RESULT_LIMIT)
      : DEFAULT_RESULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_RESULT_LIMIT, requestedLimit));

    let stage = "activity_query";
    try {
      const activityRows = await prisma.$queryRaw<RepWorkActivityAggregateRow[]>(Prisma.sql`
        WITH "count_rows" AS (
          SELECT
            "discordUserId",
            "activityType",
            COUNT(*)::int AS "totalCount"
          FROM "RepWorkActivityEvent"
          WHERE
            "guildId" = ${guildId}
            AND "eventAt" >= ${start}
            AND "eventAt" < ${end}
          GROUP BY "discordUserId", "activityType"
        ),
        "ranked_first_rows" AS (
          SELECT
            "discordUserId",
            "activityType",
            "prepTimeLeftSeconds",
            ROW_NUMBER() OVER (
              PARTITION BY
                "discordUserId",
                "activityType",
                COALESCE("syncMessageId", "sourceMessageId", "id")
              ORDER BY "eventAt" ASC, "createdAt" ASC, "id" ASC
            ) AS "rn"
          FROM "RepWorkActivityEvent"
          WHERE
            "guildId" = ${guildId}
            AND "eventAt" >= ${start}
            AND "eventAt" < ${end}
        ),
        "first_row_averages" AS (
          SELECT
            "discordUserId",
            "activityType",
            AVG("prepTimeLeftSeconds")::double precision AS "avgPrepTimeLeftSeconds"
          FROM "ranked_first_rows"
          WHERE "rn" = 1
          GROUP BY "discordUserId", "activityType"
        )
        SELECT
          c."discordUserId",
          c."activityType",
          c."totalCount",
          a."avgPrepTimeLeftSeconds"
        FROM "count_rows" c
        LEFT JOIN "first_row_averages" a
          ON a."discordUserId" = c."discordUserId"
          AND a."activityType" = c."activityType"
        ORDER BY c."discordUserId", c."activityType"
      `);

      stage = "sync_claim_query";
      const syncClaimRows = await prisma.trackedMessageClaim.findMany({
        where: {
          createdAt: { gte: start, lt: end },
          trackedMessage: {
            guildId,
            featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
          },
        },
        select: {
          userId: true,
          trackedMessageId: true,
          clanTag: true,
        },
      });

      stage = "aggregate_sync_claims";
      const users = new Map<string, RepWorkReportUserRow>();
      const activityUserIds = new Set<string>();
      for (const row of activityRows) {
        const discordUserId = String(row.discordUserId ?? "").trim();
        if (!discordUserId) continue;
        activityUserIds.add(discordUserId);
        const user = ensureUserRow(users, discordUserId);
        if (row.activityType === RepWorkActivityType.BASES_CHECKED) {
          user.basesChecked += toNumber(row.totalCount);
          user.basesAvgPrepTimeLeftSeconds =
            row.avgPrepTimeLeftSeconds === null ? null : toNumber(row.avgPrepTimeLeftSeconds);
        } else if (row.activityType === RepWorkActivityType.MAIL_CHECKED) {
          user.mailsChecked += toNumber(row.totalCount);
          user.mailsCheckedAvgPrepTimeLeftSeconds =
            row.avgPrepTimeLeftSeconds === null ? null : toNumber(row.avgPrepTimeLeftSeconds);
        } else if (row.activityType === RepWorkActivityType.MAIL_SENT) {
          user.mailsSent += toNumber(row.totalCount);
          user.mailsSentAvgPrepTimeLeftSeconds =
            row.avgPrepTimeLeftSeconds === null ? null : toNumber(row.avgPrepTimeLeftSeconds);
        }
      }

      const syncParticipationByUser = new Map<
        string,
        {
          trackedMessageIds: Set<string>;
          trackedMessageIdClanTags: Set<string>;
        }
      >();
      for (const row of syncClaimRows as RepWorkSyncClaimAggregateRow[]) {
        const discordUserId = String(row.userId ?? "").trim();
        const trackedMessageId = String(row.trackedMessageId ?? "").trim();
        const clanTag = String(row.clanTag ?? "").trim();
        if (
          !discordUserId ||
          !isDiscordSnowflakeId(discordUserId) ||
          !trackedMessageId ||
          !clanTag
        ) {
          continue;
        }
        activityUserIds.add(discordUserId);
        const entry =
          syncParticipationByUser.get(discordUserId) ??
          {
            trackedMessageIds: new Set<string>(),
            trackedMessageIdClanTags: new Set<string>(),
          };
        entry.trackedMessageIds.add(trackedMessageId);
        entry.trackedMessageIdClanTags.add(`${trackedMessageId}|${clanTag.toUpperCase()}`);
        syncParticipationByUser.set(discordUserId, entry);
      }

      for (const [discordUserId, entry] of syncParticipationByUser.entries()) {
        const user = ensureUserRow(users, discordUserId);
        user.syncsParticipated += entry.trackedMessageIds.size;
        user.clanClaims += entry.trackedMessageIdClanTags.size;
      }

      const activeUserIds = [...activityUserIds];
      stage = "telemetry_query";
      const commandRows =
        activeUserIds.length === 0
          ? []
          : await prisma.$queryRaw<RepWorkTelemetryAggregateRow[]>(Prisma.sql`
              SELECT
                "userId" AS "discordUserId",
                "commandName",
                "subcommand",
                SUM("count")::int AS "totalCount"
              FROM "TelemetryUserCommandAggregate"
              WHERE
                "guildId" = ${guildId}
                AND "bucketStart" >= ${start}
                AND "bucketStart" < ${end}
                AND "userId" IN (${Prisma.join(activeUserIds)})
              GROUP BY "userId", "commandName", "subcommand"
            `);

      stage = "build_report";
      const topCommandsByUser = buildTopCommands(commandRows);
      for (const [discordUserId, row] of users.entries()) {
        row.topCommands = topCommandsByUser.get(discordUserId) ?? [];
      }

      const sortedUsers = sortReportUsers([...users.values()]);
      const visibleUsers = sortedUsers.slice(0, limit);

      return {
        guildId,
        start,
        end,
        duration,
        totalUsers: sortedUsers.length,
        visibleUsers: visibleUsers.length,
        limit,
        users: visibleUsers,
      };
    } catch (error) {
      logBuildFailure({
        guildId,
        since: input.since,
        start,
        end,
        stage,
        error,
      });
      throw error;
    }
  }
}

export const repWorkReportService = new RepWorkReportService();
