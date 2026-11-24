import { readFile } from "node:fs/promises";
import { NativeHeatMapReferencePublicationService, buildNativeHeatMapReferencePreview } from "../services/NativeHeatMapReferencePublicationService";
import { validateNativeReferenceCandidateArtifact, type NativeReferenceCandidateArtifact } from "../helper/nativeHeatMapRefCandidate";
import { prisma } from "../prisma";

type Args = Record<string, string | boolean>;
const VALUE_FLAGS = new Set(["candidate", "request-key", "expected-generation-id", "expected-fence-token", "actor"]);
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  preview: new Set(["candidate", "request-key"]),
  publish: new Set(["candidate", "request-key", "expected-generation-id", "expected-fence-token", "actor", "confirm"]),
  verify: new Set(),
  rollback: new Set(["expected-generation-id", "expected-fence-token", "actor", "confirm"]),
};

export function parseArgs(argv: readonly string[]): { command: string; args: Args } {
  const [command = "", ...rest] = argv;
  if (!COMMAND_FLAGS[command]) throw new Error(`unknown native reference command: ${command || "(missing)"}`);
  const args: Args = {};
  const allowed = COMMAND_FLAGS[command]!;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--") || token === "--") throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`unknown --${key} for ${command}`);
    if (Object.prototype.hasOwnProperty.call(args, key)) throw new Error(`duplicate --${key}`);
    const next = rest[index + 1];
    if (VALUE_FLAGS.has(key)) {
      if (!next || next.startsWith("--")) throw new Error(`missing value for --${key}`);
      args[key] = next;
      index += 1;
    } else {
      if (next === "true" || next === "false") throw new Error(`--${key} does not accept a value`);
      args[key] = true;
    }
  }
  return { command, args };
}

function required(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing --${key}`);
  return value;
}

function optional(args: Args, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function requiredBigInt(args: Args, key: string): bigint {
  const value = required(args, key);
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`invalid nonnegative integer for --${key}`);
  }
}

function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2);
}

async function readCandidate(path: string): Promise<NativeReferenceCandidateArtifact> {
  const candidate = JSON.parse(await readFile(path, "utf8")) as NativeReferenceCandidateArtifact;
  if (!validateNativeReferenceCandidateArtifact(candidate)) throw new Error("candidate artifact failed native validation");
  return candidate;
}

function usage(): string {
  return [
    "Operator-controlled native reference commands:",
    "  native-reference preview --candidate <json> [--request-key <key>]",
    "  native-reference publish --candidate <json> --request-key <key> --expected-generation-id <id|none> --expected-fence-token <n> --confirm",
    "  native-reference verify",
    "  native-reference rollback --expected-generation-id <id> --expected-fence-token <n> --confirm",
    "",
    "Publication is provisional and informational only. No command activates operational recommendations.",
  ].join("\n");
}

export async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  const service = new NativeHeatMapReferencePublicationService();
  if (command === "preview") {
    const candidate = await readCandidate(required(args, "candidate"));
    console.log(jsonSafe(buildNativeHeatMapReferencePreview(candidate, { requestKey: optional(args, "request-key") ?? undefined })));
    return;
  }
  if (command === "publish") {
    if (!args.confirm) throw new Error("publish requires explicit --confirm");
    const candidate = await readCandidate(required(args, "candidate"));
    const requestKey = required(args, "request-key");
    const preview = buildNativeHeatMapReferencePreview(candidate, { requestKey });
    const expectedGeneration = required(args, "expected-generation-id");
    const result = await service.publish({
      candidate,
      preview,
      requestKey,
      actorDiscordUserId: optional(args, "actor"),
      expectedGenerationId: expectedGeneration === "none" ? null : expectedGeneration,
      expectedFenceToken: requiredBigInt(args, "expected-fence-token"),
    });
    console.log(jsonSafe(result));
    if (!result.published) process.exitCode = 2;
    return;
  }
  if (command === "verify") {
    console.log(jsonSafe(await service.readCurrent()));
    return;
  }
  if (command === "rollback") {
    if (!args.confirm) throw new Error("rollback requires explicit --confirm");
    const result = await service.rollback({
      expectedGenerationId: required(args, "expected-generation-id"),
      expectedFenceToken: requiredBigInt(args, "expected-fence-token"),
      actorDiscordUserId: optional(args, "actor"),
    });
    console.log(jsonSafe(result));
    if (!result.rolledBack) process.exitCode = 2;
    return;
  }
  console.log(usage());
}

if (process.argv[1]?.match(/nativeHeatMapReference\.(?:ts|js)$/)) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
