import { SettingsService } from "./SettingsService";

const PLAYER_SIGNAL_STATE_VERSION = 1;

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

type PlayerSignalState = {
  version: number;
  tag: string;
  name: string;
  clanTag: string;
  counters: Record<CounterKey, number>;
  hashes: Record<HashKey, string>;
  signalTimes: Partial<Record<SignalKey, number>>;
  lastSeenAtMs: number | null;
  updatedAtMs: number;
};

type PlayerSignalInput = {
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

type ProcessedSignals = {
  state: PlayerSignalState;
  changedSignals: SignalKey[];
  lastSeenAtMs: number | null;
};

/** Purpose: signal state key. */
function signalStateKey(tag: string): string {
  return `player_signal_state:${tag.toUpperCase()}`;
}

/** Purpose: to finite number. */
function toFiniteNumber(value: unknown): number {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return 0;
  return num;
}

function normalizeArray<T = unknown>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value as T[];
}

/** Purpose: stable hash from array. */
function stableHashFromArray(items: unknown[]): string {
  const normalized = items
    .map((item) => {
      if (!item || typeof item !== "object") return JSON.stringify(item);
      const entries = Object.entries(item as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, v]);
      return JSON.stringify(entries);
    })
    .sort();
  return normalized.join("|");
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
    },
    hashes: {
      achievements: stableHashFromArray(normalizeArray(input.achievements)),
      troops: stableHashFromArray(normalizeArray(input.troops)),
      heroes: stableHashFromArray(normalizeArray(input.heroes)),
      spells: stableHashFromArray(normalizeArray(input.spells)),
      pets: stableHashFromArray(normalizeArray(input.pets)),
      heroEquipment: stableHashFromArray(normalizeArray(input.heroEquipment)),
    },
    signalTimes: {},
    lastSeenAtMs: null,
    updatedAtMs: input.nowMs,
  };
}

/** Purpose: parse state. */
function parseState(raw: string | null): PlayerSignalState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PlayerSignalState;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== PLAYER_SIGNAL_STATE_VERSION) return null;
    return parsed;
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
  if (key === "warStars" || key === "attackWins" || key === "defenseWins" || key === "versusBattleWins" || key === "expLevel") {
    return next > previous;
  }
  return previous !== next;
}

export class ActivitySignalService {
  /** Purpose: initialize service dependencies. */
  constructor(private readonly settings = new SettingsService()) {}

  /** Purpose: get state. */
  async getState(tag: string): Promise<PlayerSignalState | null> {
    return parseState(await this.settings.get(signalStateKey(tag)));
  }

  /** Purpose: process player. */
  async processPlayer(input: PlayerSignalInput): Promise<ProcessedSignals> {
    const existing = await this.getState(input.tag);
    const nowMs = input.nowMs;
    const changedSignals: SignalKey[] = [];
    const base = existing ?? getDefaultState(input);

    const next: PlayerSignalState = {
      ...base,
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

    const nextHashes: Record<HashKey, string> = {
      achievements: stableHashFromArray(normalizeArray(input.achievements)),
      troops: stableHashFromArray(normalizeArray(input.troops)),
      heroes: stableHashFromArray(normalizeArray(input.heroes)),
      spells: stableHashFromArray(normalizeArray(input.spells)),
      pets: stableHashFromArray(normalizeArray(input.pets)),
      heroEquipment: stableHashFromArray(normalizeArray(input.heroEquipment)),
    };

    for (const key of HASH_KEYS) {
      const previous = base.hashes[key] ?? "";
      const current = nextHashes[key];
      if (existing && previous !== current) {
        next.signalTimes[key] = nowMs;
        changedSignals.push(key);
      }
      next.hashes[key] = current;
    }

    const signalMsValues = Object.values(next.signalTimes).filter(
      (v): v is number => Number.isFinite(v)
    );
    next.lastSeenAtMs = signalMsValues.length > 0 ? Math.max(...signalMsValues) : base.lastSeenAtMs;

    if (!existing && next.lastSeenAtMs === null) {
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
    achievements: "Achievements",
    troops: "Troops",
    heroes: "Heroes",
    spells: "Spells",
    pets: "Pets",
    heroEquipment: "Hero Equipment",
  };
  return map[key];
}
