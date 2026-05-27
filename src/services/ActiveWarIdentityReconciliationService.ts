import { compareActiveWarIdentities } from "./MatchTypeResolutionService";
import { parseCocApiTime } from "../utils/cocTime";

export type ActiveWarIdentityPatch = {
  state: "preparation" | "inWar";
  prepStartTime: Date;
  startTime: Date;
  endTime: Date;
  opponentTag: string;
  opponentName: string;
  clanName: string;
  warId: number | null;
  updatedAt: Date;
};

export type ActiveWarIdentityPatchResult = {
  patch: ActiveWarIdentityPatch;
  sameWar: boolean;
};

export type ActiveWarIdentityLiveWarInput = {
  state?: string | null;
  startTime?: string | Date | null;
  preparationStartTime?: string | Date | null;
  endTime?: string | Date | null;
  opponent?: {
    tag?: string | null;
    name?: string | null;
  } | null;
  clan?: {
    name?: string | null;
  } | null;
  warId?: string | number | null;
};

export type ActiveWarIdentityCurrentWarInput = {
  warId?: string | number | null;
  startTime?: Date | null;
  opponentTag?: string | null;
  state?: string | null;
  prepStartTime?: Date | null;
  endTime?: Date | null;
  opponentName?: string | null;
  clanName?: string | null;
};

export type ResolveActiveWarIdentityPatchInput = {
  guildId: string;
  clanTag: string;
  liveWar: ActiveWarIdentityLiveWarInput | null | undefined;
  currentWar?: ActiveWarIdentityCurrentWarInput | null;
};

function normalizeTag(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "");
  return normalized ? normalized : null;
}

function sanitizeClanName(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > 80) return null;
  if (/Clan Tag|Point Balance|Sync #|Winner|War State/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function parseLiveDate(input: string | Date | null | undefined): Date | null {
  if (input instanceof Date) {
    return Number.isFinite(input.getTime()) ? input : null;
  }
  const parsed = parseCocApiTime(typeof input === "string" ? input : null);
  return parsed !== null ? new Date(parsed) : null;
}

/** Purpose: reconcile live active-war identity with the current persisted row without changing ownership. */
export function resolveActiveWarIdentityPatch(
  input: ResolveActiveWarIdentityPatchInput,
): ActiveWarIdentityPatchResult | null {
  const warStateRaw = String(input.liveWar?.state ?? "").trim().toLowerCase();
  const warState =
    warStateRaw === "preparation" || warStateRaw === "inwar"
      ? (warStateRaw === "inwar" ? "inWar" : "preparation")
      : null;
  if (!warState) return null;

  const liveStartTime = parseLiveDate(input.liveWar?.startTime ?? null);
  const liveOpponentTag = normalizeTag(input.liveWar?.opponent?.tag ?? null);
  const liveOpponentName = sanitizeClanName(input.liveWar?.opponent?.name ?? null);
  const liveClanName = sanitizeClanName(input.liveWar?.clan?.name ?? null);
  if (!liveStartTime || !liveOpponentTag || !liveOpponentName || !liveClanName) {
    return null;
  }

  const parsedPrepStartTime = parseLiveDate(
    input.liveWar?.preparationStartTime ?? null,
  );
  const parsedEndTime = parseLiveDate(input.liveWar?.endTime ?? null);
  const prepStartTime =
    parsedPrepStartTime ?? new Date(liveStartTime.getTime() - 24 * 60 * 60 * 1000);
  const endTime =
    parsedEndTime ?? new Date(liveStartTime.getTime() + 24 * 60 * 60 * 1000);

  const currentWarId =
    input.currentWar?.warId !== null &&
    input.currentWar?.warId !== undefined &&
    Number.isFinite(Number(input.currentWar.warId))
      ? Math.trunc(Number(input.currentWar.warId))
      : null;
  const comparison = compareActiveWarIdentities({
    persisted: {
      warId: currentWarId,
      warStartTime: input.currentWar?.startTime ?? null,
      opponentTag: input.currentWar?.opponentTag ?? null,
    },
    active: {
      warStartTime: liveStartTime,
      opponentTag: liveOpponentTag,
    },
  });

  return {
    sameWar: comparison.sameWar,
    patch: {
      state: warState,
      prepStartTime,
      startTime: liveStartTime,
      endTime,
      opponentTag: liveOpponentTag,
      opponentName: liveOpponentName,
      clanName: liveClanName,
      warId: comparison.sameWar ? currentWarId : null,
      updatedAt: new Date(),
    },
  };
}

export const resolveActiveWarIdentityPatchForTest =
  resolveActiveWarIdentityPatch;
