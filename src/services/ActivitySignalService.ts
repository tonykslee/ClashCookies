import { createHash } from "crypto";
import { SettingsService } from "./SettingsService";

const PLAYER_SIGNAL_STATE_VERSION = 1;
const PLAYER_SIGNAL_STATE_FINGERPRINT_VERSION = 2;

const COUNTER_KEYS = [
  "donations",
  "donationsReceived",
  "capitalGold",
  "trophies",
  "builderTrophies",
  "warStars",
  "attackWins",
  "defenseWins",
  "versusBattleWins",
  "expLevel",
  "gamesChampion",
] as const;

const HASH_KEYS = [
  "achievements",
  "troops",
  "heroes",
  "spells",
  "pets",
  "heroEquipment",
] as const;

const ALL_SIGNAL_KEYS = [
  "name",
  "clan",
  ...COUNTER_KEYS,
  ...HASH_KEYS,
] as const;

type CounterKey = (typeof COUNTER_KEYS)[number];
type HashKey = (typeof HASH_KEYS)[number];
export type SignalKey = (typeof ALL_SIGNAL_KEYS)[number];

export type PlayerSignalState = {
  version: typeof PLAYER_SIGNAL_STATE_VERSION | typeof PLAYER_SIGNAL_STATE_FINGERPRINT_VERSION;
  tag: string;
  name: string;
  clanTag: string;
  counters: Record<CounterKey, number>;
  hashes: Record<HashKey, string>;
  signalTimes: Partial<Record<SignalKey, number>>;
  lastSeenAtMs: number | null;
  updatedAtMs: number;
};

export type PlayerSignalInput = {
  tag: string;
  name: string;
  clanTag: string;
  donations: number;
  donationsReceived: number;
  capitalGold: number;
  trophies: number;
  builderTrophies: number;
  warStars: number;
  attackWins: number;
  defenseWins: number;
  versusBattleWins: number;
  expLevel: number;
  achievements: unknown[];
  troops: unknown[];
  heroes: unknown[];
  spells: unknown[];
  pets: unknown[];
  heroEquipment: unknown[];
  nowMs: number;
};

export type ProcessedSignals = {
  state: PlayerSignalState;
  changedSignals: SignalKey[];
  lastSeenAtMs: number | null;
};

/** Purpose: signal state key. */
function signalStateKey(tag: string): string {
  return `player_signal_state:${tag.toUpperCase()}`;
}

/** Purpose: expose deterministic signal-state key format for cross-service readers. */
export function buildPlayerSignalStateKey(tag: string): string {
  return signalStateKey(tag);
}

/** Purpose: extract one lifetime Clan Games total from stored player signal-state JSON. */
export function extractGamesChampionTotalFromSignalState(raw: string | null | undefined): number | null {
  const parsed = parseState(raw ?? null);
  if (parsed) {
    return Math.max(0, toFiniteNumber(parsed.counters?.gamesChampion));
  }
  if (!raw) return null;
  try {
    const fallback = JSON.parse(raw) as { counters?: Record<string, unknown> };
    const value = Number(fallback?.counters?.gamesChampion);
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
  } catch {
    return null;
  }
}

/** Purpose: extract one persisted freshness timestamp from a player signal-state JSON blob. */
export function extractSignalStateFreshnessMsFromState(raw: string | null | undefined): number | null {
  const parsed = parseVersionedObject(raw ?? null);
  if (!parsed) return null;
  const signalTimes = parsed.signalTimes;
  const candidates = [
    parsed.lastSeenAtMs,
    parsed.updatedAtMs,
    ...(signalTimes && typeof signalTimes === "object" && !Array.isArray(signalTimes)
      ? Object.values(signalTimes)
      : []),
  ].filter((value): value is number => Number.isFinite(value));
  if (candidates.length <= 0) return null;
  return Math.max(...candidates);
}

/** Purpose: to finite number. */
function toFiniteNumber(value: unknown): number {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return 0;
  return num;
}

/** Purpose: retain the existing version-gated shape used by downstream freshness readers. */
function parseVersionedObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const version = (parsed as Record<string, unknown>).version;
    if (
      version !== PLAYER_SIGNAL_STATE_VERSION &&
      version !== PLAYER_SIGNAL_STATE_FINGERPRINT_VERSION
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeArray<T = unknown>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value as T[];
}

/** Purpose: preserve the exact legacy serialized representation for one player array. */
export function canonicalPlayerSignalArray(value: unknown): string {
  const normalized = normalizeArray(value)
    .map((item) => {
      if (!item || typeof item !== "object") return JSON.stringify(item) ?? "";
      const entries = Object.entries(item as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, v]);
      return JSON.stringify(entries);
    })
    .sort();
  return normalized.join("|");
}

/** Purpose: generate the v2 fingerprint from the exact legacy representation. */
export function fingerprintPlayerSignalArray(value: unknown): string {
  return createHash("sha256").update(canonicalPlayerSignalArray(value), "utf8").digest("hex");
}

/** Purpose: build the six persisted v1 representations from one observation. */
function buildLegacyHashes(input: PlayerSignalInput): Record<HashKey, string> {
  return {
    achievements: canonicalPlayerSignalArray(input.achievements),
    troops: canonicalPlayerSignalArray(input.troops),
    heroes: canonicalPlayerSignalArray(input.heroes),
    spells: canonicalPlayerSignalArray(input.spells),
    pets: canonicalPlayerSignalArray(input.pets),
    heroEquipment: canonicalPlayerSignalArray(input.heroEquipment),
  };
}

/** Purpose: build the six v2 fingerprints from one observation. */
function buildFingerprintHashes(input: PlayerSignalInput): Record<HashKey, string> {
  return {
    achievements: fingerprintPlayerSignalArray(input.achievements),
    troops: fingerprintPlayerSignalArray(input.troops),
    heroes: fingerprintPlayerSignalArray(input.heroes),
    spells: fingerprintPlayerSignalArray(input.spells),
    pets: fingerprintPlayerSignalArray(input.pets),
    heroEquipment: fingerprintPlayerSignalArray(input.heroEquipment),
  };
}

/** Purpose: extract lifetime Clan Games points from CoC achievements payload. */
function extractGamesChampionTotal(achievements: unknown[]): number {
  for (const achievement of normalizeArray<Record<string, unknown>>(achievements)) {
    const name = String(achievement?.name ?? "").trim().toLowerCase();
    if (name !== "games champion") continue;
    return Math.max(0, toFiniteNumber(achievement?.value));
  }
  return 0;
}

/** Purpose: get default state. */
function getDefaultState(input: PlayerSignalInput): PlayerSignalState {
  return {
    version: PLAYER_SIGNAL_STATE_VERSION,
    tag: input.tag,
    name: input.name,
    clanTag: input.clanTag,
    counters: {
      donations: toFiniteNumber(input.donations),
      donationsReceived: toFiniteNumber(input.donationsReceived),
      capitalGold: toFiniteNumber(input.capitalGold),
      trophies: toFiniteNumber(input.trophies),
      builderTrophies: toFiniteNumber(input.builderTrophies),
      warStars: toFiniteNumber(input.warStars),
      attackWins: toFiniteNumber(input.attackWins),
      defenseWins: toFiniteNumber(input.defenseWins),
      versusBattleWins: toFiniteNumber(input.versusBattleWins),
      expLevel: toFiniteNumber(input.expLevel),
      gamesChampion: extractGamesChampionTotal(input.achievements),
    },
    hashes: buildLegacyHashes(input),
    signalTimes: {},
    lastSeenAtMs: null,
    updatedAtMs: input.nowMs,
  };
}

/** Purpose: validate one persisted signal-state object without coercing malformed fields. */
function isValidSignalStateShape(parsed: unknown): parsed is PlayerSignalState {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const candidate = parsed as Record<string, unknown>;
  const version = candidate.version;
  if (
    version !== PLAYER_SIGNAL_STATE_VERSION &&
    version !== PLAYER_SIGNAL_STATE_FINGERPRINT_VERSION
  ) {
    return false;
  }
  if (
    typeof candidate.tag !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.clanTag !== "string"
  ) {
    return false;
  }
  const counters = candidate.counters;
  if (!counters || typeof counters !== "object" || Array.isArray(counters)) return false;
  for (const key of COUNTER_KEYS) {
    const value = (counters as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
  }
  const hashes = candidate.hashes;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) return false;
  for (const key of HASH_KEYS) {
    const value = (hashes as Record<string, unknown>)[key];
    if (typeof value !== "string") return false;
    if (
      version === PLAYER_SIGNAL_STATE_FINGERPRINT_VERSION &&
      !/^[0-9a-f]{64}$/.test(value)
    ) {
      return false;
    }
  }
  const signalTimes = candidate.signalTimes;
  if (!signalTimes || typeof signalTimes !== "object" || Array.isArray(signalTimes)) {
    return false;
  }
  if (
    Object.values(signalTimes as Record<string, unknown>).some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  ) {
    return false;
  }
  if (
    candidate.lastSeenAtMs !== null &&
    (typeof candidate.lastSeenAtMs !== "number" || !Number.isFinite(candidate.lastSeenAtMs))
  ) {
    return false;
  }
  return typeof candidate.updatedAtMs === "number" && Number.isFinite(candidate.updatedAtMs);
}

/** Purpose: parse valid v1 or v2 state and reject unknown or malformed versions. */
function parseState(raw: string | null): PlayerSignalState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidSignalStateShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Purpose: should count counter change as activity. */
function shouldCountCounterChangeAsActivity(
  key: CounterKey,
  previous: number,
  next: number
): boolean {
  if (key === "trophies" || key === "builderTrophies") {
    return previous !== next;
  }
  if (key === "donations" || key === "donationsReceived" || key === "capitalGold") {
    return next > previous;
  }
  if (
    key === "warStars" ||
    key === "attackWins" ||
    key === "defenseWins" ||
    key === "versusBattleWins" ||
    key === "expLevel" ||
    key === "gamesChampion"
  ) {
    return next > previous;
  }
  return previous !== next;
}

export class ActivitySignalService {
  /** Purpose: initialize service dependencies. */
  constructor(private readonly settings: Pick<SettingsService, "get" | "set"> = new SettingsService()) {}

  /** Purpose: get state. */
  async getState(tag: string): Promise<PlayerSignalState | null> {
    return parseState(await this.settings.get(signalStateKey(tag)));
  }

  /** Purpose: process player. */
  async processPlayer(input: PlayerSignalInput): Promise<ProcessedSignals> {
    const raw = await this.settings.get(signalStateKey(input.tag));
    const existing = parseState(raw);
    const nowMs = input.nowMs;
    const changedSignals: SignalKey[] = [];
    const base = existing ?? getDefaultState(input);

    const next: PlayerSignalState = {
      ...base,
      version: PLAYER_SIGNAL_STATE_VERSION,
      tag: input.tag,
      name: input.name,
      clanTag: input.clanTag,
      counters: { ...base.counters },
      hashes: { ...base.hashes },
      signalTimes: { ...(base.signalTimes ?? {}) },
      updatedAtMs: nowMs,
    };

    if (existing && existing.name !== input.name) {
      next.signalTimes.name = nowMs;
      changedSignals.push("name");
    }
    if (existing && existing.clanTag !== input.clanTag) {
      next.signalTimes.clan = nowMs;
      changedSignals.push("clan");
    }

    const nextCounters: Record<CounterKey, number> = {
      donations: toFiniteNumber(input.donations),
      donationsReceived: toFiniteNumber(input.donationsReceived),
      capitalGold: toFiniteNumber(input.capitalGold),
      trophies: toFiniteNumber(input.trophies),
      builderTrophies: toFiniteNumber(input.builderTrophies),
      warStars: toFiniteNumber(input.warStars),
      attackWins: toFiniteNumber(input.attackWins),
      defenseWins: toFiniteNumber(input.defenseWins),
      versusBattleWins: toFiniteNumber(input.versusBattleWins),
      expLevel: toFiniteNumber(input.expLevel),
      gamesChampion: extractGamesChampionTotal(input.achievements),
    };

    for (const key of COUNTER_KEYS) {
      const previous = toFiniteNumber(base.counters[key]);
      const current = toFiniteNumber(nextCounters[key]);
      if (existing && shouldCountCounterChangeAsActivity(key, previous, current)) {
        next.signalTimes[key] = nowMs;
        changedSignals.push(key);
      }
      next.counters[key] = current;
    }

    const nextHashes = buildLegacyHashes(input);
    const comparisonHashes =
      existing?.version === PLAYER_SIGNAL_STATE_FINGERPRINT_VERSION
        ? buildFingerprintHashes(input)
        : nextHashes;

    for (const key of HASH_KEYS) {
      const previous = base.hashes[key] ?? "";
      const current = comparisonHashes[key];
      if (existing && previous !== current) {
        next.signalTimes[key] = nowMs;
        changedSignals.push(key);
      }
      next.hashes[key] = nextHashes[key];
    }

    const signalMsValues = Object.values(next.signalTimes).filter(
      (v): v is number => Number.isFinite(v)
    );
    next.lastSeenAtMs = signalMsValues.length > 0 ? Math.max(...signalMsValues) : base.lastSeenAtMs;

    if (!existing && raw === null && next.lastSeenAtMs === null) {
      next.lastSeenAtMs = nowMs;
    }

    await this.settings.set(signalStateKey(input.tag), JSON.stringify(next));

    return {
      state: next,
      changedSignals,
      lastSeenAtMs: next.lastSeenAtMs,
    };
  }
}

/** Purpose: signal key label. */
export function signalKeyLabel(key: SignalKey): string {
  const map: Record<SignalKey, string> = {
    name: "Name Change",
    clan: "Clan Change",
    donations: "Donations",
    donationsReceived: "Donations Received",
    capitalGold: "Capital Contributions",
    trophies: "Trophies",
    builderTrophies: "Builder Trophies",
    warStars: "War Stars",
    attackWins: "Attack Wins",
    defenseWins: "Defense Wins",
    versusBattleWins: "Versus Wins",
    expLevel: "XP Level",
    gamesChampion: "Clan Games Points",
    achievements: "Achievements",
    troops: "Troops",
    heroes: "Heroes",
    spells: "Spells",
    pets: "Pets",
    heroEquipment: "Hero Equipment",
  };
  return map[key];
}
