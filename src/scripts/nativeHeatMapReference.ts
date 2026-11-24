import { readFile } from "node:fs/promises";
import { NativeHeatMapReferencePublicationService, buildNativeHeatMapReferencePreview } from "../services/NativeHeatMapReferencePublicationService";
import { validateNativeReferenceCandidateArtifact, type NativeReferenceCandidateArtifact } from "../helper/nativeHeatMapRefCandidate";

type Args = Record<string, string | boolean>;

function parseArgs(argv: readonly string[]): { command: string; args: Args } {
  const [command = "", ...rest] = argv;
  const args: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else args[key] = true;
  }
  return { command, args };
}

function required(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing --${key}`);
  return value;
}

async function readCandidate(path: string): Promise<NativeReferenceCandidateArtifact> {
  const candidate = JSON.parse(await readFile(path, "utf8")) as NativeReferenceCandidateArtifact;
  if (!validateNativeReferenceCandidateArtifact(candidate)) throw new Error("candidate artifact failed native validation");
  return candidate;
}

function usage(): string {
  return [
    "Operator-controlled native reference commands:",
    "  native-reference preview --candidate <json>",
    "  native-reference publish --candidate <json> --request-key <key> --expected-fence-token <n> [--expected-generation-id <id>] --confirm",
    "  native-reference verify",
    "  native-reference rollback --expected-generation-id <id> --expected-fence-token <n> --confirm",
    "",
    "Publication is provisional and informational only. No command activates operational recommendations.",
  ].join("\n");
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  const service = new NativeHeatMapReferencePublicationService();
  if (command === "preview") {
    const candidate = await readCandidate(required(args, "candidate"));
    console.log(JSON.stringify(buildNativeHeatMapReferencePreview(candidate, { requestKey: typeof args["request-key"] === "string" ? args["request-key"] : undefined }), null, 2));
    return;
  }
  if (command === "publish") {
    if (!args.confirm) throw new Error("publish requires explicit --confirm");
    const candidate = await readCandidate(required(args, "candidate"));
    const preview = buildNativeHeatMapReferencePreview(candidate, { requestKey: required(args, "request-key") });
    console.log(JSON.stringify(await service.publish({
      preview,
      requestKey: required(args, "request-key"),
      actorDiscordUserId: typeof args.actor === "string" ? args.actor : null,
      expectedGenerationId: typeof args["expected-generation-id"] === "string" ? args["expected-generation-id"] : null,
      expectedFenceToken: BigInt(required(args, "expected-fence-token")),
    }), null, 2));
    return;
  }
  if (command === "verify") {
    console.log(JSON.stringify(await service.readCurrent(), (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
    return;
  }
  if (command === "rollback") {
    if (!args.confirm) throw new Error("rollback requires explicit --confirm");
    console.log(JSON.stringify(await service.rollback({
      expectedGenerationId: required(args, "expected-generation-id"),
      expectedFenceToken: BigInt(required(args, "expected-fence-token")),
      actorDiscordUserId: typeof args.actor === "string" ? args.actor : null,
    }), (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
    return;
  }
  console.log(usage());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
