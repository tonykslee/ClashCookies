import { prisma } from "../prisma";
import {
  KNOWN_AFFECTED_ENDED_WAR_CLANS,
  repairEndedWarRows,
} from "../services/war-events/endedWarRepair";

export type RepairEndedWarStateScriptArgs = {
  apply: boolean;
  clanTags: string[];
  knownAffectedOnly: boolean;
  all: boolean;
};

function parseTags(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function parseRepairEndedWarStateArgs(argv: string[]): RepairEndedWarStateScriptArgs {
  const values = new Map<string, string | boolean | string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      values.set("apply", true);
      continue;
    }
    if (token === "--all") {
      values.set("all", true);
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
    all: Boolean(values.get("all")),
  };
}

function resolveScopeMode(args: RepairEndedWarStateScriptArgs): "all" | "known-affected" | "clans" | null {
  const modes = [
    args.all ? "all" : null,
    args.knownAffectedOnly ? "known-affected" : null,
    args.clanTags.length > 0 ? "clans" : null,
  ].filter((value): value is "all" | "known-affected" | "clans" => value !== null);
  if (modes.length === 0) return null;
  if (modes.length > 1) {
    throw new Error(
      "Choose exactly one explicit scope: --known-affected, --clan/--clan-tag, or --all.",
    );
  }
  return modes[0];
}

export function resolveRepairEndedWarStateScope(
  args: RepairEndedWarStateScriptArgs,
): { clanTags: string[]; scopeMode: "all" | "known-affected" | "clans" | null } {
  const scopeMode = resolveScopeMode(args);
  if (args.apply && !scopeMode) {
    throw new Error(
      "Apply mode requires one explicit scope: --known-affected, --clan/--clan-tag, or --all.",
    );
  }
  if (scopeMode === "known-affected") {
    return { clanTags: [...KNOWN_AFFECTED_ENDED_WAR_CLANS], scopeMode };
  }
  if (scopeMode === "clans") {
    return { clanTags: [...args.clanTags], scopeMode };
  }
  return { clanTags: [], scopeMode };
}

async function main(): Promise<void> {
  const args = parseRepairEndedWarStateArgs(process.argv.slice(2));
  const scope = resolveRepairEndedWarStateScope(args);

  console.log(
    JSON.stringify(
      {
        event: "ended_war_repair_start",
        mode: args.apply ? "apply" : "dry-run",
        scope:
          scope.scopeMode === "all"
            ? "all_not_in_war_rows"
            : scope.scopeMode === "known-affected"
              ? "known_affected"
              : scope.scopeMode === "clans"
                ? scope.clanTags
                : "all_not_in_war_rows",
      },
      null,
      2,
    ),
  );

  await repairEndedWarRows({
    apply: args.apply,
    clanTags: scope.clanTags,
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
