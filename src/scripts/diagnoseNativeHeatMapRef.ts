import { readFile } from "node:fs/promises";
import { getPrismaClient } from "../prisma";
import {
  generateNativeHeatMapRefCandidate,
  type NativeReferenceSourceRoster,
} from "../helper/nativeHeatMapRefCandidate";
import { NativeHeatMapRefCandidateService } from "../services/NativeHeatMapRefCandidateService";
import { HEAT_MAP_REF_SEED_ROWS } from "../services/HeatMapRefSeedData";

type CliOptions = {
  fixturePath: string | null;
  evaluationAt: string | null;
  eraStart: string | null;
  eraEnd: string | null;
  threshold: number | undefined;
};

function parseOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    fixturePath: null,
    evaluationAt: null,
    eraStart: null,
    eraEnd: null,
    threshold: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--fixture" && value) options.fixturePath = value;
    if (argument === "--evaluation-at" && value) options.evaluationAt = value;
    if (argument === "--era-start" && value) options.eraStart = value;
    if (argument === "--era-end" && value) options.eraEnd = value;
    if (argument === "--threshold" && value) options.threshold = Number(value);
    if (["--fixture", "--evaluation-at", "--era-start", "--era-end", "--threshold"].includes(argument ?? "")) index += 1;
  }
  return options;
}

function printUsage(): void {
  console.error(
    "Usage: npm run diagnose:heatmap-ref-native -- --evaluation-at ISO --era-start ISO --era-end ISO [--fixture path.json] [--threshold 10]",
  );
}

async function loadFixture(path: string): Promise<NativeReferenceSourceRoster[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { rosters?: unknown };
  if (!Array.isArray(parsed.rosters)) throw new Error("fixture must contain a rosters array");
  return parsed.rosters as NativeReferenceSourceRoster[];
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.evaluationAt || !options.eraStart || !options.eraEnd) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const eraPolicy = {
    policyId: "fwa-native-current-era",
    policyVersion: "explicit-window-v1",
    eraStartIso: options.eraStart,
    eraEndIso: options.eraEnd,
  };
  try {
    const artifact = options.fixturePath
      ? generateNativeHeatMapRefCandidate({
          sourceRosters: await loadFixture(options.fixturePath),
          bandDefinitions: HEAT_MAP_REF_SEED_ROWS.map((row) => ({
            weightMinInclusive: row.weightMinInclusive,
            weightMaxInclusive: row.weightMaxInclusive,
          })),
          eraPolicy,
          evaluationAt: options.evaluationAt,
          sampleThreshold: options.threshold,
        })
      : await new NativeHeatMapRefCandidateService().generate({
          evaluationAt: options.evaluationAt,
          eraPolicy,
          sampleThreshold: options.threshold,
        });
    console.log(JSON.stringify(artifact, null, 2));
  } catch {
    console.error("Native candidate generation failed: source or fixture was unavailable.");
    process.exitCode = 1;
  } finally {
    await getPrismaClient().$disconnect();
  }
}

void main();

