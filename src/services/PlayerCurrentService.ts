import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";
import { todoSnapshotService } from "./TodoSnapshotService";

export type PlayerCurrentResolutionField =
  | "playerName"
  | "townHall"
  | "currentClanTag"
  | "currentClanName"
  | "trophies"
  | "builderTrophies"
  | "warStars"
  | "expLevel"
  | "role"
  | "leagueName"
  | "currentWeight";

export type PlayerCurrentResolutionSource =
  | "player_current"
  | "fwa_player_catalog"
  | "todo_snapshot"
  | "live_refresh"
  | "missing";

export type PlayerCurrentRefreshPolicy = "missing_only" | "missing_or_stale";

export const PLAYER_CURRENT_SIGNUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type PlayerCurrentLike = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
  currentClanTag: string | null;
  currentClanName: string | null;
  trophies: number | null;
  builderTrophies: number | null;
  warStars: number | null;
  expLevel: number | null;
  role: string | null;
  leagueName: string | null;
  currentWeight: number | null;
  currentWeightSource: string | null;
  currentWeightMeasuredAt: Date | null;
  achievementsJson: Prisma.JsonValue | null;
  lastSeenAt: Date | null;
  lastFetchedAt: Date | null;
  lastSource: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  source: PlayerCurrentResolutionSource;
  liveRefreshInvoked: boolean;
};

type PlayerCurrentRow = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
  currentClanTag: string | null;
  currentClanName: string | null;
  trophies: number | null;
  builderTrophies: number | null;
  warStars: number | null;
  expLevel: number | null;
  role: string | null;
  leagueName: string | null;
  currentWeight: number | null;
  currentWeightSource: string | null;
  currentWeightMeasuredAt: Date | null;
  achievementsJson: Prisma.JsonValue | null;
  lastSeenAt: Date | null;
  lastFetchedAt: Date | null;
  lastSource: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type FwaPlayerCatalogRow = {
  playerTag: string;
  latestName: string;
  latestTownHall: number | null;
  latestKnownWeight: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSyncedAt: Date;
};

type TodoSnapshotRow = {
  playerTag: string;
  playerName: string;
  townHall: number | null;
  clanTag: string | null;
  clanName: string | null;
  updatedAt: Date;
  lastUpdatedAt?: Date | null;
};

const DEFAULT_REQUIRE_FIELDS: PlayerCurrentResolutionField[] = ["townHall"];

function normalizeText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized ? normalized : null;
}

function normalizeNumber(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) ? parsed : null;
}

function createMissingPlayerCurrent(input: { playerTag: string }): PlayerCurrentLike {
  return {
    playerTag: input.playerTag,
    playerName: null,
    townHall: null,
    currentClanTag: null,
    currentClanName: null,
    trophies: null,
    builderTrophies: null,
    warStars: null,
    expLevel: null,
    role: null,
    leagueName: null,
    currentWeight: null,
    currentWeightSource: null,
    currentWeightMeasuredAt: null,
    achievementsJson: null,
    lastSeenAt: null,
    lastFetchedAt: null,
    lastSource: null,
    createdAt: null,
    updatedAt: null,
    source: "missing",
    liveRefreshInvoked: false,
  };
}

function toPlayerCurrentLike(row: PlayerCurrentRow): PlayerCurrentLike {
  return {
    playerTag: row.playerTag,
    playerName: row.playerName,
    townHall: row.townHall,
    currentClanTag: row.currentClanTag,
    currentClanName: row.currentClanName,
    trophies: row.trophies,
    builderTrophies: row.builderTrophies,
    warStars: row.warStars,
    expLevel: row.expLevel,
    role: row.role,
    leagueName: row.leagueName,
    currentWeight: row.currentWeight,
    currentWeightSource: row.currentWeightSource,
    currentWeightMeasuredAt: row.currentWeightMeasuredAt,
    achievementsJson: row.achievementsJson,
    lastSeenAt: row.lastSeenAt,
    lastFetchedAt: row.lastFetchedAt,
    lastSource: row.lastSource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: "player_current",
    liveRefreshInvoked: false,
  };
}

function applyMissingFields(
  target: PlayerCurrentLike,
  source: Partial<PlayerCurrentLike>,
  sourceLabel: PlayerCurrentResolutionSource,
): void {
  const playerName = source.playerName ?? null;
  const townHall = source.townHall ?? null;
  const currentClanTag = source.currentClanTag ?? null;
  const currentClanName = source.currentClanName ?? null;
  const trophies = source.trophies ?? null;
  const builderTrophies = source.builderTrophies ?? null;
  const warStars = source.warStars ?? null;
  const expLevel = source.expLevel ?? null;
  const role = source.role ?? null;
  const leagueName = source.leagueName ?? null;
  const currentWeight = source.currentWeight ?? null;
  const currentWeightSource = source.currentWeightSource ?? null;
  const currentWeightMeasuredAt = source.currentWeightMeasuredAt ?? null;
  const achievementsJson = source.achievementsJson ?? null;
  const lastSeenAt = source.lastSeenAt ?? null;
  const lastFetchedAt = source.lastFetchedAt ?? null;
  const lastSource = source.lastSource ?? null;

  if (target.playerName === null && playerName !== null) target.playerName = playerName;
  if (target.townHall === null && townHall !== null) target.townHall = townHall;
  if (target.currentClanTag === null && currentClanTag !== null) target.currentClanTag = currentClanTag;
  if (target.currentClanName === null && currentClanName !== null) target.currentClanName = currentClanName;
  if (target.trophies === null && trophies !== null) target.trophies = trophies;
  if (target.builderTrophies === null && builderTrophies !== null) target.builderTrophies = builderTrophies;
  if (target.warStars === null && warStars !== null) target.warStars = warStars;
  if (target.expLevel === null && expLevel !== null) target.expLevel = expLevel;
  if (target.role === null && role !== null) target.role = role;
  if (target.leagueName === null && leagueName !== null) target.leagueName = leagueName;
  if (target.currentWeight === null && currentWeight !== null) target.currentWeight = currentWeight;
  if (target.currentWeightSource === null && currentWeightSource !== null) target.currentWeightSource = currentWeightSource;
  if (target.currentWeightMeasuredAt === null && currentWeightMeasuredAt !== null) target.currentWeightMeasuredAt = currentWeightMeasuredAt;
  if (target.achievementsJson === null && achievementsJson !== null) target.achievementsJson = achievementsJson;
  if (target.lastSeenAt === null && lastSeenAt !== null) target.lastSeenAt = lastSeenAt;
  if (target.lastFetchedAt === null && lastFetchedAt !== null) target.lastFetchedAt = lastFetchedAt;
  if (target.lastSource === null && lastSource !== null) target.lastSource = lastSource;
  if (target.source === "missing" && sourceLabel !== "missing") {
    target.source = sourceLabel;
  }
}

function applyLivePlayer(target: PlayerCurrentLike, livePlayer: any, now: Date): void {
  target.playerName = normalizeText(livePlayer?.name ?? null) ?? target.playerName;
  const liveTownHall = normalizeNumber(livePlayer?.townHallLevel ?? livePlayer?.townHall ?? null);
  if (liveTownHall !== null) {
    target.townHall = liveTownHall;
  }

  const clanTag = normalizeClanTag(String(livePlayer?.clan?.tag ?? ""));
  target.currentClanTag = clanTag || null;
  target.currentClanName = normalizeText(livePlayer?.clan?.name ?? null);
  target.trophies = normalizeNumber(livePlayer?.trophies ?? null) ?? target.trophies;
  target.builderTrophies = normalizeNumber(livePlayer?.builderBaseTrophies ?? livePlayer?.versusTrophies ?? null) ?? target.builderTrophies;
  target.warStars = normalizeNumber(livePlayer?.warStars ?? null) ?? target.warStars;
  target.expLevel = normalizeNumber(livePlayer?.expLevel ?? null) ?? target.expLevel;
  target.role = normalizeText(livePlayer?.role ?? null) ?? target.role;
  target.leagueName = normalizeText(livePlayer?.league?.name ?? null) ?? target.leagueName;
  target.achievementsJson = Array.isArray(livePlayer?.achievements) ? (livePlayer.achievements as Prisma.JsonValue) : target.achievementsJson;
  target.lastSeenAt = now;
  target.lastFetchedAt = now;
  target.lastSource = "live_refresh";
  target.source = "live_refresh";
  target.liveRefreshInvoked = true;
}

function isFieldMissing(record: PlayerCurrentLike, field: PlayerCurrentResolutionField): boolean {
  switch (field) {
    case "playerName":
      return record.playerName === null;
    case "townHall":
      return record.townHall === null;
    case "currentClanTag":
      return record.currentClanTag === null;
    case "currentClanName":
      return record.currentClanName === null;
    case "trophies":
      return record.trophies === null;
    case "builderTrophies":
      return record.builderTrophies === null;
    case "warStars":
      return record.warStars === null;
    case "expLevel":
      return record.expLevel === null;
    case "role":
      return record.role === null;
    case "leagueName":
      return record.leagueName === null;
    case "currentWeight":
      return record.currentWeight === null;
    default:
      return true;
  }
}

function hasUsefulPersistableData(record: PlayerCurrentLike): boolean {
  return [
    record.playerName,
    record.townHall,
    record.currentClanTag,
    record.currentClanName,
    record.trophies,
    record.builderTrophies,
    record.warStars,
    record.expLevel,
    record.role,
    record.leagueName,
    record.currentWeight,
    record.currentWeightSource,
    record.currentWeightMeasuredAt,
    record.achievementsJson,
    record.lastSeenAt,
    record.lastFetchedAt,
    record.lastSource,
  ].some((value) => value !== null && value !== undefined && value !== "");
}

function buildPersistData(record: PlayerCurrentLike): {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
  currentClanTag: string | null;
  currentClanName: string | null;
  trophies: number | null;
  builderTrophies: number | null;
  warStars: number | null;
  expLevel: number | null;
  role: string | null;
  leagueName: string | null;
  currentWeight: number | null;
  currentWeightSource: string | null;
  currentWeightMeasuredAt: Date | null;
  achievementsJson?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  lastSeenAt: Date | null;
  lastFetchedAt: Date | null;
  lastSource: string | null;
} {
  return {
    playerTag: record.playerTag,
    playerName: record.playerName,
    townHall: record.townHall,
    currentClanTag: record.currentClanTag,
    currentClanName: record.currentClanName,
    trophies: record.trophies,
    builderTrophies: record.builderTrophies,
    warStars: record.warStars,
    expLevel: record.expLevel,
    role: record.role,
    leagueName: record.leagueName,
    currentWeight: record.currentWeight,
    currentWeightSource: record.currentWeightSource,
    currentWeightMeasuredAt: record.currentWeightMeasuredAt,
    achievementsJson: record.achievementsJson === null ? undefined : (record.achievementsJson as Prisma.InputJsonValue),
    lastSeenAt: record.lastSeenAt,
    lastFetchedAt: record.lastFetchedAt,
    lastSource: record.lastSource,
  };
}

function normalizeFields(input: string[]): string[] {
  return [...new Set(input.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
}

function isPlayerCurrentStaleForSignup(
  record: PlayerCurrentLike | null | undefined,
  now: Date,
  maxAcceptedAgeMs: number,
): boolean {
  if (!record?.lastFetchedAt) {
    return true;
  }
  return now.getTime() - record.lastFetchedAt.getTime() >= maxAcceptedAgeMs;
}

function shouldLiveRefreshForRequiredFields(input: {
  currentRecord: PlayerCurrentLike | null | undefined;
  resolvedRecord: PlayerCurrentLike;
  requireFields: PlayerCurrentResolutionField[];
  refreshPolicy: PlayerCurrentRefreshPolicy;
  now: Date;
  maxAcceptedAgeMs: number;
}): boolean {
  const hasMissingRequiredField = input.requireFields.some((field) => isFieldMissing(input.resolvedRecord, field));
  if (hasMissingRequiredField) {
    return true;
  }
  if (input.refreshPolicy !== "missing_or_stale") {
    return false;
  }
  return isPlayerCurrentStaleForSignup(input.currentRecord, input.now, input.maxAcceptedAgeMs);
}

export class PlayerCurrentService {
  async listPlayerCurrentByTags(tags: string[]): Promise<Map<string, PlayerCurrentLike>> {
    const normalizedTags = normalizeFields(tags);
    if (normalizedTags.length <= 0) {
      return new Map();
    }

    const rows = await prisma.playerCurrent.findMany({
      where: {
        playerTag: { in: normalizedTags },
      },
      select: {
        playerTag: true,
        playerName: true,
        townHall: true,
        currentClanTag: true,
        currentClanName: true,
        trophies: true,
        builderTrophies: true,
        warStars: true,
        expLevel: true,
        role: true,
        leagueName: true,
        currentWeight: true,
        currentWeightSource: true,
        currentWeightMeasuredAt: true,
        achievementsJson: true,
        lastSeenAt: true,
        lastFetchedAt: true,
        lastSource: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const result = new Map<string, PlayerCurrentLike>();
    for (const row of rows) {
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) continue;
      result.set(playerTag, toPlayerCurrentLike(row as PlayerCurrentRow));
    }
    return result;
  }

  async hydrateMissingCurrentPlayersForTags(input: {
    playerTags: string[];
    cocService?: CoCService | null;
    requireFields?: PlayerCurrentResolutionField[];
  }): Promise<Map<string, PlayerCurrentLike>> {
    return this.resolveCurrentPlayersForTags(input);
  }

  async resolveCurrentPlayersForTags(input: {
    playerTags: string[];
    cocService?: CoCService | null;
    requireFields?: PlayerCurrentResolutionField[];
    refreshPolicy?: PlayerCurrentRefreshPolicy;
    maxAcceptedAgeMs?: number;
  }): Promise<Map<string, PlayerCurrentLike>> {
    const normalizedTags = normalizeFields(input.playerTags);
    if (normalizedTags.length <= 0) {
      return new Map();
    }

    const requireFields = input.requireFields && input.requireFields.length > 0 ? [...new Set(input.requireFields)] : DEFAULT_REQUIRE_FIELDS;
    const refreshPolicy: PlayerCurrentRefreshPolicy = input.refreshPolicy ?? "missing_only";
    const maxAcceptedAgeMs = Math.max(1, Math.trunc(Number(input.maxAcceptedAgeMs ?? PLAYER_CURRENT_SIGNUP_MAX_AGE_MS) || PLAYER_CURRENT_SIGNUP_MAX_AGE_MS));
    const now = new Date();

    const [playerCurrentRows, fwaRows, snapshotRows] = await Promise.all([
      this.listPlayerCurrentByTags(normalizedTags),
      prisma.fwaPlayerCatalog.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: {
          playerTag: true,
          latestName: true,
          latestTownHall: true,
          latestKnownWeight: true,
          firstSeenAt: true,
          lastSeenAt: true,
          lastSyncedAt: true,
        },
      }),
      todoSnapshotService.listSnapshotsByPlayerTags({
        playerTags: normalizedTags,
      }),
    ]);

    const fwaByTag = new Map<string, FwaPlayerCatalogRow>();
    for (const row of fwaRows) {
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) continue;
      fwaByTag.set(playerTag, {
        playerTag,
        latestName: normalizeText(row.latestName) ?? row.latestName,
        latestTownHall: normalizeNumber(row.latestTownHall),
        latestKnownWeight: normalizeNumber(row.latestKnownWeight),
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        lastSyncedAt: row.lastSyncedAt,
      });
    }

    const snapshotByTag = new Map<string, TodoSnapshotRow>();
    for (const row of snapshotRows as Array<{ playerTag: string; playerName: string; townHall?: unknown; clanTag?: string | null; clanName?: string | null; updatedAt?: Date; lastUpdatedAt?: Date | null }>) {
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) continue;
      snapshotByTag.set(playerTag, {
        playerTag,
        playerName: normalizeText(row.playerName) ?? row.playerName,
        townHall: normalizeNumber(row.townHall ?? null),
        clanTag: normalizeClanTag(String(row.clanTag ?? "")) || null,
        clanName: normalizeText(row.clanName ?? null),
        updatedAt: row.updatedAt ?? new Date(),
        lastUpdatedAt: row.lastUpdatedAt ?? row.updatedAt ?? null,
      });
    }

    const resolved = new Map<string, PlayerCurrentLike>();
    for (const playerTag of normalizedTags) {
      const current = playerCurrentRows.get(playerTag) ?? null;
      const state = current ? { ...current } : createMissingPlayerCurrent({ playerTag });
      const fwa = fwaByTag.get(playerTag) ?? null;
      if (fwa) {
        applyMissingFields(
          state,
          {
            playerName: fwa.latestName,
            townHall: fwa.latestTownHall,
            currentWeight: fwa.latestKnownWeight,
            currentWeightSource: fwa.latestKnownWeight !== null ? "FWA" : null,
            currentWeightMeasuredAt: fwa.lastSyncedAt,
            lastSeenAt: fwa.lastSeenAt,
            lastFetchedAt: fwa.lastSyncedAt,
            lastSource: "fwa_player_catalog",
          },
          "fwa_player_catalog",
        );
      }
      const snapshot = snapshotByTag.get(playerTag) ?? null;
      if (snapshot) {
        applyMissingFields(
          state,
          {
            playerName: snapshot.playerName,
            townHall: snapshot.townHall,
            currentClanTag: snapshot.clanTag,
            currentClanName: snapshot.clanName,
            lastSeenAt: snapshot.updatedAt,
            lastFetchedAt: snapshot.lastUpdatedAt ?? snapshot.updatedAt,
            lastSource: "todo_snapshot",
          },
          "todo_snapshot",
        );
      }
      resolved.set(playerTag, state);
    }

    const liveCandidates = normalizedTags.filter((playerTag) =>
      shouldLiveRefreshForRequiredFields({
        currentRecord: playerCurrentRows.get(playerTag) ?? null,
        resolvedRecord: resolved.get(playerTag) ?? createMissingPlayerCurrent({ playerTag }),
        requireFields,
        refreshPolicy,
        now,
        maxAcceptedAgeMs,
      }),
    );

    const cocService = input.cocService ?? null;
    if (cocService && typeof cocService.getPlayerRaw === "function" && liveCandidates.length > 0) {
      const liveRows = await Promise.all(
        liveCandidates.map(async (playerTag) => {
          const livePlayer = await cocService.getPlayerRaw(playerTag).catch(() => null);
          return [playerTag, livePlayer] as const;
        }),
      );
      for (const [playerTag, livePlayer] of liveRows) {
        if (!livePlayer) continue;
        const state = resolved.get(playerTag) ?? createMissingPlayerCurrent({ playerTag });
        applyLivePlayer(state, livePlayer, now);
        resolved.set(playerTag, state);
      }
    }

    const persistableRows: Array<ReturnType<typeof buildPersistData>> = [];
    for (const playerTag of normalizedTags) {
      const state = resolved.get(playerTag) ?? createMissingPlayerCurrent({ playerTag });
      resolved.set(playerTag, state);

      if (hasUsefulPersistableData(state)) {
        persistableRows.push(buildPersistData(state));
      }
    }

    if (persistableRows.length > 0) {
      await Promise.all(
        persistableRows.map((data) =>
          prisma.playerCurrent.upsert({
            where: { playerTag: data.playerTag },
            create: data,
            update: (() => {
              const { playerTag: _playerTag, ...updateData } = data;
              return updateData;
            })(),
          }),
        ),
      );
    }

    return resolved;
  }

  async upsertPlayerCurrentFromLivePlayer(input: {
    playerTag: string;
    livePlayer: unknown;
    existing?: PlayerCurrentLike | null;
    source?: PlayerCurrentResolutionSource;
    now?: Date;
  }): Promise<PlayerCurrentLike | null> {
    const playerTag = normalizePlayerTag(input.playerTag);
    if (!playerTag || !input.livePlayer) {
      return null;
    }

    const state = input.existing ? { ...input.existing } : createMissingPlayerCurrent({ playerTag });
    applyLivePlayer(state, input.livePlayer, input.now ?? new Date());
    const data = buildPersistData(state);
    await prisma.playerCurrent.upsert({
      where: { playerTag },
      create: data,
      update: (() => {
        const { playerTag: _playerTag, ...updateData } = data;
        return updateData;
      })(),
    });
    return {
      ...state,
      source: input.source ?? "live_refresh",
      liveRefreshInvoked: true,
    };
  }

  isPlayerCurrentStaleForSignup(record: PlayerCurrentLike | null | undefined, now = new Date(), maxAcceptedAgeMs = PLAYER_CURRENT_SIGNUP_MAX_AGE_MS): boolean {
    return isPlayerCurrentStaleForSignup(record, now, maxAcceptedAgeMs);
  }
}

/** Purpose: provide one singleton current-player resolver for roster signup paths. */
export const playerCurrentService = new PlayerCurrentService();
