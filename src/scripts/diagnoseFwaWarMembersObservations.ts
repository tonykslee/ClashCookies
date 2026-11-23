import { normalizeFwaTag } from "../services/fwa-feeds/normalize";
import { getPrismaClient } from "../prisma";

type Options = {
  clanTag: string | null;
  limit: number;
};

export const FWA_WAR_MEMBERS_OBSERVATION_EVIDENCE_LIMIT = 20;

/** Purpose: keep the bounded diagnostic deterministic while preferring the newest evidence revisions. */
export function selectNewestQualityEvidence<T extends { firstObservedAt: Date; id: string }>(
  evidence: readonly T[],
): T[] {
  return [...evidence]
    .sort((left, right) => {
      const observedAtDelta = right.firstObservedAt.getTime() - left.firstObservedAt.getTime();
      return observedAtDelta !== 0 ? observedAtDelta : right.id.localeCompare(left.id);
    })
    .slice(0, FWA_WAR_MEMBERS_OBSERVATION_EVIDENCE_LIMIT);
}

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
        qualityEvidence: {
          orderBy: [{ firstObservedAt: "desc" }, { id: "desc" }],
          take: FWA_WAR_MEMBERS_OBSERVATION_EVIDENCE_LIMIT,
          select: {
            id: true,
            evidenceSchemaVersion: true,
            firstObservedAt: true,
            rawRowCount: true,
            parserRejectedRowCount: true,
            evidenceIneligibleRowCount: true,
            rawWeightInvalidCount: true,
            canonicalSourceFingerprint: true,
            sourceQualityFingerprint: true,
            structuralStatus: true,
            rosterCompletenessStatus: true,
            weightStatus: true,
            sourceAuthorityStatus: true,
            sourceQualityReasonCodes: true,
          },
        },
      },
    }),
  ]);

  const boundedObservations = observations.map((observation) => ({
    ...observation,
    qualityEvidence: selectNewestQualityEvidence(observation.qualityEvidence),
  }));

  console.log(JSON.stringify({
    observationSchema: "war-members-observation-v1",
    evidenceSchema: "war-members-quality-v1",
    filter: { clanTag: options.clanTag },
    retainedObservationCount,
    returnedObservationCount: observations.length,
    observations: boundedObservations,
  }, null, 2));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`FWA WarMembers observation diagnosis failed: ${String(error)}`);
    process.exitCode = 1;
  });
}
