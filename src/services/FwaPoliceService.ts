import { createHash } from "crypto";
import { Client } from "discord.js";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  listPlayerLinksForClanMembers,
  normalizeClanTag,
  normalizePlayerTag,
} from "./PlayerLinkService";
import {
  type WarComplianceIssue,
  type WarComplianceService,
} from "./WarComplianceService";

type TrackedClanPoliceRow = {
  tag: string;
  name: string | null;
  fwaPoliceDmEnabled: boolean;
  fwaPoliceLogEnabled: boolean;
  logChannelId: string | null;
  notifyChannelId: string | null;
  mailChannelId: string | null;
};

type WarComplianceEvaluator = Pick<
  WarComplianceService,
  "evaluateComplianceForCommand"
>;

export type FwaPoliceClanConfig = {
  clanTag: string;
  clanName: string | null;
  enableDm: boolean;
  enableLog: boolean;
};

export type FwaPoliceEnforcementResult = {
  evaluatedViolations: number;
  created: number;
  deduped: number;
  dmSent: number;
  logSent: number;
};

function sortViolationsDeterministically(
  issues: WarComplianceIssue[],
): WarComplianceIssue[] {
  return [...issues].sort((a, b) => {
    const posA =
      Number.isFinite(Number(a.playerPosition)) && Number(a.playerPosition) > 0
        ? Number(a.playerPosition)
        : Number.MAX_SAFE_INTEGER;
    const posB =
      Number.isFinite(Number(b.playerPosition)) && Number(b.playerPosition) > 0
        ? Number(b.playerPosition)
        : Number.MAX_SAFE_INTEGER;
    if (posA !== posB) return posA - posB;
    const tagA = normalizePlayerTag(a.playerTag);
    const tagB = normalizePlayerTag(b.playerTag);
    if (tagA !== tagB) return tagA.localeCompare(tagB);
    return String(a.ruleType ?? "").localeCompare(String(b.ruleType ?? ""));
  });
}

function normalizeText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampText(input: unknown, maxLen: number): string {
  const value = normalizeText(input);
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

function buildViolationLabel(issue: WarComplianceIssue): string {
  const explicit = normalizeText(issue.reasonLabel);
  if (explicit) return explicit;
  if (issue.ruleType === "missed_both") return "missed both attacks";
  return "did not follow war plan";
}

function buildViolationKey(issue: WarComplianceIssue): string {
  const attackDetails = Array.isArray(issue.attackDetails)
    ? issue.attackDetails.map((row) => ({
        defenderPosition:
          Number.isFinite(Number(row.defenderPosition)) &&
          Number(row.defenderPosition) > 0
            ? Number(row.defenderPosition)
            : null,
        stars:
          Number.isFinite(Number(row.stars)) && Number(row.stars) >= 0
            ? Number(row.stars)
            : 0,
        attackOrder:
          Number.isFinite(Number(row.attackOrder)) &&
          Number(row.attackOrder) > 0
            ? Number(row.attackOrder)
            : null,
        isBreach: Boolean(row.isBreach),
      }))
    : [];
  const fingerprint = {
    ruleType: issue.ruleType,
    reasonLabel: normalizeText(issue.reasonLabel),
    expectedBehavior: normalizeText(issue.expectedBehavior),
    actualBehavior: normalizeText(issue.actualBehavior),
    attackDetails,
  };
  return createHash("sha256")
    .update(JSON.stringify(fingerprint))
    .digest("hex");
}

function resolveClanLogChannelId(clan: TrackedClanPoliceRow): string | null {
  return (
    normalizeText(clan.logChannelId) ||
    normalizeText(clan.notifyChannelId) ||
    normalizeText(clan.mailChannelId) ||
    null
  );
}

function buildViolationMessage(input: {
  clanTag: string;
  clanName: string | null;
  warId: number;
  opponentName: string | null;
  issue: WarComplianceIssue;
}): string {
  const playerTag = normalizePlayerTag(input.issue.playerTag);
  const playerName = normalizeText(input.issue.playerName) || playerTag;
  const clanLabel = input.clanName
    ? `${input.clanName} (${input.clanTag})`
    : input.clanTag;
  const warLabel = input.opponentName
    ? `${input.warId} vs ${input.opponentName}`
    : String(input.warId);
  return [
    "FWA Police - Warplan violation detected",
    `Clan: ${clanLabel}`,
    `War: ${warLabel}`,
    `Player: ${playerName} (${playerTag})`,
    `Expected: ${clampText(input.issue.expectedBehavior, 500)}`,
    `Actual: ${clampText(input.issue.actualBehavior, 500)}`,
    `Violation: ${clampText(buildViolationLabel(input.issue), 200)}`,
  ].join("\n");
}

async function resolveTrackedClanByTag(
  clanTag: string,
): Promise<TrackedClanPoliceRow | null> {
  const normalized = normalizeClanTag(clanTag);
  if (!normalized) return null;
  const bare = normalized.slice(1);
  return prisma.trackedClan.findFirst({
    where: {
      OR: [
        { tag: { equals: normalized, mode: "insensitive" } },
        { tag: { equals: bare, mode: "insensitive" } },
      ],
    },
    select: {
      tag: true,
      name: true,
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: true,
      logChannelId: true,
      notifyChannelId: true,
      mailChannelId: true,
    },
  });
}

export class FwaPoliceService {
  /** Purpose: persist clan-scoped police automation toggles on the tracked-clan source of truth. */
  async setClanConfig(input: {
    clanTag: string;
    enableDm: boolean;
    enableLog: boolean;
  }): Promise<FwaPoliceClanConfig | null> {
    const tracked = await resolveTrackedClanByTag(input.clanTag);
    if (!tracked) return null;

    const updated = await prisma.trackedClan.update({
      where: { tag: tracked.tag },
      data: {
        fwaPoliceDmEnabled: Boolean(input.enableDm),
        fwaPoliceLogEnabled: Boolean(input.enableLog),
      },
      select: {
        tag: true,
        name: true,
        fwaPoliceDmEnabled: true,
        fwaPoliceLogEnabled: true,
      },
    });

    return {
      clanTag: normalizeClanTag(updated.tag),
      clanName: normalizeText(updated.name) || null,
      enableDm: Boolean(updated.fwaPoliceDmEnabled),
      enableLog: Boolean(updated.fwaPoliceLogEnabled),
    };
  }

  /** Purpose: evaluate canonical compliance and enforce one-time police notifications per unique violation fingerprint. */
  async enforceWarViolations(input: {
    client: Client;
    guildId: string;
    clanTag: string;
    warId: number;
    warCompliance: WarComplianceEvaluator;
  }): Promise<FwaPoliceEnforcementResult> {
    const normalizedClanTag = normalizeClanTag(input.clanTag);
    const normalizedWarId = Math.trunc(Number(input.warId));
    const empty: FwaPoliceEnforcementResult = {
      evaluatedViolations: 0,
      created: 0,
      deduped: 0,
      dmSent: 0,
      logSent: 0,
    };
    if (!normalizedClanTag || !Number.isFinite(normalizedWarId) || normalizedWarId <= 0) {
      return empty;
    }

    const tracked = await resolveTrackedClanByTag(normalizedClanTag);
    if (!tracked) return empty;
    const enableDm = Boolean(tracked.fwaPoliceDmEnabled);
    const enableLog = Boolean(tracked.fwaPoliceLogEnabled);
    if (!enableDm && !enableLog) {
      return empty;
    }

    const evaluation = await input.warCompliance
      .evaluateComplianceForCommand({
        guildId: input.guildId,
        clanTag: normalizedClanTag,
        scope: "war_id",
        warId: normalizedWarId,
      })
      .catch((err) => {
        console.error(
          `[fwa-police] compliance_eval_failed guild=${input.guildId} clan=${normalizedClanTag} warId=${normalizedWarId} error=${formatError(err)}`,
        );
        return null;
      });
    if (!evaluation || evaluation.status !== "ok" || !evaluation.report) {
      return empty;
    }

    const report = evaluation.report;
    const issues = sortViolationsDeterministically(report.notFollowingPlan);
    if (issues.length <= 0) return empty;

    const links = await listPlayerLinksForClanMembers({
      memberTagsInOrder: issues.map((issue) => normalizePlayerTag(issue.playerTag)),
    });
    const discordUserIdByTag = new Map(
      links.map((link) => [normalizePlayerTag(link.playerTag), link.discordUserId]),
    );

    const resolvedLogChannelId = enableLog ? resolveClanLogChannelId(tracked) : null;
    const resolvedLogChannel =
      enableLog && resolvedLogChannelId
        ? await input.client.channels.fetch(resolvedLogChannelId).catch(() => null)
        : null;
    const canSendLog =
      Boolean(resolvedLogChannel) &&
      typeof (resolvedLogChannel as { isTextBased?: () => boolean }).isTextBased ===
        "function" &&
      (resolvedLogChannel as { isTextBased: () => boolean }).isTextBased() &&
      "send" in (resolvedLogChannel as object);

    let created = 0;
    let deduped = 0;
    let dmSent = 0;
    let logSent = 0;

    const effectiveWarId = report.warId ?? normalizedWarId;
    for (const issue of issues) {
      const playerTag = normalizePlayerTag(issue.playerTag);
      if (!playerTag) continue;

      const violationKey = buildViolationKey(issue);
      const linkedDiscordUserId = discordUserIdByTag.get(playerTag) ?? null;
      const createdRow = await prisma.fwaPoliceHandledViolation
        .create({
          data: {
            clanTag: normalizedClanTag,
            warId: effectiveWarId,
            playerTag,
            violationKey,
            linkedDiscordUserId,
          },
          select: { id: true },
        })
        .catch((err) => {
          const code = (err as { code?: string } | null | undefined)?.code ?? "";
          if (code === "P2002") return null;
          throw err;
        });
      if (!createdRow) {
        deduped += 1;
        continue;
      }
      created += 1;

      const content = buildViolationMessage({
        clanTag: normalizedClanTag,
        clanName: normalizeText(report.clanName) || normalizeText(tracked.name) || null,
        warId: effectiveWarId,
        opponentName: normalizeText(report.opponentName) || null,
        issue,
      });

      let dmSentAt: Date | null = null;
      let logSentAt: Date | null = null;

      if (enableDm && linkedDiscordUserId) {
        try {
          const user = await input.client.users
            .fetch(linkedDiscordUserId)
            .catch(() => null);
          const dm = await user?.createDM().catch(() => null);
          if (dm) {
            await dm.send({ content });
            dmSentAt = new Date();
            dmSent += 1;
          }
        } catch (err) {
          console.error(
            `[fwa-police] dm_failed guild=${input.guildId} clan=${normalizedClanTag} warId=${effectiveWarId} player=${playerTag} user=${linkedDiscordUserId} error=${formatError(err)}`,
          );
        }
      }

      if (enableLog && canSendLog) {
        try {
          const prefix = linkedDiscordUserId ? `<@${linkedDiscordUserId}> ` : "";
          await (
            resolvedLogChannel as {
              send: (input: {
                content: string;
                allowedMentions: { users: string[] };
              }) => Promise<unknown>;
            }
          ).send({
            content: `${prefix}${content}`.trim(),
            allowedMentions: {
              users: linkedDiscordUserId ? [linkedDiscordUserId] : [],
            },
          });
          logSentAt = new Date();
          logSent += 1;
        } catch (err) {
          console.error(
            `[fwa-police] log_failed guild=${input.guildId} clan=${normalizedClanTag} warId=${effectiveWarId} player=${playerTag} channel=${resolvedLogChannelId ?? "unknown"} error=${formatError(err)}`,
          );
        }
      }

      if (dmSentAt || logSentAt) {
        await prisma.fwaPoliceHandledViolation.update({
          where: { id: createdRow.id },
          data: {
            dmSentAt: dmSentAt ?? undefined,
            logSentAt: logSentAt ?? undefined,
          },
        });
      }
    }

    return {
      evaluatedViolations: issues.length,
      created,
      deduped,
      dmSent,
      logSent,
    };
  }
}

export const fwaPoliceService = new FwaPoliceService();

