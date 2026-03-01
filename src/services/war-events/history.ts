import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { CoCService } from "../CoCService";
import {
  type EventType,
  type FwaLoseStyle,
  type MatchType,
  type WarComplianceSnapshot,
  type WarEndResultSnapshot,
  computeWarComplianceForTest,
  computeWarPointsDeltaForTest,
  normalizeTag,
  parseCocTime,
} from "./core";

/** Purpose: encapsulate war-end history, compliance, and war-plan related logic. */
export class WarEventHistoryService {
  /** Purpose: initialize war history service dependencies. */
  constructor(private readonly coc: CoCService) {}

  /** Purpose: build the war-end points line text shown in event embeds. */
  buildWarEndPointsLine(
    payload: {
      clanName: string;
      matchType: MatchType;
      warStartFwaPoints: number | null;
      warEndFwaPoints: number | null;
    },
    finalResult: WarEndResultSnapshot
  ): string {
    const before = payload.warStartFwaPoints;
    const delta = this.computeWarPointsDelta({
      matchType: payload.matchType,
      before,
      after: payload.warEndFwaPoints,
      finalResult,
    });

    if (payload.matchType === "BL") {
      const afterFromRow = payload.warEndFwaPoints;
      const after =
        afterFromRow !== null && Number.isFinite(afterFromRow)
          ? afterFromRow
          : before !== null && Number.isFinite(before) && delta !== null
            ? before + delta
            : null;
      const resolvedBefore =
        before !== null && Number.isFinite(before)
          ? before
          : after !== null && Number.isFinite(after) && delta !== null
            ? after - delta
            : null;
      return `${payload.clanName}: ${resolvedBefore ?? "unknown"} -> ${after ?? "unknown"} (${delta !== null && delta >= 0 ? `+${delta}` : String(delta ?? "unknown")}) [BL]`;
    }

    const after = payload.warEndFwaPoints;
    if (
      before !== null &&
      Number.isFinite(before) &&
      after !== null &&
      Number.isFinite(after)
    ) {
      return `${payload.clanName}: ${before} -> ${after} (${delta !== null && delta >= 0 ? `+${delta}` : String(delta ?? after - before)})`;
    }
    return `${payload.clanName}: ${before ?? "unknown"} -> ${after ?? "unknown"}`;
  }

  /** Purpose: build per-clan war-plan instruction text for start/battle embeds. */
  async buildWarPlanText(
    matchType: MatchType,
    expectedOutcome: "WIN" | "LOSE" | null,
    clanTag: string
  ): Promise<string | null> {
    if (matchType !== "FWA") return null;
    if (expectedOutcome === "WIN") {
      return [
        "Win plan: if clan stars are under 100 and time remaining is over 12h,",
        "one attack must be a 3-star on mirror. Other attack can be 3-star on already-tripled base,",
        "or 2-star/1-star any base. Outside that window, free hit plan applies.",
      ].join(" ");
    }
    if (expectedOutcome === "LOSE") {
      const loseStyle = await this.getLoseStyleForClan(normalizeTag(clanTag));
      if (loseStyle === "TRIPLE_TOP_30") {
        return "Lose plan (Triple Top 30): hit only top 30 bases with both attacks; do not hit bottom 20.";
      }
      return [
        "Lose plan (Traditional): when under 12h remaining, do mirror 2-star plus non-mirror 1-star.",
        "Before that, do 1-star/2-star hits while keeping clan stars at or under 100.",
      ].join(" ");
    }
    return "FWA plan unavailable (expected outcome unknown).";
  }

  /** Purpose: persist clan-level war-end summary and full attack payload into history/lookup tables. */
  async persistWarEndHistory(payload: {
    eventType: EventType;
    clanTag: string;
    clanName: string;
    opponentTag: string;
    opponentName: string;
    syncNumber: number | null;
    notifyRole: string | null;
    fwaPoints: number | null;
    opponentFwaPoints: number | null;
    outcome: "WIN" | "LOSE" | null;
    matchType: MatchType;
    warStartFwaPoints: number | null;
    warEndFwaPoints: number | null;
    lastClanStars: number | null;
    lastOpponentStars: number | null;
    warStartTime: Date | null;
  }): Promise<void> {
    if (payload.eventType !== "war_ended") return;

    const clanTag = normalizeTag(payload.clanTag);
    const warStartTime =
      payload.warStartTime ??
      (
        await prisma.warHistoryParticipant.findFirst({
          where: { clanTag, warEndTime: { not: null } },
          orderBy: { warStartTime: "desc" },
          select: { warStartTime: true },
        })
      )?.warStartTime ??
      null;
    if (!warStartTime) return;

    const finalResult = await this.getWarEndResultSnapshot({
      clanTag: payload.clanTag,
      opponentTag: payload.opponentTag,
      fallbackClanStars: payload.lastClanStars,
      fallbackOpponentStars: payload.lastOpponentStars,
      warStartTime,
    });
    const attacks = await prisma.warHistoryAttack.findMany({
      where: { clanTag, warStartTime },
      orderBy: [{ attackSeenAt: "asc" }, { attackOrder: "asc" }, { playerTag: "asc" }],
    });
    const warEndTime =
      finalResult.warEndTime ??
      (await prisma.warHistoryParticipant.findFirst({
        where: { clanTag, warStartTime },
        orderBy: { updatedAt: "desc" },
        select: { warEndTime: true },
      }))?.warEndTime ??
      null;

    const pointsDelta = this.computeWarPointsDelta({
      matchType: payload.matchType,
      before: payload.warStartFwaPoints,
      after: payload.warEndFwaPoints,
      finalResult,
    });
    const enemyPoints =
      payload.matchType === "FWA" &&
      payload.opponentFwaPoints !== null &&
      Number.isFinite(payload.opponentFwaPoints)
        ? payload.opponentFwaPoints
        : null;

    const row = await prisma.$queryRaw<Array<{ warId: number }>>(
      Prisma.sql`
        INSERT INTO "WarClanHistory"
          ("syncNumber","matchType","clanStars","clanDestruction","opponentStars","opponentDestruction","fwaPointsGained","expectedOutcome","actualOutcome","enemyPoints","warStartTime","warEndTime","clanName","clanTag","opponentName","opponentTag","updatedAt")
        VALUES
          (${payload.syncNumber}, ${payload.matchType}, ${finalResult.clanStars}, ${finalResult.clanDestruction}, ${finalResult.opponentStars}, ${finalResult.opponentDestruction}, ${pointsDelta}, ${payload.outcome}, ${finalResult.resultLabel}, ${enemyPoints}, ${warStartTime}, ${warEndTime}, ${payload.clanName}, ${clanTag}, ${payload.opponentName}, ${normalizeTag(payload.opponentTag) || null}, NOW())
        ON CONFLICT ("clanTag","warStartTime")
        DO UPDATE SET
          "syncNumber" = EXCLUDED."syncNumber",
          "matchType" = EXCLUDED."matchType",
          "clanStars" = EXCLUDED."clanStars",
          "clanDestruction" = EXCLUDED."clanDestruction",
          "opponentStars" = EXCLUDED."opponentStars",
          "opponentDestruction" = EXCLUDED."opponentDestruction",
          "fwaPointsGained" = EXCLUDED."fwaPointsGained",
          "expectedOutcome" = EXCLUDED."expectedOutcome",
          "actualOutcome" = EXCLUDED."actualOutcome",
          "enemyPoints" = EXCLUDED."enemyPoints",
          "warEndTime" = EXCLUDED."warEndTime",
          "clanName" = EXCLUDED."clanName",
          "opponentName" = EXCLUDED."opponentName",
          "opponentTag" = EXCLUDED."opponentTag",
          "updatedAt" = NOW()
        RETURNING "warId"
      `
    );
    const warId = Number(row[0]?.warId ?? NaN);
    if (!Number.isFinite(warId)) return;

    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "WarLookup" ("warId","payload","updatedAt")
        VALUES (${warId}, ${JSON.stringify(attacks)}::jsonb, NOW())
        ON CONFLICT ("warId")
        DO UPDATE SET
          "payload" = EXCLUDED."payload",
          "updatedAt" = NOW()
      `
    );
  }

  /** Purpose: resolve final result snapshot from war log with fallbacks. */
  async getWarEndResultSnapshot(input: {
    clanTag: string;
    opponentTag: string;
    fallbackClanStars: number | null;
    fallbackOpponentStars: number | null;
    warStartTime: Date | null;
  }): Promise<WarEndResultSnapshot> {
    const log = await this.coc.getClanWarLog(input.clanTag, 10);
    const normalizedOpponentTag = normalizeTag(input.opponentTag);

    const matched =
      log.find((entry) => normalizeTag(entry.opponent?.tag ?? "") === normalizedOpponentTag) ??
      log[0] ??
      null;

    const clanStars =
      Number.isFinite(Number(matched?.clan?.stars))
        ? Number(matched?.clan?.stars)
        : input.fallbackClanStars;
    const opponentStars =
      Number.isFinite(Number(matched?.opponent?.stars))
        ? Number(matched?.opponent?.stars)
        : input.fallbackOpponentStars;
    const clanDestruction = Number.isFinite(Number(matched?.clan?.destructionPercentage))
      ? Number(matched?.clan?.destructionPercentage)
      : null;
    const opponentDestruction = Number.isFinite(Number(matched?.opponent?.destructionPercentage))
      ? Number(matched?.opponent?.destructionPercentage)
      : null;
    const warEndTime = parseCocTime(matched?.endTime ?? null);

    let resultLabel: "WIN" | "LOSE" | "TIE" | "UNKNOWN" = "UNKNOWN";
    if (clanStars !== null && opponentStars !== null) {
      resultLabel = clanStars > opponentStars ? "WIN" : clanStars < opponentStars ? "LOSE" : "TIE";
    } else if (matched?.result) {
      const result = String(matched.result).toLowerCase();
      if (result.includes("win")) resultLabel = "WIN";
      else if (result.includes("lose")) resultLabel = "LOSE";
      else if (result.includes("tie")) resultLabel = "TIE";
    }

    return {
      clanStars,
      opponentStars,
      clanDestruction,
      opponentDestruction,
      warEndTime,
      resultLabel,
    };
  }

  /** Purpose: compute missed-both and not-following-plan member lists for the target war. */
  async getWarComplianceSnapshot(
    clanTagInput: string,
    preferredWarStartTime: Date | null,
    matchType: MatchType,
    expectedOutcome: "WIN" | "LOSE" | null
  ): Promise<WarComplianceSnapshot> {
    if (matchType === "BL" || matchType === "MM") {
      return { missedBoth: [], notFollowingPlan: [] };
    }
    const clanTag = normalizeTag(clanTagInput);
    const warStartTime = preferredWarStartTime
      ? preferredWarStartTime
      : (
          await prisma.warHistoryParticipant.findFirst({
            where: { clanTag, warEndTime: { not: null } },
            orderBy: { warStartTime: "desc" },
            select: { warStartTime: true },
          })
        )?.warStartTime ?? null;
    if (!warStartTime) {
      return { missedBoth: [], notFollowingPlan: [] };
    }

    const participants = await prisma.warHistoryParticipant.findMany({
      where: { clanTag, warStartTime },
      select: { playerName: true, playerTag: true, attacksUsed: true, playerPosition: true },
      orderBy: [{ playerPosition: "asc" }, { playerName: "asc" }],
    });
    const attacks = await prisma.warHistoryAttack.findMany({
      where: { clanTag, warStartTime },
      select: {
        playerTag: true,
        playerName: true,
        playerPosition: true,
        defenderPosition: true,
        stars: true,
        trueStars: true,
        attackSeenAt: true,
        warEndTime: true,
        attackOrder: true,
      },
      orderBy: [{ attackSeenAt: "asc" }, { attackOrder: "asc" }, { playerTag: "asc" }],
    });
    const loseStyle = await this.getLoseStyleForClan(clanTag);
    return computeWarComplianceForTest({
      clanTag,
      participants,
      attacks,
      matchType,
      expectedOutcome,
      loseStyle,
    });
  }

  /** Purpose: read configured lose-war style for a tracked clan. */
  private async getLoseStyleForClan(clanTagInput: string): Promise<FwaLoseStyle> {
    const clanTag = normalizeTag(clanTagInput);
    if (!clanTag) return "TRIPLE_TOP_30";
    const row = await prisma.trackedClan.findUnique({
      where: { tag: clanTag },
      select: { loseStyle: true },
    });
    const loseStyle = String(row?.loseStyle ?? "").toUpperCase();
    if (loseStyle === "TRADITIONAL" || loseStyle === "TRIPLE_TOP_30") {
      return loseStyle;
    }
    return "TRIPLE_TOP_30";
  }

  /** Purpose: delegate war-end points delta calculation to shared core logic. */
  private computeWarPointsDelta(input: {
    matchType: MatchType;
    before: number | null;
    after: number | null;
    finalResult: WarEndResultSnapshot;
  }): number | null {
    return computeWarPointsDeltaForTest(input);
  }
}

