import { Prisma, RepWorkActivityType } from "@prisma/client";
import { EmbedBuilder } from "discord.js";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { TRACKED_MESSAGE_FEATURE_TYPE } from "./TrackedMessageService";

const DEFAULT_RESULT_LIMIT = 15;
const MAX_RESULT_LIMIT = 15;
const MAX_DURATION_DAYS = 18 * 30;
const MIN_DURATION_DAYS = 1;

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
  mailsAvgPrepTimeLeftSeconds: number | null;
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
    mailsAvgPrepTimeLeftSeconds: null,
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
    if (b.mailsChecked !== a.mailsChecked) return b.mailsChecked - a.mailsChecked;
    if (b.clanClaims !== a.clanClaims) return b.clanClaims - a.clanClaims;
    if (b.syncsParticipated !== a.syncsParticipated) return b.syncsParticipated - a.syncsParticipated;
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

export function buildRepWorkReportEmbed(report: RepWorkReport): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Rep Work Stats")
    .setDescription(
      `Window: <t:${Math.trunc(report.start.getTime() / 1000)}:f> -> <t:${Math.trunc(report.end.getTime() / 1000)}:f>`,
    )
    .setColor(0x57f287);

  if (report.users.length === 0) {
    embed.addFields({
      name: "No activity",
      value: "No rep-work activity found in this window.",
      inline: false,
    });
    embed.setFooter({ text: `Since ${report.duration.label} | Showing 0 of 0 users` });
    return embed;
  }

  for (const row of report.users) {
    const topCommands =
      row.topCommands.length > 0
        ? row.topCommands.map((command) => `\`${command.label}\` ${command.totalCount}`).join(", ")
        : "none";
    embed.addFields({
      name: `<@${row.discordUserId}>`,
      value: [
        `Bases: ${row.basesChecked} (${formatPrepTimeLeft(row.basesAvgPrepTimeLeftSeconds)})`,
        `Syncs: ${row.syncsParticipated} participated | ${row.clanClaims} clan claims`,
        `Mails: ${row.mailsChecked} (${formatPrepTimeLeft(row.mailsAvgPrepTimeLeftSeconds)})`,
        `Top cmds: ${topCommands}`,
      ].join("\n"),
      inline: false,
    });
  }

  const footer =
    report.totalUsers > report.visibleUsers
      ? `Since ${report.duration.label} | Showing top ${report.visibleUsers} of ${report.totalUsers} users`
      : `Since ${report.duration.label} | Showing ${report.visibleUsers} users`;
  embed.setFooter({ text: footer });
  return embed;
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
          user.mailsAvgPrepTimeLeftSeconds =
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
        if (!discordUserId || !trackedMessageId || !clanTag) continue;
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
