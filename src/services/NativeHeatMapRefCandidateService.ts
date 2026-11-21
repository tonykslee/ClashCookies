import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import {
  generateNativeHeatMapRefCandidate,
  NATIVE_REFERENCE_PERSISTED_EVIDENCE_TRUST,
  NATIVE_REFERENCE_PERSISTED_SOURCE_CATEGORY,
  type NativeReferenceBandDefinition,
  type NativeReferenceCandidateArtifact,
  type NativeReferenceEraPolicy,
  type NativeReferenceSourceRoster,
} from "../helper/nativeHeatMapRefCandidate";
import { HEAT_MAP_REF_SEED_ROWS } from "./HeatMapRefSeedData";

type NativeCandidateDb = Pick<PrismaClient, "fwaTrackedClanWarRosterCurrent" | "currentWar" | "fwaWarMemberCurrent">;

/** Purpose: read the persisted tracked-war snapshot without invoking feed, reference, setting, or scheduler owners. */
export class NativeHeatMapRefCandidateService {
  private readonly db: NativeCandidateDb;

  constructor(db: NativeCandidateDb = prisma) {
    this.db = db;
  }

  async readPersistedSourceRosters(): Promise<NativeReferenceSourceRoster[]> {
    const rows = await this.db.fwaTrackedClanWarRosterCurrent.findMany({
      orderBy: { clanTag: "asc" },
      include: {
        members: {
          orderBy: [{ position: "asc" }, { playerTag: "asc" }],
          select: {
            clanTag: true,
            playerTag: true,
            position: true,
            townHall: true,
            rawWeight: true,
            effectiveWeight: true,
            effectiveWeightStatus: true,
          },
        },
      },
    });
    const clanTags = rows.map((row) => row.clanTag);
    const [currentWars, memberEvidence] = await Promise.all([
      clanTags.length > 0
        ? this.db.currentWar.findMany({
            where: { clanTag: { in: clanTags } },
            select: { clanTag: true, guildId: true, warId: true, startTime: true, opponentTag: true, matchType: true, state: true, updatedAt: true },
          })
        : Promise.resolve([]),
      clanTags.length > 0
        ? this.db.fwaWarMemberCurrent.findMany({
            where: { clanTag: { in: clanTags } },
            select: { clanTag: true, playerTag: true, position: true, sourceSyncedAt: true },
          })
        : Promise.resolve([]),
    ]);
    const currentWarCountByClan = new Map<string, number>();
    const memberEvidenceCountByClan = new Map<string, number>();
    for (const row of currentWars) currentWarCountByClan.set(row.clanTag, (currentWarCountByClan.get(row.clanTag) ?? 0) + 1);
    for (const row of memberEvidence) memberEvidenceCountByClan.set(row.clanTag, (memberEvidenceCountByClan.get(row.clanTag) ?? 0) + 1);
    return rows.map((row) => ({
      clanTag: row.clanTag,
      rosterSize: row.rosterSize,
      totalRawWeight: row.totalRawWeight,
      totalEffectiveWeight: row.totalEffectiveWeight,
      observedAt: row.observedAt,
      sourceUpdatedAt: row.sourceUpdatedAt,
      sourceWarId: row.sourceWarId,
      sourceWarStartTime: row.sourceWarStartTime,
      sourceWarEndTime: row.sourceWarEndTime,
      sourceWarState: row.sourceWarState,
      sourceCurrentWarUpdatedAt: row.sourceCurrentWarUpdatedAt,
      // CurrentWar and WarMembers are separate persisted owners. There is no persisted
      // foreign key proving that these member rows belong to this exact war, so the
      // native contract must remain UNKNOWN rather than infer a binding.
      sourceIdentityStatus: "UNAVAILABLE" as const,
      sourceMatchType: null,
      sourceMemberCompletenessStatus: "UNAVAILABLE" as const,
      members: row.members.map((member) => ({
        clanTag: member.clanTag,
        playerTag: member.playerTag,
        position: member.position,
        townHall: member.townHall,
        rawWeight: member.rawWeight,
        effectiveWeight: member.effectiveWeight,
        effectiveWeightStatus: member.effectiveWeightStatus,
      })),
    }));
  }

  /** Purpose: generate a candidate artifact from persisted rows and explicit operator policy parameters. */
  async generate(input: {
    evaluationAt: Date | string;
    eraPolicy: NativeReferenceEraPolicy;
    sampleThreshold?: number;
    bandDefinitions?: readonly NativeReferenceBandDefinition[];
  }): Promise<NativeReferenceCandidateArtifact> {
    const sourceRosters = await this.readPersistedSourceRosters();
    return generateNativeHeatMapRefCandidate({
      sourceRosters,
      bandDefinitions: input.bandDefinitions ?? HEAT_MAP_REF_SEED_ROWS.map((row) => ({
        weightMinInclusive: row.weightMinInclusive,
        weightMaxInclusive: row.weightMaxInclusive,
      })),
      eraPolicy: input.eraPolicy,
      evaluationAt: input.evaluationAt,
      sampleThreshold: input.sampleThreshold,
      sourceCategory: NATIVE_REFERENCE_PERSISTED_SOURCE_CATEGORY,
      evidenceTrust: NATIVE_REFERENCE_PERSISTED_EVIDENCE_TRUST,
    });
  }
}

