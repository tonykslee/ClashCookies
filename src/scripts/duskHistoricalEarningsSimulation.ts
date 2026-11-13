import { PrismaClient } from "@prisma/client";
import {
  formatHistoricalDuskitsSimulationReport,
  simulateHistoricalDuskits,
  validateHistoricalSimulationScope,
  type CurrentRepAssignmentRow,
  type HistoricalEarningsSimulationInput,
  type HistoricalEarningsSimulationScope,
  type HistoricalEvaluationRow,
  type HistoricalParticipationRow,
  type HistoricalPlayerLinkRow,
  type HistoricalRepWorkEventRow,
  type HistoricalWarRow,
} from "../services/duskHistoricalEarningsSimulation";

type SimulationEnvironment = Record<string, string | undefined>;

export type SimulationDatabaseConfig = {
  url: string;
  expectedRole: string;
};

export type HistoricalSimulationDb = {
  clanWarHistory: { findMany: (args: unknown) => Promise<unknown[]> };
  clanWarParticipation: { findMany: (args: unknown) => Promise<unknown[]> };
  warPlanComplianceEvaluation: { findMany: (args: unknown) => Promise<unknown[]> };
  playerLink: { findMany: (args: unknown) => Promise<unknown[]> };
  repWorkActivityEvent: { findMany: (args: unknown) => Promise<unknown[]> };
  trackedClanRep: { findMany: (args: unknown) => Promise<unknown[]> };
};

function parseDate(value: string, flag: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(`${flag} requires an ISO-8601 date.`);
  return result;
}

/** Purpose: parse the explicit operator-selected guild and bounded UTC date window. */
export function parseDuskHistoricalSimulationArgs(argv: string[], now = new Date()): HistoricalEarningsSimulationScope {
  let guildId = "";
  let from: Date | undefined;
  let to: Date | undefined;
  let snapshotAt: Date | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--guild" || token === "--from" || token === "--to" || token === "--snapshot") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      index += 1;
      if (token === "--guild") guildId = value.trim();
      else if (token === "--from") from = parseDate(value, token);
      else if (token === "--to") to = parseDate(value, token);
      else snapshotAt = parseDate(value, token);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!guildId || !from || !to) throw new Error("Usage: npm run diagnose:dusk-historical-earnings -- --guild <guildId> --from <ISO> --to <ISO> [--snapshot <ISO>]");
  return { guildId, from, to, snapshotAt: snapshotAt ?? now };
}

/** Purpose: reject production/default credentials before Prisma can open a connection. */
export function validateSimulationDatabaseConfig(environment: SimulationEnvironment = process.env): SimulationDatabaseConfig {
  const url = environment.DUSK_SIMULATION_DATABASE_URL?.trim() ?? "";
  const productionUrl = environment.DATABASE_URL?.trim() ?? "";
  const expectedRole = environment.DUSK_SIMULATION_READ_ONLY_ROLE?.trim() ?? "";
  if (!url) throw new Error("DUSK_SIMULATION_DATABASE_URL is required; the simulation will not use DATABASE_URL implicitly.");
  if (productionUrl && url === productionUrl) throw new Error("DUSK_SIMULATION_DATABASE_URL must not equal DATABASE_URL.");
  if (!/^postgres(?:ql)?:\/\//i.test(url)) throw new Error("DUSK_SIMULATION_DATABASE_URL must be a PostgreSQL URL.");
  if (environment.DUSK_SIMULATION_READ_ONLY !== "1") throw new Error("Set DUSK_SIMULATION_READ_ONLY=1 to acknowledge the dedicated SELECT-only simulation connection.");
  if (!expectedRole) throw new Error("DUSK_SIMULATION_READ_ONLY_ROLE is required.");
  return { url, expectedRole };
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function date(value: unknown): Date | null {
  const result = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(result.getTime()) ? result : null;
}

function positive(value: unknown): number | null {
  const result = Number(value);
  return Number.isInteger(result) && result > 0 ? result : null;
}

function normalizeHistory(row: any): HistoricalWarRow | null {
  const warId = positive(row?.warId);
  const warStartTime = date(row?.warStartTime);
  const warEndTime = date(row?.warEndTime);
  if (!warId || !warStartTime || !warEndTime || !text(row?.clanTag)) return null;
  return {
    warId,
    matchType: row?.matchType == null ? null : text(row.matchType),
    clanTag: text(row.clanTag),
    opponentTag: row?.opponentTag == null ? null : text(row.opponentTag),
    warStartTime,
    warEndTime,
    createdAt: date(row?.createdAt) ?? warStartTime,
    updatedAt: date(row?.updatedAt) ?? warStartTime,
    participationCompleteness: "UNKNOWN",
  };
}

function normalizeParticipation(row: any): HistoricalParticipationRow | null {
  const warId = text(row?.warId);
  const warStartTime = date(row?.warStartTime);
  const warEndTime = date(row?.warEndTime);
  if (!text(row?.guildId) || !warId || !text(row?.clanTag) || !text(row?.playerTag) || !warStartTime || !warEndTime) return null;
  return {
    guildId: text(row.guildId),
    warId,
    clanTag: text(row.clanTag),
    opponentTag: row?.opponentTag == null ? null : text(row.opponentTag),
    playerTag: text(row.playerTag),
    attacksUsed: Number(row.attacksUsed),
    attacksMissed: Number(row.attacksMissed),
    matchType: text(row.matchType),
    warStartTime,
    warEndTime,
    createdAt: date(row?.createdAt) ?? warStartTime,
  };
}

function normalizeEvaluation(row: any): HistoricalEvaluationRow | null {
  const warId = positive(row?.warId);
  if (!text(row?.guildId) || !warId) return null;
  return {
    guildId: text(row.guildId),
    warId,
    status: text(row.status),
    completedAt: date(row?.completedAt),
    createdAt: date(row?.createdAt) ?? new Date(0),
    updatedAt: date(row?.updatedAt) ?? new Date(0),
    violations: Array.isArray(row?.violations)
      ? row.violations.map((violation: any) => ({ id: text(violation?.id), playerTag: text(violation?.playerTag) })).filter((violation: any) => violation.id && violation.playerTag)
      : [],
  };
}

function normalizePlayerLink(row: any): HistoricalPlayerLinkRow | null {
  if (!text(row?.playerTag)) return null;
  return {
    playerTag: text(row.playerTag),
    discordUserId: row?.discordUserId == null ? null : text(row.discordUserId),
    linkSource: text(row.linkSource),
    verificationStatus: text(row.verificationStatus),
    verificationMethod: row?.verificationMethod == null ? null : text(row.verificationMethod),
    verifiedAt: date(row?.verifiedAt),
    lastVerifiedAt: date(row?.lastVerifiedAt),
    createdAt: date(row?.createdAt) ?? new Date(0),
    updatedAt: date(row?.updatedAt) ?? new Date(0),
  };
}

function normalizeRepEvent(row: any): HistoricalRepWorkEventRow | null {
  const eventAt = date(row?.eventAt);
  if (!text(row?.guildId) || !text(row?.activityType) || !text(row?.discordUserId) || !text(row?.clanTag) || !text(row?.sourceMessageId) || !eventAt) return null;
  return {
    guildId: text(row.guildId),
    activityType: text(row.activityType),
    discordUserId: text(row.discordUserId),
    clanTag: text(row.clanTag),
    syncMessageId: row?.syncMessageId == null ? null : text(row.syncMessageId),
    sourceMessageId: text(row.sourceMessageId),
    warId: row?.warId == null ? null : text(row.warId),
    warStartTime: date(row?.warStartTime),
    eventAt,
    dedupeKey: text(row.dedupeKey),
    metadata: row?.metadata ?? null,
    createdAt: date(row?.createdAt) ?? eventAt,
    updatedAt: date(row?.updatedAt) ?? eventAt,
  };
}

/** Purpose: load only bounded, guild-owned evidence inside one read-only transaction. */
export async function loadHistoricalSimulationInput(
  db: HistoricalSimulationDb,
  scope: HistoricalEarningsSimulationScope,
): Promise<HistoricalEarningsSimulationInput> {
  const [participationRows, evaluationRows] = await Promise.all([
    db.clanWarParticipation.findMany({
      where: { guildId: scope.guildId, warEndTime: { gte: scope.from, lt: scope.to } },
      select: { guildId: true, warId: true, clanTag: true, opponentTag: true, playerTag: true, attacksUsed: true, attacksMissed: true, matchType: true, warStartTime: true, warEndTime: true, createdAt: true },
    }),
    db.warPlanComplianceEvaluation.findMany({
      where: { guildId: scope.guildId, warHistory: { warEndTime: { gte: scope.from, lt: scope.to } } },
      select: { guildId: true, warId: true, status: true, completedAt: true, createdAt: true, updatedAt: true, violations: { select: { id: true, playerTag: true } } },
    }),
  ]);

  const participation = participationRows.map(normalizeParticipation).filter((row): row is HistoricalParticipationRow => row !== null);
  const evaluations = evaluationRows.map(normalizeEvaluation).filter((row): row is HistoricalEvaluationRow => row !== null);
  const warIds = [...new Set([...participation.map((row) => Number(row.warId)), ...evaluations.map((row) => row.warId)].filter((warId) => Number.isInteger(warId) && warId > 0))];
  const histories = warIds.length === 0 ? [] : await db.clanWarHistory.findMany({
    where: { warId: { in: warIds }, warEndTime: { gte: scope.from, lt: scope.to } },
    select: { warId: true, matchType: true, clanTag: true, opponentTag: true, warStartTime: true, warEndTime: true, createdAt: true, updatedAt: true },
  });
  const wars = histories.map(normalizeHistory).filter((row): row is HistoricalWarRow => row !== null);
  const playerTags = [...new Set(participation.map((row) => row.playerTag))];
  const repUserIds = [...new Set((await db.repWorkActivityEvent.findMany({
    where: { guildId: scope.guildId, eventAt: { gte: scope.from, lt: scope.to } },
    select: { discordUserId: true },
  })).map((row: any) => text(row.discordUserId)).filter(Boolean))];
  const links = await db.playerLink.findMany({
    where: { OR: [{ playerTag: { in: playerTags } }, { discordUserId: { in: repUserIds } }] },
    select: { playerTag: true, discordUserId: true, linkSource: true, verificationStatus: true, verificationMethod: true, verifiedAt: true, lastVerifiedAt: true, createdAt: true, updatedAt: true },
  });
  const repEvents = await db.repWorkActivityEvent.findMany({
    where: { guildId: scope.guildId, eventAt: { gte: scope.from, lt: scope.to } },
    select: { guildId: true, activityType: true, discordUserId: true, clanTag: true, syncMessageId: true, sourceMessageId: true, warId: true, warStartTime: true, eventAt: true, dedupeKey: true, metadata: true, createdAt: true, updatedAt: true },
  });
  const normalizedLinks = links.map(normalizePlayerLink).filter((row): row is HistoricalPlayerLinkRow => row !== null);
  const normalizedRepEvents = repEvents.map(normalizeRepEvent).filter((row): row is HistoricalRepWorkEventRow => row !== null);
  const linkedTags = [...new Set(normalizedLinks.map((row) => row.playerTag))];
  const currentRepAssignments = linkedTags.length === 0 ? [] : (await db.trackedClanRep.findMany({
    where: { playerTag: { in: linkedTags } },
    select: { clanTag: true, playerTag: true },
  })).map((row: any): CurrentRepAssignmentRow => ({ clanTag: text(row.clanTag), playerTag: text(row.playerTag) }));
  return { scope, wars, participation, evaluations, playerLinks: normalizedLinks, repEvents: normalizedRepEvents, currentRepAssignments };
}

async function run(argv: string[]): Promise<void> {
  const scope = parseDuskHistoricalSimulationArgs(argv);
  validateHistoricalSimulationScope(scope);
  const config = validateSimulationDatabaseConfig();
  const client = new PrismaClient({ datasources: { db: { url: config.url } } });
  try {
    const report = await client.$transaction(async (tx) => {
      const safety = await tx.$queryRaw<Array<{ transactionReadOnly: string; currentUser: string }>>`SELECT current_setting('transaction_read_only') AS "transactionReadOnly", current_user AS "currentUser"`;
      const state = safety[0];
      if (!state || state.transactionReadOnly !== "on" || state.currentUser !== config.expectedRole) {
        throw new Error("Simulation connection failed read-only safety verification; no evidence queries were accepted.");
      }
      const input = await loadHistoricalSimulationInput(tx as unknown as HistoricalSimulationDb, scope);
      return simulateHistoricalDuskits(input);
    });
    process.stdout.write(`${formatHistoricalDuskitsSimulationReport(report)}\n`);
  } finally {
    await client.$disconnect();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`Historical Duskits simulation refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
