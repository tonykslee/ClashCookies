import { prisma } from "../prisma";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { normalizeClanTag } from "./PlayerLinkService";

export type RemainingCwlClanView = {
  clanTag: string;
  clanName: string | null;
  roundDay: number | null;
  roundState: string | null;
  battleDayStartsAt: Date | null;
  battleDayEndsAt: Date | null;
  nextWarAt: Date | null;
};

function normalizeRoundState(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return value.length > 0 ? value : null;
}

function resolveNextWarAt(input: {
  roundDay: number | null;
  roundState: string | null;
  battleDayStartsAt: Date | null;
  battleDayEndsAt: Date | null;
}): Date | null {
  const state = String(input.roundState ?? "").toLowerCase();
  if (state.includes("preparation")) {
    return input.battleDayStartsAt;
  }
  if (!state.includes("inwar")) {
    return null;
  }
  if (!(input.battleDayEndsAt instanceof Date) || Number.isNaN(input.battleDayEndsAt.getTime())) {
    return null;
  }
  const roundDay = input.roundDay ?? 0;
  if (roundDay >= 7) return null;
  return new Date(input.battleDayEndsAt.getTime() + 24 * 60 * 60 * 1000);
}

function mapCurrentRound(input: {
  clanTag: string;
  clanName: string | null;
  roundDay: number;
  roundState: string;
  startTime: Date | null;
  endTime: Date | null;
}): RemainingCwlClanView {
  const roundState = normalizeRoundState(input.roundState);
  const battleDayStartsAt = roundState?.toLowerCase().includes("preparation")
    ? input.startTime
    : null;
  const battleDayEndsAt = roundState?.toLowerCase().includes("inwar")
    ? input.endTime
    : null;
  return {
    clanTag: normalizeClanTag(input.clanTag),
    clanName: input.clanName,
    roundDay: input.roundDay,
    roundState,
    battleDayStartsAt,
    battleDayEndsAt,
    nextWarAt: resolveNextWarAt({
      roundDay: input.roundDay,
      roundState,
      battleDayStartsAt,
      battleDayEndsAt,
    }),
  };
}

export class RemainingCwlService {
  async getClanView(input: {
    clanTag: string;
    season?: string;
  }): Promise<RemainingCwlClanView | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return null;

    const [trackedClan, currentRound] = await Promise.all([
      prisma.cwlTrackedClan.findFirst({
        where: {
          season,
          tag: { equals: clanTag, mode: "insensitive" },
        },
        select: { tag: true, name: true },
      }),
      prisma.currentCwlRound.findUnique({
        where: {
          season_clanTag: {
            season,
            clanTag,
          },
        },
        select: {
          clanTag: true,
          clanName: true,
          roundDay: true,
          roundState: true,
          startTime: true,
          endTime: true,
        },
      }),
    ]);

    if (!trackedClan) return null;
    if (!currentRound) {
      return {
        clanTag: normalizeClanTag(trackedClan.tag),
        clanName: trackedClan.name ?? null,
        roundDay: null,
        roundState: null,
        battleDayStartsAt: null,
        battleDayEndsAt: null,
        nextWarAt: null,
      };
    }

    return mapCurrentRound({
      clanTag: currentRound.clanTag,
      clanName: currentRound.clanName ?? trackedClan.name ?? null,
      roundDay: currentRound.roundDay,
      roundState: currentRound.roundState,
      startTime: currentRound.startTime,
      endTime: currentRound.endTime,
    });
  }

  async listClanViews(input?: { season?: string }): Promise<RemainingCwlClanView[]> {
    const season = input?.season ?? resolveCurrentCwlSeasonKey();
    const [trackedClans, currentRounds] = await Promise.all([
      prisma.cwlTrackedClan.findMany({
        where: { season },
        orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
        select: { tag: true, name: true },
      }),
      prisma.currentCwlRound.findMany({
        where: { season },
        select: {
          clanTag: true,
          clanName: true,
          roundDay: true,
          roundState: true,
          startTime: true,
          endTime: true,
        },
      }),
    ]);

    const currentRoundByTag = new Map(
      currentRounds.map((round) => [normalizeClanTag(round.clanTag), round]),
    );

    return trackedClans.map((trackedClan) => {
      const clanTag = normalizeClanTag(trackedClan.tag);
      const currentRound = currentRoundByTag.get(clanTag) ?? null;
      if (!currentRound) {
        return {
          clanTag,
          clanName: trackedClan.name ?? null,
          roundDay: null,
          roundState: null,
          battleDayStartsAt: null,
          battleDayEndsAt: null,
          nextWarAt: null,
        };
      }
      return mapCurrentRound({
        clanTag: currentRound.clanTag,
        clanName: currentRound.clanName ?? trackedClan.name ?? null,
        roundDay: currentRound.roundDay,
        roundState: currentRound.roundState,
        startTime: currentRound.startTime,
        endTime: currentRound.endTime,
      });
    });
  }
}

export const remainingCwlService = new RemainingCwlService();
