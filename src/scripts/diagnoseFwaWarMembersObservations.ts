import { normalizeFwaTag } from "../services/fwa-feeds/normalize";
import { getPrismaClient } from "../prisma";

type Options = {
  clanTag: string | null;
  limit: number;
};

function parseOptions(argv: readonly string[]): Options {
  let clanTag: string | null = null;
  let limit = 20;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--clan-tag") {
      const value = argv[++index];
      if (!value) throw new Error("--clan-tag requires a value");
      clanTag = normalizeFwaTag(value) || null;
      if (!clanTag) throw new Error("--clan-tag must be a valid clan tag");
    } else if (argument === "--limit") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("--limit must be an integer from 1 to 100");
      }
      limit = value;
    } else {
      throw new Error(`unknown option: ${argument ?? ""}`);
    }
  }
  return { clanTag, limit };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const prisma = getPrismaClient();
  const where = options.clanTag ? { clanTag: options.clanTag } : undefined;
  const [retainedObservationCount, observations] = await Promise.all([
    prisma.fwaWarMembersObservation.count({ where }),
    prisma.fwaWarMembersObservation.findMany({
      where,
      orderBy: [{ firstObservedAt: "desc" }, { id: "desc" }],
      take: options.limit,
      select: {
        clanTag: true,
        firstObservedAt: true,
        rawRowCount: true,
        acceptedRowCount: true,
        discardedRowCount: true,
        rosterCompletenessStatus: true,
        weightStatus: true,
        rawWeightPresentCount: true,
        rawWeightMissingCount: true,
        rawWeightInvalidCount: true,
        canonicalSourceFingerprint: true,
        rosterFingerprint: true,
        sourceQualityReasonCodes: true,
        sourceAuthorityStatus: true,
      },
    }),
  ]);

  console.log(JSON.stringify({
    observationSchema: "war-members-observation-v1",
    filter: { clanTag: options.clanTag },
    retainedObservationCount,
    returnedObservationCount: observations.length,
    observations,
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(`FWA WarMembers observation diagnosis failed: ${String(error)}`);
  process.exitCode = 1;
});
