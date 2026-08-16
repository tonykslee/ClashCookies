import { prisma } from "../prisma";
import { getCompoWarDisplayBucket, type CompoWarDisplayBucket } from "../helper/compoWarWeightBuckets";
import {
  loadCompoActualStateContext,
  type CompoActualStateContext,
} from "./CompoActualStateService";
import { InactiveWarService } from "./InactiveWarService";
import { normalizePlayerTag } from "./PlayerLinkService";
import { projectCompoActualStateView } from "../helper/compoActualStateView";
import { WarPlanViolationHistoryService } from "./WarPlanViolationHistoryService";

export type CompoReplacementTypeFilter =
  | "filler"
  | "inactive"
  | "unlinked"
  | "surplus"
  | "violations";

export type CompoReplacementViewMode = "priority" | "all";

export type CompoReplacementFilter = {
  clanTag?: string | null;
  view: CompoReplacementViewMode;
  types?: CompoReplacementTypeFilter[];
  minimumViolations?: number;
};

export type CompoReplacementReasonFlags = {
  filler: boolean;
  inactive: boolean;
  unlinked: boolean;
  surplus: boolean;
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
  surplusDelta: number | null;
  violationCount30d: number;
  reasons: CompoReplacementReasonFlags;
};

export type CompoReplacementClanSummary = {
  clanTag: string;
  clanName: string;
  uniqueCandidateCount: number;
  fillerCount: number;
  inactiveCount: number;
  unlinkedCount: number;
  surplusCount: number;
};

export type CompoReplacementResolution = {
  inputWeight: number;
  bucket: CompoWarDisplayBucket | null;
  summaryByClan: CompoReplacementClanSummary[];
  candidates: CompoReplacementCandidate[];
};

export type CompoReplacementFilterResult = {
  candidates: CompoReplacementCandidate[];
  totalCandidateCount: number;
  filteredCount: number;
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
  surplusDelta: number | null;
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
  surplus: boolean;
}): CompoReplacementReasonFlags {
  return {
    filler: input.filler,
    inactive: input.inactive,
    unlinked: input.unlinked,
    surplus: input.surplus,
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
        surplusCount: 0,
      };
    existing.uniqueCandidateCount += 1;
    if (candidate.reasons.filler) existing.fillerCount += 1;
    if (candidate.reasons.inactive) existing.inactiveCount += 1;
    if (candidate.reasons.unlinked) existing.unlinkedCount += 1;
    if (candidate.reasons.surplus) existing.surplusCount += 1;
    summaryByClan.set(candidate.clanTag, existing);
  }

  return [...summaryByClan.values()].sort((left, right) => {
    const leftOrder = clanOrder.get(left.clanTag) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = clanOrder.get(right.clanTag) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.clanName.localeCompare(right.clanName);
  });
}

function normalizeMinimumViolations(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function hasReplacementType(
  candidate: CompoReplacementCandidate,
  type: CompoReplacementTypeFilter,
): boolean {
  if (type === "filler") return candidate.reasons.filler;
  if (type === "inactive") return candidate.reasons.inactive;
  if (type === "unlinked") return candidate.reasons.unlinked;
  if (type === "surplus") return candidate.reasons.surplus;
  return candidate.violationCount30d > 0;
}

function isPriorityReplacementCandidate(candidate: CompoReplacementCandidate): boolean {
  return candidate.reasons.filler || candidate.reasons.inactive || candidate.violationCount30d > 0;
}

/** Purpose: rank resolved replacement candidates without changing eligibility or persistence. */
export function compareCompoReplacementCandidates(
  left: CompoReplacementCandidate,
  right: CompoReplacementCandidate,
): number {
  if (left.reasons.filler !== right.reasons.filler) {
    return left.reasons.filler ? -1 : 1;
  }
  if (left.violationCount30d !== right.violationCount30d) {
    return right.violationCount30d - left.violationCount30d;
  }
  if (left.reasons.inactive !== right.reasons.inactive) {
    return left.reasons.inactive ? -1 : 1;
  }
  if (left.reasons.unlinked !== right.reasons.unlinked) {
    return left.reasons.unlinked ? -1 : 1;
  }

  const leftSurplusOnly =
    left.reasons.surplus &&
    !left.reasons.filler &&
    !left.reasons.inactive &&
    !left.reasons.unlinked &&
    left.violationCount30d <= 0;
  const rightSurplusOnly =
    right.reasons.surplus &&
    !right.reasons.filler &&
    !right.reasons.inactive &&
    !right.reasons.unlinked &&
    right.violationCount30d <= 0;
  if (leftSurplusOnly !== rightSurplusOnly) {
    return leftSurplusOnly ? 1 : -1;
  }

  const nameCompare = left.playerName.toLowerCase().localeCompare(right.playerName.toLowerCase());
  if (nameCompare !== 0) return nameCompare;
  return left.playerTag.localeCompare(right.playerTag);
}

/** Purpose: apply pure clan/view/type/violation filters and deterministic ranking to resolved candidates. */
export function filterAndSortCompoReplacementCandidates(input: {
  candidates: CompoReplacementCandidate[];
  filter: CompoReplacementFilter;
}): CompoReplacementFilterResult {
  const hasClanFilter = Boolean(input.filter.clanTag?.trim());
  const requestedClanTag = hasClanFilter ? normalizeTagLike(input.filter.clanTag ?? "") : null;
  const types = [...new Set(input.filter.types ?? [])];
  const hasExplicitTypes = types.length > 0;
  const minimumViolations = normalizeMinimumViolations(input.filter.minimumViolations);
  const filtered = input.candidates
    .filter((candidate) => {
      if (
        hasClanFilter &&
        (!requestedClanTag || normalizeTagLike(candidate.clanTag) !== requestedClanTag)
      ) {
        return false;
      }
      if (candidate.violationCount30d < minimumViolations) return false;

      if (hasExplicitTypes) {
        return types.some((type) => hasReplacementType(candidate, type));
      }
      return input.filter.view === "all" || isPriorityReplacementCandidate(candidate);
    })
    .sort(compareCompoReplacementCandidates);

  return {
    candidates: filtered,
    totalCandidateCount: input.candidates.length,
    filteredCount: filtered.length,
  };
}

/** Purpose: resolve DB-backed replacement candidates for one compo placement bucket without changing `/compo place` rendering yet. */
export class CompoReplacementService {
  constructor(
    private readonly inactiveWarService = new InactiveWarService(),
    private readonly violationHistoryService = new WarPlanViolationHistoryService(),
  ) {}

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
      const projection = projectCompoActualStateView({
        view: "auto",
        base: clan.base,
        heatMapRefs: context.heatMapRefs,
      });
      const surplusDeltaByBucket = new Map<CompoWarDisplayBucket, number>();
      if (projection.selectedHeatMapRef) {
        for (const displayBucket of [
          "TH18",
          "TH17",
          "TH16",
          "TH15",
          "TH14",
          "<=TH13",
        ] as CompoWarDisplayBucket[]) {
          const delta = projection.deltaByBucket[displayBucket];
          if (delta !== null && delta > 0) {
            surplusDeltaByBucket.set(displayBucket, delta);
          }
        }
      }

      for (const member of clan.members) {
        const playerTag = normalizeTagLike(member.playerTag);
        if (!playerTag || !isPositiveWeight(member.resolvedWeight)) continue;

        const resolvedBucket = getCompoWarDisplayBucket(member.resolvedWeight);
        if (!resolvedBucket) continue;
        const isSameBucket = resolvedBucket === bucket;
        const surplusDelta = surplusDeltaByBucket.get(resolvedBucket) ?? null;
        const hasSurplusReason = surplusDelta !== null;
        const discordUserId = linkedUserIdByPlayerTag.get(playerTag) ?? null;
        const isFiller = fillerTagSet.has(playerTag);
        const isInactive =
          inactiveByDaysTagSet.has(playerTag) || inactiveByWarsTagSet.has(playerTag);
        const isUnlinked = discordUserId === null;
        const qualifiesByExistingRule =
          isSameBucket && (isFiller || isInactive || isUnlinked);
        const qualifiesBySurplus = hasSurplusReason;
        if (!qualifiesByExistingRule && !qualifiesBySurplus) continue;

        const reasons = buildReasonFlags({
          filler: isFiller,
          inactive: isInactive,
          unlinked: isUnlinked,
          surplus: hasSurplusReason,
        });

        memberSeeds.push({
          key: `${clan.clanTag}|${playerTag}`,
          clanTag: clan.clanTag,
          clanName: clan.clanName,
          playerTag,
          playerName: member.playerName?.trim() || playerTag,
          resolvedWeight: member.resolvedWeight,
          resolvedBucket,
          discordUserId,
          inactiveLabel: inactiveLabelByPlayerTag.get(playerTag) ?? null,
          surplusDelta,
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

    const violationCountByCandidateKey = new Map<string, number>();
    if (input.guildId && uniqueByKey.size > 0) {
      const seedsByClan = new Map<string, ReplacementCandidateSeed[]>();
      for (const seed of uniqueByKey.values()) {
        const clanSeeds = seedsByClan.get(seed.clanTag) ?? [];
        clanSeeds.push(seed);
        seedsByClan.set(seed.clanTag, clanSeeds);
      }

      await Promise.all(
        [...seedsByClan.entries()].map(async ([clanTag, seeds]) => {
          const result = await this.violationHistoryService.getClanPlayerViolationCounts({
            guildId: input.guildId as string,
            clanTag,
            playerTags: seeds.map((seed) => seed.playerTag),
            period: "30d",
          });
          for (const seed of seeds) {
            const count = result.violationCountByPlayerTag.get(seed.playerTag) ?? 0;
            violationCountByCandidateKey.set(
              `${seed.clanTag}|${seed.playerTag}`,
              Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
            );
          }
        }),
      );
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
        surplusDelta: seed.surplusDelta,
        violationCount30d:
          violationCountByCandidateKey.get(`${seed.clanTag}|${seed.playerTag}`) ?? 0,
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
  context?: CompoActualStateContext | null;
}) => new CompoReplacementService().resolveReplacementCandidates(input);
