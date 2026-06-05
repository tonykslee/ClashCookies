import { prisma } from "../prisma";
import {
  KNOWN_AFFECTED_ENDED_WAR_CLANS,
  repairEndedWarRows,
} from "../services/war-events/endedWarRepair";

type ScriptArgs = {
  apply: boolean;
  clanTags: string[];
  knownAffectedOnly: boolean;
};

function parseTags(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseArgs(argv: string[]): ScriptArgs {
  const values = new Map<string, string | boolean | string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      values.set("apply", true);
      continue;
    }
    if (token === "--known-affected") {
      values.set("known-affected", true);
      continue;
    }
    if ((token === "--clan" || token === "--clan-tag") && i + 1 < argv.length) {
      const existing = (values.get("clan") as string[] | undefined) ?? [];
      values.set("clan", [...existing, argv[i + 1]]);
      i += 1;
      continue;
    }
  }

  const clanTagValues = (values.get("clan") as string[] | undefined) ?? [];
  const clanTags = Array.from(
    new Set(clanTagValues.flatMap((value) => parseTags(value))),
  );
  return {
    apply: Boolean(values.get("apply")),
    clanTags,
    knownAffectedOnly: Boolean(values.get("known-affected")),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scopeTags = args.clanTags.length > 0
    ? args.clanTags
    : args.knownAffectedOnly
      ? [...KNOWN_AFFECTED_ENDED_WAR_CLANS]
      : [];

  console.log(
    JSON.stringify(
      {
        event: "ended_war_repair_start",
        mode: args.apply ? "apply" : "dry-run",
        scope: scopeTags.length > 0 ? scopeTags : "all_not_in_war_rows",
      },
      null,
      2,
    ),
  );

  await repairEndedWarRows({
    apply: args.apply,
    clanTags: scopeTags,
    knownAffectedOnly: false,
    db: prisma,
    logger: console,
  });
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
