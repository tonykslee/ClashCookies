import { describe, expect, it } from "vitest";
import {
  ActivitySignalService,
  canonicalPlayerSignalArray,
  extractGamesChampionTotalFromSignalState,
  extractSignalStateFreshnessMsFromState,
  fingerprintPlayerSignalArray,
  type PlayerSignalInput,
  type PlayerSignalState,
} from "../src/services/ActivitySignalService";

const HASH_FIELDS = [
  "achievements",
  "troops",
  "heroes",
  "spells",
  "pets",
  "heroEquipment",
] as const;

class MemorySettings {
  constructor(public value: string | null = null) {}

  async get(_key: string): Promise<string | null> {
    return this.value;
  }

  async set(_key: string, value: string): Promise<void> {
    this.value = value;
  }
}

function makeInput(overrides: Partial<PlayerSignalInput> = {}): PlayerSignalInput {
  return {
    tag: "#AAA111",
    name: "Alpha",
    clanTag: "#CLAN1",
    donations: 10,
    donationsReceived: 4,
    capitalGold: 100,
    trophies: 5000,
    builderTrophies: 3000,
    warStars: 20,
    attackWins: 12,
    defenseWins: 8,
    versusBattleWins: 5,
    expLevel: 200,
    achievements: [{ name: "Games Champion", value: 1200, nested: { b: 2, a: 1 } }],
    troops: [{ name: "Barbarian", level: 12 }],
    heroes: [{ name: "Barbarian King", level: 80 }],
    spells: [{ name: "Rage", level: 6 }],
    pets: [{ name: "L.A.S.S.I.", level: 10 }],
    heroEquipment: [{ name: "Barbarian Puppet", level: 18 }],
    nowMs: 1_000,
    ...overrides,
  };
}

function readState(settings: MemorySettings): PlayerSignalState {
  return JSON.parse(settings.value ?? "null") as PlayerSignalState;
}

function toV2State(input: PlayerSignalInput, v1State: PlayerSignalState): PlayerSignalState {
  const hashes = Object.fromEntries(
    HASH_FIELDS.map((field) => [field, fingerprintPlayerSignalArray(input[field])]),
  ) as PlayerSignalState["hashes"];
  return { ...v1State, version: 2, hashes };
}

async function seedV1State(input = makeInput()): Promise<{
  settings: MemorySettings;
  state: PlayerSignalState;
}> {
  const settings = new MemorySettings();
  const service = new ActivitySignalService(settings);
  await service.processPlayer(input);
  return { settings, state: readState(settings) };
}

describe("ActivitySignalService canonical representations", () => {
  it("preserves legacy array sorting, object-key sorting, and duplicates", () => {
    const first = [{ b: 2, a: 1 }, { name: "same" }, { name: "same" }];
    const reordered = [{ name: "same" }, { a: 1, b: 2 }, { name: "same" }];

    expect(canonicalPlayerSignalArray(first)).toBe(canonicalPlayerSignalArray(reordered));
    expect(canonicalPlayerSignalArray(first)).not.toBe(
      canonicalPlayerSignalArray(first.slice(0, 2)),
    );
  });

  it("keeps missing and non-array values equivalent to an empty array", () => {
    expect(canonicalPlayerSignalArray(undefined)).toBe("");
    expect(canonicalPlayerSignalArray(null)).toBe("");
    expect(canonicalPlayerSignalArray({})).toBe("");
    expect(canonicalPlayerSignalArray([])).toBe("");
  });

  it("does not recursively normalize nested objects", () => {
    expect(
      canonicalPlayerSignalArray([{ nested: { b: 2, a: 1 } }]),
    ).not.toBe(canonicalPlayerSignalArray([{ nested: { a: 1, b: 2 } }]));
  });

  it("generates a lowercase SHA-256 hex digest of the canonical representation", () => {
    expect(fingerprintPlayerSignalArray([])).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(fingerprintPlayerSignalArray(["alpha"])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ActivitySignalService version-aware state", () => {
  it("keeps first observations and unchanged v1 observations on the v1 write contract", async () => {
    const settings = new MemorySettings();
    const service = new ActivitySignalService(settings);
    const input = makeInput();

    const first = await service.processPlayer(input);
    const unchanged = await service.processPlayer({ ...input, nowMs: 2_000 });

    expect(first.changedSignals).toEqual([]);
    expect(first.lastSeenAtMs).toBe(1_000);
    expect(unchanged.changedSignals).toEqual([]);
    expect(unchanged.lastSeenAtMs).toBe(1_000);
    expect(unchanged.state.updatedAtMs).toBe(2_000);
    expect(unchanged.state.version).toBe(1);
    expect(unchanged.state.hashes.troops).toBe(canonicalPlayerSignalArray(input.troops));
  });

  it.each([
    ["donations decreases", { donations: 9 }, false],
    ["donations increase", { donations: 11 }, true],
    ["trophies change", { trophies: 4999 }, true],
    ["war stars decrease", { warStars: 19 }, false],
    ["war stars increase", { warStars: 21 }, true],
    [
      "Clan Games total decreases",
      { achievements: [{ name: "Games Champion", value: 1199 }] },
      false,
    ],
  ])("applies the existing counter activity predicate: %s", async (_label, override, expected) => {
    const input = makeInput();
    const { settings } = await seedV1State(input);
    const service = new ActivitySignalService(settings);
    const result = await service.processPlayer({ ...input, ...override, nowMs: 2_000 });

    const key = "donations" in override
      ? "donations"
      : "trophies" in override
        ? "trophies"
        : "warStars" in override
          ? "warStars"
          : "gamesChampion";
    expect(result.changedSignals.some((signal) => signal === key)).toBe(expected);
  });

  it("compares a valid v2 fixture by digest while persisting v1 values and freshness", async () => {
    const input = makeInput();
    const { state } = await seedV1State(input);
    const settings = new MemorySettings(JSON.stringify(toV2State(input, state)));
    const service = new ActivitySignalService(settings);

    const result = await service.processPlayer({ ...input, nowMs: 2_000 });
    const persisted = readState(settings);

    expect(result.changedSignals).toEqual([]);
    expect(result.lastSeenAtMs).toBe(state.lastSeenAtMs);
    expect(result.state.updatedAtMs).toBe(2_000);
    expect(persisted.version).toBe(1);
    expect(persisted.hashes.achievements).toBe(canonicalPlayerSignalArray(input.achievements));
    expect(extractGamesChampionTotalFromSignalState(JSON.stringify(toV2State(input, state)))).toBe(
      1200,
    );
    expect(
      extractSignalStateFreshnessMsFromState(JSON.stringify(toV2State(input, state))),
    ).toBe(state.lastSeenAtMs);
  });

  it("produces the same activity result for v1 and v2 on a legitimate change", async () => {
    const input = makeInput();
    const { state: v1State } = await seedV1State(input);
    const v1Settings = new MemorySettings(JSON.stringify(v1State));
    const v2Settings = new MemorySettings(JSON.stringify(toV2State(input, v1State)));
    const changedInput = {
      ...input,
      donations: 11,
      troops: [{ name: "Barbarian", level: 13 }],
      nowMs: 2_000,
    };

    const v1Result = await new ActivitySignalService(v1Settings).processPlayer(changedInput);
    const v2Result = await new ActivitySignalService(v2Settings).processPlayer(changedInput);

    expect(v2Result.changedSignals).toEqual(v1Result.changedSignals);
    expect(v2Result.state.signalTimes).toEqual(v1Result.state.signalTimes);
    expect(v2Result.lastSeenAtMs).toBe(v1Result.lastSeenAtMs);
  });

  it("fails closed for missing, unknown, malformed, and invalid v2 state", async () => {
    const missingSettings = new MemorySettings();
    const missingResult = await new ActivitySignalService(missingSettings).processPlayer(makeInput());
    expect(missingResult.lastSeenAtMs).toBe(1_000);
    expect(missingResult.changedSignals).toEqual([]);

    const { state } = await seedV1State();
    const invalidStates = [
      JSON.stringify({ ...state, version: 99 }),
      JSON.stringify({ ...state, version: 2 }),
      "not-json",
    ];

    for (const raw of invalidStates) {
      const settings = new MemorySettings(raw);
      const service = new ActivitySignalService(settings);
      expect(await service.getState("#AAA111")).toBeNull();
      const result = await service.processPlayer(makeInput({ nowMs: 2_000 }));
      expect(result.changedSignals).toEqual([]);
      expect(result.lastSeenAtMs).toBeNull();
      expect(result.state.version).toBe(1);
      expect(result.state.updatedAtMs).toBe(2_000);
    }
  });
});
