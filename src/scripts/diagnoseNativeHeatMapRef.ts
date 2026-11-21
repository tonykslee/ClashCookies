import { readFile } from "node:fs/promises";
import {
  generateNativeHeatMapRefCandidate,
  NATIVE_REFERENCE_ERA_POLICY_VERSION,
  NATIVE_REFERENCE_SYNTHETIC_EVIDENCE_TRUST,
  NATIVE_REFERENCE_SYNTHETIC_SOURCE_CATEGORY,
  type NativeReferenceSourceRoster,
} from "../helper/nativeHeatMapRefCandidate";
import { HEAT_MAP_REF_SEED_ROWS } from "../services/HeatMapRefSeedData";

type CliOptions = {
  fixturePath: string | null;
  useDb: boolean;
  evaluationAt: string;
  eraStart: string;
  eraEnd: string;
  threshold: number | undefined;
};

const valueOptions = new Set(["--fixture", "--evaluation-at", "--era-start", "--era-end", "--threshold"]);
const flagOptions = new Set(["--db"]);

function isIso(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function parseOptions(argv: readonly string[]): CliOptions {
  const values: Partial<CliOptions> = { fixturePath: null, useDb: false, threshold: undefined };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument || (!valueOptions.has(argument) && !flagOptions.has(argument))) throw new Error(`unknown option: ${argument ?? ""}`);
    if (seen.has(argument)) throw new Error(`duplicate option: ${argument}`);
    seen.add(argument);
    if (flagOptions.has(argument)) {
      values.useDb = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    const key = argument === "--fixture" ? "fixturePath" : argument === "--evaluation-at" ? "evaluationAt" : argument === "--era-start" ? "eraStart" : argument === "--era-end" ? "eraEnd" : "threshold";
    (values as Record<string, unknown>)[key] = argument === "--threshold" ? Number(value) : value;
    index += 1;
  }
  if (typeof values.evaluationAt !== "string" || typeof values.eraStart !== "string" || typeof values.eraEnd !== "string") throw new Error("--evaluation-at, --era-start, and --era-end are required");
  if (!isIso(values.evaluationAt) || !isIso(values.eraStart) || !isIso(values.eraEnd)) throw new Error("timestamps must be canonical ISO values");
  if (new Date(values.eraStart).getTime() > new Date(values.eraEnd).getTime()) throw new Error("era start must not be after era end");
  if (values.threshold !== undefined && (!Number.isInteger(values.threshold) || values.threshold <= 0)) throw new Error("threshold must be a positive integer");
  if (values.fixturePath && values.useDb || !values.fixturePath && !values.useDb) throw new Error("exactly one of --fixture or --db is required");
  return values as CliOptions;
}

function printUsage(): void {
  console.error("Usage: npm run diagnose:heatmap-ref-native -- --evaluation-at ISO --era-start ISO --era-end ISO (--fixture path.json | --db) [--threshold 10]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isIso(value));
}

function validateFixtureRoster(value: unknown): NativeReferenceSourceRoster {
  if (!isRecord(value) || typeof value.clanTag !== "string" || !Number.isInteger(value.rosterSize) || !isNullableNumber(value.totalRawWeight) || !isNullableNumber(value.totalEffectiveWeight) || !isNullableTimestamp(value.observedAt) || !isNullableTimestamp(value.sourceUpdatedAt) || (value.sourceWarId !== null && !Number.isInteger(value.sourceWarId)) || !isNullableTimestamp(value.sourceWarStartTime) || !isNullableTimestamp(value.sourceWarEndTime) || (value.sourceWarState !== null && typeof value.sourceWarState !== "string") || !isNullableTimestamp(value.sourceCurrentWarUpdatedAt) || value.sourceIdentityStatus !== "VERIFIED" || value.sourceMatchType !== "FWA" || value.sourceMemberCompletenessStatus !== "VERIFIED" || !Array.isArray(value.members)) throw new Error("fixture contains an invalid roster contract");
  const members = value.members.map((member) => {
    if (!isRecord(member) || typeof member.clanTag !== "string" || typeof member.playerTag !== "string" || (member.position !== null && !Number.isInteger(member.position)) || (member.townHall !== null && !Number.isInteger(member.townHall)) || !isNullableNumber(member.rawWeight) || !isNullableNumber(member.effectiveWeight) || typeof member.effectiveWeightStatus !== "string" || !isNullableTimestamp(member.sourceSyncedAt ?? null)) throw new Error("fixture contains an invalid member contract");
    return member;
  });
  return { ...value, members } as unknown as NativeReferenceSourceRoster;
}

async function loadFixture(path: string): Promise<NativeReferenceSourceRoster[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.rosters)) throw new Error("fixture must contain a rosters array");
  return parsed.rosters.map(validateFixtureRoster);
}

async function main(): Promise<void> {
  let dbMode = false;
  try {
    const options = parseOptions(process.argv.slice(2));
    dbMode = options.useDb;
    const eraPolicy = { policyId: "fwa-native-current-era", policyVersion: NATIVE_REFERENCE_ERA_POLICY_VERSION, eraStartIso: options.eraStart, eraEndIso: options.eraEnd };
    const bandDefinitions = HEAT_MAP_REF_SEED_ROWS.map((row) => ({ weightMinInclusive: row.weightMinInclusive, weightMaxInclusive: row.weightMaxInclusive }));
    const artifact = options.fixturePath
      ? generateNativeHeatMapRefCandidate({ sourceRosters: await loadFixture(options.fixturePath), bandDefinitions, eraPolicy, evaluationAt: options.evaluationAt, sampleThreshold: options.threshold, sourceCategory: NATIVE_REFERENCE_SYNTHETIC_SOURCE_CATEGORY, evidenceTrust: NATIVE_REFERENCE_SYNTHETIC_EVIDENCE_TRUST })
      : await (async () => {
          const { NativeHeatMapRefCandidateService } = await import("../services/NativeHeatMapRefCandidateService");
          return new NativeHeatMapRefCandidateService().generate({ evaluationAt: options.evaluationAt, eraPolicy, sampleThreshold: options.threshold, bandDefinitions });
        })();
    console.log(JSON.stringify(artifact, null, 2));
  } catch {
    printUsage();
    console.error("Native candidate generation failed: invalid arguments, fixture, or unavailable local persisted source.");
    process.exitCode = 1;
  } finally {
    if (dbMode) {
      try {
        const { getPrismaClient } = await import("../prisma");
        await getPrismaClient().$disconnect();
      } catch {
        // Cleanup failure must not replace the sanitized generation result.
      }
    }
  }
}

void main();
