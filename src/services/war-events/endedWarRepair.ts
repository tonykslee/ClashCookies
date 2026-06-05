import { prisma as defaultPrisma } from "../../prisma";
import {
  normalizeOutcome,
  normalizeTag,
  type MatchType,
} from "./core";
import {
  resolveFwaMatchChecklistViewType,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
} from "../TrackedMessageService";

export const KNOWN_AFFECTED_ENDED_WAR_CLANS = [
  "#9GLGQCCU",
  "#LQQ99UV8",
] as const;

type CurrentWarRow = {
  clanTag: string;
  guildId: string;
  startTime: Date | null;
  opponentTag: string | null;
  matchType: MatchType;
  outcome: string | null;
  warEndFwaPoints: number | null;
};

type CurrentWarHistoryRow = {
  matchType: MatchType;
  expectedOutcome: string | null;
  actualOutcome: string | null;
  pointsAfterWar: number | null;
  warStartTime: Date;
};

type TrackedMessageRow = {
  guildId: string;
  channelId: string;
  messageId: string;
  clanTag: string | null;
  metadata: unknown;
};

export type EndedWarRepairLogger = Pick<
  Console,
  "log" | "warn" | "error"
>;

export type EndedWarRepairDb = {
  currentWar: {
    findMany: (args: any) => Promise<CurrentWarRow[]>;
    update: (args: any) => Promise<unknown>;
  };
  clanWarHistory: {
    findFirst: (args: any) => Promise<CurrentWarHistoryRow | null>;
  };
  trackedMessage?: {
    findMany: (args: any) => Promise<TrackedMessageRow[]>;
  } | null;
};

export type RepairEndedWarRowsInput = {
  apply?: boolean;
  clanTags?: string[];
  knownAffectedOnly?: boolean;
  logger?: EndedWarRepairLogger;
  now?: Date;
  db?: EndedWarRepairDb;
};

export type RepairEndedWarRowsSummary = {
  mode: "dry-run" | "apply";
  scanned: number;
  mismatched: number;
  repaired: number;
  skipped: number;
  errors: number;
  missingHistory: number;
  refreshTargets: number;
};

function normalizeScopeTags(input: RepairEndedWarRowsInput): string[] {
  const explicit = (input.clanTags ?? [])
    .map((tag) => normalizeTag(tag))
    .filter(Boolean);
  if (explicit.length > 0) return Array.from(new Set(explicit));
  if (input.knownAffectedOnly) {
    return Array.from(KNOWN_AFFECTED_ENDED_WAR_CLANS);
  }
  return [];
}

function normalizeNullablePoints(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Math.trunc(Number(value))
    : null;
}

function stringifyOutcome(value: string | null | undefined): "WIN" | "LOSE" | null {
  return normalizeOutcome(value);
}

function formatRepairContext(row: CurrentWarRow, repair: CurrentWarHistoryRow | null) {
  return {
    clanTag: normalizeTag(row.clanTag),
    opponentTag: normalizeTag(row.opponentTag ?? ""),
    warStartTime: row.startTime instanceof Date ? row.startTime.toISOString() : null,
    current: {
      matchType: row.matchType ?? null,
      outcome: stringifyOutcome(row.outcome),
      warEndFwaPoints: normalizeNullablePoints(row.warEndFwaPoints),
    },
    canonical: repair
      ? {
          matchType: repair.matchType ?? null,
          outcome: stringifyOutcome(
            repair.expectedOutcome ?? repair.actualOutcome ?? null,
          ),
          warEndFwaPoints: normalizeNullablePoints(repair.pointsAfterWar),
        }
      : null,
  };
}

async function findChecklistRefreshTargets(params: {
  db: EndedWarRepairDb;
  clans: string[];
}): Promise<
  Array<{
    guildId: string;
    channelId: string;
    messageId: string;
    clanTag: string;
    viewType: "Mail" | "Bases";
  }>
> {
  if (!params.db.trackedMessage || params.clans.length === 0) return [];
  const rows = await params.db.trackedMessage.findMany({
    where: {
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
      clanTag: { in: params.clans },
    },
    select: {
      guildId: true,
      channelId: true,
      messageId: true,
      clanTag: true,
      metadata: true,
    },
  });
  return rows.map((row) => ({
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    clanTag: normalizeTag(row.clanTag ?? "") || row.clanTag || "unknown",
    viewType: resolveFwaMatchChecklistViewType(row.metadata),
  }));
}

export async function repairEndedWarRows(
  input: RepairEndedWarRowsInput = {},
): Promise<RepairEndedWarRowsSummary> {
  const db = input.db ?? {
    currentWar: defaultPrisma.currentWar,
    clanWarHistory: defaultPrisma.clanWarHistory,
    trackedMessage: defaultPrisma.trackedMessage,
  };
  const logger = input.logger ?? console;
  const apply = Boolean(input.apply);
  const scopeTags = normalizeScopeTags(input);
  const currentWars = await db.currentWar.findMany({
    where: {
      state: "notInWar",
      ...(scopeTags.length > 0 ? { clanTag: { in: scopeTags } } : {}),
    },
    orderBy: [{ clanTag: "asc" }, { startTime: "asc" }],
    select: {
      clanTag: true,
      guildId: true,
      startTime: true,
      opponentTag: true,
      matchType: true,
      outcome: true,
      warEndFwaPoints: true,
    },
  });

  const summary: RepairEndedWarRowsSummary = {
    mode: apply ? "apply" : "dry-run",
    scanned: 0,
    mismatched: 0,
    repaired: 0,
    skipped: 0,
    errors: 0,
    missingHistory: 0,
    refreshTargets: 0,
  };
  const repairedClanTags = new Set<string>();

  for (const row of currentWars) {
    summary.scanned += 1;
    try {
      const clanTag = normalizeTag(row.clanTag);
      const opponentTag = normalizeTag(row.opponentTag ?? "");
      const startTime = row.startTime instanceof Date ? row.startTime : null;
      if (!clanTag || !opponentTag || !startTime) {
        summary.skipped += 1;
        continue;
      }

      const history = await db.clanWarHistory.findFirst({
        where: {
          clanTag,
          opponentTag,
          warStartTime: startTime,
        },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          matchType: true,
          expectedOutcome: true,
          actualOutcome: true,
          pointsAfterWar: true,
          warStartTime: true,
        },
      });

      if (!history) {
        summary.skipped += 1;
        summary.missingHistory += 1;
        continue;
      }

      const canonicalMatchType = history.matchType ?? row.matchType ?? null;
      const canonicalOutcome = stringifyOutcome(
        history.expectedOutcome ?? history.actualOutcome ?? row.outcome,
      );
      const canonicalWarEndFwaPoints =
        normalizeNullablePoints(history.pointsAfterWar) ??
        normalizeNullablePoints(row.warEndFwaPoints);

      const currentMatchType = row.matchType ?? null;
      const currentOutcome = stringifyOutcome(row.outcome);
      const currentWarEndFwaPoints = normalizeNullablePoints(row.warEndFwaPoints);

      const mismatch =
        currentMatchType !== canonicalMatchType ||
        currentOutcome !== canonicalOutcome ||
        currentWarEndFwaPoints !== canonicalWarEndFwaPoints;

      if (!mismatch) {
        summary.skipped += 1;
        continue;
      }

      summary.mismatched += 1;
      repairedClanTags.add(clanTag);
      const context = formatRepairContext(row, history);
      logger.log(
        JSON.stringify({
          event: "ended_war_repair_candidate",
          mode: summary.mode,
          ...context,
        }),
      );

      if (!apply) continue;

      await db.currentWar.update({
        where: {
          clanTag_guildId: {
            clanTag: row.clanTag,
            guildId: row.guildId,
          },
        },
        data: {
          matchType: canonicalMatchType,
          outcome: canonicalOutcome,
          warEndFwaPoints: canonicalWarEndFwaPoints,
        },
      });
      summary.repaired += 1;
      logger.log(
        JSON.stringify({
          event: "ended_war_repaired",
          clanTag,
          opponentTag,
          warStartTime: startTime.toISOString(),
          before: context.current,
          after: context.canonical,
        }),
      );
    } catch (error) {
      summary.errors += 1;
      logger.error(
        JSON.stringify({
          event: "ended_war_repair_error",
          clanTag: row.clanTag,
          guildId: row.guildId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const refreshTargets = await findChecklistRefreshTargets({
    db,
    clans: Array.from(repairedClanTags),
  });
  summary.refreshTargets = refreshTargets.length;

  for (const target of refreshTargets) {
    logger.log(
      JSON.stringify({
        event: "ended_war_refresh_target",
        clanTag: target.clanTag,
        guildId: target.guildId,
        channelId: target.channelId,
        messageId: target.messageId,
        viewType: target.viewType,
        refreshPath:
          "Use the existing checklist refresh button or trackedMessageService.refreshFwaMatchChecklistMessage after the DB repair.",
      }),
    );
  }

  logger.log(
    JSON.stringify({
      event: "ended_war_repair_summary",
      ...summary,
    }),
  );

  return summary;
}
