import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { CoCService } from "../CoCService";
import { PointsSyncService } from "../PointsSyncService";
import { WarComplianceService } from "../WarComplianceService";
import {
  type EventType,
  type FwaLoseStyle,
  type MatchType,
  type WarComplianceSnapshot,
  type WarEndResultSnapshot,
  computeWarPointsDeltaForTest,
  normalizeTag,
  parseCocTime,
} from "./core";

/** Purpose: encapsulate war-end history, compliance, and war-plan related logic. */
export class WarEventHistoryService {
  /** Purpose: initialize war history service dependencies. */
  constructor(
    private readonly coc: CoCService,
    private readonly pointsSync = new PointsSyncService(),
    private readonly compliance = new WarComplianceService()
  ) {}

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
    const _finalResult = finalResult;
    void _finalResult;
    const before =
      payload.warStartFwaPoints !== null && Number.isFinite(payload.warStartFwaPoints)
        ? Math.trunc(payload.warStartFwaPoints)
        : null;
    const after =
      payload.warEndFwaPoints !== null && Number.isFinite(payload.warEndFwaPoints)
        ? Math.trunc(payload.warEndFwaPoints)
        : null;
    if (before === null && after === null) {
      return `${payload.clanName}: unknown -> unknown (expected post-war points unavailable)`;
    }
    if (before === null || after === null) {
      return `${payload.clanName}: ${before ?? "unknown"} -> ${after ?? "unknown"}`;
    }
    const delta = after - before;
    const deltaText = delta >= 0 ? `+${delta}` : String(delta);
    if (payload.matchType === "BL") {
      return `${payload.clanName}: ${before} -> ${after} (${deltaText}) [BL]`;
    }
    if (payload.matchType === "MM") {
      return `${payload.clanName}: ${before} -> ${after} (+0) [MM]`;
    }
    return `${payload.clanName}: ${before} -> ${after} (${deltaText})`;
  }

  /** Purpose: resolve canonical persisted ended-war identity/metadata for downstream notify rendering. */
  async resolveCanonicalWarEndedContext(input: {
    clanTag: string;
    opponentTag: string | null | undefined;
    warStartTime: Date | null;
  }): Promise<{
    warId: number | null;
    syncNumber: number | null;
    clanName: string | null;
    opponentTag: string | null;
    opponentName: string | null;
    warStartTime: Date | null;
    warEndTime: Date | null;
  } | null> {
    const clanTag = normalizeTag(input.clanTag);
    if (!clanTag) return null;
    const opponentTag = normalizeTag(input.opponentTag ?? "");

    let row: {
      warId: number;
      syncNumber: number | null;
      clanName: string | null;
      opponentTag: string | null;
      opponentName: string | null;
      warStartTime: Date;
      warEndTime: Date | null;
    } | null = null;
    if (input.warStartTime) {
      row = await prisma.clanWarHistory.findFirst({
        where: {
          clanTag,
          warStartTime: input.warStartTime,
          ...(opponentTag ? { opponentTag } : {}),
        },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          warId: true,
          syncNumber: true,
          clanName: true,
          opponentTag: true,
          opponentName: true,
          warStartTime: true,
          warEndTime: true,
        },
      });
    }
    if (!row) {
      row = await prisma.clanWarHistory.findFirst({
        where: {
          clanTag,
          ...(opponentTag ? { opponentTag } : {}),
        },
        orderBy: [{ warEndTime: "desc" }, { warStartTime: "desc" }, { updatedAt: "desc" }],
        select: {
          warId: true,
          syncNumber: true,
          clanName: true,
          opponentTag: true,
          opponentName: true,
          warStartTime: true,
          warEndTime: true,
        },
      });
    }
    if (!row) return null;

    return {
      warId:
        row.warId !== null && row.warId !== undefined && Number.isFinite(Number(row.warId))
          ? Math.trunc(Number(row.warId))
          : null,
      syncNumber:
        row.syncNumber !== null && row.syncNumber !== undefined && Number.isFinite(Number(row.syncNumber))
          ? Math.trunc(Number(row.syncNumber))
          : null,
      clanName: row.clanName ?? null,
      opponentTag: normalizeTag(row.opponentTag ?? "") || null,
      opponentName: row.opponentName ?? null,
      warStartTime: row.warStartTime ?? null,
      warEndTime: row.warEndTime ?? null,
    };
  }

  /** Purpose: build per-clan war-plan instruction text for start/battle embeds. */
  async buildWarPlanText(
    guildIdOrMatchType: string | null | undefined,
    matchTypeOrExpectedOutcome: MatchType | "WIN" | "LOSE" | null,
    expectedOutcomeOrClanTag: "WIN" | "LOSE" | string | null,
    clanTagOrOpponentName?: string | null,
    opponentNameInput?: string | null,
    _phase: "prep" | "battle" = "battle",
    clanNameInput?: string | null,
    options?: { forcedLoseStyle?: FwaLoseStyle | null }
  ): Promise<string | null> {
    let guildId: string | null | undefined = guildIdOrMatchType;
    let matchType = matchTypeOrExpectedOutcome as MatchType;
    let expectedOutcome = expectedOutcomeOrClanTag as "WIN" | "LOSE" | null;
    let clanTag = clanTagOrOpponentName ?? "";
    let opponentNameInputResolved = opponentNameInput;

    const legacyMatchType = String(guildIdOrMatchType ?? "").toUpperCase();
    if (legacyMatchType === "FWA" || legacyMatchType === "BL" || legacyMatchType === "MM") {
      guildId = null;
      matchType = legacyMatchType as MatchType;
      expectedOutcome =
        matchTypeOrExpectedOutcome === "WIN" || matchTypeOrExpectedOutcome === "LOSE"
          ? matchTypeOrExpectedOutcome
          : null;
      clanTag = String(expectedOutcomeOrClanTag ?? "");
      opponentNameInputResolved = clanTagOrOpponentName ?? null;
    }

    const normalizedClanTag = normalizeTag(clanTag);
    const normalizedClanTagWithHash = normalizedClanTag || "";
    const normalizedClanTagBare = normalizedClanTag.replace(/^#/, "");
    const opponentName = String(opponentNameInputResolved ?? "").trim() || "Unknown";
    const clanName = String(clanNameInput ?? "").trim() || normalizedClanTagWithHash || "Our Clan";
    const applyPlaceholders = (planText: string): string =>
      planText.replace(/\{opponent\}/gi, opponentName).replace(/\{clan\}/gi, clanName);
    const forcedLoseStyle =
      options?.forcedLoseStyle === "TRADITIONAL" || options?.forcedLoseStyle === "TRIPLE_TOP_30"
        ? options.forcedLoseStyle
        : null;
    let loseStyleCache: FwaLoseStyle | null = null;
    const getLoseStyle = async (): Promise<FwaLoseStyle> => {
      if (forcedLoseStyle) return forcedLoseStyle;
      if (!loseStyleCache) {
        loseStyleCache = await this.getLoseStyleForClan(normalizedClanTag);
      }
      return loseStyleCache;
    };
    if (guildId) {
      const matchTypeKey: "FWA" | "BL" | "MM" =
        matchType === "BL" || matchType === "MM" || matchType === "FWA" ? matchType : "FWA";
      const outcomeKey =
        matchTypeKey === "FWA"
          ? expectedOutcome === "WIN" || expectedOutcome === "LOSE"
            ? expectedOutcome
            : "ANY"
          : "ANY";
      const loseStyle =
        matchTypeKey === "FWA" && outcomeKey === "LOSE" ? await getLoseStyle() : "ANY";
      const loseStyleKey =
        matchTypeKey === "FWA" && outcomeKey === "LOSE"
          ? loseStyle
          : "ANY";
      try {
        const customPlan = await prisma.clanWarPlan.findFirst({
          where: {
            guildId,
            scope: "CUSTOM",
            OR: [
              { clanTag: { equals: normalizedClanTagWithHash, mode: "insensitive" } },
              { clanTag: { equals: normalizedClanTagBare, mode: "insensitive" } },
            ],
            matchType: matchTypeKey,
            outcome: outcomeKey,
            loseStyle: { in: [loseStyleKey, "ANY"] },
          },
          orderBy: [{ loseStyle: "desc" }],
          select: {
            planText: true,
          },
        });
        if (customPlan?.planText && customPlan.planText.trim().length > 0) {
          return applyPlaceholders(customPlan.planText);
        }

        const defaultPlan = await prisma.clanWarPlan.findFirst({
          where: {
            guildId,
            scope: "DEFAULT",
            clanTag: "",
            matchType: matchTypeKey,
            outcome: outcomeKey,
            loseStyle: { in: [loseStyleKey, "ANY"] },
          },
          orderBy: [{ loseStyle: "desc" }],
          select: {
            planText: true,
          },
        });
        if (defaultPlan?.planText && defaultPlan.planText.trim().length > 0) {
          return applyPlaceholders(defaultPlan.planText);
        }
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          (error.code !== "P2021" && error.code !== "P2022")
        ) {
          throw error;
        }
      }
    }

    if (matchType === "BL") {
      return [
        `# \u26ab\ufe0f ${clanName} vs ${opponentName} \ud83c\udff4\u200d\u2620\ufe0f`,
        "Everyone switch to WAR BASES!!",
        "This is our opportunity to gain some extra FWA points!",
        "\u2795 30+ people switch to war base = +1 point",
        "\u2795 60% total destruction = +1 point",
        "\u2795 win war = +1 point",
        "---",
        "If you need war base, check https://clashofclans-layouts.com/ or bases",
      ].join("\n");
    }

    if (matchType === "MM") {
      return [
        `# \u26aa\ufe0f ${clanName} vs ${opponentName} :sob:`,
        "Keep WA base active, attack what you can!",
      ].join("\n");
    }

    if (matchType !== "FWA") return null;
    if (expectedOutcome === "WIN") {
      return [
        `# \ud83d\udfe2 ${clanName} vs ${opponentName} \ud83d\udc9a`,
        "\ud83d\udde1\ufe0f 1st Attack: \u2605 \u2605 \u2605 -> Mirror",
        "\ud83d\udde1\ufe0f 2nd Attack: \u2605 \u2605 \u2606 -> any",
        "\u231b\ufe0f Only after 101+ stars -> Attack ANY base",
      ].join("\n");
    }
    if (expectedOutcome === "LOSE") {
      const loseStyle = await getLoseStyle();
      if (loseStyle === "TRIPLE_TOP_30") {
        return [
          `# \ud83d\udd34 ${clanName} vs ${opponentName} \u2764\ufe0f`,
          "\ud83d\udde1\ufe0f Attack any of the top 30 bases for 1-3 stars",
          "\ud83d\udeab Do NOT attack the bottom 20 bases",
          "\ud83c\udfaf Goal is 90 stars (do not cross)",
        ].join("\n");
      }
      return [
        `# \ud83d\udd34 ${clanName} vs ${opponentName} \u2764\ufe0f`,
        "\ud83d\udde1\ufe0f 1st Attack: \u2605 \u2605 \u2606 -> Mirror",
        "\ud83d\udde1\ufe0f 2nd Attack: \u2605 \u2606 \u2606 -> any",
        "\u23f3 Last 12hrs: \u2605 \u2605 \u2606 -> any",
        "\ud83c\udfaf Do NOT surpass 100 \u2605",
      ].join("\n");
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
    clanStars: number | null;
    opponentStars: number | null;
    prepStartTime: Date | null;
    warStartTime: Date | null;
  }): Promise<void> {
    if (payload.eventType !== "war_ended") return;

    const clanTag = normalizeTag(payload.clanTag);
    const warStartTime =
      payload.warStartTime ??
      (
        await prisma.warAttacks.findFirst({
          where: { clanTag, warEndTime: { not: null }, attackOrder: 0 },
          orderBy: { warStartTime: "desc" },
          select: { warStartTime: true },
        })
      )?.warStartTime ??
      null;
    if (!warStartTime) return;

    const finalResult = await this.getWarEndResultSnapshot({
      clanTag: payload.clanTag,
      opponentTag: payload.opponentTag,
      fallbackClanStars: payload.clanStars,
      fallbackOpponentStars: payload.opponentStars,
      warStartTime,
    });
    const attacks = await prisma.warAttacks.findMany({
      where: { clanTag, warStartTime },
      orderBy: [{ attackSeenAt: "asc" }, { attackOrder: "asc" }, { playerTag: "asc" }],
    });
    const warEndTime =
      finalResult.warEndTime ??
      (await prisma.warAttacks.findFirst({
        where: { clanTag, warStartTime, attackOrder: 0 },
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
    const resolvedPointsAfterWar =
      payload.warEndFwaPoints !== null && Number.isFinite(payload.warEndFwaPoints)
        ? payload.warEndFwaPoints
        : payload.warStartFwaPoints !== null &&
            Number.isFinite(payload.warStartFwaPoints) &&
            pointsDelta !== null &&
            Number.isFinite(pointsDelta)
          ? payload.warStartFwaPoints + pointsDelta
          : null;
    const resolvedActualOutcome: "WIN" | "LOSE" | "TIE" | "UNKNOWN" =
      finalResult.resultLabel === "UNKNOWN" && payload.outcome
        ? payload.outcome
        : finalResult.resultLabel;

    const row = await prisma.$queryRaw<Array<{ warId: number }>>(
      Prisma.sql`
        INSERT INTO "ClanWarHistory"
          ("syncNumber","matchType","clanStars","clanDestruction","opponentStars","opponentDestruction","pointsAfterWar","expectedOutcome","actualOutcome","prepStartTime","warStartTime","warEndTime","clanName","clanTag","opponentName","opponentTag","updatedAt")
        VALUES
          (${payload.syncNumber}, CAST(${payload.matchType} AS "WarMatchType"), ${finalResult.clanStars}, ${finalResult.clanDestruction}, ${finalResult.opponentStars}, ${finalResult.opponentDestruction}, ${resolvedPointsAfterWar}, ${payload.outcome}, ${resolvedActualOutcome}, ${payload.prepStartTime}, ${warStartTime}, ${warEndTime}, ${payload.clanName}, ${clanTag}, ${payload.opponentName}, ${normalizeTag(payload.opponentTag) || null}, NOW())
        ON CONFLICT ("warStartTime","clanTag","opponentTag")
        DO UPDATE SET
          "syncNumber" = EXCLUDED."syncNumber",
          "matchType" = EXCLUDED."matchType",
          "clanStars" = EXCLUDED."clanStars",
          "clanDestruction" = EXCLUDED."clanDestruction",
          "opponentStars" = EXCLUDED."opponentStars",
          "opponentDestruction" = EXCLUDED."opponentDestruction",
          "pointsAfterWar" = EXCLUDED."pointsAfterWar",
          "expectedOutcome" = EXCLUDED."expectedOutcome",
          "actualOutcome" = COALESCE(EXCLUDED."actualOutcome", "ClanWarHistory"."actualOutcome", EXCLUDED."expectedOutcome", 'UNKNOWN'),
          "prepStartTime" = EXCLUDED."prepStartTime",
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

    // Normalize ended-war rows to carry resolved warId before archive/delete lifecycle.
    await prisma.warAttacks.updateMany({
      where: { clanTag, warStartTime },
      data: { warId },
    });
    await prisma.currentWar.updateMany({
      where: { clanTag, startTime: warStartTime, warId: null },
      data: { warId },
    });
    await this.pointsSync.attachWarId({
      clanTag,
      warStartTime,
      warId: String(warId),
    });

    const currentSnapshot = await prisma.currentWar.findFirst({
      where: { clanTag, startTime: warStartTime },
      select: {
        guildId: true,
        inferredMatchType: true,
        matchType: true,
        state: true,
        clanName: true,
        opponentTag: true,
        opponentName: true,
        startTime: true,
        endTime: true,
      },
    });
    const syncRow = currentSnapshot?.guildId
      ? await this.pointsSync.getCurrentSyncForClan({
          guildId: currentSnapshot.guildId,
          clanTag,
          warId: String(warId),
          warStartTime,
        })
      : null;
    const participants = attacks.filter((a) => Number(a.attackOrder) === 0);
    const teamSize = participants.length > 0 ? participants.length : null;
    const pointsAwarded =
      payload.warStartFwaPoints !== null &&
      Number.isFinite(payload.warStartFwaPoints) &&
      resolvedPointsAfterWar !== null &&
      Number.isFinite(resolvedPointsAfterWar)
        ? resolvedPointsAfterWar - payload.warStartFwaPoints
        : pointsDelta;
    const attacksPayload = attacks
      .filter((a) => Number(a.attackOrder) > 0)
      .map((a) => ({
        attackerTag: a.playerTag,
        attackerName: a.playerName,
        attackerPosition: a.playerPosition,
        defenderTag: a.defenderTag,
        defenderName: a.defenderName,
        defenderPosition: a.defenderPosition,
        stars: a.stars,
        trueStars: a.trueStars,
        destruction: a.destruction,
        order: a.attackOrder,
        attackSeenAt: a.attackSeenAt instanceof Date ? a.attackSeenAt.toISOString() : null,
      }));
    const mirrorHits = attacksPayload.filter((a) => {
      const row = attacks.find(
        (x) =>
          x.playerTag === a.attackerTag &&
          x.defenderTag === a.defenderTag &&
          Number(x.attackOrder) === Number(a.order)
      );
      if (!row) return false;
      return (
        Number.isFinite(Number(row.playerPosition)) &&
        Number.isFinite(Number(row.defenderPosition)) &&
        Number(row.playerPosition) === Number(row.defenderPosition)
      );
    }).length;
    const nonMirrorHits = Math.max(0, attacksPayload.length - mirrorHits);
    const lookupPayload = {
      warMeta: {
        warId: String(warId),
        clanTag,
        opponentTag: normalizeTag(payload.opponentTag) || null,
        state: "warEnded",
        teamSize,
        startTime: warStartTime.toISOString(),
        endTime: warEndTime ? warEndTime.toISOString() : null,
        result: resolvedActualOutcome.toLowerCase(),
        synced: true,
      },
      score: {
        clanStars: finalResult.clanStars,
        opponentStars: finalResult.opponentStars,
        clanDestruction: finalResult.clanDestruction,
        opponentDestruction: finalResult.opponentDestruction,
      },
      fwa: {
        syncNumber: payload.syncNumber ?? syncRow?.syncNum ?? null,
        pointsAwarded: pointsAwarded ?? null,
        inferred: Boolean(currentSnapshot?.inferredMatchType),
        mismatch: payload.matchType === "MM",
        blacklist: payload.matchType === "BL",
      },
      clan: {
        tag: clanTag,
        name: payload.clanName ?? currentSnapshot?.clanName ?? clanTag,
        members: participants.map((p) => ({
          tag: p.playerTag,
          name: p.playerName,
          mapPosition: p.playerPosition,
          townHall: null,
        })),
      },
      opponent: {
        tag: normalizeTag(payload.opponentTag) || currentSnapshot?.opponentTag || null,
        name: payload.opponentName ?? currentSnapshot?.opponentName ?? null,
        members: Array.from(
          new Map(
            attacks
              .filter((a) => Number(a.attackOrder) > 0 && a.defenderTag)
              .map((a) => [
                a.defenderTag,
                {
                  tag: a.defenderTag,
                  name: a.defenderName,
                  mapPosition: a.defenderPosition,
                  townHall: null,
                },
              ])
          ).values()
        ),
      },
      attacks: attacksPayload,
      compliance: {
        mirrorHits,
        nonMirrorHits,
        lateHits: 0,
        violations: [] as string[],
      },
    };
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "WarLookup" ("warId","clanTag","opponentTag","startTime","endTime","result","payload","createdAt")
        VALUES (${String(warId)}, ${clanTag}, ${normalizeTag(payload.opponentTag) || null}, ${warStartTime}, ${warEndTime}, ${resolvedActualOutcome.toLowerCase()}, ${JSON.stringify(lookupPayload)}::jsonb, NOW())
        ON CONFLICT ("warId")
        DO UPDATE SET
          "clanTag" = EXCLUDED."clanTag",
          "opponentTag" = EXCLUDED."opponentTag",
          "startTime" = EXCLUDED."startTime",
          "endTime" = EXCLUDED."endTime",
          "result" = EXCLUDED."result",
          "payload" = EXCLUDED."payload"
      `
    );
    await this.persistWarParticipationSnapshot({
      guildId: currentSnapshot?.guildId ?? null,
      warId: String(warId),
      clanTag,
      opponentTag: normalizeTag(payload.opponentTag) || currentSnapshot?.opponentTag || null,
      warStartTime: currentSnapshot?.startTime ?? warStartTime,
      warEndTime: currentSnapshot?.endTime ?? warEndTime,
      matchType: currentSnapshot?.matchType ?? payload.matchType,
      participantRows: participants,
      attackRows: attacks.filter((a) => Number(a.attackOrder) > 0),
    });
    // Ephemeral lifecycle: archive complete, then clear active-war rows by warId.
    await prisma.warAttacks.deleteMany({
      where: { warId },
    });
    await prisma.currentWar.deleteMany({
      where: { warId },
    });
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
    return this.compliance.getComplianceSnapshot({
      clanTag: clanTagInput,
      preferredWarStartTime,
      matchType,
      expectedOutcome,
    });
  }

  /** Purpose: read configured lose-war style for a tracked clan. */
  private async getLoseStyleForClan(clanTagInput: string): Promise<FwaLoseStyle> {
    const clanTag = normalizeTag(clanTagInput);
    if (!clanTag) return "TRIPLE_TOP_30";
    const row = await prisma.trackedClan.findFirst({
      where: {
        OR: [
          { tag: { equals: `#${clanTag}`, mode: "insensitive" } },
          { tag: { equals: clanTag, mode: "insensitive" } },
        ],
      },
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

  /** Purpose: snapshot per-player war participation before current-war rows are deleted. */
  private async persistWarParticipationSnapshot(input: {
    guildId: string | null;
    warId: string;
    clanTag: string;
    opponentTag: string | null;
    warStartTime: Date;
    warEndTime: Date | null;
    matchType: MatchType | null;
    participantRows: Array<{
      playerTag: string;
      playerName: string | null;
      playerPosition: number | null;
      attacksUsed: number;
    }>;
    attackRows: Array<{
      playerTag: string;
      playerName: string | null;
      stars: number;
      trueStars: number;
      attackSeenAt: Date;
    }>;
  }): Promise<void> {
    if (!input.guildId) return;
    const guildId = input.guildId;

    const battleDayStartMs = input.warStartTime.getTime();
    const firstAttackWindowCloseMs = battleDayStartMs + 12 * 60 * 60 * 1000;
    const attacksByPlayer = new Map<string, typeof input.attackRows>();
    for (const row of input.attackRows) {
      const rows = attacksByPlayer.get(row.playerTag) ?? [];
      rows.push(row);
      attacksByPlayer.set(row.playerTag, rows);
    }

    const rows = input.participantRows.map((player) => {
      const attackRows = attacksByPlayer.get(player.playerTag) ?? [];
      const attacksUsed = attackRows.length;
      const firstAttackAt =
        attackRows.length > 0
          ? new Date(
              Math.min(
                ...attackRows.map((row) => row.attackSeenAt.getTime())
              )
            )
          : null;
      const attackDelayMinutes =
        firstAttackAt !== null
          ? Math.max(0, Math.floor((firstAttackAt.getTime() - battleDayStartMs) / 60000))
          : null;
      return {
        guildId,
        warId: input.warId,
        clanTag: input.clanTag,
        opponentTag: input.opponentTag,
        playerTag: player.playerTag,
        playerName: player.playerName?.trim() || attackRows[0]?.playerName?.trim() || player.playerTag,
        townHall: null,
        attacksUsed,
        attacksMissed: Math.max(0, 2 - attacksUsed),
        starsEarned: attackRows.reduce((sum, row) => sum + Number(row.stars || 0), 0),
        trueStars: attackRows.reduce((sum, row) => sum + Number(row.trueStars || 0), 0),
        missedBoth: attacksUsed === 0,
        firstAttackAt,
        attackDelayMinutes,
        attackWindowMissed:
          firstAttackAt !== null ? firstAttackAt.getTime() > firstAttackWindowCloseMs : null,
        matchType: input.matchType ?? "FWA",
        warStartTime: input.warStartTime,
        warEndTime: input.warEndTime,
      };
    });
    if (rows.length === 0) return;

    await prisma.clanWarParticipation.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }
}



