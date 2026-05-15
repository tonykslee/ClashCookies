import { prisma } from "../prisma";
import { getCompoWarDisplayBucket, type CompoWarDisplayBucket } from "../helper/compoWarWeightBuckets";
import {
  loadCompoActualStateContext,
  type CompoActualStateContext,
} from "./CompoActualStateService";
import { InactiveWarService } from "./InactiveWarService";
import { normalizePlayerTag } from "./PlayerLinkService";

export type CompoReplacementReasonFlags = {
  filler: boolean;
  inactive: boolean;
  unlinked: boolean;
};

export type CompoReplacementCandidate = {
  clanTag: string;
  clanName: string;
  playerTag: string;
  playerName: string;
  resolvedWeight: number;
  resolvedBucket: CompoWarDisplayBucket;
  discordUserId: string | null;
  discordMention: string | null;
  inactiveLabel: string | null;
  reasons: CompoReplacementReasonFlags;
};

export type CompoReplacementClanSummary = {
  clanTag: string;
  clanName: string;
  uniqueCandidateCount: number;
  fillerCount: number;
  inactiveCount: number;
  unlinkedCount: number;
};

export type CompoReplacementResolution = {
  inputWeight: number;
  bucket: CompoWarDisplayBucket | null;
  summaryByClan: CompoReplacementClanSummary[];
  candidates: CompoReplacementCandidate[];
};

type ReplacementCandidateSeed = {
  clanTag: string;
  clanName: string;
  playerTag: string;
  playerName: string;
  resolvedWeight: number;
  resolvedBucket: CompoWarDisplayBucket;
  discordUserId: string | null;
  inactiveLabel: string | null;
  reasons: CompoReplacementReasonFlags;
};

function normalizeTagLike(input: string): string {
  return normalizePlayerTag(input);
}

function isPositiveWeight(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildDiscordMention(discordUserId: string | null): string | null {
  return discordUserId ? `<@${discordUserId}>` : null;
}

function buildReasonFlags(input: {
  filler: boolean;
  inactive: boolean;
  unlinked: boolean;
}): CompoReplacementReasonFlags {
  return {
    filler: input.filler,
    inactive: input.inactive,
    unlinked: input.unlinked,
  };
}

function sortCandidatesForDisplay(
  left: ReplacementCandidateSeed,
  right: ReplacementCandidateSeed,
  clanOrder: Map<string, number>,
): number {
  const leftOrder = clanOrder.get(left.clanTag) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = clanOrder.get(right.clanTag) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  const leftName = left.playerName.toLowerCase();
  const rightName = right.playerName.toLowerCase();
  if (leftName !== rightName) return leftName.localeCompare(rightName);

  return left.playerTag.localeCompare(right.playerTag);
}

function summarizeCandidatesByClan(
  candidates: CompoReplacementCandidate[],
  clanOrder: Map<string, number>,
): CompoReplacementClanSummary[] {
  const summaryByClan = new Map<string, CompoReplacementClanSummary>();
  for (const candidate of candidates) {
    const existing =
      summaryByClan.get(candidate.clanTag) ?? {
        clanTag: candidate.clanTag,
        clanName: candidate.clanName,
        uniqueCandidateCount: 0,
        fillerCount: 0,
        inactiveCount: 0,
        unlinkedCount: 0,
      };
    existing.uniqueCandidateCount += 1;
    if (candidate.reasons.filler) existing.fillerCount += 1;
    if (candidate.reasons.inactive) existing.inactiveCount += 1;
    if (candidate.reasons.unlinked) existing.unlinkedCount += 1;
    summaryByClan.set(candidate.clanTag, existing);
  }

  return [...summaryByClan.values()].sort((left, right) => {
    const leftOrder = clanOrder.get(left.clanTag) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = clanOrder.get(right.clanTag) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.clanName.localeCompare(right.clanName);
  });
}

/** Purpose: resolve DB-backed replacement candidates for one compo placement bucket without changing `/compo place` rendering yet. */
export class CompoReplacementService {
  private readonly inactiveWarService = new InactiveWarService();

  async resolveReplacementCandidates(input: {
    guildId?: string | null;
    weight: number;
    bucket?: CompoWarDisplayBucket | null;
    context?: CompoActualStateContext | null;
  }): Promise<CompoReplacementResolution> {
    const bucket = input.bucket ?? getCompoWarDisplayBucket(input.weight);
    if (!bucket) {
      return {
        inputWeight: input.weight,
        bucket: null,
        summaryByClan: [],
        candidates: [],
      };
    }

    const context =
      input.context ?? (await loadCompoActualStateContext(input.guildId ?? null));
    if (context.clans.length === 0) {
      return {
        inputWeight: input.weight,
        bucket,
        summaryByClan: [],
        candidates: [],
      };
    }

    const clanOrder = new Map(
      context.clans.map((clan, index) => [clan.clanTag, index] as const),
    );
    const memberSeeds: Array<ReplacementCandidateSeed & { key: string }> = [];

    const allPlayerTags = [...new Set(
      context.clans.flatMap((clan) =>
        clan.members.map((member) => normalizeTagLike(member.playerTag)).filter(Boolean),
      ),
    )];

    const fillerRows = input.guildId
      ? await prisma.fillerAccount.findMany({
          where: { guildId: input.guildId },
          orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
          select: { playerTag: true },
        })
      : [];

    const [playerLinks, playerActivityRows, inactiveWarRows] = await Promise.all([
      allPlayerTags.length > 0
        ? prisma.playerLink.findMany({
            where: { playerTag: { in: allPlayerTags } },
            select: {
              playerTag: true,
              discordUserId: true,
            },
          })
        : Promise.resolve([] as Array<{ playerTag: string; discordUserId: string | null }>),
      input.guildId && allPlayerTags.length > 0
        ? prisma.playerActivity.findMany({
            where: {
              guildId: input.guildId,
              tag: { in: allPlayerTags },
            },
            select: {
              tag: true,
              lastSeenAt: true,
            },
          })
        : Promise.resolve([] as Array<{ tag: string; lastSeenAt: Date | null }>),
      input.guildId
        ? this.inactiveWarService.listInactiveWarPlayers({
            guildId: input.guildId,
            wars: 3,
          })
        : Promise.resolve({ results: [] as Array<{ playerTag: string; missedWars: number }> } as Awaited<
            ReturnType<InactiveWarService["listInactiveWarPlayers"]>
          >),
    ]);

    const fillerTagSet = new Set(
      fillerRows
        .map((row) => normalizeTagLike(row.playerTag))
        .filter((tag): tag is string => Boolean(tag)),
    );
    const linkedUserIdByPlayerTag = new Map<string, string>();
    for (const row of playerLinks) {
      const playerTag = normalizeTagLike(row.playerTag);
      const discordUserId = String(row.discordUserId ?? "").trim();
      if (!playerTag || !discordUserId) continue;
      if (!linkedUserIdByPlayerTag.has(playerTag)) {
        linkedUserIdByPlayerTag.set(playerTag, discordUserId);
      }
    }

    const inactiveByDaysTagSet = new Set<string>();
    const inactiveLabelByPlayerTag = new Map<string, string>();
    const inactiveCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    for (const row of playerActivityRows) {
      const playerTag = normalizeTagLike(row.tag);
      if (!playerTag || !row.lastSeenAt) continue;
      if (row.lastSeenAt.getTime() < inactiveCutoff.getTime()) {
        inactiveByDaysTagSet.add(playerTag);
        const daysInactive = Math.max(
          1,
          Math.floor((Date.now() - row.lastSeenAt.getTime()) / (24 * 60 * 60 * 1000)),
        );
        if (!inactiveLabelByPlayerTag.has(playerTag)) {
          inactiveLabelByPlayerTag.set(playerTag, `${daysInactive}d`);
        }
      }
    }

    const inactiveByWarsTagSet = new Set<string>();
    for (const row of inactiveWarRows.results ?? []) {
      const playerTag = normalizeTagLike(row.playerTag);
      if (!playerTag) continue;
      if ((row.missedWars ?? 0) > 0) {
        inactiveByWarsTagSet.add(playerTag);
        if (!inactiveLabelByPlayerTag.has(playerTag)) {
          inactiveLabelByPlayerTag.set(playerTag, `${Math.max(1, Math.trunc(row.missedWars ?? 0))}w`);
        }
      }
    }

    for (const clan of context.clans) {
      for (const member of clan.members) {
        const playerTag = normalizeTagLike(member.playerTag);
        if (!playerTag || !isPositiveWeight(member.resolvedWeight)) continue;
        if (!member.resolvedBucket || member.resolvedBucket !== bucket) continue;

        const discordUserId = linkedUserIdByPlayerTag.get(playerTag) ?? null;
        const reasons = buildReasonFlags({
          filler: fillerTagSet.has(playerTag),
          inactive: inactiveByDaysTagSet.has(playerTag) || inactiveByWarsTagSet.has(playerTag),
          unlinked: discordUserId === null,
        });
        if (!reasons.filler && !reasons.inactive && !reasons.unlinked) {
          continue;
        }

        memberSeeds.push({
          key: `${clan.clanTag}|${playerTag}`,
          clanTag: clan.clanTag,
          clanName: clan.clanName,
          playerTag,
          playerName: member.playerName,
          resolvedWeight: member.resolvedWeight,
          resolvedBucket: bucket,
          discordUserId,
          inactiveLabel: inactiveLabelByPlayerTag.get(playerTag) ?? null,
          reasons,
        });
      }
    }

    const uniqueByKey = new Map<string, ReplacementCandidateSeed>();
    for (const seed of memberSeeds) {
      if (!uniqueByKey.has(seed.key)) {
        uniqueByKey.set(seed.key, seed);
      }
    }

    const candidates = [...uniqueByKey.values()]
      .sort((left, right) => sortCandidatesForDisplay(left, right, clanOrder))
      .map((seed) => ({
        clanTag: seed.clanTag,
        clanName: seed.clanName,
        playerTag: seed.playerTag,
        playerName: seed.playerName,
        resolvedWeight: seed.resolvedWeight,
        resolvedBucket: seed.resolvedBucket,
        discordUserId: seed.discordUserId,
        discordMention: buildDiscordMention(seed.discordUserId),
        inactiveLabel: seed.inactiveLabel,
        reasons: seed.reasons,
      }));

    return {
      inputWeight: input.weight,
      bucket,
      summaryByClan: summarizeCandidatesByClan(candidates, clanOrder),
      candidates,
    };
  }
}

export const resolveCompoReplacementCandidatesForTest = async (input: {
  guildId?: string | null;
  weight: number;
  bucket?: CompoWarDisplayBucket | null;
}) => new CompoReplacementService().resolveReplacementCandidates(input);
